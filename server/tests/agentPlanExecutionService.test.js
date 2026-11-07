import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AgentPlanExecutionService } from "../services/agentPlanExecutionService.js";

const clone = (value) => structuredClone(value);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

class MemoryPlanStore {
  constructor() { this.runs = new Map(); }
  async createRun({ run, steps }) {
    const value = { ...clone(run), status: "queued", currentStep: 0, totalSteps: steps.length, progress: 0,
      activeJobId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      steps: clone(steps).map((step, index) => ({ ...step, id: String(index + 1), status: "ready",
        requiresApproval: false, approvedAt: null, parameterDigest: null, resultPersisted: false })) };
    this.runs.set(run.id, value);
    return clone(value);
  }
  async attachJob({ runId, jobId }) { this.runs.get(runId).activeJobId = String(jobId); return clone(this.runs.get(runId)); }
  async getRun({ runId, userId = null }) {
    const run = this.runs.get(runId);
    return run && (!userId || run.userId === userId) ? clone(run) : null;
  }
  async markWaitingApproval({ runId, stepId, resolvedParameters, parameterDigest, reasonCode }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "waiting_approval", resolvedParameters: clone(resolvedParameters), parameterDigest,
      approvalReasonCode: reasonCode, requiresApproval: true });
    Object.assign(run, { status: "waiting_approval", currentStep: step.position });
    return clone(step);
  }
  async approveStep({ runId, userId, stepId, jobId }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "ready", approvedAt: new Date().toISOString(), approvedByUserId: userId });
    Object.assign(run, { status: "queued", activeJobId: String(jobId) });
    return clone(step);
  }
  async markWaitingClient({ runId, stepId, result }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "waiting_client", result: clone(result) });
    Object.assign(run, { status: "waiting_client", currentStep: step.position });
    return clone(step);
  }
  async completeClientStep({ runId, stepId, clientResult }) {
    return this.completeClientStepAndAppend({ runId, stepId, clientResult, newSteps: [] });
  }
  async completeClientStepAndAppend({ runId, stepId, clientResult, newSteps = [], finalResponse = null }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "completed", result: { ...(step.result || {}), clientResult: clone(clientResult) } });
    for (const nextStep of newSteps) {
      run.steps.push({ ...clone(nextStep), id: String(run.steps.length + 1), status: "ready",
        requiresApproval: false, approvedAt: null, parameterDigest: null, resultPersisted: false });
    }
    const completed = run.steps.filter((item) => item.status === "completed").length;
    const done = completed === run.steps.length;
    if (finalResponse) run.plan = { ...run.plan, finalResponse };
    Object.assign(run, { status: done ? "completed" : "queued", currentStep: completed,
      totalSteps: run.steps.length, progress: done ? 100 : Math.floor((completed / run.steps.length) * 100) });
    return { step: clone(step), done };
  }
  async markStepRunning({ runId, stepId, resolvedParameters, parameterDigest }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "running", resolvedParameters: clone(resolvedParameters), parameterDigest });
    Object.assign(run, { status: "running", currentStep: step.position });
    return clone(step);
  }
  async recordStepResult({ runId, stepId, result }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { result: clone(result), resultPersisted: true });
    return clone(step);
  }
  async deferStep({ runId, stepId, result, jobId }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    step.status = "ready";
    if (result !== undefined) step.result = clone(result);
    Object.assign(run, { status: "queued", activeJobId: String(jobId), currentStep: step.position });
    return clone(run);
  }
  async completeStep({ runId, stepId, result, approvalConsumed }) {
    return this.completeStepAndAppend({ runId, stepId, result, approvalConsumed, newSteps: [] });
  }
  async completeStepAndAppend({ runId, stepId, result, approvalConsumed, newSteps = [], finalResponse = null }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    Object.assign(step, { status: "completed", result: clone(result), approvalConsumedAt: approvalConsumed ? new Date().toISOString() : null });
    for (const nextStep of newSteps) {
      run.steps.push({ ...clone(nextStep), id: String(run.steps.length + 1), status: "ready",
        requiresApproval: false, approvedAt: null, parameterDigest: null, resultPersisted: false });
    }
    const completed = run.steps.filter((item) => item.status === "completed").length;
    if (finalResponse) run.plan = { ...run.plan, finalResponse };
    Object.assign(run, { status: completed === run.steps.length ? "completed" : "running", currentStep: completed,
      totalSteps: run.steps.length, progress: completed === run.steps.length ? 100 : Math.floor((completed / run.steps.length) * 100) });
    return clone(run);
  }
  async resetStepForRetry({ runId, stepId }) {
    const run = this.runs.get(runId); const step = run.steps.find((item) => item.id === String(stepId));
    step.status = "ready"; run.status = "queued"; return clone(step);
  }
  async failStep({ runId, stepId, errorCode, errorMessage }) {
    const run = this.runs.get(runId);
    if (stepId) Object.assign(run.steps.find((item) => item.id === String(stepId)), { status: "failed", errorCode, errorMessage });
    Object.assign(run, { status: "failed", errorCode, errorMessage });
    return clone(run);
  }
  async cancelRun({ runId, reason }) {
    const run = this.runs.get(runId); run.status = "cancelled"; run.cancelReason = reason; return clone(run);
  }
}

class MemoryQueue {
  constructor() { this.jobs = []; }
  async enqueue(input) {
    const existing = this.jobs.find((job) => job.idempotencyKey === input.idempotencyKey);
    if (existing) return clone(existing);
    const job = { id: String(this.jobs.length + 1), ...clone(input), attempts: 1, maxAttempts: input.maxAttempts };
    this.jobs.push(job); return clone(job);
  }
  async cancel() { return { status: "cancelled" }; }
}

const createRuntime = ({ approvalTools = new Set(), calls = [], handlers = {}, idempotencyGuard = null, operationClass = null } = {}) => ({
  listTools: () => [
    "demo.read",
    "demo.write",
    "demo.danger",
    "demo.browser",
    ...Object.keys(handlers),
  ].map((toolKey) => ({ toolKey })),
  assess: ({ toolKey, parameters }) => ({
    decision: approvalTools.has(toolKey) ? "require_approval" : "allow",
    operationClass,
    requiresApproval: approvalTools.has(toolKey),
    reasonCode: approvalTools.has(toolKey) ? "ASK_MODE_REQUIRES_APPROVAL" : "AGENT_MODE_ALLOWS_TOOL",
    parameterDigest: digest(parameters),
  }),
  issueApproval: async () => ({ approvalToken: "transient-approval-token-123" }),
  execute: async ({ toolKey, parameters, approvalToken, context }) => {
    if (typeof idempotencyGuard === "function") await idempotencyGuard({ toolKey, parameters, context });
    calls.push({ toolKey, parameters: clone(parameters), approvalToken });
    if (typeof handlers[toolKey] === "function") {
      return { result: await handlers[toolKey]({ parameters: clone(parameters) }) };
    }
    if (toolKey === "demo.read") return { result: { item: { id: "item-1" } } };
    if (toolKey === "demo.browser") return { result: { clientAction: { type: "demo.download" } } };
    return { result: { received: clone(parameters), ok: true } };
  },
});

const startInput = (plan, agentMode = "full_access") => ({
  userId: "user-1", userRole: "user", membershipTier: "pro", agentMode,
  sessionId: "session-1", instruction: "do it", language: "en", plan,
  idempotencyKey: `agent-run:${Math.random().toString(36).slice(2, 12)}`,
});

test("durable Agent plans execute sequentially and resolve previous-step references on the server", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ calls }), trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "chain", calls: [
    { id: "read", toolKey: "demo.read", parameters: {} },
    { id: "write", toolKey: "demo.write", parameters: { target: "{{steps.read.result.item}}" } },
  ] }));
  const completed = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  assert.equal(completed.status, "completed");
  assert.deepEqual(calls[1].parameters.target, { id: "item-1" });
  assert.equal(completed.progress, 100);
});

test("public Agent run timestamps are JSON-safe for persistent job results", async () => {
  const store = new MemoryPlanStore();
  const queue = new MemoryQueue();
  const service = new AgentPlanExecutionService({
    store,
    jobQueue: queue,
    runtimeFactory: () => createRuntime(),
    trustedContextResolver: async () => ({}),
  });
  const started = await service.start(startInput({ summary: "date serialization", calls: [
    { id: "read", toolKey: "demo.read", parameters: {} },
  ] }));

  const persisted = store.runs.get(started.id);
  persisted.createdAt = new Date(persisted.createdAt);
  persisted.updatedAt = new Date(persisted.updatedAt);
  persisted.steps[0].approvedAt = new Date();

  const completed = await service.executeJob({
    ...queue.jobs[0],
    jobType: "agent.plan",
    userId: "user-1",
    payload: { runId: started.id },
  });

  assert.equal(typeof completed.timestamps.createdAt, "string");
  assert.equal(typeof completed.timestamps.updatedAt, "string");
  assert.equal(typeof completed.steps[0].approvedAt, "string");
});

test("approval pauses durably and resumes without persisting the one-time token", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ approvalTools: new Set(["demo.danger"]), calls }),
    trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "approval", calls: [
    { id: "danger", toolKey: "demo.danger", parameters: { publish: true } },
  ] }, "ask_for_approval"));
  const waiting = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(calls.length, 0);
  const approved = await service.approve({ userId: "user-1", runId: started.id, stepId: waiting.steps[0].id });
  assert.equal(approved.status, "queued");
  assert.equal(JSON.stringify(queue.jobs).includes("transient-approval-token"), false);
  const resumedJob = queue.jobs.at(-1);
  const completed = await service.executeJob({ ...resumedJob, jobType: "agent.plan", userId: "user-1", payload: resumedJob.payload });
  assert.equal(completed.status, "completed");
  assert.equal(calls[0].approvalToken, "transient-approval-token-123");
});

test("browser-only Agent actions pause durably and resume after client completion", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ calls }), trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "browser", calls: [
    { id: "export", toolKey: "demo.browser", parameters: {} },
    { id: "write", toolKey: "demo.write", parameters: { filename: "{{steps.export.result.clientResult.filename}}" } },
  ] }));

  const waiting = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  assert.equal(waiting.status, "waiting_client");
  assert.equal(waiting.steps[0].result.clientAction.type, "demo.download");

  const resumed = await service.completeClientAction({
    userId: "user-1",
    runId: started.id,
    stepId: waiting.steps[0].id,
    result: { filename: "export.zip", downloaded: true },
  });
  assert.equal(resumed.status, "queued");
  const resumedJob = queue.jobs.at(-1);
  const completed = await service.executeJob({ ...resumedJob, jobType: "agent.plan", userId: "user-1", payload: resumedJob.payload });
  assert.equal(completed.status, "completed");
  assert.equal(calls.at(-1).parameters.filename, "export.zip");
});

test("a worker interruption leaves a running step uncertain and never repeats it", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ calls }), trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "uncertain", calls: [
    { id: "write", toolKey: "demo.write", parameters: { value: 1 } },
  ] }));
  const run = store.runs.get(started.id); run.status = "running"; run.steps[0].status = "running";
  const failed = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "AGENT_STEP_EXECUTION_UNCERTAIN");
  assert.equal(calls.length, 0);
});

test("reactive Agent plans execute one tool, observe it, then append the next tool", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const observations = [];
  let replanCount = 0;
  const service = new AgentPlanExecutionService({
    store,
    jobQueue: queue,
    runtimeFactory: () => createRuntime({ calls }),
    trustedContextResolver: async () => ({}),
    reactPlanner: async ({ context }) => {
      observations.push(clone(context.observations));
      replanCount += 1;
      return replanCount === 1
        ? { summary: "continue", execution_mode: "reactive", calls: [{ toolKey: "demo.write", parameters: { source: "{{steps.read.result.item}}" } }] }
        : { summary: "done", response: "The requested update is complete.", execution_mode: "reactive", calls: [] };
    },
  });
  const started = await service.start(startInput({ execution_mode: "reactive", summary: "react", calls: [
    { id: "read", toolKey: "demo.read", parameters: {} },
  ] }));

  const completed = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });

  assert.equal(completed.status, "completed");
  assert.equal(completed.steps.length, 2);
  assert.deepEqual(calls.map((call) => call.toolKey), ["demo.read", "demo.write"]);
  assert.deepEqual(calls[1].parameters.source, { id: "item-1" });
  assert.equal(observations[0][0].callId, "read");
  assert.equal(observations[1].length, 2);
  assert.equal(completed.progress, 100);
  assert.equal(completed.finalResponse, "The requested update is complete.");
});

test("reactive Agent waits for the submitted media creation instead of creating another task", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  let statusChecks = 0;
  const service = new AgentPlanExecutionService({
    store,
    jobQueue: queue,
    mediaPollIntervalMs: 0,
    runtimeFactory: () => createRuntime({
      calls,
      handlers: {
        "media.generate.video": async () => ({
          kind: "submitted",
          creationId: "creation-42",
          taskId: "provider-task-42",
          status: "pending",
        }),
        "creation.get": async () => {
          statusChecks += 1;
          return statusChecks === 1
            ? { id: "creation-42", status: "pending", provider_status: "in_progress" }
            : { id: "creation-42", status: "completed", content: "https://media.example/video.mp4" };
        },
      },
    }),
    trustedContextResolver: async () => ({}),
    reactPlanner: async ({ context }) => (
      context.observations.length === 1
        ? {
            summary: "incorrect duplicate generation",
            execution_mode: "reactive",
            calls: [{ toolKey: "media.generate.video", parameters: { sceneKey: "freeform_video", userModification: "retry" } }],
          }
        : { summary: "done", execution_mode: "reactive", calls: [] }
    ),
  });
  const started = await service.start(startInput({ execution_mode: "reactive", summary: "generate video", calls: [
    { id: "generate", toolKey: "media.generate.video", parameters: { sceneKey: "freeform_video", userModification: "sunset" } },
  ] }));

  const waiting = await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  assert.equal(waiting.status, "queued");
  assert.deepEqual(calls.map((call) => call.toolKey), ["media.generate.video"]);
  assert.equal(waiting.steps[1].toolKey, "creation.get");
  assert.equal(waiting.steps[1].parameters.creationId, "creation-42");

  const firstPollJob = queue.jobs[1];
  const stillWaiting = await service.executeJob({ ...firstPollJob, jobType: "agent.plan", userId: "user-1", payload: firstPollJob.payload });
  assert.equal(stillWaiting.status, "queued");
  assert.deepEqual(calls.map((call) => call.toolKey), ["media.generate.video", "creation.get"]);

  const secondPollJob = queue.jobs[2];
  const completed = await service.executeJob({ ...secondPollJob, jobType: "agent.plan", userId: "user-1", payload: secondPollJob.payload });
  assert.equal(completed.status, "completed");
  assert.deepEqual(calls.map((call) => call.toolKey), ["media.generate.video", "creation.get", "creation.get"]);
  assert.equal(completed.steps[1].result.status, "completed");
});

test("reactive Agent keeps polling when a media status check is temporarily unavailable", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  let statusChecks = 0;
  const service = new AgentPlanExecutionService({
    store,
    jobQueue: queue,
    mediaPollIntervalMs: 0,
    runtimeFactory: () => createRuntime({
      calls,
      handlers: {
        "media.generate.video": async () => ({
          kind: "submitted",
          creationId: "creation-transient-503",
          status: "pending",
        }),
        "creation.get": async () => {
          statusChecks += 1;
          if (statusChecks === 1) {
            throw Object.assign(new Error("provider status endpoint unavailable"), {
              status: 503,
              code: "CREATION_STATUS_SYNC_FAILED",
            });
          }
          return { id: "creation-transient-503", status: "completed", content: "https://media.example/video.mp4" };
        },
      },
    }),
    trustedContextResolver: async () => ({}),
    reactPlanner: async ({ context }) => (
      context.observations.length >= 2
        ? { summary: "done", execution_mode: "reactive", calls: [] }
        : { summary: "wait", execution_mode: "reactive", calls: [] }
    ),
  });
  const started = await service.start(startInput({ execution_mode: "reactive", summary: "generate video", calls: [
    { id: "generate", toolKey: "media.generate.video", parameters: { sceneKey: "freeform_video", userModification: "sunset" } },
  ] }));

  await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  const firstPollJob = queue.jobs[1];
  const stillWaiting = await service.executeJob({ ...firstPollJob, jobType: "agent.plan", userId: "user-1", payload: firstPollJob.payload });
  assert.equal(stillWaiting.status, "queued");
  assert.equal(stillWaiting.error, null);
  assert.equal(stillWaiting.steps[1].status, "ready");
  assert.equal(stillWaiting.steps[1].result.agentPolling.attempt, 1);

  const completed = await service.executeJob({ ...queue.jobs[2], jobType: "agent.plan", userId: "user-1", payload: queue.jobs[2].payload });
  assert.equal(completed.status, "completed");
  assert.deepEqual(calls.map((call) => call.toolKey), ["media.generate.video", "creation.get", "creation.get"]);
  assert.equal(completed.steps[1].result.status, "completed");
});

test("reactive Agent uses a new idempotency key for each pending media poll", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const observedKeys = new Set();
  let statusChecks = 0;
  const service = new AgentPlanExecutionService({
    store,
    jobQueue: queue,
    mediaPollIntervalMs: 0,
    runtimeFactory: () => createRuntime({
      calls,
      idempotencyGuard: async ({ toolKey, context }) => {
        if (toolKey !== "creation.get") return;
        const key = String(context?.idempotencyKey || "");
        if (observedKeys.has(key)) {
          throw Object.assign(new Error("Execution idempotency state has no stored tool result"), {
            status: 409,
            code: "EXECUTION_IDEMPOTENCY_STATE_CONFLICT",
          });
        }
        observedKeys.add(key);
      },
      handlers: {
        "media.generate.video": async () => ({
          kind: "submitted",
          creationId: "creation-idempotency-poll",
          status: "pending",
        }),
        "creation.get": async () => {
          statusChecks += 1;
          return statusChecks === 1
            ? { id: "creation-idempotency-poll", status: "pending" }
            : { id: "creation-idempotency-poll", status: "completed", content: "https://media.example/video.mp4" };
        },
      },
    }),
    trustedContextResolver: async () => ({}),
    reactPlanner: async ({ context }) => (
      context.observations.length >= 2
        ? { summary: "done", execution_mode: "reactive", calls: [] }
        : { summary: "wait", execution_mode: "reactive", calls: [] }
    ),
  });
  const started = await service.start(startInput({ execution_mode: "reactive", summary: "poll idempotency", calls: [
    { id: "generate", toolKey: "media.generate.video", parameters: { sceneKey: "freeform_video" } },
  ] }));

  await service.executeJob({ ...queue.jobs[0], jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } });
  await service.executeJob({ ...queue.jobs[1], jobType: "agent.plan", userId: "user-1", payload: queue.jobs[1].payload });
  const completed = await service.executeJob({ ...queue.jobs[2], jobType: "agent.plan", userId: "user-1", payload: queue.jobs[2].payload });

  assert.equal(completed.status, "completed");
  assert.equal(observedKeys.size, 2);
  assert.deepEqual(calls.map((call) => call.toolKey), ["media.generate.video", "creation.get", "creation.get"]);
});

test("durable plan steps do not replay a permanent authorization failure with retry metadata", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ calls, operationClass: "read", handlers: { "demo.read": async () => {
      throw Object.assign(new Error("provider denied access"), { status: 403, code: "AGENT_PROVIDER_REJECTED", retryAfterMs: 0 });
    } } }), trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "read", calls: [{ id: "read", toolKey: "demo.read", parameters: {} }] }));
  const job = { ...queue.jobs[0], attempts: 1, maxAttempts: 3, jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } };
  const failed = await service.executeJob(job);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.code, "AGENT_PROVIDER_REJECTED");
  await service.executeJob({ ...job, attempts: 2 });
  assert.equal(calls.length, 1);
});

test("durable plan steps retain automatic retries for a temporary rate limit", async () => {
  const store = new MemoryPlanStore(); const queue = new MemoryQueue();
  const error = Object.assign(new Error("busy"), { status: 429 });
  const service = new AgentPlanExecutionService({ store, jobQueue: queue,
    runtimeFactory: () => createRuntime({ operationClass: "read", handlers: { "demo.read": async () => { throw error; } } }),
    trustedContextResolver: async () => ({}) });
  const started = await service.start(startInput({ summary: "read", calls: [{ id: "read", toolKey: "demo.read", parameters: {} }] }));
  await assert.rejects(service.executeJob({ ...queue.jobs[0], attempts: 1, maxAttempts: 3, jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } }),
    (actual) => actual === error);
  assert.equal((await service.get({ userId: "user-1", runId: started.id })).steps[0].status, "ready");
});

test("reactive planner authorization failures preserve completed tool results without replanning repeatedly", async () => {
  for (const resumePersistedResult of [false, true]) {
    const store = new MemoryPlanStore(); const queue = new MemoryQueue(); const calls = [];
    let plannerCalls = 0;
    const service = new AgentPlanExecutionService({ store, jobQueue: queue,
      runtimeFactory: () => createRuntime({ calls }), trustedContextResolver: async () => ({}),
      reactPlanner: async () => {
        plannerCalls += 1;
        throw Object.assign(new Error("provider denied access"), { status: 403, retryAfterMs: 0 });
      },
    });
    const started = await service.start(startInput({ execution_mode: "reactive", summary: "read then plan", calls: [
      { id: "read", toolKey: "demo.read", parameters: {} },
    ] }));
    if (resumePersistedResult) {
      const run = store.runs.get(started.id);
      run.status = "running";
      Object.assign(run.steps[0], { status: "running", resultPersisted: true, result: { item: { id: "item-1" } } });
    }
    const job = { ...queue.jobs[0], attempts: 1, maxAttempts: 3, jobType: "agent.plan", userId: "user-1", payload: { runId: started.id } };
    const failed = await service.executeJob(job);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "AGENT_REACT_PLANNER_FAILED");
    assert.deepEqual(failed.steps[0].result, { item: { id: "item-1" } });
    await service.executeJob({ ...job, attempts: 2 });
    assert.equal(plannerCalls, 1);
    assert.equal(calls.length, resumePersistedResult ? 0 : 1);
  }
});
