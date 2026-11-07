import { McpTransportPort } from "../ports/mcpPort.js";
import { requestPinnedHttp } from "./pinnedHttpRequest.js";
import { resolveAndPinPublicMcpHost } from "../services/mcpSecurityService.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const SESSION_PATTERN = /^[a-zA-Z0-9._~:/+-]{1,256}$/;

const fail = (message, { status = 502, code = "MCP_TRANSPORT_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const asPositiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseSse = (text) => {
  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try { messages.push(JSON.parse(data)); } catch { throw fail("MCP SSE response contained invalid JSON", { code: "MCP_RESPONSE_INVALID" }); }
  };
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (!line.trim()) flush();
  }
  flush();
  return messages;
};

const parseResponse = (text, contentType) => {
  if (!text) return [];
  if (contentType.toLowerCase().includes("text/event-stream")) return parseSse(text);
  try { return [JSON.parse(text)]; } catch { throw fail("MCP response was not valid JSON", { code: "MCP_RESPONSE_INVALID" }); }
};

const responseError = (response, body) => {
  const upstreamCode = body?.error?.code || body?.error || null;
  return fail("MCP server rejected the request", {
    status: response.status === 401 ? 401 : 502,
    code: response.status === 401 ? "MCP_UPSTREAM_UNAUTHORIZED" : "MCP_UPSTREAM_HTTP_FAILED",
    upstreamStatus: response.status,
    upstreamCode: typeof upstreamCode === "string" || typeof upstreamCode === "number" ? upstreamCode : null,
  });
};

const validateMessage = (message, requestId) => {
  if (!message || message.jsonrpc !== "2.0" || message.id !== requestId) {
    throw fail("MCP response did not match the request", { code: "MCP_RESPONSE_ID_MISMATCH" });
  }
  if (message.error) {
    throw fail("MCP tool request failed", {
      code: "MCP_RPC_ERROR",
      rpcCode: Number.isSafeInteger(message.error.code) ? message.error.code : null,
    });
  }
  return message.result;
};

/**
 * Streamable HTTP adapter. It is deliberately stateless at the HTTP seam:
 * callers may pass a session id, while the adapter guarantees that redirects
 * are checked before a bearer token is ever sent to a new host.
 */
export class McpStreamableHttpTransport extends McpTransportPort {
  #request;
  #production;
  #allowLoopback;
  #timeoutMs;
  #maxResponseBytes;
  #protocolVersion;
  #dnsLookup;
  #nextId = 1;

  constructor({
    requestImpl,
    production = process.env.NODE_ENV === "production",
    allowLoopback = false,
    timeoutMs = asPositiveInteger(process.env.MCP_HTTP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxResponseBytes = asPositiveInteger(process.env.MCP_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
    protocolVersion = process.env.MCP_PROTOCOL_VERSION || "2025-06-18",
    dnsLookup,
  } = {}) {
    super();
    if (requestImpl != null && typeof requestImpl !== "function") throw new TypeError("McpStreamableHttpTransport requestImpl must be a function");
    this.#request = requestImpl || requestPinnedHttp;
    this.#production = production;
    this.#allowLoopback = allowLoopback;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#protocolVersion = String(protocolVersion).trim().slice(0, 40) || "2025-06-18";
    this.#dnsLookup = dnsLookup;
  }

  #requestId() {
    const id = this.#nextId;
    this.#nextId += 1;
    if (this.#nextId > Number.MAX_SAFE_INTEGER - 1) this.#nextId = 1;
    return id;
  }

  async #post({ endpoint, accessToken, sessionId = null, method, params = {} } = {}) {
    if (!accessToken) throw fail("MCP access token is unavailable", { status: 401, code: "MCP_TOKEN_UNAVAILABLE" });
    let target = await resolveAndPinPublicMcpHost(endpoint, {
      production: this.#production,
      allowLoopback: this.#allowLoopback,
      lookup: this.#dnsLookup,
    });
    const requestId = this.#requestId();
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "mcp-protocol-version": this.#protocolVersion,
    };
    if (sessionId != null) {
      const normalizedSession = String(sessionId);
      if (!SESSION_PATTERN.test(normalizedSession)) throw fail("MCP session id is invalid", { status: 400, code: "MCP_SESSION_INVALID" });
      headers["mcp-session-id"] = normalizedSession;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params });
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response;
      try {
        response = await this.#request({
          target,
          addresses: target.addresses,
          method: "POST",
          headers,
          body,
          signal: controller.signal,
          maxResponseBytes: this.#maxResponseBytes,
          responseTooLargeError: () => fail("MCP response is too large", { code: "MCP_RESPONSE_TOO_LARGE" }),
        });
      } catch (error) {
        if (error.code === "MCP_RESPONSE_TOO_LARGE") throw error;
        throw fail("MCP transport network request failed", {
          status: 503,
          code: error.name === "AbortError" ? "MCP_TRANSPORT_TIMEOUT" : "MCP_TRANSPORT_NETWORK_FAILED",
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = await resolveAndPinPublicMcpHost(new URL(response.headers.get("location"), target.url).toString(), {
          production: this.#production,
          allowLoopback: this.#allowLoopback,
          lookup: this.#dnsLookup,
        });
        // Never forward the bearer token across origins. Same-origin redirects
        // are allowed only after the destination was checked for SSRF.
        if (next.url.origin !== target.url.origin) throw fail("MCP redirect changed origin", { code: "MCP_REDIRECT_ORIGIN_CHANGED" });
        target = next;
        continue;
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > this.#maxResponseBytes) throw fail("MCP response is too large", { code: "MCP_RESPONSE_TOO_LARGE" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.#maxResponseBytes) throw fail("MCP response is too large", { code: "MCP_RESPONSE_TOO_LARGE" });
      const messages = parseResponse(new TextDecoder().decode(bytes), response.headers.get("content-type") || "application/json");
      if (!response.ok) throw responseError(response, messages[0]);
      if (response.status === 202 && messages.length === 0) throw fail("MCP server accepted a request without a response", { code: "MCP_RESPONSE_MISSING" });
      if (!messages.length) throw fail("MCP response did not contain a JSON-RPC message", { code: "MCP_RESPONSE_MISSING" });
      const message = messages.find((item) => item?.id === requestId) || messages[0];
      return {
        result: validateMessage(message, requestId),
        sessionId: response.headers.get("mcp-session-id") || sessionId || null,
      };
    }
    throw fail("MCP redirect chain is too long", { code: "MCP_REDIRECT_CHAIN_TOO_LONG" });
  }

  async initialize({ endpoint, accessToken }) {
    const response = await this.#post({
      endpoint,
      accessToken,
      method: "initialize",
      params: {
        protocolVersion: this.#protocolVersion,
        capabilities: {},
        clientInfo: { name: "stardraw-web", version: "1.0" },
      },
    });
    return { ...response.result, sessionId: response.sessionId };
  }

  async listTools({ endpoint, accessToken, sessionId = null } = {}) {
    let activeSession = sessionId;
    if (!activeSession) activeSession = (await this.initialize({ endpoint, accessToken })).sessionId;
    const response = await this.#post({ endpoint, accessToken, sessionId: activeSession, method: "tools/list", params: {} });
    return { tools: Array.isArray(response.result?.tools) ? response.result.tools : [], sessionId: response.sessionId };
  }

  async callTool({ endpoint, accessToken, sessionId = null, toolName, arguments: toolArguments = {} } = {}) {
    const name = String(toolName || "").trim();
    if (!name || name.length > 160) throw fail("MCP tool name is invalid", { status: 400, code: "INVALID_MCP_TOOL_NAME" });
    if (!toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)) {
      throw fail("MCP tool arguments must be a JSON object", { status: 400, code: "INVALID_MCP_TOOL_ARGUMENTS" });
    }
    let activeSession = sessionId;
    if (!activeSession) activeSession = (await this.initialize({ endpoint, accessToken })).sessionId;
    const response = await this.#post({
      endpoint,
      accessToken,
      sessionId: activeSession,
      method: "tools/call",
      params: { name, arguments: toolArguments },
    });
    return { ...response.result, sessionId: response.sessionId };
  }
}
