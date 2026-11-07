import assert from "node:assert/strict";
import test from "node:test";

import { CreativeAgentAdapter } from "../infrastructure/creativeAgentAdapter.js";
import {
  getCreativeAgent,
  resetCreativeAgent,
  setCreativeAgentForTests,
} from "../services/creativeAgentComposition.js";

test("creative Agent adapter keeps planning and prompt provider call shapes behind one seam", async () => {
  const calls = [];
  const adapter = new CreativeAgentAdapter({
    canvas: {
      generateCanvasAgentPlan: async (request) => { calls.push(["canvas", request]); return { actions: [] }; },
    },
    script: {
      optimizeDigitalHumanScript: async (request) => { calls.push(["script", request]); return { optimized: "prompt" }; },
    },
    prompt: {
      optimizeGenerationPrompt: async (request) => { calls.push(["prompt", request]); return { optimized: "image prompt" }; },
    },
  });

  assert.deepEqual(await adapter.planCanvas({ instruction: "organize" }), { actions: [] });
  assert.deepEqual(await adapter.optimizeDigitalHumanScript({ brief: "hello" }), { optimized: "prompt" });
  assert.deepEqual(await adapter.optimizeGenerationPrompt({ prompt: "bottle" }), { optimized: "image prompt" });
  assert.deepEqual(calls, [
    ["canvas", { instruction: "organize" }],
    ["script", { brief: "hello" }],
    ["prompt", { prompt: "bottle" }],
  ]);
});

test("creative Agent runtime can replace the adapter without changing callers", () => {
  const runtime = getCreativeAgent();
  const fake = {
    planGlobal: async () => ({ provider: "fake" }),
    planCanvas: async () => ({ provider: "fake" }),
    optimizeDigitalHumanScript: async () => ({ provider: "fake" }),
    optimizeGenerationPrompt: async () => ({ provider: "fake" }),
  };
  try {
    assert.equal(setCreativeAgentForTests(fake), runtime);
    assert.equal(runtime, getCreativeAgent());
  } finally {
    resetCreativeAgent();
  }
});
