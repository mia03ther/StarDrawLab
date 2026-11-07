import { createHash } from "node:crypto";
import { McpTransportPort } from "../ports/mcpPort.js";
import { AGENT_MODES, TOOL_OPERATION_CLASSES } from "../ports/agentToolPort.js";
import { resolveAgentDecision } from "./agentPolicyService.js";

const MAX_ARGUMENT_BYTES = 128 * 1024;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

const fail = (message, { status = 400, code = "MCP_TOOL_CALL_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (["undefined", "function", "symbol"].includes(typeof value)) return null;
  return value;
};

export const hashMcpToolArguments = (value) => createHash("sha256")
  .update(JSON.stringify(canonicalize(value ?? {})))
  .digest("hex");

const normalizeArguments = (value) => {
  const args = value == null ? {} : value;
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw fail("MCP tool arguments must be a JSON object", { code: "INVALID_MCP_TOOL_ARGUMENTS" });
  }
  let serialized;
  try { serialized = JSON.stringify(args); } catch { throw fail("MCP tool arguments must be JSON serializable", { code: "INVALID_MCP_TOOL_ARGUMENTS" }); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_ARGUMENT_BYTES) {
    throw fail("MCP tool arguments are too large", { status: 413, code: "MCP_TOOL_ARGUMENTS_TOO_LARGE" });
  }
  return args;
};

const normalizeToolName = (value) => {
  const name = String(value || "").trim();
  if (!TOOL_NAME_PATTERN.test(name)) throw fail("MCP tool name is invalid", { code: "INVALID_MCP_TOOL_NAME" });
  return name;
};

const schemaFail = (message, path) => fail(`${message} at ${path}`, {
  status: 400,
  code: "MCP_INPUT_SCHEMA_INVALID",
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const deepEqual = (left, right) => {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  if (typeof left !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
};

/** Validate the bounded JSON-Schema subset used by MCP tool definitions. */
const validateInputSchema = (value, schema, path = "$") => {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    throw schemaFail("value is not one of the allowed enum values", path);
  }
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((candidate) => {
    try {
      validateInputSchema(value, candidate, path);
      return true;
    } catch {
      return false;
    }
  })) {
    throw schemaFail("value does not match any allowed schema", path);
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0) {
    const typeMatches = types.some((type) => (
      (type === "object" && isObject(value))
      || (type === "array" && Array.isArray(value))
      || (type === "string" && typeof value === "string")
      || (type === "number" && typeof value === "number" && Number.isFinite(value))
      || (type === "integer" && Number.isSafeInteger(value))
      || (type === "boolean" && typeof value === "boolean")
      || (type === "null" && value === null)
    ));
    if (!typeMatches) throw schemaFail(`expected ${types.join(" or ")}`, path);
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < Number(schema.minLength)) throw schemaFail("string is too short", path);
    if (schema.maxLength != null && value.length > Number(schema.maxLength)) throw schemaFail("string is too long", path);
    if (schema.pattern != null) {
      let pattern;
      try { pattern = new RegExp(String(schema.pattern)); } catch { throw schemaFail("schema pattern is invalid", path); }
      if (!pattern.test(value)) throw schemaFail("string does not match the required pattern", path);
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum != null && value < Number(schema.minimum)) throw schemaFail("number is below the minimum", path);
    if (schema.maximum != null && value > Number(schema.maximum)) throw schemaFail("number is above the maximum", path);
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < Number(schema.minItems)) throw schemaFail("array has too few items", path);
    if (schema.maxItems != null && value.length > Number(schema.maxItems)) throw schemaFail("array has too many items", path);
    if (schema.items) value.forEach((item, index) => validateInputSchema(item, schema.items, `${path}[${index}]`));
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key !== "string" || !Object.hasOwn(value, key)) throw schemaFail(`missing required property ${String(key)}`, path);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) throw schemaFail(`unknown property ${unknown}`, path);
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateInputSchema(value[key], childSchema, `${path}.${key}`);
    }
  }
};

const roleAllowsTool = (tool, userRole) => Array.isArray(tool.requiredRoles)
  && tool.requiredRoles.includes(String(userRole || "user").toLowerCase());

/**
 * Application module for an MCP tool call.
 *
 * It binds the current user to their own OAuth connection, resolves endpoint
 * and tool policy from root/admin-owned records, then invokes the transport.
 * Neither callers nor the Agent can provide an endpoint or bearer token.
 */
export class McpToolExecutionService {
  #repository;
  #oauth;
  #transport;
  #clock;

  constructor({ repository, oauth, transport, clock = () => Date.now() } = {}) {
    if (!repository || typeof repository.getEnabledTool !== "function" || typeof repository.appendCallAudit !== "function") {
      throw new TypeError("McpToolExecutionService requires an MCP repository");
    }
    if (!oauth || typeof oauth.getAccessToken !== "function") throw new TypeError("McpToolExecutionService requires an MCP OAuth module");
    if (!transport || !(transport instanceof McpTransportPort) && typeof transport.callTool !== "function") {
      throw new TypeError("McpToolExecutionService requires an MCP transport port");
    }
    this.#repository = repository;
    this.#oauth = oauth;
    this.#transport = transport;
    this.#clock = clock;
  }

  async listAllowedTools({ userId, connectionId, userRole = "user" } = {}) {
    const credential = await this.#oauth.getAccessToken({ userId, connectionId });
    const server = await this.#resolveServer(credential.connection);
    const tools = await this.#repository.listServerTools({ serverId: server.id, includeDisabled: false });
    return tools.filter((tool) => roleAllowsTool(tool, userRole)).map((tool) => ({
      toolName: tool.toolName,
      description: tool.description,
      operationClass: tool.operationClass,
      approvalPolicy: tool.approvalPolicy,
      inputSchema: tool.inputSchema,
    }));
  }

  async callTool({ userId, userRole = "user", agentMode = AGENT_MODES.FULL_ACCESS, connectionId, serverKey = null, toolName: rawToolName, arguments: rawArguments = {}, approvalId = null } = {}) {
    const toolName = normalizeToolName(rawToolName);
    const toolArguments = normalizeArguments(rawArguments);
    const credential = await this.#oauth.getAccessToken({ userId, connectionId });
    const connection = credential.connection;
    const server = await this.#resolveServer(connection);
    if (serverKey && String(serverKey).trim().toLowerCase() !== server.serverKey) {
      await this.#recordDenied({ userId, server, connection, toolName, approvalId, code: "MCP_CONNECTION_SERVER_MISMATCH" });
      throw fail("MCP connection does not belong to the requested server", { status: 403, code: "MCP_CONNECTION_SERVER_MISMATCH" });
    }
    const tool = await this.#repository.getEnabledTool({ serverId: server.id, toolName });
    if (!tool || !tool.enabled) {
      await this.#recordDenied({ userId, server, connection, toolName, approvalId, code: "MCP_TOOL_NOT_ALLOWED" });
      throw fail("MCP tool is not enabled by an administrator", { status: 403, code: "MCP_TOOL_NOT_ALLOWED" });
    }
    if (!roleAllowsTool(tool, userRole)) {
      await this.#recordDenied({ userId, server, connection, toolName, approvalId, code: "MCP_TOOL_RBAC_DENIED" });
      throw fail("Current role cannot use this MCP tool", { status: 403, code: "MCP_TOOL_RBAC_DENIED" });
    }

    try {
      validateInputSchema(toolArguments, tool.inputSchema);
    } catch (error) {
      await this.#recordDenied({ userId, server, connection, toolName, approvalId, code: error.code || "MCP_INPUT_SCHEMA_INVALID" });
      throw error;
    }

    const decision = resolveAgentDecision({
      mode: agentMode,
      operationClass: tool.operationClass || TOOL_OPERATION_CLASSES.EXTERNAL_MCP,
      approvalPolicy: tool.approvalPolicy || "policy",
    });
    if (decision.requiresApproval && !approvalId) {
      await this.#recordDenied({ userId, server, connection, toolName, approvalId, code: "MCP_TOOL_APPROVAL_REQUIRED" });
      throw fail("This MCP tool requires explicit user approval", {
        status: 403,
        code: "MCP_TOOL_APPROVAL_REQUIRED",
        operationClass: tool.operationClass || TOOL_OPERATION_CLASSES.EXTERNAL_MCP,
        reasonCode: decision.reasonCode,
      });
    }

    const parameterDigest = hashMcpToolArguments(toolArguments);
    const startedAt = Number(this.#clock());
    await this.#repository.appendCallAudit({
      userId,
      mcpServerId: server.id,
      connectionId: connection.id,
      toolName,
      parameterDigest,
      approvalId,
      outcome: "started",
      metadata: { providerAdapter: server.providerAdapter },
    });
    try {
      const result = await this.#transport.callTool({
        endpoint: server.canonicalUrl,
        accessToken: credential.accessToken,
        toolName,
        arguments: toolArguments,
      });
      await this.#repository.appendCallAudit({
        userId,
        mcpServerId: server.id,
        connectionId: connection.id,
        toolName,
        parameterDigest,
        approvalId,
        outcome: "succeeded",
        latencyMs: Math.max(0, Number(this.#clock()) - startedAt),
        metadata: { providerAdapter: server.providerAdapter },
      });
      return {
        serverKey: server.serverKey,
        toolName,
        result,
      };
    } catch (error) {
      try {
        await this.#repository.appendCallAudit({
          userId,
          mcpServerId: server.id,
          connectionId: connection.id,
          toolName,
          parameterDigest,
          approvalId,
          outcome: "failed",
          statusCode: Number(error.status) || 500,
          latencyMs: Math.max(0, Number(this.#clock()) - startedAt),
          errorCode: String(error.code || "MCP_TOOL_CALL_FAILED").slice(0, 120),
          metadata: { providerAdapter: server.providerAdapter },
        });
      } catch {
        // Preserve the upstream failure; the global Agent audit still records
        // that execution failed if the MCP-specific audit sink is unavailable.
      }
      throw error;
    }
  }

  async #resolveServer(connection) {
    const server = await this.#repository.getServerById({ serverId: connection.serverId });
    if (!server || !server.enabled || server.status !== "enabled") {
      throw fail("MCP server is not enabled", { status: 403, code: "MCP_SERVER_UNAVAILABLE" });
    }
    if (String(server.id) !== String(connection.serverId)) {
      throw fail("MCP connection server binding is invalid", { status: 403, code: "MCP_CONNECTION_SERVER_MISMATCH" });
    }
    let connectionResource;
    let serverResource;
    try {
      connectionResource = new URL(connection.resourceUri).toString();
      serverResource = new URL(server.canonicalUrl).toString();
    } catch {
      throw fail("MCP connection resource binding is invalid", { status: 403, code: "MCP_CONNECTION_RESOURCE_MISMATCH" });
    }
    if (connectionResource !== serverResource) {
      throw fail("MCP token is not bound to this server resource", { status: 403, code: "MCP_CONNECTION_RESOURCE_MISMATCH" });
    }
    if (server.transport !== "streamable_http") {
      throw fail("MCP transport is not enabled in this release", { status: 503, code: "MCP_TRANSPORT_UNAVAILABLE" });
    }
    return server;
  }

  async #recordDenied({ userId, server, connection, toolName, approvalId, code }) {
    await this.#repository.appendCallAudit({
      userId,
      mcpServerId: server.id,
      connectionId: connection.id,
      toolName,
      approvalId,
      outcome: "denied",
      errorCode: code,
    });
  }
}
