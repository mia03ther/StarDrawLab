import assert from "node:assert/strict";
import test from "node:test";

import { AgentApprovalService, InMemoryAgentApprovalStore } from "../services/agentApprovalService.js";
import { AgentPolicyService } from "../services/agentPolicyService.js";
import { AgentToolRegistry, DEFAULT_AGENT_TOOLS } from "../services/agentToolRegistry.js";
import { AgentToolRuntimeService } from "../services/agentToolRuntimeService.js";

const createRuntime = ({ governor = null } = {}) => {
  const registry = new AgentToolRegistry({ tools: [
    { toolKey: "canvas.read", operationClass: "read", requiresOwnership: true },
    { toolKey: "creation.get", operationClass: "read", requiresOwnership: true },
    { toolKey: "billing.pay", operationClass: "payment" },
  ] });
  const policy = new AgentPolicyService({ registry });
  const approvals = new AgentApprovalService({
    store: new InMemoryAgentApprovalStore(),
    tokenGenerator: () => "runtime-approval-token-123456",
  });
  const executed = [];
  const runtime = new AgentToolRuntimeService({
    registry,
    policy,
    approvals,
    handlers: new Map([
      ["canvas.read", async (input) => {
        executed.push(input);
        return { canvasId: input.parameters.canvasId };
      }],
      ["creation.get", async (input) => ({ creationId: input.parameters.creationId, status: "processing" })],
      ["billing.pay", async () => ({ paid: true })],
    ]),
    governor,
  });
  return { runtime, executed };
};

test("ownership is server-verified before a user-owned Agent tool runs", () => {
  const { runtime } = createRuntime();
  const unverified = runtime.assess({
    userId: "u1", userRole: "user", agentMode: "full", sessionId: "s1",
    toolKey: "canvas.read", parameters: { canvasId: "c1" }, context: {},
  });
  assert.equal(unverified.decision, "deny");
  assert.equal(unverified.reasonCode, "RESOURCE_OWNERSHIP_UNVERIFIED");
});

test("Ask mode consumes a user approval exactly once before executing", async () => {
  const { runtime, executed } = createRuntime();
  const input = {
    userId: "u1", userRole: "user", agentMode: "ask", sessionId: "s1",
    toolKey: "canvas.read", parameters: { canvasId: "c1" },
    context: { resourceOwnerUserId: "u1" },
  };
  await assert.rejects(runtime.execute(input), (error) => error.code === "AGENT_APPROVAL_REQUIRED");
  const approval = await runtime.issueApproval({ ...input, reason: "用户确认读取画布" });
  const result = await runtime.execute({ ...input, approvalToken: approval.approvalToken });
  assert.deepEqual(result.result, { canvasId: "c1" });
  assert.equal(executed.length, 1);
  await assert.rejects(
    runtime.execute({ ...input, approvalToken: approval.approvalToken }),
    (error) => error.code === "APPROVAL_ALREADY_USED",
  );
});

test("Full mode still routes payment through explicit approval", async () => {
  const { runtime } = createRuntime();
  const input = {
    userId: "u1", userRole: "user", agentMode: "full_access", sessionId: "s1",
    toolKey: "billing.pay", parameters: { planId: "basic" },
  };
  const assessment = runtime.assess(input);
  assert.equal(assessment.requiresApproval, true);
  const approval = await runtime.issueApproval({ ...input, reason: "支付确认" });
  const result = await runtime.execute({ ...input, approvalToken: approval.approvalToken });
  assert.equal(result.result.paid, true);
});

test("quota rejection happens before a one-time approval is consumed", async () => {
  let deny = true;
  const calls = [];
  const governor = {
    async admit(input) {
      calls.push(["admit", input]);
      if (deny) throw Object.assign(new Error("rate limited"), { status: 429, code: "EXECUTION_RATE_LIMITED" });
      return { admitted: true, replayed: false, leaseId: "lease-1" };
    },
    async complete(input) { calls.push(["complete", input]); },
    async release(input) { calls.push(["release", input]); },
  };
  const { runtime } = createRuntime({ governor });
  const input = {
    userId: "u1", userRole: "user", agentMode: "ask", sessionId: "s1",
    toolKey: "billing.pay", parameters: { planId: "basic" },
  };
  const approval = await runtime.issueApproval({ ...input, reason: "支付确认" });
  await assert.rejects(
    runtime.execute({ ...input, approvalToken: approval.approvalToken }),
    (error) => error.code === "EXECUTION_RATE_LIMITED",
  );

  deny = false;
  const result = await runtime.execute({ ...input, approvalToken: approval.approvalToken });
  assert.deepEqual(result.result, { paid: true });
  assert.equal(calls.at(-1)[0], "complete");
});

test("read-only creation polling does not consume the execution quota", async () => {
  const governor = {
    async admit() {
      throw Object.assign(new Error("Daily execution quota has been reached"), {
        status: 429,
        code: "DAILY_QUOTA_EXCEEDED",
      });
    },
    async complete() {
      throw new Error("read-only polling must not settle a lease");
    },
    async release() {
      throw new Error("read-only polling must not release a lease");
    },
  };
  const { runtime } = createRuntime({ governor });

  const result = await runtime.execute({
    userId: "u1",
    userRole: "user",
    agentMode: "full_access",
    sessionId: "s1",
    toolKey: "creation.get",
    parameters: { creationId: "creation-1" },
    context: { resourceOwnerUserId: "u1" },
  });

  assert.deepEqual(result.result, { creationId: "creation-1", status: "processing" });
});

test("registered input schemas reject invalid parameters before policy, approval, quota, or execution", async () => {
  const registry = new AgentToolRegistry({ tools: [{
    toolKey: "content.delete",
    operationClass: "destructive",
    inputSchema: {
      type: "object",
      required: ["resourceId"],
      additionalProperties: false,
      properties: { resourceId: { type: "string", minLength: 1 } },
    },
  }] });
  const calls = { policy: 0, issue: 0, consume: 0, admit: 0, handler: 0 };
  const runtime = new AgentToolRuntimeService({
    registry,
    policy: {
      evaluateToolCall() {
        calls.policy += 1;
        return {
          decision: "require_approval",
          requiresApproval: true,
          toolKey: "content.delete",
          operationClass: "destructive",
          toolVersion: 1,
        };
      },
    },
    approvals: {
      async issueApproval() { calls.issue += 1; return {}; },
      async consumeApproval() { calls.consume += 1; return {}; },
    },
    governor: {
      async admit() { calls.admit += 1; return { leaseId: "lease-1" }; },
    },
    handlers: new Map([["content.delete", async () => { calls.handler += 1; return {}; }]]),
  });
  const invalid = {
    userId: "u1",
    userRole: "user",
    agentMode: "ask",
    sessionId: "s1",
    toolKey: "content.delete",
    parameters: { resourceId: "", unexpected: true },
  };
  const matchesStableValidationError = (error) => (
    error.code === "AGENT_TOOL_INPUT_SCHEMA_INVALID"
    && error.status === 400
    && error.toolKey === "content.delete"
    && typeof error.path === "string"
  );

  assert.throws(() => runtime.assess(invalid), matchesStableValidationError);
  await assert.rejects(runtime.issueApproval(invalid), matchesStableValidationError);
  await assert.rejects(runtime.authorize({ ...invalid, approvalToken: "approval-token" }), matchesStableValidationError);
  await assert.rejects(runtime.execute({ ...invalid, approvalToken: "approval-token" }), matchesStableValidationError);
  assert.deepEqual(calls, { policy: 0, issue: 0, consume: 0, admit: 0, handler: 0 });
});

test("high-risk default Agent tools publish bounded input schemas", () => {
  const highRiskToolKeys = [
    "mcp.call.external",
    "content.delete",
    "content.publish",
    "community.publish",
    "community.unpublish",
    "community.like",
    "community.favorite",
    "community.report",
    "billing.pay",
    "billing.refund",
    "point-package.purchase",
    "root.point-package.refund",
    "content.recycle.restore",
    "creation.failed.delete",
    "media.generate.image",
    "media.generate.video",
    "task.cancel",
    "workflow.run",
  ];
  const toolsByKey = new Map(DEFAULT_AGENT_TOOLS.map((tool) => [tool.toolKey, tool]));

  for (const toolKey of highRiskToolKeys) {
    const schema = toolsByKey.get(toolKey)?.inputSchema;
    assert.equal(schema?.type, "object", `${toolKey} must require an object`);
    assert.equal(schema?.additionalProperties, false, `${toolKey} must reject undeclared fields`);
    if (toolKey === "workflow.run") {
      assert.equal(schema.oneOf?.some((candidate) => candidate.required?.includes("canvasId")), true);
      assert.equal(schema.oneOf?.some((candidate) => candidate.required?.includes("definition")), true);
    } else {
      assert.ok(schema.required?.length > 0, `${toolKey} must require its target identifiers`);
    }
  }
});

test("legacy canvas Agent planning is rejected by the global runtime", () => {
  const registry = new AgentToolRegistry({ tools: DEFAULT_AGENT_TOOLS });
  const policy = new AgentPolicyService({ registry });
  const runtime = new AgentToolRuntimeService({
    registry,
    policy,
    approvals: new AgentApprovalService({ store: new InMemoryAgentApprovalStore() }),
    handlers: new Map(),
  });
  const parameters = {
    canvasId: "canvas-1",
    instruction: "做一个工作流",
    selectedIds: [],
  };

  const decision = runtime.assess({
    userId: "user-1",
    userRole: "user",
    agentMode: "approve_for_me",
    sessionId: "session-1",
    toolKey: "canvas.agent.plan",
    parameters,
    context: { resourceOwnerUserId: "user-1" },
  });

  assert.equal(decision.decision, "deny");
  assert.equal(decision.reasonCode, "AGENT_TOOL_NOT_FOUND");
  assert.equal(
    registry.getTool("workflow.run").inputSchema.oneOf.some((candidate) => candidate.required?.includes("definition")),
    true,
  );
});

test("planning-only canvas Agent tool is excluded from the global Agent catalog", () => {
  const registry = new AgentToolRegistry({ tools: DEFAULT_AGENT_TOOLS });
  const policy = new AgentPolicyService({ registry });
  const runtime = new AgentToolRuntimeService({
    registry,
    policy,
    approvals: new AgentApprovalService({ store: new InMemoryAgentApprovalStore() }),
    handlers: new Map(),
  });

  assert.equal(runtime.listTools({ userRole: "user", globalOnly: true }).some((tool) => tool.toolKey === "canvas.agent.plan"), false);
  assert.equal(runtime.listTools({ userRole: "user", globalOnly: true }).some((tool) => tool.toolKey === "workflow.run"), true);
});

test("new global Agent coverage publishes bounded filters and cancellation input", () => {
  const toolsByKey = new Map(DEFAULT_AGENT_TOOLS.map((tool) => [tool.toolKey, tool]));
  for (const toolKey of [
    "creation.history",
    "creation.download",
    "community.list",
    "community.publication.get",
    "subscription.renewal.cancel",
  ]) {
    const schema = toolsByKey.get(toolKey)?.inputSchema;
    assert.equal(schema?.type, "object", `${toolKey} must require an object`);
    assert.equal(schema?.additionalProperties, false, `${toolKey} must reject undeclared fields`);
  }
  assert.deepEqual(
    toolsByKey.get("content.delete").inputSchema.properties.resourceType.enum,
    ["creation", "canvas", "private_template", "digital_human", "upload"],
  );
  assert.equal(toolsByKey.get("subscription.renewal.cancel").operationClass, "destructive");
  assert.notEqual(toolsByKey.get("subscription.renewal.cancel").approvalPolicy, "always");
  assert.equal(toolsByKey.get("billing.pay").operationClass, "payment");
  assert.equal(toolsByKey.get("billing.refund").operationClass, "refund");
});
