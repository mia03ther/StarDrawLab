import express from "express";

import { agentApprovalLimiter, agentLimiter } from "../../middlewares/rateLimiter.js";
import {
  archiveCanvasAgentConversation,
  createCanvasAgentConversation,
  getCanvasAgentConversation,
  listCanvasAgentConversations,
  saveCanvasAgentConversation,
} from "./conversationService.js";
import { getCanvasModelPreferences, saveCanvasModelPreferences } from "./modelPreferencesService.js";
import { getCanvasAgentRuntime } from "./composition.js";
import { getCanvasAgentToolRegistry } from "./toolRegistry.js";

const router = express.Router();

const requestError = (res, error, fallback) => {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    success: false,
    code: error?.code || "CANVAS_AGENT_REQUEST_FAILED",
    message: status >= 500 && process.env.NODE_ENV === "production" ? fallback : String(error?.message || fallback),
    ...(error?.available_points != null ? { available_points: error.available_points } : {}),
    ...(error?.required_points != null ? { required_points: error.required_points } : {}),
  });
};

const requiredCanvasId = (req) => {
  const canvasId = String(req.query.canvas_id || req.query.canvasId || req.body?.canvas_id || req.body?.canvasId || "").trim();
  if (!canvasId) throw Object.assign(new Error("canvasId is required"), { status: 400, code: "CANVAS_ID_REQUIRED" });
  return canvasId;
};

const requiredIdempotencyKey = (req) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!key) throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  return key;
};

router.get("/tools", (_req, res) => {
  res.set("Cache-Control", "private, max-age=60");
  return res.json({ success: true, data: getCanvasAgentToolRegistry().list() });
});

router.get("/models", async (req, res) => {
  try {
    const data = await getCanvasModelPreferences({ userId: req.auth.userId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to load Canvas Agent models");
  }
});

router.put("/models", async (req, res) => {
  try {
    const data = await saveCanvasModelPreferences({ userId: req.auth.userId, patch: req.body || {} });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to save Canvas Agent models");
  }
});

router.get("/conversations", async (req, res) => {
  try {
    const data = await listCanvasAgentConversations({
      userId: req.auth.userId,
      canvasId: requiredCanvasId(req),
      limit: req.query.limit,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to list Canvas Agent conversations");
  }
});

router.post("/conversations", async (req, res) => {
  try {
    const data = await createCanvasAgentConversation({
      userId: req.auth.userId,
      canvasId: requiredCanvasId(req),
      title: req.body?.title,
    });
    res.set("Cache-Control", "no-store");
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to create Canvas Agent conversation");
  }
});

router.get("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await getCanvasAgentConversation({ userId: req.auth.userId, conversationId: req.params.conversationId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to read Canvas Agent conversation");
  }
});

router.put("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await saveCanvasAgentConversation({
      userId: req.auth.userId,
      conversationId: req.params.conversationId,
      title: req.body?.title,
      messages: req.body?.messages,
      runtimeState: req.body?.runtime_state || req.body?.runtimeState,
      modelPreferences: req.body?.model_preferences || req.body?.modelPreferences,
      rememberModels: req.body?.remember_models !== false,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to save Canvas Agent conversation");
  }
});

router.delete("/conversations/:conversationId", async (req, res) => {
  try {
    const data = await archiveCanvasAgentConversation({ userId: req.auth.userId, conversationId: req.params.conversationId });
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to archive Canvas Agent conversation");
  }
});

router.post("/runs", agentLimiter, async (req, res) => {
  try {
    const instruction = String(req.body?.instruction || "").trim();
    if (!instruction) throw Object.assign(new Error("instruction is required"), { status: 400, code: "AGENT_INSTRUCTION_REQUIRED" });
    const data = await getCanvasAgentRuntime().start({
      userId: req.auth.userId,
      userRole: req.auth.role,
      membershipTier: req.auth.membershipTier || "free",
      canvasId: req.body?.canvas_id || req.body?.canvasId,
      conversationId: req.body?.conversation_id || req.body?.conversationId,
      agentMode: req.body?.agent_mode || req.body?.agentMode,
      instruction,
      language: req.body?.language === "en" ? "en" : "zh",
      context: req.body?.context,
      idempotencyKey: requiredIdempotencyKey(req),
    });
    res.set("Cache-Control", "no-store");
    return res.status(data.status === "queued" && !data.activeJobId ? 201 : 202).json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Canvas Agent is unavailable");
  }
});

router.get("/runs/:runId", async (req, res) => {
  try {
    const data = await getCanvasAgentRuntime().get({ userId: req.auth.userId, runId: req.params.runId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to read Canvas Agent run");
  }
});

router.post("/runs/:runId/steps/:stepId/approve", agentApprovalLimiter, async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw Object.assign(new Error("Explicit user confirmation is required"), { status: 400, code: "USER_CONFIRMATION_REQUIRED" });
    }
    const data = await getCanvasAgentRuntime().approve({
      userId: req.auth.userId,
      runId: req.params.runId,
      stepId: req.params.stepId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to approve Canvas Agent step");
  }
});

router.post("/runs/:runId/cancel", async (req, res) => {
  try {
    const data = await getCanvasAgentRuntime().cancel({
      userId: req.auth.userId,
      runId: req.params.runId,
      reason: req.body?.reason,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return requestError(res, error, "Unable to cancel Canvas Agent run");
  }
});

router.get("/runs/:runId/events", async (req, res) => {
  const runtime = getCanvasAgentRuntime();
  const userId = req.auth.userId;
  const runId = req.params.runId;
  let timer;
  let closed = false;
  let lastId = Math.max(0, Number(req.query.after || 0) || 0);
  try {
    await runtime.get({ userId, runId });
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const poll = async () => {
      if (closed) return;
      try {
        const events = await runtime.events({ userId, runId, afterId: lastId });
        for (const event of events) {
          lastId = Number(event.id);
          res.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.payload)}\n\n`);
        }
        res.write(": heartbeat\n\n");
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: error.code || "CANVAS_AGENT_EVENTS_FAILED" })}\n\n`);
      }
    };
    await poll();
    timer = setInterval(() => void poll(), 1_200);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  } catch (error) {
    return requestError(res, error, "Unable to stream Canvas Agent events");
  }
});

export default router;
