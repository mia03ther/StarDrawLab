import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "workflow-execution-test:db" };
    if (specifier === "./pointsService.js") return { shortCircuit: true, url: "workflow-execution-test:points" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "workflow-execution-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default Object.assign(function sql() { throw new Error('database access forbidden'); }, { begin() { throw new Error('database access forbidden'); } });",
      };
    }
    if (url === "workflow-execution-test:points") {
      return {
        format: "module",
        shortCircuit: true,
        source: [
          "export const getAccountInfo = async () => ({ available_points: 0 });",
          "export const reservePoints = async () => {};",
          "export const chargePoints = async () => {};",
          "export const releasePoints = async () => {};",
        ].join("\n"),
      };
    }
    return nextLoad(url, context);
  },
});

const { WorkflowExecutionService } = await import("../services/workflowExecutionService.js");

const compactSql = (strings) => strings.join("?").replace(/\s+/g, " ").trim();

const createWorkflowSql = ({
  pointsEstimate = 3,
  nodeType = "image.generate",
  dependsOn = [],
  dependencyRows = [],
  config = { prompt: "sunrise" },
  remainingActive = 0,
} = {}) => {
  const state = {
    nodeStatus: "pending",
    runStatus: "running",
    pointsCharged: 0,
    resultSnapshot: null,
    events: [],
    runningUpdateSql: "",
  };

  const sql = async (strings, ...values) => {
    const query = compactSql(strings);

    if (query.includes("FROM workflow_nodes node JOIN workflow_runs run")) {
      return [{
        id: 11,
        run_id: 7,
        node_key: "generate",
        node_type: nodeType,
        depends_on: dependsOn,
        config,
        points_estimate: pointsEstimate,
        points_charged: 0,
        status: state.nodeStatus,
        result_snapshot: state.resultSnapshot,
        attempt_count: 0,
        user_id: "user-1",
        run_status: state.runStatus,
        canvas_id: "canvas-1",
      }];
    }
    if (query.startsWith("SELECT node_key FROM workflow_nodes WHERE run_id")) return [];
    if (query.startsWith("SELECT node_key, node_type, result_snapshot FROM workflow_nodes")) return dependencyRows;
    if (query.startsWith("UPDATE workflow_nodes SET status = 'waiting_approval'")) {
      state.nodeStatus = "waiting_approval";
      state.resultSnapshot = JSON.parse(values[0]);
      return [{ id: 11, run_id: 7, node_key: "generate", node_type: nodeType, status: "waiting_approval" }];
    }
    if (query.startsWith("UPDATE workflow_runs SET status = 'paused'")) {
      state.runStatus = "paused";
      return [];
    }
    if (query.startsWith("UPDATE workflow_nodes SET status = 'running'")) {
      state.runningUpdateSql = query;
      state.nodeStatus = "running";
      return [{
        id: 11,
        run_id: 7,
        node_key: "generate",
        node_type: nodeType,
        depends_on: dependsOn,
        config: { prompt: "sunrise" },
        points_estimate: pointsEstimate,
        points_charged: 0,
        status: "running",
        attempt_count: 1,
      }];
    }
    if (query.startsWith("UPDATE workflow_nodes SET status = 'completed'")) {
      if (query.includes("status = 'waiting_approval'")) {
        const result = JSON.parse(values[0]);
        state.nodeStatus = "completed";
        return [{
          id: 11,
          run_id: 7,
          node_key: "generate",
          node_type: nodeType,
          status: "completed",
          result_snapshot: result,
          completed_at: result.approvedAt,
        }];
      }
      state.nodeStatus = "completed";
      state.pointsCharged = Number(values[1]);
      state.resultSnapshot = JSON.parse(values[0]);
      return [{ id: 11 }];
    }
    if (query.startsWith("UPDATE workflow_nodes SET status = 'pending'")) {
      state.nodeStatus = "pending";
      state.resultSnapshot = values[2] ? JSON.parse(values[2]) : null;
      return [];
    }
    if (query.startsWith("UPDATE workflow_runs SET points_charged = points_charged")) return [];
    if (query.startsWith("INSERT INTO workflow_events")) {
      state.events.push({
        runId: values[0],
        nodeKey: values[1],
        eventType: values[2],
        payload: JSON.parse(values[3]),
      });
      return [];
    }
    if (query.startsWith("SELECT id, user_id, status, execution_lease_id FROM workflow_runs")) {
      return [{ id: 7, user_id: "user-1", status: state.runStatus }];
    }
    if (query.startsWith("SELECT COUNT(*)::int AS remaining FROM workflow_nodes")) return [{ remaining: 0 }];
    if (query.startsWith("UPDATE workflow_runs SET status = ?")) {
      state.runStatus = values[0];
      return [];
    }
    if (query.startsWith("UPDATE workflow_runs SET status = CASE")) return [];
    if (query.startsWith("SELECT node_key FROM workflow_nodes node")) return [];
    if (query.startsWith("SELECT COUNT(*) FILTER")) {
      return [{ active: remainingActive, completed: 1, failed: 0, total: 1 + remainingActive }];
    }
    if (query.startsWith("UPDATE workflow_runs SET status = 'completed'")) {
      state.runStatus = "completed";
      return [];
    }
    throw new Error(`Unexpected test query: ${query}`);
  };
  sql.begin = async (operation) => operation(sql);
  return { sql, state };
};

test("workflow node execution keeps run ownership context and persists successful settlement", async () => {
  const { sql, state } = createWorkflowSql({ nodeType: "custom.billable" });
  const pointCalls = [];
  const queue = { enqueue: async () => ({}) };
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue,
    pointsAdapter: {
      reservePoints: async (input) => pointCalls.push(["reserve", input]),
      chargePoints: async (input) => pointCalls.push(["charge", input]),
      releasePoints: async (input) => pointCalls.push(["release", input]),
    },
    handlers: new Map([["custom.billable", async (input) => {
      assert.equal(input.userId, "user-1");
      assert.equal(input.canvasId, "canvas-1");
      return { outputRef: "oss://private/generated.png" };
    }]]),
  });

  const result = await service.executeNode({ runId: "7", nodeKey: "generate" });

  assert.equal(result.status, "completed");
  assert.equal(state.nodeStatus, "completed");
  assert.equal(state.runStatus, "completed");
  assert.equal(state.pointsCharged, 3);
  assert.deepEqual(pointCalls.map(([operation]) => operation), ["reserve", "charge"]);
  assert.equal(pointCalls[0][1].userId, "user-1");
  assert.equal(pointCalls[1][1].userId, "user-1");
  assert.equal(state.events.at(-1).eventType, "workflow.node.completed");
  assert.doesNotMatch(state.runningUpdateSql, /\buser_id\b|\brun_status\b|\bcanvas_id\b/);
});

test("zero-cost workflow orchestration leaves one charge to the downstream billing owner", async () => {
  const { sql, state } = createWorkflowSql({ pointsEstimate: 0 });
  const workflowPointCalls = [];
  let downstreamCharges = 0;
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async () => ({}) },
    pointsAdapter: {
      reservePoints: async (input) => workflowPointCalls.push(["reserve", input]),
      chargePoints: async (input) => workflowPointCalls.push(["charge", input]),
      releasePoints: async (input) => workflowPointCalls.push(["release", input]),
    },
    handlers: new Map([["image.generate", async () => {
      downstreamCharges += 1;
      return { kind: "completed", pointsCharged: 7 };
    }]]),
  });

  const result = await service.executeNode({ runId: "7", nodeKey: "generate" });

  assert.equal(result.status, "completed");
  assert.equal(downstreamCharges, 1);
  assert.deepEqual(workflowPointCalls, []);
  assert.equal(state.pointsCharged, 7);
});

test("workflow handlers receive completed dependency snapshots as trusted inputs", async () => {
  const { sql } = createWorkflowSql({
    pointsEstimate: 0,
    nodeType: "noop",
    dependsOn: ["source"],
    dependencyRows: [{
      node_key: "source",
      node_type: "input",
      result_snapshot: { value: { prompt: "cinematic sunrise" } },
    }],
  });
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async () => ({}) },
    handlers: new Map([["noop", async (input) => {
      assert.deepEqual(input.inputs, { source: { value: { prompt: "cinematic sunrise" } } });
      assert.deepEqual(input.inputTypes, { source: "input" });
      return { ok: true };
    }]]),
  });

  const result = await service.executeNode({ runId: "7", nodeKey: "generate" });

  assert.equal(result.status, "completed");
});

test("a completed node schedules a distinct durable dispatch wave for downstream nodes", async () => {
  const { sql } = createWorkflowSql({
    pointsEstimate: 0,
    nodeType: "noop",
    remainingActive: 1,
  });
  const queued = [];
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async (job) => { queued.push(job); return job; } },
    handlers: new Map([["noop", async () => ({ ok: true })]]),
  });

  const result = await service.executeNode({ runId: "7", nodeKey: "generate" });

  assert.equal(result.status, "completed");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].jobType, "workflow.dispatch");
  assert.match(queued[0].idempotencyKey, /^workflow-dispatch:7:[0-9a-f]{32}$/);
  assert.notEqual(queued[0].idempotencyKey, "workflow-dispatch:7");
  assert.equal(queued[0].metadata.dispatchTrigger, "node-completed:generate:1");
});

test("external media checkpoints survive a worker retry and are passed back to the handler", async () => {
  const { sql, state } = createWorkflowSql({ pointsEstimate: 0, nodeType: "video.generate" });
  const checkpoints = [];
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async () => ({}) },
    handlers: new Map([["video.generate", async ({ checkpoint }) => {
      checkpoints.push(checkpoint);
      if (!checkpoint) {
        throw Object.assign(new Error("provider task is still running"), {
          code: "WORKFLOW_NODE_EXTERNAL_PENDING",
          creationId: "creation-existing",
        });
      }
      return { creationId: checkpoint.creationId, status: "completed", pointsCharged: 12 };
    }]]),
  });

  await assert.rejects(
    service.executeNode({ runId: "7", nodeKey: "generate" }),
    (error) => error.code === "WORKFLOW_NODE_EXTERNAL_PENDING",
  );
  assert.equal(state.nodeStatus, "pending");
  assert.equal(state.resultSnapshot.creationId, "creation-existing");

  const completed = await service.executeNode({ runId: "7", nodeKey: "generate" });
  assert.equal(completed.status, "completed");
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[1].creationId, "creation-existing");
});

test("condition skips propagate through a branch while merge nodes remain runnable", async () => {
  const statuses = new Map([
    ["condition", "completed"],
    ["true-image", "completed"],
    ["false-video", "pending"],
    ["false-caption", "pending"],
    ["merge", "pending"],
    ["publish", "pending"],
  ]);
  const nodes = [
    { id: 1, node_key: "condition", node_type: "condition.rule", depends_on: [], config: {}, result_snapshot: { branch: "true" } },
    { id: 2, node_key: "true-image", node_type: "image.generate", depends_on: ["condition"], config: { when: { nodeKey: "condition", branch: "true" } } },
    { id: 3, node_key: "false-video", node_type: "video.generate", depends_on: ["condition"], config: { when: { nodeKey: "condition", branch: "false" } } },
    { id: 4, node_key: "false-caption", node_type: "agent.call", depends_on: ["false-video"], config: {} },
    { id: 5, node_key: "merge", node_type: "merge", depends_on: ["true-image", "false-caption"], config: {} },
    { id: 6, node_key: "publish", node_type: "agent.call", depends_on: ["merge"], config: {} },
  ];
  const events = [];
  const queued = [];
  const sql = async (strings, ...values) => {
    const query = compactSql(strings);
    if (query.startsWith("SELECT id, user_id, status, execution_lease_id FROM workflow_runs")) {
      return [{ id: 7, user_id: "user-1", status: "running", execution_lease_id: null }];
    }
    if (query.startsWith("SELECT node_key, node_type, depends_on, config FROM workflow_nodes node")) {
      return nodes
        .filter((node) => statuses.get(node.node_key) === "pending")
        .filter((node) => node.depends_on.every((key) => ["completed", "skipped"].includes(statuses.get(key))))
        .map(({ node_key, node_type, depends_on, config }) => ({ node_key, node_type, depends_on, config }));
    }
    if (query.startsWith("SELECT node_key FROM workflow_nodes WHERE run_id")) {
      const dependencyKeys = values[1] || [];
      return nodes
        .filter((node) => dependencyKeys.includes(node.node_key) && statuses.get(node.node_key) === "skipped")
        .map((node) => ({ node_key: node.node_key }));
    }
    if (query.startsWith("SELECT status, result_snapshot FROM workflow_nodes")) {
      const node = nodes.find((candidate) => candidate.node_key === values[1]);
      return node ? [{ status: statuses.get(node.node_key), result_snapshot: node.result_snapshot }] : [];
    }
    if (query.startsWith("UPDATE workflow_nodes SET status = 'skipped'")) {
      const nodeKey = values[2];
      if (statuses.get(nodeKey) !== "pending") return [];
      statuses.set(nodeKey, "skipped");
      return [{ id: nodes.find((node) => node.node_key === nodeKey).id }];
    }
    if (query.startsWith("INSERT INTO workflow_events")) {
      events.push({ nodeKey: values[1], type: values[2] });
      return [];
    }
    if (query.startsWith("SELECT COUNT(*) FILTER")) {
      return [{
        active: [...statuses.values()].filter((status) => ["pending", "running", "waiting_approval", "paused"].includes(status)).length,
        completed: [...statuses.values()].filter((status) => status === "completed").length,
        failed: 0,
        total: statuses.size,
      }];
    }
    throw new Error(`Unexpected test query: ${query}`);
  };
  sql.begin = async (operation) => operation(sql);
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async (job) => { queued.push(job); return {}; } },
  });

  await service.dispatchReadyNodes("7");

  assert.equal(statuses.get("false-video"), "skipped");
  assert.equal(statuses.get("false-caption"), "skipped");
  assert.deepEqual(events.map((item) => item.nodeKey), ["false-video", "false-caption"]);
  assert.deepEqual(queued.map((job) => job.payload.nodeKey), ["merge"]);
});

test("approval workflow nodes pause durably and resume only after the owner confirms", async () => {
  const { sql, state } = createWorkflowSql({
    pointsEstimate: 0,
    nodeType: "approval.wait",
    dependsOn: ["write_prompt"],
    dependencyRows: [{
      node_key: "write_prompt",
      node_type: "agent.call",
      result_snapshot: { content: "最终视频提示词" },
    }],
    config: {
      title: "确认视频提示词",
      message: "请确认：${nodes.write_prompt.content}",
    },
  });
  const queued = [];
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async (input) => { queued.push(input); return {}; } },
  });

  const waiting = await service.executeNode({ runId: "7", nodeKey: "generate" });
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(state.nodeStatus, "waiting_approval");
  assert.equal(state.runStatus, "paused");
  assert.equal(state.events.at(-1).eventType, "workflow.node.waiting_approval");
  assert.equal(state.resultSnapshot.kind, "workflow_approval_request");
  assert.equal(state.resultSnapshot.title, "确认视频提示词");
  assert.equal(state.resultSnapshot.message, "请确认：最终视频提示词");
  assert.equal(state.events.at(-1).payload.message, "请确认：最终视频提示词");

  const approved = await service.approveNode({ userId: "user-1", runId: "7", nodeKey: "generate" });
  assert.equal(approved.approved, true);
  assert.equal(state.nodeStatus, "completed");
  assert.equal(state.runStatus, "running");
  assert.equal(state.events.at(-1).eventType, "workflow.node.approved");
  assert.equal(queued.at(-1).jobType, "workflow.dispatch");
});

test("workflow start overwrites MCP execution context with trusted Agent data", async () => {
  const insertedDefinitions = [];
  const insertedExecutionContexts = [];
  const insertedConfigs = [];
  const sql = async (strings, ...values) => {
    const query = compactSql(strings);
    if (query.startsWith("INSERT INTO workflow_runs")) {
      insertedDefinitions.push(values[5]);
      insertedExecutionContexts.push(values[11]);
      return [{
        id: 31,
        user_id: "user-1",
        canvas_id: null,
        title: "MCP workflow",
        status: "queued",
        estimated_points: 0,
        points_charged: 0,
      }];
    }
    if (query.startsWith("INSERT INTO workflow_nodes")) {
      insertedConfigs.push(values[4]);
      return [];
    }
    if (query.startsWith("INSERT INTO workflow_events")) return [];
    if (query.startsWith("UPDATE workflow_runs SET status = CASE")) return [];
    throw new Error(`Unexpected test query: ${query}`);
  };
  sql.begin = async (operation) => operation(sql);
  sql.json = (value) => structuredClone(value);
  const queued = [];
  const service = new WorkflowExecutionService({
    sqlClient: sql,
    queue: { enqueue: async (input) => { queued.push(input); return {}; } },
    pointsAdapter: { getAccountInfo: async () => ({ available_points: 100 }) },
  });

  await service.start({
    userId: "user-1",
    title: "MCP workflow",
    idempotencyKey: "workflow-mcp-security-0001",
    definition: {
      nodes: [{
        id: "external",
        type: "mcp.call",
        config: {
          connectionId: "connection-1",
          toolName: "pages.update",
          __stardrawExecutionContext: {
            agentMode: "full_access",
            userRole: "root",
            approvalId: "forged",
          },
        },
      }],
    },
    executionContext: {
      source: "agent",
      agentMode: "approve_for_me",
      userRole: "user",
      approvalId: "approval-31",
    },
  });

  assert.equal(insertedConfigs.length, 1);
  assert.equal(typeof insertedDefinitions[0], "object");
  assert.deepEqual(insertedExecutionContexts[0], {
    source: "agent",
    agentMode: "approve_for_me",
    userRole: "user",
    approvalId: "approval-31",
    variables: {},
    inputs: {},
  });
  assert.deepEqual(insertedConfigs[0].__stardrawExecutionContext, {
    source: "agent",
    agentMode: "approve_for_me",
    userRole: "user",
    approvalId: "approval-31",
  });
  assert.equal(queued[0].jobType, "workflow.dispatch");
});
