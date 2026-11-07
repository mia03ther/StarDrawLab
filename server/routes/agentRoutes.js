import express from "express";
import { getAgentRuntime } from "../services/agentRuntimeComposition.js";
import { getAgentPlanExecution } from "../services/agentPlanExecutionComposition.js";
import { getCreativeAgent } from "../services/creativeAgentComposition.js";
import { executeMeteredAgentOperation } from "../services/meteredAgentOperationService.js";
import {
  agentApprovalBurstLimiter,
  agentApprovalLimiter,
  agentBurstLimiter,
  agentLimiter,
} from "../middlewares/rateLimiter.js";
import { resolveTrustedGlobalAgentContext } from "../services/agentTemplateContextService.js";
import { resolveTrustedAgentToolContext } from "../services/agentTrustedContextService.js";
import { selectAgentTools } from "../services/agentToolSelectionService.js";
import {
  createAgentConversation,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  saveAgentConversation,
} from "../services/agentConversationService.js";
import {
  getGlobalAgentPreferences,
  saveGlobalAgentPreferences,
} from "../services/globalAgentPreferencesService.js";

const router = express.Router();

const requestError = (res, error, fallback = "Agent request failed") => res.status(error.status || 500).json({
  success: false,
  code: error.code || "AGENT_REQUEST_FAILED",
  message: (error.status || process.env.NODE_ENV !== "production") ? error.message : fallback,
  ...(error.decision ? { decision: error.decision } : {}),
});

const publicPlanningMessage = (error, status) => {
  if (status === 504 || error?.code === "AGENT_PROVIDER_TIMEOUT") {
    return "Agent 规划超时，请稍后重试。";
  }
  if (error?.code === "AGENT_PROVIDER_EMPTY_PLAN") {
    return "Agent 没有生成可执行计划，请换一种说法重试。";
  }
  if (["AGENT_PROVIDER_UNAVAILABLE", "AGENT_PROVIDER_RATE_LIMITED"].includes(error?.code)) {
    return "Agent 上游暂时繁忙，系统已自动重试，请稍后再试。";
  }
  if (error?.code === "AGENT_PROVIDER_INVALID_RESPONSE") {
    return "Agent 上游返回了无效响应，请稍后重试。";
  }
  if (["EXECUTION_IN_PROGRESS", "AGENT_OPERATION_IN_PROGRESS"].includes(error?.code)) {
    return "Agent 正在处理同一请求，请稍候，完成后会复用原结果。";
  }
  return status >= 500 && process.env.NODE_ENV === "production" ? "Agent is unavailable" : error.message;
};

const requireSession = (value) => {
  const sessionId = String(value || "").trim();
  if (!sessionId || sessionId.length > 255) {
    throw Object.assign(new Error("sessionId is required"), { status: 400, code: "INVALID_AGENT_SESSION" });
  }
  return sessionId;
};

const readParameters = (body) => {
  const parameters = body?.parameters;
  if (parameters == null) return {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw Object.assign(new Error("parameters must be a JSON object"), { status: 400, code: "INVALID_AGENT_PARAMETERS" });
  }
  return parameters;
};

/**
 * Resolve only server-owned context. Client-provided ownership fields are
 * intentionally ignored; otherwise a caller could turn the ownership check
 * into a self-attestation.
 */
const resolveTrustedContext = resolveTrustedAgentToolContext;

const requireIdempotencyKey = (req) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!key || key.length > 128) {
    throw Object.assign(new Error("X-Idempotency-Key header is required"), {
      status: 400,
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  }
  return key;
};

router.get("/tools", (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: getAgentRuntime().listTools({ userRole: req.auth.role, globalOnly: true }) });
  } catch (error) {
    return requestError(res, error, "Unable to list Agent tools");
  }
});

router.get("/skills", async (_req, res) => {
  try {
    const { getAgentSkillRegistry } = await import("../services/agentSkillRegistry.js");
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: await getAgentSkillRegistry().list() });
  } catch (error) {
    return requestError(res, error, "Unable to list Agent Skills");
  }
});

router.get("/preferences", async (req, res) => {
  try {
    const data = await getGlobalAgentPreferences({ userId: req.auth.userId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to read Agent preferences");
  }
});

router.put("/preferences", async (req, res) => {
  try {
    const data = await saveGlobalAgentPreferences({
      userId: req.auth.userId,
      mode: req.body?.mode,
      preferences: req.body?.agentPreferences ?? req.body?.preferences,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to save Agent preferences");
  }
});

router.get("/conversations", async (req, res) => {
  try {
    const data = await listAgentConversations({
      userId: req.auth.userId,
      surface: req.query.surface,
      canvasId: req.query.canvas_id,
      limit: req.query.limit,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to list Agent conversations");
  }
});

router.post("/conversations", async (req, res) => {
  try {
    const data = await createAgentConversation({
      userId: req.auth.userId,
      surface: req.body?.surface,
      canvasId: req.body?.canvas_id,
      title: req.body?.title,
    });
    res.set("Cache-Control", "no-store");
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to create Agent conversation");
  }
});

router.get("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await getAgentConversation({
      userId: req.auth.userId,
      conversationId: req.params.conversationId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to read Agent conversation");
  }
});

router.put("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await saveAgentConversation({
      userId: req.auth.userId,
      conversationId: req.params.conversationId,
      title: req.body?.title,
      messages: req.body?.messages,
      runtimeState: req.body?.runtime_state,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to save Agent conversation");
  }
});

router.delete("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await deleteAgentConversation({
      userId: req.auth.userId,
      conversationId: req.params.conversationId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to delete Agent conversation");
  }
});

router.post("/plan", agentBurstLimiter, agentLimiter, async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || "").trim().slice(0, 2400);
    if (!instruction) {
      throw Object.assign(new Error("instruction is required"), { status: 400, code: "AGENT_INSTRUCTION_REQUIRED" });
    }
    const sessionId = requireSession(req.body?.sessionId);
    const clientContext = req.body?.context && typeof req.body.context === "object" && !Array.isArray(req.body.context)
      ? req.body.context
      : {};
    const context = await resolveTrustedGlobalAgentContext({
      userId: req.auth.userId,
      membershipTier: req.auth.membershipTier || "free",
      instruction,
      clientContext,
    });
    const tools = selectAgentTools({
      tools: getAgentRuntime().listTools({ userRole: req.auth.role, globalOnly: true }),
      instruction,
      context,
    });
    const requestPayload = {
      instruction,
      context,
      language: req.body?.language === "en" ? "en" : "zh",
      toolKeys: tools.map((tool) => tool.toolKey),
      requestedTemplateId: context.requestedTemplate?.id || null,
      requestedTemplateVersion: context.requestedTemplate?.version || null,
      agentPreferences: context.agentPreferences,
    };
    const operation = await executeMeteredAgentOperation({
      userId: req.auth.userId,
      membershipTier: req.auth.membershipTier || "free",
      operationType: "global_agent_plan",
      idempotencyKey: req.headers["x-idempotency-key"],
      requestPayload,
      modelKey: context.agentPreferences?.agentModel || null,
      invoke: ({ route }) => getCreativeAgent().planGlobal({
        userId: req.auth.userId,
        instruction,
        context,
        tools,
        language: requestPayload.language,
        modelRoute: route,
      }),
    });
    return res.json({
      success: true,
      data: {
        ...operation.result,
        tools,
        session_id: sessionId,
      },
      operation_id: operation.operationId,
      points_charged: operation.pointsCost,
      idempotent_replay: operation.replayed,
    });
  } catch (error) {
    const status = error.code === "INSUFFICIENT_POINTS" ? 402 : (Number(error.status) || 500);
    return res.status(status).json({
      success: false,
      code: error.code || "AGENT_PLAN_FAILED",
      available_points: error.available_points,
      required_points: error.required_points,
      message: publicPlanningMessage(error, status),
    });
  }
});

router.post("/runs", agentBurstLimiter, agentLimiter, async (req, res) => {
  try {
    const data = await getAgentPlanExecution().start({
      userId: req.auth.userId,
      userRole: req.auth.role,
      membershipTier: req.auth.membershipTier || "free",
      agentMode: req.body?.agentMode,
      sessionId: requireSession(req.body?.sessionId),
      instruction: String(req.body?.instruction || "").trim(),
      language: req.body?.language === "en" ? "en" : "zh",
      plan: req.body?.plan,
      idempotencyKey: requireIdempotencyKey(req),
    });
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to start Agent plan");
  }
});

router.get("/runs/:runId", async (req, res) => {
  try {
    const data = await getAgentPlanExecution().get({
      userId: req.auth.userId,
      runId: req.params.runId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to read Agent plan");
  }
});

router.post("/runs/:runId/steps/:stepId/approve", agentApprovalBurstLimiter, agentApprovalLimiter, async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw Object.assign(new Error("Explicit user confirmation is required"), {
        status: 400,
        code: "USER_CONFIRMATION_REQUIRED",
      });
    }
    const data = await getAgentPlanExecution().approve({
      userId: req.auth.userId,
      runId: req.params.runId,
      stepId: req.params.stepId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to approve Agent plan step");
  }
});

router.post("/runs/:runId/steps/:stepId/client-complete", agentApprovalLimiter, async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw Object.assign(new Error("Explicit browser action confirmation is required"), {
        status: 400,
        code: "USER_CONFIRMATION_REQUIRED",
      });
    }
    const result = req.body?.result == null ? {} : req.body.result;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw Object.assign(new Error("Browser action result must be a JSON object"), {
        status: 400,
        code: "INVALID_AGENT_CLIENT_RESULT",
      });
    }
    const data = await getAgentPlanExecution().completeClientAction({
      userId: req.auth.userId,
      runId: req.params.runId,
      stepId: req.params.stepId,
      result,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to complete Agent browser action");
  }
});

router.post("/runs/:runId/cancel", async (req, res) => {
  try {
    requireIdempotencyKey(req);
    const data = await getAgentPlanExecution().cancel({
      userId: req.auth.userId,
      runId: req.params.runId,
      reason: req.body?.reason || "Cancelled by user",
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to cancel Agent plan");
  }
});

router.post("/tools/assess", async (req, res) => {
  try {
    const parameters = readParameters(req.body);
    const context = await resolveTrustedContext({
      userId: req.auth.userId,
      toolKey: req.body?.toolKey,
      parameters,
    });
    const data = getAgentRuntime().assess({
      userId: req.auth.userId,
      userRole: req.auth.role,
      agentMode: req.body?.agentMode,
      sessionId: requireSession(req.body?.sessionId),
      toolKey: req.body?.toolKey,
      parameters,
      context,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to assess Agent tool call");
  }
});

router.post("/approvals", agentApprovalLimiter, async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw Object.assign(new Error("Explicit user confirmation is required"), {
        status: 400,
        code: "USER_CONFIRMATION_REQUIRED",
      });
    }
    const parameters = readParameters(req.body);
    const context = await resolveTrustedContext({
      userId: req.auth.userId,
      toolKey: req.body?.toolKey,
      parameters,
    });
    const data = await getAgentRuntime().issueApproval({
      userId: req.auth.userId,
      userRole: req.auth.role,
      agentMode: req.body?.agentMode,
      sessionId: requireSession(req.body?.sessionId),
      toolKey: req.body?.toolKey,
      parameters,
      context,
      reason: req.body?.reason,
    });
    res.set("Cache-Control", "no-store");
    return res.status(201).json({
      success: true,
      data: {
        approval_id: data.approvalId,
        approval_token: data.approvalToken,
        parameter_digest: data.parameterDigest,
        expires_at: data.expiresAt,
        decision: data.decision,
        reason_code: data.reasonCode,
      },
    });
  } catch (error) {
    return requestError(res, error, "Unable to issue Agent approval");
  }
});

router.post("/approvals/revoke", async (req, res) => {
  try {
    const data = await getAgentRuntime().revokeApproval({
      approvalId: req.body?.approvalId || req.body?.approval_id,
      approvalToken: req.body?.approvalToken || req.body?.approval_token,
      userId: req.auth.userId,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to revoke Agent approval");
  }
});

router.post("/tools/execute", agentBurstLimiter, agentLimiter, async (req, res) => {
  try {
    const parameters = readParameters(req.body);
    const context = await resolveTrustedContext({
      userId: req.auth.userId,
      toolKey: req.body?.toolKey,
      parameters,
    });
    const data = await getAgentRuntime().execute({
      userId: req.auth.userId,
      userRole: req.auth.role,
      agentMode: req.body?.agentMode,
      sessionId: requireSession(req.body?.sessionId),
      toolKey: req.body?.toolKey,
      parameters,
      context: {
        ...context,
        idempotencyKey: req.headers["x-idempotency-key"] || null,
      },
      approvalToken: req.body?.approvalToken || req.body?.approval_token,
      membershipTier: req.auth.membershipTier || "free",
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: { decision: data.decision, result: data.result } });
  } catch (error) {
    return requestError(res, error, "Unable to execute Agent tool");
  }
});

export default router;
