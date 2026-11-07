/**
 * Ports for the Agent tool runtime.
 *
 * These contracts deliberately contain no Express, PostgreSQL, MCP SDK, or
 * provider-specific types. Adapters can implement them in the API process,
 * a Worker, or a future Redis-backed deployment.
 */

export const AGENT_MODES = Object.freeze({
  ASK_FOR_APPROVAL: "ask_for_approval",
  APPROVE_FOR_ME: "approve_for_me",
  FULL_ACCESS: "full_access",
});

export const USER_ROLES = Object.freeze({
  ROOT: "root",
  ADMIN: "admin",
  USER: "user",
});

export const AGENT_DECISIONS = Object.freeze({
  ALLOW: "allow",
  REQUIRE_APPROVAL: "require_approval",
  DENY: "deny",
});

export const TOOL_OPERATION_CLASSES = Object.freeze({
  READ: "read",
  CREATIVE: "creative",
  REVERSIBLE: "reversible",
  DESTRUCTIVE: "destructive",
  PUBLISH: "publish",
  EXTERNAL_MCP: "external_mcp",
  PAYMENT: "payment",
  RECHARGE: "recharge",
  REFUND: "refund",
});

const MODE_ALIASES = new Map([
  ["ask", AGENT_MODES.ASK_FOR_APPROVAL],
  ["ask_for_approval", AGENT_MODES.ASK_FOR_APPROVAL],
  ["ask-for-approval", AGENT_MODES.ASK_FOR_APPROVAL],
  ["approve", AGENT_MODES.APPROVE_FOR_ME],
  ["approve_for_me", AGENT_MODES.APPROVE_FOR_ME],
  ["approve-for-me", AGENT_MODES.APPROVE_FOR_ME],
  ["full", AGENT_MODES.FULL_ACCESS],
  ["full_access", AGENT_MODES.FULL_ACCESS],
  ["full-access", AGENT_MODES.FULL_ACCESS],
]);

const ROLE_ALIASES = new Map([
  [USER_ROLES.ROOT, USER_ROLES.ROOT],
  [USER_ROLES.ADMIN, USER_ROLES.ADMIN],
  [USER_ROLES.USER, USER_ROLES.USER],
]);

const OPERATION_ALIASES = new Map([
  ["read", TOOL_OPERATION_CLASSES.READ],
  ["creative", TOOL_OPERATION_CLASSES.CREATIVE],
  ["reversible", TOOL_OPERATION_CLASSES.REVERSIBLE],
  ["destructive", TOOL_OPERATION_CLASSES.DESTRUCTIVE],
  ["dangerous", TOOL_OPERATION_CLASSES.DESTRUCTIVE],
  ["publish", TOOL_OPERATION_CLASSES.PUBLISH],
  ["external_mcp", TOOL_OPERATION_CLASSES.EXTERNAL_MCP],
  ["external-mcp", TOOL_OPERATION_CLASSES.EXTERNAL_MCP],
  ["mcp", TOOL_OPERATION_CLASSES.EXTERNAL_MCP],
  ["payment", TOOL_OPERATION_CLASSES.PAYMENT],
  ["recharge", TOOL_OPERATION_CLASSES.RECHARGE],
  ["refund", TOOL_OPERATION_CLASSES.REFUND],
]);

const invalid = (message, code = "INVALID_AGENT_TOOL_INPUT") => Object.assign(new Error(message), {
  status: 400,
  code,
});

export const normalizeAgentMode = (value) => {
  const normalized = MODE_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) throw invalid("Unknown Agent access mode", "INVALID_AGENT_MODE");
  return normalized;
};

export const normalizeUserRole = (value) => {
  const normalized = ROLE_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) throw invalid("Unknown user RBAC role", "INVALID_USER_ROLE");
  return normalized;
};

export const normalizeToolOperationClass = (value) => {
  const normalized = OPERATION_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) throw invalid("Unknown Agent tool operation class", "INVALID_TOOL_OPERATION_CLASS");
  return normalized;
};

export const requireNonEmptyIdentifier = (value, name) => {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 255) throw invalid(`${name} must be a non-empty identifier`);
  return normalized;
};

/**
 * Abstract registry port. Implementations must make registration and lookup
 * atomic when backed by durable storage.
 */
export class AgentToolRegistryPort {
  registerTool() { throw new Error("AgentToolRegistryPort.registerTool is not implemented"); }
  getTool() { throw new Error("AgentToolRegistryPort.getTool is not implemented"); }
  listTools() { throw new Error("AgentToolRegistryPort.listTools is not implemented"); }
  unregisterTool() { throw new Error("AgentToolRegistryPort.unregisterTool is not implemented"); }
}

/**
 * Approval store port. consumeApproval must be an atomic compare-and-consume
 * operation so two concurrent requests cannot spend one credential twice.
 */
export class AgentApprovalStorePort {
  createApproval() { throw new Error("AgentApprovalStorePort.createApproval is not implemented"); }
  consumeApproval() { throw new Error("AgentApprovalStorePort.consumeApproval is not implemented"); }
  revokeApproval() { throw new Error("AgentApprovalStorePort.revokeApproval is not implemented"); }
}

export class AgentAuditPort {
  append() { throw new Error("AgentAuditPort.append is not implemented"); }
}

