import { createHash, randomUUID } from "node:crypto";
import { isRetryableAgentError } from "../../domain/agent/retryPolicy.js";

import { writeAuditLog } from "../../services/auditService.js";
import {
  getCanvasAgentConversation,
  saveCanvasAgentConversation,
} from "./conversationService.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);
const PENDING_CREATION_STATUSES = new Set(["queued", "pending", "running", "in_progress", "processing"]);
const TERMINAL_CREATION_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MEDIA_GENERATION_TOOLS = new Set(["media.generate.image", "media.generate.video"]);
const MAX_REASONING_STEPS = 40;
const MAX_STORED_STEPS = 240;

const defaultConversationRepository = Object.freeze({
  get: getCanvasAgentConversation,
  save: saveCanvasAgentConversation,
});

const fail = (message, code = "CANVAS_AGENT_RUN_FAILED", status = 400, extra = {}) => {
  throw Object.assign(new Error(message), { code, status, ...extra });
};

const clean = (value, max) => String(value || "").trim().slice(0, max);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const normalizeRole = (value) => ["user", "admin", "root"].includes(value) ? value : "user";
const normalizeTier = (value) => ["free", "basic", "pro", "max", "enterprise"].includes(value) ? value : "free";
const normalizeMode = (value) => ["ask_for_approval", "approve_for_me", "full_access"].includes(value)
  ? value
  : "approve_for_me";

const uniqueBy = (items, keyOf, limit) => {
  const rows = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push(item);
    if (rows.length >= limit) break;
  }
  return rows;
};

export const normalizeCanvasAgentRunContext = (value) => {
  const source = object(value);
  const templates = uniqueBy((Array.isArray(source.templates) ? source.templates : []).map((item) => ({
    kind: "template",
    id: clean(item?.id || item?.templateId || item?.template_id, 80),
    sceneKey: clean(item?.sceneKey || item?.scene_key, 120),
    outputType: ["image", "video"].includes(clean(item?.outputType || item?.output_type, 20).toLowerCase())
      ? clean(item?.outputType || item?.output_type, 20).toLowerCase()
      : null,
  })).filter((item) => item.id), (item) => item.id, 8);
  const referenceImages = uniqueBy((Array.isArray(source.referenceImages) ? source.referenceImages : []).map((item) => ({
    kind: "canvas_image",
    elementId: clean(item?.elementId || item?.element_id, 80),
    title: clean(item?.title, 120),
  })).filter((item) => item.elementId), (item) => item.elementId, 4);
  const selectedTemplateId = clean(source.selectedTemplateId || source.selected_template_id, 80);
  return {
    templates,
    referenceImages,
    selectedTemplateId: templates.some((item) => item.id === selectedTemplateId)
      ? selectedTemplateId
      : templates[0]?.id || null,
  };
};

export const bindCanvasAgentRunContextParameters = ({ toolKey, parameters, contextSnapshot } = {}) => {
  const next = { ...object(parameters) };
  if (!MEDIA_GENERATION_TOOLS.has(clean(toolKey, 128).toLowerCase())) return next;
  const attachedIds = (Array.isArray(contextSnapshot?.referenceImages) ? contextSnapshot.referenceImages : [])
    .map((item) => clean(item?.elementId || item?.element_id, 80))
    .filter(Boolean);
  const explicitIds = (Array.isArray(next.referenceElementIds) ? next.referenceElementIds : [])
    .map((item) => clean(item, 80))
    .filter(Boolean);
  const referenceElementIds = [...new Set([...explicitIds, ...attachedIds])].slice(0, 4);
  if (referenceElementIds.length) next.referenceElementIds = referenceElementIds;
  return next;
};

const normalizeTrustedWorkflowTemplate = (value) => {
  const sceneKey = clean(value?.sceneKey || value?.scene_key, 120);
  const outputType = clean(value?.outputType || value?.output_type, 20).toLowerCase();
  if (!sceneKey || !["image", "video"].includes(outputType)) return null;
  return {
    id: clean(value?.id || value?.templateId || value?.template_id, 80) || null,
    sceneKey,
    outputType,
    fallback: Boolean(value?.fallback),
  };
};

export const trustedWorkflowTemplateObservations = (steps) => {
  const candidates = [];
  for (const step of steps || []) {
    if (step?.status !== "completed") continue;
    if (step.toolKey === "template.search" && Array.isArray(step.result)) {
      candidates.push(...step.result);
    } else if (step.toolKey === "template.read") {
      candidates.push(step.result);
    } else if (step.toolKey === "workflow.catalog") {
      candidates.push(...Object.values(object(step.result?.fallbackTemplates)));
    }
  }
  return uniqueBy(
    candidates.map(normalizeTrustedWorkflowTemplate).filter(Boolean),
    (template) => `${template.outputType}:${template.id || ""}:${template.sceneKey}`,
    80,
  );
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const digest = (value) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

const requireIdempotencyKey = (value) => {
  const key = clean(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    fail("A valid 8-128 character idempotency key is required", "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
};

const creationIdOf = (result) => clean(
  result?.creationId || result?.creation_id || result?.creation?.id || result?.id,
  80,
);

const creationStatusOf = (result) => clean(
  result?.status || result?.creation?.status || result?.providerStatus || result?.provider_status,
  40,
).toLowerCase();

const isPendingCreation = (result) => {
  const status = creationStatusOf(result);
  return PENDING_CREATION_STATUSES.has(status)
    || ["submitted", "reconciliation_pending"].includes(clean(result?.kind, 40).toLowerCase());
};

const isSuccessfulMediaResult = (result) => {
  const status = creationStatusOf(result);
  if (!creationIdOf(result) || ["failed", "cancelled"].includes(status)) return false;
  return status === "completed"
    || (!status && (result?.content || result?.imageUrl || result?.image_url || clean(result?.kind, 40).toLowerCase() === "completed"));
};

export const findDuplicateCompletedMediaStep = ({ steps = [], toolKey, parameters, excludeStepId = null } = {}) => {
  const normalizedToolKey = clean(toolKey, 128).toLowerCase();
  if (!MEDIA_GENERATION_TOOLS.has(normalizedToolKey)) return null;
  const requestDigest = digest({ toolKey: normalizedToolKey, parameters: object(parameters) });
  return (steps || []).find((step) => (
    step?.id !== excludeStepId
    && step?.status === "completed"
    && clean(step?.toolKey, 128).toLowerCase() === normalizedToolKey
    && isSuccessfulMediaResult(step.result)
    && digest({ toolKey: normalizedToolKey, parameters: object(step.parameters) }) === requestDigest
  )) || null;
};

const unresolvedMediaCreation = (steps) => {
  const pending = new Map();
  const observe = (result, sourceStep) => {
    const creationId = creationIdOf(result);
    if (!creationId) return;
    if (isPendingCreation(result)) {
      pending.set(creationId, { creationId, sourceStep });
      return;
    }
    if (TERMINAL_CREATION_STATUSES.has(creationStatusOf(result))) pending.delete(creationId);
  };
  const observeWorkflowResult = (value, sourceStep, seen = new Set(), depth = 0) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) return;
    seen.add(value);
    observe(value, sourceStep);
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) nested.slice(0, 80).forEach((item) => observeWorkflowResult(item, sourceStep, seen, depth + 1));
      else observeWorkflowResult(nested, sourceStep, seen, depth + 1);
    }
  };
  for (const step of steps || []) {
    if (step.status !== "completed") continue;
    const creationId = creationIdOf(step.result);
    if (creationId && MEDIA_GENERATION_TOOLS.has(step.toolKey) && isPendingCreation(step.result)) {
      pending.set(creationId, { creationId, sourceStep: step });
      continue;
    }
    if (step.toolKey === "creation.get") {
      const requestedId = creationId || clean(step.parameters?.creationId, 80);
      const status = creationStatusOf(step.result);
      if (requestedId && TERMINAL_CREATION_STATUSES.has(status)) pending.delete(requestedId);
      else if (requestedId && PENDING_CREATION_STATUSES.has(status)) {
        pending.set(requestedId, { creationId: requestedId, sourceStep: step });
      }
    }
    // A workflow can submit image/video tasks inside node results. Treat those
    // exactly like direct media calls so the planner cannot create a second run
    // while the first output is still settling.
    if (["workflow.run", "workflow.get"].includes(step.toolKey)) observeWorkflowResult(step.result, step);
  }
  return [...pending.values()].at(-1) || null;
};

const terminalWorkflowObservation = (steps) => [...(steps || [])].reverse().find((step) => (
  step?.status === "completed"
  && step.toolKey === "workflow.get"
  && clean(step?.result?.status || step?.result?.run?.status, 40).toLowerCase() === "completed"
)) || null;

const safeErrorCode = (error) => {
  const candidate = clean(error?.code || "CANVAS_AGENT_STEP_FAILED", 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(candidate)
    ? candidate
    : "CANVAS_AGENT_STEP_FAILED";
};

const safeProviderDetail = (error) => {
  const detail = error?.details;
  const message = detail?.error?.message || detail?.message || detail?.error?.code;
  if (!message) return "";
  return clean(String(message)
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}/gi, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]"), 420);
};

const safeErrorMessage = (error) => {
  const status = Number(error?.status || 500);
  const detail = safeProviderDetail(error);
  if (detail) return clean(`Canvas Agent provider error: ${detail}`, 500);
  if (safeErrorCode(error) === "INSUFFICIENT_POINTS") return clean(error?.message || "积分不足，未执行生成任务。", 500);
  if (status >= 500) return `Canvas Agent step execution failed (${safeErrorCode(error)})`;
  return clean(error?.message || "Canvas Agent step execution failed", 500);
};

const isRetryable = isRetryableAgentError;
const publicTimestamp = (value) => value instanceof Date ? value.toISOString() : value ?? null;
const conversationWasArchived = (error) => error?.code === "CANVAS_AGENT_CONVERSATION_NOT_FOUND";

const publicRun = (run) => run ? ({
  id: run.id,
  conversationId: run.conversationId,
  canvasId: run.canvasId,
  agentMode: run.agentMode,
  models: { text: run.textModel, image: run.imageModel ?? null, video: run.videoModel ?? null },
  instruction: run.instruction,
  language: run.language,
  status: run.status,
  currentStep: run.currentStep,
  progress: run.progress,
  finalSummary: run.finalSummary ?? null,
  errorCode: run.errorCode ?? null,
  errorMessage: run.errorMessage ?? null,
  cancelReason: run.cancelReason ?? null,
  createdAt: publicTimestamp(run.createdAt),
  updatedAt: publicTimestamp(run.updatedAt),
  startedAt: publicTimestamp(run.startedAt),
  completedAt: publicTimestamp(run.completedAt),
  failedAt: publicTimestamp(run.failedAt),
  cancelledAt: publicTimestamp(run.cancelledAt),
  steps: (run.steps || []).map((step) => ({
    id: step.id,
    position: step.position,
    thought: step.thought,
    toolKey: step.toolKey ?? null,
    parameters: step.parameters ?? {},
    result: step.result ?? null,
    status: step.status,
    requiresApproval: step.requiresApproval,
    approvalReasonCode: step.approvalReasonCode ?? null,
    approvedAt: publicTimestamp(step.approvedAt),
    errorCode: step.errorCode ?? null,
    errorMessage: step.errorMessage ?? null,
    createdAt: publicTimestamp(step.createdAt),
    startedAt: publicTimestamp(step.startedAt),
    completedAt: publicTimestamp(step.completedAt),
  })),
}) : null;

export class CanvasAgentRunService {
  constructor({ store, jobQueue, toolRegistry, planner, conversationRepository = defaultConversationRepository, auditWriter = writeAuditLog, queueName = "canvas_agent", mediaPollIntervalMs = 5_000 } = {}) {
    if (!store || typeof store.createRun !== "function") throw new TypeError("CanvasAgentRunStore is required");
    if (!jobQueue || typeof jobQueue.enqueue !== "function") throw new TypeError("JobQueuePort is required");
    if (!toolRegistry || typeof toolRegistry.execute !== "function") throw new TypeError("CanvasAgentToolRegistry is required");
    if (typeof planner !== "function") throw new TypeError("Canvas Agent planner is required");
    if (!conversationRepository || typeof conversationRepository.get !== "function" || typeof conversationRepository.save !== "function") throw new TypeError("Canvas Agent conversation repository is required");
    if (typeof auditWriter !== "function") throw new TypeError("Canvas Agent audit writer is required");
    this.store = store;
    this.jobQueue = jobQueue;
    this.toolRegistry = toolRegistry;
    this.planner = planner;
    this.conversations = conversationRepository;
    this.auditWriter = auditWriter;
    this.queueName = queueName;
    this.mediaPollIntervalMs = Math.min(30_000, Math.max(1_000, Number(mediaPollIntervalMs) || 5_000));
    // Queue insertion and active_job_id attachment are separate writes. A
    // short grace period prevents the worker from leasing a job before the
    // run can point at it.
    this.initialJobDelayMs = Math.min(5_000, Math.max(250, Number(process.env.CANVAS_AGENT_INITIAL_JOB_DELAY_MS || 750) || 750));
    this.approvalJobDelayMs = Math.min(5_000, Math.max(250, Number(process.env.CANVAS_AGENT_APPROVAL_JOB_DELAY_MS || 750) || 750));
  }

  async enqueueCycle({ run, keySuffix, delayMs = 200 }) {
    const job = await this.jobQueue.enqueue({
      queueName: this.queueName,
      jobType: "canvas.agent.react",
      userId: run.userId,
      idempotencyKey: `canvas-agent:${run.id}:${keySuffix}`,
      payload: { runId: run.id },
      metadata: { canvasAgentRunId: run.id, conversationId: run.conversationId, canvasId: run.canvasId },
      maxAttempts: 3,
      availableAt: new Date(Date.now() + Math.max(0, delayMs)),
    });
    await this.store.attachJob({
      runId: run.id,
      userId: run.userId,
      jobId: job.id,
      status: delayMs >= this.mediaPollIntervalMs ? "waiting_external" : "queued",
    });
    return job;
  }

  async start({
    userId,
    userRole = "user",
    membershipTier = "free",
    canvasId,
    conversationId,
    agentMode = "approve_for_me",
    instruction,
    language = "zh",
    context = {},
    idempotencyKey,
  } = {}) {
    const owner = clean(userId, 255);
    const targetCanvasId = clean(canvasId, 64);
    const targetConversationId = clean(conversationId, 80);
    const normalizedInstruction = clean(instruction, 12_000);
    if (!owner || !targetCanvasId || !targetConversationId || !normalizedInstruction) {
      fail("userId, canvasId, conversationId and instruction are required", "CANVAS_AGENT_INPUT_REQUIRED");
    }
    const conversation = await this.conversations.get({ userId: owner, conversationId: targetConversationId });
    if (conversation.canvas_id !== targetCanvasId) {
      fail("Canvas Agent conversation does not belong to this canvas", "CANVAS_AGENT_CONTEXT_MISMATCH", 403);
    }
    const requestIdempotencyKey = requireIdempotencyKey(idempotencyKey);
    const normalizedContext = normalizeCanvasAgentRunContext(context);
    const run = {
      id: `carun_${randomUUID().replaceAll("-", "")}`,
      conversationId: targetConversationId,
      userId: owner,
      canvasId: targetCanvasId,
      userRole: normalizeRole(userRole),
      membershipTier: normalizeTier(membershipTier),
      agentMode: normalizeMode(agentMode),
      textModel: clean(conversation.model_preferences?.textModel, 100),
      imageModel: clean(conversation.model_preferences?.imageModel, 100),
      videoModel: clean(conversation.model_preferences?.videoModel, 100),
      instruction: normalizedInstruction,
      language: language === "en" ? "en" : "zh",
      contextSnapshot: normalizedContext,
      requestIdempotencyKey,
      requestHash: digest({ owner, targetCanvasId, targetConversationId, agentMode, normalizedInstruction, context: normalizedContext }),
    };
    if (!run.textModel) fail("Canvas Agent conversation has no text model", "CANVAS_AGENT_MODEL_REQUIRED", 409);
    const created = await this.store.createRun({ run });
    if (created.activeJobId || created.status !== "queued") return publicRun(created);
    const messageId = `cam_${randomUUID().replaceAll("-", "")}`;
    await this.conversations.save({
      userId: owner,
      conversationId: targetConversationId,
      title: conversation.messages.length ? conversation.title : normalizedInstruction.slice(0, 48),
      messages: [...conversation.messages, {
        id: messageId,
        role: "user",
        content: normalizedInstruction,
        runId: created.id,
        attachments: [...normalizedContext.templates, ...normalizedContext.referenceImages],
        createdAt: new Date().toISOString(),
      }],
      runtimeState: { ...conversation.runtime_state, activeRunId: created.id },
      modelPreferences: conversation.model_preferences,
      rememberModels: false,
    });
    try {
      await this.enqueueCycle({
        run: { ...created, userId: owner },
        keySuffix: "cycle:1",
        delayMs: this.initialJobDelayMs,
      });
    } catch (error) {
      const failed = await this.store.failRun({
        runId: created.id,
        userId: owner,
        errorCode: safeErrorCode(error),
        errorMessage: "Canvas Agent run could not be queued",
      });
      if (failed) await this.settleFailedRun(failed);
      throw error;
    }
    return this.get({ userId: owner, runId: created.id });
  }

  async get({ userId, runId }) {
    const run = await this.store.getRun({ runId: clean(runId, 80), userId: clean(userId, 255) });
    if (!run) fail("Canvas Agent run was not found", "CANVAS_AGENT_RUN_NOT_FOUND", 404);
    return publicRun(run);
  }

  async events({ userId, runId, afterId = 0 }) {
    return this.store.listEvents({
      runId: clean(runId, 80),
      userId: clean(userId, 255),
      afterId: Math.max(0, Number(afterId) || 0),
    });
  }

  async approve({ userId, runId, stepId }) {
    const owner = clean(userId, 255);
    const current = await this.store.getRun({ runId: clean(runId, 80), userId: owner });
    if (!current) fail("Canvas Agent run was not found", "CANVAS_AGENT_RUN_NOT_FOUND", 404);
    const step = current.steps.find((candidate) => String(candidate.id) === String(stepId));
    if (!step) fail("Canvas Agent step was not found", "CANVAS_AGENT_STEP_NOT_FOUND", 404);
    if (step.approvedAt && ["ready", "running", "completed"].includes(step.status)) return publicRun(current);
    if (current.status !== "waiting_approval" || step.status !== "waiting_approval" || !step.parameterDigest) {
      fail("Canvas Agent step is not waiting for approval", "CANVAS_AGENT_APPROVAL_STATE_CONFLICT", 409);
    }
    const job = await this.jobQueue.enqueue({
      queueName: this.queueName,
      jobType: "canvas.agent.react",
      userId: owner,
      idempotencyKey: `canvas-agent:${current.id}:execute:${step.position}`,
      payload: { runId: current.id },
      metadata: { canvasAgentRunId: current.id, canvasId: current.canvasId },
      maxAttempts: 3,
      // The approval state change must commit before the worker can lease it.
      availableAt: new Date(Date.now() + this.approvalJobDelayMs),
    });
    await this.store.approveStep({
      runId: current.id,
      userId: owner,
      stepId: step.id,
      parameterDigest: step.parameterDigest,
      jobId: job.id,
    });
    return this.get({ userId: owner, runId: current.id });
  }

  async cancel({ userId, runId, reason = "Cancelled by user" }) {
    const owner = clean(userId, 255);
    const current = await this.store.getRun({ runId: clean(runId, 80), userId: owner });
    if (!current) fail("Canvas Agent run was not found", "CANVAS_AGENT_RUN_NOT_FOUND", 404);
    const cancelled = await this.store.cancelRun({ runId: current.id, userId: owner, reason });
    if (current.activeJobId) {
      try { await this.jobQueue.cancel({ jobId: current.activeJobId, userId: owner, reason }); } catch { /* already settled */ }
    }
    await this.settleConversation(cancelled, {
      status: "cancelled",
      content: cancelled.language === "en" ? "Canvas Agent run cancelled." : "画布 Agent 运行已取消。",
    });
    return publicRun(cancelled);
  }

  async settleConversation(run, { status, content }) {
    let conversation;
    try {
      conversation = await this.conversations.get({ userId: run.userId, conversationId: run.conversationId });
    } catch (error) {
      if (conversationWasArchived(error)) return { settled: false, reason: "conversation_archived" };
      throw error;
    }
    const assistantMessageExists = conversation.messages.some((message) => (
      message?.role === "assistant" && String(message?.runId || "") === String(run.id)
    ));
    const activeRunId = clean(conversation.runtime_state?.activeRunId || conversation.runtime_state?.active_run_id, 80);
    try {
      await this.conversations.save({
        userId: run.userId,
        conversationId: run.conversationId,
        title: conversation.title,
        messages: assistantMessageExists ? conversation.messages : [...conversation.messages, {
          id: `cam_${randomUUID().replaceAll("-", "")}`,
          role: "assistant",
          content,
          runId: run.id,
          runStatus: status,
          createdAt: new Date().toISOString(),
        }],
        runtimeState: {
          ...conversation.runtime_state,
          activeRunId: activeRunId === run.id ? null : activeRunId || null,
          lastRunId: run.id,
          lastRunStatus: status,
        },
        modelPreferences: conversation.model_preferences,
        rememberModels: false,
      });
      return { settled: true };
    } catch (error) {
      if (conversationWasArchived(error)) return { settled: false, reason: "conversation_archived" };
      throw error;
    }
  }

  async settleFailedRun(run) {
    const content = run.language === "en"
      ? `Canvas Agent stopped: ${run.errorMessage || "The requested action failed."}`
      : `画布 Agent 已停止：${run.errorMessage || "请求的操作执行失败。"}`;
    await this.settleConversation(run, { status: "failed", content });
  }

  async executeReadyStep({ run, step, job }) {
    const duplicate = findDuplicateCompletedMediaStep({
      steps: run.steps,
      toolKey: step.toolKey,
      parameters: step.parameters,
      excludeStepId: step.id,
    });
    if (duplicate) {
      await this.store.markStepRunning({
        runId: run.id,
        userId: run.userId,
        stepId: step.id,
        parameterDigest: digest({ toolKey: step.toolKey, parameters: step.parameters }),
      });
      await this.store.completeStep({
        runId: run.id,
        userId: run.userId,
        stepId: step.id,
        result: {
          ...object(duplicate.result),
          deduplicated: true,
          reusedCreationId: creationIdOf(duplicate.result),
        },
        waitingExternal: false,
      });
      const refreshed = await this.store.getRun({ runId: run.id, userId: run.userId });
      await this.enqueueCycle({
        run: refreshed,
        keySuffix: `cycle:${step.position + 1}`,
        delayMs: 200,
      });
      return this.get({ userId: run.userId, runId: run.id });
    }
    const assessment = await this.toolRegistry.assess({
      userId: run.userId,
      toolKey: step.toolKey,
      parameters: step.parameters,
      agentMode: run.agentMode,
    });
    const parameterDigest = digest({ toolKey: step.toolKey, parameters: step.parameters });
    if (assessment.requiresApproval && !step.approvedAt) {
      await this.store.markWaitingApproval({
        runId: run.id,
        userId: run.userId,
        stepId: step.id,
        parameterDigest,
        reasonCode: `mode:${run.agentMode}:${assessment.definition.operationClass}`,
      });
      return this.get({ userId: run.userId, runId: run.id });
    }
    await this.store.markStepRunning({
      runId: run.id,
      userId: run.userId,
      stepId: step.id,
      parameterDigest,
    });
    try {
      const result = await this.toolRegistry.execute({
        userId: run.userId,
        canvasId: run.canvasId,
        conversationId: run.conversationId,
        toolKey: step.toolKey,
        parameters: step.parameters,
        idempotencyKey: step.executionIdempotencyKey,
        executionContext: {
          source: "canvas_agent",
          agentMode: run.agentMode,
          userRole: run.userRole,
          approvalId: step.approvedAt ? `canvas-agent-step:${step.id}` : null,
          selectedTemplateId: clean(run.contextSnapshot?.selectedTemplateId, 80) || null,
          trustedWorkflowTemplates: trustedWorkflowTemplateObservations(run.steps),
        },
      });
      const waitingExternal = (
        (MEDIA_GENERATION_TOOLS.has(step.toolKey) || step.toolKey === "creation.get")
        && isPendingCreation(result)
      );
      await this.store.completeStep({
        runId: run.id,
        userId: run.userId,
        stepId: step.id,
        result,
        waitingExternal,
      });
      try {
        await this.auditWriter({
          actorUserId: run.userId,
          actorRole: run.userRole,
          action: "canvas_agent.tool.completed",
          targetType: "canvas_agent_run",
          targetId: run.id,
          reason: step.thought,
          metadata: { stepId: step.id, toolKey: step.toolKey, operationClass: assessment.definition.operationClass },
        });
      } catch {
        // The canvas event stream remains the authoritative per-step audit;
        // an unrelated administrator audit outage must not repeat a paid tool.
      }
      const refreshed = await this.store.getRun({ runId: run.id, userId: run.userId });
      await this.enqueueCycle({
        run: refreshed,
        keySuffix: `cycle:${step.position + 1}`,
        delayMs: waitingExternal ? this.mediaPollIntervalMs : 200,
      });
      return this.get({ userId: run.userId, runId: run.id });
    } catch (error) {
      if (isRetryable(error) && Number(job?.attempts || 0) < Number(job?.maxAttempts || 1)) {
        await this.store.resetStepForRetry({
          runId: run.id,
          userId: run.userId,
          stepId: step.id,
          errorCode: safeErrorCode(error),
        });
        throw error;
      }
      const failed = await this.store.failRun({
        runId: run.id,
        userId: run.userId,
        stepId: step.id,
        errorCode: safeErrorCode(error),
        errorMessage: safeErrorMessage(error),
      });
      if (failed) await this.settleFailedRun(failed);
      return this.get({ userId: run.userId, runId: run.id });
    }
  }

  async executeJob(job) {
    const runId = clean(job?.payload?.runId || job?.payload?.run_id, 80);
    if (!runId) fail("Canvas Agent job is missing runId", "INVALID_DURABLE_JOB_PAYLOAD");
    let run = await this.store.getRun({ runId });
    if (!run) return null;
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      if (run.status === "completed") {
        await this.settleConversation(run, { status: "completed", content: run.finalSummary || "Canvas Agent completed." });
      } else if (run.status === "failed") {
        await this.settleFailedRun(run);
      } else {
        await this.settleConversation(run, {
          status: "cancelled",
          content: run.language === "en" ? "Canvas Agent run cancelled." : "画布 Agent 运行已取消。",
        });
      }
      return publicRun(run);
    }
    if (run.status === "waiting_approval") return publicRun(run);
    if (run.activeJobId && String(run.activeJobId) !== String(job.id)) {
      return publicRun(run);
    }

    const readyStep = [...run.steps].reverse().find((step) => step.status === "ready");
    if (readyStep) return this.executeReadyStep({ run, step: readyStep, job });
    if (run.steps.length >= MAX_STORED_STEPS) {
      const failed = await this.store.failRun({
        runId: run.id,
        userId: run.userId,
        errorCode: "CANVAS_AGENT_STEP_LIMIT",
        errorMessage: "Canvas Agent reached the stored observation limit",
      });
      if (failed) await this.settleFailedRun(failed);
      return this.get({ userId: run.userId, runId: run.id });
    }

    let decision;
    const pendingMedia = unresolvedMediaCreation(run.steps);
    if (pendingMedia) {
      decision = {
        action: "tool",
        thought: run.language === "en"
          ? "Check the submitted media task without creating a duplicate."
          : "检查已提交媒体任务的进度，不重复创建任务。",
        toolKey: "creation.get",
        parameters: { creationId: pendingMedia.creationId },
      };
    } else {
      const completedWorkflow = terminalWorkflowObservation(run.steps);
      if (completedWorkflow) {
        const summary = run.language === "en"
          ? "The workflow completed. Its generated results are available on the canvas and in recent creations."
          : "工作流已完成，生成结果已保存到画布和最近作品中。";
        const completed = await this.store.completeRun({ runId: run.id, userId: run.userId, summary });
        await this.settleConversation(completed, { status: "completed", content: summary });
        return publicRun(completed);
      }
      const reasoningSteps = run.steps.filter((step) => step.toolKey !== "creation.get").length;
      if (reasoningSteps >= MAX_REASONING_STEPS) {
        const failed = await this.store.failRun({
          runId: run.id,
          userId: run.userId,
          errorCode: "CANVAS_AGENT_REASONING_STEP_LIMIT",
          errorMessage: "Canvas Agent reached the 40 action limit",
        });
        if (failed) await this.settleFailedRun(failed);
        return this.get({ userId: run.userId, runId: run.id });
      }
      try {
        const conversation = await this.conversations.get({ userId: run.userId, conversationId: run.conversationId });
        decision = await this.planner({
          userId: run.userId,
          modelKey: run.textModel,
          instruction: run.instruction,
          language: run.language,
          conversation,
          run,
          tools: this.toolRegistry.list(),
        });
      } catch (error) {
        if (isRetryable(error) && Number(job?.attempts || 0) < Number(job?.maxAttempts || 1)) throw error;
        const failed = await this.store.failRun({
          runId: run.id,
          userId: run.userId,
          errorCode: safeErrorCode(error),
          errorMessage: safeErrorMessage(error),
        });
        if (failed) await this.settleFailedRun(failed);
        return this.get({ userId: run.userId, runId: run.id });
      }
    }

    if (decision.action === "finish") {
      const completed = await this.store.completeRun({ runId: run.id, userId: run.userId, summary: decision.summary });
      await this.settleConversation(completed, { status: "completed", content: decision.summary });
      return publicRun(completed);
    }
    const boundParameters = bindCanvasAgentRunContextParameters({
      toolKey: decision.toolKey,
      parameters: decision.parameters,
      contextSnapshot: run.contextSnapshot,
    });
    const duplicate = findDuplicateCompletedMediaStep({
      steps: run.steps,
      toolKey: decision.toolKey,
      parameters: boundParameters,
    });
    if (duplicate) {
      const creationId = creationIdOf(duplicate.result);
      const summary = run.language === "en"
        ? `The image request was already completed; reused creation ${creationId}.`
        : `这次图片请求已经完成，不再重复生成，已复用结果 ${creationId}。`;
      const completed = await this.store.completeRun({ runId: run.id, userId: run.userId, summary });
      await this.settleConversation(completed, { status: "completed", content: summary });
      return publicRun(completed);
    }
    const position = run.steps.length + 1;
    const step = await this.store.addStep({
      runId: run.id,
      userId: run.userId,
      thought: decision.thought,
      toolKey: decision.toolKey,
      parameters: boundParameters,
      executionIdempotencyKey: `canvas-tool:${run.id}:${position}`,
    });
    run = await this.store.getRun({ runId: run.id, userId: run.userId });
    return this.executeReadyStep({ run, step, job });
  }
}

export { publicRun as mapPublicCanvasAgentRun, unresolvedMediaCreation };
