import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "resource-test:db" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "resource-test:db") return { format: "module", shortCircuit: true, source: "export default function sql() { throw new Error('database access forbidden'); }" };
    return nextLoad(url, context);
  },
});

process.env.RESOURCE_ACCESS_SECRET = "resource-test-secret-that-is-definitely-longer-than-32-characters";
const resource = await import("../services/resourceAccessService.js");

test("object keys reject traversal and encoded path separators", () => {
  assert.equal(resource.normalizeObjectKey("quickai/user/image.png"), "quickai/user/image.png");
  for (const value of ["../secret", "/absolute", "folder\\secret", "folder%2Fsecret", "folder%5Csecret", "folder/../secret"]) {
    assert.throws(() => resource.normalizeObjectKey(value));
  }
});

test("resource grants are bound to the exact object key and reject tampering", () => {
  const objectKey = "quickai/user/image.png";
  const token = resource.issueResourceGrant({ objectKey, userId: "user-1", ttlSeconds: 60 });
  const verified = resource.verifyResourceGrant({ token, objectKey });
  assert.equal(verified.userId, "user-1");
  assert.equal(resource.verifyResourceGrant({ token, objectKey: "quickai/user/other.png" }), null);
  assert.equal(resource.verifyResourceGrant({ token: `${token}x`, objectKey }), null);
});

test("granted proxy URL preserves nested keys and allowed processing", () => {
  const url = resource.buildGrantedProxyUrl({
    objectKey: "quickai/user/folder/image one.png",
    userId: "user-1",
    ttlSeconds: 60,
    process: "video/snapshot,t_0,f_jpg,w_640,m_fast",
  });
  assert.match(url, /^\/oss-proxy\/quickai\/user\/folder\/image%20one\.png\?/);
  assert.match(url, /resource_token=/);
  assert.match(url, /x-oss-process=/);
});
