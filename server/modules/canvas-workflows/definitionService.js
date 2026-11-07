import { randomUUID } from "node:crypto";

import sql from "../../configs/db.js";
import { getWorkflowRuntime } from "../../services/workflowRuntimeComposition.js";
import { workflowContainsMcpCall } from "../../services/workflowCostService.js";
import { getCanvasWorkflowNodeDefinition } from "./workflowCatalog.js";
import { resolveWorkflowNodeConfig } from "./nodeConfig.js";
import { appendCanvasRevision } from "../../services/canvasRevisionService.js";
import { normalizeWorkflowVariableDefinitions } from "./variables.js";

const MAX_NODES = 200;
const MAX_NAME = 160;
const MAX_LOOP_ITERATIONS = Math.max(1, Math.min(100, Number(process.env.WORKFLOW_LOOP_MAX_ITERATIONS || 20)));
// Keep a bounded per-loop cap, but do not derive it from the default iteration
// count: a workflow may explicitly allow up to 100 iterations and should be
// able to use the configured concurrency for those items.
const MAX_LOOP_CONCURRENCY = Math.max(1, Math.min(100, Number(process.env.WORKFLOW_LOOP_MAX_CONCURRENCY || 100)));
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const fail = (message, code = "INVALID_CANVAS_WORKFLOW", status = 400, extra = {}) => {
  throw Object.assign(new Error(message), { code, status, ...extra });
};

const clean = (value, max = MAX_NAME) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const jsonClone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];

const normalizeEdge = (edge, index, nodeKeys) => {
  const from = clean(edge?.from || edge?.source, 128);
  const to = clean(edge?.to || edge?.target, 128);
  if (!nodeKeys.has(from) || !nodeKeys.has(to) || from === to) fail(`Invalid workflow edge ${from || "?"} -> ${to || "?"}`);
  const branch = ["true", "false"].includes(String(edge?.branch || edge?.sourceHandle || "").toLowerCase())
    ? String(edge.branch || edge.sourceHandle).toLowerCase()
    : null;
  return { id: clean(edge?.id, 160) || `edge_${index + 1}`, from, to, branch };
};

export const normalizeCanvasWorkflowDefinition = (definition = {}, { depth = 0 } = {}) => {
  if (depth > 2) fail("Nested workflow depth exceeds the supported limit", "WORKFLOW_NESTING_LIMIT");
  const rawNodes = array(definition.nodes);
  if (rawNodes.length > MAX_NODES) fail(`Workflow cannot contain more than ${MAX_NODES} nodes`);
  const keys = new Set();
  const nodes = rawNodes.map((raw, index) => {
    const id = clean(raw?.id || raw?.nodeKey || raw?.node_key || `node_${index + 1}`, 128);
    if (!SAFE_KEY.test(id) || keys.has(id)) fail(`Invalid or duplicate workflow node key: ${id}`);
    keys.add(id);
    const type = clean(raw?.type || raw?.nodeType || raw?.node_type, 80).toLowerCase();
    if (!getCanvasWorkflowNodeDefinition(type)) fail(`Unsupported workflow node type: ${type}`, "WORKFLOW_NODE_TYPE_UNSUPPORTED");
    const config = jsonClone(resolveWorkflowNodeConfig(raw));
    if (["loop.foreach", "loop.repeat_until"].includes(type)) {
      config.maxIterations = Math.min(MAX_LOOP_ITERATIONS, Math.max(1, Number(config.maxIterations || config.max_iterations || 20) || 20));
      config.concurrency = type === "loop.foreach"
        ? Math.min(MAX_LOOP_CONCURRENCY, Math.max(1, Number(config.concurrency || 1) || 1))
        : 1;
      config.body = normalizeCanvasWorkflowDefinition(config.body || {}, { depth: depth + 1 });
    }
    return {
      id,
      type,
      title: clean(raw?.title || raw?.label || id),
      x: Number.isFinite(Number(raw?.x ?? raw?.position?.x)) ? Number(raw?.x ?? raw.position.x) : index * 260,
      y: Number.isFinite(Number(raw?.y ?? raw?.position?.y)) ? Number(raw?.y ?? raw.position.y) : (index % 2) * 180,
      config,
      pointsEstimate: Math.max(0, Number(raw?.pointsEstimate ?? raw?.points_estimate ?? 0) || 0),
    };
  });
  const edges = array(definition.edges).map((edge, index) => normalizeEdge(edge, index, keys));
  const inferredEdges = [];
  rawNodes.forEach((raw, index) => {
    const to = nodes[index]?.id;
    const config = object(resolveWorkflowNodeConfig(raw));
    const dependencies = [
      ...array(raw?.dependsOn || raw?.depends_on),
      ...array(config.dependsOn || config.depends_on),
    ];
    [...new Set(dependencies.map((dependency) => clean(dependency)).filter(Boolean))].forEach((from) => {
      if (!keys.has(from) || from === to) return;
      const when = object(config.when);
      const whenNodeKey = clean(when.nodeKey || when.node_key);
      const whenBranch = ["true", "false"].includes(clean(when.branch).toLowerCase())
        && whenNodeKey === from
        ? clean(when.branch).toLowerCase()
        : null;
      const alreadyConnected = edges.some((edge) => (
        edge.from === from && edge.to === to && (!whenBranch || edge.branch === whenBranch)
      ));
      if (alreadyConnected) return;
      inferredEdges.push(normalizeEdge({
        id: `${from}->${to}${whenBranch ? `:${whenBranch}` : ""}`,
        from,
        to,
        branch: whenBranch,
      }, edges.length + inferredEdges.length, keys));
    });
  });
  edges.push(...inferredEdges);
  const incoming = new Map(nodes.map((node) => [node.id, []]));
  edges.forEach((edge) => incoming.get(edge.to).push(edge));
  const enrichedNodes = nodes.map((node) => {
    const incomingEdges = incoming.get(node.id) || [];
    const branchEdge = incomingEdges.find((edge) => edge.branch);
    return {
      ...node,
      dependsOn: [...new Set(incomingEdges.map((edge) => edge.from))],
      config: branchEdge
        ? { ...node.config, when: { nodeKey: branchEdge.from, branch: branchEdge.branch } }
        : node.config,
    };
  });
  return {
    schemaVersion: 2,
    version: Number(definition.version || 1),
    variables: normalizeWorkflowVariableDefinitions(definition.variables),
    nodes: enrichedNodes,
    edges,
    viewport: object(definition.viewport),
  };
};

const assertOwnedCanvas = async ({ userId, canvasId, db = sql }) => {
  const [canvas] = await db`SELECT id, title, canvas_state FROM canvases WHERE id = ${canvasId} AND user_id = ${userId} LIMIT 1`;
  if (!canvas) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  return canvas;
};

export const isCanvasWorkflowLocked = async ({ userId, workflowId, db = sql } = {}) => {
  const [row] = await db`
    SELECT run.id, run.status,
           EXISTS (
             SELECT 1 FROM workflow_nodes node
             WHERE node.run_id = run.id AND node.status = 'waiting_approval'
           ) AS waiting_approval
    FROM workflow_runs run
    JOIN canvas_workflows workflow ON workflow.id = run.workflow_id
    WHERE workflow.id = ${workflowId} AND workflow.user_id = ${userId}
      AND (
        run.status IN ('queued', 'running')
        OR (run.status = 'paused' AND EXISTS (
          SELECT 1 FROM workflow_nodes node
          WHERE node.run_id = run.id AND node.status = 'waiting_approval'
        ))
      )
    ORDER BY run.id DESC
    LIMIT 1
  `;
  return row ? { locked: true, runId: String(row.id), status: row.waiting_approval ? "waiting_approval" : row.status } : { locked: false };
};

const mapWorkflow = (row) => row ? ({
  id: row.id,
  canvasId: row.canvas_id,
  name: row.name,
  version: Number(row.current_version || row.version || 1),
  definition: row.definition || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
}) : null;

export const listCanvasWorkflows = async ({ userId, canvasId, db = sql } = {}) => {
  await assertOwnedCanvas({ userId, canvasId, db });
  const rows = await db`
    SELECT workflow.id, workflow.canvas_id, workflow.name, workflow.current_version,
           workflow.created_at, workflow.updated_at,
           version.definition
    FROM canvas_workflows workflow
    JOIN canvas_workflow_versions version
      ON version.workflow_id = workflow.id AND version.version = workflow.current_version
    WHERE workflow.user_id = ${userId} AND workflow.canvas_id = ${canvasId}
      AND workflow.archived_at IS NULL
    ORDER BY workflow.updated_at DESC, workflow.id DESC
  `;
  const locks = await Promise.all(rows.map((row) => isCanvasWorkflowLocked({ userId, workflowId: row.id, db })));
  return rows.map((row, index) => ({ ...mapWorkflow(row), lock: locks[index] }));
};

export const getCanvasWorkflow = async ({ userId, workflowId, db = sql } = {}) => {
  const [row] = await db`
    SELECT workflow.id, workflow.canvas_id, workflow.name, workflow.current_version,
           workflow.created_at, workflow.updated_at, version.definition
    FROM canvas_workflows workflow
    JOIN canvas_workflow_versions version
      ON version.workflow_id = workflow.id AND version.version = workflow.current_version
    WHERE workflow.id = ${workflowId} AND workflow.user_id = ${userId}
      AND workflow.archived_at IS NULL
    LIMIT 1
  `;
  if (!row) fail("Workflow not found", "CANVAS_WORKFLOW_NOT_FOUND", 404);
  return { ...mapWorkflow(row), lock: await isCanvasWorkflowLocked({ userId, workflowId, db }) };
};

const validateExecutionDefinition = async ({ userId, definition }) => {
  if (definition.nodes.length === 0) return { definition, estimate: { totalPoints: 0, knownNodePoints: 0, paths: [], roots: [] } };
  return getWorkflowRuntime().estimate({ userId, definition });
};

export const createCanvasWorkflow = async ({ userId, canvasId, name, definition, db = sql } = {}) => {
  await assertOwnedCanvas({ userId, canvasId, db });
  const normalized = normalizeCanvasWorkflowDefinition(definition);
  const validation = await validateExecutionDefinition({ userId, definition: normalized });
  const workflowId = `cwf_${randomUUID().replaceAll("-", "")}`;
  const workflowName = clean(name) || "Untitled workflow";
  let revision;
  await db.begin(async (tx) => {
    const [canvas] = await tx`
      SELECT id, title, canvas_state
      FROM canvases
      WHERE id = ${canvasId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!canvas) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
    await tx`
      INSERT INTO canvas_workflows (id, user_id, canvas_id, name, current_version)
      VALUES (${workflowId}, ${userId}, ${canvasId}, ${workflowName}, 1)
    `;
    await tx`
      INSERT INTO canvas_workflow_versions (workflow_id, version, definition, created_by_user_id)
      VALUES (${workflowId}, 1, ${tx.json(normalized)}, ${userId})
    `;
    revision = await appendCanvasRevision({
      db: tx,
      userId,
      canvasId,
      title: canvas.title,
      canvasState: canvas.canvas_state,
      reason: "workflow.created",
    });
  });
  return { ...(await getCanvasWorkflow({ userId, workflowId, db })), estimate: validation.estimate, revision };
};

export const updateCanvasWorkflow = async ({ userId, workflowId, name, definition, expectedVersion, db = sql } = {}) => {
  const lock = await isCanvasWorkflowLocked({ userId, workflowId, db });
  if (lock.locked) fail("Workflow cannot be edited while it is running or waiting for approval", "WORKFLOW_EDIT_LOCKED", 409, lock);
  const existing = await getCanvasWorkflow({ userId, workflowId, db });
  if (Number(expectedVersion) !== existing.version) fail("Workflow version changed; reload before saving", "WORKFLOW_VERSION_CONFLICT", 409, { currentVersion: existing.version });
  const normalized = normalizeCanvasWorkflowDefinition(definition);
  const validation = await validateExecutionDefinition({ userId, definition: normalized });
  const nextVersion = existing.version + 1;
  let revision;
  await db.begin(async (tx) => {
    const [canvas] = await tx`
      SELECT id, title, canvas_state
      FROM canvases
      WHERE id = ${existing.canvasId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!canvas) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
    const [updated] = await tx`
      UPDATE canvas_workflows
      SET name = ${clean(name) || existing.name}, current_version = ${nextVersion}, updated_at = NOW()
      WHERE id = ${workflowId} AND user_id = ${userId} AND current_version = ${existing.version}
      RETURNING id
    `;
    if (!updated) fail("Workflow version changed; reload before saving", "WORKFLOW_VERSION_CONFLICT", 409);
    await tx`
      INSERT INTO canvas_workflow_versions (workflow_id, version, definition, created_by_user_id)
      VALUES (${workflowId}, ${nextVersion}, ${tx.json(normalized)}, ${userId})
    `;
    revision = await appendCanvasRevision({
      db: tx,
      userId,
      canvasId: existing.canvasId,
      title: canvas.title,
      canvasState: canvas.canvas_state,
      reason: "workflow.updated",
    });
  });
  return { ...(await getCanvasWorkflow({ userId, workflowId, db })), estimate: validation.estimate, revision };
};

export const runCanvasWorkflowDefinition = async ({
  userId,
  workflowId,
  idempotencyKey,
  mcpApprovalConfirmed = false,
  userRole = "user",
  executionContext = null,
  variables,
  inputs,
} = {}) => {
  const workflow = await getCanvasWorkflow({ userId, workflowId });
  if (workflow.lock.locked) fail("Workflow is already running", "WORKFLOW_ALREADY_RUNNING", 409, workflow.lock);
  const containsMcp = workflowContainsMcpCall(workflow.definition);
  const agentAuthorized = executionContext?.source === "canvas_agent";
  if (containsMcp && !mcpApprovalConfirmed && !agentAuthorized) {
    fail("Workflow MCP calls require explicit user confirmation", "WORKFLOW_MCP_APPROVAL_REQUIRED", 403);
  }
  const trustedExecutionContext = agentAuthorized
    ? executionContext
    : containsMcp ? {
      source: "user_direct",
      agentMode: "full_access",
      userRole,
      approvalId: `workflow-user-confirmed:${idempotencyKey}`,
    } : null;
  return getWorkflowRuntime().start({
    userId,
    canvasId: workflow.canvasId,
    title: workflow.name,
    definition: workflow.definition,
    idempotencyKey,
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    executionContext: trustedExecutionContext,
    variables,
    inputs,
  });
};

export const archiveCanvasWorkflow = async ({ userId, workflowId, db = sql } = {}) => {
  const lock = await isCanvasWorkflowLocked({ userId, workflowId, db });
  if (lock.locked) fail("Workflow cannot be archived while it is running", "WORKFLOW_EDIT_LOCKED", 409, lock);
  const [row] = await db`
    UPDATE canvas_workflows SET archived_at = NOW(), updated_at = NOW()
    WHERE id = ${workflowId} AND user_id = ${userId} AND archived_at IS NULL
    RETURNING id
  `;
  if (!row) fail("Workflow not found", "CANVAS_WORKFLOW_NOT_FOUND", 404);
  return { id: row.id, archived: true };
};

export { MAX_LOOP_CONCURRENCY, MAX_LOOP_ITERATIONS };
