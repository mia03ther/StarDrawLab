import assert from "node:assert/strict";
import test from "node:test";

import {
  clearGenerationRequestKey,
  generationRequestFingerprint,
  getGenerationRequestKey,
} from "./generationRequestIdentity.js";

test("generation request identity survives navigation and clears after completion", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const fingerprint = generationRequestFingerprint({ prompt: "city", model: "image", size: "1:1" });
  let sequence = 0;
  const options = { storage, scope: "image", fingerprint, now: () => 1000, randomUUID: () => `key-${++sequence}` };

  const first = getGenerationRequestKey(options);
  const afterNavigation = getGenerationRequestKey(options);
  assert.equal(afterNavigation, first);

  clearGenerationRequestKey({ storage, scope: "image", requestKey: first });
  assert.notEqual(getGenerationRequestKey(options), first);
});
