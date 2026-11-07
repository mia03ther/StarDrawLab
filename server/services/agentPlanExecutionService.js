import { createHash, randomUUID } from "node:crypto";
import { isRetryableAgentError } from "../domain/agent/retryPolicy.js";

import { buildAgentStepContext, resolveAgentStepReferences } from "../domain/agent/stepReferences.js";
import { AGENT_DECISIONS, normalizeAgentMode, normalizeUserRole } from "../ports/agentToolPort.js";

const MAX_CALLS = 12;
const MAX_PLAN_BYTES = 256 * 1024;
const MAX_STEP_RESULT_BYTES = 384 * 1024;
const CALL_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const EXECUTION_MODES = new Set(["static", "reactive"]);
const MEDIA_GENERATION_TOOLS = new Set(["media.generate.image", "media.generate.video"]);
const CREATION_PENDING_STATUSES = new Set(["pending", "queued", "processing", "running", "in_progress", "submitted"]);
const CREATION_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_MEDIA_POLL_INTERVAL_MS = 15_000;
const MAX_MEDIA_POLL_INTERVAL_MS = 60_000;

const fail = (message, { status = 400, code = "AGENT_PLAN_EXECUTION_FAILED", ...extra } = {}) => {
  throw Object.assign(new Error(message), { status, code, ...extra });
};

const text = (value, label, max, { required = true } = {}) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) fail(`${label} is required`, { code: "INVALID_AGENT_PLAN" });
  if (normalized.length > max) fail(`${label} is too long`, { code: "INVALID_AGENT_PLAN" });
  return normalized;
};

const safeJson = (value, label, maxBytes = MAX_PLAN_BYTES) => {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail(`${label} must be valid JSON`, { code: "INVALID_AGENT_PLAN_JSON" }); }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) {
    fail(`${label} is too large`, { status: 413, code: "AGENT_PLAN_TOO_LARGE" });
  }
  return JSON.parse(serialized);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const requestHash = (value) => createHash("sha256")
  .update(JSON.stringify(canonicalize(value)))
  .digest("hex");

const normalizeIdempotencyKey = (value) => {
  const key = text(value, "idempotencyKey", 128);
  if (!IDEMPOTENCY_PATTERN.test(key)) fail("idempotencyKey is invalid", { code: "INVALID_IDEMPOTENCY_KEY" });
  return key;
};

const normalizePlan = ({ plan, tools, allowEmpty = false }) => {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) fail("plan must be an object", { code: "INVALID_AGENT_PLAN" });
  const allowed = new Set(tools.map((tool) => tool.toolKey));
  const rawCalls = Array.isArray(plan.calls) ? plan.calls : [];
  if ((!allowEmpty && rawCalls.length < 1) || rawCalls.length > MAX_CALLS) {
    fail(`plan.calls must contain 1-${MAX_CALLS} calls`, { code: "INVALID_AGENT_PLAN_CALLS" });
  }
  const usedIds = new Set();
  const calls = rawCalls.map((call, index) => {
    if (!call || typeof call !== "object" || Array.isArray(call)) fail("Each Agent call must be an object", { code: "INVALID_AGENT_PLAN_CALL" });
    const requestedId = text(call.id || call.stepId || call.callId || `step_${index + 1}`, "call.id", 80);
    const callId = CALL_ID_PATTERN.test(requestedId) ? requestedId : `step_${index + 1}`;
    if (usedIds.has(callId)) fail(`Duplicate Agent call id: ${callId}`, { code: "AGENT_PLAN_DUPLICATE_CALL_ID" });
    usedIds.add(callId);
    const toolKey = text(call.toolKey || call.tool_key, "call.toolKey", 128).toLowerCase();
    if (!allowed.has(toolKey)) fail(`Agent tool is not registered: ${toolKey}`, { status: 404, code: "AGENT_TOOL_NOT_FOUND" });
    const parameters = call.parameters == null ? {} : call.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
      fail("call.parameters must be an object", { code: "INVALID_AGENT_PLAN_PARAMETERS" });
    }
    return {
      position: index + 1,
      callId,
      callName: text(call.name || call.label || callId, "call.name", 160),
      toolKey,
      reason: text(call.reason || "", "call.reason", 500, { required: false }),
      parameters: safeJson(parameters, `call ${callId} parameters`, 64 * 1024),
      executionIdempotencyKey: `agent-step:${randomUUID()}`,
      status: "ready",
      result: null,
    };
  });
  const executionMode = EXECUTION_MODES.has(String(plan.execution_mode || plan.executionMode || "").trim().toLowerCase())
    ? String(plan.execution_mode || plan.executionMode).trim().toLowerCase()
    : "static";
  const snapshot = safeJson({
    ...plan,
    executionMode,
    execution_mode: executionMode,
    calls: calls.map(({ executionIdempotencyKey: _ignored, ...call }) => call),
  }, "plan");
  return {
    summary: text(plan.summary || "Plan ready.", "plan.summary", 800),
    calls,
    executionMode,
    snapshot,
  };
};

const publicTimestamp = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const publicRun = (run) => run ? ({
  id: run.id,
  status: run.status,
  agentMode: run.agentMode,
  sessionId: run.sessionId,
  instruction: run.instruction,
  language: run.language,
  summary: run.summary,
  finalResponse: run.plan?.finalResponse || run.plan?.final_response || null,
  executionMode: run.plan?.executionMode || run.plan?.execution_mode || "static",
  currentStep: run.currentStep,
  totalSteps: run.totalSteps,
  progress: run.progress,
  error: run.errorCode || run.errorMessage ? { code: run.errorCode, message: run.errorMessage } : null,
  cancelReason: run.cancelReason || null,
  timestamps: {
    createdAt: publicTimestamp(run.createdAt),
    updatedAt: publicTimestamp(run.updatedAt),
    startedAt: publicTimestamp(run.startedAt),
    completedAt: publicTimestamp(run.completedAt),
    failedAt: publicTimestamp(run.failedAt),
    cancelledAt: publicTimestamp(run.cancelledAt),
  },
  steps: (run.steps || []).map((step) => ({
    id: step.id,
    position: step.position,
    callId: step.callId,
    callName: step.callName,
    toolKey: step.toolKey,
    reason: step.reason,
    parameters: step.parameters,
    resolvedParameters: step.resolvedParameters,
    result: step.result,
    status: step.status,
    requiresApproval: step.requiresApproval,
    approvalReasonCode: step.approvalReasonCode,
    approvedAt: publicTimestamp(step.approvedAt),
    error: step.errorCode || step.errorMessage ? { code: step.errorCode, message: step.errorMessage } : null,
    timestamps: {
      startedAt: publicTimestamp(step.startedAt),
      completedAt: publicTimestamp(step.completedAt),
      failedAt: publicTimestamp(step.failedAt),
    },
  })),
}) : null;

const safeErrorCode = (error) => {
  const code = String(error?.code || "AGENT_STEP_FAILED").trim().slice(0, 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(code) ? code : "AGENT_STEP_FAILED";
};

const safeErrorMessage = (error) => {
  const status = Number(error?.status) || 500;
  if (status >= 500) return "Agent step execution failed";
  return String(error?.message || "Agent step execution failed").slice(0, 500);
};

const isRetryable = isRetryableAgentError;
const AUTOMATIC_RETRY_OPERATION_CLASSES = new Set(["read", "creative", "reversible"]);

const mediaCreationId = (result) => String(
  result?.creationId || result?.creation_id || result?.id || result?.creation?.id || "",
).trim();

const creationStatus = (result) => String(
  result?.status || result?.creation?.status || result?.providerStatus || result?.provider_status || "",
).trim().toLowerCase();

const isPendingCreationResult = (result) => {
  const status = creationStatus(result);
  return CREATION_PENDING_STATUSES.has(status)
    || ["submitted", "reconciliation_pending"].includes(String(result?.kind || "").trim().toLowerCase());
};

const isTerminalCreationResult = (result) => CREATION_TERMINAL_STATUSES.has(creationStatus(result));

const isMediaObservationStep = (step) => (
  step?.toolKey === "creation.get" && String(step?.callId || "").startsWith("observe_media_")
);

const executionIdempotencyKeyForStep = (step) => {
  const baseKey = String(step?.executionIdempotencyKey || "").trim();
  if (!isMediaObservationStep(step)) return baseKey;
  const pollAttempt = Math.max(0, Number(step.result?.agentPolling?.attempt) || 0);
  return `${baseKey}:poll:${pollAttempt}`;
};

const unresolvedMediaCreation = (steps) => {
  const pending = new Map();
  for (const step of steps || []) {
    if (step.status !== "completed") continue;
    if (MEDIA_GENERATION_TOOLS.has(step.toolKey) && isPendingCreationResult(step.result)) {
      const creationId = mediaCreationId(step.result);
      if (creationId) pending.set(creationId, { creationId, sourceStep: step });
      continue;
    }
    if (step.toolKey !== "creation.get") continue;
    const creationId = mediaCreationId(step.result)
      || String(step.resolvedParameters?.creationId || step.parameters?.creationId || "").trim();
    if (creationId && isTerminalCreationResult(step.result)) pending.delete(creationId);
  }
  return [...pending.values()].at(-1) || null;
};

const normalizePollInterval = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_MEDIA_POLL_INTERVAL_MS;
  return Math.min(MAX_MEDIA_POLL_INTERVAL_MS, Math.max(0, Math.trunc(parsed)));
};

/**
 * Deep application module for persistent Global Agent plans.
 *
 * Callers see start/get/approve/cancel/executeJob. PostgreSQL, queue leases,
 * transient approval credentials and expression interpolation stay internal.
 */
export class AgentPlanExecutionService {
  constructor({
    store,
    jobQueue,
    runtimeFactory,
    trustedContextResolver,
    reactPlanner = null,
    queueName = "workflow",
    mediaPollIntervalMs = process.env.AGENT_MEDIA_POLL_INTERVAL_MS,
  } = {}) {
    if (!store || typeof store.createRun !== "function" || typeof store.getRun !== "function") {
      throw new TypeError("AgentPlanExecutionService requires an AgentPlanStorePort");
    }
    if (!jobQueue || typeof jobQueue.enqueue !== "function" || typeof jobQueue.cancel !== "function") {
      throw new TypeError("AgentPlanExecutionService requires a JobQueuePort");
    }
    if (typeof runtimeFactory !== "function") throw new TypeError("runtimeFactory is required");
    if (typeof trustedContextResolver !== "function") throw new TypeError("trustedContextResolver is required");
    this.store = store;
    this.jobQueue = jobQueue;
    this.runtimeFactory = runtimeFactory;
    this.trustedContextResolver = trustedContextResolver;
    if (reactPlanner != null && typeof reactPlanner !== "function") throw new TypeError("reactPlanner must be a function");
    this.reactPlanner = reactPlanner;
    this.queueName = queueName;
    this.mediaPollIntervalMs = normalizePollInterval(mediaPollIntervalMs);
  }

  async deferMediaObservation({ current, step, result, pollAttempt }) {
    const attempt = Math.max(0, Number(pollAttempt) || 0);
    const job = await this.jobQueue.enqueue({
      queueName: this.queueName,
      jobType: "agent.plan",
      userId: current.userId,
      idempotencyKey: `agent-plan:${current.id}:media:${step.id}:poll:${attempt}`,
      payload: { runId: current.id, resumeStep: step.position, mediaPollAttempt: attempt },
      metadata: { title: current.summary, agentPlanRunId: current.id, mediaCreationId: step.parameters?.creationId || null },
      maxAttempts: 3,
      availableAt: new Date(Date.now() + this.mediaPollIntervalMs),
    });
    await this.store.deferStep({
      runId: current.id,
      stepId: step.id,
      result,
      jobId: job.id,
    });
    return this.get({ userId: current.userId, runId: current.id });
  }

  async start({ userId, userRole, membershipTier = "free", agentMode, sessionId, instruction, language = "zh", plan, idempotencyKey }) {
    const runtime = await this.runtimeFactory();
    const normalizedRole = normalizeUserRole(userRole);
    const normalized = normalizePlan({ plan, tools: runtime.listTools({ userRole: normalizedRole }) });
    const requestIdempotencyKey = normalizeIdempotencyKey(idempotencyKey);
    const run = {
      id: `agentplan_${randomUUID().replaceAll("-", "")}`,
      userId: text(userId, "userId", 255),
      userRole: normalizedRole,
      membershipTier: text(membershipTier || "free", "membershipTier", 20),
      agentMode: normalizeAgentMode(agentMode),
      sessionId: text(sessionId, "sessionId", 255),
      instruction: text(instruction, "instruction", 2400),
      language: language === "en" ? "en" : "zh",
      summary: normalized.summary,
      plan: normalized.snapshot,
      requestIdempotencyKey,
      requestHash: requestHash({ userId, agentMode, sessionId, instruction, language, plan: normalized.snapshot }),
    };
    const initialSteps = normalized.executionMode === "reactive" ? normalized.calls.slice(0, 1) : normalized.calls;
    if (initialSteps.length === 0) fail("Reactive Agent plan has no initial tool call", { code: "INVALID_AGENT_PLAN_CALLS" });
    const created = await this.store.createRun({ run, steps: initialSteps });
    if (created.activeJobId || created.status !== "queued") return publicRun(created);
    try {
      const job = await this.jobQueue.enqueue({
        queueName: this.queueName,
        jobType: "agent.plan",
        userId: run.userId,
        idempotencyKey: `agent-plan:${created.id}`,
        payload: { runId: created.id },
        metadata: { title: normalized.summary, agentPlanRunId: created.id },
        maxAttempts: 3,
      });
      await this.store.attachJob({ runId: created.id, userId: run.userId, jobId: job.id });
      return this.get({ userId: run.userId, runId: created.id });
    } catch (error) {
      await this.store.failStep({
        runId: created.id,
        stepId: null,
        errorCode: safeErrorCode(error),
        errorMessage: "Agent plan could not be queued",
      });
      throw error;
    }
  }

  async get({ userId, runId }) {
    const run = await this.store.getRun({ runId: text(runId, "runId", 80), userId: text(userId, "userId", 255) });
    if (!run) fail("Agent plan was not found", { status: 404, code: "AGENT_PLAN_NOT_FOUND" });
    return publicRun(run);
  }

  async approve({ userId, runId, stepId }) {
    const owner = text(userId, "userId", 255);
    const existing = await this.store.getRun({ runId: text(runId, "runId", 80), userId: owner });
    if (!existing) fail("Agent plan was not found", { status: 404, code: "AGENT_PLAN_NOT_FOUND" });
    const step = existing.steps.find((item) => String(item.id) === String(stepId));
    if (!step) fail("Agent plan step was not found", { status: 404, code: "AGENT_PLAN_STEP_NOT_FOUND" });
    if (step.approvedAt && ["ready", "running", "completed"].includes(step.status)) return publicRun(existing);
    if (existing.status !== "waiting_approval" || step.status !== "waiting_approval" || !step.parameterDigest) {
      fail("Agent plan step is not waiting for approval", { status: 409, code: "AGENT_PLAN_APPROVAL_STATE_CONFLICT" });
    }
    const job = await this.jobQueue.enqueue({
      queueName: this.queueName,
      jobType: "agent.plan",
      userId: owner,
      idempotencyKey: `agent-plan:${existing.id}:resume:${step.position}`,
      payload: { runId: existing.id, resumeStep: step.position },
      metadata: { title: existing.summary, agentPlanRunId: existing.id },
      maxAttempts: 3,
      availableAt: new Date(Date.now() + 1_000),
    });
    await this.store.approveStep({
      runId: existing.id,
      userId: owner,
      stepId: step.id,
      parameterDigest: step.parameterDigest,
      jobId: job.id,
    });
    return this.get({ userId: owner, runId: existing.id });
  }

  async completeClientAction({ userId, runId, stepId, result }) {
    const owner = text(userId, "userId", 255);
    const existing = await this.store.getRun({ runId: text(runId, "runId", 80), userId: owner });
    if (!existing) fail("Agent plan was not found", { status: 404, code: "AGENT_PLAN_NOT_FOUND" });
    const step = existing.steps.find((item) => String(item.id) === String(stepId));
    if (!step) fail("Agent plan step was not found", { status: 404, code: "AGENT_PLAN_STEP_NOT_FOUND" });
    const storedAction = step.result?.clientAction;
    if (!storedAction || typeof storedAction !== "object" || Array.isArray(storedAction)) {
      fail("Agent plan step has no browser action", { status: 422, code: "AGENT_PLAN_CLIENT_ACTION_MISSING" });
    }
    const clientResult = safeJson(result ?? {}, "Agent browser action result", 64 * 1024);

    if (step.status === "waiting_client" && existing.status === "waiting_client") {
      const completedStep = {
        ...step,
        status: "completed",
        result: { ...(step.result || {}), clientResult },
      };
      const nextTurn = await this.nextReactiveTurn({
        ...existing,
        steps: existing.steps.map((item) => item.id === step.id ? completedStep : item),
      });
      await this.store.completeClientStepAndAppend({
        runId: existing.id,
        userId: owner,
        stepId: step.id,
        clientResult,
        newSteps: nextTurn.steps,
        finalResponse: nextTurn.finalResponse,
      });
    } else if (step.status !== "completed") {
      fail("Agent plan step is not waiting for the browser", {
        status: 409,
        code: "AGENT_PLAN_CLIENT_ACTION_STATE_CONFLICT",
      });
    }

    const updated = await this.store.getRun({ runId: existing.id, userId: owner });
    if (!updated || TERMINAL.has(updated.status) || updated.status === "running") return publicRun(updated);
    const nextStep = updated.steps.find((item) => item.status !== "completed");
    if (!nextStep) return publicRun(updated);
    const job = await this.jobQueue.enqueue({
      queueName: this.queueName,
      jobType: "agent.plan",
      userId: owner,
      idempotencyKey: `agent-plan:${updated.id}:client:${step.position}`,
      payload: { runId: updated.id, resumeStep: nextStep.position },
      metadata: { title: updated.summary, agentPlanRunId: updated.id },
      maxAttempts: 3,
      availableAt: new Date(Date.now() + 1_000),
    });
    await this.store.attachJob({ runId: updated.id, userId: owner, jobId: job.id });
    return this.get({ userId: owner, runId: updated.id });
  }

  async cancel({ userId, runId, reason = "Cancelled by user" }) {
    const owner = text(userId, "userId", 255);
    const existing = await this.store.getRun({ runId: text(runId, "runId", 80), userId: owner });
    if (!existing) fail("Agent plan was not found", { status: 404, code: "AGENT_PLAN_NOT_FOUND" });
    const cancelled = await this.store.cancelRun({ runId: existing.id, userId: owner, reason: text(reason, "reason", 500) });
    if (existing.activeJobId) {
      try { await this.jobQueue.cancel({ jobId: existing.activeJobId, userId: owner, reason }); } catch { /* already settled */ }
    }
    return publicRun({ ...cancelled, steps: existing.steps.map((step) => (
      ["ready", "running", "waiting_approval", "waiting_client"].includes(step.status) ? { ...step, status: "cancelled" } : step
    )) });
  }

  async nextReactiveTurn(current) {
    if ((current.plan?.executionMode || current.plan?.execution_mode) !== "reactive" || !this.reactPlanner) {
      return { steps: [], finalResponse: "" };
    }
    if (current.steps.length >= MAX_CALLS) {
      return { steps: [], finalResponse: current.language === "en" ? "I completed the available execution steps." : "我已完成当前可执行的步骤。" };
    }
    const runtime = await this.runtimeFactory();
    const pendingMedia = unresolvedMediaCreation(current.steps);
    if (pendingMedia) {
      const normalized = normalizePlan({
        plan: {
          summary: "Wait for the submitted media task.",
          execution_mode: "reactive",
          calls: [{
            id: `observe_media_${current.steps.length + 1}`,
            name: "Check media generation status",
            toolKey: "creation.get",
            reason: "Observe the existing media task until it reaches a terminal state; never submit a replacement task while it is pending.",
            parameters: { creationId: pendingMedia.creationId },
          }],
        },
        tools: runtime.listTools({ userRole: current.userRole, globalOnly: true }),
      });
      return {
        steps: normalized.calls.map((step, index) => ({
          ...step,
          position: current.steps.length + index + 1,
        })),
        finalResponse: "",
      };
    }
    const observations = current.steps
      .filter((step) => step.status === "completed")
      .map((step) => ({
        stepId: String(step.id),
        callId: step.callId,
        toolKey: step.toolKey,
        status: step.status,
        result: step.result,
      }));
    const nextPlan = await this.reactPlanner({
      userId: current.userId,
      runId: current.id,
      modelKey: current.plan?.model_key || current.plan?.modelKey || null,
      userRole: current.userRole,
      membershipTier: current.membershipTier,
      instruction: current.instruction,
      language: current.language,
      tools: runtime.listTools({ userRole: current.userRole, globalOnly: true }),
      context: {
        ...(current.plan?.react_context || current.plan?.reactContext || {}),
        reactive: true,
        observations,
      },
    });
    const remaining = MAX_CALLS - current.steps.length;
    const seededCalls = (Array.isArray(nextPlan?.calls) ? nextPlan.calls : [])
      .slice(0, remaining)
      .map((call, index) => ({
        ...call,
        id: `react_${current.steps.length + 1}_${index + 1}`,
      }));
    if (seededCalls.length === 0) {
      return {
        steps: [],
        finalResponse: text(
          nextPlan?.response || nextPlan?.final_response || nextPlan?.finalResponse || nextPlan?.summary || "",
          "Agent final response",
          2_400,
          { required: false },
        ),
      };
    }
    const normalized = normalizePlan({
      plan: { ...nextPlan, execution_mode: "reactive", calls: seededCalls },
      tools: runtime.listTools({ userRole: current.userRole, globalOnly: true }),
    });
    return {
      steps: normalized.calls.map((step, index) => ({
        ...step,
        position: current.steps.length + index + 1,
      })),
      finalResponse: "",
    };
  }

  async executeJob(job) {
    const runId = text(job?.payload?.runId || job?.payload?.run_id, "runId", 80);
    const run = await this.store.getRun({ runId });
    if (!run) fail("Agent plan was not found", { status: 404, code: "AGENT_PLAN_NOT_FOUND" });
    if (String(job.userId || job.user_id) !== String(run.userId)) {
      fail("Durable Agent plan owner does not match the job", { status: 403, code: "AGENT_PLAN_JOB_OWNER_MISMATCH" });
    }
    if (TERMINAL.has(run.status)) return publicRun(run);

    let current = run;
    while (!TERMINAL.has(current.status)) {
      const step = current.steps.find((item) => item.status !== "completed");
      if (!step) return this.get({ userId: current.userId, runId: current.id });
      if (step.status === "waiting_approval" && !step.approvedAt) return publicRun(current);
      if (step.status === "waiting_client") return publicRun(current);
      if (step.status === "running") {
        // A worker may have persisted the provider result just before its
        // lease expired or the ReAct planner timed out. Resume from the
        // observation; never execute that successful tool a second time.
        if (step.resultPersisted && (current.plan?.executionMode || current.plan?.execution_mode) === "reactive") {
          try {
            const nextTurn = await this.nextReactiveTurn({
              ...current,
              steps: current.steps.map((item) => item.id === step.id ? { ...item, status: "completed" } : item),
            });
            await this.store.completeStepAndAppend({
              runId: current.id,
              stepId: step.id,
              result: step.result,
              approvalConsumed: Boolean(step.approvalConsumedAt),
              newSteps: nextTurn.steps,
              finalResponse: nextTurn.finalResponse,
            });
            current = await this.store.getRun({ runId: current.id });
            continue;
          } catch (error) {
            if (isRetryable(error) && Number(job.attempts || 0) < Number(job.maxAttempts || 1)) throw error;
            await this.store.failStep({
              runId: current.id,
              stepId: step.id,
              errorCode: "AGENT_REACT_PLANNER_FAILED",
              errorMessage: safeErrorMessage(error),
            });
            return this.get({ userId: current.userId, runId: current.id });
          }
        }
        await this.store.failStep({
          runId: current.id,
          stepId: step.id,
          errorCode: "AGENT_STEP_EXECUTION_UNCERTAIN",
          errorMessage: "Execution state is uncertain after a worker interruption; the step was not repeated",
        });
        return this.get({ userId: current.userId, runId: current.id });
      }
      if (step.status === "failed" || step.status === "cancelled") return publicRun(current);

      let markedRunning = false;
      let operationClass = null;
      let resultPersisted = false;
      try {
        if ((current.plan?.executionMode || current.plan?.execution_mode) === "reactive"
            && MEDIA_GENERATION_TOOLS.has(step.toolKey)
            && unresolvedMediaCreation(current.steps.slice(0, step.position - 1))) {
          fail("A previous media generation task is still pending", {
            status: 409,
            code: "AGENT_MEDIA_GENERATION_ALREADY_PENDING",
          });
        }
        const resolvedParameters = resolveAgentStepReferences(
          step.parameters,
          buildAgentStepContext(current.steps.slice(0, step.position - 1)),
        );
        const runtime = await this.runtimeFactory();
        const context = await this.trustedContextResolver({
          userId: current.userId,
          toolKey: step.toolKey,
          parameters: resolvedParameters,
        });
        const decision = runtime.assess({
          userId: current.userId,
          userRole: current.userRole,
          agentMode: current.agentMode,
          sessionId: current.sessionId,
          toolKey: step.toolKey,
          parameters: resolvedParameters,
          context,
        });
        operationClass = decision.operationClass || null;
        if (decision.decision === AGENT_DECISIONS.DENY) {
          fail(decision.reason || "Agent tool call was denied", {
            status: decision.reasonCode === "AGENT_TOOL_NOT_FOUND" ? 404 : 403,
            code: decision.reasonCode || "AGENT_TOOL_DENIED",
          });
        }
        if (decision.requiresApproval && !step.approvedAt) {
          await this.store.markWaitingApproval({
            runId: current.id,
            stepId: step.id,
            resolvedParameters,
            parameterDigest: decision.parameterDigest,
            reasonCode: decision.reasonCode,
          });
          return this.get({ userId: current.userId, runId: current.id });
        }
        if (decision.requiresApproval && step.parameterDigest !== decision.parameterDigest) {
          fail("Approved Agent parameters changed before execution", {
            status: 409,
            code: "AGENT_PLAN_APPROVAL_DIGEST_MISMATCH",
          });
        }

        await this.store.markStepRunning({
          runId: current.id,
          stepId: step.id,
          resolvedParameters,
          parameterDigest: decision.parameterDigest,
        });
        markedRunning = true;

        let approvalToken = null;
        if (decision.requiresApproval) {
          const approval = await runtime.issueApproval({
            userId: current.userId,
            userRole: current.userRole,
            agentMode: current.agentMode,
            sessionId: current.sessionId,
            toolKey: step.toolKey,
            parameters: resolvedParameters,
            context,
            reason: `Durable Agent plan ${current.id}, step ${step.position}`,
          });
          approvalToken = approval.approvalToken;
        }
        const executed = await runtime.execute({
          userId: current.userId,
          userRole: current.userRole,
          membershipTier: current.membershipTier,
          agentMode: current.agentMode,
          sessionId: current.sessionId,
          toolKey: step.toolKey,
          parameters: resolvedParameters,
          context: {
            ...context,
            idempotencyKey: executionIdempotencyKeyForStep(step),
            agentPlanRunId: current.id,
          },
          approvalToken,
        });
        const result = safeJson(executed.result ?? null, "Agent step result", MAX_STEP_RESULT_BYTES);
        if (result?.clientAction && typeof result.clientAction === "object" && !Array.isArray(result.clientAction)) {
          const actionType = String(result.clientAction.type || "").trim();
          if (!actionType || actionType.length > 120) {
            fail("Agent browser action type is invalid", { code: "AGENT_PLAN_CLIENT_ACTION_INVALID" });
          }
          await this.store.markWaitingClient({ runId: current.id, stepId: step.id, result });
          return this.get({ userId: current.userId, runId: current.id });
        }
        if (isMediaObservationStep(step) && isPendingCreationResult(result)) {
          const previousAttempt = Number(step.result?.agentPolling?.attempt || 0);
          const pollAttempt = previousAttempt + 1;
          const deferredResult = safeJson({
            ...result,
            agentPolling: {
              attempt: pollAttempt,
              creationId: mediaCreationId(result) || String(resolvedParameters.creationId || ""),
              nextCheckAfterMs: this.mediaPollIntervalMs,
            },
          }, "Agent media observation result", MAX_STEP_RESULT_BYTES);
          return this.deferMediaObservation({
            current,
            step,
            result: deferredResult,
            pollAttempt,
          });
        }
        await this.store.recordStepResult({ runId: current.id, stepId: step.id, result });
        resultPersisted = true;
        const nextTurn = await this.nextReactiveTurn({
          ...current,
          steps: current.steps.map((item) => item.id === step.id ? { ...item, status: "completed", result } : item),
        });
        await this.store.completeStepAndAppend({
          runId: current.id,
          stepId: step.id,
          result,
          approvalConsumed: decision.requiresApproval,
          newSteps: nextTurn.steps,
          finalResponse: nextTurn.finalResponse,
        });
        current = await this.store.getRun({ runId: current.id });
        const deferredObservation = nextTurn.steps.find(isMediaObservationStep);
        if (deferredObservation) {
          const persistedStep = current.steps.find((item) => item.callId === deferredObservation.callId);
          if (persistedStep) {
            return this.deferMediaObservation({
              current,
              step: persistedStep,
              result: undefined,
              pollAttempt: 0,
            });
          }
        }
      } catch (error) {
        // A provider status endpoint can briefly fail while the creation is
        // still running. Keep the observation step durable and poll again;
        // only a confirmed terminal creation status should fail the Agent run.
        if (!resultPersisted && isMediaObservationStep(step) && isRetryable(error)) {
          const previousResult = step.result && typeof step.result === "object" && !Array.isArray(step.result)
            ? step.result
            : {};
          const previousAttempt = Number(previousResult.agentPolling?.attempt || 0);
          const creationId = mediaCreationId(previousResult)
            || String(step.resolvedParameters?.creationId || step.parameters?.creationId || "").trim();
          const deferredResult = safeJson({
            ...previousResult,
            id: previousResult.id || creationId || undefined,
            status: creationStatus(previousResult) || "pending",
            agentPolling: {
              ...(previousResult.agentPolling || {}),
              attempt: previousAttempt + 1,
              creationId,
              nextCheckAfterMs: this.mediaPollIntervalMs,
              lastTransientError: safeErrorCode(error),
            },
          }, "Agent media observation result", MAX_STEP_RESULT_BYTES);
          return this.deferMediaObservation({
            current,
            step,
            result: deferredResult,
            pollAttempt: previousAttempt + 1,
          });
        }
        if (resultPersisted) {
          if (isRetryable(error) && Number(job.attempts || 0) < Number(job.maxAttempts || 1)) throw error;
          await this.store.failStep({
            runId: current.id,
            stepId: step.id,
            errorCode: "AGENT_REACT_PLANNER_FAILED",
            errorMessage: safeErrorMessage(error),
          });
          return this.get({ userId: current.userId, runId: current.id });
        }
        const retryable = markedRunning
          && AUTOMATIC_RETRY_OPERATION_CLASSES.has(operationClass)
          && isRetryable(error)
          && Number(job.attempts || 0) < Number(job.maxAttempts || 1);
        if (retryable) {
          await this.store.resetStepForRetry({ runId: current.id, stepId: step.id, errorCode: safeErrorCode(error) });
          throw error;
        }
        await this.store.failStep({
          runId: current.id,
          stepId: step.id,
          errorCode: safeErrorCode(error),
          errorMessage: safeErrorMessage(error),
        });
        return this.get({ userId: current.userId, runId: current.id });
      }
    }
    return publicRun(current);
  }
}

export { publicRun as mapPublicAgentPlanRun };
