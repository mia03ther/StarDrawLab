import assert from "node:assert/strict";
import test from "node:test";

process.env.LOG_DIR = "/tmp/stardraw-job-executor-test-logs";

const {
  createApplicationJobExecutorRegistry,
  DURABLE_JOB_TYPES,
  JobExecutorRegistry,
} = await import("../services/jobExecutorRegistry.js");

test("job executor registry rejects unknown types and lists the durable runtime surface", async () => {
  const registry = new JobExecutorRegistry({ executors: { "demo.job": async () => ({ ok: true }) } });
  assert.deepEqual(registry.list(), ["demo.job"]);
  assert.equal(registry.has("demo.job"), true);
  await assert.rejects(
    registry.execute({ jobType: "unknown.job" }),
    (error) => error.code === "UNSUPPORTED_DURABLE_JOB" && error.status === 503,
  );
});

test("application registry routes workflow, MCP and Agent jobs through injected runtimes", async () => {
  const calls = [];
  const workflowRuntimeFactory = () => ({ executeJob: async (job) => { calls.push(["workflow", job.jobType]); return { workflow: true }; } });
  const agentRuntimeFactory = () => ({ execute: async (input) => { calls.push(["agent", input.toolKey]); return { agent: true }; } });
  const agentPlanExecutionFactory = () => ({ executeJob: async () => { calls.push(["agent-plan", "run"]); return { plan: true }; } });
  const mcpRuntimeFactory = () => ({ callTool: async (input) => { calls.push(["mcp", input.toolName]); return { mcp: true }; } });
  const registry = createApplicationJobExecutorRegistry({ workflowRuntimeFactory, agentRuntimeFactory, agentPlanExecutionFactory, mcpRuntimeFactory });

  assert.deepEqual(await registry.execute({ jobType: DURABLE_JOB_TYPES.WORKFLOW_NODE, payload: { runId: "r1" } }), { workflow: true });
  assert.deepEqual(await registry.execute({
    jobType: DURABLE_JOB_TYPES.MCP_CALL, userId: "u1",
    payload: { connectionId: "c1", toolName: "pages.search", arguments: { query: "canvas" } },
  }), { mcp: true });
  assert.deepEqual(await registry.execute({
    jobType: DURABLE_JOB_TYPES.AGENT_TOOL, userId: "u1",
    payload: { sessionId: "s1", toolKey: "canvas.read", parameters: {} },
  }), { agent: true });
  assert.deepEqual(await registry.execute({
    jobType: DURABLE_JOB_TYPES.AGENT_PLAN, userId: "u1", payload: { runId: "r1" },
  }), { plan: true });
  assert.deepEqual(calls, [["workflow", "workflow.node"], ["mcp", "pages.search"], ["agent", "canvas.read"], ["agent-plan", "run"]]);
});

test("durable Agent jobs never persist one-time approval tokens", async () => {
  const registry = createApplicationJobExecutorRegistry({
    agentRuntimeFactory: () => ({ execute: async () => ({ ok: true }) }),
  });
  await assert.rejects(
    registry.execute({
      jobType: DURABLE_JOB_TYPES.AGENT_TOOL, userId: "u1",
      payload: { sessionId: "s1", toolKey: "billing.pay", approvalToken: "secret" },
    }),
    (error) => error.code === "AGENT_JOB_SECRET_NOT_ALLOWED",
  );
});
