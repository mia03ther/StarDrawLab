import { assertVideoGenerationAvailable } from "./videoMaintenance.js";
import { createHash } from "node:crypto";

import sql from "../configs/db.js";
import { chargePoints, getAccountInfo, releasePoints, reservePoints } from "./pointsService.js";
import {
  estimateWorkflowCost,
  normalizeWorkflowDefinition,
} from "./workflowCostService.js";
import { normalizeAgentMode, normalizeUserRole } from "../ports/agentToolPort.js";
import { resolveWorkflowRunContext } from "../modules/canvas-workflows/variables.js";
import { interpolateWorkflowValue } from "../modules/canvas-workflows/expression.js";

const WORKFLOW_DISPATCH_JOB = "workflow.dispatch";
const WORKFLOW_NODE_JOB = "workflow.node";
const MAX_TITLE_LENGTH = 160;
const WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS = Math.min(1000, Math.max(25, Number(process.env.WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS || 360) || 360));
const SELF_BILLED_NODE_TYPES = new Set([
  "image.generate", "media.generate.image",
  "video.generate", "media.generate.video",
  "agent.call", "condition.ai", "script.optimize",
  "loop.foreach", "loop.repeat_until",
]);
const APPROVAL_NODE_TYPES = new Set(["approval.wait", "approval"]);

const fail = (message, { status = 500, code = "WORKFLOW_EXECUTION_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const hashRequest = (value) => createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex");

const workflowDispatchIdempotencyKey = (runId, trigger) => {
  const triggerDigest = createHash("sha256")
    .update(String(trigger || "start"))
    .digest("hex")
    .slice(0, 32);
  return `workflow-dispatch:${runId}:${triggerDigest}`;
};

const json = (db, value) => typeof db?.json === "function"
  ? db.json(value)
  : JSON.stringify(value);

const safeKey = (value, name = "key") => {
  const normalized = String(value || "").trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw fail(`${name} must be 8-128 safe ASCII characters`, { status: 400, code: "INVALID_WORKFLOW_IDEMPOTENCY_KEY" });
  }
  return normalized;
};

const requiredWorkflowInputKey = (node) => {
  const config = node?.config && typeof node.config === "object" ? node.config : {};
  const value = String(config.value || "").trim();
  const expression = value.match(/^(?:\$\{|\{\{)\s*inputs\.([A-Za-z][A-Za-z0-9_:-]{0,127})\s*(?:\}\}|\})$/);
  if (expression) return expression[1];
  const configured = String(config.inputKey || config.input_key || "").trim();
  if (/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(configured)) return configured;
  if (!Object.prototype.hasOwnProperty.call(config, "value") && !Object.prototype.hasOwnProperty.call(config, "prompt")) {
    const nodeKey = String(node?.nodeKey || "").trim();
    if (/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(nodeKey)) return nodeKey;
  }
  return "";
};

const assertRequiredWorkflowInputs = (nodes, inputs) => {
  const provided = inputs && typeof inputs === "object" && !Array.isArray(inputs) ? inputs : {};
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.nodeType !== "input" || node.config?.required === false) continue;
    const key = requiredWorkflowInputKey(node);
    if (!key || Object.prototype.hasOwnProperty.call(provided, key)) continue;
    throw fail(`Workflow input ${key} is required`, {
      status: 400,
      code: "WORKFLOW_INPUT_REQUIRED",
      inputKey: key,
    });
  }
};

const mapRun = (row) => row ? ({
  id: String(row.id),
  userId: row.user_id,
  canvasId: row.canvas_id,
  workflowId: row.workflow_id || null,
  workflowVersion: row.workflow_version == null ? null : Number(row.workflow_version),
  parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
  title: row.title,
  status: row.status,
  estimatedPoints: Number(row.estimated_points || 0),
  pointsCharged: Number(row.points_charged || 0),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  failedAt: row.failed_at,
  cancelledAt: row.cancelled_at,
}) : null;

const mapNode = (row) => ({
  nodeKey: row.node_key,
  nodeType: row.node_type,
  dependsOn: row.depends_on || [],
  status: row.status,
  pointsEstimate: Number(row.points_estimate || 0),
  pointsCharged: Number(row.points_charged || 0),
  attemptCount: Number(row.attempt_count || 0),
  result: row.result_snapshot,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const event = async (db, { runId, nodeKey = null, eventType, payload = {} }) => db`
  INSERT INTO workflow_events (run_id, node_key, event_type, payload)
  VALUES (${runId}, ${nodeKey}, ${eventType}, ${json(db, payload)})
`;

const isInsufficientPoints = (error) => error?.code === "INSUFFICIENT_POINTS";

const bindTrustedExecutionContext = (definition, executionContext) => {
  const source = String(executionContext?.source || "").trim().toLowerCase();
  if (!source) return definition;
  const agentMode = normalizeAgentMode(executionContext?.agentMode);
  const userRole = normalizeUserRole(executionContext?.userRole);
  const approvalId = executionContext?.approvalId == null
    ? null
    : String(executionContext.approvalId).trim().slice(0, 255) || null;
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (!["mcp.call", "mcp.call.external"].includes(node.nodeType)) return node;
      return {
        ...node,
        config: {
          ...node.config,
          __stardrawExecutionContext: {
            source,
            agentMode,
            userRole,
            approvalId,
          },
        },
      };
    }),
  };
};

const workflowDefinitionForRequestHash = (definition) => ({
  ...definition,
  nodes: definition.nodes.map((node) => {
    const trusted = node.config?.__stardrawExecutionContext;
    if (!trusted) return node;
    return {
      ...node,
      config: {
        ...node.config,
        __stardrawExecutionContext: {
          ...trusted,
          approvalId: null,
        },
      },
    };
  }),
});

/**
 * Persistent workflow application module. The queue and points adapter are
 * injected ports; the default composition uses PostgreSQL implementations.
 */
export class WorkflowExecutionService {
  #sql;
  #queue;
  #points;
  #handlers;
  #resolveNodeCost;
  #resolveNodeCosts;
  #governor;

  constructor({ sqlClient = sql, queue, pointsAdapter = {}, handlers = new Map(), resolveNodeCost = null, resolveNodeCosts = null, governor = null } = {}) {
    if (!sqlClient || typeof sqlClient.begin !== "function") throw new TypeError("WorkflowExecutionService requires a transactional SQL client");
    if (!queue || typeof queue.enqueue !== "function") throw new TypeError("WorkflowExecutionService requires a JobQueuePort");
    this.#sql = sqlClient;
    this.#queue = queue;
    this.#points = {
      getAccountInfo: pointsAdapter.getAccountInfo || getAccountInfo,
      reservePoints: pointsAdapter.reservePoints || reservePoints,
      chargePoints: pointsAdapter.chargePoints || chargePoints,
      releasePoints: pointsAdapter.releasePoints || releasePoints,
    };
    this.#handlers = handlers instanceof Map ? handlers : new Map(Object.entries(handlers || {}));
    this.#resolveNodeCost = resolveNodeCost;
    this.#resolveNodeCosts = resolveNodeCosts;
    this.#governor = governor;
  }

  async #normalizeDefinition(definition, context = {}) {
    let costByKey = null;
    if (typeof this.#resolveNodeCosts === "function") {
      costByKey = await this.#resolveNodeCosts(definition, context);
    }
    return normalizeWorkflowDefinition(definition, {
      resolveNodeCost: ({ nodeKey, ...node }) => {
        if (costByKey instanceof Map && costByKey.has(nodeKey)) return costByKey.get(nodeKey);
        if (costByKey && Object.prototype.hasOwnProperty.call(costByKey, nodeKey)) return costByKey[nodeKey];
        if (typeof this.#resolveNodeCost === "function") return this.#resolveNodeCost({ nodeKey, ...node });
        return node.pointsEstimate ?? node.points_estimate ?? node.pointsCost ?? node.points_cost;
      },
    });
  }

  async estimate({ userId, definition } = {}) {
    const normalized = await this.#normalizeDefinition(definition, { userId });
    const estimate = estimateWorkflowCost(normalized.nodes);
    return { definition: normalized, estimate };
  }

  async start({
    userId,
    canvasId = null,
    title = "Untitled workflow",
    definition,
    idempotencyKey,
    executionContext = null,
    workflowId = null,
    workflowVersion = null,
    parentRunId = null,
    variables,
    inputs,
  } = {}) {
    const normalizedKey = safeKey(idempotencyKey, "X-Idempotency-Key");
    const normalizedTitle = String(title || "Untitled workflow").trim().slice(0, MAX_TITLE_LENGTH) || "Untitled workflow";
    const normalizedInput = await this.#normalizeDefinition(definition, { userId });
    const baseExecutionContext = executionContext && typeof executionContext === "object" && !Array.isArray(executionContext)
      ? executionContext
      : {};
    const resolvedRunContext = resolveWorkflowRunContext({
      definitions: normalizedInput.variables,
      variableValues: variables,
      inputs,
      inheritedVariables: baseExecutionContext.variables,
      inheritedInputs: baseExecutionContext.inputs,
      allowInheritedVariables: variables === undefined && Boolean(baseExecutionContext.variables),
    });
    const runtimeExecutionContext = {
      ...baseExecutionContext,
      ...resolvedRunContext,
    };
    assertRequiredWorkflowInputs(normalizedInput.nodes, runtimeExecutionContext.inputs);
    const normalized = bindTrustedExecutionContext(normalizedInput, runtimeExecutionContext);
    if (normalized.nodes.some(node => ["video.generate", "media.generate.video"].includes(node.type || node.nodeType || node.node_type))) assertVideoGenerationAvailable();
    const estimate = estimateWorkflowCost(normalized.nodes);
    const requestHash = hashRequest({
      userId,
      canvasId,
      title: normalizedTitle,
      definition: workflowDefinitionForRequestHash(normalized),
      executionContext: { ...runtimeExecutionContext, approvalId: null },
      workflowId,
      workflowVersion,
      parentRunId,
    });
    const account = await this.#points.getAccountInfo(userId);
    const availablePoints = Number(account?.available_points ?? 0);
    if (availablePoints < estimate.totalPoints) {
      throw fail("Insufficient points for the estimated workflow cost", {
        status: 402,
        code: "INSUFFICIENT_POINTS",
        available_points: availablePoints,
        required_points: estimate.totalPoints,
      });
    }

    const admission = this.#governor
      ? await this.#governor.admit({
          userId,
          operationKey: "workflow.run",
          queueName: "workflow",
          idempotencyKey: normalizedKey,
          leaseDurationMs: 24 * 60 * 60 * 1000,
          metadata: { source: "workflow_run", estimatedPoints: estimate.totalPoints },
        })
      : null;

    let initialized;
    try {
      initialized = await this.#sql.begin(async (tx) => {
      const [inserted] = await tx`
        INSERT INTO workflow_runs
          (user_id, canvas_id, title, request_idempotency_key, request_hash,
           definition_snapshot, status, estimated_points, execution_lease_id,
           workflow_id, workflow_version, parent_run_id, execution_context)
        VALUES
          (${userId}, ${canvasId}, ${normalizedTitle}, ${normalizedKey}, ${requestHash},
           ${json(tx, normalized)}, 'queued', ${estimate.totalPoints},
           ${admission?.leaseId || null}, ${workflowId}, ${workflowVersion}, ${parentRunId},
           ${json(tx, runtimeExecutionContext)})
        ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
        RETURNING id, user_id, canvas_id, title, status, estimated_points, points_charged,
                  error_code, error_message, created_at, updated_at, started_at,
                  completed_at, failed_at, cancelled_at
      `;

      if (!inserted) {
        const [existing] = await tx`
          SELECT id, user_id, canvas_id, title, status, estimated_points, points_charged,
                 error_code, error_message, created_at, updated_at, started_at,
                 completed_at, failed_at, cancelled_at, request_hash
          FROM workflow_runs
          WHERE user_id = ${userId} AND request_idempotency_key = ${normalizedKey}
          FOR UPDATE
        `;
        if (!existing) throw fail("Workflow idempotency record was not found", { code: "WORKFLOW_STATE_CONFLICT" });
        if (existing.request_hash !== requestHash) throw fail("X-Idempotency-Key was reused with different workflow parameters", {
          status: 409,
          code: "WORKFLOW_IDEMPOTENCY_CONFLICT",
          run_id: String(existing.id),
        });
        return { replayed: true, run: mapRun(existing) };
      }

      for (const node of normalized.nodes) {
        await tx`
          INSERT INTO workflow_nodes
            (run_id, node_key, node_type, depends_on, config, points_estimate)
          VALUES
            (${inserted.id}, ${node.nodeKey}, ${node.nodeType}, ${node.dependsOn},
             ${json(tx, node.config)}, ${node.pointsEstimate})
        `;
      }
      await event(tx, {
        runId: inserted.id,
        eventType: "workflow.created",
        payload: {
          estimatedPoints: estimate.totalPoints,
          nodeCount: normalized.nodes.length,
          variableKeys: Object.keys(runtimeExecutionContext.variables || {}),
          inputKeys: Object.keys(runtimeExecutionContext.inputs || {}),
        },
      });
      return { replayed: false, run: mapRun(inserted) };
      });
    } catch (error) {
      if (admission && !admission.replayed) {
        await this.#governor.release({ leaseId: admission.leaseId, outcome: "failed", error }).catch(() => {});
      }
      throw error;
    }

    if (initialized.replayed) {
      if (admission && !admission.replayed) {
        await this.#governor.release({
          leaseId: admission.leaseId,
          outcome: "cancelled",
          metadata: { reason: "workflow_idempotency_replay" },
        }).catch(() => {});
      }
      return {
        ...initialized,
        estimate,
        availablePoints,
      };
    }
    if (admission?.replayed) {
      throw fail("Execution idempotency state has no matching workflow run", {
        status: 409,
        code: "EXECUTION_IDEMPOTENCY_STATE_CONFLICT",
      });
    }

    try {
      await this.#ensureDispatch(initialized.run.id, userId, { trigger: "start" });
    } catch (error) {
      if (admission) await this.#governor.release({ leaseId: admission.leaseId, outcome: "failed", error }).catch(() => {});
      throw error;
    }
    return {
      ...initialized,
      run: initialized.run,
      estimate,
      availablePoints,
    };
  }

  async #ensureDispatch(runId, userId, { trigger = "start" } = {}) {
    const dispatchTrigger = String(trigger || "start").slice(0, 500);
    await this.#queue.enqueue({
      queueName: "workflow",
      jobType: WORKFLOW_DISPATCH_JOB,
      userId,
      idempotencyKey: workflowDispatchIdempotencyKey(runId, dispatchTrigger),
      payload: { runId: String(runId) },
      metadata: { purpose: "workflow_dispatch", dispatchTrigger },
      maxAttempts: 10,
    });
    await this.#sql`
      UPDATE workflow_runs
      SET status = CASE WHEN status = 'queued' THEN 'running' ELSE status END,
          started_at = COALESCE(started_at, NOW()), updated_at = NOW()
      WHERE id = ${runId} AND status IN ('queued', 'running')
    `;
  }

  async #settleRunAdmission(leaseId, outcome, error = null) {
    if (!this.#governor || !leaseId) return;
    try {
      if (outcome === "completed") {
        await this.#governor.complete({ leaseId: String(leaseId) });
      } else {
        await this.#governor.release({
          leaseId: String(leaseId),
          outcome: outcome === "cancelled" ? "cancelled" : "failed",
          error,
        });
      }
    } catch {
      // The durable lease remains recoverable by expiry/reconciliation. Never
      // rewrite an already-settled workflow solely because quota settlement
      // needs retrying.
    }
  }

  async dispatchReadyNodes(runId) {
    const [run] = await this.#sql`
        SELECT id, user_id, status, execution_lease_id
      FROM workflow_runs WHERE id = ${runId}
    `;
    if (!run) throw fail("Workflow run not found", { status: 404, code: "WORKFLOW_NOT_FOUND" });
    if (["cancelled", "failed", "completed"].includes(run.status)) return { queued: 0, status: run.status };

    const ready = await this.#sql`
      SELECT node_key, node_type, depends_on, config
      FROM workflow_nodes node
      WHERE node.run_id = ${runId} AND node.status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM workflow_nodes dependency
          WHERE dependency.run_id = node.run_id
            AND dependency.node_key = ANY(node.depends_on)
            AND dependency.status NOT IN ('completed', 'skipped')
        )
      ORDER BY node.id ASC
    `;
    let queued = 0;
    let skipped = 0;
    for (const node of ready) {
      const skipNode = async (payload) => {
        const [updated] = await this.#sql`
          UPDATE workflow_nodes
          SET status = 'skipped', result_snapshot = ${json(this.#sql, payload)},
              completed_at = NOW(), updated_at = NOW()
          WHERE run_id = ${runId} AND node_key = ${node.node_key} AND status = 'pending'
          RETURNING id
        `;
        if (!updated) return;
        await event(this.#sql, {
          runId,
          nodeKey: node.node_key,
          eventType: "workflow.node.skipped",
          payload,
        });
        skipped += 1;
      };
      if ((node.depends_on || []).length > 0 && !["merge", "join"].includes(node.node_type)) {
        const skippedDependencies = await this.#sql`
          SELECT node_key
          FROM workflow_nodes
          WHERE run_id = ${runId} AND node_key = ANY(${node.depends_on}) AND status = 'skipped'
          ORDER BY id ASC
        `;
        if (skippedDependencies.length > 0) {
          await skipNode({
            kind: "workflow_dependency_skip",
            dependencyNodeKeys: skippedDependencies.map((dependency) => dependency.node_key),
          });
          continue;
        }
      }
      const when = node.config?.when;
      const conditionNodeKey = String(when?.nodeKey || when?.node_key || "").trim();
      const expectedBranch = String(when?.branch || "").trim().toLowerCase();
      if (conditionNodeKey && ["true", "false"].includes(expectedBranch)) {
        const [conditionNode] = await this.#sql`
          SELECT status, result_snapshot
          FROM workflow_nodes
          WHERE run_id = ${runId} AND node_key = ${conditionNodeKey}
          LIMIT 1
        `;
        const actualBranch = String(conditionNode?.result_snapshot?.branch || "").trim().toLowerCase();
        if (conditionNode?.status === "completed" && actualBranch && actualBranch !== expectedBranch) {
          await skipNode({
            kind: "workflow_condition_skip",
            conditionNodeKey,
            expectedBranch,
            actualBranch,
          });
          continue;
        }
      }
      await this.#queue.enqueue({
        queueName: "workflow",
        jobType: WORKFLOW_NODE_JOB,
        userId: run.user_id,
        idempotencyKey: `workflow-node:${runId}:${node.node_key}`,
        payload: { runId: String(runId), nodeKey: node.node_key },
        metadata: { purpose: "workflow_node", nodeType: "workflow" },
        maxAttempts: ["loop.foreach", "loop.repeat_until"].includes(node.node_type)
          ? 500
          : ["image.generate", "media.generate.image", "video.generate", "media.generate.video"].includes(node.node_type)
            ? WORKFLOW_MEDIA_MAX_POLL_ATTEMPTS
            : 25,
      });
      queued += 1;
    }

    if (skipped > 0) return this.dispatchReadyNodes(runId);

    const [counts] = await this.#sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending', 'running', 'waiting_approval', 'paused'))::int AS active,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COUNT(*)::int AS total
      FROM workflow_nodes WHERE run_id = ${runId}
    `;
    if (Number(counts?.total || 0) > 0 && Number(counts.active || 0) === 0 && Number(counts.failed || 0) === 0) {
      const [completedRun] = await this.#sql`
        UPDATE workflow_runs
        SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = ${runId} AND status IN ('queued', 'running', 'paused')
        RETURNING execution_lease_id
      `;
      await this.#settleRunAdmission(completedRun?.execution_lease_id, "completed");
    }
    return { queued, status: run.status };
  }

  async executeJob(job) {
    const jobType = job.jobType || job.job_type;
    const runId = String(job.payload?.runId || job.payload?.run_id || "").trim();
    if (!runId) throw fail("Workflow job has no runId", { code: "INVALID_WORKFLOW_JOB" });
    if (jobType === WORKFLOW_DISPATCH_JOB) {
      const result = await this.dispatchReadyNodes(runId);
      return { runId, ...result };
    }
    if (jobType !== WORKFLOW_NODE_JOB) throw fail(`Unsupported workflow job type: ${jobType}`, { code: "UNSUPPORTED_WORKFLOW_JOB" });
    const nodeKey = String(job.payload?.nodeKey || job.payload?.node_key || "").trim();
    if (!nodeKey) throw fail("Workflow node job has no nodeKey", { code: "INVALID_WORKFLOW_JOB" });
    return this.executeNode({ runId, nodeKey });
  }

  async executeNode({ runId, nodeKey }) {
    const prepared = await this.#sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT node.id, node.run_id, node.node_key, node.node_type, node.depends_on,
               node.config, node.points_estimate, node.points_charged, node.status,
               node.result_snapshot,
               run.user_id, run.status AS run_status, run.canvas_id,
               run.execution_context,
               run.execution_lease_id
        FROM workflow_nodes node
        JOIN workflow_runs run ON run.id = node.run_id
        WHERE node.run_id = ${runId} AND node.node_key = ${nodeKey}
        FOR UPDATE
      `;
      if (!row) throw fail("Workflow node not found", { status: 404, code: "WORKFLOW_NODE_NOT_FOUND" });
      if (["completed", "skipped"].includes(row.status)) return { done: true, row };
      if (row.status === "running") return { inProgress: true, row };
      if (row.status === "waiting_approval") return { deferred: true, row };
      if (["cancelled", "failed"].includes(row.run_status)) return { done: true, row };
      const [blocked] = await tx`
        SELECT node_key
        FROM workflow_nodes
        WHERE run_id = ${runId} AND node_key = ANY(${row.depends_on}) AND status NOT IN ('completed', 'skipped')
        LIMIT 1
      `;
      if (blocked) return { deferred: true, row };
      const dependencyRows = row.depends_on?.length
        ? await tx`
            SELECT node_key, node_type, result_snapshot
            FROM workflow_nodes
            WHERE run_id = ${runId} AND node_key = ANY(${row.depends_on}) AND status = 'completed'
            ORDER BY id ASC
          `
        : [];
      if (APPROVAL_NODE_TYPES.has(row.node_type)) {
        const approvalConfig = interpolateWorkflowValue(row.config || {}, {
          nodes: Object.fromEntries(dependencyRows.map((dependency) => [dependency.node_key, dependency.result_snapshot])),
          inputs: row.execution_context?.inputs || {},
          variables: row.execution_context?.variables || {},
          loop: row.execution_context?.loop || {},
        });
        const approvalRequest = {
          kind: "workflow_approval_request",
          title: String(approvalConfig.title || row.node_key).slice(0, 160),
          message: String(approvalConfig.message || approvalConfig.prompt || "Workflow approval is required").slice(0, 12_000),
          requestedAt: new Date().toISOString(),
        };
        const [waiting] = await tx`
          UPDATE workflow_nodes
          SET status = 'waiting_approval', result_snapshot = ${json(tx, approvalRequest)}, updated_at = NOW(),
              error_code = NULL, error_message = NULL
          WHERE id = ${row.id} AND status IN ('pending', 'paused')
          RETURNING id, run_id, node_key, node_type, status
        `;
        if (!waiting) return { deferred: true, row };
        await tx`
          UPDATE workflow_runs
          SET status = 'paused', updated_at = NOW()
          WHERE id = ${row.run_id} AND status IN ('queued', 'running', 'paused')
        `;
        await event(tx, {
          runId: row.run_id,
          nodeKey: row.node_key,
          eventType: "workflow.node.waiting_approval",
          payload: {
            title: approvalRequest.title,
            message: approvalRequest.message,
          },
        });
        return { waitingApproval: true, row: { ...row, ...waiting } };
      }
      const [running] = await tx`
        UPDATE workflow_nodes
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
            error_code = NULL, error_message = NULL
        WHERE id = ${row.id} AND status IN ('pending', 'paused')
        RETURNING id, run_id, node_key, node_type, depends_on, config,
                  points_estimate, points_charged, status, attempt_count
      `;
      if (!running) return { inProgress: true, row };
      // Ownership and run state come from the locked JOIN above. They are not
      // columns on workflow_nodes and must not be requested in RETURNING.
      return {
        done: false,
        row: {
          ...row,
          ...running,
          inputs: Object.fromEntries(dependencyRows.map((dependency) => [dependency.node_key, dependency.result_snapshot])),
          inputTypes: Object.fromEntries(dependencyRows.map((dependency) => [dependency.node_key, dependency.node_type])),
          executionContext: row.execution_context || {},
        },
      };
    });

    if (prepared.done || prepared.deferred || prepared.inProgress || prepared.waitingApproval) {
      if (prepared.done && prepared.row.status === "completed") await this.dispatchReadyNodes(runId);
      return {
        runId,
        nodeKey,
        status: prepared.waitingApproval
          ? "waiting_approval"
          : prepared.deferred
            ? "deferred"
            : prepared.inProgress
              ? "in_progress"
              : "completed",
      };
    }
    const node = prepared.row;
    const handler = this.#handlers.get(node.node_type);
    if (typeof handler !== "function") {
      await this.#markNodeFailed(node, "WORKFLOW_NODE_HANDLER_UNAVAILABLE", `No handler registered for ${node.node_type}`);
      return { runId, nodeKey, status: "failed" };
    }

    const sourceId = `${runId}:${nodeKey}`;
    const points = Number(node.points_estimate || 0);
    const selfBilled = SELF_BILLED_NODE_TYPES.has(node.node_type);
    const workflowOwnedPoints = selfBilled ? 0 : points;
    let reserved = false;
    let charged = false;
    let completedPersisted = false;
    try {
      if (workflowOwnedPoints > 0) {
        await this.#points.reservePoints({
          userId: node.user_id,
          amount: workflowOwnedPoints,
          sourceType: "workflow_node",
          sourceId,
          idempotencyKey: `reserve:workflow:${sourceId}`,
          note: `预占：工作流节点 ${nodeKey}`,
        });
        reserved = true;
      }

      const result = await handler({
        userId: node.user_id,
        runId,
        nodeKey,
        nodeType: node.node_type,
        config: node.config || {},
        canvasId: node.canvas_id,
        inputs: {
          ...(node.inputs || {}),
        },
        inputTypes: node.inputTypes || {},
        attemptCount: Number(node.attempt_count || 1),
        executionContext: node.executionContext || {},
        checkpoint: node.result_snapshot || null,
      });

      if (workflowOwnedPoints > 0) {
        await this.#points.chargePoints({
          userId: node.user_id,
          amount: workflowOwnedPoints,
          sourceType: "workflow_node",
          sourceId,
          idempotencyKey: `charge:workflow:${sourceId}`,
          note: `结算：工作流节点 ${nodeKey}`,
        });
        charged = true;
      }
      const settledPoints = selfBilled
        ? Math.max(0, Number(result?.pointsCharged ?? result?.points_charged ?? result?.creation?.points_cost ?? 0) || 0)
        : workflowOwnedPoints;
      completedPersisted = await this.#markNodeCompleted(node, result, settledPoints);
      if (!completedPersisted?.persisted) {
        throw fail("Workflow node billing/result settlement is pending reconciliation", {
          status: 503,
          code: "WORKFLOW_NODE_SETTLEMENT_PENDING",
        });
      }
      if (completedPersisted.runCompleted) {
        await this.#settleRunAdmission(completedPersisted.executionLeaseId, "completed");
      } else {
        // Dispatch the next ready set through the durable queue. The current
        // node job can finish before another worker evaluates dependencies;
        // this also keeps the node execution seam small and idempotent.
        await this.#ensureDispatch(runId, node.user_id, {
          trigger: `node-completed:${node.node_key}:${node.attempt_count}`,
        });
      }
      return { runId, nodeKey, status: "completed", result };
    } catch (error) {
      if (reserved && !charged) {
        await this.#points.releasePoints({
          userId: node.user_id,
          amount: workflowOwnedPoints,
          sourceType: "workflow_node",
          sourceId,
          idempotencyKey: `release:workflow:${sourceId}:${node.attempt_count}`,
          note: `返还：工作流节点 ${nodeKey} 失败`,
        }).catch(() => {});
      }
      if (isInsufficientPoints(error)) {
        await this.#markNodePaused(node, error);
        return {
          runId,
          nodeKey,
          status: "paused",
          availablePoints: error.available_points,
          requiredPoints: error.required_points,
        };
      }
      if (["REFERENCE_IMAGE_REQUIRED", "INVALID_WORKFLOW_REFERENCE_IMAGES", "WORKFLOW_REFERENCE_IMAGES_UNSUPPORTED"].includes(error?.code)) {
        error.terminalWorkflowNode = true;
      }
      if (error?.terminalWorkflowNode === true) {
        await this.#markNodeFailed(node, error.code || "WORKFLOW_NODE_FAILED", String(error.message || error));
        return { runId, nodeKey, status: "failed", errorCode: error.code || "WORKFLOW_NODE_FAILED" };
      }
      if (!charged && !completedPersisted) await this.#markNodePending(node, error);
      throw error;
    }
  }

  async #markNodeCompleted(node, result, points) {
    return this.#sql.begin(async (tx) => {
      const [updated] = await tx`
        UPDATE workflow_nodes
        SET status = 'completed', result_snapshot = ${json(tx, result ?? null)},
            points_charged = ${points}, completed_at = NOW(), updated_at = NOW(),
            error_code = NULL, error_message = NULL
        WHERE id = ${node.id} AND status = 'running'
        RETURNING id
      `;
      if (!updated) return { persisted: false };
      await tx`
        UPDATE workflow_runs
        SET points_charged = points_charged + ${points}, updated_at = NOW()
        WHERE id = ${node.run_id}
      `;
      const [counts] = await tx`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('pending', 'running', 'waiting_approval', 'paused'))::int AS active,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
          COUNT(*)::int AS total
        FROM workflow_nodes
        WHERE run_id = ${node.run_id}
      `;
      let executionLeaseId = null;
      const runCompleted = Number(counts?.total || 0) > 0
        && Number(counts?.active || 0) === 0
        && Number(counts?.failed || 0) === 0;
      if (runCompleted) {
        const [completedRun] = await tx`
          UPDATE workflow_runs
          SET status = 'completed', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
          WHERE id = ${node.run_id} AND status IN ('queued', 'running', 'paused')
          RETURNING execution_lease_id
        `;
        executionLeaseId = completedRun?.execution_lease_id || null;
      }
      await event(tx, { runId: node.run_id, nodeKey: node.node_key, eventType: "workflow.node.completed", payload: { points } });
      return { persisted: true, runCompleted, executionLeaseId };
    });
  }

  async #markNodePaused(node, error) {
    await this.#sql`
      UPDATE workflow_nodes
      SET status = 'paused', error_code = ${error.code || "INSUFFICIENT_POINTS"},
          error_message = ${String(error.message || error).slice(0, 2000)}, updated_at = NOW()
      WHERE id = ${node.id} AND status = 'running'
    `;
    await this.#sql`
      UPDATE workflow_runs SET status = 'paused', updated_at = NOW()
      WHERE id = ${node.run_id} AND status IN ('queued', 'running')
    `;
    await event(this.#sql, { runId: node.run_id, nodeKey: node.node_key, eventType: "workflow.node.paused", payload: { code: error.code } });
  }

  async #markNodePending(node, error) {
    const checkpoint = error?.creationId
      ? {
          kind: "workflow_external_task",
          creationId: String(error.creationId),
          status: "pending",
          errorCode: String(error.code || "WORKFLOW_NODE_EXTERNAL_PENDING").slice(0, 120),
          updatedAt: new Date().toISOString(),
        }
      : node.result_snapshot || null;
    await this.#sql`
      UPDATE workflow_nodes
      SET status = 'pending', error_code = ${error.code || "WORKFLOW_NODE_FAILED"},
          error_message = ${String(error.message || error).slice(0, 2000)},
          result_snapshot = ${json(this.#sql, checkpoint)}, updated_at = NOW()
      WHERE id = ${node.id} AND status = 'running'
    `;
  }

  async #markNodeFailed(node, code, message) {
    await this.#sql`
      UPDATE workflow_nodes
      SET status = 'failed', error_code = ${code}, error_message = ${message.slice(0, 2000)}, updated_at = NOW()
      WHERE id = ${node.id} AND status = 'running'
    `;
    const [failedRun] = await this.#sql`
      UPDATE workflow_runs
      SET status = 'failed', error_code = ${code}, error_message = ${message.slice(0, 2000)}, failed_at = NOW(), updated_at = NOW()
      WHERE id = ${node.run_id} AND status NOT IN ('completed', 'cancelled')
      RETURNING execution_lease_id
    `;
    await this.#settleRunAdmission(failedRun?.execution_lease_id || node.execution_lease_id, "failed", message);
    await event(this.#sql, { runId: node.run_id, nodeKey: node.node_key, eventType: "workflow.node.failed", payload: { code } });
  }

  async getRun({ userId, runId }) {
    const [run] = await this.#sql`
      SELECT id, user_id, canvas_id, title, status, estimated_points, points_charged,
             workflow_id, workflow_version, parent_run_id,
             error_code, error_message, created_at, updated_at, started_at,
             completed_at, failed_at, cancelled_at
      FROM workflow_runs WHERE id = ${runId} AND user_id = ${userId}
    `;
    if (!run) throw fail("Workflow run not found", { status: 404, code: "WORKFLOW_NOT_FOUND" });
    const nodes = await this.#sql`
      SELECT node_key, node_type, depends_on, status, points_estimate, points_charged,
             attempt_count, result_snapshot, error_code, error_message, started_at, completed_at
      FROM workflow_nodes WHERE run_id = ${runId} ORDER BY id ASC
    `;
    return { run: mapRun(run), nodes: nodes.map(mapNode) };
  }

  async events({ userId, runId, afterId = 0, limit = 100 }) {
    const safeAfter = Number.isSafeInteger(Number(afterId)) && Number(afterId) >= 0 ? Number(afterId) : 0;
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 100));
    const [owned] = await this.#sql`
      SELECT id FROM workflow_runs WHERE id = ${runId} AND user_id = ${userId}
    `;
    if (!owned) throw fail("Workflow run not found", { status: 404, code: "WORKFLOW_NOT_FOUND" });
    return this.#sql`
      SELECT id, node_key, event_type, payload, created_at
      FROM workflow_events
      WHERE run_id = ${runId} AND id > ${safeAfter}
      ORDER BY id ASC LIMIT ${safeLimit}
    `;
  }

  async approveNode({ userId, runId, nodeKey } = {}) {
    const normalizedNodeKey = String(nodeKey || "").trim();
    if (!normalizedNodeKey) throw fail("Workflow nodeKey is required", { status: 400, code: "WORKFLOW_NODE_KEY_REQUIRED" });
    const approvedAt = new Date().toISOString();
    const result = await this.#sql.begin(async (tx) => {
      const [node] = await tx`
        SELECT node.id, node.run_id, node.node_key, node.node_type, node.status,
               node.result_snapshot, run.user_id, run.status AS run_status
        FROM workflow_nodes node
        JOIN workflow_runs run ON run.id = node.run_id
        WHERE node.run_id = ${runId} AND node.node_key = ${normalizedNodeKey}
          AND run.user_id = ${userId}
        FOR UPDATE OF node, run
      `;
      if (!node) throw fail("Workflow approval node not found", { status: 404, code: "WORKFLOW_APPROVAL_NOT_FOUND" });
      if (!APPROVAL_NODE_TYPES.has(node.node_type)) {
        throw fail("Workflow node does not accept approval", { status: 422, code: "WORKFLOW_NODE_NOT_APPROVABLE" });
      }
      if (node.status === "completed" && node.result_snapshot?.kind === "workflow_approval") {
        return { replayed: true, node, result: node.result_snapshot };
      }
      if (node.status !== "waiting_approval") {
        throw fail("Workflow node is not waiting for approval", { status: 409, code: "WORKFLOW_APPROVAL_STATE_CONFLICT" });
      }

      const approvalResult = {
        kind: "workflow_approval",
        approved: true,
        approvedBy: String(userId),
        approvedAt,
      };
      const [approved] = await tx`
        UPDATE workflow_nodes
        SET status = 'completed', result_snapshot = ${json(tx, approvalResult)},
            completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL
        WHERE id = ${node.id} AND status = 'waiting_approval'
        RETURNING id, run_id, node_key, node_type, status, result_snapshot, completed_at
      `;
      if (!approved) throw fail("Workflow approval state changed", { status: 409, code: "WORKFLOW_APPROVAL_STATE_CONFLICT" });
      const [waiting] = await tx`
        SELECT COUNT(*)::int AS remaining
        FROM workflow_nodes
        WHERE run_id = ${node.run_id} AND status = 'waiting_approval'
      `;
      await tx`
        UPDATE workflow_runs
        SET status = ${Number(waiting?.remaining || 0) > 0 ? "paused" : "running"}, updated_at = NOW()
        WHERE id = ${node.run_id} AND status = 'paused'
      `;
      await event(tx, {
        runId: node.run_id,
        nodeKey: node.node_key,
        eventType: "workflow.node.approved",
        payload: { approvedBy: String(userId), approvedAt },
      });
      return { replayed: false, node: approved, result: approvalResult };
    });
    await this.#ensureDispatch(runId, userId, {
      trigger: `node-approved:${normalizedNodeKey}:${result.result?.approvedAt || "completed"}`,
    });
    return {
      runId: String(runId),
      nodeKey: normalizedNodeKey,
      status: "completed",
      approved: true,
      approvedAt: result.result?.approvedAt || approvedAt,
      idempotentReplay: result.replayed,
    };
  }

  async retryNode({ userId, runId, nodeKey } = {}) {
    const normalizedNodeKey = String(nodeKey || "").trim();
    if (!normalizedNodeKey) throw fail("Workflow nodeKey is required", { status: 400, code: "WORKFLOW_NODE_KEY_REQUIRED" });
    const result = await this.#sql.begin(async (tx) => {
      const [node] = await tx`
        SELECT node.id, node.run_id, node.node_key, node.status, node.attempt_count,
               run.user_id, run.status AS run_status
        FROM workflow_nodes node
        JOIN workflow_runs run ON run.id = node.run_id
        WHERE node.run_id = ${runId} AND node.node_key = ${normalizedNodeKey}
          AND run.user_id = ${userId}
        FOR UPDATE OF node, run
      `;
      if (!node) throw fail("Workflow node not found", { status: 404, code: "WORKFLOW_NODE_NOT_FOUND" });
      if (!["failed", "paused"].includes(node.status)) {
        throw fail("Only failed or interrupted workflow nodes can be retried", { status: 409, code: "WORKFLOW_NODE_RETRY_STATE_CONFLICT" });
      }
      await tx`
        UPDATE workflow_nodes
        SET status = 'pending', error_code = NULL, error_message = NULL, updated_at = NOW()
        WHERE id = ${node.id}
      `;
      await tx`
        UPDATE workflow_runs
        SET status = 'running', error_code = NULL, error_message = NULL,
            failed_at = NULL, updated_at = NOW()
        WHERE id = ${runId} AND status IN ('failed', 'paused', 'running')
      `;
      await event(tx, {
        runId,
        nodeKey: normalizedNodeKey,
        eventType: "workflow.node.retry_requested",
        payload: { previousStatus: node.status, attemptCount: Number(node.attempt_count || 0) },
      });
      return node;
    });
    await this.#queue.enqueue({
      queueName: "workflow",
      jobType: WORKFLOW_DISPATCH_JOB,
      userId,
      idempotencyKey: `workflow-dispatch:${runId}:retry:${normalizedNodeKey}:${Number(result.attempt_count || 0) + 1}`.slice(0, 128),
      payload: { runId: String(runId) },
      metadata: { purpose: "workflow_retry", nodeKey: normalizedNodeKey },
      maxAttempts: 10,
    });
    return this.getRun({ userId, runId });
  }

  async cancel({ userId, runId, reason = "Cancelled by user" }) {
    const result = await this.#sql.begin(async (tx) => {
      const [run] = await tx`
        SELECT id, user_id, status, execution_lease_id FROM workflow_runs
        WHERE id = ${runId} AND user_id = ${userId} FOR UPDATE
      `;
      if (!run) throw fail("Workflow run not found", { status: 404, code: "WORKFLOW_NOT_FOUND" });
      if (["completed", "failed", "cancelled"].includes(run.status)) return run;
      await tx`
        UPDATE workflow_runs
        SET status = 'cancelled', error_code = 'WORKFLOW_CANCELLED',
            error_message = ${String(reason || "Cancelled by user").slice(0, 500)},
            cancelled_at = NOW(), updated_at = NOW()
        WHERE id = ${runId}
      `;
      await tx`
        UPDATE workflow_nodes SET status = 'skipped', updated_at = NOW()
        WHERE run_id = ${runId} AND status IN ('pending', 'paused', 'waiting_approval')
      `;
      await event(tx, { runId, eventType: "workflow.cancelled", payload: { reason } });
      return { ...run, status: "cancelled" };
    });
    await this.#settleRunAdmission(result.execution_lease_id, "cancelled", reason);
    return mapRun(result);
  }
}

export const WORKFLOW_JOB_TYPES = Object.freeze({ WORKFLOW_DISPATCH_JOB, WORKFLOW_NODE_JOB });
