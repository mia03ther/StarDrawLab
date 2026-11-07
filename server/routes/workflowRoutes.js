import express from "express";
import { getWorkflowRuntime } from "../services/workflowRuntimeComposition.js";
import { workflowBurstLimiter, workflowLimiter } from "../middlewares/rateLimiter.js";
import { workflowContainsMcpCall } from "../services/workflowCostService.js";
import { listCanvasWorkflowNodeCatalog } from "../modules/canvas-workflows/workflowCatalog.js";
import {
  archiveCanvasWorkflow,
  createCanvasWorkflow,
  getCanvasWorkflow,
  listCanvasWorkflows,
  runCanvasWorkflowDefinition,
  updateCanvasWorkflow,
} from "../modules/canvas-workflows/definitionService.js";

const router = express.Router();

const fail = (res, error, fallback) => res.status(error.status || 500).json({
  success: false,
  code: error.code || "WORKFLOW_REQUEST_FAILED",
  message: (error.status || process.env.NODE_ENV !== "production") ? error.message : fallback,
  ...(error.available_points != null ? { available_points: error.available_points } : {}),
  ...(error.required_points != null ? { required_points: error.required_points } : {}),
  ...(error.currentVersion != null ? { currentVersion: error.currentVersion } : {}),
  ...(error.runId != null ? { runId: error.runId } : {}),
  ...(error.locked != null ? { locked: Boolean(error.locked) } : {}),
});

const idempotencyKey = (req) => String(req.headers["x-idempotency-key"] || "").trim();

router.get("/catalog", (_req, res) => {
  res.set("Cache-Control", "private, max-age=300");
  return res.json({ success: true, data: listCanvasWorkflowNodeCatalog() });
});

router.get("/definitions", async (req, res) => {
  try {
    const data = await listCanvasWorkflows({
      userId: req.auth.userId,
      canvasId: String(req.query.canvas_id || req.query.canvasId || "").trim(),
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to list workflows");
  }
});

router.post("/definitions", async (req, res) => {
  try {
    const data = await createCanvasWorkflow({
      userId: req.auth.userId,
      canvasId: req.body?.canvasId || req.body?.canvas_id,
      name: req.body?.name,
      definition: req.body?.definition || {},
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to create workflow");
  }
});

router.get("/definitions/:workflowId", async (req, res) => {
  try {
    const data = await getCanvasWorkflow({ userId: req.auth.userId, workflowId: req.params.workflowId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to load workflow definition");
  }
});

router.put("/definitions/:workflowId", async (req, res) => {
  try {
    const data = await updateCanvasWorkflow({
      userId: req.auth.userId,
      workflowId: req.params.workflowId,
      name: req.body?.name,
      definition: req.body?.definition || {},
      expectedVersion: req.body?.expectedVersion ?? req.body?.expected_version,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to update workflow");
  }
});

router.delete("/definitions/:workflowId", async (req, res) => {
  try {
    const data = await archiveCanvasWorkflow({ userId: req.auth.userId, workflowId: req.params.workflowId });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to archive workflow");
  }
});

router.post("/definitions/:workflowId/run", workflowBurstLimiter, workflowLimiter, async (req, res) => {
  try {
    const key = idempotencyKey(req);
    if (!key) throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
    const data = await runCanvasWorkflowDefinition({
      userId: req.auth.userId,
      workflowId: req.params.workflowId,
      idempotencyKey: key,
      mcpApprovalConfirmed: req.body?.mcpApprovalConfirmed === true || req.body?.mcp_approval_confirmed === true,
      userRole: req.auth.role,
      variables: req.body?.variables,
      inputs: req.body?.inputs,
    });
    return res.status(data.replayed ? 200 : 202).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to run workflow");
  }
});

router.post("/estimate", async (req, res) => {
  try {
    const data = await getWorkflowRuntime().estimate({
      userId: req.auth.userId,
      definition: req.body?.definition || req.body,
    });
    return res.json({
      success: true,
      data: {
        definition: data.definition,
        estimate: data.estimate,
        estimated_points: data.estimate.totalPoints,
      },
    });
  } catch (error) {
    return fail(res, error, "Unable to estimate workflow cost");
  }
});

router.post("/runs", workflowBurstLimiter, workflowLimiter, async (req, res) => {
  try {
    const key = idempotencyKey(req);
    if (!key) throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
    const definition = req.body?.definition || {};
    const containsMcp = workflowContainsMcpCall(definition);
    if (containsMcp && req.body?.mcpApprovalConfirmed !== true && req.body?.mcp_approval_confirmed !== true) {
      throw Object.assign(new Error("Workflow MCP calls require explicit user confirmation"), {
        status: 403,
        code: "WORKFLOW_MCP_APPROVAL_REQUIRED",
      });
    }
    const data = await getWorkflowRuntime().start({
      userId: req.auth.userId,
      canvasId: req.body?.canvasId || req.body?.canvas_id || null,
      title: req.body?.title,
      definition,
      idempotencyKey: key,
      executionContext: {
        source: "user_direct",
        agentMode: containsMcp ? "full_access" : "approve_for_me",
        userRole: req.auth.role,
        membershipTier: req.auth.membershipTier || "free",
        approvalId: containsMcp ? `workflow-user-confirmed:${key}` : null,
      },
      variables: req.body?.variables,
      inputs: req.body?.inputs,
    });
    return res.status(data.replayed ? 200 : 202).json({
      success: true,
      data: {
        run: data.run,
        estimate: data.estimate,
        estimated_points: data.estimate.totalPoints,
        available_points: data.availablePoints,
        idempotent_replay: data.replayed,
      },
    });
  } catch (error) {
    return fail(res, error, "Unable to start workflow");
  }
});

router.get("/runs/:runId", async (req, res) => {
  try {
    const data = await getWorkflowRuntime().getRun({ userId: req.auth.userId, runId: req.params.runId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to load workflow");
  }
});

router.post("/runs/:runId/nodes/:nodeKey/approve", async (req, res) => {
  try {
    if (req.body?.confirmed !== true) {
      throw Object.assign(new Error("Explicit workflow approval confirmation is required"), {
        status: 400,
        code: "WORKFLOW_APPROVAL_CONFIRMATION_REQUIRED",
      });
    }
    const data = await getWorkflowRuntime().approveNode({
      userId: req.auth.userId,
      runId: req.params.runId,
      nodeKey: req.params.nodeKey,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to approve workflow node");
  }
});

router.post("/runs/:runId/nodes/:nodeKey/retry", async (req, res) => {
  try {
    const data = await getWorkflowRuntime().retryNode({
      userId: req.auth.userId,
      runId: req.params.runId,
      nodeKey: req.params.nodeKey,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to retry workflow node");
  }
});

router.post("/runs/:runId/cancel", async (req, res) => {
  try {
    const data = await getWorkflowRuntime().cancel({
      userId: req.auth.userId,
      runId: req.params.runId,
      reason: req.body?.reason,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to cancel workflow");
  }
});

/**
 * Lightweight SSE progress stream. The run remains durable in PostgreSQL;
 * SSE is only a presentation adapter and can be reconnected at any time.
 */
router.get("/runs/:runId/events", async (req, res) => {
  const runtime = getWorkflowRuntime();
  const runId = req.params.runId;
  const userId = req.auth.userId;
  let timer;
  let closed = false;
  let lastId = Number(req.query.after || 0);
  if (!Number.isSafeInteger(lastId) || lastId < 0) lastId = 0;

  try {
    const data = await runtime.getRun({ userId, runId });
    if (!data) return res.status(404).end();
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
        const rows = await runtime.events({ userId, runId, afterId: lastId });
        for (const row of rows) {
          lastId = Number(row.id);
          res.write(`id: ${row.id}\nevent: ${row.event_type}\ndata: ${JSON.stringify(row.payload || {})}\n\n`);
        }
        res.write(": heartbeat\n\n");
      } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify({ code: error.code || "WORKFLOW_EVENTS_FAILED" })}\n\n`);
      }
    };
    await poll();
    timer = setInterval(() => void poll(), 1500);
    const timeout = setTimeout(() => {
      if (!closed) res.end();
    }, 60_000);
    req.on("close", () => {
      closed = true;
      clearInterval(timer);
      clearTimeout(timeout);
    });
  } catch (error) {
    if (!res.headersSent) return fail(res, error, "Unable to stream workflow events");
    res.end();
  }
});

export default router;
