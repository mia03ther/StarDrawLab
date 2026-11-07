import assert from "node:assert/strict";
import test from "node:test";

import { isMediaProxyReadRequest, resolveTrustProxyHops } from "../configs/httpSecurity.js";

test("trusted proxy depth is explicit and bounded", () => {
  assert.equal(resolveTrustProxyHops(undefined), 2);
  assert.equal(resolveTrustProxyHops("0"), 0);
  assert.equal(resolveTrustProxyHops("2"), 2);
  for (const invalid of ["-1", "5", "1.5", "all", ""]) {
    assert.throws(() => resolveTrustProxyHops(invalid), (error) => error.code === "INVALID_TRUST_PROXY_CONFIGURATION");
  }
});

test("media proxy reads use the dedicated limiter instead of the general API budget", () => {
  assert.equal(isMediaProxyReadRequest({ method: "GET", path: "/api/proxy/oss/quickai/template.jpg" }), true);
  assert.equal(isMediaProxyReadRequest({ method: "HEAD", originalUrl: "/api/proxy/oss/quickai/template.jpg?x=1" }), true);
  assert.equal(isMediaProxyReadRequest({ method: "POST", path: "/api/proxy/oss/grant" }), false);
  assert.equal(isMediaProxyReadRequest({ method: "GET", path: "/api/template-studio/prompt-templates" }), false);
});
