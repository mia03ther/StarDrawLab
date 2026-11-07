import sql from "../configs/db.js";
import { McpRepositoryPort } from "../ports/mcpPort.js";

const mapServer = (row) => row ? ({
  id: String(row.id),
  serverKey: row.server_key,
  displayName: row.display_name,
  canonicalUrl: row.canonical_url,
  providerAdapter: row.provider_adapter,
  status: row.status,
  transport: row.transport,
  allowedDomains: row.allowed_domains || [],
  oauthConfig: row.oauth_config || {},
  discoveryCache: row.discovery_cache || {},
  enabled: Boolean(row.enabled),
}) : null;

const mapRegistration = (row) => row ? ({
  id: String(row.id),
  mcpServerId: String(row.mcp_server_id),
  issuer: row.issuer,
  registrationMode: row.registration_mode,
  clientId: row.client_id,
  encryptedClientSecret: row.encrypted_client_secret,
  metadata: row.metadata || {},
  status: row.status,
}) : null;

const mapTransaction = (row) => row ? ({
  id: String(row.id),
  userId: row.user_id,
  mcpServerId: String(row.mcp_server_id),
  issuer: row.issuer,
  resourceUri: row.resource_uri,
  authorizationEndpoint: row.authorization_endpoint,
  tokenEndpoint: row.token_endpoint,
  revokeEndpoint: row.revoke_endpoint,
  redirectUri: row.redirect_uri,
  stateHash: row.state_hash,
  encryptedPkceVerifier: row.encrypted_pkce_verifier,
  clientId: row.client_id,
  scopes: row.scopes || [],
  status: row.status,
  expiresAt: row.expires_at,
  usedAt: row.used_at,
}) : null;

const mapConnection = (row) => row ? ({
  id: String(row.id),
  userId: row.user_id,
  mcpServerId: String(row.mcp_server_id),
  serverKey: row.server_key,
  providerAccountId: row.provider_account_id,
  issuer: row.issuer,
  resourceUri: row.resource_uri,
  tokenEndpoint: row.token_endpoint,
  revokeEndpoint: row.revoke_endpoint,
  encryptedAccessToken: row.encrypted_access_token,
  encryptedRefreshToken: row.encrypted_refresh_token,
  tokenType: row.token_type,
  tokenExpiresAt: row.token_expires_at,
  scopes: row.scopes || [],
  status: row.status,
  lastRefreshAt: row.last_refresh_at,
  lastUsedAt: row.last_used_at,
  lastErrorCode: row.last_error_code,
  lastErrorMessage: row.last_error_message,
}) : null;

const mapTool = (row) => row ? ({
  id: String(row.id),
  serverId: String(row.server_id),
  toolName: row.tool_name,
  description: row.description || "",
  operationClass: row.operation_class,
  requiredRoles: row.required_roles || [],
  approvalPolicy: row.approval_policy,
  inputSchema: row.input_schema || null,
  metadata: row.metadata || {},
  enabled: Boolean(row.enabled),
}) : null;

export class PostgresMcpRepository extends McpRepositoryPort {
  #sql;

  constructor({ sqlClient = sql } = {}) {
    super();
    if (!sqlClient || typeof sqlClient.begin !== "function") throw new TypeError("PostgresMcpRepository requires a SQL client");
    this.#sql = sqlClient;
  }

  async getEnabledServer({ serverKey }) {
    const [row] = await this.#sql`
      SELECT id, server_key, display_name, canonical_url, provider_adapter, status,
             transport, allowed_domains, oauth_config, discovery_cache, enabled
      FROM mcp_servers
      WHERE server_key = ${serverKey} AND enabled = TRUE AND status = 'enabled'
      LIMIT 1
    `;
    return mapServer(row);
  }

  async getServerByKey({ serverKey }) {
    const [row] = await this.#sql`
      SELECT id, server_key, display_name, canonical_url, provider_adapter, status,
             transport, allowed_domains, oauth_config, discovery_cache, enabled
      FROM mcp_servers WHERE server_key = ${serverKey} LIMIT 1
    `;
    return mapServer(row);
  }

  async getServerById({ serverId }) {
    const [row] = await this.#sql`
      SELECT id, server_key, display_name, canonical_url, provider_adapter, status,
             transport, allowed_domains, oauth_config, discovery_cache, enabled
      FROM mcp_servers WHERE id = ${serverId} LIMIT 1
    `;
    return mapServer(row);
  }

  async listEnabledServers() {
    const rows = await this.#sql`
      SELECT id, server_key, display_name, canonical_url, provider_adapter, status,
             transport, allowed_domains, oauth_config, discovery_cache, enabled
      FROM mcp_servers WHERE enabled = TRUE AND status = 'enabled'
      ORDER BY display_name ASC, id ASC
    `;
    return rows.map(mapServer).map((server) => ({
      id: server.id,
      serverKey: server.serverKey,
      displayName: server.displayName,
      providerAdapter: server.providerAdapter,
      status: server.status,
      transport: server.transport,
    }));
  }

  async listAllServers() {
    const rows = await this.#sql`
      SELECT id, server_key, display_name, canonical_url, provider_adapter, status,
             transport, allowed_domains, oauth_config, discovery_cache, enabled
      FROM mcp_servers ORDER BY created_at ASC, id ASC
    `;
    return rows.map(mapServer);
  }

  async registerServer(record) {
    const [row] = await this.#sql`
      INSERT INTO mcp_servers
        (server_key, display_name, canonical_url, provider_adapter, status,
         transport, allowed_domains, oauth_config, admin_notes, enabled)
      VALUES
        (${record.serverKey}, ${record.displayName}, ${record.canonicalUrl}, ${record.providerAdapter},
         ${record.status || "draft"}, ${record.transport || "streamable_http"}, ${record.allowedDomains || []},
         ${JSON.stringify(record.oauthConfig || {})}::jsonb, ${record.adminNotes || null}, ${Boolean(record.enabled)})
      ON CONFLICT (server_key) DO UPDATE
      SET display_name = EXCLUDED.display_name, canonical_url = EXCLUDED.canonical_url,
          provider_adapter = EXCLUDED.provider_adapter, status = EXCLUDED.status,
          transport = EXCLUDED.transport, allowed_domains = EXCLUDED.allowed_domains,
          oauth_config = EXCLUDED.oauth_config, admin_notes = EXCLUDED.admin_notes,
          enabled = EXCLUDED.enabled, updated_at = NOW()
      RETURNING id, server_key, display_name, canonical_url, provider_adapter, status,
                transport, allowed_domains, oauth_config, discovery_cache, enabled
    `;
    return mapServer(row);
  }

  async setServerStatus({ serverKey, status, enabled }) {
    const [row] = await this.#sql`
      UPDATE mcp_servers SET status = ${status}, enabled = ${Boolean(enabled)}, updated_at = NOW()
      WHERE server_key = ${serverKey}
      RETURNING id, server_key, display_name, canonical_url, provider_adapter, status,
                transport, allowed_domains, oauth_config, discovery_cache, enabled
    `;
    return mapServer(row);
  }

  async listServerTools({ serverId, includeDisabled = true }) {
    const rows = await this.#sql`
      SELECT id, server_id, tool_name, description, operation_class,
             required_roles, approval_policy, input_schema, metadata, enabled
      FROM mcp_server_tools
      WHERE server_id = ${serverId}
        AND (${Boolean(includeDisabled)} = TRUE OR enabled = TRUE)
      ORDER BY tool_name ASC, id ASC
    `;
    return rows.map(mapTool);
  }

  async getEnabledTool({ serverId, toolName }) {
    const [row] = await this.#sql`
      SELECT id, server_id, tool_name, description, operation_class,
             required_roles, approval_policy, input_schema, metadata, enabled
      FROM mcp_server_tools
      WHERE server_id = ${serverId} AND tool_name = ${toolName} AND enabled = TRUE
      LIMIT 1
    `;
    return mapTool(row);
  }

  async upsertServerTool(record) {
    const [row] = await this.#sql`
      INSERT INTO mcp_server_tools
        (server_id, tool_name, description, operation_class, required_roles,
         approval_policy, input_schema, metadata, enabled)
      VALUES
        (${record.serverId}, ${record.toolName}, ${record.description || ""},
         ${record.operationClass || "external_mcp"}, ${record.requiredRoles || ["user", "admin", "root"]},
         ${record.approvalPolicy || "policy"}, ${record.inputSchema ? JSON.stringify(record.inputSchema) : null}::jsonb,
         ${JSON.stringify(record.metadata || {})}::jsonb, ${Boolean(record.enabled)})
      ON CONFLICT (server_id, tool_name) DO UPDATE
      SET description = EXCLUDED.description, operation_class = EXCLUDED.operation_class,
          required_roles = EXCLUDED.required_roles, approval_policy = EXCLUDED.approval_policy,
          input_schema = EXCLUDED.input_schema, metadata = EXCLUDED.metadata,
          enabled = EXCLUDED.enabled, updated_at = NOW()
      RETURNING id, server_id, tool_name, description, operation_class,
                required_roles, approval_policy, input_schema, metadata, enabled
    `;
    return mapTool(row);
  }

  async getClientRegistration({ mcpServerId, issuer }) {
    const [row] = await this.#sql`
      SELECT id, mcp_server_id, issuer, registration_mode, client_id,
             encrypted_client_secret, metadata, status
      FROM oauth_client_registrations
      WHERE mcp_server_id = ${mcpServerId} AND issuer = ${issuer} AND status = 'active'
      LIMIT 1
    `;
    return mapRegistration(row);
  }

  async upsertClientRegistration(record) {
    const [row] = await this.#sql`
      INSERT INTO oauth_client_registrations
        (mcp_server_id, issuer, registration_mode, client_id, encrypted_client_secret, metadata, status)
      VALUES
        (${record.mcpServerId}, ${record.issuer}, ${record.registrationMode}, ${record.clientId},
         ${record.encryptedClientSecret || null}, ${JSON.stringify(record.metadata || {})}::jsonb, 'active')
      ON CONFLICT (mcp_server_id, issuer) DO UPDATE
      SET registration_mode = EXCLUDED.registration_mode, client_id = EXCLUDED.client_id,
          encrypted_client_secret = EXCLUDED.encrypted_client_secret, metadata = EXCLUDED.metadata,
          status = 'active', updated_at = NOW()
      RETURNING id, mcp_server_id, issuer, registration_mode, client_id,
                encrypted_client_secret, metadata, status
    `;
    return mapRegistration(row);
  }

  async createOAuthTransaction(record) {
    const [row] = await this.#sql`
      INSERT INTO mcp_oauth_transactions
        (user_id, mcp_server_id, issuer, resource_uri, authorization_endpoint,
         token_endpoint, revoke_endpoint, redirect_uri, state_hash,
         encrypted_pkce_verifier, client_id, scopes, expires_at)
      VALUES
        (${record.userId}, ${record.mcpServerId}, ${record.issuer}, ${record.resourceUri},
         ${record.authorizationEndpoint}, ${record.tokenEndpoint}, ${record.revokeEndpoint || null},
         ${record.redirectUri}, ${record.stateHash}, ${record.encryptedPkceVerifier},
         ${record.clientId}, ${record.scopes || []}, ${record.expiresAt})
      RETURNING id, user_id, mcp_server_id, issuer, resource_uri, authorization_endpoint,
                token_endpoint, revoke_endpoint, redirect_uri, state_hash,
                encrypted_pkce_verifier, client_id, scopes, status, expires_at, used_at
    `;
    return mapTransaction(row);
  }

  async consumeOAuthTransaction({ stateHash, now }) {
    return this.#sql.begin(async (tx) => {
      const [row] = await tx`
        SELECT id, user_id, mcp_server_id, issuer, resource_uri, authorization_endpoint,
               token_endpoint, revoke_endpoint, redirect_uri, state_hash,
               encrypted_pkce_verifier, client_id, scopes, status, expires_at, used_at
        FROM mcp_oauth_transactions WHERE state_hash = ${stateHash} FOR UPDATE
      `;
      if (!row) return { status: "not_found", transaction: null };
      const transaction = mapTransaction(row);
      if (transaction.status !== "pending") return { status: transaction.status, transaction };
      if (new Date(transaction.expiresAt).getTime() <= new Date(now).getTime()) {
        const [expired] = await tx`
          UPDATE mcp_oauth_transactions
          SET status = 'expired', failure_reason = 'oauth transaction expired'
          WHERE id = ${row.id} AND status = 'pending'
          RETURNING id, user_id, mcp_server_id, issuer, resource_uri, authorization_endpoint,
                    token_endpoint, revoke_endpoint, redirect_uri, state_hash,
                    encrypted_pkce_verifier, client_id, scopes, status, expires_at, used_at
        `;
        return { status: "expired", transaction: mapTransaction(expired || row) };
      }
      const [used] = await tx`
        UPDATE mcp_oauth_transactions
        SET status = 'used', used_at = ${now}
        WHERE id = ${row.id} AND status = 'pending'
        RETURNING id, user_id, mcp_server_id, issuer, resource_uri, authorization_endpoint,
                  token_endpoint, revoke_endpoint, redirect_uri, state_hash,
                  encrypted_pkce_verifier, client_id, scopes, status, expires_at, used_at
      `;
      return used
        ? { status: "consumed", transaction: mapTransaction(used) }
        : { status: "used", transaction };
    });
  }

  async upsertConnection(record) {
    const [row] = await this.#sql`
      INSERT INTO mcp_connections
        (user_id, mcp_server_id, provider_account_id, issuer, resource_uri,
         token_endpoint, revoke_endpoint, encrypted_access_token,
         encrypted_refresh_token, token_type, token_expires_at, scopes, status,
         last_refresh_at, revoked_at, last_error_code, last_error_message)
      VALUES
        (${record.userId}, ${record.mcpServerId}, ${record.providerAccountId}, ${record.issuer}, ${record.resourceUri},
         ${record.tokenEndpoint || null}, ${record.revokeEndpoint || null}, ${record.encryptedAccessToken},
         ${record.encryptedRefreshToken || null}, ${record.tokenType || "Bearer"}, ${record.tokenExpiresAt || null},
         ${record.scopes || []}, 'active', NOW(), NULL, NULL, NULL)
      ON CONFLICT (user_id, mcp_server_id, provider_account_id) DO UPDATE
      SET issuer = EXCLUDED.issuer, resource_uri = EXCLUDED.resource_uri,
          token_endpoint = EXCLUDED.token_endpoint, revoke_endpoint = EXCLUDED.revoke_endpoint,
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          token_type = EXCLUDED.token_type, token_expires_at = EXCLUDED.token_expires_at,
          scopes = EXCLUDED.scopes, status = 'active', last_refresh_at = NOW(),
          revoked_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
      RETURNING id, user_id, mcp_server_id, provider_account_id, issuer, resource_uri,
                token_endpoint, revoke_endpoint, encrypted_access_token,
                encrypted_refresh_token, token_type, token_expires_at, scopes, status,
                last_refresh_at, last_used_at, last_error_code, last_error_message
    `;
    return mapConnection(row);
  }

  async getConnection({ userId, connectionId }) {
    const [row] = await this.#sql`
      SELECT c.id, c.user_id, c.mcp_server_id, s.server_key, c.provider_account_id,
             c.issuer, c.resource_uri, c.token_endpoint, c.revoke_endpoint,
             c.encrypted_access_token, c.encrypted_refresh_token, c.token_type,
             c.token_expires_at, c.scopes, c.status, c.last_refresh_at, c.last_used_at,
             c.last_error_code, c.last_error_message
      FROM mcp_connections c
      JOIN mcp_servers s ON s.id = c.mcp_server_id
      WHERE c.id = ${connectionId} AND c.user_id = ${userId}
      LIMIT 1
    `;
    return mapConnection(row);
  }

  async listConnections({ userId }) {
    const rows = await this.#sql`
      SELECT c.id, c.user_id, c.mcp_server_id, s.server_key, c.provider_account_id,
             c.issuer, c.resource_uri, c.token_endpoint, c.revoke_endpoint,
             c.encrypted_access_token, c.encrypted_refresh_token, c.token_type,
             c.token_expires_at, c.scopes, c.status, c.last_refresh_at, c.last_used_at,
             c.last_error_code, c.last_error_message
      FROM mcp_connections c
      JOIN mcp_servers s ON s.id = c.mcp_server_id
      WHERE c.user_id = ${userId} AND c.status <> 'revoked'
      ORDER BY c.updated_at DESC, c.id DESC
    `;
    return rows.map(mapConnection).map((connection) => ({
      id: connection.id,
      serverKey: connection.serverKey,
      providerAccountId: connection.providerAccountId,
      issuer: connection.issuer,
      resourceUri: connection.resourceUri,
      scopes: connection.scopes,
      status: connection.status,
      tokenExpiresAt: connection.tokenExpiresAt,
      lastRefreshAt: connection.lastRefreshAt,
      lastUsedAt: connection.lastUsedAt,
    }));
  }

  async updateConnectionTokens({ id, userId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt }) {
    const [row] = await this.#sql`
      UPDATE mcp_connections c
      SET encrypted_access_token = ${encryptedAccessToken},
          encrypted_refresh_token = ${encryptedRefreshToken || null},
          token_expires_at = ${tokenExpiresAt || null}, status = 'active',
          last_refresh_at = NOW(), last_used_at = NOW(), last_error_code = NULL,
          last_error_message = NULL, updated_at = NOW()
      WHERE c.id = ${id} AND c.user_id = ${userId} AND c.status <> 'revoked'
      RETURNING c.id, c.user_id, c.mcp_server_id, c.provider_account_id, c.issuer,
                c.resource_uri, c.token_endpoint, c.revoke_endpoint,
                c.encrypted_access_token, c.encrypted_refresh_token, c.token_type,
                c.token_expires_at, c.scopes, c.status, c.last_refresh_at,
                c.last_used_at, c.last_error_code, c.last_error_message
    `;
    if (!row) throw Object.assign(new Error("MCP connection was revoked during refresh"), { status: 401, code: "MCP_CONNECTION_UNAVAILABLE" });
    return mapConnection(row);
  }

  async markConnectionError({ id, userId, code, message }) {
    await this.#sql`
      UPDATE mcp_connections
      SET status = 'error', last_error_code = ${code}, last_error_message = ${String(message || "").slice(0, 1000)}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId} AND status <> 'revoked'
    `;
  }

  async revokeConnection({ id, userId }) {
    await this.#sql`
      UPDATE mcp_connections
      SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  async appendCallAudit(record) {
    const [row] = await this.#sql`
      INSERT INTO mcp_call_audit
        (user_id, mcp_server_id, connection_id, tool_name, parameter_digest,
         approval_id, outcome, status_code, latency_ms, error_code, metadata)
      VALUES
        (${record.userId}, ${record.mcpServerId}, ${record.connectionId || null},
         ${record.toolName}, ${record.parameterDigest || null}, ${record.approvalId || null},
         ${record.outcome}, ${record.statusCode || null}, ${record.latencyMs || null},
         ${record.errorCode || null}, ${JSON.stringify(record.metadata || {})}::jsonb)
      RETURNING id, created_at
    `;
    return row;
  }

  async listCallAudit({ userId = null, serverKey = null, toolName = null, limit = 100 } = {}) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.#sql`
      SELECT a.id, a.user_id, s.server_key, a.connection_id, a.tool_name,
             a.parameter_digest, a.approval_id, a.outcome, a.status_code,
             a.latency_ms, a.error_code, a.metadata, a.created_at
      FROM mcp_call_audit a
      JOIN mcp_servers s ON s.id = a.mcp_server_id
      WHERE (${userId}::varchar IS NULL OR a.user_id = ${userId})
        AND (${serverKey}::varchar IS NULL OR s.server_key = ${serverKey})
        AND (${toolName}::varchar IS NULL OR a.tool_name = ${toolName})
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${safeLimit}
    `;
  }
}
