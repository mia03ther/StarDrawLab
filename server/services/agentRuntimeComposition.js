import { randomBytes, randomUUID } from "node:crypto";
import sql from "../configs/db.js";
import { normalizeCanvasState } from "../domain/canvas/canvasState.js";
import {
  applyAgentWorkflowOperations,
  canonicalizeAgentWorkflowDefinition,
  listWorkflowAgentNodeTypes,
} from "../domain/workflow/workflowAgentDefinition.js";
import { PostgresAgentApprovalStore, PostgresAgentAuditSink } from "../infrastructure/postgresAgentRuntime.js";
import { AgentApprovalService } from "./agentApprovalService.js";
import { AgentPolicyService } from "./agentPolicyService.js";
import { AgentToolRegistry, DEFAULT_AGENT_TOOLS } from "./agentToolRegistry.js";
import { AgentToolRuntimeService } from "./agentToolRuntimeService.js";
import { getExecutionGovernor } from "./executionGovernorComposition.js";
import { resolveAgentGenerationInput } from "./agentTemplateContextService.js";
import { searchAgentCapabilities } from "./agentToolSelectionService.js";
import { assertTemplateMembership } from "../domain/templates/templateAccessPolicy.js";
import { UserTemplateAgentService } from "./userTemplateAgentService.js";
import { hasPermission, PERMISSIONS } from "./accessControlService.js";
import {
  executeAdministratorOperation,
  normalizeAdministratorIdempotencyKey,
  normalizeAdministratorReason,
} from "./administratorOperationService.js";
import { writeAuditLog } from "./auditService.js";

let runtime;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });
const dbJson = (db, value) => (typeof db?.json === "function" ? db.json(value) : JSON.stringify(value));

// Business modules with provider/logger dependencies stay lazy so importing
// the Agent routes does not initialize adapters or create log directories.
const defaultWorkflowRuntimeFactory = async () => (
  (await import("./workflowRuntimeComposition.js")).getWorkflowRuntime()
);
const defaultGenerationApplicationFactory = async () => (
  (await import("./generationApplicationService.js")).getGenerationApplication()
);
const defaultObjectStorageFactory = async () => (
  (await import("./objectStorageComposition.js")).getObjectStorage()
);
const defaultMcpRuntimeFactory = async () => (
  (await import("./mcpRuntimeComposition.js")).getMcpToolRuntime()
);
const defaultMcpUserRuntimeFactory = async () => {
  const module = await import("./mcpRuntimeComposition.js");
  return {
    repository: module.getMcpRepository(),
    tools: module.getMcpToolRuntime(),
    oauth: module.getMcpOAuthRuntime(),
  };
};
const defaultDeleteContent = async (input) => (
  (await import("./contentRecycleService.js")).deleteOwnContent(input)
);
const defaultRunUserOperation = async (input) => (
  (await import("./userOperationService.js")).executeUserOperation(input)
);
const defaultCreateOrder = async (input) => (
  (await import("./subscriptionService.js")).createSubscriptionOrder(input)
);
const defaultRefundOrder = async (input) => (
  (await import("./subscriptionService.js")).refundSubscriptionOrder(input)
);
const defaultListPointPackages = async () => (
  (await import("./pointPackageService.js")).listActivePointPackages()
);
const defaultCreatePointPackageOrder = async (input) => (
  (await import("./pointPackageService.js")).createPointPackageOrder(input)
);
const defaultRefundPointPackageOrder = async (input) => (
  (await import("./pointPackageService.js")).refundPointPackageOrder(input)
);
const defaultCancelRenewal = async ({ userId, db }) => (
  (await import("./subscriptionService.js")).cancelSubscriptionRenewal(userId, db)
);
const defaultReleasePoints = async (input) => (
  (await import("./pointsService.js")).releasePoints(input)
);
const defaultReconcileVideoCreation = async (creation) => {
  const videoStatus = await import("./videoStatusService.js");
  if (!videoStatus.needsVideoReconciliation(creation)) return null;
  return videoStatus.syncVideoCreationStatus(creation);
};
const defaultCommunityServiceFactory = async () => import("./communityService.js");
const defaultTaskCenterFactory = async () => {
  const [{ createTaskCenterService }, { createPostgresJobQueue }, { getWorkflowRuntime }, { getAgentPlanExecution }] = await Promise.all([
    import("./taskCenterService.js"),
    import("./postgresJobQueue.js"),
    import("./workflowRuntimeComposition.js"),
    import("./agentPlanExecutionComposition.js"),
  ]);
  return createTaskCenterService({
    sqlClient: sql,
    jobQueue: createPostgresJobQueue({ sqlClient: sql }),
    workflowRuntime: getWorkflowRuntime(),
    agentPlanExecution: getAgentPlanExecution(),
  });
};

const defaultAdministratorRuntimeFactory = async () => {
  const [
    access,
    templates,
    plans,
    recycle,
    mcp,
    mcpCatalog,
    visual,
    models,
    executionPolicies,
    audit,
    privateContent,
    community,
    skills,
    pointPackages,
  ] = await Promise.all([
    import("./accessControlService.js"),
    import("./administratorTemplateService.js"),
    import("./subscriptionPlanConfigurationService.js"),
    import("./contentRecycleService.js"),
    import("./mcpRuntimeComposition.js"),
    import("./mcpConfigurationService.js"),
    import("./visualParameterService.js"),
    import("./modelConfigurationService.js"),
    import("./executionGovernorConfigurationService.js"),
    import("./auditService.js"),
    import("./privateContentReviewService.js"),
    import("./communityService.js"),
    import("./agentSkillDatabaseService.js"),
    import("./pointPackageConfigurationService.js"),
  ]);
  return {
    access,
    templates,
    plans,
    recycle,
    mcp,
    mcpCatalog,
    visual,
    models,
    executionPolicies,
    audit,
    privateContent,
    community,
    skills,
    pointPackages,
  };
};

const identifier = (value, message, code) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255) throw fail(message, code);
  return normalized;
};

const recordId = (value, message, code) => {
  const normalized = identifier(value, message, code);
  if (!/^[1-9]\d{0,18}$/.test(normalized) || BigInt(normalized) > 9223372036854775807n) {
    throw fail(message, code);
  }
  return normalized;
};

const canvasIdFrom = (parameters) => identifier(
  parameters?.canvasId || parameters?.canvas_id,
  "canvasId is required",
  "CANVAS_ID_REQUIRED",
);

const idempotencyKeyFrom = ({ parameters, context }) => (
  context?.idempotencyKey
  || parameters?.idempotencyKey
  || parameters?.idempotency_key
  || null
);

const mapCanvasRow = (row) => ({
  id: row.id,
  title: row.title,
  state: row.canvas_state || {},
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const expectedUpdatedAtFrom = (parameters) => {
  const value = String(parameters?.expectedUpdatedAt || parameters?.expected_updated_at || "").trim();
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) {
    throw fail("expectedUpdatedAt must be the valid updatedAt returned by canvas.read", "CANVAS_EXPECTED_UPDATED_AT_REQUIRED");
  }
  return { value, timestamp };
};

const assertCanvasVersion = (row, expected) => {
  const actualTimestamp = new Date(row?.updated_at).getTime();
  if (Number.isFinite(actualTimestamp) && actualTimestamp === expected.timestamp) return;
  const error = fail("Canvas changed after it was read; read it again before editing", "CANVAS_VERSION_CONFLICT", 409);
  error.expectedUpdatedAt = expected.value;
  error.currentUpdatedAt = row?.updated_at || null;
  throw error;
};

const serializeCanvasState = (state) => {
  const normalized = normalizeCanvasState(state);
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 1_500_000) throw fail("Canvas state is too large", "CANVAS_STATE_TOO_LARGE", 413);
  return { normalized, serialized };
};

const mutateCanvas = async ({ sqlClient, userId, parameters, mutate }) => {
  const canvasId = canvasIdFrom(parameters);
  const expected = expectedUpdatedAtFrom(parameters);
  return sqlClient.begin(async (tx) => {
    const [existing] = await tx`
      SELECT id, title, canvas_state, created_at, updated_at
      FROM canvases
      WHERE id = ${canvasId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!existing) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
    assertCanvasVersion(existing, expected);
    const currentState = normalizeCanvasState(existing.canvas_state || {});
    const candidate = await mutate({ tx, existing, currentState });
    const { normalized } = serializeCanvasState(candidate);
    const title = parameters?.title == null
      ? existing.title
      : (String(parameters.title).trim().slice(0, 120) || existing.title || "Untitled Canvas");
    const [updated] = await tx`
      UPDATE canvases
      SET title = ${title}, canvas_state = ${dbJson(tx, normalized)}, updated_at = NOW()
      WHERE id = ${canvasId} AND user_id = ${userId}
      RETURNING id, title, canvas_state, created_at, updated_at
    `;
    if (!updated) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
    return { row: updated, state: normalized };
  });
};

const clampLimit = (value, fallback = 20, maximum = 50) => Math.min(maximum, Math.max(1, Number(value) || fallback));

const createCanvasListHandler = (sqlClient) => async ({ userId, parameters }) => ({
  canvases: await sqlClient`
    SELECT id, title, created_at, updated_at
    FROM canvases
    WHERE user_id = ${userId}
    ORDER BY updated_at DESC, id DESC
    LIMIT ${clampLimit(parameters?.limit)}
  `,
});

const createCanvasCreateHandler = (sqlClient) => async ({ userId, parameters }) => {
  const title = String(parameters?.title || "Untitled Canvas").trim().slice(0, 120) || "Untitled Canvas";
  const { normalized } = serializeCanvasState(parameters?.state || {});
  const canvasId = `canvas_${randomUUID().replaceAll("-", "")}`;
  const [row] = await sqlClient`
    INSERT INTO canvases (id, user_id, title, canvas_state)
    VALUES (${canvasId}, ${userId}, ${title}, ${dbJson(sqlClient, normalized)})
    RETURNING id, title, canvas_state, created_at, updated_at
  `;
  return mapCanvasRow(row);
};

const mapTemplateRow = (row) => ({
  id: String(row.id),
  sceneKey: row.scene_key,
  sceneName: row.scene_name,
  outputType: row.output_type,
  targetProvider: row.target_provider,
  defaultModel: row.default_model,
  defaultSeconds: row.default_seconds == null ? null : Number(row.default_seconds),
  defaultSize: row.default_size,
  systemPrompt: row.system_prompt,
  starterPrompt: row.starter_prompt,
  placeholderText: row.placeholder_text,
  requiresReference: Boolean(row.requires_reference),
  tags: Array.isArray(row.tags) ? row.tags : [],
  visibility: row.visibility,
  approvalStatus: row.approval_status,
  requiredMembershipTier: row.required_membership_tier || "free",
  ownerUserId: row.owner_user_id || null,
  version: Number(row.version || 1),
});

const createCanvasReadHandler = (sqlClient) => async ({ userId, parameters }) => {
  const canvasId = canvasIdFrom(parameters);
  const [row] = await sqlClient`
    SELECT id, title, canvas_state, created_at, updated_at
    FROM canvases
    WHERE id = ${canvasId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!row) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  return mapCanvasRow(row);
};

const createCanvasEditHandler = (sqlClient) => async ({ userId, parameters }) => {
  const stateInput = parameters?.state ?? parameters?.canvasState ?? parameters?.canvas_state;
  if (stateInput == null) throw fail("canvas state is required", "CANVAS_STATE_REQUIRED");
  const { row } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async () => stateInput,
  });
  return mapCanvasRow(row);
};

const createCanvasPatchHandler = (sqlClient) => async ({ userId, parameters }) => {
  const patch = parameters?.patch && typeof parameters.patch === "object" && !Array.isArray(parameters.patch)
    ? parameters.patch
    : {};
  const appendElements = Array.isArray(parameters?.appendElements) ? parameters.appendElements : [];
  const updateElements = Array.isArray(parameters?.updateElements) ? parameters.updateElements : [];
  const removeElementIds = new Set((parameters?.removeElementIds || []).map((id) => String(id)));
  if (Object.keys(patch).length === 0 && appendElements.length === 0 && updateElements.length === 0 && removeElementIds.size === 0 && parameters?.title == null) {
    throw fail("canvas.patch requires at least one change", "CANVAS_PATCH_EMPTY");
  }
  const { row } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async ({ currentState }) => {
      const nextState = { ...currentState, ...patch };
      let elements = Array.isArray(nextState.elements) ? nextState.elements : currentState.elements;
      if (removeElementIds.size > 0) elements = elements.filter((element) => !removeElementIds.has(String(element?.id)));
      if (updateElements.length > 0) {
        const byId = new Map(updateElements.map((element) => [String(element?.id || ""), element]));
        const existingIds = new Set(elements.map((element) => String(element?.id || "")));
        const missing = [...byId.keys()].find((id) => !id || !existingIds.has(id));
        if (missing !== undefined) throw fail("canvas.patch references an unknown element", "CANVAS_ELEMENT_NOT_FOUND", 404);
        elements = elements.map((element) => byId.has(String(element.id)) ? { ...element, ...byId.get(String(element.id)), id: element.id } : element);
      }
      if (appendElements.length > 0) {
        const existingIds = new Set(elements.map((element) => String(element?.id || "")));
        const duplicate = appendElements.find((element) => element?.id && existingIds.has(String(element.id)));
        if (duplicate) throw fail("canvas.patch cannot append a duplicate element id", "CANVAS_ELEMENT_ALREADY_EXISTS", 409);
        elements = [...elements, ...appendElements];
      }
      return { ...nextState, elements };
    },
  });
  return mapCanvasRow(row);
};

const createCanvasAttachCreationHandler = (sqlClient) => async ({ userId, parameters }) => {
  const creationId = identifier(parameters?.creationId || parameters?.creation_id, "creationId is required", "CREATION_ID_REQUIRED");
  const [creation] = await sqlClient`
    SELECT id, type, status, content, thumbnail_url, scene_name, prompt
    FROM creations
    WHERE id::text = ${creationId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!creation) throw fail("Creation not found", "CREATION_NOT_FOUND", 404);
  if (creation.status !== "completed" || !creation.content || !["image", "video"].includes(creation.type)) {
    throw fail("Only completed image or video creations can be attached", "CREATION_NOT_ATTACHABLE", 409);
  }
  const width = Number(parameters?.width) || (creation.type === "video" ? 380 : 320);
  const height = Number(parameters?.height) || (creation.type === "video" ? 214 : 320);
  const element = {
    id: `${creation.type}_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    type: creation.type,
    x: Number(parameters?.x) || 0,
    y: Number(parameters?.y) || 0,
    width,
    height,
    title: String(parameters?.title || creation.scene_name || (creation.type === "video" ? "AI Video" : "AI Image")).slice(0, 120),
    creationId: String(creation.id),
    src: creation.content,
    poster: creation.type === "video" ? (creation.thumbnail_url || "") : "",
    source: "agent.creation",
    prompt: creation.prompt || "",
  };
  const { row } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async ({ currentState }) => ({ ...currentState, elements: [...currentState.elements, element] }),
  });
  return { ...mapCanvasRow(row), attachedElement: element };
};

const createCanvasBrowserActionHandler = (sqlClient, actionType) => async ({ userId, parameters }) => {
  const canvasId = canvasIdFrom(parameters);
  const [canvas] = await sqlClient`
    SELECT id, title, canvas_state, updated_at
    FROM canvases
    WHERE id = ${canvasId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!canvas) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  const state = normalizeCanvasState(canvas.canvas_state || {});
  if (actionType === "timeline.render") {
    const hasClips = (state.timeline?.tracks || []).some((track) => Array.isArray(track?.clips) && track.clips.length > 0);
    if (!hasClips) throw fail("Timeline has no clips to render", "TIMELINE_EMPTY", 409);
  } else if (state.elements.length === 0) {
    throw fail("Canvas has no content to export", "CANVAS_EXPORT_EMPTY", 409);
  }
  return {
    clientAction: {
      type: actionType,
      canvasId: String(canvas.id),
      canvasTitle: canvas.title || "canvas",
      canvasUpdatedAt: canvas.updated_at,
      targetPath: "/ai/canvas",
    },
  };
};

const createCanvasAssetUploadActionHandler = (sqlClient) => async ({ userId, parameters }) => {
  const canvasId = canvasIdFrom(parameters);
  const [canvas] = await sqlClient`
    SELECT id, title FROM canvases
    WHERE id = ${canvasId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!canvas) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  const mediaType = String(parameters?.mediaType || parameters?.media_type || "").trim().toLowerCase();
  if (mediaType && !new Set(["image", "video", "audio"]).has(mediaType)) {
    throw fail("mediaType must be image, video, or audio", "INVALID_CANVAS_ASSET_TYPE");
  }
  return {
    clientAction: {
      type: "canvas.asset.upload",
      canvasId: String(canvas.id),
      canvasTitle: canvas.title || "canvas",
      mediaType: mediaType || null,
      accept: mediaType ? `${mediaType}/*` : "image/*,video/*,audio/*",
    },
  };
};

const createStoryboardEditHandler = (sqlClient) => async ({ userId, parameters }) => {
  const storyboard = parameters?.storyboard
    ?? parameters?.storyboardState
    ?? parameters?.storyboard_state
    ?? (Array.isArray(parameters?.shots) ? { shots: parameters.shots } : null);
  if (!storyboard || typeof storyboard !== "object" || Array.isArray(storyboard)) {
    throw fail("storyboard is required", "STORYBOARD_REQUIRED");
  }

  const { row, state } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async ({ currentState }) => ({ ...currentState, storyboard }),
  });
  return { ...mapCanvasRow(row), storyboard: state.storyboard };
};

const createStoryboardPatchHandler = (sqlClient) => async ({ userId, parameters }) => {
  const patch = parameters?.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw fail("storyboard patch is required", "STORYBOARD_PATCH_REQUIRED");
  const { row, state } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async ({ currentState }) => ({
      ...currentState,
      storyboard: { ...(currentState.storyboard || {}), ...patch },
    }),
  });
  return { ...mapCanvasRow(row), storyboard: state.storyboard };
};

const createCanvasSectionEditHandler = (sqlClient, section, parameterNames) => async ({ userId, parameters }) => {
  const value = parameterNames.map((name) => parameters?.[name]).find((candidate) => candidate != null);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(`${section} is required`, `${section.toUpperCase()}_REQUIRED`);
  const { row, state } = await mutateCanvas({
    sqlClient, userId, parameters,
    mutate: async ({ currentState }) => ({ ...currentState, [section]: value }),
  });
  return { ...mapCanvasRow(row), [section]: state[section] };
};

const workflowDefinitionFrom = (parameters) => {
  const candidate = parameters?.definition
    ?? parameters?.workflow
    ?? (Array.isArray(parameters?.nodes) ? {
      version: parameters?.version || 1,
      nodes: parameters.nodes,
      edges: parameters?.edges || [],
    } : null);
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? canonicalizeAgentWorkflowDefinition(candidate)
    : null;
};

const readOwnedCanvasWorkflow = async ({ sqlClient, userId, canvasId }) => {
  const targetId = identifier(canvasId, "canvasId is required", "CANVAS_ID_REQUIRED");
  const [row] = await sqlClient`
    SELECT id, title, canvas_state, created_at, updated_at
    FROM canvases
    WHERE id = ${targetId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!row) throw fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  const state = normalizeCanvasState(row.canvas_state || {});
  return { row, state, workflow: canonicalizeAgentWorkflowDefinition(state.workflow) };
};

const createWorkflowCatalogHandler = () => async () => ({
  version: 1,
  nodeTypes: listWorkflowAgentNodeTypes(),
  patchOperations: ["add_node", "update_node", "remove_node", "connect", "disconnect", "set_variables", "rename", "clear"],
  references: {
    previous: "{{previous.result.prompt}}",
    node: "{{nodes.<nodeId>.result.creationId}}",
  },
});

const createAgentCapabilitySearchHandler = () => async ({ userRole, parameters }) => {
  const query = String(parameters?.query || "").trim();
  const tools = searchAgentCapabilities({
    tools: AGENT_RUNTIME_TOOLS,
    query,
    userRole,
    limit: parameters?.limit,
  });
  return { query, count: tools.length, tools };
};

const createWorkflowReadHandler = (sqlClient, workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const loaded = await readOwnedCanvasWorkflow({
    sqlClient,
    userId,
    canvasId: parameters?.canvasId || parameters?.canvas_id,
  });
  let validation = null;
  if (loaded.workflow.nodes.length > 0) {
    validation = await (await workflowRuntimeFactory()).estimate({ userId, definition: loaded.workflow });
  }
  return {
    canvasId: String(loaded.row.id),
    canvasTitle: loaded.row.title,
    updatedAt: loaded.row.updated_at,
    workflow: loaded.workflow,
    definition: validation?.definition || null,
    estimate: validation?.estimate || null,
  };
};

const createWorkflowSaveHandler = (sqlClient, workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const requested = workflowDefinitionFrom(parameters);
  if (!requested) throw fail("definition or workflow is required", "WORKFLOW_DEFINITION_REQUIRED");
  const workflowRuntime = await workflowRuntimeFactory();
  const validation = requested.nodes.length > 0
    ? await workflowRuntime.estimate({ userId, definition: requested })
    : {
        definition: { version: requested.version || 1, nodes: [] },
        estimate: { totalPoints: 0, knownNodePoints: 0, paths: [], roots: [] },
      };
  const { row, state } = await mutateCanvas({
    sqlClient,
    userId,
    parameters,
    mutate: async ({ currentState }) => ({ ...currentState, workflow: requested }),
  });
  return {
    ...mapCanvasRow(row),
    workflow: state.workflow,
    definition: validation.definition,
    estimate: validation.estimate,
  };
};

const createWorkflowPatchHandler = (sqlClient, workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const operations = Array.isArray(parameters?.operations) ? parameters.operations : [];
  if (operations.length === 0) throw fail("operations must contain at least one workflow change", "WORKFLOW_PATCH_EMPTY");
  const workflowRuntime = await workflowRuntimeFactory();
  let validation = null;
  const { row, state } = await mutateCanvas({
    sqlClient,
    userId,
    parameters,
    mutate: async ({ currentState }) => {
      const workflow = applyAgentWorkflowOperations(currentState.workflow, operations);
      validation = workflow.nodes.length > 0
        ? await workflowRuntime.estimate({ userId, definition: workflow })
        : { definition: { version: workflow.version || 1, nodes: [] }, estimate: { totalPoints: 0, knownNodePoints: 0, paths: [], roots: [] } };
      return { ...currentState, workflow };
    },
  });
  return {
    ...mapCanvasRow(row),
    workflow: state.workflow,
    definition: validation?.definition || null,
    estimate: validation?.estimate || null,
  };
};

const createWorkflowRunHandler = (sqlClient, workflowRuntimeFactory) => async ({
  userId,
  userRole,
  agentMode,
  parameters,
  context,
  approvalId,
}) => {
  const workflowRuntime = await workflowRuntimeFactory();
  let definition = workflowDefinitionFrom(parameters);
  let canvasTitle = null;
  const canvasId = parameters?.canvasId || parameters?.canvas_id || null;
  if (!definition && canvasId) {
    const loaded = await readOwnedCanvasWorkflow({ sqlClient, userId, canvasId });
    definition = loaded.workflow;
    canvasTitle = loaded.row.title;
  }
  if (!definition || definition.nodes.length === 0) {
    throw fail("A non-empty definition or a canvas with a saved workflow is required", "WORKFLOW_DEFINITION_REQUIRED");
  }
  return workflowRuntime.start({
    userId,
    canvasId,
    title: parameters?.title || (canvasTitle ? `${canvasTitle} workflow` : undefined),
    definition,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    executionContext: {
      source: "agent",
      agentMode,
      userRole,
      approvalId: approvalId || null,
    },
  });
};

const createWorkflowGetHandler = (workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const runId = identifier(parameters?.runId || parameters?.run_id, "runId is required", "WORKFLOW_RUN_ID_REQUIRED");
  return (await workflowRuntimeFactory()).getRun({ userId, runId });
};

const createWorkflowEstimateHandler = (sqlClient, workflowRuntimeFactory) => async ({ userId, parameters }) => {
  let definition = workflowDefinitionFrom(parameters);
  if (!definition && (parameters?.canvasId || parameters?.canvas_id)) {
    definition = (await readOwnedCanvasWorkflow({
      sqlClient,
      userId,
      canvasId: parameters?.canvasId || parameters?.canvas_id,
    })).workflow;
  }
  if (!definition || definition.nodes.length === 0) {
    throw fail("A non-empty definition or canvasId is required", "WORKFLOW_DEFINITION_REQUIRED");
  }
  return (await workflowRuntimeFactory()).estimate({ userId, definition });
};

const createWorkflowEventsHandler = (workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const runId = identifier(parameters?.runId || parameters?.run_id, "runId is required", "WORKFLOW_RUN_ID_REQUIRED");
  return (await workflowRuntimeFactory()).events({
    userId,
    runId,
    afterId: parameters?.afterId || parameters?.after_id || 0,
    limit: parameters?.limit || 100,
  });
};

const createWorkflowCancelHandler = (workflowRuntimeFactory) => async ({ userId, parameters }) => {
  const runId = identifier(parameters?.runId || parameters?.run_id, "runId is required", "WORKFLOW_RUN_ID_REQUIRED");
  return (await workflowRuntimeFactory()).cancel({
    userId,
    runId,
    reason: String(parameters?.reason || "Cancelled by Agent").slice(0, 500),
  });
};

const createMediaEstimateHandler = (sqlClient) => async ({ userId, membershipTier, parameters }) => {
  const outputType = String(parameters?.outputType || parameters?.output_type || "").trim().toLowerCase();
  if (!new Set(["image", "video"]).has(outputType)) {
    throw fail("outputType must be image or video", "INVALID_OUTPUT_TYPE");
  }
  const resolved = await resolveAgentGenerationInput({ userId, membershipTier, parameters, outputType, db: sqlClient });
  const [media, modelRouting, points, policy, mediaPort] = await Promise.all([
    import("./mediaGenerationComposition.js"),
    import("./modelConfigurationService.js"),
    import("./pointsService.js"),
    import("../domain/generation/generationPolicy.js"),
    import("../ports/mediaGenerationPort.js"),
  ]);
  const normalized = outputType === "video"
    ? media.getVideoGenerationProvider().normalizeRequest({
        provider: resolved.template.target_provider,
        model: resolved.model,
        size: resolved.size,
      })
    : media.getImageGenerationProvider().normalizeRequest({
        model: resolved.model || "nano-banana-2",
        size: resolved.size || null,
      });
  const route = policy.requireExpectedModelProvider(
    await modelRouting.resolveActiveModelRoute({
      modelKey: normalized.model,
      outputType,
      userId,
      db: sqlClient,
    }),
    normalized.routeProviderKeys,
  );
  const seconds = outputType === "video"
    ? policy.normalizeVideoDuration({
        requestedSeconds: resolved.seconds,
        defaultSeconds: resolved.template.default_seconds,
        isHeyGen: normalized.kind === mediaPort.VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN,
      })
    : null;
  const estimatedPoints = await points.resolveCharge({
    outputType,
    provider: resolved.template.target_provider,
    sceneKey: resolved.sceneKey,
    model: normalized.model,
    seconds,
    size: normalized.size,
  });
  return {
    sceneKey: resolved.sceneKey,
    outputType,
    estimatedPoints,
    currencyUnit: "points",
    ruleSnapshot: {
      provider: resolved.template.target_provider,
      model: normalized.model,
      routeId: route.id,
      seconds,
      size: normalized.size,
    },
  };
};

const objectKeyFromProxyUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let pathname = raw;
  try {
    pathname = new URL(raw, "https://resource-access.invalid").pathname;
  } catch {
    pathname = raw.split("?", 1)[0];
  }
  const prefixes = ["/oss-proxy/", "/api/proxy/oss/"];
  const prefix = prefixes.find((candidate) => pathname.startsWith(candidate));
  if (!prefix) return "";
  try {
    const key = decodeURIComponent(pathname.slice(prefix.length));
    if (!key || key.startsWith("/") || key.includes("\\") || /(^|\/)\.\.?($|\/)/.test(key)) return "";
    return key;
  } catch {
    return "";
  }
};

const resolveAgentReferenceImages = async ({ sqlClient, objectStorageFactory, userId, parameters }) => {
  const rawUploads = parameters?.referenceImages ?? parameters?.reference_images ?? [];
  if (!Array.isArray(rawUploads)) throw fail("referenceImages must be an array", "INVALID_AGENT_REFERENCE_IMAGES");
  if (rawUploads.length > 0) {
    throw fail("Agent tool calls must reference owned creation IDs instead of carrying image bytes", "AGENT_REFERENCE_IMAGES_UNSUPPORTED", 422);
  }
  const ids = parameters?.referenceCreationIds ?? parameters?.reference_creation_ids ?? [];
  const templateIds = parameters?.referenceTemplateIds ?? parameters?.reference_template_ids ?? [];
  const uploadIds = parameters?.referenceUploadIds ?? parameters?.reference_upload_ids ?? [];
  if (!Array.isArray(ids) || ids.length > 4) throw fail("referenceCreationIds must contain at most four creation IDs", "INVALID_AGENT_REFERENCE_IMAGES");
  if (!Array.isArray(templateIds) || templateIds.length > 4) throw fail("referenceTemplateIds must contain at most four template IDs", "INVALID_AGENT_REFERENCE_IMAGES");
  if (!Array.isArray(uploadIds) || uploadIds.length > 4) throw fail("referenceUploadIds must contain at most four upload IDs", "INVALID_AGENT_REFERENCE_IMAGES");
  if (ids.length + templateIds.length + uploadIds.length > 4) {
    throw fail("At most four reference images may be used in one generation", "INVALID_AGENT_REFERENCE_IMAGES");
  }
  if (ids.length === 0 && templateIds.length === 0 && uploadIds.length === 0) return [];
  const storage = await objectStorageFactory();
  const images = [];
  for (const rawId of ids) {
    const creationId = identifier(rawId, "reference creation id is required", "REFERENCE_CREATION_ID_REQUIRED");
    const [creation] = await sqlClient`
      SELECT id, content_object_key
      FROM creations
      WHERE id::text = ${creationId}
        AND type = 'image' AND status = 'completed' AND content_object_key IS NOT NULL
        AND (user_id = ${userId} OR (community_status = 'public' AND community_hidden = FALSE))
      LIMIT 1
    `;
    if (!creation) throw fail("Reference image creation is unavailable or not public", "AGENT_REFERENCE_CREATION_UNAVAILABLE", 404);
    const downloaded = await storage.downloadBuffer(creation.content_object_key);
    images.push({ buffer: downloaded.buffer, mimetype: downloaded.contentType || "image/jpeg" });
  }
  for (const rawId of templateIds) {
    const templateId = identifier(rawId, "reference template id is required", "REFERENCE_TEMPLATE_ID_REQUIRED");
    const [template] = await sqlClient`
      SELECT id, preview_object_key, preview_image_url
      FROM prompt_templates
      WHERE id::text = ${templateId}
        AND is_active = TRUE AND visibility = 'public' AND approval_status = 'approved'
      LIMIT 1
    `;
    const objectKey = template?.preview_object_key || objectKeyFromProxyUrl(template?.preview_image_url);
    if (!template || !objectKey) throw fail("Reference template preview is unavailable", "AGENT_REFERENCE_TEMPLATE_UNAVAILABLE", 404);
    const downloaded = await storage.downloadBuffer(objectKey);
    images.push({ buffer: downloaded.buffer, mimetype: downloaded.contentType || "image/jpeg" });
  }
  for (const rawId of uploadIds) {
    const uploadId = identifier(rawId, "reference upload id is required", "REFERENCE_UPLOAD_ID_REQUIRED");
    const [upload] = await sqlClient`
      SELECT id, object_key, mime_type
      FROM user_content_uploads
      WHERE id::text = ${uploadId}
        AND user_id = ${userId} AND media_type = 'image' AND object_key IS NOT NULL
      LIMIT 1
    `;
    if (!upload) throw fail("Reference upload is unavailable or does not belong to the current user", "AGENT_REFERENCE_UPLOAD_UNAVAILABLE", 404);
    const downloaded = await storage.downloadBuffer(upload.object_key);
    images.push({ buffer: downloaded.buffer, mimetype: downloaded.contentType || upload.mime_type || "image/jpeg" });
  }
  return images;
};

const createImageGenerationHandler = (generationApplicationFactory, objectStorageFactory, sqlClient) => async ({ userId, membershipTier, parameters, context }) => {
  const referenceImages = await resolveAgentReferenceImages({ sqlClient, objectStorageFactory, userId, parameters });
  const resolved = await resolveAgentGenerationInput({ userId, membershipTier, parameters, outputType: "image", db: sqlClient });
  const generationApplication = await generationApplicationFactory();
  return generationApplication.generateImage({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    sceneKey: resolved.sceneKey,
    userPrompt: resolved.userPrompt,
    model: resolved.model,
    size: resolved.size,
    visualParameters: parameters?.visualParameters ?? parameters?.visual_parameters,
    referenceImages,
  });
};

const createVideoGenerationHandler = (generationApplicationFactory, objectStorageFactory, sqlClient) => async ({ userId, membershipTier, parameters, context }) => {
  const referenceImages = await resolveAgentReferenceImages({ sqlClient, objectStorageFactory, userId, parameters });
  const resolved = await resolveAgentGenerationInput({ userId, membershipTier, parameters, outputType: "video", db: sqlClient });
  const generationApplication = await generationApplicationFactory();
  return generationApplication.generateVideo({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    sceneKey: resolved.sceneKey,
    userPrompt: resolved.userPrompt,
    model: resolved.model,
    seconds: resolved.seconds,
    size: resolved.size,
    visualParameters: parameters?.visualParameters ?? parameters?.visual_parameters,
    referenceImages,
    roleId: parameters?.roleId || parameters?.role_id,
    requireDigitalHuman: parameters?.requireDigitalHuman === true || parameters?.require_digital_human === true,
    allowOfflineRender: parameters?.allowOfflineRender === true || parameters?.allow_offline_render === true,
  });
};

const createImageRemovalHandler = (imageHandler, kind) => async (input) => {
  const parameters = input.parameters || {};
  const creationId = identifier(parameters?.creationId || parameters?.creation_id, "creationId is required", "CREATION_ID_REQUIRED");
  const userModification = kind === "background"
    ? parameters?.replacementBackground
      ? `Remove the existing background completely and replace it with: ${String(parameters.replacementBackground).slice(0, 500)}. Preserve the subject exactly.`
      : "Remove the entire background and return a clean transparent-background image. Preserve the subject, edges, colors, pose, and details exactly."
    : `Remove only this object from the image: ${String(parameters.objectDescription || "").slice(0, 500)}. Reconstruct the occluded background naturally and preserve everything else.`;
  return imageHandler({
    ...input,
    parameters: {
      sceneKey: parameters?.sceneKey || parameters?.scene_key || "freeform_image",
      userModification,
      model: parameters?.model,
      size: parameters?.size,
      referenceCreationIds: [creationId],
    },
  });
};

const createTemplateUseHandler = (sqlClient) => async ({ userId, membershipTier = "free", parameters }) => {
  const templateId = String(parameters?.templateId || parameters?.template_id || parameters?.id || "").trim();
  const sceneKey = String(parameters?.sceneKey || parameters?.scene_key || "").trim();
  if (!templateId && !sceneKey) {
    throw fail("templateId or sceneKey is required", "TEMPLATE_IDENTIFIER_REQUIRED");
  }
  const rows = templateId
    ? await sqlClient`
        SELECT id, scene_key, scene_name, output_type, target_provider, default_model,
               default_seconds, default_size, system_prompt, starter_prompt,
               placeholder_text, requires_reference, tags, visibility, approval_status,
               required_membership_tier, owner_user_id, version
        FROM prompt_templates
        WHERE id::text = ${templateId} AND is_active = TRUE
          AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
        LIMIT 1
      `
    : await sqlClient`
        SELECT id, scene_key, scene_name, output_type, target_provider, default_model,
               default_seconds, default_size, system_prompt, starter_prompt,
               placeholder_text, requires_reference, tags, visibility, approval_status,
               required_membership_tier, owner_user_id, version
        FROM prompt_templates
        WHERE scene_key = ${sceneKey} AND is_active = TRUE
          AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
        LIMIT 1
      `;
  if (!rows[0]) throw fail("Template not found", "TEMPLATE_NOT_FOUND", 404);
  assertTemplateMembership({ template: rows[0], userId, membershipTier });
  return mapTemplateRow(rows[0]);
};

const createTemplateSearchHandler = (sqlClient) => async ({ userId, membershipTier, parameters }) => {
  const { resolveTrustedGlobalAgentContext } = await import("./agentTemplateContextService.js");
  const outputType = String(parameters?.outputType || parameters?.output_type || "").trim().toLowerCase();
  const context = await resolveTrustedGlobalAgentContext({
    userId,
    membershipTier,
    instruction: parameters?.query || parameters?.search || "",
    clientContext: {},
    db: sqlClient,
  });
  const rows = outputType === "image"
    ? context.templates.availableImages
    : outputType === "video"
      ? context.templates.availableVideos
      : [...context.templates.availableImages, ...context.templates.availableVideos];
  return { templates: rows.slice(0, clampLimit(parameters?.limit, 20, 48)) };
};

const createUserTemplateHandler = (service, action) => async ({ userId, parameters, context }) => {
  const idempotencyKey = idempotencyKeyFrom({ parameters, context });
  if (action === "create") return service.create({ userId, input: parameters, idempotencyKey });
  if (action === "update") return service.update({ userId, templateId: parameters?.templateId, patch: parameters?.patch, idempotencyKey });
  if (action === "import") return service.import({ userId, document: parameters?.document, idempotencyKey });
  if (action === "export") return service.export({ userId, templateId: parameters?.templateId });
  if (action === "delete") return service.remove({ userId, templateId: parameters?.templateId, idempotencyKey });
  throw fail("Unsupported private template action", "PRIVATE_TEMPLATE_ACTION_UNSUPPORTED", 500);
};

const createCreationHistoryHandler = (sqlClient) => async ({ userId, parameters }) => {
  const page = Math.min(10_000, Math.max(1, Number(parameters?.page) || 1));
  const pageSize = Math.min(50, Math.max(1, Number(
    parameters?.pageSize || parameters?.page_size || parameters?.limit,
  ) || 20));
  const type = String(parameters?.type || "").trim().toLowerCase() || null;
  const status = String(parameters?.status || "").trim().toLowerCase() || null;
  const query = String(parameters?.query || "").trim().slice(0, 100) || null;
  const offset = (page - 1) * pageSize;
  const [[countRow], items] = await Promise.all([
    sqlClient`
      SELECT COUNT(*)::int AS count
      FROM creations
      WHERE user_id = ${userId}
        AND (${type}::text IS NULL OR type = ${type})
        AND (${status}::text IS NULL OR status = ${status})
        AND (${query}::text IS NULL OR POSITION(
          LOWER(${query}) IN LOWER(CONCAT_WS(' ', scene_name, scene_key, model, prompt))
        ) > 0)
    `,
    sqlClient`
      SELECT id, type, status, provider_status, charge_status, scene_key, scene_name,
             provider, model, content, thumbnail_url, task_id, points_cost,
             points_reserved, prompt, error_message, community_status,
             community_title, community_tags, community_prompt_public,
             community_published_at, created_at, updated_at, expires_at
      FROM creations
      WHERE user_id = ${userId}
        AND (${type}::text IS NULL OR type = ${type})
        AND (${status}::text IS NULL OR status = ${status})
        AND (${query}::text IS NULL OR POSITION(
          LOWER(${query}) IN LOWER(CONCAT_WS(' ', scene_name, scene_key, model, prompt))
        ) > 0)
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `,
  ]);
  const total = Number(countRow?.count || 0);
  return { items, page, pageSize, total, hasNextPage: offset + items.length < total };
};

const createCreationGetHandler = (sqlClient, reconcileVideoCreation) => async ({ userId, parameters }) => {
  const creationId = identifier(parameters?.creationId || parameters?.creation_id, "creationId is required", "CREATION_ID_REQUIRED");
  const loadCreation = async () => {
    const [row] = await sqlClient`
      SELECT id, user_id, type, status, provider_status, charge_status, scene_key, scene_name,
           provider, model, content, thumbnail_url, task_id, points_cost,
           points_reserved, prompt, error_message, community_status, meta_info,
           content_object_key, thumbnail_object_key,
           created_at, updated_at, expires_at
      FROM creations
      WHERE id::text = ${creationId} AND user_id = ${userId}
      LIMIT 1
    `;
    return row || null;
  };
  let creation = await loadCreation();
  if (!creation) throw fail("Creation not found", "CREATION_NOT_FOUND", 404);
  const reconciliation = await reconcileVideoCreation(creation);
  if (reconciliation && !reconciliation.success) {
    throw fail(
      reconciliation.message || "Unable to refresh video status",
      "CREATION_STATUS_SYNC_FAILED",
      503,
    );
  }
  if (reconciliation?.creation) creation = await loadCreation() || creation;
  const {
    user_id: _userId,
    meta_info: _metaInfo,
    content_object_key: _contentObjectKey,
    thumbnail_object_key: _thumbnailObjectKey,
    ...safeCreation
  } = creation;
  return safeCreation;
};

const createCreationDownloadHandler = (sqlClient) => async ({ userId, parameters }) => {
  const creationId = recordId(
    parameters?.creationId || parameters?.creation_id,
    "creationId is invalid",
    "INVALID_CREATION_ID",
  );
  const [creation] = await sqlClient`
    SELECT id, type, status, expires_at
    FROM creations
    WHERE id = ${creationId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!creation) throw fail("Creation not found", "CREATION_NOT_FOUND", 404);
  if (creation.status !== "completed") {
    throw fail("Creation is not completed", "CREATION_NOT_COMPLETED", 409);
  }
  if (creation.expires_at && new Date(creation.expires_at).getTime() <= Date.now()) {
    throw fail("Creation has expired", "CREATION_EXPIRED", 410);
  }
  const extension = creation.type === "video" ? "mp4" : "png";
  return {
    clientAction: {
      type: "creation.download",
      creationId: String(creation.id),
      filename: `creation_${creation.id}.${extension}`,
    },
  };
};

const createFailedCreationDeleteHandler = ({
  runUserOperation,
  releasePointsOperation,
  deleteContent,
}) => async ({ userId, parameters, context }) => {
  const creationId = recordId(
    parameters?.creationId || parameters?.creation_id,
    "creationId is invalid",
    "INVALID_CREATION_ID",
  );
  const reason = String(parameters?.reason || "Deleted failed creation through Agent").trim().slice(0, 500);
  return runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: "failed_creation.deleted",
    targetType: "creation",
    targetId: creationId,
    requestPayload: { creation_id: creationId, reason },
    mutate: async (tx) => {
      const [creation] = await tx`
        SELECT id, status, charge_status, points_reserved
        FROM creations
        WHERE id = ${creationId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!creation) throw fail("Creation not found", "CREATION_NOT_FOUND", 404);
      if (creation.status !== "failed") {
        throw fail("Only failed creations can use this tool", "CREATION_NOT_FAILED", 409);
      }

      const reservedPoints = Number(creation.points_reserved || 0);
      if (creation.charge_status === "reserved" && reservedPoints > 0) {
        const release = await releasePointsOperation({
          userId,
          amount: reservedPoints,
          creationId: creation.id,
          idempotencyKey: `release:delete_failed_creation:${creation.id}`,
          note: "Release: delete failed creation",
          tx,
        });
        const releasedAmount = Math.abs(Number(release?.ledger?.held_points_change || 0));
        if (releasedAmount !== reservedPoints) {
          throw fail(
            "Creation point reservation could not be released in full",
            "CREATION_RESERVATION_INCONSISTENT",
            409,
          );
        }
        const [releasedCreation] = await tx`
          UPDATE creations
          SET charge_status = 'released', points_reserved = 0
          WHERE id = ${creation.id} AND user_id = ${userId}
            AND charge_status = 'reserved'
          RETURNING id
        `;
        if (!releasedCreation) {
          throw fail(
            "Creation charge state changed while releasing points",
            "CREATION_CHARGE_STATE_CONFLICT",
            409,
          );
        }
      }

      const deletion = await deleteContent({
        userId,
        resourceType: "creation",
        resourceId: creation.id,
        reason,
        tx,
      });
      return { deletedId: String(creation.id), deletion };
    },
  });
};

const createCreationBatchDownloadHandler = (sqlClient) => async ({ userId, parameters }) => {
  const rawIds = parameters?.creationIds || parameters?.creation_ids;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 20) {
    throw fail("creationIds must contain 1-20 ids", "INVALID_CREATION_IDS");
  }
  const creationIds = [...new Set(rawIds.map((value) => identifier(value, "creationId is required", "CREATION_ID_REQUIRED")))];
  if (creationIds.length !== rawIds.length) throw fail("creationIds must not contain duplicates", "DUPLICATE_CREATION_IDS");
  const rows = await sqlClient`
    SELECT id::text AS id
    FROM creations
    WHERE user_id = ${userId} AND id::text = ANY(${creationIds})
      AND status = 'completed' AND content IS NOT NULL
      AND (expires_at IS NULL OR expires_at > NOW())
  `;
  const available = new Set(rows.map((row) => String(row.id)));
  if (creationIds.some((id) => !available.has(id))) {
    throw fail("One or more creations are unavailable for download", "CREATION_DOWNLOAD_UNAVAILABLE", 404);
  }
  return {
    clientAction: {
      type: "creation.download.batch",
      creationIds,
      filename: "creations.zip",
    },
  };
};

const createCreationCsvExportHandler = () => async () => ({
  clientAction: {
    type: "creation.export.csv",
    filename: "creations.csv",
  },
});

const createModelListHandler = (sqlClient) => async ({ userId, parameters }) => {
  const { listAvailableModels } = await import("./modelConfigurationService.js");
  return {
    models: await listAvailableModels({
      userId,
      outputType: parameters?.outputType || parameters?.output_type || null,
      db: sqlClient,
    }),
  };
};

const createVisualParameterListHandler = (sqlClient) => async () => {
  const { listVisualParameterCatalog } = await import("./visualParameterService.js");
  return listVisualParameterCatalog({ db: sqlClient, allowFallback: true });
};

const createProfileReadHandler = (sqlClient) => async ({ userId, userRole }) => {
  const [profile] = await sqlClient`
    SELECT display_name, avatar_url, account_status, app_role, created_at, updated_at
    FROM user_profiles
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  return {
    displayName: profile?.display_name || null,
    avatarUrl: profile?.avatar_url || null,
    accountStatus: profile?.account_status || "active",
    role: profile?.app_role || userRole || "user",
    createdAt: profile?.created_at || null,
    updatedAt: profile?.updated_at || null,
  };
};

const createProfileUpdateHandler = (sqlClient) => async ({ userId, parameters }) => {
  const displayName = String(parameters?.displayName || parameters?.display_name || "").trim().replace(/\s+/g, " ");
  if (!displayName || displayName.length > 40) throw fail("displayName must be 1-40 characters", "INVALID_DISPLAY_NAME");
  const [profile] = await sqlClient`
    INSERT INTO user_profiles (user_id, display_name)
    VALUES (${userId}, ${displayName})
    ON CONFLICT (user_id) DO UPDATE
    SET display_name = EXCLUDED.display_name, updated_at = NOW()
    RETURNING display_name, avatar_url, updated_at
  `;
  return { displayName: profile.display_name, avatarUrl: profile.avatar_url || null, updatedAt: profile.updated_at };
};

const createProfileAvatarUploadActionHandler = () => async () => ({
  clientAction: {
    type: "profile.avatar.upload",
    accept: "image/*",
  },
});

const createTemplatePreviewUploadActionHandler = (sqlClient) => async ({ userId, parameters }) => {
  const templateId = identifier(parameters?.templateId || parameters?.template_id, "templateId is required", "TEMPLATE_ID_REQUIRED");
  const previewKind = String(parameters?.previewKind || parameters?.preview_kind || "").trim().toLowerCase();
  if (!new Set(["image", "video"]).has(previewKind)) {
    throw fail("previewKind must be image or video", "INVALID_TEMPLATE_PREVIEW_KIND");
  }
  const [template] = await sqlClient`
    SELECT id, scene_name, version
    FROM prompt_templates
    WHERE id::text = ${templateId} AND owner_user_id = ${userId}
    LIMIT 1
  `;
  if (!template) throw fail("Private template not found", "PRIVATE_TEMPLATE_NOT_FOUND", 404);
  return {
    clientAction: {
      type: "template.preview.upload",
      templateId: String(template.id),
      templateName: template.scene_name,
      templateVersion: Number(template.version || 1),
      previewKind,
      accept: `${previewKind}/*`,
    },
  };
};

const createTaskListHandler = (taskCenterFactory) => async ({ userId, parameters }) => (
  (await taskCenterFactory()).listForUser({
    userId,
    page: parameters?.page,
    pageSize: parameters?.pageSize || parameters?.page_size,
    status: parameters?.status,
    type: parameters?.type,
  })
);

const createTaskCancelHandler = (taskCenterFactory) => async ({ userId, parameters, context }) => (
  (await taskCenterFactory()).cancelForUser({
    userId,
    taskId: parameters?.taskId || parameters?.task_id,
    reason: parameters?.reason,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createTaskGetHandler = (taskCenterFactory) => async ({ userId, parameters }) => (
  (await taskCenterFactory()).getForUser({
    userId,
    taskId: parameters?.taskId || parameters?.task_id,
  })
);

const createCommunityListHandler = (communityServiceFactory) => async ({ userId, parameters }) => {
  const service = await communityServiceFactory();
  return service.listPublicCreations({
    userId,
    limit: parameters?.limit,
    type: parameters?.type,
    sort: parameters?.sort,
    query: parameters?.query,
    cursor: parameters?.cursor,
  });
};

const createCommunityGetHandler = (communityServiceFactory) => async ({ userId, parameters }) => {
  const creationId = identifier(parameters?.creationId || parameters?.creation_id, "creationId is required", "CREATION_ID_REQUIRED");
  const creation = await (await communityServiceFactory()).getPublicCreation({ userId, creationId });
  if (!creation) throw fail("Community creation not found", "COMMUNITY_CREATION_NOT_FOUND", 404);
  return creation;
};

const createCommunityPublicationGetHandler = (communityServiceFactory) => async ({ userId, parameters }) => {
  const creationId = recordId(
    parameters?.creationId || parameters?.creation_id,
    "creationId is invalid",
    "INVALID_CREATION_ID",
  );
  return (await communityServiceFactory()).getOwnedCommunityState({ userId, creationId });
};

const createCommunityPublishHandler = (communityServiceFactory) => async ({ userId, parameters, context }) => {
  const service = await communityServiceFactory();
  return service.publishCreation({
    userId,
    creationId: parameters?.creationId || parameters?.creation_id,
    body: {
      title: parameters?.title,
      tags: parameters?.tags,
      prompt_public: parameters?.promptPublic ?? parameters?.prompt_public,
      visual_parameters: parameters?.visualParameters ?? parameters?.visual_parameters,
    },
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  });
};

const createCommunityUnpublishHandler = (communityServiceFactory) => async ({ userId, parameters, context }) => (
  (await communityServiceFactory()).unpublishCreation({
    userId,
    creationId: parameters?.creationId || parameters?.creation_id,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createCommunityRelationHandler = (communityServiceFactory, relation) => async ({ userId, parameters, context }) => {
  const service = await communityServiceFactory();
  const action = relation === "like" ? service.setCreationLike : service.setCreationFavorite;
  return action({
    userId,
    creationId: parameters?.creationId || parameters?.creation_id,
    enabled: parameters?.enabled !== false,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  });
};

const createCommunityReportHandler = (communityServiceFactory) => async ({ userId, parameters, context }) => (
  (await communityServiceFactory()).reportCreation({
    userId,
    creationId: parameters?.creationId || parameters?.creation_id,
    reason: parameters?.reason,
    details: parameters?.details,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createAccountBalanceHandler = (sqlClient) => async ({ userId }) => {
  const [{ checkAndGrantBonus }, { getAccountInfo }] = await Promise.all([
    import("./membershipService.js"),
    import("./pointsService.js"),
  ]);
  await sqlClient`
    INSERT INTO user_point_accounts (user_id, balance_points, held_points)
    VALUES (${userId}, 0, 0)
    ON CONFLICT (user_id) DO NOTHING
  `;
  await checkAndGrantBonus(userId);
  return getAccountInfo(userId);
};

const createAccountLedgerHandler = (sqlClient) => async ({ userId, parameters }) => {
  const page = Math.max(1, Number(parameters?.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(parameters?.pageSize || parameters?.page_size) || 20));
  const entryType = String(parameters?.entryType || parameters?.entry_type || "").trim().slice(0, 80) || null;
  const offset = (page - 1) * pageSize;
  const [[countRow], items] = await Promise.all([
    sqlClient`
      SELECT COUNT(*)::int AS count
      FROM point_ledger
      WHERE user_id = ${userId}
        AND (${entryType}::text IS NULL OR entry_type = ${entryType})
    `,
    sqlClient`
      SELECT id, entry_type, source_type, source_id, change_points,
             held_points_change, balance_after, held_after, note, metadata, created_at
      FROM point_ledger
      WHERE user_id = ${userId}
        AND (${entryType}::text IS NULL OR entry_type = ${entryType})
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset}
    `,
  ]);
  return { items, page, pageSize, total: Number(countRow?.count || 0) };
};

const createRecycleListHandler = () => async ({ userId, parameters }) => (
  (await import("./contentRecycleService.js")).listOwnRecycleBin({
    userId,
    limit: parameters?.limit,
    offset: parameters?.offset,
  })
);

const createRecycleRestoreHandler = () => async ({ userId, parameters, context }) => (
  (await import("./contentRecycleService.js")).restoreOwnContent({
    userId,
    entryId: parameters?.entryId || parameters?.entry_id,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createContentNotificationListHandler = () => async ({ userId, parameters }) => (
  (await import("./contentRecycleService.js")).listOwnContentNotifications({
    userId,
    limit: parameters?.limit,
    offset: parameters?.offset,
  })
);

const createContentNotificationReadHandler = () => async ({ userId, parameters, context }) => (
  (await import("./contentRecycleService.js")).markOwnContentNotificationRead({
    userId,
    notificationId: parameters?.notificationId || parameters?.notification_id,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createContentDeleteHandler = (deleteContent) => async ({ userId, parameters, context }) => (
  deleteContent({
    userId,
    resourceType: parameters?.resourceType || parameters?.resource_type,
    resourceId: parameters?.resourceId || parameters?.resource_id,
    reason: parameters?.reason,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
  })
);

const createContentPublishHandler = (runUserOperation) => async ({ userId, parameters, context }) => {
  const resourceType = String(parameters?.resourceType || parameters?.resource_type || "private_template")
    .trim().toLowerCase().replaceAll("-", "_");
  if (!["template", "private_template", "prompt_template"].includes(resourceType)) {
    throw fail(
      "Only private template publication requests are supported",
      "CONTENT_PUBLISH_UNSUPPORTED",
      422,
    );
  }
  const templateId = identifier(
    parameters?.resourceId || parameters?.resource_id || parameters?.templateId || parameters?.template_id,
    "template resourceId is required",
    "CONTENT_RESOURCE_ID_REQUIRED",
  );
  const result = await runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: "template.publication_requested",
    targetType: "prompt_template",
    targetId: templateId,
    requestPayload: { template_id: templateId },
    mutate: async (tx) => {
      const [updated] = await tx`
        UPDATE prompt_templates
        SET approval_status = 'pending', publication_requested_at = NOW(),
            publication_reviewed_at = NULL, publication_review_note = NULL, updated_at = NOW()
        WHERE id::text = ${templateId}
          AND owner_user_id = ${userId}
          AND visibility = 'private'
          AND is_active = TRUE
        RETURNING id, scene_key, scene_name, output_type, target_provider, default_model,
                  default_seconds, default_size, system_prompt, starter_prompt,
                  placeholder_text, requires_reference, tags, visibility, approval_status,
                  required_membership_tier, owner_user_id, version
      `;
      if (!updated) throw fail("Private template not found", "CONTENT_RESOURCE_NOT_FOUND", 404);
      return mapTemplateRow(updated);
    },
  });
  return { publicationStatus: "pending", template: result };
};

const createMcpCallHandler = (mcpRuntimeFactory) => async ({
  userId,
  userRole,
  agentMode,
  parameters,
  approvalId,
}) => {
  const connectionId = identifier(
    parameters?.connectionId || parameters?.connection_id,
    "connectionId is required",
    "MCP_CONNECTION_ID_REQUIRED",
  );
  const mcpRuntime = await mcpRuntimeFactory();
  return mcpRuntime.callTool({
    userId,
    userRole,
    agentMode,
    connectionId,
    serverKey: parameters?.serverKey || parameters?.server_key || null,
    toolName: parameters?.toolName || parameters?.tool_name,
    arguments: parameters?.arguments || {},
    approvalId,
  });
};

const createMcpServerListHandler = (mcpUserRuntimeFactory) => async () => {
  const { repository } = await mcpUserRuntimeFactory();
  return { servers: await repository.listEnabledServers() };
};

const createMcpConnectionListHandler = (mcpUserRuntimeFactory) => async ({ userId }) => {
  const { repository } = await mcpUserRuntimeFactory();
  return { connections: await repository.listConnections({ userId }) };
};

const createMcpToolListHandler = (mcpUserRuntimeFactory) => async ({ userId, userRole, parameters }) => {
  const connectionId = identifier(parameters?.connectionId || parameters?.connection_id, "connectionId is required", "MCP_CONNECTION_ID_REQUIRED");
  const { tools } = await mcpUserRuntimeFactory();
  return {
    connectionId,
    tools: await tools.listAllowedTools({ userId, userRole, connectionId }),
  };
};

const createMcpConnectionStartHandler = (mcpUserRuntimeFactory) => async ({ userId, parameters }) => {
  const { oauth } = await mcpUserRuntimeFactory();
  const redirectUri = String(process.env.MCP_OAUTH_REDIRECT_URI || "").trim();
  if (!redirectUri) throw fail("MCP OAuth redirect URI is not configured", "MCP_REDIRECT_NOT_CONFIGURED", 503);
  return oauth.beginConnection({
    userId,
    serverKey: parameters?.serverKey || parameters?.server_key,
    requestedScopes: parameters?.scopes,
    redirectUri,
  });
};

const createMcpConnectionRevokeHandler = (mcpUserRuntimeFactory) => async ({ userId, parameters }) => {
  const { oauth } = await mcpUserRuntimeFactory();
  return oauth.revoke({
    userId,
    connectionId: parameters?.connectionId || parameters?.connection_id,
  });
};

const createSubscriptionPlanListHandler = () => async () => {
  const { listActivePlans } = await import("./subscriptionService.js");
  return { plans: await listActivePlans() };
};

const createSubscriptionOverviewHandler = () => async ({ userId }) => {
  const { getSubscriptionOverview } = await import("./subscriptionService.js");
  return getSubscriptionOverview(userId);
};

const createSubscriptionOrderGetHandler = (sqlClient) => async ({ userId, parameters }) => {
  const orderNo = identifier(parameters?.orderNo || parameters?.order_no, "orderNo is required", "ORDER_NO_REQUIRED");
  const [order] = await sqlClient`
    SELECT id, order_no, order_type, plan_key, plan_name, membership_tier,
           billing_interval, amount_cents, included_points, bonus_points,
           monthly_bonus_points, period_start, period_end, status, payment_method,
           created_at, paid_at, refunded_at, updated_at
    FROM subscription_orders
    WHERE order_no = ${orderNo} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!order) throw fail("Subscription order not found", "SUBSCRIPTION_ORDER_NOT_FOUND", 404);
  return order;
};

const createPointPackageListHandler = (listPointPackages) => async () => ({
  packages: await listPointPackages(),
});

const createPointPackageOrderGetHandler = (sqlClient) => async ({ userId, parameters }) => {
  const orderNo = identifier(parameters?.orderNo || parameters?.order_no, "orderNo is required", "ORDER_NO_REQUIRED");
  const [order] = await sqlClient`
    SELECT id, order_no, package_key, package_name, amount_cents, points,
           bonus_points, total_points, status, payment_method, created_at,
           paid_at, confirmed_at, refunded_at, updated_at
    FROM point_orders
    WHERE order_no = ${orderNo} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!order) throw fail("Point package order not found", "POINT_PACKAGE_ORDER_NOT_FOUND", 404);
  return order;
};

const createSubscriptionRenewalCancelHandler = ({ runUserOperation, cancelRenewal }) => async ({
  userId,
  parameters,
  context,
}) => {
  const reason = String(parameters?.reason || "Cancelled through Agent").trim().slice(0, 500);
  return runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: "subscription.renewal_cancelled",
    targetType: "subscription",
    targetId: "current",
    requestPayload: { reason },
    mutate: async (tx) => {
      const subscription = await cancelRenewal({ userId, db: tx });
      if (!subscription) {
        throw fail("Active automatic renewal was not found", "SUBSCRIPTION_RENEWAL_NOT_FOUND", 404);
      }
      return {
        id: subscription.id,
        status: subscription.status,
        membershipTier: subscription.membership_tier,
        billingInterval: subscription.billing_interval,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        autoRenew: Boolean(subscription.auto_renew),
        cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
        cancelledAt: subscription.cancelled_at,
        updatedAt: subscription.updated_at,
      };
    },
  });
};

const createDigitalHumanRoleListHandler = (sqlClient) => async ({ userId }) => ({
  roles: await sqlClient`
    SELECT id, role_name, role_description, prompt_text, status, ready_at,
           created_at, updated_at
    FROM digital_human_roles
    WHERE user_id = ${userId}
    ORDER BY created_at DESC, id DESC
  `,
});

const createDigitalHumanRoleHandler = (runUserOperation) => async ({ userId, parameters, context }) => {
  const roleName = String(parameters?.roleName || parameters?.role_name || "").trim().slice(0, 120);
  if (!roleName) throw fail("roleName is required", "DIGITAL_HUMAN_ROLE_NAME_REQUIRED");
  const roleDescription = String(parameters?.roleDescription || parameters?.role_description || "").trim().slice(0, 1000);
  const promptText = String(parameters?.promptText || parameters?.prompt_text || "").trim().slice(0, 2000);
  const captureToken = `dh_${randomBytes(32).toString("base64url")}`;
  const result = await runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: "digital_human.role.created",
    targetType: "digital_human_role",
    targetId: roleName,
    requestPayload: { roleName, roleDescription, promptText },
    mutate: async (tx) => {
      const [role] = await tx`
        INSERT INTO digital_human_roles
          (user_id, role_name, role_description, prompt_text, status, qr_token,
           qr_token_issued_at, qr_token_expires_at)
        VALUES
          (${userId}, ${roleName}, ${roleDescription || null}, ${promptText || null},
           'collecting', ${captureToken}, NOW(), NOW() + INTERVAL '24 hours')
        RETURNING id, role_name, role_description, prompt_text, status,
                  qr_token_expires_at, created_at, updated_at
      `;
      return { ...role, captureToken };
    },
  });
  const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return {
    id: result.id,
    roleName: result.role_name,
    roleDescription: result.role_description || "",
    promptText: result.prompt_text || "",
    status: result.status,
    captureUrl: `${base}/capture/digital-human/${result.captureToken}`,
    captureExpiresAt: result.qr_token_expires_at,
    createdAt: result.created_at,
  };
};

const digitalHumanCaptureUrl = (token) => {
  const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
  return `${base}/capture/digital-human/${token}`;
};

const createDigitalHumanCaptureLinkGetHandler = (sqlClient) => async ({ userId, parameters }) => {
  const roleId = identifier(parameters?.roleId || parameters?.role_id, "roleId is required", "DIGITAL_HUMAN_ROLE_ID_REQUIRED");
  const [role] = await sqlClient`
    SELECT id, role_name, status, qr_token, qr_token_expires_at,
           (qr_token_expires_at > NOW() AND qr_token_claimed_at IS NULL
             AND qr_token_consumed_at IS NULL AND qr_token_revoked_at IS NULL) AS capture_active
    FROM digital_human_roles
    WHERE id::text = ${roleId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!role) throw fail("Digital-human role not found", "DIGITAL_HUMAN_ROLE_NOT_FOUND", 404);
  return {
    roleId: String(role.id),
    roleName: role.role_name,
    status: role.status,
    captureActive: Boolean(role.capture_active),
    captureUrl: role.capture_active ? digitalHumanCaptureUrl(role.qr_token) : null,
    captureExpiresAt: role.capture_active ? role.qr_token_expires_at : null,
  };
};

const createDigitalHumanCaptureLinkMutationHandler = (runUserOperation, action) => async ({ userId, parameters, context }) => {
  const roleId = identifier(parameters?.roleId || parameters?.role_id, "roleId is required", "DIGITAL_HUMAN_ROLE_ID_REQUIRED");
  const rotate = action === "rotate";
  const nextToken = rotate ? `dh_${randomBytes(32).toString("base64url")}` : null;
  const result = await runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: `digital_human.capture.${action}`,
    targetType: "digital_human_role",
    targetId: roleId,
    requestPayload: { roleId, action },
    mutate: async (tx) => {
      const [role] = await tx`
        SELECT id, role_name, status, qr_token, qr_token_expires_at,
               qr_token_claimed_at, qr_token_consumed_at, qr_token_revoked_at
        FROM digital_human_roles
        WHERE id::text = ${roleId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!role) throw fail("Digital-human role not found", "DIGITAL_HUMAN_ROLE_NOT_FOUND", 404);
      if (role.qr_token_claimed_at && !role.qr_token_consumed_at && !role.qr_token_revoked_at) {
        throw fail("Capture upload is already in progress", "DIGITAL_HUMAN_CAPTURE_IN_PROGRESS", 409);
      }
      const [updated] = rotate
        ? await tx`
            UPDATE digital_human_roles
            SET qr_token = ${nextToken}, qr_token_issued_at = NOW(),
                qr_token_expires_at = NOW() + INTERVAL '24 hours',
                qr_token_claimed_at = NULL, qr_token_consumed_at = NULL,
                qr_token_revoked_at = NULL, updated_at = NOW()
            WHERE id = ${role.id} AND user_id = ${userId}
            RETURNING id, role_name, status, qr_token, qr_token_expires_at
          `
        : await tx`
            UPDATE digital_human_roles
            SET qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()), updated_at = NOW()
            WHERE id = ${role.id} AND user_id = ${userId}
            RETURNING id, role_name, status, qr_token, qr_token_expires_at
          `;
      return updated;
    },
  });
  return {
    roleId: String(result.id),
    roleName: result.role_name,
    status: result.status,
    captureActive: rotate,
    captureUrl: rotate ? digitalHumanCaptureUrl(result.qr_token) : null,
    captureExpiresAt: rotate ? result.qr_token_expires_at : null,
  };
};

const createDigitalHumanAttachCreationHandler = (runUserOperation) => async ({ userId, parameters, context }) => {
  const roleId = identifier(parameters?.roleId || parameters?.role_id, "roleId is required", "DIGITAL_HUMAN_ROLE_ID_REQUIRED");
  const creationId = identifier(parameters?.creationId || parameters?.creation_id, "creationId is required", "CREATION_ID_REQUIRED");
  const requestedKind = String(parameters?.assetKind || parameters?.asset_kind || "").trim().toLowerCase();
  if (requestedKind && !new Set(["image", "video"]).has(requestedKind)) {
    throw fail("assetKind must be image or video", "INVALID_DIGITAL_HUMAN_ASSET_KIND");
  }
  return runUserOperation({
    userId,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    action: "digital_human.asset.attached",
    targetType: "digital_human_role",
    targetId: roleId,
    requestPayload: { roleId, creationId, assetKind: requestedKind || null },
    mutate: async (tx) => {
      const [[role], [creation]] = await Promise.all([
        tx`
          SELECT id, role_name, status
          FROM digital_human_roles
          WHERE id::text = ${roleId} AND user_id = ${userId}
          FOR UPDATE
        `,
        tx`
          SELECT id, type, status, content, content_object_key
          FROM creations
          WHERE id::text = ${creationId} AND user_id = ${userId}
          LIMIT 1
        `,
      ]);
      if (!role) throw fail("Digital-human role not found", "DIGITAL_HUMAN_ROLE_NOT_FOUND", 404);
      if (!creation || creation.status !== "completed" || !["image", "video"].includes(creation.type)
          || !creation.content || !creation.content_object_key) {
        throw fail("Completed owned image or video creation is required", "DIGITAL_HUMAN_CREATION_UNAVAILABLE", 404);
      }
      if (requestedKind && requestedKind !== creation.type) {
        throw fail("assetKind does not match the selected creation", "DIGITAL_HUMAN_ASSET_KIND_MISMATCH", 409);
      }
      const [updated] = creation.type === "video"
        ? await tx`
            UPDATE digital_human_roles
            SET demo_video_url = ${creation.content}, demo_video_object_key = ${creation.content_object_key},
                status = 'training', ready_at = NOW() + INTERVAL '14 seconds',
                qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()), updated_at = NOW()
            WHERE id = ${role.id} AND user_id = ${userId}
            RETURNING id, role_name, status, avatar_url, demo_video_url, ready_at, updated_at
          `
        : await tx`
            UPDATE digital_human_roles
            SET avatar_url = ${creation.content}, avatar_object_key = ${creation.content_object_key},
                status = 'training', ready_at = NOW() + INTERVAL '14 seconds',
                qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()), updated_at = NOW()
            WHERE id = ${role.id} AND user_id = ${userId}
            RETURNING id, role_name, status, avatar_url, demo_video_url, ready_at, updated_at
          `;
      return {
        roleId: String(updated.id),
        roleName: updated.role_name,
        status: updated.status,
        attachedCreationId: String(creation.id),
        assetKind: creation.type,
        avatarUrl: updated.avatar_url || null,
        demoVideoUrl: updated.demo_video_url || null,
        readyAt: updated.ready_at,
        updatedAt: updated.updated_at,
      };
    },
  });
};

const createDigitalHumanAssetUploadActionHandler = (sqlClient) => async ({ userId, parameters }) => {
  const roleId = identifier(parameters?.roleId || parameters?.role_id, "roleId is required", "DIGITAL_HUMAN_ROLE_ID_REQUIRED");
  const assetKind = String(parameters?.assetKind || parameters?.asset_kind || "").trim().toLowerCase();
  if (!new Set(["image", "video"]).has(assetKind)) {
    throw fail("assetKind must be image or video", "INVALID_DIGITAL_HUMAN_ASSET_KIND");
  }
  const [role] = await sqlClient`
    SELECT id, role_name, status
    FROM digital_human_roles
    WHERE id::text = ${roleId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!role) throw fail("Digital-human role not found", "DIGITAL_HUMAN_ROLE_NOT_FOUND", 404);
  return {
    clientAction: {
      type: "digital-human.role.asset.upload",
      roleId: String(role.id),
      roleName: role.role_name,
      assetKind,
      accept: `${assetKind}/*`,
    },
  };
};

const createDigitalHumanScriptHandler = () => async ({ userId, membershipTier, parameters, context }) => {
  const [{ getCreativeAgent }, { executeMeteredAgentOperation }] = await Promise.all([
    import("./creativeAgentComposition.js"),
    import("./meteredAgentOperationService.js"),
  ]);
  const request = {
    userId,
    brief: String(parameters?.brief || "").trim(),
    language: parameters?.language === "en" ? "en" : "zh",
    durationSeconds: Number(parameters?.durationSeconds || parameters?.duration_seconds || 30),
  };
  const operation = await executeMeteredAgentOperation({
    userId,
    membershipTier,
    operationType: "digital_human_script_optimizer",
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    requestPayload: request,
    invoke: ({ route }) => getCreativeAgent().optimizeDigitalHumanScript({ ...request, modelRoute: route }),
  });
  return { ...operation.result, pointsCharged: operation.pointsCost, operationId: operation.operationId };
};

const assertRuntimePermission = (userRole, permission) => {
  if (!hasPermission(userRole, permission)) {
    throw fail("The authenticated role cannot use this administrator tool", "USER_RBAC_DENIED", 403);
  }
};

const administratorActor = ({ userId, userRole }) => ({ userId, role: userRole });

const administratorMutationContext = ({ parameters, context }) => {
  const idempotencyKey = normalizeAdministratorIdempotencyKey(idempotencyKeyFrom({ parameters, context }));
  const reason = normalizeAdministratorReason(parameters?.reason);
  return {
    idempotencyKey,
    reason,
    req: {
      headers: {
        "x-idempotency-key": idempotencyKey,
        "x-request-id": String(context?.agentPlanRunId || idempotencyKey).slice(0, 128),
        "user-agent": "StarDraw-Agent/1.0",
      },
    },
  };
};

const administratorReadHandler = (permission, administratorRuntimeFactory, callback) => async (input) => {
  assertRuntimePermission(input.userRole, permission);
  return callback(await administratorRuntimeFactory(), input);
};

const administratorMutationHandler = (permission, administratorRuntimeFactory, callback) => async (input) => {
  assertRuntimePermission(input.userRole, permission);
  return callback(await administratorRuntimeFactory(), input, administratorMutationContext(input));
};

const safeMcpServer = (server, { root = false } = {}) => server ? ({
  id: String(server.id),
  serverKey: server.serverKey,
  displayName: server.displayName,
  providerAdapter: server.providerAdapter,
  status: server.status,
  transport: server.transport,
  allowedDomains: Array.isArray(server.allowedDomains) ? server.allowedDomains : [],
  oauthConfig: {
    allowedScopes: Array.isArray(server.oauthConfig?.allowedScopes)
      ? server.oauthConfig.allowedScopes
      : (Array.isArray(server.oauthConfig?.allowed_scopes) ? server.oauthConfig.allowed_scopes : []),
  },
  enabled: Boolean(server.enabled),
  ...(root ? { canonicalUrl: server.canonicalUrl } : {}),
}) : null;

const safeMcpTool = (tool) => tool ? ({
  id: String(tool.id),
  serverId: String(tool.serverId),
  toolName: tool.toolName,
  description: tool.description,
  operationClass: tool.operationClass,
  requiredRoles: tool.requiredRoles,
  approvalPolicy: tool.approvalPolicy,
  inputSchema: tool.inputSchema,
  enabled: Boolean(tool.enabled),
}) : null;

const createAdministratorUserListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.USER_READ,
  administratorRuntimeFactory,
  ({ access }, { parameters }) => access.listManagedUsers({
    page: parameters?.page,
    pageSize: parameters?.pageSize,
    query: parameters?.query,
    status: parameters?.status,
  }).then((result) => ({
    items: result.rows,
    total: result.total,
    page: result.page,
    pageSize: result.page_size,
  })),
);

const createAdministratorUserSuspensionHandler = (administratorRuntimeFactory, suspended) => administratorMutationHandler(
  PERMISSIONS.USER_SUSPEND,
  administratorRuntimeFactory,
  ({ access }, input, mutation) => access.setUserSuspension({
    actor: administratorActor(input),
    targetUserId: identifier(input.parameters?.targetUserId, "targetUserId is required", "TARGET_USER_ID_REQUIRED"),
    suspended,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    requestPayload: { suspended, reason: mutation.reason },
    req: mutation.req,
  }),
);

const createRootRoleHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.ROLE_MANAGE,
  administratorRuntimeFactory,
  ({ access }, input, mutation) => access.setUserRole({
    actor: administratorActor(input),
    targetUserId: identifier(input.parameters?.targetUserId, "targetUserId is required", "TARGET_USER_ID_REQUIRED"),
    role: String(input.parameters?.role || "").trim().toLowerCase(),
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    requestPayload: { role: input.parameters?.role, reason: mutation.reason },
    req: mutation.req,
  }),
);

const createAdministratorTemplateListHandler = (administratorRuntimeFactory, publicationRequests) => administratorReadHandler(
  PERMISSIONS.TEMPLATE_MANAGE,
  administratorRuntimeFactory,
  ({ templates }, input) => templates.listAdministratorTemplates({
    actor: administratorActor(input),
    publicationRequests,
  }),
);

const createAdministratorTemplateReviewHandler = (administratorRuntimeFactory, decision) => administratorMutationHandler(
  PERMISSIONS.TEMPLATE_MANAGE,
  administratorRuntimeFactory,
  ({ templates }, input, mutation) => templates.reviewTemplatePublication({
    actor: administratorActor(input),
    templateId: input.parameters?.templateId,
    decision,
    requiredMembershipTier: input.parameters?.requiredMembershipTier,
    note: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorTemplateDeactivateHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.TEMPLATE_MANAGE,
  administratorRuntimeFactory,
  ({ templates }, input, mutation) => templates.deactivateTemplateAsAdministrator({
    actor: administratorActor(input),
    templateId: input.parameters?.templateId,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorContentDeleteHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.CONTENT_MODERATE,
  administratorRuntimeFactory,
  ({ recycle }, input, mutation) => recycle.deleteContentAsAdministrator({
    actorUserId: input.userId,
    actorRole: input.userRole,
    ownerUserId: input.parameters?.ownerUserId,
    resourceType: input.parameters?.resourceType,
    resourceId: input.parameters?.resourceId,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorPlanListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ plans }, input) => plans.listConfiguredSubscriptionPlans({ actor: administratorActor(input) }),
);

const createAdministratorPlanSaveHandler = (administratorRuntimeFactory, update) => administratorMutationHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ plans }, input, mutation) => plans.saveConfiguredSubscriptionPlan({
    actor: administratorActor(input),
    planId: update ? input.parameters?.planId : null,
    input: input.parameters?.configuration,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorPlanDeactivateHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ plans }, input, mutation) => plans.deactivateConfiguredSubscriptionPlan({
    actor: administratorActor(input),
    planId: input.parameters?.planId,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorPointPackageListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ pointPackages }, input) => pointPackages.listConfiguredPointPackages({ actor: administratorActor(input) }),
);

const createAdministratorPointPackageSaveHandler = (administratorRuntimeFactory, update) => administratorMutationHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ pointPackages }, input, mutation) => pointPackages.saveConfiguredPointPackage({
    actor: administratorActor(input),
    packageId: update ? input.parameters?.packageId : null,
    input: input.parameters?.configuration,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorPointPackageDeactivateHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  administratorRuntimeFactory,
  ({ pointPackages }, input, mutation) => pointPackages.deactivateConfiguredPointPackage({
    actor: administratorActor(input),
    packageId: input.parameters?.packageId,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createAdministratorRecycleListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.RECYCLE_RESTORE_REQUEST,
  administratorRuntimeFactory,
  ({ recycle }, input) => recycle.listAdministrativeRecycleBin({
    actorRole: input.userRole,
    limit: input.parameters?.limit,
    offset: input.parameters?.offset,
  }),
);

const createAdministratorRestoreRequestHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.RECYCLE_RESTORE_REQUEST,
  administratorRuntimeFactory,
  ({ recycle }, input, mutation) => recycle.requestAdministrativeRestore({
    actorUserId: input.userId,
    actorRole: input.userRole,
    entryId: input.parameters?.entryId,
    reason: mutation.reason,
    idempotencyKey: mutation.idempotencyKey,
    req: mutation.req,
  }),
);

const createRootRestoreReviewHandler = (administratorRuntimeFactory, approve) => administratorMutationHandler(
  PERMISSIONS.RECYCLE_RESTORE_APPROVE,
  administratorRuntimeFactory,
  ({ recycle }, input, mutation) => (approve
    ? recycle.approveAdministrativeRestore({
        rootUserId: input.userId,
        actorRole: input.userRole,
        requestId: input.parameters?.requestId,
        note: mutation.reason,
        idempotencyKey: mutation.idempotencyKey,
        req: mutation.req,
      })
    : recycle.rejectAdministrativeRestore({
        rootUserId: input.userId,
        actorRole: input.userRole,
        requestId: input.parameters?.requestId,
        note: mutation.reason,
        idempotencyKey: mutation.idempotencyKey,
        req: mutation.req,
      })),
);

const createAdministratorMcpServerListHandler = (administratorRuntimeFactory, root) => administratorReadHandler(
  root ? PERMISSIONS.MCP_SERVER_MANAGE : PERMISSIONS.MCP_TOOL_MANAGE,
  administratorRuntimeFactory,
  async ({ mcp }) => (await mcp.getMcpRepository().listAllServers()).map((server) => safeMcpServer(server, { root })),
);

const createAdministratorMcpToolListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.MCP_TOOL_MANAGE,
  administratorRuntimeFactory,
  async ({ mcp }, { parameters }) => {
    const repository = mcp.getMcpRepository();
    const server = await repository.getServerByKey({ serverKey: parameters?.serverKey });
    if (!server) throw fail("MCP server not found", "MCP_SERVER_NOT_FOUND", 404);
    return (await repository.listServerTools({ serverId: server.id, includeDisabled: true })).map(safeMcpTool);
  },
);

const createAdministratorMcpToolUpsertHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }) => administratorMutationHandler(
  PERMISSIONS.MCP_TOOL_MANAGE,
  administratorRuntimeFactory,
  async ({ mcp }, input, mutation) => {
    const serverKey = identifier(input.parameters?.serverKey, "serverKey is required", "MCP_SERVER_KEY_REQUIRED");
    const toolName = identifier(input.parameters?.toolName, "toolName is required", "MCP_TOOL_NAME_REQUIRED");
    const configuration = input.parameters?.configuration || {};
    return administratorOperationExecutor({
      actor: administratorActor(input),
      idempotencyKey: mutation.idempotencyKey,
      action: "mcp.tool.updated",
      targetType: "mcp_tool",
      targetId: `${serverKey}:${toolName}`,
      requestPayload: { serverKey, toolName, configuration, reason: mutation.reason },
      mutate: async (tx) => {
        const repository = mcp.getMcpRepository();
        const server = await repository.getServerByKey({ serverKey });
        if (!server) throw fail("MCP server not found", "MCP_SERVER_NOT_FOUND", 404);
        const before = (await repository.listServerTools({ serverId: server.id, includeDisabled: true }))
          .find((tool) => tool.toolName === toolName) || null;
        const after = await mcp.getMcpConfigurationRuntime().upsertServerTool({
          serverKey,
          toolName,
          ...configuration,
        });
        await administratorAuditWriter({
          req: mutation.req,
          actorUserId: input.userId,
          actorRole: input.userRole,
          action: "mcp.tool.updated",
          targetType: "mcp_tool",
          targetId: `${serverKey}:${toolName}`,
          reason: mutation.reason,
          before: safeMcpTool(before),
          after: safeMcpTool(after),
          tx,
        });
        return safeMcpTool(after);
      },
    });
  },
);

const createRootMcpProviderListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.MCP_SERVER_MANAGE,
  administratorRuntimeFactory,
  ({ mcpCatalog }) => mcpCatalog.listMcpProviderCapabilities(),
);

const createRootMcpRegisterHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }) => administratorMutationHandler(
  PERMISSIONS.MCP_SERVER_MANAGE,
  administratorRuntimeFactory,
  async ({ mcp }, input, mutation) => {
    const parameters = input.parameters || {};
    const serverKey = identifier(parameters.serverKey, "serverKey is required", "MCP_SERVER_KEY_REQUIRED");
    const configuration = {
      serverKey,
      displayName: parameters.displayName,
      canonicalUrl: parameters.canonicalUrl,
      providerAdapter: parameters.providerAdapter,
      transport: parameters.transport,
      allowedDomains: parameters.allowedDomains,
      oauthConfig: parameters.oauthConfig,
      adminNotes: parameters.adminNotes,
      status: parameters.status,
      enabled: parameters.enabled,
    };
    return administratorOperationExecutor({
      actor: administratorActor(input),
      idempotencyKey: mutation.idempotencyKey,
      action: "mcp.server.registered",
      targetType: "mcp_server",
      targetId: serverKey,
      requestPayload: { ...configuration, reason: mutation.reason },
      mutate: async (tx) => {
        const before = await mcp.getMcpRepository().getServerByKey({ serverKey });
        const after = await mcp.getMcpConfigurationRuntime().registerServer(configuration);
        await administratorAuditWriter({
          req: mutation.req,
          actorUserId: input.userId,
          actorRole: input.userRole,
          action: "mcp.server.registered",
          targetType: "mcp_server",
          targetId: serverKey,
          reason: mutation.reason,
          before: safeMcpServer(before, { root: true }),
          after: safeMcpServer(after, { root: true }),
          tx,
        });
        return safeMcpServer(after, { root: true });
      },
    });
  },
);

const createRootMcpStatusHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }) => administratorMutationHandler(
  PERMISSIONS.MCP_SERVER_MANAGE,
  administratorRuntimeFactory,
  async ({ mcp }, input, mutation) => {
    const serverKey = identifier(input.parameters?.serverKey, "serverKey is required", "MCP_SERVER_KEY_REQUIRED");
    const status = String(input.parameters?.status || "").trim().toLowerCase();
    const enabled = input.parameters?.enabled === true;
    return administratorOperationExecutor({
      actor: administratorActor(input),
      idempotencyKey: mutation.idempotencyKey,
      action: "mcp.server.status_changed",
      targetType: "mcp_server",
      targetId: serverKey,
      requestPayload: { status, enabled, reason: mutation.reason },
      mutate: async (tx) => {
        const before = await mcp.getMcpRepository().getServerByKey({ serverKey });
        if (!before) throw fail("MCP server not found", "MCP_SERVER_NOT_FOUND", 404);
        const after = await mcp.getMcpConfigurationRuntime().setServerStatus({ serverKey, status, enabled });
        await administratorAuditWriter({
          req: mutation.req,
          actorUserId: input.userId,
          actorRole: input.userRole,
          action: "mcp.server.status_changed",
          targetType: "mcp_server",
          targetId: serverKey,
          reason: mutation.reason,
          before: safeMcpServer(before, { root: true }),
          after: safeMcpServer(after, { root: true }),
          tx,
        });
        return safeMcpServer(after, { root: true });
      },
    });
  },
);

const createRootMcpAuditHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.AUDIT_READ,
  administratorRuntimeFactory,
  ({ mcp }, { parameters }) => mcp.getMcpRepository().listCallAudit({
    userId: parameters?.userId || null,
    serverKey: parameters?.serverKey || null,
    toolName: parameters?.toolName || null,
    limit: parameters?.limit,
  }),
);

const createAdministratorVisualListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.VISUAL_PARAMETER_MANAGE,
  administratorRuntimeFactory,
  ({ visual }) => visual.listVisualParameterCatalog({ includeInactive: true }),
);

const createAdministratorVisualSaveHandler = (administratorRuntimeFactory, update) => administratorMutationHandler(
  PERMISSIONS.VISUAL_PARAMETER_MANAGE,
  administratorRuntimeFactory,
  ({ visual }, input, mutation) => (update
    ? visual.updateVisualParameterOption({
        actor: administratorActor(input), id: input.parameters?.optionId,
        body: input.parameters?.configuration, req: mutation.req, reason: mutation.reason,
      })
    : visual.createVisualParameterOption({
        actor: administratorActor(input), body: input.parameters?.configuration,
        req: mutation.req, reason: mutation.reason,
      })),
);

const createAdministratorVisualDeactivateHandler = (administratorRuntimeFactory) => administratorMutationHandler(
  PERMISSIONS.VISUAL_PARAMETER_MANAGE,
  administratorRuntimeFactory,
  ({ visual }, input, mutation) => visual.deactivateVisualParameterOption({
    actor: administratorActor(input), id: input.parameters?.optionId,
    req: mutation.req, reason: mutation.reason,
  }),
);

const createAdministratorSkillListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.AGENT_SKILL_MANAGE,
  administratorRuntimeFactory,
  ({ skills }) => skills.listDatabaseSkills({ includeInactive: true }),
);

const createAdministratorSkillSaveHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }, update) => administratorMutationHandler(
  PERMISSIONS.AGENT_SKILL_MANAGE,
  administratorRuntimeFactory,
  ({ skills }, input, mutation) => {
    const configuration = input.parameters?.configuration || {};
    const targetName = update ? input.parameters?.skillName : configuration.name;
    return administratorOperationExecutor({
      actor: administratorActor(input),
      idempotencyKey: mutation.idempotencyKey,
      action: update ? "agent_skill.updated" : "agent_skill.created",
      targetType: "agent_skill",
      targetId: targetName,
      requestPayload: { configuration, reason: mutation.reason },
      mutate: async (tx) => {
        const result = await skills.upsertDatabaseSkill({
          input: configuration,
          existingName: update ? input.parameters?.skillName : null,
          actorUserId: input.userId,
          db: tx,
        });
        await administratorAuditWriter({
          req: mutation.req,
          actorUserId: input.userId,
          actorRole: input.userRole,
          action: update ? "agent_skill.updated" : "agent_skill.created",
          targetType: "agent_skill",
          targetId: result.id,
          reason: mutation.reason,
          after: { ...result, content: "[REDACTED]" },
          tx,
        });
        return result;
      },
    });
  },
);

const createAdministratorSkillDeactivateHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }) => administratorMutationHandler(
  PERMISSIONS.AGENT_SKILL_MANAGE,
  administratorRuntimeFactory,
  ({ skills }, input, mutation) => administratorOperationExecutor({
    actor: administratorActor(input),
    idempotencyKey: mutation.idempotencyKey,
    action: "agent_skill.deactivated",
    targetType: "agent_skill",
    targetId: input.parameters?.skillName,
    requestPayload: { reason: mutation.reason },
    mutate: async (tx) => {
      const result = await skills.deactivateDatabaseSkill({
        name: input.parameters?.skillName,
        actorUserId: input.userId,
        db: tx,
      });
      await administratorAuditWriter({
        req: mutation.req,
        actorUserId: input.userId,
        actorRole: input.userRole,
        action: "agent_skill.deactivated",
        targetType: "agent_skill",
        targetId: result.id,
        reason: mutation.reason,
        after: { ...result, content: "[REDACTED]" },
        tx,
      });
      return result;
    },
  }),
);

const createAdministratorCommunityModerationHandler = (administratorRuntimeFactory, action) => administratorMutationHandler(
  PERMISSIONS.CONTENT_MODERATE,
  administratorRuntimeFactory,
  ({ community }, input, mutation) => {
    const common = {
      actor: administratorActor(input),
      creationId: input.parameters?.creationId,
      reason: mutation.reason,
      idempotencyKey: mutation.idempotencyKey,
      req: mutation.req,
    };
    if (action === "hide") return community.hideCreationAsAdministrator(common);
    if (action === "restore") return community.restoreCreationAsAdministrator(common);
    return community.setCreationFeaturedAsAdministrator({ ...common, featured: input.parameters?.featured === true });
  },
);

const createRootModelListHandler = (administratorRuntimeFactory, routes) => administratorReadHandler(
  PERMISSIONS.MODEL_MANAGE,
  administratorRuntimeFactory,
  ({ models }) => (routes
    ? models.listModelRoutes({ includeInactive: true })
    : models.listModelCatalog({ includeInactive: true })),
);

const createRootModelMutationHandler = (administratorRuntimeFactory, action) => administratorMutationHandler(
  PERMISSIONS.MODEL_MANAGE,
  administratorRuntimeFactory,
  ({ models }, input, mutation) => {
    const common = { actor: administratorActor(input), req: mutation.req, reason: mutation.reason };
    if (action === "model.create") return models.createModel({ ...common, body: input.parameters?.configuration });
    if (action === "model.update") return models.updateModel({ ...common, modelKey: input.parameters?.modelKey, body: input.parameters?.configuration });
    if (action === "model.deactivate") return models.deactivateModel({ ...common, modelKey: input.parameters?.modelKey });
    if (action === "route.create") return models.createModelRoute({ ...common, body: input.parameters?.configuration });
    if (action === "route.update") return models.updateModelRoute({ ...common, routeId: input.parameters?.routeId, body: input.parameters?.configuration });
    return models.deactivateModelRoute({ ...common, routeId: input.parameters?.routeId });
  },
);

const createRootExecutionPolicyListHandler = (administratorRuntimeFactory, sqlClient) => administratorReadHandler(
  PERMISSIONS.EXECUTION_POLICY_MANAGE,
  administratorRuntimeFactory,
  ({ executionPolicies }) => executionPolicies.listExecutionPolicies({ db: sqlClient }),
);

const createRootExecutionPolicyUpdateHandler = ({ administratorRuntimeFactory, administratorOperationExecutor, administratorAuditWriter }) => administratorMutationHandler(
  PERMISSIONS.EXECUTION_POLICY_MANAGE,
  administratorRuntimeFactory,
  ({ executionPolicies }, input, mutation) => {
    const membershipTier = input.parameters?.membershipTier;
    const operationKey = input.parameters?.operationKey;
    return administratorOperationExecutor({
      actor: administratorActor(input),
      idempotencyKey: mutation.idempotencyKey,
      action: "execution_policy.updated",
      targetType: "execution_policy",
      targetId: `${membershipTier}:${operationKey}`,
      requestPayload: { configuration: input.parameters?.configuration, reason: mutation.reason },
      mutate: async (tx) => {
        const result = await executionPolicies.updateExecutionPolicy({
          tx,
          membershipTier,
          operationKey,
          changes: input.parameters?.configuration,
        });
        await administratorAuditWriter({
          req: mutation.req,
          actorUserId: input.userId,
          actorRole: input.userRole,
          action: "execution_policy.updated",
          targetType: "execution_policy",
          targetId: `${membershipTier}:${operationKey}`,
          reason: mutation.reason,
          before: result.before,
          after: result.after,
          tx,
        });
        return result.after;
      },
    });
  },
);

const createRootAuditListHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.AUDIT_READ,
  administratorRuntimeFactory,
  ({ audit }, { parameters }) => audit.listAuditLogs(parameters || {}),
);

const createRootPrivateContentReviewHandler = (administratorRuntimeFactory) => administratorReadHandler(
  PERMISSIONS.PRIVATE_CONTENT_REVIEW,
  administratorRuntimeFactory,
  ({ privateContent }, input) => privateContent.reviewPrivateContent({
    actor: administratorActor(input),
    ownerUserId: input.parameters?.ownerUserId,
    resourceType: input.parameters?.resourceType,
    resourceId: input.parameters?.resourceId,
    reason: input.parameters?.reason,
    req: {
      headers: {
        "x-request-id": String(input.context?.agentPlanRunId || input.sessionId || "agent-private-review").slice(0, 128),
        "user-agent": "StarDraw-Agent/1.0",
      },
    },
  }),
);

const defaultSubscriptionPurchasesEnabled = () => ["1", "true", "yes", "on"].includes(
  String(process.env.SUBSCRIPTION_PURCHASES_ENABLED || "false").trim().toLowerCase(),
);

const defaultSubscriptionReturnUrl = () => (
  process.env.ALIPAY_RETURN_URL || `${process.env.APP_BASE_URL || ""}/ai/billing`
);

const createBillingPayHandler = ({ createOrder, purchasesEnabled, returnUrl }) => async ({
  userId,
  parameters,
  context,
}) => {
  if (!purchasesEnabled()) {
    throw fail("Subscription purchases are not open yet", "SUBSCRIPTION_PURCHASES_DISABLED", 503);
  }
  const planKey = identifier(
    parameters?.planKey || parameters?.plan_key,
    "planKey is required",
    "PLAN_KEY_REQUIRED",
  );
  return createOrder({
    userId,
    planKey,
    clientRequestId: idempotencyKeyFrom({ parameters, context }),
    contactEmail: parameters?.contactEmail || parameters?.contact_email || null,
    returnUrl: returnUrl(),
  });
};

const createBillingRefundHandler = (refundOrder) => async ({ userId, userRole, parameters, context }) => {
  if (userRole !== "root") throw fail("Only root can refund subscription orders", "USER_RBAC_DENIED", 403);
  const orderNo = identifier(
    parameters?.orderNo || parameters?.order_no,
    "orderNo is required",
    "ORDER_NO_REQUIRED",
  );
  return refundOrder({
    orderNo,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    reason: String(parameters?.reason || "Agent approved subscription refund").slice(0, 500),
    actor: { userId, role: userRole },
    req: null,
  });
};

const createPointPackagePurchaseHandler = ({ createOrder, purchasesEnabled, returnUrl }) => async ({
  userId,
  parameters,
  context,
}) => {
  if (!purchasesEnabled()) {
    throw fail("Point package purchases are not open yet", "POINT_PACKAGE_PURCHASES_DISABLED", 503);
  }
  const packageKey = identifier(
    parameters?.packageKey || parameters?.package_key,
    "packageKey is required",
    "PACKAGE_KEY_REQUIRED",
  );
  return createOrder({
    userId,
    packageKey,
    clientRequestId: idempotencyKeyFrom({ parameters, context }),
    returnUrl: returnUrl(),
  });
};

const createPointPackageRefundHandler = (refundOrder) => async ({ userId, userRole, parameters, context }) => {
  if (userRole !== "root") throw fail("Only root can refund point-package orders", "USER_RBAC_DENIED", 403);
  const orderNo = identifier(
    parameters?.orderNo || parameters?.order_no,
    "orderNo is required",
    "ORDER_NO_REQUIRED",
  );
  return refundOrder({
    orderNo,
    idempotencyKey: idempotencyKeyFrom({ parameters, context }),
    reason: String(parameters?.reason || "Agent approved point-package refund").slice(0, 500),
    actor: { userId, role: userRole },
    req: null,
  });
};

/** Build the built-in handler map without opening a database connection. */
export const createDefaultAgentToolHandlers = ({
  sqlClient = sql,
  workflowRuntimeFactory = defaultWorkflowRuntimeFactory,
  generationApplicationFactory = defaultGenerationApplicationFactory,
  objectStorageFactory = defaultObjectStorageFactory,
  mcpRuntimeFactory = defaultMcpRuntimeFactory,
  mcpUserRuntimeFactory = defaultMcpUserRuntimeFactory,
  deleteContent = defaultDeleteContent,
  runUserOperation = defaultRunUserOperation,
  releasePointsOperation = defaultReleasePoints,
  reconcileVideoCreation = defaultReconcileVideoCreation,
  createOrder = defaultCreateOrder,
  refundOrder = defaultRefundOrder,
  listPointPackages = defaultListPointPackages,
  createPointPackageOrder = defaultCreatePointPackageOrder,
  refundPointPackageOrder = defaultRefundPointPackageOrder,
  cancelRenewal = defaultCancelRenewal,
  purchasesEnabled = defaultSubscriptionPurchasesEnabled,
  subscriptionReturnUrl = defaultSubscriptionReturnUrl,
  communityServiceFactory = defaultCommunityServiceFactory,
  taskCenterFactory = defaultTaskCenterFactory,
  administratorRuntimeFactory = defaultAdministratorRuntimeFactory,
  administratorOperationExecutor = executeAdministratorOperation,
  administratorAuditWriter = writeAuditLog,
} = {}) => {
  const userTemplateService = new UserTemplateAgentService({
    sqlClient,
    operationExecutor: runUserOperation,
    deleteContent,
  });
  const imageGenerationHandler = createImageGenerationHandler(generationApplicationFactory, objectStorageFactory, sqlClient);
  const administratorDependencies = {
    administratorRuntimeFactory,
    administratorOperationExecutor,
    administratorAuditWriter,
  };
  return new Map([
  ["agent.capability.search", createAgentCapabilitySearchHandler()],
  ["canvas.list", createCanvasListHandler(sqlClient)],
  ["canvas.create", createCanvasCreateHandler(sqlClient)],
  ["canvas.read", createCanvasReadHandler(sqlClient)],
  ["canvas.edit", createCanvasEditHandler(sqlClient)],
  ["canvas.patch", createCanvasPatchHandler(sqlClient)],
  ["canvas.asset.attach_creation", createCanvasAttachCreationHandler(sqlClient)],
  ["canvas.asset.upload", createCanvasAssetUploadActionHandler(sqlClient)],
  ["canvas.export.image", createCanvasBrowserActionHandler(sqlClient, "canvas.export.image")],
  ["workflow.catalog", createWorkflowCatalogHandler()],
  ["workflow.read", createWorkflowReadHandler(sqlClient, workflowRuntimeFactory)],
  ["workflow.save", createWorkflowSaveHandler(sqlClient, workflowRuntimeFactory)],
  ["workflow.patch", createWorkflowPatchHandler(sqlClient, workflowRuntimeFactory)],
  ["workflow.run", createWorkflowRunHandler(sqlClient, workflowRuntimeFactory)],
  ["workflow.estimate", createWorkflowEstimateHandler(sqlClient, workflowRuntimeFactory)],
  ["workflow.get", createWorkflowGetHandler(workflowRuntimeFactory)],
  ["workflow.events", createWorkflowEventsHandler(workflowRuntimeFactory)],
  ["workflow.cancel", createWorkflowCancelHandler(workflowRuntimeFactory)],
  ["media.estimate", createMediaEstimateHandler(sqlClient)],
  ["media.generate.image", imageGenerationHandler],
  ["media.remove-background", createImageRemovalHandler(imageGenerationHandler, "background")],
  ["media.remove-object", createImageRemovalHandler(imageGenerationHandler, "object")],
  ["media.generate.video", createVideoGenerationHandler(generationApplicationFactory, objectStorageFactory, sqlClient)],
  ["storyboard.edit", createStoryboardEditHandler(sqlClient)],
  ["storyboard.patch", createStoryboardPatchHandler(sqlClient)],
  ["timeline.edit", createCanvasSectionEditHandler(sqlClient, "timeline", ["timeline"])],
  ["timeline.render", createCanvasBrowserActionHandler(sqlClient, "timeline.render")],
  ["director3d.edit", createCanvasSectionEditHandler(sqlClient, "director3d", ["director3d", "director_3d"])],
  ["model.list", createModelListHandler(sqlClient)],
  ["visual-parameter.list", createVisualParameterListHandler(sqlClient)],
  ["template.use", createTemplateUseHandler(sqlClient)],
  ["template.search", createTemplateSearchHandler(sqlClient)],
  ["template.create", createUserTemplateHandler(userTemplateService, "create")],
  ["template.update", createUserTemplateHandler(userTemplateService, "update")],
  ["template.import", createUserTemplateHandler(userTemplateService, "import")],
  ["template.export", createUserTemplateHandler(userTemplateService, "export")],
  ["template.preview.upload", createTemplatePreviewUploadActionHandler(sqlClient)],
  ["template.delete", createUserTemplateHandler(userTemplateService, "delete")],
  ["creation.history", createCreationHistoryHandler(sqlClient)],
  ["creation.get", createCreationGetHandler(sqlClient, reconcileVideoCreation)],
  ["creation.download", createCreationDownloadHandler(sqlClient)],
  ["creation.download.batch", createCreationBatchDownloadHandler(sqlClient)],
  ["creation.export.csv", createCreationCsvExportHandler()],
  ["creation.failed.delete", createFailedCreationDeleteHandler({
    runUserOperation,
    releasePointsOperation,
    deleteContent,
  })],
  ["task.list", createTaskListHandler(taskCenterFactory)],
  ["task.get", createTaskGetHandler(taskCenterFactory)],
  ["task.cancel", createTaskCancelHandler(taskCenterFactory)],
  ["community.list", createCommunityListHandler(communityServiceFactory)],
  ["community.get", createCommunityGetHandler(communityServiceFactory)],
  ["community.publication.get", createCommunityPublicationGetHandler(communityServiceFactory)],
  ["community.publish", createCommunityPublishHandler(communityServiceFactory)],
  ["community.unpublish", createCommunityUnpublishHandler(communityServiceFactory)],
  ["community.like", createCommunityRelationHandler(communityServiceFactory, "like")],
  ["community.favorite", createCommunityRelationHandler(communityServiceFactory, "favorite")],
  ["community.report", createCommunityReportHandler(communityServiceFactory)],
  ["account.balance", createAccountBalanceHandler(sqlClient)],
  ["account.ledger.list", createAccountLedgerHandler(sqlClient)],
  ["profile.read", createProfileReadHandler(sqlClient)],
  ["profile.update", createProfileUpdateHandler(sqlClient)],
  ["profile.avatar.upload", createProfileAvatarUploadActionHandler()],
  ["content.recycle.list", createRecycleListHandler()],
  ["content.recycle.restore", createRecycleRestoreHandler()],
  ["content.notification.list", createContentNotificationListHandler()],
  ["content.notification.mark-read", createContentNotificationReadHandler()],
  ["content.delete", createContentDeleteHandler(deleteContent)],
  ["content.publish", createContentPublishHandler(runUserOperation)],
  ["mcp.call.external", createMcpCallHandler(mcpRuntimeFactory)],
  ["mcp.server.list", createMcpServerListHandler(mcpUserRuntimeFactory)],
  ["mcp.connection.list", createMcpConnectionListHandler(mcpUserRuntimeFactory)],
  ["mcp.tool.list", createMcpToolListHandler(mcpUserRuntimeFactory)],
  ["mcp.connection.start", createMcpConnectionStartHandler(mcpUserRuntimeFactory)],
  ["mcp.connection.revoke", createMcpConnectionRevokeHandler(mcpUserRuntimeFactory)],
  ["subscription.plan.list", createSubscriptionPlanListHandler()],
  ["subscription.overview", createSubscriptionOverviewHandler()],
  ["subscription.order.get", createSubscriptionOrderGetHandler(sqlClient)],
  ["subscription.renewal.cancel", createSubscriptionRenewalCancelHandler({
    runUserOperation,
    cancelRenewal,
  })],
  ["point-package.list", createPointPackageListHandler(listPointPackages)],
  ["point-package.order.get", createPointPackageOrderGetHandler(sqlClient)],
  ["point-package.purchase", createPointPackagePurchaseHandler({
    createOrder: createPointPackageOrder,
    purchasesEnabled,
    returnUrl: subscriptionReturnUrl,
  })],
  ["digital-human.role.list", createDigitalHumanRoleListHandler(sqlClient)],
  ["digital-human.role.create", createDigitalHumanRoleHandler(runUserOperation)],
  ["digital-human.role.capture-link.get", createDigitalHumanCaptureLinkGetHandler(sqlClient)],
  ["digital-human.role.capture-link.rotate", createDigitalHumanCaptureLinkMutationHandler(runUserOperation, "rotate")],
  ["digital-human.role.capture-link.revoke", createDigitalHumanCaptureLinkMutationHandler(runUserOperation, "revoke")],
  ["digital-human.role.attach-creation", createDigitalHumanAttachCreationHandler(runUserOperation)],
  ["digital-human.role.asset.upload", createDigitalHumanAssetUploadActionHandler(sqlClient)],
  ["digital-human.script.optimize", createDigitalHumanScriptHandler()],
  ["admin.user.list", createAdministratorUserListHandler(administratorRuntimeFactory)],
  ["admin.user.suspend", createAdministratorUserSuspensionHandler(administratorRuntimeFactory, true)],
  ["admin.user.restore", createAdministratorUserSuspensionHandler(administratorRuntimeFactory, false)],
  ["admin.template.list", createAdministratorTemplateListHandler(administratorRuntimeFactory, false)],
  ["admin.template.review.list", createAdministratorTemplateListHandler(administratorRuntimeFactory, true)],
  ["admin.template.approve", createAdministratorTemplateReviewHandler(administratorRuntimeFactory, "approve")],
  ["admin.template.reject", createAdministratorTemplateReviewHandler(administratorRuntimeFactory, "reject")],
  ["admin.template.deactivate", createAdministratorTemplateDeactivateHandler(administratorRuntimeFactory)],
  ["admin.content.delete", createAdministratorContentDeleteHandler(administratorRuntimeFactory)],
  ["admin.subscription-plan.list", createAdministratorPlanListHandler(administratorRuntimeFactory)],
  ["admin.subscription-plan.create", createAdministratorPlanSaveHandler(administratorRuntimeFactory, false)],
  ["admin.subscription-plan.update", createAdministratorPlanSaveHandler(administratorRuntimeFactory, true)],
  ["admin.subscription-plan.deactivate", createAdministratorPlanDeactivateHandler(administratorRuntimeFactory)],
  ["admin.point-package.list", createAdministratorPointPackageListHandler(administratorRuntimeFactory)],
  ["admin.point-package.create", createAdministratorPointPackageSaveHandler(administratorRuntimeFactory, false)],
  ["admin.point-package.update", createAdministratorPointPackageSaveHandler(administratorRuntimeFactory, true)],
  ["admin.point-package.deactivate", createAdministratorPointPackageDeactivateHandler(administratorRuntimeFactory)],
  ["admin.recycle.list", createAdministratorRecycleListHandler(administratorRuntimeFactory)],
  ["admin.recycle.restore-request", createAdministratorRestoreRequestHandler(administratorRuntimeFactory)],
  ["root.recycle.restore-approve", createRootRestoreReviewHandler(administratorRuntimeFactory, true)],
  ["root.recycle.restore-reject", createRootRestoreReviewHandler(administratorRuntimeFactory, false)],
  ["admin.mcp.server.list", createAdministratorMcpServerListHandler(administratorRuntimeFactory, false)],
  ["admin.mcp.tool.list", createAdministratorMcpToolListHandler(administratorRuntimeFactory)],
  ["admin.mcp.tool.upsert", createAdministratorMcpToolUpsertHandler(administratorDependencies)],
  ["root.mcp.provider.list", createRootMcpProviderListHandler(administratorRuntimeFactory)],
  ["root.mcp.server.list", createAdministratorMcpServerListHandler(administratorRuntimeFactory, true)],
  ["root.mcp.server.register", createRootMcpRegisterHandler(administratorDependencies)],
  ["root.mcp.server.status", createRootMcpStatusHandler(administratorDependencies)],
  ["root.mcp.audit.list", createRootMcpAuditHandler(administratorRuntimeFactory)],
  ["admin.visual-parameter.list", createAdministratorVisualListHandler(administratorRuntimeFactory)],
  ["admin.visual-parameter.create", createAdministratorVisualSaveHandler(administratorRuntimeFactory, false)],
  ["admin.visual-parameter.update", createAdministratorVisualSaveHandler(administratorRuntimeFactory, true)],
  ["admin.visual-parameter.deactivate", createAdministratorVisualDeactivateHandler(administratorRuntimeFactory)],
  ["admin.skill.list", createAdministratorSkillListHandler(administratorRuntimeFactory)],
  ["admin.skill.create", createAdministratorSkillSaveHandler(administratorDependencies, false)],
  ["admin.skill.update", createAdministratorSkillSaveHandler(administratorDependencies, true)],
  ["admin.skill.deactivate", createAdministratorSkillDeactivateHandler(administratorDependencies)],
  ["admin.community.hide", createAdministratorCommunityModerationHandler(administratorRuntimeFactory, "hide")],
  ["admin.community.restore", createAdministratorCommunityModerationHandler(administratorRuntimeFactory, "restore")],
  ["admin.community.feature", createAdministratorCommunityModerationHandler(administratorRuntimeFactory, "feature")],
  ["root.user.role.set", createRootRoleHandler(administratorRuntimeFactory)],
  ["root.model.list", createRootModelListHandler(administratorRuntimeFactory, false)],
  ["root.model.create", createRootModelMutationHandler(administratorRuntimeFactory, "model.create")],
  ["root.model.update", createRootModelMutationHandler(administratorRuntimeFactory, "model.update")],
  ["root.model.deactivate", createRootModelMutationHandler(administratorRuntimeFactory, "model.deactivate")],
  ["root.model-route.list", createRootModelListHandler(administratorRuntimeFactory, true)],
  ["root.model-route.create", createRootModelMutationHandler(administratorRuntimeFactory, "route.create")],
  ["root.model-route.update", createRootModelMutationHandler(administratorRuntimeFactory, "route.update")],
  ["root.model-route.deactivate", createRootModelMutationHandler(administratorRuntimeFactory, "route.deactivate")],
  ["root.execution-policy.list", createRootExecutionPolicyListHandler(administratorRuntimeFactory, sqlClient)],
  ["root.execution-policy.update", createRootExecutionPolicyUpdateHandler(administratorDependencies)],
  ["root.audit.list", createRootAuditListHandler(administratorRuntimeFactory)],
  ["root.private-content.review", createRootPrivateContentReviewHandler(administratorRuntimeFactory)],
  ["billing.pay", createBillingPayHandler({
    createOrder,
    purchasesEnabled,
    returnUrl: subscriptionReturnUrl,
  })],
  ["billing.refund", createBillingRefundHandler(refundOrder)],
  ["root.point-package.refund", createPointPackageRefundHandler(refundPointPackageOrder)],
  ]);
};

const HANDLER_VERIFIED_OWNERSHIP = new Set([
  "canvas.read",
  "canvas.edit",
  "canvas.patch",
  "canvas.asset.attach_creation",
  "canvas.asset.upload",
  "canvas.export.image",
  "storyboard.edit",
  "storyboard.patch",
  "timeline.edit",
  "timeline.render",
  "director3d.edit",
  "creation.get",
  "creation.download",
  "creation.failed.delete",
  "content.delete",
  "content.publish",
  "community.publish",
  "community.unpublish",
  "community.publication.get",
  "task.cancel",
  "content.recycle.restore",
]);

export const AGENT_RUNTIME_TOOLS = Object.freeze(DEFAULT_AGENT_TOOLS
  .map((tool) => Object.freeze(HANDLER_VERIFIED_OWNERSHIP.has(tool.toolKey)
    ? { ...tool, requiresOwnership: false, metadata: { ...tool.metadata, ownershipVerifiedByHandler: true } }
    : tool)));

export const buildRuntime = ({
  sqlClient = sql,
  tools = AGENT_RUNTIME_TOOLS,
  handlers = null,
  handlerDependencies = {},
  auditSink,
  approvalStore,
  approvalService,
  governor,
} = {}) => {
  const registry = new AgentToolRegistry({ tools });
  const policy = new AgentPolicyService({ registry });
  const configuredHandlers = handlers || createDefaultAgentToolHandlers({ sqlClient, ...handlerDependencies });
  const resolvedHandlers = configuredHandlers instanceof Map
    ? configuredHandlers
    : new Map(Object.entries(configuredHandlers || {}));
  const missingHandlers = registry.listTools({ includeDisabled: true })
    .map((tool) => tool.toolKey)
    .filter((toolKey) => typeof resolvedHandlers.get(toolKey) !== "function");
  if (missingHandlers.length > 0) {
    throw new TypeError(`Agent tools are missing server handlers: ${missingHandlers.join(", ")}`);
  }
  const resolvedAuditSink = auditSink === undefined
    ? new PostgresAgentAuditSink({ sqlClient })
    : auditSink;
  const resolvedApprovalStore = approvalStore || new PostgresAgentApprovalStore({ sqlClient });
  const approvals = approvalService || new AgentApprovalService({
    store: resolvedApprovalStore,
    auditSink: resolvedAuditSink,
  });
  return new AgentToolRuntimeService({
    registry,
    policy,
    approvals,
    auditSink: resolvedAuditSink,
    handlers: resolvedHandlers,
    governor: governor === undefined ? getExecutionGovernor() : governor,
  });
};

/** Lazy composition root: importing routes never opens a new DB-backed runtime. */
export const getAgentRuntime = () => {
  if (!runtime) runtime = buildRuntime();
  return runtime;
};

export const resetAgentRuntimeForTests = () => {
  runtime = null;
};
