import {
  AGENT_DECISIONS,
  normalizeAgentMode,
  normalizeUserRole,
  requireNonEmptyIdentifier,
} from "../ports/agentToolPort.js";
import { hashAgentToolParameters } from "./agentApprovalService.js";
import { validateBoundedJsonSchema } from "../domain/schema/boundedJsonSchema.js";

const fail = (message, { status = 400, code = "AGENT_TOOL_RUNTIME_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const normalizeSessionId = (value) => {
  const sessionId = requireNonEmptyIdentifier(value, "sessionId");
  if (sessionId.length > 255) throw fail("sessionId is too long", { code: "INVALID_AGENT_SESSION" });
  return sessionId;
};

const emit = async (sink, event) => {
  if (!sink) return;
  if (typeof sink === "function") return sink(event);
  if (typeof sink.append === "function") return sink.append(event);
  throw new TypeError("Agent audit sink must be a function or expose append(event)");
};

/**
 * Deep module for Agent tool authorization and execution.
 *
 * The HTTP layer only supplies identity, mode, session and parameters. This
 * module owns the invariant that every call is policy-checked immediately
 * before execution, and that an approval credential is consumed exactly once
 * when the policy requires it. Actual tool implementations stay behind the
 * handler map, so MCP and built-in tools can evolve independently.
 */
export class AgentToolRuntimeService {
  #registry;
  #policy;
  #approvals;
  #audit;
  #handlers;
  #governor;

  constructor({ registry, policy, approvals, auditSink = null, handlers = new Map(), governor = null } = {}) {
    if (!registry || typeof registry.getTool !== "function" || typeof registry.listTools !== "function") {
      throw new TypeError("AgentToolRuntimeService requires an Agent tool registry");
    }
    if (!policy || typeof policy.evaluateToolCall !== "function") {
      throw new TypeError("AgentToolRuntimeService requires an Agent policy service");
    }
    if (!approvals || typeof approvals.issueApproval !== "function" || typeof approvals.consumeApproval !== "function") {
      throw new TypeError("AgentToolRuntimeService requires an Agent approval service");
    }
    this.#registry = registry;
    this.#policy = policy;
    this.#approvals = approvals;
    this.#audit = auditSink;
    this.#handlers = handlers instanceof Map ? handlers : new Map(Object.entries(handlers || {}));
    this.#governor = governor;
  }

  listTools({ userRole = null, globalOnly = false } = {}) {
    const normalizedRole = userRole == null ? null : normalizeUserRole(userRole);
    return this.#registry.listTools({ globalOnly })
      .filter((tool) => normalizedRole == null || tool.requiredRoles.includes(normalizedRole))
      .map((tool) => ({
      toolKey: tool.toolKey,
      name: tool.name,
      description: tool.description,
      version: tool.version,
      operationClass: tool.operationClass,
      resourceScope: tool.resourceScope,
      requiresOwnership: tool.requiresOwnership,
      approvalPolicy: tool.approvalPolicy,
      allowedModes: tool.allowedModes,
      requiredRoles: tool.requiredRoles,
      inputSchema: tool.inputSchema,
    }));
  }

  #validateParameters(toolKey, parameters) {
    const tool = this.#registry.getTool(toolKey);
    if (!tool?.inputSchema) return tool;
    validateBoundedJsonSchema(parameters, tool.inputSchema, {
      code: "AGENT_TOOL_INPUT_SCHEMA_INVALID",
      messagePrefix: "Agent tool parameters are invalid",
      toolKey: tool.toolKey,
    });
    return tool;
  }

  assess({ userId, userRole, agentMode, sessionId, toolKey, parameters = {}, context = {} } = {}) {
    const tool = this.#validateParameters(toolKey, parameters);
    const normalizedMode = normalizeAgentMode(agentMode);
    const normalizedRole = normalizeUserRole(userRole);
    const normalizedSessionId = normalizeSessionId(sessionId);
    const decision = this.#policy.evaluateToolCall({
      userId,
      userRole: normalizedRole,
      agentMode: normalizedMode,
      toolKey,
      tool,
      context,
    });
    return {
      ...decision,
      agentMode: normalizedMode,
      userRole: normalizedRole,
      sessionId: normalizedSessionId,
      parameterDigest: hashAgentToolParameters(parameters),
    };
  }

  async issueApproval({ userId, userRole, agentMode, sessionId, toolKey, parameters = {}, context = {}, reason = "" } = {}) {
    const decision = this.assess({ userId, userRole, agentMode, sessionId, toolKey, parameters, context });
    if (decision.decision === AGENT_DECISIONS.DENY) {
      throw fail(decision.reason, {
        status: decision.reasonCode === "AGENT_TOOL_NOT_FOUND" ? 404 : 403,
        code: decision.reasonCode,
        decision,
      });
    }
    if (!decision.requiresApproval) {
      throw fail("This tool does not require an approval credential in the selected Agent mode", {
        code: "APPROVAL_NOT_REQUIRED",
        status: 400,
        decision,
      });
    }
    const approval = await this.#approvals.issueApproval({
      userId,
      sessionId: decision.sessionId,
      toolKey: decision.toolKey,
      parameters,
      reason,
      metadata: {
        agentMode: decision.agentMode,
        operationClass: decision.operationClass,
        toolVersion: decision.toolVersion,
      },
    });
    return { ...decision, ...approval };
  }

  async revokeApproval({ approvalId, approvalToken, userId } = {}) {
    return this.#approvals.revokeApproval({ approvalId, approvalToken, userId });
  }

  async authorize({
    userId,
    userRole,
    agentMode,
    sessionId,
    toolKey,
    parameters = {},
    context = {},
    approvalToken = null,
    consumeApproval = true,
  } = {}) {
    const decision = this.assess({ userId, userRole, agentMode, sessionId, toolKey, parameters, context });
    if (decision.decision === AGENT_DECISIONS.DENY) {
      throw fail(decision.reason, {
        status: decision.reasonCode === "AGENT_TOOL_NOT_FOUND" ? 404 : 403,
        code: decision.reasonCode,
        decision,
      });
    }
    let approval = null;
    if (decision.requiresApproval) {
      if (!approvalToken) throw fail("This Agent tool call requires explicit user approval", {
        status: 403,
        code: "AGENT_APPROVAL_REQUIRED",
        decision,
      });
      if (consumeApproval) {
        approval = await this.#approvals.consumeApproval({
          approvalToken,
          userId,
          sessionId: decision.sessionId,
          toolKey: decision.toolKey,
          parameters,
        });
      }
    }
    await emit(this.#audit, {
      eventType: "agent.tool.authorized",
      outcome: approval ? "approved" : "executed",
      actorType: "agent",
      userId,
      sessionId: decision.sessionId,
      toolKey: decision.toolKey,
      approvalId: approval?.approvalId || null,
      parameterDigest: decision.parameterDigest,
      occurredAt: new Date().toISOString(),
      metadata: { authorizationOnly: true },
    });
    return { decision, approval };
  }

  async consumeApproval({ approvalToken, userId, sessionId, toolKey, parameters = {} } = {}) {
    if (!approvalToken) throw fail("An Agent approval token is required", {
      status: 403,
      code: "AGENT_APPROVAL_REQUIRED",
    });
    this.#validateParameters(toolKey, parameters);
    return this.#approvals.consumeApproval({ approvalToken, userId, sessionId, toolKey, parameters });
  }

  async execute({
    userId,
    userRole,
    agentMode,
    sessionId,
    toolKey,
    parameters = {},
    context = {},
    approvalToken = null,
    membershipTier = "free",
  } = {}) {
    const decision = this.assess({ userId, userRole, agentMode, sessionId, toolKey, parameters, context });
    if (decision.decision === AGENT_DECISIONS.DENY) {
      throw fail(decision.reason, {
        status: decision.reasonCode === "AGENT_TOOL_NOT_FOUND" ? 404 : 403,
        code: decision.reasonCode,
        decision,
      });
    }

    const handler = this.#handlers.get(decision.toolKey);
    if (typeof handler !== "function") {
      throw fail("The Agent tool is authorized but has no server handler", {
        status: 503,
        code: "AGENT_TOOL_HANDLER_UNAVAILABLE",
        decision,
      });
    }

    if (decision.requiresApproval && !approvalToken) {
      throw fail("This Agent tool call requires explicit user approval", {
        status: 403,
        code: "AGENT_APPROVAL_REQUIRED",
        decision,
      });
    }

    // Read-only Agent tools (for example creation.get polling) must not consume
    // the daily execution quota. HTTP/API rate limiting still protects these
    // endpoints. All state-changing or provider-backed operations continue
    // through the governor before approval consumption.
    let admission = null;
    if (this.#governor && decision.operationClass !== "read") {
      admission = await this.#governor.admit({
        userId,
        membershipTier,
        operationKey: decision.toolKey,
        queueName: "agent-tools",
        idempotencyKey: context?.idempotencyKey || null,
        leaseDurationMs: 30 * 60 * 1000,
        metadata: { source: "agent_tool_runtime" },
      });
    }
    if (admission?.replayed) {
      throw fail("Execution idempotency state has no stored tool result", {
        status: 409,
        code: "EXECUTION_IDEMPOTENCY_STATE_CONFLICT",
        decision,
      });
    }

    let approval = null;
    try {
      if (decision.requiresApproval) {
        approval = await this.#approvals.consumeApproval({
          approvalToken,
          userId,
          sessionId: decision.sessionId,
          toolKey: decision.toolKey,
          parameters,
        });
      }

      const baseEvent = {
        userId,
        sessionId: decision.sessionId,
        toolKey: decision.toolKey,
        approvalId: approval?.approvalId || null,
        parameterDigest: decision.parameterDigest,
        occurredAt: new Date().toISOString(),
      };
      const result = await handler({
        userId,
        membershipTier,
        userRole: decision.userRole,
        agentMode: decision.agentMode,
        sessionId: decision.sessionId,
        tool: decision,
        parameters,
        context,
        approvalId: approval?.approvalId || null,
      });
      if (admission) {
        try {
          await this.#governor.complete({ leaseId: admission.leaseId });
        } catch (settlementError) {
          await emit(this.#audit, {
            userId,
            sessionId: decision.sessionId,
            toolKey: decision.toolKey,
            approvalId: approval?.approvalId || null,
            parameterDigest: decision.parameterDigest,
            eventType: "agent.execution.settlement_failed",
            outcome: "failed",
            reasonCode: settlementError.code || "EXECUTION_SETTLEMENT_FAILED",
            occurredAt: new Date().toISOString(),
          });
        }
      }
      await emit(this.#audit, {
        ...baseEvent,
        eventType: "agent.tool.executed",
        outcome: "executed",
      });
      return { decision, approval, result };
    } catch (error) {
      if (admission) {
        try {
          await this.#governor.release({ leaseId: admission.leaseId, outcome: "failed", error });
        } catch {
          // Preserve the original provider/approval error. The lease expiry
          // janitor remains the final safety net for a failed release.
        }
      }
      const baseEvent = {
        userId,
        sessionId: decision.sessionId,
        toolKey: decision.toolKey,
        approvalId: approval?.approvalId || null,
        parameterDigest: decision.parameterDigest,
        occurredAt: new Date().toISOString(),
      };
      await emit(this.#audit, {
        ...baseEvent,
        eventType: "agent.tool.failed",
        outcome: "failed",
        reasonCode: error.code || "AGENT_TOOL_HANDLER_FAILED",
        metadata: { status: Number(error.status) || 500 },
      });
      throw error;
    }
  }
}
