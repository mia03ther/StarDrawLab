import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { AesGcmCredentialVault } from "../infrastructure/credentialVault.js";
import { McpHttpOAuthAdapter } from "../infrastructure/mcpHttpOAuthAdapter.js";
import { McpStreamableHttpTransport } from "../infrastructure/mcpStreamableHttpTransport.js";
import { createPinnedAddressLookup } from "../infrastructure/pinnedHttpRequest.js";
import { McpConfigurationService } from "../services/mcpConfigurationService.js";
import { McpToolExecutionService } from "../services/mcpToolExecutionService.js";

const loopbackOptions = { production: false, allowLoopback: true };

const listen = async (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve(server.address().port);
  });
});

const close = async (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const createRepository = () => {
  const servers = new Map();
  const tools = new Map();
  const registrations = new Map();
  const audits = [];
  return {
    servers,
    tools,
    registrations,
    audits,
    async getServerByKey({ serverKey }) { return servers.get(serverKey) || null; },
    async getServerById({ serverId }) { return [...servers.values()].find((server) => String(server.id) === String(serverId)) || null; },
    async registerServer(record) {
      const server = { id: String(servers.size + 1), ...record, oauthConfig: record.oauthConfig || {} };
      servers.set(server.serverKey, server);
      return server;
    },
    async setServerStatus({ serverKey, status, enabled }) {
      const server = servers.get(serverKey);
      if (!server) return null;
      Object.assign(server, { status, enabled });
      return server;
    },
    async getClientRegistration({ mcpServerId, issuer }) { return registrations.get(`${mcpServerId}:${issuer}`) || null; },
    async upsertClientRegistration(record) {
      const registration = { id: "1", ...record, status: "active" };
      registrations.set(`${record.mcpServerId}:${record.issuer}`, registration);
      return registration;
    },
    async upsertServerTool(record) {
      const tool = { id: "1", ...record };
      tools.set(`${record.serverId}:${record.toolName}`, tool);
      return tool;
    },
    async getEnabledTool({ serverId, toolName }) {
      const tool = tools.get(`${serverId}:${toolName}`);
      return tool?.enabled ? tool : null;
    },
    async listServerTools({ serverId }) { return [...tools.values()].filter((tool) => tool.serverId === String(serverId) && tool.enabled); },
    async appendCallAudit(record) { audits.push(record); },
  };
};

test("root MCP configuration admits only safe providers and keeps Figma pending", async () => {
  const repository = createRepository();
  const vault = new AesGcmCredentialVault({ masterKey: Buffer.alloc(32, 9) });
  const configuration = new McpConfigurationService({ repository, vault, ...loopbackOptions });

  const figma = await configuration.registerServer({
    serverKey: "figma",
    displayName: "Figma",
    canonicalUrl: "http://127.0.0.1:4100/mcp",
    providerAdapter: "figma",
    status: "enabled",
    enabled: true,
  });
  assert.equal(figma.status, "catalog_pending");
  assert.equal(figma.enabled, false);

  await assert.rejects(
    configuration.registerServer({
      serverKey: "unsafe",
      canonicalUrl: "http://127.0.0.1:4100/mcp",
      providerAdapter: "arbitrary",
    }),
    (error) => error.code === "MCP_PROVIDER_NOT_ALLOWED",
  );
  await assert.rejects(
    configuration.registerServer({
      serverKey: "unsafe",
      canonicalUrl: "https://127.0.0.1:4100/mcp",
      providerAdapter: "notion",
    }),
    (error) => error.code === "MCP_SSRF_BLOCKED",
  );
});

test("root can register a generic OAuth 2.1 MCP with custom least-privilege scopes", async () => {
  const repository = createRepository();
  const vault = new AesGcmCredentialVault({ masterKey: Buffer.alloc(32, 7) });
  const configuration = new McpConfigurationService({ repository, vault, ...loopbackOptions });
  const server = await configuration.registerServer({
    serverKey: "acme-design",
    displayName: "Acme Design MCP",
    canonicalUrl: "http://127.0.0.1:4100/mcp",
    providerAdapter: "generic_oauth21",
    allowedDomains: ["127.0.0.1"],
    oauthConfig: { allowedScopes: ["design:read", "files:write"] },
  });
  assert.equal(server.providerAdapter, "generic_oauth21");
  assert.deepEqual(server.oauthConfig.allowedScopes, ["design:read", "files:write"]);
});

test("MCP client registration encrypts secrets and rejects credentials in metadata", async () => {
  const repository = createRepository();
  const vault = new AesGcmCredentialVault({ masterKey: Buffer.alloc(32, 3) });
  const configuration = new McpConfigurationService({ repository, vault, ...loopbackOptions });
  await configuration.registerServer({
    serverKey: "notion",
    displayName: "Notion",
    canonicalUrl: "http://127.0.0.1:4100/mcp",
    providerAdapter: "notion",
  });
  const registration = await configuration.upsertClientRegistration({
    serverKey: "notion",
    issuer: "http://127.0.0.1:4101",
    clientId: "client-id",
    clientSecret: "client-secret",
    registrationMode: "manual",
  });
  assert.equal(registration.clientId, "client-id");
  assert.equal(registration.encryptedClientSecret, undefined);
  const stored = repository.registrations.get("1:http://127.0.0.1:4101/");
  assert.notEqual(stored.encryptedClientSecret, "client-secret");
  assert.equal(vault.decrypt(stored.encryptedClientSecret), "client-secret");
  await assert.rejects(
    configuration.upsertClientRegistration({
      serverKey: "notion",
      issuer: "http://127.0.0.1:4101",
      clientId: "client-id",
      metadata: { access_token: "must-not-be-stored" },
    }),
    (error) => error.code === "MCP_CREDENTIAL_IN_METADATA",
  );
});

test("Streamable HTTP transport initializes, binds session and calls a tool", async () => {
  const calls = [];
  const requestImpl = async ({ target, ...options }) => {
    calls.push({ url: target.url.toString(), options });
    const payload = JSON.parse(options.body);
    if (payload.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { content: [{ type: "text", text: "ok" }] } }), {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "session-1" },
    });
  };
  const transport = new McpStreamableHttpTransport({ requestImpl, ...loopbackOptions });
  const result = await transport.callTool({
    endpoint: "http://127.0.0.1:4100/mcp",
    accessToken: "user-token",
    toolName: "pages.search",
    arguments: { query: "safe" },
  });
  assert.equal(result.content[0].text, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.authorization, "Bearer user-token");
  assert.equal(calls[1].options.headers["mcp-session-id"], "session-1");
  assert.equal(JSON.parse(calls[1].options.body).method, "tools/call");
});

test("Streamable HTTP transport default requester uses the pinned Node HTTP path", async (context) => {
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } }));
    });
  });
  const port = await listen(server);
  context.after(() => close(server));
  const transport = new McpStreamableHttpTransport(loopbackOptions);

  const result = await transport.initialize({
    endpoint: `http://127.0.0.1:${port}/mcp`,
    accessToken: "user-token",
  });

  assert.equal(result.protocolVersion, "2025-06-18");
});

test("Streamable HTTP transport keeps full-response timeout and byte limits", async (context) => {
  const server = http.createServer((request, response) => {
    if (request.url === "/slow") return;
    response.writeHead(200, { "content-type": "application/json", "content-length": "128" });
    response.end("x".repeat(128));
  });
  const port = await listen(server);
  context.after(() => close(server));

  const timed = new McpStreamableHttpTransport({ ...loopbackOptions, timeoutMs: 30 });
  await assert.rejects(
    timed.initialize({ endpoint: `http://127.0.0.1:${port}/slow`, accessToken: "user-token" }),
    (error) => error.code === "MCP_TRANSPORT_TIMEOUT",
  );

  const bounded = new McpStreamableHttpTransport({ ...loopbackOptions, maxResponseBytes: 32 });
  await assert.rejects(
    bounded.initialize({ endpoint: `http://127.0.0.1:${port}/large`, accessToken: "user-token" }),
    (error) => error.code === "MCP_RESPONSE_TOO_LARGE",
  );
});

test("MCP transport never forwards a bearer token across a redirect origin", async () => {
  const requestImpl = async () => new Response(null, {
    status: 302,
    headers: { location: "https://8.8.8.8/mcp" },
  });
  const transport = new McpStreamableHttpTransport({ requestImpl, ...loopbackOptions });
  await assert.rejects(
    transport.initialize({ endpoint: "http://127.0.0.1:4100/mcp", accessToken: "user-token" }),
    (error) => error.code === "MCP_REDIRECT_ORIGIN_CHANGED",
  );
});

test("MCP transport connects only to the address snapshot that passed SSRF validation", async () => {
  const dnsAnswers = [
    [{ address: "93.184.216.34", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }],
  ];
  const dnsLookup = async () => dnsAnswers.shift() || [{ address: "127.0.0.1", family: 4 }];
  const connectedAddresses = [];
  const requestImpl = async ({ target, addresses, body }) => {
    const lookup = createPinnedAddressLookup({ hostname: target.hostname, addresses });
    const address = await new Promise((resolve, reject) => lookup(
      target.hostname,
      {},
      (error, resolvedAddress, family) => error ? reject(error) : resolve({ address: resolvedAddress, family }),
    ));
    connectedAddresses.push(address.address);
    const payload = JSON.parse(body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-06-18" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const transport = new McpStreamableHttpTransport({ requestImpl, dnsLookup, production: true });

  await transport.initialize({ endpoint: "https://mcp.example.test/mcp", accessToken: "user-token" });

  assert.deepEqual(connectedAddresses, ["93.184.216.34"]);
});

test("MCP transport re-resolves and blocks a same-origin redirect that rebinds privately", async () => {
  const dnsAnswers = [
    [{ address: "93.184.216.34", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }],
  ];
  const dnsLookup = async () => dnsAnswers.shift() || [];
  let requests = 0;
  const requestImpl = async () => {
    requests += 1;
    return new Response(null, { status: 302, headers: { location: "/redirected-mcp" } });
  };
  const transport = new McpStreamableHttpTransport({ requestImpl, dnsLookup, production: true });

  await assert.rejects(
    transport.initialize({ endpoint: "https://mcp.example.test/mcp", accessToken: "user-token" }),
    (error) => error.code === "MCP_SSRF_BLOCKED",
  );
  assert.equal(requests, 1);
});

test("MCP OAuth HTTP requests pin validated DNS and revalidate redirects", async () => {
  const dnsAnswers = [
    [{ address: "93.184.216.34", family: 4 }],
    [{ address: "127.0.0.1", family: 4 }],
  ];
  const dnsLookup = async () => dnsAnswers.shift() || [];
  const connectedAddresses = [];
  const requestImpl = async ({ target, addresses }) => {
    const lookup = createPinnedAddressLookup({ hostname: target.hostname, addresses });
    const address = await new Promise((resolve, reject) => lookup(
      target.hostname,
      {},
      (error, resolvedAddress) => error ? reject(error) : resolve(resolvedAddress),
    ));
    connectedAddresses.push(address);
    return new Response(null, { status: 302, headers: { location: "/oauth-metadata" } });
  };
  const oauth = new McpHttpOAuthAdapter({ requestImpl, dnsLookup, production: true });

  await assert.rejects(
    oauth.discoverProtectedResource({ resourceUri: "https://mcp.example.test/mcp" }),
    (error) => error.code === "MCP_SSRF_BLOCKED",
  );
  assert.deepEqual(connectedAddresses, ["93.184.216.34"]);
});

test("MCP tool execution uses the user's connection and administrator allowlist", async () => {
  const repository = createRepository();
  repository.servers.set("notion", {
    id: "7", serverKey: "notion", canonicalUrl: "http://127.0.0.1:4100/mcp",
    providerAdapter: "notion", transport: "streamable_http", status: "enabled", enabled: true,
  });
  repository.tools.set("7:pages.search", {
    id: "8", serverId: "7", toolName: "pages.search", requiredRoles: ["user"], enabled: true,
  });
  const transport = { async callTool(input) { return { echoed: input.arguments }; } };
  const oauth = { async getAccessToken({ userId, connectionId }) {
    assert.equal(userId, "user-1");
    assert.equal(connectionId, "connection-1");
    return {
      accessToken: "not-visible-to-handler",
      connection: { id: "connection-1", serverId: "7", resourceUri: "http://127.0.0.1:4100/mcp" },
    };
  } };
  const service = new McpToolExecutionService({ repository, oauth, transport, clock: () => 1000 });
  const result = await service.callTool({
    userId: "user-1", userRole: "user", connectionId: "connection-1",
    toolName: "pages.search", arguments: { query: "hello" },
  });
  assert.deepEqual(result.result, { echoed: { query: "hello" } });
  assert.equal(repository.audits[0].outcome, "started");
  assert.equal(repository.audits[1].outcome, "succeeded");
  assert.equal(repository.audits[0].parameterDigest.length, 64);
});

test("MCP tool execution enforces the administrator approval policy and input schema", async () => {
  const repository = createRepository();
  repository.servers.set("notion", {
    id: "7", serverKey: "notion", canonicalUrl: "http://127.0.0.1:4100/mcp",
    providerAdapter: "notion", transport: "streamable_http", status: "enabled", enabled: true,
  });
  repository.tools.set("7:pages.publish", {
    id: "9", serverId: "7", toolName: "pages.publish", requiredRoles: ["user"], enabled: true,
    operationClass: "destructive", approvalPolicy: "always",
    inputSchema: {
      type: "object",
      required: ["pageId", "publish"],
      additionalProperties: false,
      properties: {
        pageId: { type: "string", minLength: 3 },
        publish: { type: "boolean", enum: [true] },
      },
    },
  });
  let transportCalls = 0;
  const transport = { async callTool() { transportCalls += 1; return { ok: true }; } };
  const oauth = { async getAccessToken() {
    return {
      accessToken: "user-token",
      connection: { id: "connection-1", serverId: "7", resourceUri: "http://127.0.0.1:4100/mcp" },
    };
  } };
  const service = new McpToolExecutionService({ repository, oauth, transport, clock: () => 1000 });

  await assert.rejects(
    service.callTool({
      userId: "user-1", userRole: "user", agentMode: "full_access", connectionId: "connection-1",
      toolName: "pages.publish", arguments: { pageId: "page-1", publish: true },
    }),
    (error) => error.code === "MCP_TOOL_APPROVAL_REQUIRED",
  );
  await assert.rejects(
    service.callTool({
      userId: "user-1", userRole: "user", agentMode: "full_access", connectionId: "connection-1",
      toolName: "pages.publish", approvalId: "12", arguments: { pageId: "page-1", publish: "yes" },
    }),
    (error) => error.code === "MCP_INPUT_SCHEMA_INVALID",
  );
  const result = await service.callTool({
    userId: "user-1", userRole: "user", agentMode: "full_access", connectionId: "connection-1",
    toolName: "pages.publish", approvalId: "12", arguments: { pageId: "page-1", publish: true },
  });
  assert.deepEqual(result.result, { ok: true });
  assert.equal(transportCalls, 1);
  assert.equal(repository.audits.filter((item) => item.outcome === "denied").length, 2);
});
