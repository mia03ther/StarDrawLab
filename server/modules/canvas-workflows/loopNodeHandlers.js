import {
  evaluateWorkflowCondition,
  interpolateWorkflowValue,
  resolveWorkflowExpression,
} from "./expression.js";
import { MAX_LOOP_CONCURRENCY, MAX_LOOP_ITERATIONS } from "./definitionService.js";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const pending = (message = "Workflow loop is waiting for child runs") => Object.assign(new Error(message), {
  status: 503,
  code: "WORKFLOW_LOOP_PENDING",
  retryAfterMs: 2_000,
});

const terminal = (message, code = "WORKFLOW_LOOP_CHILD_FAILED") => Object.assign(new Error(message), {
  status: 422,
  code,
  terminalWorkflowNode: true,
});

const runtimeContext = ({ inputs = {}, executionContext = {} } = {}) => ({
  nodes: inputs,
  inputs: object(executionContext.inputs),
  variables: object(executionContext.variables),
  loop: object(executionContext.loop),
});

export const prepareWorkflowLoopConfig = (rawConfig, context) => {
  const source = object(rawConfig);
  const { body, ...controlConfig } = source;
  return {
    ...interpolateWorkflowValue(controlConfig, context),
    body: object(body),
  };
};

const childSnapshot = (detail) => ({
  run: detail.run,
  nodes: Object.fromEntries((detail.nodes || []).map((node) => [node.nodeKey, {
    status: node.status,
    result: node.result,
    errorCode: node.errorCode,
  }])),
});

const iterationRows = async (db, runId, nodeKey) => db`
  SELECT iteration.id, iteration.iteration_index, iteration.item_snapshot,
         iteration.status, iteration.child_run_id,
         child.status AS child_status, child.points_charged
  FROM workflow_loop_iterations iteration
  LEFT JOIN workflow_runs child ON child.id = iteration.child_run_id
  WHERE iteration.parent_run_id = ${runId} AND iteration.parent_node_key = ${nodeKey}
  ORDER BY iteration.iteration_index ASC
`;

const initializeIterations = async ({ db, runId, nodeKey, items }) => {
  await db.begin(async (tx) => {
    for (let index = 0; index < items.length; index += 1) {
      await tx`
        INSERT INTO workflow_loop_iterations
          (parent_run_id, parent_node_key, iteration_index, item_snapshot)
        VALUES (${runId}, ${nodeKey}, ${index}, ${tx.json(items[index])})
        ON CONFLICT (parent_run_id, parent_node_key, iteration_index) DO NOTHING
      `;
    }
  });
};

const startChild = async ({ db, workflowRuntime, runtime, config, iteration, previousResult = null }) => {
  const childContext = {
    inputs: object(runtime.executionContext?.inputs),
    variables: object(runtime.executionContext?.variables),
    textModel: runtime.executionContext?.textModel || config.model || null,
    loop: {
      item: iteration.item_snapshot,
      index: Number(iteration.iteration_index),
      previousResult,
    },
  };
  const idempotencyKey = `workflow-loop:${runtime.runId}:${runtime.nodeKey}:${iteration.iteration_index}`;
  const started = await workflowRuntime.start({
    userId: runtime.userId,
    canvasId: runtime.canvasId,
    title: `${String(config.title || runtime.nodeKey).slice(0, 100)} #${Number(iteration.iteration_index) + 1}`,
    definition: config.body,
    idempotencyKey: idempotencyKey.slice(0, 128),
    executionContext: childContext,
    parentRunId: runtime.runId,
  });
  await db`
    UPDATE workflow_loop_iterations
    SET child_run_id = ${started.run.id}, status = 'running', updated_at = NOW()
    WHERE id = ${iteration.id} AND child_run_id IS NULL
  `;
};

const synchronizeIterations = async ({ db, rows }) => {
  for (const row of rows) {
    if (!row.child_run_id) continue;
    const next = row.child_status === "completed"
      ? "completed"
      : ["failed", "cancelled"].includes(row.child_status)
        ? "failed"
        : "running";
    if (next !== row.status) {
      await db`UPDATE workflow_loop_iterations SET status = ${next}, updated_at = NOW() WHERE id = ${row.id}`;
    }
  }
};

const collectCompleted = async ({ workflowRuntime, userId, rows }) => Promise.all(rows.map(async (row) => (
  childSnapshot(await workflowRuntime.getRun({ userId, runId: row.child_run_id }))
)));

export const createWorkflowLoopNodeHandlers = ({ sqlClient, workflowRuntimeFactory }) => {
  const foreach = async (runtime) => {
    const config = prepareWorkflowLoopConfig(runtime.config, runtimeContext(runtime));
    const expression = config.itemsExpression || config.items_expression;
    const resolved = resolveWorkflowExpression(expression, runtimeContext(runtime));
    const sourceItems = Array.isArray(resolved) ? resolved : Array.isArray(config.items) ? config.items : [];
    const limit = Math.min(MAX_LOOP_ITERATIONS, Math.max(1, Number(config.maxIterations || 20) || 20));
    const items = sourceItems.slice(0, limit);
    if (items.length === 0) return { kind: "workflow_foreach", items: [], results: [], iterations: 0, pointsCharged: 0 };
    await initializeIterations({ db: sqlClient, runId: runtime.runId, nodeKey: runtime.nodeKey, items });

    const workflowRuntime = workflowRuntimeFactory();
    let rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    await synchronizeIterations({ db: sqlClient, rows });
    rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    const failed = rows.find((row) => row.status === "failed");
    if (failed) throw terminal(`Loop iteration ${Number(failed.iteration_index) + 1} failed`);

    const concurrency = Math.min(MAX_LOOP_CONCURRENCY, Math.max(1, Number(config.concurrency || 1) || 1));
    const activeCount = rows.filter((row) => row.status === "running").length;
    const startable = rows.filter((row) => row.status === "pending" && !row.child_run_id).slice(0, Math.max(0, concurrency - activeCount));
    for (const iteration of startable) {
      await startChild({ db: sqlClient, workflowRuntime, runtime, config, iteration });
    }

    rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    if (!rows.every((row) => row.child_status === "completed")) throw pending();
    const results = await collectCompleted({ workflowRuntime, userId: runtime.userId, rows });
    return {
      kind: "workflow_foreach",
      items,
      results,
      iterations: rows.length,
      pointsCharged: rows.reduce((sum, row) => sum + Number(row.points_charged || 0), 0),
    };
  };

  const repeatUntil = async (runtime) => {
    const config = prepareWorkflowLoopConfig(runtime.config, runtimeContext(runtime));
    const maxIterations = Math.min(MAX_LOOP_ITERATIONS, Math.max(1, Number(config.maxIterations || 20) || 20));
    const workflowRuntime = workflowRuntimeFactory();
    let rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    await synchronizeIterations({ db: sqlClient, rows });
    rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    const failed = rows.find((row) => row.status === "failed");
    if (failed) throw terminal(`Repeat iteration ${Number(failed.iteration_index) + 1} failed`);

    const completedRows = rows.filter((row) => row.child_status === "completed");
    const snapshots = await collectCompleted({ workflowRuntime, userId: runtime.userId, rows: completedRows });
    const latest = snapshots.at(-1) || null;
    if (latest) {
      const condition = object(config.until);
      const context = {
        ...runtimeContext(runtime),
        loop: { ...(runtimeContext(runtime).loop || {}), result: latest, iteration: completedRows.length - 1 },
      };
      const left = resolveWorkflowExpression(condition.left, context) ?? condition.left;
      const right = resolveWorkflowExpression(condition.right, context) ?? condition.right;
      const evaluated = evaluateWorkflowCondition({ left, operator: condition.operator, right });
      if (evaluated.matched) {
        return {
          kind: "workflow_repeat_until",
          results: snapshots,
          iterations: completedRows.length,
          matched: true,
          pointsCharged: completedRows.reduce((sum, row) => sum + Number(row.points_charged || 0), 0),
        };
      }
    }
    if (completedRows.length >= maxIterations) {
      return {
        kind: "workflow_repeat_until",
        results: snapshots,
        iterations: completedRows.length,
        matched: false,
        pointsCharged: completedRows.reduce((sum, row) => sum + Number(row.points_charged || 0), 0),
      };
    }
    const running = rows.find((row) => row.status === "running");
    if (running) throw pending();
    const nextIndex = completedRows.length;
    await initializeIterations({
      db: sqlClient,
      runId: runtime.runId,
      nodeKey: runtime.nodeKey,
      items: Array.from({ length: nextIndex + 1 }, (_, index) => ({ iteration: index })),
    });
    rows = await iterationRows(sqlClient, runtime.runId, runtime.nodeKey);
    const next = rows.find((row) => Number(row.iteration_index) === nextIndex);
    await startChild({ db: sqlClient, workflowRuntime, runtime, config, iteration: next, previousResult: latest });
    throw pending();
  };

  return new Map([
    ["loop.foreach", foreach],
    ["loop.repeat_until", repeatUntil],
  ]);
};
