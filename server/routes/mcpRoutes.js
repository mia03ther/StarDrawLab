import express from "express";
import {
  getMcpConfigurationRuntime,
  getMcpOAuthRuntime,
  getMcpToolRuntime,
  getMcpRepository,
} from "../services/mcpRuntimeComposition.js";
import {
  getMcpProviderCapability,
  listMcpProviderCapabilities,
} from "../services/mcpConfigurationService.js";

export const mcpRouter = express.Router();
export const publicMcpOAuthRouter = express.Router();
export const rootMcpRouter = express.Router();
export const adminMcpRouter = express.Router();

const fail = (res, error, fallback) => res.status(error.status || 500).json({
  success: false,
  code: error.code || "MCP_REQUEST_FAILED",
  message: (error.status || process.env.NODE_ENV !== "production") ? error.message : fallback,
});

const configuredRedirectUri = () => {
  const value = String(process.env.MCP_OAUTH_REDIRECT_URI || "").trim();
  if (!value) throw Object.assign(new Error("MCP_OAUTH_REDIRECT_URI is not configured"), { status: 503, code: "MCP_REDIRECT_NOT_CONFIGURED" });
  return value;
};

const safeServer = (server) => ({
  id: String(server.id),
  serverKey: server.serverKey,
  displayName: server.displayName,
  providerAdapter: server.providerAdapter,
  status: server.status,
  transport: server.transport,
  allowedDomains: server.allowedDomains || [],
  oauthConfig: {
    allowedScopes: Array.isArray(server.oauthConfig?.allowedScopes)
      ? server.oauthConfig.allowedScopes
      : (Array.isArray(server.oauthConfig?.allowed_scopes) ? server.oauthConfig.allowed_scopes : []),
  },
  enabled: Boolean(server.enabled),
  capability: getMcpProviderCapability(server.providerAdapter),
});

const safeRootServer = (server) => ({
  ...safeServer(server),
  canonicalUrl: server.canonicalUrl,
});

const safeTool = (tool) => ({
  id: String(tool.id),
  serverId: String(tool.serverId),
  toolName: tool.toolName,
  description: tool.description,
  operationClass: tool.operationClass,
  requiredRoles: tool.requiredRoles,
  approvalPolicy: tool.approvalPolicy,
  inputSchema: tool.inputSchema,
  enabled: Boolean(tool.enabled),
});

mcpRouter.get("/servers", async (req, res) => {
  try {
    const servers = await getMcpRepository().listEnabledServers();
    return res.json({ success: true, data: servers.map(safeServer) });
  } catch (error) {
    return fail(res, error, "Unable to list MCP servers");
  }
});

mcpRouter.get("/providers", async (req, res) => {
  return res.json({
    success: true,
    data: listMcpProviderCapabilities().filter((item) => item.admission === "supported"),
  });
});

mcpRouter.get("/connections", async (req, res) => {
  try {
    const connections = await getMcpRepository().listConnections({ userId: req.auth.userId });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: connections });
  } catch (error) {
    return fail(res, error, "Unable to list MCP connections");
  }
});

mcpRouter.post("/connections/start", async (req, res) => {
  try {
    const data = await getMcpOAuthRuntime().beginConnection({
      userId: req.auth.userId,
      serverKey: req.body?.serverKey || req.body?.server_key,
      requestedScopes: req.body?.scopes,
      redirectUri: configuredRedirectUri(),
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to start MCP authorization");
  }
});

mcpRouter.post("/connections/:connectionId/revoke", async (req, res) => {
  try {
    const data = await getMcpOAuthRuntime().revoke({ userId: req.auth.userId, connectionId: req.params.connectionId });
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to revoke MCP connection");
  }
});

mcpRouter.get("/connections/:connectionId/tools", async (req, res) => {
  try {
    const data = await getMcpToolRuntime().listAllowedTools({
      userId: req.auth.userId,
      userRole: req.auth.role,
      connectionId: req.params.connectionId,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to list MCP tools");
  }
});

publicMcpOAuthRouter.get("/oauth/callback", async (req, res) => {
  try {
    const data = await getMcpOAuthRuntime().handleCallback({
      state: req.query.state,
      code: req.query.code,
      issuer: req.query.iss,
      error: req.query.error,
    });
    const target = String(process.env.MCP_OAUTH_SUCCESS_REDIRECT || "/ai/account").trim();
    // Only redirect to a server-configured URL; the provider cannot choose it.
    return res.redirect(`${target}${target.includes("?") ? "&" : "?"}mcp_connected=1&connection_id=${encodeURIComponent(data.id)}`);
  } catch (error) {
    const target = String(process.env.MCP_OAUTH_ERROR_REDIRECT || "/ai/account").trim();
    return res.redirect(`${target}${target.includes("?") ? "&" : "?"}mcp_error=${encodeURIComponent(error.code || "MCP_OAUTH_FAILED")}`);
  }
});

rootMcpRouter.get("/servers", async (req, res) => {
  try {
    // Root UI receives metadata needed for configuration, never client secrets.
    const rows = await getMcpRepository().listAllServers();
    return res.json({ success: true, data: rows.map(safeRootServer) });
  } catch (error) {
    return fail(res, error, "Unable to list MCP server configuration");
  }
});

rootMcpRouter.get("/providers", async (req, res) => {
  return res.json({ success: true, data: listMcpProviderCapabilities() });
});

rootMcpRouter.post("/servers", async (req, res) => {
  try {
    const data = await getMcpConfigurationRuntime().registerServer({
      ...req.body,
      canonicalUrl: req.body?.canonicalUrl || req.body?.canonical_url,
      providerAdapter: req.body?.providerAdapter || req.body?.provider_adapter,
    });
    return res.status(201).json({ success: true, data: safeRootServer(data) });
  } catch (error) {
    return fail(res, error, "Unable to register MCP server");
  }
});

rootMcpRouter.patch("/servers/:serverKey/status", async (req, res) => {
  try {
    const data = await getMcpConfigurationRuntime().setServerStatus({
      serverKey: req.params.serverKey,
      status: String(req.body?.status || "disabled"),
      enabled: Boolean(req.body?.enabled),
    });
    if (!data) return res.status(404).json({ success: false, code: "MCP_SERVER_NOT_FOUND", message: "MCP server not found" });
    return res.json({ success: true, data: safeRootServer(data) });
  } catch (error) {
    return fail(res, error, "Unable to change MCP server status");
  }
});

rootMcpRouter.post("/servers/:serverKey/oauth-clients", async (req, res) => {
  try {
    const data = await getMcpConfigurationRuntime().upsertClientRegistration({
      serverKey: req.params.serverKey,
      issuer: req.body?.issuer,
      clientId: req.body?.clientId || req.body?.client_id,
      clientSecret: req.body?.clientSecret ?? req.body?.client_secret,
      registrationMode: req.body?.registrationMode || req.body?.registration_mode,
      metadata: req.body?.metadata || {},
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return fail(res, error, "Unable to configure MCP OAuth client");
  }
});

rootMcpRouter.get("/audit", async (req, res) => {
  try {
    const rows = await getMcpRepository().listCallAudit({
      userId: req.query?.userId || req.query?.user_id || null,
      serverKey: req.query?.serverKey || req.query?.server_key || null,
      toolName: req.query?.toolName || req.query?.tool_name || null,
      limit: req.query?.limit,
    });
    // Parameter values are never stored; parameter_digest is safe to expose
    // only to root for incident correlation and billing reconciliation.
    return res.json({ success: true, data: rows });
  } catch (error) {
    return fail(res, error, "Unable to list MCP audit records");
  }
});

adminMcpRouter.get("/servers", async (req, res) => {
  try {
    const rows = await getMcpRepository().listAllServers();
    return res.json({ success: true, data: rows.map(safeServer) });
  } catch (error) {
    return fail(res, error, "Unable to list MCP servers");
  }
});

adminMcpRouter.get("/providers", async (req, res) => {
  return res.json({
    success: true,
    data: listMcpProviderCapabilities().map((item) => ({
      providerAdapter: item.providerAdapter,
      displayName: item.displayName,
      admission: item.admission,
      reasonCode: item.reasonCode,
      supportedTransports: item.supportedTransports,
      oauth: item.oauth,
    })),
  });
});

adminMcpRouter.get("/servers/:serverKey/tools", async (req, res) => {
  try {
    const server = await getMcpRepository().getServerByKey({ serverKey: req.params.serverKey });
    if (!server) return res.status(404).json({ success: false, code: "MCP_SERVER_NOT_FOUND", message: "MCP server not found" });
    const rows = await getMcpRepository().listServerTools({ serverId: server.id, includeDisabled: true });
    return res.json({ success: true, data: rows.map(safeTool) });
  } catch (error) {
    return fail(res, error, "Unable to list MCP tool allowlist");
  }
});

adminMcpRouter.put("/servers/:serverKey/tools/:toolName", async (req, res) => {
  try {
    const data = await getMcpConfigurationRuntime().upsertServerTool({
      serverKey: req.params.serverKey,
      toolName: req.params.toolName,
      description: req.body?.description,
      operationClass: req.body?.operationClass || req.body?.operation_class,
      requiredRoles: req.body?.requiredRoles || req.body?.required_roles,
      approvalPolicy: req.body?.approvalPolicy || req.body?.approval_policy,
      inputSchema: req.body?.inputSchema || req.body?.input_schema,
      metadata: req.body?.metadata || {},
      enabled: req.body?.enabled === true,
    });
    return res.json({ success: true, data: safeTool(data) });
  } catch (error) {
    return fail(res, error, "Unable to update MCP tool allowlist");
  }
});

export default mcpRouter;
