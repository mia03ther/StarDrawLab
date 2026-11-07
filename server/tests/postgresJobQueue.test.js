import assert from "node:assert/strict";
import test from "node:test";

import { createJobWorker } from "../worker.js";
import {
  JobQueueError,
  PostgresJobQueue,
  hashJobRequest,
} from "../services/postgresJobQueue.js";

const clone = (value) => JSON.parse(JSON.stringify(value));

class FakeSql {
  constructor() {
    this.nextId = 1;
    this.jobs = new Map();
    this.now = Date.now();
    this.jsonParameterTypes = [];
  }

  async begin(callback) {
    return callback(this);
  }

  async unsafe(query, values) {
    const marker = query.match(/persistent-jobs:([a-z-]+)/)?.[1];
    const now = this.now;
    const job = (row) => ({
      ...clone(row),
      available_at: row.available_at ?? now,
      created_at: row.created_at ?? now,
      updated_at: now,
    });
    if (marker === "enqueue") {
      const [queueName, jobType, userId, key, requestHash, payload, refs, metadata, priority, maxAttempts, availableAt] = values;
      this.jsonParameterTypes.push(typeof payload, typeof refs, typeof metadata);
      const existing = [...this.jobs.values()].find((item) => item.queue_name === queueName
        && item.user_id === userId && item.idempotency_key === key && key);
      if (existing) return [];
      const jsonValue = (value) => typeof value === "string" ? JSON.parse(value) : clone(value);
      const row = job({ id: this.nextId++, queue_name: queueName, job_type: jobType, user_id: userId,
        idempotency_key: key, request_hash: requestHash, payload: jsonValue(payload), input_refs: jsonValue(refs),
        metadata: jsonValue(metadata), status: "queued", priority, attempts: 0, max_attempts: maxAttempts,
        available_at: new Date(availableAt).getTime() });
      this.jobs.set(String(row.id), row);
      return [row];
    }
    if (marker === "enqueue-existing") {
      const [queueName, userId, key] = values;
      return [...this.jobs.values()].filter((item) => item.queue_name === queueName
        && item.user_id === userId && item.idempotency_key === key);
    }
    if (marker === "expire-exhausted") {
      for (const item of this.jobs.values()) {
        if (item.queue_name === values[0] && item.status === "running" && item.lease_expires_at <= now && item.attempts >= item.max_attempts) {
          Object.assign(item, { status: "failed", lease_owner: null, lease_expires_at: null,
            error_code: "LEASE_EXPIRED_MAX_ATTEMPTS", error_message: "Job lease expired after the maximum number of attempts",
            failed_at: now, dead_lettered_at: now, updated_at: now });
        }
      }
      return [];
    }
    if (marker === "lease") {
      const [queueName, limit, workerId, duration] = values;
      const candidates = [...this.jobs.values()].filter((item) => item.queue_name === queueName
        && item.attempts < item.max_attempts && item.available_at <= now
        && (item.status === "queued" || (item.status === "running" && item.lease_expires_at <= now)))
        .sort((a, b) => b.priority - a.priority || a.id - b.id).slice(0, limit);
      return candidates.map((item) => Object.assign(item, { status: "running", attempts: item.attempts + 1,
        lease_owner: workerId, lease_expires_at: now + duration, last_heartbeat_at: now, updated_at: now }));
    }
    if (marker === "heartbeat") {
      const [id, workerId, duration] = values;
      const item = this.jobs.get(String(id));
      if (!item || item.lease_owner !== workerId || item.status !== "running" || item.lease_expires_at <= now) return [];
      Object.assign(item, { lease_expires_at: now + duration, last_heartbeat_at: now, updated_at: now });
      return [item];
    }
    if (marker === "complete") {
      const [id, workerId, result] = values;
      this.jsonParameterTypes.push(typeof result);
      const item = this.jobs.get(String(id));
      if (!item || item.lease_owner !== workerId || item.status !== "running" || item.lease_expires_at <= now) return [];
      Object.assign(item, { status: "completed", result_snapshot: typeof result === "string" ? JSON.parse(result) : clone(result), lease_owner: null,
        lease_expires_at: null, last_heartbeat_at: null, completed_at: now, updated_at: now });
      return [item];
    }
    if (marker === "fail") {
      const [id, workerId, delay, errorCode, errorMessage] = values;
      const item = this.jobs.get(String(id));
      if (!item || item.lease_owner !== workerId || item.status !== "running" || item.lease_expires_at <= now) return [];
      const exhausted = item.attempts >= item.max_attempts;
      Object.assign(item, { status: exhausted ? "failed" : "queued", available_at: exhausted ? item.available_at : now + delay,
        lease_owner: null, lease_expires_at: null, last_heartbeat_at: null, error_code: errorCode,
        error_message: errorMessage, failed_at: exhausted ? now : null,
        dead_lettered_at: exhausted ? now : null, updated_at: now });
      return [item];
    }
    if (marker === "cancel") {
      const [id, userId, reason] = values;
      const item = this.jobs.get(String(id));
      if (!item || (userId !== null && item.user_id !== userId) || !["queued", "running"].includes(item.status)) return [];
      Object.assign(item, { status: "cancelled", lease_owner: null, lease_expires_at: null,
        last_heartbeat_at: null, cancel_reason: reason, cancelled_at: now, updated_at: now });
      return [item];
    }
    if (marker === "retry") {
      const [id, userId, delay] = values;
      const item = this.jobs.get(String(id));
      if (!item || (userId !== null && item.user_id !== userId) || item.status !== "failed" || item.attempts >= item.max_attempts) return [];
      Object.assign(item, { status: "queued", available_at: now + delay, failed_at: null,
        error_code: null, error_message: null, updated_at: now });
      return [item];
    }
    if (marker === "inspect") {
      const [id, userId] = values;
      const item = this.jobs.get(String(id));
      return item && (userId === null || item.user_id === userId) ? [item] : [];
    }
    throw new Error(`Unknown fake query marker: ${marker}`);
  }
}

const makeQueue = () => {
  const sql = new FakeSql();
  return { sql, queue: new PostgresJobQueue({ sqlClient: sql }) };
};

test("hashJobRequest is stable across JSON object key ordering", () => {
  assert.equal(hashJobRequest({ payload: { b: 2, a: 1 } }), hashJobRequest({ payload: { a: 1, b: 2 } }));
});

test("enqueue is idempotent and rejects reuse with different parameters", async () => {
  const { queue } = makeQueue();
  const first = await queue.enqueue({ jobType: "image.generate", userId: "u1", idempotencyKey: "job-key-1", payload: { prompt: "a" } });
  const replay = await queue.enqueue({ jobType: "image.generate", userId: "u1", idempotencyKey: "job-key-1", payload: { prompt: "a" } });
  assert.equal(replay.id, first.id);
  await assert.rejects(
    queue.enqueue({ jobType: "image.generate", userId: "u1", idempotencyKey: "job-key-1", payload: { prompt: "b" } }),
    (error) => error instanceof JobQueueError && error.code === "JOB_IDEMPOTENCY_CONFLICT",
  );
});

test("lease, heartbeat and complete enforce the lease owner", async () => {
  const { sql, queue } = makeQueue();
  const created = await queue.enqueue({ jobType: "workflow.node", availableAt: new Date(0), payload: { ref: "oss://private/a" } });
  const [leased] = await queue.lease({ workerId: "worker-a", leaseDurationMs: 1_000 });
  assert.equal(leased.id, created.id);
  await assert.rejects(queue.heartbeat({ jobId: leased.id, workerId: "worker-b" }), (error) => error.code === "JOB_LEASE_LOST");
  const heartbeat = await queue.heartbeat({ jobId: leased.id, workerId: "worker-a" });
  assert.equal(heartbeat.status, "running");
  const completed = await queue.complete({ jobId: leased.id, workerId: "worker-a", result: { outputRef: "oss://private/result" } });
  assert.equal(completed.status, "completed");
  assert.equal(completed.result.outputRef, "oss://private/result");
  assert.deepEqual(sql.jsonParameterTypes, ["object", "object", "object", "object"]);
});

test("expired leases can be recovered by another worker", async () => {
  const { sql, queue } = makeQueue();
  await queue.enqueue({ jobType: "video.generate", maxAttempts: 2, availableAt: new Date(sql.now) });
  const [first] = await queue.lease({ workerId: "worker-a" });
  sql.now = first.leaseExpiresAt + 1;
  const [second] = await queue.lease({ workerId: "worker-b" });
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 2);
});

test("fail requeues before max attempts and becomes terminal at max attempts", async () => {
  const { queue } = makeQueue();
  await queue.enqueue({ jobType: "agent.tool", maxAttempts: 2 });
  const [first] = await queue.lease({ workerId: "worker-a" });
  const retryError = Object.assign(new Error("temporary token=must-not-persist"), { code: "token-secret-value" });
  const queued = await queue.fail({ jobId: first.id, workerId: "worker-a", error: retryError });
  assert.equal(queued.status, "queued");
  assert.equal(queued.deadLetteredAt, null);
  assert.equal(queued.errorCode, "JOB_EXECUTION_FAILED");
  assert.doesNotMatch(queued.errorMessage, /must-not-persist|token/);
  const [second] = await queue.lease({ workerId: "worker-a" });
  const failed = await queue.fail({ jobId: second.id, workerId: "worker-a", error: { code: "UPSTREAM", message: "permanent" } });
  assert.equal(failed.status, "failed");
  assert.notEqual(failed.deadLetteredAt, null);
  await assert.rejects(queue.retry({ jobId: second.id }), (error) => error.code === "JOB_RETRY_NOT_ALLOWED");
});

test("a final expired lease becomes a durable dead letter", async () => {
  const { sql, queue } = makeQueue();
  await queue.enqueue({ jobType: "mcp.call", maxAttempts: 1, availableAt: new Date(sql.now) });
  const [leased] = await queue.lease({ workerId: "worker-a", leaseDurationMs: 1_000 });
  sql.now = leased.leaseExpiresAt + 1;

  assert.deepEqual(await queue.lease({ workerId: "worker-b" }), []);
  const failed = await queue.inspect({ jobId: leased.id });
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "LEASE_EXPIRED_MAX_ATTEMPTS");
  assert.notEqual(failed.deadLetteredAt, null);
});

test("binary media is rejected and cancellation is terminal", async () => {
  const { queue } = makeQueue();
  await assert.rejects(queue.enqueue({ jobType: "upload", payload: { bytes: Buffer.from("media") } }),
    (error) => error.code === "MEDIA_BYTES_NOT_ALLOWED");
  const created = await queue.enqueue({ jobType: "workflow.node" });
  const cancelled = await queue.cancel({ jobId: created.id, userId: null, reason: "stop" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await queue.inspect({ jobId: created.id })).status, "cancelled");
});

test("an expired worker lease cannot settle a job", async () => {
  const { sql, queue } = makeQueue();
  await queue.enqueue({ jobType: "workflow.node", availableAt: new Date(sql.now) });
  const [leased] = await queue.lease({ workerId: "worker-a", leaseDurationMs: 1_000 });
  sql.now = leased.leaseExpiresAt + 1;
  await assert.rejects(
    queue.complete({ jobId: leased.id, workerId: "worker-a", result: { stale: true } }),
    (error) => error.code === "JOB_LEASE_LOST",
  );
});

test("worker executes a leased job and settles it through the port", async () => {
  const calls = [];
  const job = { id: "job-1", jobType: "workflow.node", status: "running" };
  const queue = {
    async lease(args) { calls.push(["lease", args]); return [job]; },
    async heartbeat(args) { calls.push(["heartbeat", args]); return job; },
    async complete(args) { calls.push(["complete", args]); return { ...job, status: "completed", result: args.result }; },
    async fail(args) { calls.push(["fail", args]); return { ...job, status: "failed" }; },
  };
  const worker = createJobWorker({
    queue,
    workerId: "worker-test",
    pollIntervalMs: 50,
    leaseDurationMs: 1_000,
    execute: async (leasedJob) => ({ outputRef: `oss://result/${leasedJob.id}` }),
    logger: { warn() {}, error() {} },
  });
  const settled = await worker.runOnce();
  assert.equal(settled.status, "completed");
  assert.equal(calls.at(-1)[0], "complete");
  assert.equal(calls.at(-1)[1].result.outputRef, "oss://result/job-1");
});

test("worker sends executor failures back to fail for retry handling", async () => {
  let failed;
  let leased = true;
  const queue = {
    async lease() { if (!leased) return []; leased = false; return [{ id: "job-2", jobType: "mcp.call" }]; },
    async heartbeat() {},
    async complete() { throw new Error("complete should not run"); },
    async fail(args) { failed = args; return { id: "job-2", status: "queued" }; },
  };
  const worker = createJobWorker({
    queue,
    pollIntervalMs: 50,
    leaseDurationMs: 1_000,
    execute: async () => { throw Object.assign(new Error("provider unavailable"), { code: "UPSTREAM_DOWN" }); },
    logger: { warn() {}, error() {} },
  });
  const settled = await worker.runOnce();
  assert.equal(settled.status, "queued");
  assert.equal(failed.error.code, "UPSTREAM_DOWN");
});

test("worker keeps a completed settlement when notification delivery fails", async () => {
  let notificationAttempts = 0;
  const queue = {
    async lease() { return [{ id: "job-3", jobType: "agent.tool" }]; },
    async heartbeat() {},
    async complete(args) { return { id: args.jobId, jobType: "agent.tool", status: "completed" }; },
    async fail() { throw new Error("fail should not run"); },
  };
  const worker = createJobWorker({
    queue,
    settlementNotifier: {
      async flush() {},
      async notify() { notificationAttempts += 1; throw new Error("SMTP unavailable"); },
    },
    pollIntervalMs: 50,
    leaseDurationMs: 1_000,
    execute: async () => ({ ok: true }),
    logger: { warn() {}, error() {} },
  });

  const settled = await worker.runOnce();
  assert.equal(settled.status, "completed");
  assert.equal(settled.job.status, "completed");
  assert.equal(notificationAttempts, 1);
});
