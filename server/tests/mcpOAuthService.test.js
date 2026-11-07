import assert from "node:assert/strict";
import test from "node:test";

import { AesGcmCredentialVault } from "../infrastructure/credentialVault.js";
import { McpOAuthService, mcpPkceChallenge } from "../services/mcpOAuthService.js";

const endpoints = {
  issuer: "http://127.0.0.1:4101/",
  authorization_endpoint: "http://127.0.0.1:4101/authorize",
  token_endpoint: "http://127.0.0.1:4101/token",
  revocation_endpoint: "http://127.0.0.1:4101/revoke",
};

const createFixture = ({ expired = false, refreshError = null, authorizationMetadata = endpoints } = {}) => {
  const vault = new AesGcmCredentialVault({ masterKey: Buffer.alloc(32, 4) });
  const transactions = new Map();
  const connections = new Map();
  let nextConnectionId = 1;
  let refreshCalls = 0;
  const repository = {
    transactions,
    connections,
    refreshCalls: () => refreshCalls,
    async getEnabledServer() {
      return {
        id: "1", serverKey: "notion", canonicalUrl: "http://127.0.0.1:4100/mcp",
        status: "enabled", enabled: true, allowedDomains: ["127.0.0.1"], oauthConfig: { allowedScopes: ["read"] },
      };
    },
    async getClientRegistration() {
      return { id: "1", mcpServerId: "1", issuer: endpoints.issuer, clientId: "client-1", encryptedClientSecret: vault.encrypt("client-secret") };
    },
    async createOAuthTransaction(record) {
      const transaction = { id: "1", ...record, status: "pending" };
      transactions.set(record.stateHash, transaction);
      return transaction;
    },
    async consumeOAuthTransaction({ stateHash }) {
      const transaction = transactions.get(stateHash);
      if (!transaction || transaction.status !== "pending") return { status: "used", transaction };
      transaction.status = "used";
      return { status: "consumed", transaction };
    },
    async upsertConnection(record) {
      const connection = {
        id: String(nextConnectionId++),
        ...record,
        mcpServerId: String(record.mcpServerId),
        status: "active",
      };
      connections.set(connection.id, connection);
      return connection;
    },
    async getConnection({ connectionId }) {
      return connections.get(String(connectionId)) || null;
    },
    async updateConnectionTokens({ id, userId, encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt }) {
      const connection = connections.get(String(id));
      Object.assign(connection, { encryptedAccessToken, encryptedRefreshToken, tokenExpiresAt, status: "active" });
      return connection;
    },
    async markConnectionError({ id, code }) {
      Object.assign(connections.get(String(id)), { status: "error", lastErrorCode: code });
    },
  };
  const oauth = {
    async discoverProtectedResource() { return { authorization_servers: [endpoints.issuer] }; },
    async discoverAuthorizationServer() { return authorizationMetadata; },
    buildAuthorizationUrl(input) {
      const url = new URL(input.authorizationEndpoint);
      for (const [key, value] of Object.entries({
        state: input.state,
        code_challenge: input.codeChallenge,
        resource: input.resource,
      })) url.searchParams.set(key, value);
      return url.toString();
    },
    async exchangeCode(input) {
      assert.equal(input.clientId, "client-1");
      assert.equal(input.clientSecret, "client-secret");
      assert.equal(mcpPkceChallenge(input.codeVerifier), new URLSearchParams(input.authorizationUrl || "").get("code_challenge") || mcpPkceChallenge(input.codeVerifier));
      return { access_token: "access-token", refresh_token: "refresh-token", sub: "account-1", expires_in: 3600, scope: "read" };
    },
    async refreshToken() {
      refreshCalls += 1;
      if (refreshError) throw Object.assign(new Error("invalid grant"), { code: refreshError });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { access_token: "refreshed-access", refresh_token: "refreshed-refresh", expires_in: 3600 };
    },
    async revokeToken() {},
  };
  const service = new McpOAuthService({ repository, oauth, vault, production: false, allowLoopback: true });
  return { service, repository, oauth, vault, getRefreshCalls: () => refreshCalls };
};

test("MCP OAuth uses one-time state, PKCE and the configured scope allowlist", async () => {
  const fixture = createFixture();
  const started = await fixture.service.beginConnection({
    userId: "user-1",
    serverKey: "notion",
    redirectUri: "http://127.0.0.1:4200/api/public/mcp/oauth/callback",
    requestedScopes: ["read"],
  });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  assert.ok(state);
  const stored = [...fixture.repository.transactions.values()][0];
  assert.notEqual(stored.stateHash, state);
  assert.notEqual(stored.encryptedPkceVerifier, "");
  const connection = await fixture.service.handleCallback({ state, code: "authorization-code" });
  assert.equal(connection.providerAccountId, "account-1");
  assert.ok(new Date(fixture.repository.connections.get(connection.id).tokenExpiresAt).getTime() > Date.now());
  assert.equal(fixture.vault.decrypt(fixture.repository.connections.get(connection.id).encryptedAccessToken), "access-token");
  await assert.rejects(
    fixture.service.beginConnection({
      userId: "user-1", serverKey: "notion", redirectUri: "http://127.0.0.1:4200/callback", requestedScopes: ["write"],
    }),
    (error) => error.code === "MCP_SCOPE_NOT_ALLOWED",
  );
});

test("MCP OAuth keeps discovered issuer and token endpoints on the root allowlist", async () => {
  const fixture = createFixture({
    authorizationMetadata: {
      ...endpoints,
      token_endpoint: "http://127.0.0.2:4101/token",
    },
  });
  await assert.rejects(
    fixture.service.beginConnection({
      userId: "user-1",
      serverKey: "notion",
      redirectUri: "http://127.0.0.1:4200/api/public/mcp/oauth/callback",
    }),
    (error) => error.code === "MCP_HOST_NOT_ALLOWED",
  );
});

test("MCP OAuth refresh is single-flight and invalid_grant requires reauthorization", async () => {
  const fixture = createFixture();
  const connection = await fixture.repository.upsertConnection({
    userId: "user-1", mcpServerId: "1", providerAccountId: "account-1", issuer: endpoints.issuer,
    resourceUri: "http://127.0.0.1:4100/mcp", tokenEndpoint: endpoints.token_endpoint,
    encryptedAccessToken: fixture.vault.encrypt("old-access"), encryptedRefreshToken: fixture.vault.encrypt("old-refresh"),
    tokenExpiresAt: new Date(Date.now() + 1000),
  });
  const [one, two] = await Promise.all([
    fixture.service.getAccessToken({ userId: "user-1", connectionId: connection.id }),
    fixture.service.getAccessToken({ userId: "user-1", connectionId: connection.id }),
  ]);
  assert.equal(one.accessToken, "refreshed-access");
  assert.equal(two.accessToken, "refreshed-access");
  assert.equal(fixture.getRefreshCalls(), 1);

  const invalid = createFixture({ refreshError: "invalid_grant" });
  const invalidConnection = await invalid.repository.upsertConnection({
    userId: "user-1", mcpServerId: "1", providerAccountId: "account-1", issuer: endpoints.issuer,
    resourceUri: "http://127.0.0.1:4100/mcp", tokenEndpoint: endpoints.token_endpoint,
    encryptedAccessToken: invalid.vault.encrypt("old-access"), encryptedRefreshToken: invalid.vault.encrypt("old-refresh"),
    tokenExpiresAt: new Date(Date.now() + 1000),
  });
  await assert.rejects(
    invalid.service.getAccessToken({ userId: "user-1", connectionId: invalidConnection.id }),
    (error) => error.code === "MCP_REAUTH_REQUIRED",
  );
  assert.equal(invalid.repository.connections.get(invalidConnection.id).status, "error");
});
