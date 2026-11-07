import { createHash, randomBytes } from "node:crypto";
import { McpRepositoryPort, McpOAuthPort } from "../ports/mcpPort.js";
import {
  assertAllowedMcpHost,
  assertSafeMcpUrl,
  resolveAndAssertPublicMcpHost,
} from "./mcpSecurityService.js";

const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

const fail = (message, { status = 400, code = "MCP_OAUTH_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const tokenHash = (value) => createHash("sha256").update(String(value)).digest("hex");
const pkceChallenge = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const randomUrlToken = () => randomBytes(32).toString("base64url");

const tokenExpiry = (token, now = Date.now()) => {
  const absolute = token?.expiresAt || token?.expires_at;
  if (absolute) {
    const date = new Date(absolute);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const seconds = Number(token?.expiresIn ?? token?.expires_in);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 365 * 24 * 60 * 60) {
    return new Date(Number(now) + Math.floor(seconds * 1000));
  }
  return null;
};

const string = (value, label, max = 512) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > max) throw fail(`${label} is invalid`, { code: `INVALID_MCP_${label.toUpperCase()}` });
  return normalized;
};

const parseConfig = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const safeConnection = (connection) => ({
  id: String(connection.id),
  serverId: String(connection.mcpServerId || connection.mcp_server_id),
  serverKey: connection.serverKey || connection.server_key,
  providerAccountId: connection.providerAccountId || connection.provider_account_id,
  issuer: connection.issuer,
  resourceUri: connection.resourceUri || connection.resource_uri,
  scopes: connection.scopes || [],
  tokenType: connection.tokenType || connection.token_type || "Bearer",
  tokenExpiresAt: connection.tokenExpiresAt || connection.token_expires_at || null,
  status: connection.status,
  lastRefreshAt: connection.lastRefreshAt || connection.last_refresh_at || null,
  lastUsedAt: connection.lastUsedAt || connection.last_used_at || null,
});

/** OAuth 2.1 + MCP resource-indicator application module. */
export class McpOAuthService {
  #repository;
  #oauth;
  #vault;
  #production;
  #allowLoopback;
  #refreshes = new Map();

  constructor({ repository, oauth, vault, production = process.env.NODE_ENV === "production", allowLoopback = false } = {}) {
    if (!repository || !(repository instanceof McpRepositoryPort)
      && typeof repository.getEnabledServer !== "function") {
      throw new TypeError("McpOAuthService requires an MCP repository port");
    }
    if (!oauth || !(oauth instanceof McpOAuthPort)
      && typeof oauth.discoverProtectedResource !== "function") {
      throw new TypeError("McpOAuthService requires an MCP OAuth port");
    }
    if (!vault || typeof vault.encrypt !== "function" || typeof vault.decrypt !== "function") {
      throw new TypeError("McpOAuthService requires a credential vault port");
    }
    this.#repository = repository;
    this.#oauth = oauth;
    this.#vault = vault;
    this.#production = production;
    this.#allowLoopback = allowLoopback;
  }

  async beginConnection({ userId, serverKey, redirectUri, requestedScopes = [] } = {}) {
    const server = await this.#repository.getEnabledServer({ serverKey: string(serverKey, "serverKey", 80) });
    if (!server || server.enabled === false || server.status !== "enabled") {
      throw fail("MCP server is not enabled", { status: 404, code: "MCP_SERVER_UNAVAILABLE" });
    }
    const resource = await resolveAndAssertPublicMcpHost(server.canonicalUrl, {
      production: this.#production,
      allowLoopback: this.#allowLoopback,
    });
    const allowedDomains = Array.isArray(server.allowedDomains || server.allowed_domains)
      ? (server.allowedDomains || server.allowed_domains)
      : [];
    assertAllowedMcpHost(resource, allowedDomains);
    const resolveAllowedEndpoint = async (value, label) => {
      const endpoint = await resolveAndAssertPublicMcpHost(value, {
        production: this.#production,
        allowLoopback: this.#allowLoopback,
      });
      assertAllowedMcpHost(endpoint, allowedDomains);
      if (!endpoint) throw fail(`${label} is invalid`, { status: 503, code: "MCP_OAUTH_ENDPOINT_INVALID" });
      return endpoint.toString();
    };
    const resourceUri = resource.toString().replace(/#$/, "");
    const protectedMetadata = await this.#oauth.discoverProtectedResource({ resourceUri });
    const issuers = Array.isArray(protectedMetadata?.authorization_servers)
      ? protectedMetadata.authorization_servers : [];
    if (issuers.length === 0) throw fail("MCP protected resource did not declare an authorization server", { status: 503, code: "MCP_AUTH_SERVER_UNDISCOVERED" });
    const issuer = string(issuers[0], "issuer", 1000);
    const issuerUrl = await resolveAllowedEndpoint(issuer, "MCP issuer");
    const authMetadata = await this.#oauth.discoverAuthorizationServer({ issuer: issuerUrl.toString() });
    if (String(authMetadata?.issuer || "") !== issuerUrl) {
      throw fail("MCP authorization issuer does not match discovered issuer", { status: 503, code: "MCP_ISSUER_MISMATCH" });
    }
    const authorizationEndpoint = await resolveAllowedEndpoint(authMetadata.authorization_endpoint, "authorization endpoint");
    const tokenEndpoint = await resolveAllowedEndpoint(authMetadata.token_endpoint, "token endpoint");
    const revokeEndpoint = authMetadata.revocation_endpoint || authMetadata.revoke_endpoint
      ? await resolveAllowedEndpoint(authMetadata.revocation_endpoint || authMetadata.revoke_endpoint, "revocation endpoint")
      : null;
    const registration = await this.#repository.getClientRegistration({ mcpServerId: server.id, issuer: issuerUrl });
    if (!registration?.clientId) throw fail("MCP OAuth client is not configured for this issuer", { status: 503, code: "MCP_CLIENT_NOT_CONFIGURED" });

    const config = parseConfig(server.oauthConfig || server.oauth_config);
    const allowedScopes = Array.isArray(config.allowedScopes || config.allowed_scopes) ? (config.allowedScopes || config.allowed_scopes).map(String) : [];
    const requested = [...new Set((Array.isArray(requestedScopes) ? requestedScopes : []).map((scope) => String(scope).trim()).filter(Boolean))];
    const scopes = requested.length ? requested : allowedScopes;
    if ((requested.length && !allowedScopes.length) || scopes.some((scope) => !allowedScopes.includes(scope))) {
      throw fail("Requested MCP scopes exceed the server allowlist", { status: 403, code: "MCP_SCOPE_NOT_ALLOWED" });
    }
    const callbackUri = assertSafeMcpUrl(string(redirectUri, "redirectUri", 1000), {
      production: this.#production,
      allowLoopback: this.#allowLoopback,
    }).toString();
    const state = randomUrlToken();
    const verifier = randomUrlToken();
    const expiresAt = new Date(Date.now() + TRANSACTION_TTL_MS);
    await this.#repository.createOAuthTransaction({
      userId,
      mcpServerId: server.id,
      issuer: issuerUrl,
      resourceUri,
      authorizationEndpoint,
      tokenEndpoint,
      revokeEndpoint,
      redirectUri: callbackUri,
      stateHash: tokenHash(state),
      encryptedPkceVerifier: this.#vault.encrypt(verifier),
      clientId: registration.clientId,
      scopes,
      expiresAt,
    });
    const authorizationUrl = this.#oauth.buildAuthorizationUrl({
      authorizationEndpoint,
      clientId: registration.clientId,
      redirectUri: callbackUri,
      state,
      scope: scopes,
      resource: resourceUri,
      codeChallenge: pkceChallenge(verifier),
      codeChallengeMethod: "S256",
    });
    return { authorizationUrl, expiresAt: expiresAt.toISOString(), serverKey: server.serverKey || server.server_key };
  }

  async handleCallback({ state, code, issuer, error } = {}) {
    const rawState = string(state, "state", 512);
    const transactionResult = await this.#repository.consumeOAuthTransaction({ stateHash: tokenHash(rawState), now: new Date() });
    if (!transactionResult || transactionResult.status !== "consumed") {
      throw fail("MCP OAuth state is invalid, expired or already used", { status: 400, code: "MCP_OAUTH_STATE_INVALID" });
    }
    const transaction = transactionResult.transaction;
    if (error) throw fail("MCP OAuth authorization was denied", { status: 400, code: "MCP_OAUTH_DENIED" });
    if (!code) throw fail("MCP OAuth callback did not contain an authorization code", { status: 400, code: "MCP_OAUTH_CODE_MISSING" });
    if (issuer && String(issuer) !== String(transaction.issuer)) throw fail("MCP OAuth callback issuer mismatch", { status: 400, code: "MCP_ISSUER_MISMATCH" });
    const verifier = this.#vault.decrypt(transaction.encryptedPkceVerifier);
    const registration = await this.#repository.getClientRegistration({ mcpServerId: transaction.mcpServerId, issuer: transaction.issuer });
    const token = await this.#oauth.exchangeCode({
      code: string(code, "code", 4096),
      codeVerifier: verifier,
      clientId: transaction.clientId,
      redirectUri: transaction.redirectUri,
      tokenEndpoint: transaction.tokenEndpoint,
      resource: transaction.resourceUri,
      clientSecret: registration?.encryptedClientSecret ? this.#vault.decrypt(registration.encryptedClientSecret) : null,
    });
    const accessToken = token?.accessToken || token?.access_token;
    const refreshToken = token?.refreshToken || token?.refresh_token;
    // OAuth token responses do not universally expose an account subject.
    // Providers that do expose one retain multi-account support; otherwise
    // first release intentionally keeps one active account per user/server.
    const providerAccountId = token?.providerAccountId || token?.provider_account_id || token?.subject || token?.sub || "primary";
    if (!accessToken) throw fail("MCP OAuth token response is missing an access token", { status: 503, code: "MCP_TOKEN_RESPONSE_INVALID" });
    const connection = await this.#repository.upsertConnection({
      userId: transaction.userId,
      mcpServerId: transaction.mcpServerId,
      providerAccountId: string(providerAccountId, "providerAccountId", 255),
      issuer: transaction.issuer,
      resourceUri: transaction.resourceUri,
      tokenEndpoint: transaction.tokenEndpoint,
      revokeEndpoint: transaction.revokeEndpoint,
      encryptedAccessToken: this.#vault.encrypt(accessToken),
      encryptedRefreshToken: refreshToken ? this.#vault.encrypt(refreshToken) : null,
      tokenType: token.tokenType || token.token_type || "Bearer",
      tokenExpiresAt: tokenExpiry(token),
      scopes: token.scope ? String(token.scope).split(/\s+/).filter(Boolean) : (transaction.scopes || []),
    });
    return safeConnection(connection);
  }

  async getAccessToken({ userId, connectionId }) {
    const connection = await this.#repository.getConnection({ userId, connectionId });
    if (!connection || connection.status !== "active") throw fail("MCP connection is not active", { status: 403, code: "MCP_CONNECTION_UNAVAILABLE" });
    const expiresAt = connection.tokenExpiresAt || connection.token_expires_at;
    if (!expiresAt || new Date(expiresAt).getTime() > Date.now() + REFRESH_SKEW_MS) {
      return { accessToken: this.#vault.decrypt(connection.encryptedAccessToken), resourceUri: connection.resourceUri || connection.resource_uri, connection: safeConnection(connection) };
    }
    const key = `${userId}:${connection.id}`;
    if (!this.#refreshes.has(key)) {
      this.#refreshes.set(key, this.#refreshConnection(connection).finally(() => this.#refreshes.delete(key)));
    }
    const refreshed = await this.#refreshes.get(key);
    return { accessToken: refreshed.accessToken, resourceUri: refreshed.resourceUri, connection: safeConnection(refreshed.connection) };
  }

  async #refreshConnection(connection) {
    if (!connection.encryptedRefreshToken) throw fail("MCP connection requires reauthorization", { status: 401, code: "MCP_REAUTH_REQUIRED" });
    const refreshToken = this.#vault.decrypt(connection.encryptedRefreshToken);
    try {
      const registration = await this.#repository.getClientRegistration({ mcpServerId: connection.mcpServerId || connection.mcp_server_id, issuer: connection.issuer });
      const token = await this.#oauth.refreshToken({
        refreshToken,
        tokenEndpoint: connection.tokenEndpoint || connection.token_endpoint,
        issuer: connection.issuer,
        resource: connection.resourceUri || connection.resource_uri,
        clientId: registration?.clientId,
        clientSecret: registration?.encryptedClientSecret ? this.#vault.decrypt(registration.encryptedClientSecret) : null,
      });
      const accessToken = token?.accessToken || token?.access_token;
      if (!accessToken) throw fail("MCP refresh response is invalid", { status: 503, code: "MCP_REFRESH_INVALID" });
      const nextRefresh = token?.refreshToken || token?.refresh_token || refreshToken;
      const updated = await this.#repository.updateConnectionTokens({
        id: connection.id,
        userId: connection.userId || connection.user_id,
        encryptedAccessToken: this.#vault.encrypt(accessToken),
        encryptedRefreshToken: this.#vault.encrypt(nextRefresh),
        tokenExpiresAt: tokenExpiry(token),
      });
      return { accessToken, resourceUri: updated.resourceUri || updated.resource_uri, connection: updated };
    } catch (error) {
      if (error.code === "invalid_grant" || error.oauthError === "invalid_grant") {
        await this.#repository.markConnectionError({ id: connection.id, userId: connection.userId || connection.user_id, code: "MCP_INVALID_GRANT", message: "MCP refresh token is no longer valid" });
        throw fail("MCP connection requires reauthorization", { status: 401, code: "MCP_REAUTH_REQUIRED" });
      }
      throw error;
    }
  }

  async revoke({ userId, connectionId }) {
    const connection = await this.#repository.getConnection({ userId, connectionId });
    if (!connection) throw fail("MCP connection not found", { status: 404, code: "MCP_CONNECTION_NOT_FOUND" });
    const token = connection.encryptedRefreshToken ? this.#vault.decrypt(connection.encryptedRefreshToken) : this.#vault.decrypt(connection.encryptedAccessToken);
    try {
      if (connection.revokeEndpoint) await this.#oauth.revokeToken({ revokeEndpoint: connection.revokeEndpoint, token, tokenTypeHint: connection.encryptedRefreshToken ? "refresh_token" : "access_token" });
    } finally {
      await this.#repository.revokeConnection({ id: connection.id, userId });
    }
    return { revoked: true, connectionId: String(connection.id) };
  }
}

export const mcpPkceChallenge = pkceChallenge;
export const hashMcpOAuthState = tokenHash;
export const resolveMcpTokenExpiry = tokenExpiry;
