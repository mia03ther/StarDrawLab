import assert from "node:assert/strict";
import test from "node:test";

import { AesGcmCredentialVault } from "../infrastructure/credentialVault.js";
import {
  assertAllowedMcpHost,
  assertSafeMcpUrl,
  classifyIp,
  resolveAndPinPublicMcpHost,
} from "../services/mcpSecurityService.js";

test("MCP URL security blocks credentials, HTTP and private targets", () => {
  assert.equal(classifyIp("10.0.0.1"), "private");
  assert.equal(classifyIp("127.0.0.1"), "loopback");
  assert.equal(classifyIp("::ffff:10.0.0.1"), "private");
  assert.equal(classifyIp("[::1]"), "loopback");
  assert.equal(classifyIp("100.64.0.1"), "shared");
  assert.equal(classifyIp("8.8.8.8"), "public");
  assert.throws(() => assertSafeMcpUrl("http://example.com/mcp", { production: true }), (error) => error.code === "MCP_HTTPS_REQUIRED");
  assert.throws(() => assertSafeMcpUrl("https://127.0.0.1/mcp"), (error) => error.code === "MCP_SSRF_BLOCKED");
  assert.throws(() => assertSafeMcpUrl("https://user:pass@example.com/mcp"), (error) => error.code === "MCP_URL_UNSAFE");
  const url = assertSafeMcpUrl("https://mcp.example.com/mcp");
  assertAllowedMcpHost(url, ["*.example.com"]);
  assert.throws(() => assertAllowedMcpHost(url, ["not-example.com"]), (error) => error.code === "MCP_HOST_NOT_ALLOWED");
});

test("MCP DNS validation returns an immutable public address snapshot", async () => {
  const addresses = [{ address: "93.184.216.34", family: 4 }];
  const target = await resolveAndPinPublicMcpHost("https://mcp.example.test/path", {
    production: true,
    lookup: async () => addresses,
  });
  addresses[0].address = "127.0.0.1";
  assert.equal(target.url.hostname, "mcp.example.test");
  assert.deepEqual(target.addresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.equal(Object.isFrozen(target.addresses), true);

  await assert.rejects(
    resolveAndPinPublicMcpHost("https://mcp.example.test/path", {
      production: true,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    }),
    (error) => error.code === "MCP_SSRF_BLOCKED",
  );
});

test("credential vault encrypts and rejects tampered ciphertext", () => {
  const vault = new AesGcmCredentialVault({ masterKey: Buffer.alloc(32, 7) });
  const ciphertext = vault.encrypt("refresh-token-secret");
  assert.notEqual(ciphertext, "refresh-token-secret");
  assert.equal(vault.decrypt(ciphertext), "refresh-token-secret");
  const parts = ciphertext.split(":");
  const changed = parts[3][0] === "A" ? "B" : "A";
  parts[3] = `${changed}${parts[3].slice(1)}`;
  const tampered = parts.join(":");
  assert.throws(() => vault.decrypt(tampered), (error) => error.code === "CREDENTIAL_DECRYPTION_FAILED");
});
