import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "capture-test:db" };
    if (specifier === "../services/objectStorageComposition.js") return { shortCircuit: true, url: "capture-test:object-storage" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "capture-test:logger" };
    if (specifier === "../services/resourceAccessService.js") return { shortCircuit: true, url: "capture-test:resource" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "capture-test:db") return { format: "module", shortCircuit: true, source: "export default function sql() { throw new Error('database access forbidden'); }" };
    if (url === "capture-test:object-storage") return { format: "module", shortCircuit: true, source: "export const getObjectStorage=()=>({ uploadBuffer:async()=>{}, buildObjectKey:()=>'', deleteObject:async()=>{} });" };
    if (url === "capture-test:logger") return { format: "module", shortCircuit: true, source: "export default { info() {}, warn() {}, error() {} };" };
    if (url === "capture-test:resource") return { format: "module", shortCircuit: true, source: "export const buildGrantedProxyUrl=()=>'';" };
    return nextLoad(url, context);
  },
});

const { createCaptureToken, isCaptureTokenActive } = await import("../controllers/digitalHumanRoleController.js");

test("digital-human capture tokens are 256-bit URL-safe and unique", () => {
  const tokens = new Set(Array.from({ length: 100 }, () => createCaptureToken()));
  assert.equal(tokens.size, 100);
  for (const token of tokens) assert.match(token, /^dh_[A-Za-z0-9_-]{43}$/);
});

test("capture token activity requires expiry and an unused, unrevoked state", () => {
  const token = createCaptureToken();
  const active = { qr_token: token, qr_token_expires_at: new Date(Date.now() + 60_000), qr_token_claimed_at: null, qr_token_consumed_at: null, qr_token_revoked_at: null };
  assert.equal(isCaptureTokenActive(active), true);
  assert.equal(isCaptureTokenActive({ ...active, qr_token_claimed_at: new Date() }), false);
  assert.equal(isCaptureTokenActive({ ...active, qr_token_consumed_at: new Date() }), false);
  assert.equal(isCaptureTokenActive({ ...active, qr_token_revoked_at: new Date() }), false);
  assert.equal(isCaptureTokenActive({ ...active, qr_token_expires_at: new Date(Date.now() - 1) }), false);
});
