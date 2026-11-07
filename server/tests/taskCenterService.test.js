import assert from "node:assert/strict";
import test from "node:test";

import {
  TaskCenterError,
  createTaskCenterService,
} from "../services/taskCenterService.js";

class FakeTaskCenterSql {
  constructor({ tasks = [], total = tasks.length } = {}) {
    this.tasks = tasks;
    this.total = total;
    this.calls = [];
  }

  async unsafe(query, values) {
    const marker = query.match(/task-center:(list|count|get)/)?.[1];
    this.calls.push({ marker, query, values });
    if (marker === "list") {
      const limit = Number(values[3]);
      const offset = Number(values[4]);
      return this.tasks.slice(offset, offset + limit);
    }
    if (marker === "count") return [{ total: this.total }];
    if (marker === "get") {
      const [, source, sourceId] = values;
      return this.tasks.filter((item) => item.source_type === source && String(item.source_id) === String(sourceId)).slice(0, 1);
    }
    throw new Error(`Unexpected task center query: ${query}`);
  }
}

test("lists the signed-in user's jobs, workflow runs, and creations as one paged task list", async () => {
  const sql = new FakeTaskCenterSql({
    tasks: [
      {
        source_type: "persistent_job",
        source_id: "job-1",
        user_id: "owner-1",
        status: "running",
        progress: 50,
        type: "agent.tool",
        title: "Agent task",
        created_at: "2026-08-07T09:00:00.000Z",
        updated_at: "2026-08-07T09:01:00.000Z",
        started_at: "2026-08-07T09:00:30.000Z",
        completed_at: null,
        failed_at: null,
        cancelled_at: null,
        error_code: null,
        error_message: null,
      },
      {
        source_type: "workflow_run",
        source_id: "run-2",
        user_id: "owner-1",
        status: "paused",
        progress: 50,
        type: "workflow",
        title: "Storyboard workflow",
        created_at: "2026-08-07T08:00:00.000Z",
        updated_at: "2026-08-07T08:30:00.000Z",
        started_at: "2026-08-07T08:01:00.000Z",
        completed_at: null,
        failed_at: null,
        cancelled_at: null,
        error_code: "WAITING_APPROVAL",
        error_message: "Waiting for approval",
      },
      {
        source_type: "creation",
        source_id: "17",
        user_id: "owner-1",
        status: "completed",
        progress: 100,
        type: "image",
        title: "Product photo",
        created_at: "2026-08-07T07:00:00.000Z",
        updated_at: "2026-08-07T07:00:00.000Z",
        started_at: null,
        completed_at: null,
        failed_at: null,
        cancelled_at: null,
        error_code: null,
        error_message: null,
      },
    ],
    total: 3,
  });
  const service = createTaskCenterService({ sqlClient: sql });

  const result = await service.listForUser({ userId: "owner-1", page: 1, pageSize: 2 });

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 2);
  assert.equal(result.total, 3);
  assert.equal(result.hasNextPage, true);
  assert.deepEqual(result.tasks[0], {
    id: "persistent_job:job-1",
    source: "persistent_job",
    sourceId: "job-1",
    status: "running",
    progress: 50,
    type: "agent.tool",
    title: "Agent task",
    timestamps: {
      createdAt: "2026-08-07T09:00:00.000Z",
      updatedAt: "2026-08-07T09:01:00.000Z",
      startedAt: "2026-08-07T09:00:30.000Z",
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
    },
    error: null,
    cancellation: { supported: true, reason: null },
  });
  assert.equal(sql.calls.length, 2);
  assert.equal(sql.calls[0].values[0], "owner-1");
  assert.match(sql.calls[0].query, /user_id\s*=\s*\$1/);
  assert.equal(sql.calls[1].values[0], "owner-1");

  const secondPage = await service.listForUser({ userId: "owner-1", page: 2, pageSize: 2 });
  assert.equal(secondPage.tasks[0].source, "creation");
  assert.equal(secondPage.tasks[0].timestamps.completedAt, null);
});

test("binds filters and rejects unsafe pagination before querying PostgreSQL", async () => {
  const sql = new FakeTaskCenterSql();
  const service = createTaskCenterService({ sqlClient: sql });

  await assert.rejects(
    () => service.listForUser({ userId: "owner-1", page: 0, pageSize: 999 }),
    (error) => error.code === "INVALID_TASK_CENTER_PAGINATION" && error.status === 400,
  );
  assert.equal(sql.calls.length, 0);

  await service.listForUser({ userId: "owner-1", status: "running", type: "workflow" });
  assert.deepEqual(sql.calls[0].values.slice(0, 3), ["owner-1", "running", "workflow"]);
});

test("delegates supported cancellation and marks creations as unsupported", async () => {
  const calls = [];
  const service = createTaskCenterService({
    sqlClient: new FakeTaskCenterSql(),
    jobQueue: {
      cancel: async (input) => {
        calls.push(["job", input]);
        return { id: input.jobId, status: "cancelled" };
      },
    },
    workflowRuntime: {
      cancel: async (input) => {
        calls.push(["workflow", input]);
        return { id: input.runId, status: "cancelled" };
      },
    },
    agentPlanExecution: {
      cancel: async (input) => {
        calls.push(["agent-plan", input]);
        return { id: input.runId, status: "cancelled" };
      },
    },
  });

  assert.deepEqual(await service.cancelForUser({ userId: "owner-1", taskId: "persistent_job:42", reason: "stop" }), {
    taskId: "persistent_job:42",
    source: "persistent_job",
    sourceId: "42",
    status: "cancelled",
    cancelled: true,
  });
  assert.deepEqual(await service.cancelForUser({ userId: "owner-1", taskId: "workflow_run:7" }), {
    taskId: "workflow_run:7",
    source: "workflow_run",
    sourceId: "7",
    status: "cancelled",
    cancelled: true,
  });
  assert.deepEqual(await service.cancelForUser({ userId: "owner-1", taskId: "agent_plan_run:plan-8" }), {
    taskId: "agent_plan_run:plan-8",
    source: "agent_plan_run",
    sourceId: "plan-8",
    status: "cancelled",
    cancelled: true,
  });
  await assert.rejects(
    () => service.cancelForUser({ userId: "owner-1", taskId: "creation:17" }),
    (error) => error instanceof TaskCenterError
      && error.code === "TASK_CANCELLATION_UNSUPPORTED"
      && error.status === 409,
  );
  assert.deepEqual(calls, [
    ["job", { jobId: "42", userId: "owner-1", reason: "stop" }],
    ["workflow", { runId: "7", userId: "owner-1", reason: undefined }],
    ["agent-plan", { runId: "plan-8", userId: "owner-1", reason: undefined }],
  ]);
});

test("gets one owned Agent plan task by its source-qualified id", async () => {
  const sql = new FakeTaskCenterSql({ tasks: [{
    source_type: "agent_plan_run", source_id: "agentplan_1", user_id: "owner-1",
    status: "waiting_approval", progress: 40, type: "agent_plan", title: "Publish a creation",
    created_at: "2026-08-08T01:00:00Z", updated_at: "2026-08-08T01:01:00Z",
    started_at: "2026-08-08T01:00:10Z", completed_at: null, failed_at: null,
    cancelled_at: null, error_code: null, error_message: null,
  }] });
  const task = await createTaskCenterService({ sqlClient: sql }).getForUser({
    userId: "owner-1",
    taskId: "agent_plan_run:agentplan_1",
  });
  assert.equal(task.source, "agent_plan_run");
  assert.equal(task.status, "waiting_approval");
  assert.equal(task.cancellation.supported, true);
});

test("does not claim a terminal workflow was cancelled when the existing runtime returns it unchanged", async () => {
  const service = createTaskCenterService({
    sqlClient: new FakeTaskCenterSql(),
    workflowRuntime: {
      cancel: async () => ({ id: "7", status: "completed" }),
    },
  });

  assert.deepEqual(await service.cancelForUser({ userId: "owner-1", taskId: "workflow_run:7" }), {
    taskId: "workflow_run:7",
    source: "workflow_run",
    sourceId: "7",
    status: "completed",
    cancelled: false,
  });
});

test("routes cancellation through the durable user-operation idempotency seam", async () => {
  const calls = [];
  const service = createTaskCenterService({
    sqlClient: new FakeTaskCenterSql(),
    operationExecutor: async (operation) => {
      calls.push({
        userId: operation.userId,
        idempotencyKey: operation.idempotencyKey,
        action: operation.action,
        targetType: operation.targetType,
        targetId: operation.targetId,
        requestPayload: operation.requestPayload,
      });
      return operation.mutate();
    },
    jobQueue: { cancel: async ({ jobId }) => ({ id: jobId, status: "cancelled" }) },
  });

  const result = await service.cancelForUser({
    userId: "owner-1",
    taskId: "persistent_job:42",
    reason: "stop",
    idempotencyKey: "cancel-job-0001",
  });

  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, [{
    userId: "owner-1",
    idempotencyKey: "cancel-job-0001",
    action: "task.cancelled",
    targetType: "persistent_job",
    targetId: "42",
    requestPayload: { reason: "stop" },
  }]);
});
