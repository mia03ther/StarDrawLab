import { McpOAuthPort } from "../ports/mcpPort.js";
import { requestPinnedHttp } from "./pinnedHttpRequest.js";
import { assertSafeMcpUrl, resolveAndPinPublicMcpHost } from "../services/mcpSecurityService.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

const oauthError = (message, response, body = {}) => Object.assign(new Error(message), {
  status: response?.status >= 400 ? 502 : 503,
  code: body?.error || "MCP_OAUTH_UPSTREAM_FAILED",
  oauthError: body?.error,
  upstreamStatus: response?.status,
});

export class McpHttpOAuthAdapter extends McpOAuthPort {
  #send;
  #production;
  #allowLoopback;
  #timeoutMs;
  #maxResponseBytes;
  #dnsLookup;

  constructor({ requestImpl, production = process.env.NODE_ENV === "production", allowLoopback = false, timeoutMs = DEFAULT_TIMEOUT_MS, maxResponseBytes = MAX_RESPONSE_BYTES, dnsLookup } = {}) {
    super();
    if (requestImpl != null && typeof requestImpl !== "function") throw new TypeError("McpHttpOAuthAdapter requestImpl must be a function");
    this.#send = requestImpl || requestPinnedHttp;
    this.#production = production;
    this.#allowLoopback = allowLoopback;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#dnsLookup = dnsLookup;
  }

  async #request(url, { method = "GET", headers = {}, body = null } = {}) {
    let current = assertSafeMcpUrl(url, { production: this.#production, allowLoopback: this.#allowLoopback });
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const target = await resolveAndPinPublicMcpHost(current.toString(), {
        production: this.#production,
        allowLoopback: this.#allowLoopback,
        lookup: this.#dnsLookup,
      });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response;
      try {
        response = await this.#send({
          target,
          addresses: target.addresses,
          method,
          headers,
          body,
          signal: controller.signal,
          maxResponseBytes: this.#maxResponseBytes,
          responseTooLargeError: () => Object.assign(new Error("MCP OAuth response is too large"), { status: 502, code: "MCP_RESPONSE_TOO_LARGE" }),
        });
      } catch (error) {
        if (error.code === "MCP_RESPONSE_TOO_LARGE") throw error;
        throw Object.assign(new Error("MCP OAuth network request failed"), { status: 503, code: error.name === "AbortError" ? "MCP_OAUTH_TIMEOUT" : "MCP_OAUTH_NETWORK_FAILED" });
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
        const next = new URL(response.headers.get("location"), target.url);
        if (method !== "GET" && next.origin !== target.url.origin) {
          throw Object.assign(new Error("MCP OAuth redirect changed origin"), { status: 502, code: "MCP_REDIRECT_ORIGIN_CHANGED" });
        }
        current = next;
        continue;
      }
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > this.#maxResponseBytes) throw Object.assign(new Error("MCP OAuth response is too large"), { status: 502, code: "MCP_RESPONSE_TOO_LARGE" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > this.#maxResponseBytes) throw Object.assign(new Error("MCP OAuth response is too large"), { status: 502, code: "MCP_RESPONSE_TOO_LARGE" });
      const text = new TextDecoder().decode(bytes);
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { throw Object.assign(new Error("MCP OAuth response was not JSON"), { status: 502, code: "MCP_RESPONSE_INVALID" }); }
      if (!response.ok) throw oauthError("MCP OAuth upstream request failed", response, data);
      return data;
    }
    throw Object.assign(new Error("MCP OAuth redirect chain is too long"), { status: 502, code: "MCP_REDIRECT_CHAIN_TOO_LONG" });
  }

  async discoverProtectedResource({ resourceUri }) {
    const resource = assertSafeMcpUrl(resourceUri, { production: this.#production, allowLoopback: this.#allowLoopback });
    const candidates = [
      new URL("/.well-known/oauth-protected-resource", resource).toString(),
      new URL("/.well-known/oauth-protected-resource", `${resource.origin}/`).toString(),
    ];
    let lastError;
    for (const candidate of [...new Set(candidates)]) {
      try { return await this.#request(candidate); } catch (error) { lastError = error; if (error.upstreamStatus !== 404) throw error; }
    }
    throw lastError || Object.assign(new Error("MCP protected resource metadata not found"), { status: 503, code: "MCP_RESOURCE_METADATA_MISSING" });
  }

  async discoverAuthorizationServer({ issuer }) {
    const base = assertSafeMcpUrl(issuer, { production: this.#production, allowLoopback: this.#allowLoopback });
    const candidates = [
      new URL(".well-known/oauth-authorization-server", `${base.toString().replace(/\/$/, "")}/`).toString(),
      new URL(".well-known/openid-configuration", `${base.toString().replace(/\/$/, "")}/`).toString(),
    ];
    let lastError;
    for (const candidate of candidates) {
      try { return await this.#request(candidate); } catch (error) { lastError = error; if (error.upstreamStatus !== 404) throw error; }
    }
    throw lastError || Object.assign(new Error("MCP authorization server metadata not found"), { status: 503, code: "MCP_AUTH_METADATA_MISSING" });
  }

  buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, state, scope = [], resource, codeChallenge, codeChallengeMethod = "S256" }) {
    const url = assertSafeMcpUrl(authorizationEndpoint, { production: this.#production, allowLoopback: this.#allowLoopback });
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", codeChallengeMethod);
    url.searchParams.set("resource", resource);
    if (scope.length) url.searchParams.set("scope", scope.join(" "));
    return url.toString();
  }

  async exchangeCode({ code, codeVerifier, clientId, clientSecret, redirectUri, tokenEndpoint, resource }) {
    const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri, resource });
    if (clientSecret) body.set("client_secret", clientSecret);
    return this.#request(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  }

  async refreshToken({ refreshToken, clientId, clientSecret, tokenEndpoint, resource }) {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, resource });
    if (clientId) body.set("client_id", clientId);
    if (clientSecret) body.set("client_secret", clientSecret);
    return this.#request(tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  }

  async revokeToken({ revokeEndpoint, token, tokenTypeHint }) {
    const body = new URLSearchParams({ token });
    if (tokenTypeHint) body.set("token_type_hint", tokenTypeHint);
    return this.#request(revokeEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() });
  }
}
