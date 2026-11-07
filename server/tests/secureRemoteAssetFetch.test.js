import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createByteLimitedStream,
  createPinnedPublicLookup,
  readRemoteAssetPolicy,
  validateRemoteAssetUrl,
} from "../infrastructure/secureRemoteAssetFetch.js";

test("remote asset policy derives provider hosts and bounded limits", () => {
  const policy = readRemoteAssetPolicy({
    NODE_ENV: "production",
    IMAGE_PROVIDER_BASE_URL: "https://images.example.com/v1",
    REMOTE_ASSET_ALLOWED_HOSTS: "*.cdn.example.com",
    REMOTE_ASSET_MAX_BYTES: "1024",
    REMOTE_ASSET_TIMEOUT_MS: "5000",
    REMOTE_ASSET_MAX_REDIRECTS: "2",
  });
  assert.deepEqual(policy.allowedHosts, ["*.cdn.example.com", "images.example.com"]);
  assert.equal(policy.maxBytes, 1024);
  assert.equal(policy.timeoutMs, 5000);
  assert.equal(policy.maxRedirects, 2);
  assert.equal(policy.requireAllowlist, true);
});

test("remote asset URLs require HTTPS, public addresses and an allowed host", () => {
  const policy = { allowedHosts: ["*.cdn.example.com"], requireAllowlist: true };
  assert.equal(validateRemoteAssetUrl("https://media.cdn.example.com/file.png", policy).hostname, "media.cdn.example.com");
  assert.throws(() => validateRemoteAssetUrl("http://media.cdn.example.com/file.png", policy), (error) => error.code === "REMOTE_ASSET_HTTPS_REQUIRED");
  assert.throws(() => validateRemoteAssetUrl("https://127.0.0.1/file.png", policy), (error) => error.code === "REMOTE_ASSET_SSRF_BLOCKED");
  assert.throws(() => validateRemoteAssetUrl("https://evil.example/file.png", policy), (error) => error.code === "REMOTE_ASSET_HOST_NOT_ALLOWED");
  assert.throws(
    () => validateRemoteAssetUrl("https://cdn.example.com/file.png", { allowedHosts: [], requireAllowlist: true }),
    (error) => error.code === "REMOTE_ASSET_ALLOWLIST_MISSING",
  );
});

test("pinned lookup rejects any private DNS answer", async () => {
  const lookup = createPinnedPublicLookup({
    policy: { allowedHosts: ["assets.example.com"], requireAllowlist: true },
    lookup: async () => [
      { address: "203.0.114.10", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ],
  });
  await assert.rejects(
    new Promise((resolve, reject) => lookup("assets.example.com", {}, (error, address) => error ? reject(error) : resolve(address))),
    (error) => error.code === "REMOTE_ASSET_SSRF_BLOCKED",
  );
});

test("byte limited stream aborts content beyond the configured maximum", async () => {
  const source = Readable.from([Buffer.alloc(4), Buffer.alloc(5)]);
  const limited = createByteLimitedStream(source, 8);
  await assert.rejects(
    async () => {
      for await (const _chunk of limited) { /* consume */ }
    },
    (error) => error.code === "REMOTE_ASSET_TOO_LARGE",
  );
});
