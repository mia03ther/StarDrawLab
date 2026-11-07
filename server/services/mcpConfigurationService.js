import {
  MCP_SERVER_STATUSES,
  MCP_TRANSPORTS,
} from "../ports/mcpPort.js";
import {
  assertAllowedMcpHost,
  assertSafeMcpUrl,
  resolveAndAssertPublicMcpHost,
} from "./mcpSecurityService.js";
import {
  assertMcpProviderConfiguration,
  getMcpProviderCapability,
  listMcpProviderCapabilities,
  MCP_PROVIDER_ADAPTERS,
} from "../domain/mcp/mcpProviderCatalog.js";

export { MCP_PROVIDER_ADAPTERS, getMcpProviderCapability, listMcpProviderCapabilities };
const SERVER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?$/;
const DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;
const OPERATION_CLASSES = new Set(["read", "creative", "reversible", "destructive", "publish", "external_mcp"]);
const ROLES = new Set(["root", "admin", "user"]);

const fail = (message, { status = 400, code = "INVALID_MCP_CONFIGURATION" } = {}) => Object.assign(new Error(message), {
  status,
  code,
});

const boundedString = (value, label, max) => {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw fail(`${label} is invalid`, { code: `INVALID_MCP_${label.toUpperCase()}` });
  return result;
};

const normalizeServerKey = (value) => {
  const key = boundedString(value, "serverKey", 80).toLowerCase();
  if (!SERVER_KEY_PATTERN.test(key)) throw fail("serverKey contains unsupported characters", { code: "INVALID_MCP_SERVER_KEY" });
  return key;
};

const normalizeDomains = (value, fallbackHost) => {
  const raw = value == null || (Array.isArray(value) && value.length === 0) ? [fallbackHost] : value;
  if (!Array.isArray(raw) || raw.length > 20) throw fail("allowedDomains must contain at most 20 domains", { code: "INVALID_MCP_ALLOWED_DOMAINS" });
  const domains = [...new Set(raw.map((item) => String(item || "").trim().toLowerCase()))];
  if (domains.some((domain) => !DOMAIN_PATTERN.test(domain))) {
    throw fail("allowedDomains contains an invalid hostname pattern", { code: "INVALID_MCP_ALLOWED_DOMAINS" });
  }
  return domains;
};

const normalizeObject = (value, label, maxBytes = 32 * 1024) => {
  const object = value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) : {};
  let encoded;
  try { encoded = JSON.stringify(object); } catch { throw fail(`${label} must be JSON serializable`); }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw fail(`${label} is too large`, { code: "MCP_CONFIGURATION_TOO_LARGE" });
  return object;
};

const normalizeMetadata = (value) => {
  const metadata = normalizeObject(value, "metadata");
  const sensitiveName = /(secret|token|password|private.?key|credential)/i;
  const containsSensitiveKey = (item) => item && typeof item === "object"
    && Object.entries(item).some(([key, nested]) => sensitiveName.test(key) || containsSensitiveKey(nested));
  if (containsSensitiveKey(metadata)) throw fail("metadata cannot contain credentials", { code: "MCP_CREDENTIAL_IN_METADATA" });
  return metadata;
};

const normalizeOAuthConfig = (value, capability = null) => {
  const config = normalizeObject(value, "oauthConfig");
  const rawScopes = config.allowedScopes ?? config.allowed_scopes ?? [];
  if (!Array.isArray(rawScopes) || rawScopes.length > 64) {
    throw fail("oauthConfig.allowedScopes must contain at most 64 scopes", { code: "INVALID_MCP_SCOPES" });
  }
  const configuredScopes = [...new Set(rawScopes.map((scope) => String(scope || "").trim()))];
  const defaultScopes = Array.isArray(capability?.oauth?.scopeDefaults) ? capability.oauth.scopeDefaults : [];
  const allowedScopes = configuredScopes.length > 0 ? configuredScopes : [...defaultScopes];
  if (capability?.oauth?.scopeSource === "fixed_catalog"
      && defaultScopes.length > 0
      && allowedScopes.some((scope) => !defaultScopes.includes(scope))) {
    throw fail("OAuth scopes do not match the provider capability catalog", {
      status: 400,
      code: "MCP_PROVIDER_SCOPE_INVALID",
    });
  }
  if (allowedScopes.some((scope) => !scope || scope.length > 160 || /\s|["'\\]/.test(scope))) {
    throw fail("oauthConfig.allowedScopes contains an invalid scope", { code: "INVALID_MCP_SCOPES" });
  }
  const credentialKey = /^(client_?secret|access_?token|refresh_?token|password|private_?key)$/i;
  if (Object.keys(config).some((key) => credentialKey.test(key))) {
    throw fail("OAuth credentials must use the encrypted client registration interface", { code: "MCP_CREDENTIAL_IN_OAUTH_CONFIG" });
  }
  delete config.allowed_scopes;
  config.allowedScopes = allowedScopes;
  return config;
};

const safeRegistration = (registration) => registration && ({
  id: String(registration.id),
  mcpServerId: String(registration.mcpServerId),
  issuer: registration.issuer,
  registrationMode: registration.registrationMode,
  clientId: registration.clientId,
  metadata: registration.metadata || {},
  status: registration.status,
});

/**
 * Root/admin MCP configuration module.
 *
 * URL policy, provider admission, secret encryption and tool allowlisting are
 * kept behind this seam so Express routes do not become a second security
 * implementation. The repository and vault are replaceable adapters.
 */
export class McpConfigurationService {
  #repository;
  #vault;
  #production;
  #allowLoopback;

  constructor({ repository, vault, production = process.env.NODE_ENV === "production", allowLoopback = false } = {}) {
    if (!repository || typeof repository.getServerByKey !== "function" || typeof repository.registerServer !== "function") {
      throw new TypeError("McpConfigurationService requires an MCP repository");
    }
    if (!vault || typeof vault.encrypt !== "function") throw new TypeError("McpConfigurationService requires a credential vault");
    this.#repository = repository;
    this.#vault = vault;
    this.#production = production;
    this.#allowLoopback = allowLoopback;
  }

  async registerServer(input = {}) {
    const serverKey = normalizeServerKey(input.serverKey);
    const providerAdapter = boundedString(input.providerAdapter, "providerAdapter", 80).toLowerCase();
    const transport = String(input.transport || MCP_TRANSPORTS.STREAMABLE_HTTP).trim().toLowerCase();
    if (!Object.values(MCP_TRANSPORTS).includes(transport)) throw fail("MCP transport is not supported", { code: "MCP_TRANSPORT_NOT_ALLOWED" });
    const url = await resolveAndAssertPublicMcpHost(input.canonicalUrl, {
      production: this.#production,
      allowLoopback: this.#allowLoopback,
    });
    const allowedDomains = normalizeDomains(input.allowedDomains, url.hostname.toLowerCase());
    assertAllowedMcpHost(url, allowedDomains);
    const requestedStatus = String(input.status || MCP_SERVER_STATUSES.DRAFT).trim().toLowerCase();
    if (!Object.values(MCP_SERVER_STATUSES).includes(requestedStatus)) throw fail("MCP server status is invalid", { code: "INVALID_MCP_SERVER_STATUS" });
    const capability = getMcpProviderCapability(providerAdapter);
    assertMcpProviderConfiguration({
      providerAdapter,
      transport,
      // Registration may safely downgrade a catalog-pending provider to a
      // pending record. The status mutation endpoint remains fail-closed.
      status: capability?.admission === "catalog_pending" ? MCP_SERVER_STATUSES.CATALOG_PENDING : requestedStatus,
      enabled: capability?.admission === "catalog_pending" ? false : input.enabled === true,
    });
    if (transport === MCP_TRANSPORTS.SSE && requestedStatus === MCP_SERVER_STATUSES.ENABLED) {
      throw fail("SSE transport is reserved for a later release; enable Streamable HTTP instead", { status: 503, code: "MCP_TRANSPORT_UNAVAILABLE" });
    }
    const status = capability.admission === "catalog_pending"
      ? MCP_SERVER_STATUSES.CATALOG_PENDING : requestedStatus;
    const enabled = status === MCP_SERVER_STATUSES.ENABLED && input.enabled === true;
    if (requestedStatus === MCP_SERVER_STATUSES.ENABLED && input.enabled !== true) {
      throw fail("An enabled MCP server must explicitly set enabled=true", { code: "MCP_ENABLE_CONFIRMATION_REQUIRED" });
    }
    return this.#repository.registerServer({
      serverKey,
      displayName: boundedString(input.displayName || serverKey, "displayName", 160),
      canonicalUrl: url.toString(),
      providerAdapter,
      status,
      transport,
      allowedDomains,
      oauthConfig: normalizeOAuthConfig(input.oauthConfig, capability),
      adminNotes: String(input.adminNotes || "").trim().slice(0, 2000),
      enabled,
    });
  }

  async setServerStatus({ serverKey: rawServerKey, status: rawStatus, enabled = false } = {}) {
    const serverKey = normalizeServerKey(rawServerKey);
    const server = await this.#repository.getServerByKey({ serverKey });
    if (!server) return null;
    const status = String(rawStatus || MCP_SERVER_STATUSES.DISABLED).trim().toLowerCase();
    if (!Object.values(MCP_SERVER_STATUSES).includes(status)) throw fail("MCP server status is invalid", { code: "INVALID_MCP_SERVER_STATUS" });
    assertMcpProviderConfiguration({ providerAdapter: server.providerAdapter, transport: server.transport, status, enabled });
    if (server.transport === MCP_TRANSPORTS.SSE && status === MCP_SERVER_STATUSES.ENABLED) {
      throw fail("SSE transport is reserved for a later release; enable Streamable HTTP instead", { status: 503, code: "MCP_TRANSPORT_UNAVAILABLE" });
    }
    const nextEnabled = status === MCP_SERVER_STATUSES.ENABLED && enabled === true;
    if (status === MCP_SERVER_STATUSES.ENABLED && !nextEnabled) throw fail("An enabled MCP server must set enabled=true", { code: "MCP_ENABLE_CONFIRMATION_REQUIRED" });
    return this.#repository.setServerStatus({ serverKey, status, enabled: nextEnabled });
  }

  async upsertClientRegistration({ serverKey: rawServerKey, issuer: rawIssuer, clientId: rawClientId, clientSecret, registrationMode = "manual", metadata = {} } = {}) {
    const serverKey = normalizeServerKey(rawServerKey);
    const server = await this.#repository.getServerByKey({ serverKey });
    if (!server) throw fail("MCP server not found", { status: 404, code: "MCP_SERVER_NOT_FOUND" });
    const capability = getMcpProviderCapability(server.providerAdapter);
    if (!capability?.oauth?.clientRegistration?.includes(registrationMode)) {
      throw fail(`${capability?.displayName || "This MCP provider"} does not support this OAuth client registration mode`, {
        status: 400,
        code: "MCP_REGISTRATION_MODE_UNAVAILABLE",
      });
    }
    const issuer = await resolveAndAssertPublicMcpHost(rawIssuer, { production: this.#production, allowLoopback: this.#allowLoopback });
    const clientId = boundedString(rawClientId, "clientId", 512);
    const modes = new Set(["pre_registered", "client_id_metadata", "dynamic_registration", "manual"]);
    if (!modes.has(registrationMode)) throw fail("OAuth client registration mode is invalid", { code: "INVALID_MCP_REGISTRATION_MODE" });
    const existing = await this.#repository.getClientRegistration({ mcpServerId: server.id, issuer: issuer.toString() });
    let encryptedClientSecret = existing?.encryptedClientSecret || null;
    if (clientSecret !== undefined) {
      const secret = String(clientSecret || "");
      encryptedClientSecret = secret ? this.#vault.encrypt(secret) : null;
    }
    const registration = await this.#repository.upsertClientRegistration({
      mcpServerId: server.id,
      issuer: issuer.toString(),
      registrationMode,
      clientId,
      encryptedClientSecret,
      metadata: normalizeMetadata(metadata),
    });
    return safeRegistration(registration);
  }

  async upsertServerTool({ serverKey: rawServerKey, toolName: rawToolName, description = "", operationClass = "external_mcp", requiredRoles = ["user", "admin", "root"], approvalPolicy = "policy", inputSchema = null, metadata = {}, enabled = false } = {}) {
    const serverKey = normalizeServerKey(rawServerKey);
    const server = await this.#repository.getServerByKey({ serverKey });
    if (!server) throw fail("MCP server not found", { status: 404, code: "MCP_SERVER_NOT_FOUND" });
    const toolName = boundedString(rawToolName, "toolName", 160);
    if (!TOOL_NAME_PATTERN.test(toolName)) throw fail("MCP tool name contains unsupported characters", { code: "INVALID_MCP_TOOL_NAME" });
    const normalizedOperationClass = String(operationClass || "").trim().toLowerCase();
    if (!OPERATION_CLASSES.has(normalizedOperationClass)) throw fail("MCP tool operation class is invalid", { code: "INVALID_MCP_OPERATION_CLASS" });
    if (!Array.isArray(requiredRoles) || requiredRoles.length === 0 || requiredRoles.some((role) => !ROLES.has(String(role)))) {
      throw fail("MCP tool requiredRoles is invalid", { code: "INVALID_MCP_TOOL_ROLES" });
    }
    const normalizedApprovalPolicy = String(approvalPolicy || "").trim().toLowerCase();
    if (!new Set(["policy", "always"]).has(normalizedApprovalPolicy)) throw fail("MCP tool approvalPolicy is invalid", { code: "INVALID_MCP_TOOL_APPROVAL_POLICY" });
    return this.#repository.upsertServerTool({
      serverId: server.id,
      toolName,
      description: String(description || "").trim().slice(0, 2000),
      operationClass: normalizedOperationClass,
      requiredRoles: [...new Set(requiredRoles.map((role) => String(role)))],
      approvalPolicy: normalizedApprovalPolicy,
      inputSchema: inputSchema == null ? null : normalizeObject(inputSchema, "inputSchema", 64 * 1024),
      metadata: normalizeMetadata(metadata),
      enabled: Boolean(enabled) && server.status === MCP_SERVER_STATUSES.ENABLED && server.enabled,
    });
  }
}

export { normalizeServerKey, safeRegistration };
