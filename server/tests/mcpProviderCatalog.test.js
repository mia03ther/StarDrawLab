import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMcpProviderConfiguration,
  getMcpProviderCapability,
  listMcpProviderCapabilities,
} from "../domain/mcp/mcpProviderCatalog.js";

test("MCP provider catalog exposes supported providers without provider secrets", () => {
  const providers = listMcpProviderCapabilities();
  assert.deepEqual(providers.map((item) => item.providerAdapter), ["notion", "github", "generic_oauth21", "figma"]);
  assert.equal(getMcpProviderCapability("GITHUB").admission, "supported");
  assert.equal(getMcpProviderCapability("github").oauth.authorizationCodePkce, true);
  assert.equal(Object.prototype.hasOwnProperty.call(getMcpProviderCapability("github"), "clientSecret"), false);
});

test("root may register generic OAuth 2.1 Streamable HTTP providers", () => {
  const generic = assertMcpProviderConfiguration({
    providerAdapter: "generic_oauth21",
    transport: "streamable_http",
    status: "enabled",
    enabled: true,
  });
  assert.equal(generic.admission, "supported");
  assert.equal(generic.oauth.authorizationCodePkce, true);
  assert.deepEqual(generic.supportedTransports, ["streamable_http"]);
});

test("catalog_pending providers cannot be enabled", () => {
  assert.throws(
    () => assertMcpProviderConfiguration({ providerAdapter: "figma", transport: "streamable_http", status: "enabled", enabled: true }),
    (error) => error.code === "MCP_FIGMA_CATALOG_PENDING" && error.status === 409,
  );
  assert.equal(
    assertMcpProviderConfiguration({ providerAdapter: "figma", transport: "streamable_http", status: "draft" }).admission,
    "catalog_pending",
  );
});

test("provider catalog rejects transports that are not admitted", () => {
  assert.throws(
    () => assertMcpProviderConfiguration({ providerAdapter: "notion", transport: "sse", status: "draft" }),
    (error) => error.code === "MCP_PROVIDER_TRANSPORT_UNAVAILABLE" && error.status === 503,
  );
});
