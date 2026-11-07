import sql from "../configs/db.js";
import { createPostgresJobQueue } from "./postgresJobQueue.js";
import { normalizeCanvasState } from "../domain/canvas/canvasState.js";
import { WorkflowExecutionService } from "./workflowExecutionService.js";
import { getExecutionGovernor } from "./executionGovernorComposition.js";
import { getGenerationApplication } from "./generationApplicationService.js";
import { getCreativeAgent } from "./creativeAgentComposition.js";
import { getCreativeLlmModelKey } from "./creativeLlmConfiguration.js";
import { executeMeteredAgentOperation } from "./meteredAgentOperationService.js";
import { getMcpToolRuntime } from "./mcpRuntimeComposition.js";
import { resolveCharge } from "./pointsService.js";
import { getObjectStorage } from "./objectStorageComposition.js";
import { needsVideoReconciliation, syncVideoCreationStatus } from "./videoStatusService.js";
import {
  createWorkflowProductionNodeHandlers,
  resolveWorkflowProductionNodeCost,
} from "./workflowProductionNodeHandlers.js";
import { assertTemplateMembership } from "../domain/templates/templateAccessPolicy.js";
import { estimateWorkflowCost, normalizeWorkflowDefinition } from "./workflowCostService.js";
import { createWorkflowControlNodeHandlers } from "../modules/canvas-workflows/controlNodeHandlers.js";
import { createWorkflowLoopNodeHandlers } from "../modules/canvas-workflows/loopNodeHandlers.js";
import { interpolateWorkflowValue } from "../modules/canvas-workflows/expression.js";
import { appendCanvasRevision } from "./canvasRevisionService.js";

let workflowRuntime;
const WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS = Math.min(1000, Math.max(25, Number(process.env.WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS || 360) || 360));

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const dbJson = (db, value) => (typeof db?.json === "function" ? db.json(value) : JSON.stringify(value));
const withResolvedWorkflowConfig = (handler) => (runtime) => handler({
  ...runtime,
  config: interpolateWorkflowValue(object(runtime.config), {
    nodes: object(runtime.inputs),
    inputs: object(runtime.executionContext?.inputs),
    variables: object(runtime.executionContext?.variables),
    loop: object(runtime.executionContext?.loop),
  }),
});

const FREE_NODE_TYPES = new Set([
  "input",
  "canvas.image",
  "canvas.video",
  "join",
  "merge",
  "canvas.read",
  "canvas.action",
  "canvas.set_state",
  "storyboard.edit",
  "template.use",
  "approval.wait",
  "approval",
  "condition.rule",
  "noop",
]);

export const resolveWorkflowNodeExecutionCosts = async (definition, {
  userId = null,
  sqlClient = sql,
  resolveChargeFn = resolveCharge,
} = {}) => {
  const costs = new Map();
  for (const rawNode of definition?.nodes || []) {
    const nodeKey = String(rawNode?.id || rawNode?.nodeKey || rawNode?.node_key || "").trim();
    const nodeType = String(rawNode?.type || rawNode?.nodeType || rawNode?.node_type || "").trim().toLowerCase();
    if (FREE_NODE_TYPES.has(nodeType)) {
      costs.set(nodeKey, 0);
      continue;
    }
    const config = rawNode?.config && typeof rawNode.config === "object" ? rawNode.config : {};
    if (["loop.foreach", "loop.repeat_until"].includes(nodeType)) {
      const body = config.body && typeof config.body === "object" ? config.body : { nodes: [] };
      if (!Array.isArray(body.nodes) || body.nodes.length === 0) {
        costs.set(nodeKey, 0);
        continue;
      }
      const bodyCosts = await resolveWorkflowNodeExecutionCosts(body, { userId, sqlClient, resolveChargeFn });
      const normalizedBody = normalizeWorkflowDefinition(body, {
        resolveNodeCost: ({ nodeKey: childKey }) => bodyCosts.get(childKey) || 0,
      });
      const bodyEstimate = estimateWorkflowCost(normalizedBody.nodes);
      const maxIterations = Math.min(
        Math.max(1, Number(process.env.WORKFLOW_LOOP_MAX_ITERATIONS || 20) || 20),
        Math.max(1, Number(config.maxIterations || config.max_iterations || 20) || 20),
      );
      costs.set(nodeKey, bodyEstimate.totalPoints * maxIterations);
      continue;
    }
    if (["image.generate", "media.generate.image", "video.generate", "media.generate.video"].includes(nodeType)) {
      const outputType = nodeType.includes("video") ? "video" : "image";
      const sceneKey = String(config.sceneKey || config.scene_key || rawNode.sceneKey || rawNode.scene_key || "").trim();
      const [template] = await sqlClient`
        SELECT target_provider, default_model, default_seconds, default_size,
               required_membership_tier, owner_user_id
        FROM prompt_templates
        WHERE scene_key = ${sceneKey} AND is_active = TRUE
          AND (
            (${userId}::varchar IS NOT NULL AND owner_user_id = ${userId})
            OR (visibility = 'public' AND approval_status = 'approved')
          )
        LIMIT 1
      `;
      if (!template) {
        throw Object.assign(new Error(`Workflow template is unavailable: ${sceneKey || "<empty>"}`), {
          status: 404,
          code: "WORKFLOW_TEMPLATE_UNAVAILABLE",
        });
      }
      if (String(template.required_membership_tier || "free") !== "free"
          && String(template.owner_user_id || "") !== String(userId || "")) {
        const [account] = await sqlClient`
          SELECT COALESCE(membership_tier, 'free') AS membership_tier
          FROM user_point_accounts
          WHERE user_id = ${userId}
          LIMIT 1
        `;
        assertTemplateMembership({
          template,
          userId,
          membershipTier: account?.membership_tier || "free",
        });
      }
      costs.set(nodeKey, await resolveChargeFn({
        outputType,
        provider: template.target_provider,
        sceneKey,
        model: config.model || rawNode.model || template.default_model,
        seconds: outputType === "video" ? (config.seconds ?? template.default_seconds) : null,
        size: config.size || rawNode.size || template.default_size,
      }));
      continue;
    }
    if (["agent.call", "condition.ai"].includes(nodeType)) {
      costs.set(nodeKey, await resolveChargeFn({
        outputType: "agent", provider: "canvas_agent", sceneKey: "canvas_agent_plan",
        model: config.model || rawNode.model || getCreativeLlmModelKey(), seconds: null, size: null,
      }));
      continue;
    }
    if (nodeType === "script.optimize") {
      costs.set(nodeKey, await resolveChargeFn({
        outputType: "agent", provider: "canvas_agent", sceneKey: "digital_human_script_optimizer",
        model: getCreativeLlmModelKey(), seconds: null, size: null,
      }));
      continue;
    }
    // MCP has no platform point rule. It still goes through OAuth, approval,
    // rate, concurrency and audit controls at execution time.
    costs.set(nodeKey, resolveWorkflowProductionNodeCost(nodeType));
  }
  return costs;
};

const createCanvasStateHandler = (sqlClient) => async ({ userId, canvasId, config }) => sqlClient.begin(async (tx) => {
  const targetId = String(canvasId || "").trim();
  if (!targetId) throw Object.assign(new Error("canvasId is required for canvas workflow nodes"), { status: 400, code: "CANVAS_ID_REQUIRED" });
  const [row] = await tx`
    SELECT id, title, canvas_state
    FROM canvases WHERE id = ${targetId} AND user_id = ${userId} FOR UPDATE
  `;
  if (!row) throw Object.assign(new Error("Canvas not found"), { status: 404, code: "CANVAS_NOT_FOUND" });
  const nextState = normalizeCanvasState(config?.state || config?.canvasState || row.canvas_state);
  const title = String(config?.title || row.title || "Untitled Canvas").trim().slice(0, 120) || "Untitled Canvas";
  const [updated] = await tx`
    UPDATE canvases
    SET title = ${title}, canvas_state = ${dbJson(tx, nextState)}, updated_at = NOW()
    WHERE id = ${targetId} AND user_id = ${userId}
    RETURNING id, title, canvas_state, updated_at
  `;
  const revision = await appendCanvasRevision({
    db: tx,
    userId,
    canvasId: targetId,
    title: updated.title,
    canvasState: nextState,
    reason: "workflow.canvas_updated",
  });
  return { id: updated.id, title: updated.title, state: updated.canvas_state, updatedAt: updated.updated_at, revision };
});

export const createCanvasReadNodeHandler = (sqlClient) => async ({ userId, canvasId }) => {
  const targetId = String(canvasId || "").trim();
  if (!targetId) throw Object.assign(new Error("canvasId is required"), { status: 400, code: "CANVAS_ID_REQUIRED" });
  const [row] = await sqlClient`
    SELECT id, title, canvas_state, created_at, updated_at
    FROM canvases WHERE id = ${targetId} AND user_id = ${userId}
  `;
  if (!row) throw Object.assign(new Error("Canvas not found"), { status: 404, code: "CANVAS_NOT_FOUND" });
  return {
    id: row.id,
    title: row.title,
    state: normalizeCanvasState(row.canvas_state),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export const createCanvasMediaNodeHandler = (sqlClient, expectedType) => async ({ userId, canvasId, config }) => {
  const targetId = String(canvasId || "").trim();
  const elementId = String(config?.elementId || config?.element_id || "").trim();
  if (!targetId) throw Object.assign(new Error("canvasId is required"), { status: 400, code: "CANVAS_ID_REQUIRED" });
  if (!elementId) throw Object.assign(new Error("A canvas media element is required"), { status: 400, code: "CANVAS_MEDIA_ELEMENT_REQUIRED" });
  const [canvas] = await sqlClient`
    SELECT id, canvas_state
    FROM canvases
    WHERE id = ${targetId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!canvas) throw Object.assign(new Error("Canvas not found"), { status: 404, code: "CANVAS_NOT_FOUND" });
  const state = normalizeCanvasState(canvas.canvas_state);
  const element = state.elements.find((candidate) => String(candidate?.id || "") === elementId);
  if (!element || element.type !== expectedType) {
    throw Object.assign(new Error(`The selected canvas ${expectedType} is unavailable`), {
      status: 404,
      code: "CANVAS_MEDIA_ELEMENT_NOT_FOUND",
    });
  }
  const creationId = String(element.creationId || "").trim();
  const resourceId = String(element.resourceId || "").trim();
  return {
    kind: "canvas_media",
    mediaType: expectedType,
    elementId,
    creationId,
    resourceId,
    referenceId: creationId || (resourceId ? `upload:${resourceId}` : ""),
    content: element.src || "",
    thumbnailUrl: element.poster || (expectedType === "image" ? element.src || "" : ""),
    title: element.title || (expectedType === "image" ? "Canvas image" : "Canvas video"),
    objectKey: element.objectKey || "",
  };
};

const createStoryboardNodeHandler = (sqlClient) => async ({ userId, canvasId, config, inputs }) => sqlClient.begin(async (tx) => {
  const targetId = String(canvasId || "").trim();
  if (!targetId) throw Object.assign(new Error("canvasId is required"), { status: 400, code: "CANVAS_ID_REQUIRED" });
  const fromInputs = Object.values(inputs || {}).find(
    (value) => value?.storyboard || Array.isArray(value?.shots),
  );
  const storyboard = config?.storyboard || config?.value || fromInputs?.storyboard || fromInputs;
  if (!storyboard || typeof storyboard !== "object") throw Object.assign(new Error("storyboard is required"), { status: 400, code: "STORYBOARD_REQUIRED" });
  const [row] = await tx`SELECT id, title, canvas_state FROM canvases WHERE id = ${targetId} AND user_id = ${userId} FOR UPDATE`;
  if (!row) throw Object.assign(new Error("Canvas not found"), { status: 404, code: "CANVAS_NOT_FOUND" });
  const state = normalizeCanvasState({ ...(row.canvas_state || {}), storyboard });
  await tx`UPDATE canvases SET canvas_state = ${dbJson(tx, state)}, updated_at = NOW() WHERE id = ${targetId} AND user_id = ${userId}`;
  const revision = await appendCanvasRevision({
    db: tx,
    userId,
    canvasId: targetId,
    title: row.title,
    canvasState: state,
    reason: "workflow.storyboard_updated",
  });
  return { canvasId: targetId, storyboard: state.storyboard, revision };
});

const createTemplateNodeHandler = (sqlClient) => async ({ userId, config }) => {
  const templateId = String(config?.templateId || config?.template_id || "").trim();
  const sceneKey = String(config?.sceneKey || config?.scene_key || "").trim();
  if (!templateId && !sceneKey) throw Object.assign(new Error("templateId or sceneKey is required"), { status: 400, code: "TEMPLATE_IDENTIFIER_REQUIRED" });
  const rows = templateId
    ? await sqlClient`SELECT * FROM prompt_templates WHERE id::text = ${templateId} AND is_active = TRUE AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved')) LIMIT 1`
    : await sqlClient`SELECT * FROM prompt_templates WHERE scene_key = ${sceneKey} AND is_active = TRUE AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved')) LIMIT 1`;
  if (!rows[0]) throw Object.assign(new Error("Template not found"), { status: 404, code: "TEMPLATE_NOT_FOUND" });
  if (String(rows[0].required_membership_tier || "free") !== "free"
      && String(rows[0].owner_user_id || "") !== String(userId)) {
    const [account] = await sqlClient`
      SELECT COALESCE(membership_tier, 'free') AS membership_tier
      FROM user_point_accounts
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    assertTemplateMembership({
      template: rows[0],
      userId,
      membershipTier: account?.membership_tier || "free",
    });
  }
  return rows[0];
};

const mapCompletedCreation = (creation) => ({
  kind: "completed",
  creationId: String(creation.id),
  status: creation.status,
  content: creation.content,
  thumbnailUrl: creation.thumbnail_url,
  pointsCharged: Number(creation.points_cost || 0),
  expiresAt: creation.expires_at,
});

const createVideoResultResolver = (sqlClient) => async ({ userId, result, attemptCount = 1 }) => {
  const creationId = String(result?.creationId || result?.creation_id || "").trim();
  if (!creationId) return result;
  const [existing] = await sqlClient`SELECT * FROM creations WHERE id = ${creationId} AND user_id = ${userId} LIMIT 1`;
  if (!existing) throw Object.assign(new Error("Workflow video creation not found"), { status: 404, code: "CREATION_NOT_FOUND", terminalWorkflowNode: true });
  let creation = existing;
  if (needsVideoReconciliation(existing)) {
    const synced = await syncVideoCreationStatus(existing);
    if (!synced?.success) {
      throw Object.assign(new Error(synced?.message || "Video status reconciliation failed"), {
        status: 503,
        code: "WORKFLOW_VIDEO_RECONCILIATION_FAILED",
        retryAfterMs: 10_000,
        creationId,
        terminalWorkflowNode: Number(attemptCount) >= WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS,
      });
    }
    creation = synced.creation || existing;
  }
  if (creation.status === "completed") return mapCompletedCreation(creation);
  if (creation.status === "failed") {
    throw Object.assign(new Error(creation.error_message || "Workflow video generation failed"), {
      status: 502,
      code: "WORKFLOW_VIDEO_GENERATION_FAILED",
      creationId,
      terminalWorkflowNode: true,
    });
  }
  throw Object.assign(new Error("Workflow video is still processing"), {
    status: 503,
    code: "WORKFLOW_NODE_EXTERNAL_PENDING",
    retryAfterMs: 10_000,
    creationId,
    terminalWorkflowNode: Number(attemptCount) >= WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS,
  });
};

export const createWorkflowReferenceImageResolver = (sqlClient, objectStorage = getObjectStorage()) => async ({ userId, creationId }) => {
  const referenceId = String(creationId || "").trim();
  const uploadMatch = referenceId.match(/^upload:(\d+)$/);
  if (uploadMatch) {
    const [upload] = await sqlClient`
      SELECT upload.object_key, upload.mime_type
      FROM user_content_uploads upload
      WHERE upload.id = ${uploadMatch[1]}::bigint
        AND upload.user_id = ${userId}
        AND upload.media_type = 'image'
        AND NOT EXISTS (
          SELECT 1
          FROM content_recycle_entries recycle
          WHERE recycle.resource_type = 'upload'
            AND recycle.resource_id = upload.id::text
            AND recycle.status = 'active'
        )
      LIMIT 1
    `;
    if (!upload) throw Object.assign(new Error("Workflow reference image is unavailable"), { status: 404, code: "WORKFLOW_REFERENCE_IMAGE_UNAVAILABLE" });
    const downloaded = await objectStorage.downloadBuffer(upload.object_key);
    return [{ buffer: downloaded.buffer, mimetype: downloaded.contentType || upload.mime_type || "image/jpeg" }];
  }

  const [creation] = await sqlClient`
    SELECT id, content_object_key
    FROM creations
    WHERE id = ${referenceId} AND user_id = ${userId} AND type = 'image'
      AND status = 'completed' AND content_object_key IS NOT NULL
    LIMIT 1
  `;
  if (!creation) throw Object.assign(new Error("Workflow reference image is unavailable"), { status: 404, code: "WORKFLOW_REFERENCE_IMAGE_UNAVAILABLE" });
  const downloaded = await objectStorage.downloadBuffer(creation.content_object_key);
  return [{ buffer: downloaded.buffer, mimetype: downloaded.contentType || "image/jpeg" }];
};

export const resolveWorkflowCanvasPlacement = ({ state, config, nodePosition, nodeKey, elements, width, height, index = 0 } = {}) => {
  const requested = config?.canvasPosition || config?.canvas_position;
  if (Number.isFinite(Number(requested?.x)) && Number.isFinite(Number(requested?.y))) {
    return { x: Math.round(Number(requested.x)), y: Math.round(Number(requested.y)) };
  }

  if (Number.isFinite(Number(nodePosition?.x)) && Number.isFinite(Number(nodePosition?.y))) {
    const safeNodeKey = String(nodeKey || "").replace(/[^A-Za-z0-9._:-]/g, "_");
    const x = Number(nodePosition.x) + (228 - width) / 2;
    let y = Number(nodePosition.y) + 112 + 40;
    const related = (Array.isArray(elements) ? elements : [])
      .filter((element) => String(element?.workflowNodeKey || "") === String(nodeKey || "")
        || (safeNodeKey && String(element?.id || "").startsWith(`workflow_${safeNodeKey}_`)))
      .sort((first, second) => Number(first?.y || 0) - Number(second?.y || 0));
    for (const existing of related) {
      const existingX = Number(existing?.x) || 0;
      const existingY = Number(existing?.y) || 0;
      const existingWidth = Math.max(1, Number(existing?.width) || width);
      const existingHeight = Math.max(1, Number(existing?.height) || height);
      const overlaps = x < existingX + existingWidth + 24
        && x + width + 24 > existingX
        && y < existingY + existingHeight + 24
        && y + height + 24 > existingY;
      if (overlaps) y = existingY + existingHeight + 24;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  const viewport = state?.viewport || {};
  const scale = Math.max(0.05, Number(viewport.scale) || 1);
  const viewportSize = config?.canvasViewport || config?.canvas_viewport || {};
  const boardWidth = Math.max(320, Number(viewportSize.width) || 1280);
  const boardHeight = Math.max(240, Number(viewportSize.height) || 720);
  const offset = Math.max(0, Number(index) || 0) % 4;
  return {
    x: Math.round((boardWidth / 2 - (Number(viewport.x) || 0)) / scale - width / 2 + offset * 28),
    y: Math.round((boardHeight / 2 - (Number(viewport.y) || 0)) / scale - height / 2 + offset * 28),
  };
};

const createCanvasResultWriter = (sqlClient) => async ({ userId, runId, canvasId, nodeKey, nodeType, config, result }) => {
  const targetId = String(canvasId || "").trim();
  const creationId = String(result?.creationId || result?.creation_id || "").trim();
  if (!targetId || !creationId || config?.insertIntoCanvas === false || config?.insert_into_canvas === false) return result;
  return sqlClient.begin(async (tx) => {
    const [[creation], [canvas], [run]] = await Promise.all([
      tx`SELECT id, type, status, scene_name, content, thumbnail_url, content_object_key, prompt FROM creations WHERE id = ${creationId} AND user_id = ${userId} LIMIT 1`,
      tx`SELECT id, title, canvas_state FROM canvases WHERE id = ${targetId} AND user_id = ${userId} FOR UPDATE`,
      tx`SELECT definition_snapshot FROM workflow_runs WHERE id = ${runId} AND user_id = ${userId} AND canvas_id = ${targetId} LIMIT 1`,
    ]);
    if (!creation || creation.status !== "completed" || !creation.content || !canvas) return result;
    const state = normalizeCanvasState(canvas.canvas_state || {});
    const elementId = `workflow_${String(nodeKey).replace(/[^A-Za-z0-9._:-]/g, "_")}_${creationId}`.slice(0, 80);
    if (state.elements.some((element) => element.id === elementId || element.creationId === creationId)) {
      return { ...result, canvasId: targetId, canvasElementId: elementId };
    }
    const index = state.elements.length;
    const isVideo = creation.type === "video" || String(nodeType).includes("video");
    const width = isVideo ? 380 : 320;
    const height = isVideo ? 214 : 320;
    const sourceNode = (run?.definition_snapshot?.nodes || []).find((node) => String(node?.nodeKey || node?.id || "") === String(nodeKey));
    const placement = resolveWorkflowCanvasPlacement({
      state,
      config,
      nodePosition: sourceNode,
      nodeKey,
      elements: state.elements,
      width,
      height,
      index,
    });
    state.elements.push({
      id: elementId,
      type: isVideo ? "video" : "image",
      x: placement.x,
      y: placement.y,
      width,
      height,
      title: creation.scene_name || (isVideo ? "Workflow video" : "Workflow image"),
      creationId,
      src: creation.content,
      poster: creation.thumbnail_url || "",
      source: "workflow_generation",
      workflowNodeKey: String(nodeKey || ""),
      workflowRunId: String(runId || ""),
      objectKey: creation.content_object_key || "",
      prompt: creation.prompt || config?.prompt || "",
    });
    const normalized = normalizeCanvasState(state);
    await tx`UPDATE canvases SET canvas_state = ${dbJson(tx, normalized)}, updated_at = NOW() WHERE id = ${targetId} AND user_id = ${userId}`;
    const revision = await appendCanvasRevision({
      db: tx,
      userId,
      canvasId: targetId,
      title: canvas.title,
      canvasState: normalized,
      reason: "workflow.media_inserted",
    });
    return { ...result, canvasId: targetId, canvasElementId: elementId, revision };
  });
};

export const buildRuntime = ({
  sqlClient = sql,
  queue = createPostgresJobQueue({ sqlClient }),
  governor = getExecutionGovernor(),
  productionHandlerDependencies = {},
} = {}) => {
  const canvasStateHandler = createCanvasStateHandler(sqlClient);
  const productionHandlers = createWorkflowProductionNodeHandlers({
    generationApplicationFactory: getGenerationApplication,
    creativeAgentFactory: getCreativeAgent,
    executeMeteredAgentOperation,
    mcpRuntimeFactory: getMcpToolRuntime,
    videoResultResolver: createVideoResultResolver(sqlClient),
    referenceImageResolver: createWorkflowReferenceImageResolver(sqlClient),
    canvasResultWriter: createCanvasResultWriter(sqlClient),
    ...productionHandlerDependencies,
  });
  let runtime;
  const controlHandlers = createWorkflowControlNodeHandlers({ defaultTextModel: getCreativeLlmModelKey });
  const loopHandlers = createWorkflowLoopNodeHandlers({
    sqlClient,
    workflowRuntimeFactory: () => runtime,
  });
  runtime = new WorkflowExecutionService({
    sqlClient,
    queue,
    resolveNodeCosts: resolveWorkflowNodeExecutionCosts,
    governor,
    handlers: new Map([
      ...productionHandlers,
      ...controlHandlers,
      ...loopHandlers,
      ["input", withResolvedWorkflowConfig(async ({ config }) => ({ value: config?.value ?? config?.prompt ?? config ?? null }))],
      ["noop", async () => ({ kind: "noop" })],
      ["join", async ({ inputs }) => ({ inputs: inputs || {} })],
      ["merge", async ({ inputs }) => ({ inputs: inputs || {} })],
      ["canvas.read", createCanvasReadNodeHandler(sqlClient)],
      ["canvas.image", createCanvasMediaNodeHandler(sqlClient, "image")],
      ["canvas.video", createCanvasMediaNodeHandler(sqlClient, "video")],
      ["canvas.action", withResolvedWorkflowConfig(canvasStateHandler)],
      ["canvas.set_state", withResolvedWorkflowConfig(canvasStateHandler)],
      ["storyboard.edit", withResolvedWorkflowConfig(createStoryboardNodeHandler(sqlClient))],
      ["template.use", withResolvedWorkflowConfig(createTemplateNodeHandler(sqlClient))],
    ]),
  });
  return runtime;
};

export const getWorkflowRuntime = () => {
  if (!workflowRuntime) workflowRuntime = buildRuntime();
  return workflowRuntime;
};

export const resetWorkflowRuntimeForTests = () => {
  workflowRuntime = null;
};
