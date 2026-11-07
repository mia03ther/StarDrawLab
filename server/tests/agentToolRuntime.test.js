import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_DECISIONS,
  AGENT_MODES,
  TOOL_OPERATION_CLASSES,
} from "../ports/agentToolPort.js";
import { AgentToolRegistry } from "../services/agentToolRegistry.js";
import { AgentApprovalService, InMemoryAgentApprovalStore } from "../services/agentApprovalService.js";
import { AgentPolicyService } from "../services/agentPolicyService.js";

const fixedNow = new Date("2026-08-06T12:00:00.000Z");

test("registry requires root for tool registration and returns normalized definitions", () => {
  const registry = new AgentToolRegistry();
  assert.throws(
    () => registry.registerTool({ toolKey: "canvas.edit", operationClass: "reversible" }, { actorRole: "admin" }),
    (error) => error.code === "AGENT_TOOL_REGISTRATION_FORBIDDEN" && error.status === 403,
  );
  const tool = registry.registerTool({
    toolKey: "canvas.edit",
    operationClass: "reversible",
    requiredRoles: ["user", "admin"],
  });
  assert.equal(tool.toolKey, "canvas.edit");
  assert.deepEqual(tool.requiredRoles, ["user", "admin"]);
  assert.equal(registry.getTool("CANVAS.EDIT").operationClass, TOOL_OPERATION_CLASSES.REVERSIBLE);
  assert.throws(
    () => registry.registerTool({ toolKey: "canvas.edit", operationClass: "read" }),
    (error) => error.code === "AGENT_TOOL_ALREADY_REGISTERED" && error.status === 409,
  );
});

test("user RBAC and Agent mode are separate policy decisions", () => {
  const registry = new AgentToolRegistry({ tools: [
    { toolKey: "admin.model.configure", operationClass: "destructive", requiredRoles: ["root"] },
    { toolKey: "media.generate.image", operationClass: "creative", requiredRoles: ["user", "admin", "root"] },
    { toolKey: "content.delete", operationClass: "destructive", requiresOwnership: true },
  ] });
  const policy = new AgentPolicyService({ registry });

  const deniedByRbac = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: AGENT_MODES.FULL_ACCESS, toolKey: "admin.model.configure",
  });
  assert.equal(deniedByRbac.decision, AGENT_DECISIONS.DENY);
  assert.equal(deniedByRbac.reasonCode, "USER_RBAC_DENIED");

  const creativeInFull = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: "full", toolKey: "media.generate.image",
  });
  assert.equal(creativeInFull.decision, AGENT_DECISIONS.ALLOW);
  assert.equal(creativeInFull.requiresApproval, false);

  const destructiveInApprove = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: AGENT_MODES.APPROVE_FOR_ME, toolKey: "content.delete",
    context: { resourceOwnerUserId: "user-1" },
  });
  assert.equal(destructiveInApprove.decision, AGENT_DECISIONS.REQUIRE_APPROVAL);
  assert.equal(destructiveInApprove.reasonCode, "APPROVE_MODE_DANGEROUS_TOOL");

  const destructiveInFull = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: AGENT_MODES.FULL_ACCESS, toolKey: "content.delete",
    context: { resourceOwnerUserId: "user-1" },
  });
  assert.equal(destructiveInFull.decision, AGENT_DECISIONS.ALLOW);

  const wrongOwner = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: AGENT_MODES.FULL_ACCESS, toolKey: "content.delete",
    context: { resourceOwnerUserId: "user-2" },
  });
  assert.equal(wrongOwner.decision, AGENT_DECISIONS.DENY);
  assert.equal(wrongOwner.reasonCode, "USER_RESOURCE_OWNERSHIP_REQUIRED");
});

test("Ask mode requires approval for every tool, including harmless reads", () => {
  const registry = new AgentToolRegistry({ tools: [{ toolKey: "canvas.read", operationClass: "read" }] });
  const policy = new AgentPolicyService({ registry });
  const result = policy.evaluateToolCall({
    userId: "user-1", userRole: "user", agentMode: AGENT_MODES.ASK_FOR_APPROVAL, toolKey: "canvas.read",
  });
  assert.equal(result.decision, AGENT_DECISIONS.REQUIRE_APPROVAL);
  assert.equal(result.reasonCode, "ASK_MODE_REQUIRES_APPROVAL");
});

test("nested workflow MCP risk inherits the selected Agent mode", () => {
  const registry = new AgentToolRegistry({ tools: [{ toolKey: "workflow.run", operationClass: "creative" }] });
  const policy = new AgentPolicyService({ registry });
  const context = {
    operationClassOverrideTrusted: true,
    operationClassOverride: "external_mcp",
  };
  const approveMode = policy.evaluateToolCall({
    userId: "user-1",
    userRole: "user",
    agentMode: "approve_for_me",
    toolKey: "workflow.run",
    context,
  });
  assert.equal(approveMode.operationClass, "external_mcp");
  assert.equal(approveMode.requiresApproval, true);

  const fullMode = policy.evaluateToolCall({
    userId: "user-1",
    userRole: "user",
    agentMode: "full_access",
    toolKey: "workflow.run",
    context,
  });
  assert.equal(fullMode.operationClass, "external_mcp");
  assert.equal(fullMode.requiresApproval, false);
});

test("Full mode still requires approval for payment, recharge and refund", () => {
  const registry = new AgentToolRegistry({ tools: [
    { toolKey: "billing.pay", operationClass: "payment" },
    { toolKey: "billing.recharge", operationClass: "recharge" },
    { toolKey: "billing.refund", operationClass: "refund", requiredRoles: ["root"] },
  ] });
  const policy = new AgentPolicyService({ registry });
  for (const [toolKey, userRole] of [["billing.pay", "user"], ["billing.recharge", "user"], ["billing.refund", "root"]]) {
    const result = policy.evaluateToolCall({ userId: "u-1", userRole, agentMode: "full_access", toolKey });
    assert.equal(result.decision, AGENT_DECISIONS.REQUIRE_APPROVAL);
    assert.equal(result.reasonCode, "FULL_MODE_PAYMENT_REQUIRES_APPROVAL");
  }
});

test("approval credentials bind user, session, tool and canonical parameter digest", async () => {
  const events = [];
  const store = new InMemoryAgentApprovalStore();
  const service = new AgentApprovalService({
    store,
    clock: () => fixedNow,
    tokenGenerator: () => "approval-token-1234567890",
    auditSink: (event) => events.push(event),
  });
  const issued = await service.issueApproval({
    userId: "user-1",
    sessionId: "session-1",
    toolKey: "canvas.delete",
    parameters: { id: 7, options: { force: false } },
    reason: "删除用户确认的素材",
  });
  assert.equal(issued.approvalToken, "approval-token-1234567890");
  assert.match(issued.parameterDigest, /^[0-9a-f]{64}$/);
  assert.equal(issued.auditEvent.eventType, "agent.approval.issued");
  assert.equal(issued.auditEvent.metadata.expiresAt, issued.expiresAt);

  await assert.rejects(
    () => service.consumeApproval({ approvalToken: issued.approvalToken, userId: "user-2", sessionId: "session-1", toolKey: "canvas.delete", parameters: { id: 7, options: { force: false } } }),
    (error) => error.code === "APPROVAL_BINDING_MISMATCH" && error.auditEvent.outcome === "denied",
  );
  await assert.rejects(
    () => service.consumeApproval({ approvalToken: issued.approvalToken, userId: "user-1", sessionId: "session-1", toolKey: "canvas.delete", parameters: { id: 8, options: { force: false } } }),
    (error) => error.code === "APPROVAL_PARAMETER_MISMATCH",
  );

  const consumed = await service.consumeApproval({
    approvalToken: issued.approvalToken,
    userId: "user-1",
    sessionId: "session-1",
    toolKey: "canvas.delete",
    parameters: { options: { force: false }, id: 7 },
  });
  assert.equal(consumed.approved, true);
  assert.equal(consumed.auditEvent.eventType, "agent.approval.consumed");
  await assert.rejects(
    () => service.consumeApproval({ approvalToken: issued.approvalToken, userId: "user-1", sessionId: "session-1", toolKey: "canvas.delete", parameters: { id: 7, options: { force: false } } }),
    (error) => error.code === "APPROVAL_ALREADY_USED",
  );
  assert.equal(events.filter((event) => event.eventType === "agent.approval.issued").length, 1);
  assert.equal(events.filter((event) => event.eventType === "agent.approval.consumed").length, 1);
});

test("expired credentials cannot be consumed and never expose parameters in audit data", async () => {
  let now = new Date("2026-08-06T12:00:00.000Z");
  const events = [];
  const service = new AgentApprovalService({
    clock: () => now,
    tokenGenerator: () => "approval-token-expired-123",
    auditSink: (event) => events.push(event),
  });
  const issued = await service.issueApproval({ userId: "user-1", sessionId: "s-1", toolKey: "mcp.call", parameters: { secret: "must-not-leak" }, expiresInSeconds: 1 });
  now = new Date(now.getTime() + 1001);
  await assert.rejects(
    () => service.consumeApproval({ approvalToken: issued.approvalToken, userId: "user-1", sessionId: "s-1", toolKey: "mcp.call", parameters: { secret: "must-not-leak" } }),
    (error) => error.code === "APPROVAL_EXPIRED",
  );
  assert.equal(JSON.stringify(events).includes("must-not-leak"), false);
});
