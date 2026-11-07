import assert from "node:assert/strict";
import test from "node:test";

import {
  PostgresJobSettlementStore,
  createJobSettlementNotifier,
} from "../services/jobSettlementNotification.js";

class MemorySettlementStore {
  constructor({ jobs = [], profiles = {}, workflowRuns = {} } = {}) {
    this.jobs = new Map(jobs.map((job) => [String(job.id), structuredClone(job)]));
    this.profiles = profiles;
    this.workflowRuns = new Map(Object.entries(workflowRuns).map(([id, run]) => [id, structuredClone(run)]));
    this.claimed = new Set();
    this.sent = new Set();
    this.failed = [];
  }

  async pendingJobIds() {
    return [...this.jobs.keys()];
  }

  async claim(jobId) {
    const job = this.jobs.get(String(jobId));
    if (!job || !["completed", "failed"].includes(job.status)) return [];
    const deliveries = [];
    if (job.status === "failed") {
      deliveries.push({
        key: `dead-letter:${job.id}`,
        kind: "dead-letter",
        jobId: String(job.id),
        jobType: job.jobType,
        queueName: job.queueName,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        errorCode: job.errorCode,
      });
    }

    if (job.jobType.startsWith("workflow.")) {
      const run = this.workflowRuns.get(String(job.workflowRunId));
      if (job.status === "failed" && run && !["completed", "failed", "cancelled"].includes(run.status)) {
        run.status = "failed";
      }
      if (run && ["completed", "failed"].includes(run.status)) {
        deliveries.push({
          key: `workflow:${run.id}`,
          kind: "user",
          jobId: String(job.id),
          taskId: String(run.id),
          jobType: "workflow.run",
          outcome: run.status,
          profile: this.profiles[run.userId] || null,
        });
      }
    } else {
      deliveries.push({
        key: `job:${job.id}`,
        kind: "user",
        jobId: String(job.id),
        taskId: String(job.id),
        jobType: job.jobType,
        outcome: job.status,
        profile: this.profiles[job.userId] || null,
      });
    }
    return deliveries.filter((delivery) => {
      if (this.claimed.has(delivery.key) || this.sent.has(delivery.key)) return false;
      this.claimed.add(delivery.key);
      return true;
    });
  }

  async finish(delivery, result) {
    this.claimed.delete(delivery.key);
    if (result.status === "sent" || result.status === "skipped") this.sent.add(delivery.key);
    else this.failed.push({ delivery, result });
  }
}

const silentLogger = { info() {}, warn() {}, error() {} };

class FakePostgresSettlementSql {
  constructor() {
    this.userNotificationSent = false;
  }

  async begin(callback) {
    return callback(this);
  }

  async unsafe(query, values) {
    const marker = query.match(/job-settlement:([a-z-]+)/)?.[1];
    if (marker === "load-job") return [{
      id: "db-job-1",
      queue_name: "workflow",
      job_type: "agent.tool",
      user_id: "db-user-1",
      payload: { email: "payload-attacker@example.com" },
      status: "completed",
      attempts: 1,
      max_attempts: 3,
      error_code: null,
    }];
    if (marker === "claim-job-user") return this.userNotificationSent ? [] : [{ id: "db-job-1" }];
    if (marker === "profile") {
      assert.deepEqual(values, ["db-user-1"]);
      return [{ email: "db-owner@example.com", display_name: "Database Owner" }];
    }
    if (marker === "finish-job-user") {
      assert.deepEqual(values, ["db-job-1"]);
      this.userNotificationSent = true;
      return [];
    }
    throw new Error(`Unknown fake settlement query marker: ${marker}`);
  }
}

test("retryable failures do not send user mail or operational alerts", async () => {
  const store = new MemorySettlementStore({
    jobs: [{ id: "1", jobType: "agent.tool", status: "queued", userId: "u1" }],
    profiles: { u1: { email: "owner@example.com", displayName: "Owner" } },
  });
  const calls = [];
  const notifier = createJobSettlementNotifier({
    store,
    sendUserNotification: async (input) => { calls.push(["user", input]); return { sent: true }; },
    sendOperationalAlert: async (input) => { calls.push(["alert", input]); return { sent: true }; },
    logger: silentLogger,
  });

  assert.deepEqual(await notifier.notify({ jobId: "1" }), { claimed: 0, sent: 0, skipped: 0, failed: 0 });
  assert.deepEqual(calls, []);
});

test("terminal job failure sends one bounded dead-letter alert without payload data", async () => {
  const store = new MemorySettlementStore({
    jobs: [{ id: "2", jobType: "mcp.call", queueName: "workflow", status: "failed", userId: "u1",
      attempts: 3, maxAttempts: 3, errorCode: "UPSTREAM_FAILED", payload: { token: "must-not-leak" } }],
    profiles: { u1: { email: "owner@example.com", displayName: "Owner" } },
  });
  const alerts = [];
  const notifier = createJobSettlementNotifier({
    store,
    sendUserNotification: async () => ({ sent: true }),
    sendOperationalAlert: async (input) => { alerts.push(input); return { sent: true }; },
    logger: silentLogger,
  });

  const first = await notifier.notify({ jobId: "2", payload: { email: "attacker@example.com" } });
  const replay = await notifier.notify({ jobId: "2" });

  assert.equal(first.sent, 2);
  assert.equal(replay.claimed, 0);
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].details, {
    jobId: "2",
    queueName: "workflow",
    jobType: "mcp.call",
    attempts: "3/3",
    errorCode: "UPSTREAM_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(alerts[0]), /must-not-leak|attacker@example\.com/);
});

test("multiple workflow node settlements notify the workflow owner only once", async () => {
  const store = new MemorySettlementStore({
    jobs: [
      { id: "11", jobType: "workflow.node", status: "completed", userId: "u1", workflowRunId: "run-7" },
      { id: "12", jobType: "workflow.node", status: "completed", userId: "u1", workflowRunId: "run-7" },
    ],
    workflowRuns: { "run-7": { id: "run-7", userId: "u1", status: "completed" } },
    profiles: { u1: { email: "database-owner@example.com", displayName: "DB Owner" } },
  });
  const messages = [];
  const notifier = createJobSettlementNotifier({
    store,
    sendUserNotification: async (input) => { messages.push(input); return { sent: true }; },
    sendOperationalAlert: async () => ({ sent: true }),
    logger: silentLogger,
  });

  await notifier.notify({ jobId: "11", email: "payload@example.com" });
  await notifier.notify({ jobId: "12", email: "payload@example.com" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "database-owner@example.com");
  assert.equal(messages[0].taskId, "run-7");
  assert.equal(messages[0].jobType, "workflow.run");
});

test("mail delivery failure is recorded for retry and does not escape notify", async () => {
  const store = new MemorySettlementStore({
    jobs: [{ id: "3", jobType: "agent.tool", status: "completed", userId: "u1" }],
    profiles: { u1: { email: "owner@example.com", displayName: "Owner" } },
  });
  const notifier = createJobSettlementNotifier({
    store,
    sendUserNotification: async () => { throw new Error("SMTP password=must-not-leak"); },
    sendOperationalAlert: async () => ({ sent: true }),
    logger: silentLogger,
  });

  assert.deepEqual(await notifier.notify({ jobId: "3" }), { claimed: 1, sent: 0, skipped: 0, failed: 1 });
  assert.equal(store.jobs.get("3").status, "completed");
  assert.equal(store.failed.length, 1);
  assert.equal(store.failed[0].result.reason, "delivery_failed");
  assert.doesNotMatch(JSON.stringify(store.failed), /must-not-leak/);
});

test("Postgres settlement store resolves identity and email from canonical database rows", async () => {
  const sql = new FakePostgresSettlementSql();
  const messages = [];
  const notifier = createJobSettlementNotifier({
    store: new PostgresJobSettlementStore({ sqlClient: sql, retryAfterMs: 1_000 }),
    sendUserNotification: async (input) => { messages.push(input); return { sent: true }; },
    sendOperationalAlert: async () => ({ sent: true }),
    logger: silentLogger,
  });

  await notifier.notify({ jobId: "db-job-1", email: "caller-attacker@example.com" });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "db-owner@example.com");
  assert.equal(messages[0].displayName, "Database Owner");
  assert.doesNotMatch(JSON.stringify(messages), /payload-attacker|caller-attacker/);
});
