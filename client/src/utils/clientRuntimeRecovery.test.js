import assert from "node:assert/strict";
import test from "node:test";

import { createChunkLoadRecovery } from "./clientRuntimeRecovery.js";

test("chunk recovery reloads only once inside the retry window", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  let reloads = 0;
  let prevented = 0;
  const recover = createChunkLoadRecovery({
    storage,
    now: () => 1_000,
    reload: () => { reloads += 1; },
  });
  const event = { preventDefault: () => { prevented += 1; } };

  assert.equal(recover(event), true);
  assert.equal(recover(event), false);
  assert.equal(reloads, 1);
  assert.equal(prevented, 2);
});
