import {
  AGENT_DECISIONS,
  AGENT_MODES,
  TOOL_OPERATION_CLASSES,
  USER_ROLES,
  normalizeAgentMode,
  normalizeToolOperationClass,
  normalizeUserRole,
} from "../ports/agentToolPort.js";

const AUTOMATIC_IN_APPROVE_MODE = new Set([
  TOOL_OPERATION_CLASSES.READ,
  TOOL_OPERATION_CLASSES.CREATIVE,
  TOOL_OPERATION_CLASSES.REVERSIBLE,
]);

const PAYMENT_CLASSES = new Set([
  TOOL_OPERATION_CLASSES.PAYMENT,
  TOOL_OPERATION_CLASSES.RECHARGE,
  TOOL_OPERATION_CLASSES.REFUND,
]);

const fail = (message, { code = "AGENT_POLICY_DENIED", status = 403, ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const denial = (tool, code, message, extra = {}) => ({
  decision: AGENT_DECISIONS.DENY,
  requiresApproval: false,
  toolKey: tool?.toolKey || null,
  operationClass: tool?.operationClass || null,
  reasonCode: code,
  reason: message,
  ...extra,
});

export const isPaymentOperation = (operationClass) => PAYMENT_CLASSES.has(operationClass);

export const resolveAgentDecision = ({ mode, operationClass, approvalPolicy = "policy" }) => {
  const normalizedMode = normalizeAgentMode(mode);
  if (approvalPolicy === "always" || normalizedMode === AGENT_MODES.ASK_FOR_APPROVAL) {
    return {
      decision: AGENT_DECISIONS.REQUIRE_APPROVAL,
      requiresApproval: true,
      reasonCode: approvalPolicy === "always" ? "TOOL_REQUIRES_APPROVAL" : "ASK_MODE_REQUIRES_APPROVAL",
    };
  }

  if (normalizedMode === AGENT_MODES.APPROVE_FOR_ME && !AUTOMATIC_IN_APPROVE_MODE.has(operationClass)) {
    return {
      decision: AGENT_DECISIONS.REQUIRE_APPROVAL,
      requiresApproval: true,
      reasonCode: "APPROVE_MODE_DANGEROUS_TOOL",
    };
  }

  if (normalizedMode === AGENT_MODES.FULL_ACCESS && isPaymentOperation(operationClass)) {
    return {
      decision: AGENT_DECISIONS.REQUIRE_APPROVAL,
      requiresApproval: true,
      reasonCode: "FULL_MODE_PAYMENT_REQUIRES_APPROVAL",
    };
  }

  return {
    decision: AGENT_DECISIONS.ALLOW,
    requiresApproval: false,
    reasonCode: "AGENT_MODE_ALLOWS_TOOL",
  };
};

export const checkUserRbac = ({ userRole, requiredRoles = Object.values(USER_ROLES) }) => {
  let normalizedRole;
  try {
    normalizedRole = normalizeUserRole(userRole);
  } catch (error) {
    return { allowed: false, reasonCode: error.code, role: null };
  }
  const allowed = requiredRoles.includes(normalizedRole);
  return {
    allowed,
    role: normalizedRole,
    reasonCode: allowed ? "USER_RBAC_ALLOWS_TOOL" : "USER_RBAC_DENIED",
  };
};

export class AgentPolicyService {
  #registry;

  constructor({ registry } = {}) {
    if (!registry || typeof registry.getTool !== "function") {
      throw new TypeError("AgentPolicyService requires an Agent tool registry port");
    }
    this.#registry = registry;
  }

  evaluateToolCall({ userId, userRole, agentMode, toolKey, tool, context = {} } = {}) {
    const resolvedTool = tool || this.#registry.getTool(toolKey);
    if (!resolvedTool) return denial(null, "AGENT_TOOL_NOT_FOUND", "Agent tool is not registered or enabled");
    if (!resolvedTool.enabled) return denial(resolvedTool, "AGENT_TOOL_DISABLED", "Agent tool is disabled");

    const rbac = checkUserRbac({ userRole, requiredRoles: resolvedTool.requiredRoles });
    if (!rbac.allowed) return denial(resolvedTool, rbac.reasonCode, "The user's RBAC role cannot use this tool", { userRole: rbac.role });

    if (Array.isArray(resolvedTool.allowedModes) && !resolvedTool.allowedModes.includes(normalizeAgentMode(agentMode))) {
      return denial(resolvedTool, "AGENT_MODE_NOT_ALLOWED", "This tool is not available in the selected Agent mode", { userRole: rbac.role });
    }

    if (resolvedTool.requiresOwnership && context.resourceOwnerUserId == null) {
      return denial(resolvedTool, "RESOURCE_OWNERSHIP_UNVERIFIED", "The server could not verify ownership of the requested resource", { userRole: rbac.role });
    }

    if (resolvedTool.requiresOwnership && String(context.resourceOwnerUserId) !== String(userId)) {
      return denial(resolvedTool, "USER_RESOURCE_OWNERSHIP_REQUIRED", "The Agent can only operate on the current user's resource", { userRole: rbac.role });
    }

    let effectiveOperationClass = resolvedTool.operationClass;
    if (context.operationClassOverrideTrusted === true && context.operationClassOverride) {
      effectiveOperationClass = normalizeToolOperationClass(context.operationClassOverride);
    }

    const agentDecision = resolveAgentDecision({
      mode: agentMode,
      operationClass: effectiveOperationClass,
      approvalPolicy: resolvedTool.approvalPolicy,
    });
    return {
      ...agentDecision,
      toolKey: resolvedTool.toolKey,
      operationClass: effectiveOperationClass,
      toolVersion: resolvedTool.version,
      userRole: rbac.role,
      resourceScope: resolvedTool.resourceScope,
      ownershipRequired: resolvedTool.requiresOwnership,
    };
  }

  assertCanUseTool({ userId, userRole, agentMode, toolKey, tool, context } = {}) {
    const decision = this.evaluateToolCall({ userId, userRole, agentMode, toolKey, tool, context });
    if (decision.decision === AGENT_DECISIONS.DENY) throw fail(decision.reason, {
      code: decision.reasonCode,
      status: decision.reasonCode === "AGENT_TOOL_NOT_FOUND" ? 404 : 403,
      decision,
    });
    return decision;
  }
}
