/** Provider-neutral seams for MCP registration, OAuth and transport. */
export const MCP_SERVER_STATUSES = Object.freeze({
  DRAFT: "draft",
  ENABLED: "enabled",
  DISABLED: "disabled",
  CATALOG_PENDING: "catalog_pending",
});

export const MCP_CONNECTION_STATUSES = Object.freeze({
  ACTIVE: "active",
  REVOKED: "revoked",
  ERROR: "error",
});

export const MCP_TRANSPORTS = Object.freeze({
  STREAMABLE_HTTP: "streamable_http",
  SSE: "sse",
});

export class McpOAuthPort {
  async discoverProtectedResource() { throw new Error("McpOAuthPort.discoverProtectedResource is not implemented"); }
  async discoverAuthorizationServer() { throw new Error("McpOAuthPort.discoverAuthorizationServer is not implemented"); }
  buildAuthorizationUrl() { throw new Error("McpOAuthPort.buildAuthorizationUrl is not implemented"); }
  async exchangeCode() { throw new Error("McpOAuthPort.exchangeCode is not implemented"); }
  async refreshToken() { throw new Error("McpOAuthPort.refreshToken is not implemented"); }
  async revokeToken() { throw new Error("McpOAuthPort.revokeToken is not implemented"); }
}

export class McpTransportPort {
  async initialize() { throw new Error("McpTransportPort.initialize is not implemented"); }
  async listTools() { throw new Error("McpTransportPort.listTools is not implemented"); }
  async callTool() { throw new Error("McpTransportPort.callTool is not implemented"); }
}

export class CredentialVaultPort {
  encrypt() { throw new Error("CredentialVaultPort.encrypt is not implemented"); }
  decrypt() { throw new Error("CredentialVaultPort.decrypt is not implemented"); }
}

export class McpRepositoryPort {
  async getEnabledServer() { throw new Error("McpRepositoryPort.getEnabledServer is not implemented"); }
  async getServerByKey() { throw new Error("McpRepositoryPort.getServerByKey is not implemented"); }
  async getServerById() { throw new Error("McpRepositoryPort.getServerById is not implemented"); }
  async listEnabledServers() { throw new Error("McpRepositoryPort.listEnabledServers is not implemented"); }
  async listAllServers() { throw new Error("McpRepositoryPort.listAllServers is not implemented"); }
  async registerServer() { throw new Error("McpRepositoryPort.registerServer is not implemented"); }
  async setServerStatus() { throw new Error("McpRepositoryPort.setServerStatus is not implemented"); }
  async listServerTools() { throw new Error("McpRepositoryPort.listServerTools is not implemented"); }
  async getEnabledTool() { throw new Error("McpRepositoryPort.getEnabledTool is not implemented"); }
  async upsertServerTool() { throw new Error("McpRepositoryPort.upsertServerTool is not implemented"); }
  async getClientRegistration() { throw new Error("McpRepositoryPort.getClientRegistration is not implemented"); }
  async upsertClientRegistration() { throw new Error("McpRepositoryPort.upsertClientRegistration is not implemented"); }
  async createOAuthTransaction() { throw new Error("McpRepositoryPort.createOAuthTransaction is not implemented"); }
  async consumeOAuthTransaction() { throw new Error("McpRepositoryPort.consumeOAuthTransaction is not implemented"); }
  async upsertConnection() { throw new Error("McpRepositoryPort.upsertConnection is not implemented"); }
  async getConnection() { throw new Error("McpRepositoryPort.getConnection is not implemented"); }
  async updateConnectionTokens() { throw new Error("McpRepositoryPort.updateConnectionTokens is not implemented"); }
  async markConnectionError() { throw new Error("McpRepositoryPort.markConnectionError is not implemented"); }
  async revokeConnection() { throw new Error("McpRepositoryPort.revokeConnection is not implemented"); }
  async appendCallAudit() { throw new Error("McpRepositoryPort.appendCallAudit is not implemented"); }
  async listCallAudit() { throw new Error("McpRepositoryPort.listCallAudit is not implemented"); }
}
