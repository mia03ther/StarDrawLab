import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAgentTokenCharge,
  normalizeAgentTokenUsage,
} from "../domain/pricing/agentTokenPricing.js";

test("Agent token pricing converts CNY per million tokens to points and rounds up", () => {
  const result = calculateAgentTokenCharge({
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
    },
    pricing: {
      input_price: 1.5,
      output_price: 9,
      cache_read_price: 0.15,
      cache_write_price: 1.875,
      unit_tokens: 1_000_000,
      points_per_currency_unit: 100,
      minimum_points: 1,
    },
  });

  assert.equal(result.pointsCost, 240);
  assert.equal(result.currencyCost, 2.4);
  assert.deepEqual(result.usage, {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("cached input is billed separately from regular input", () => {
  assert.deepEqual(normalizeAgentTokenUsage({
    prompt_tokens: 1_200,
    prompt_tokens_details: { cached_tokens: 800 },
    completion_tokens: 200,
  }), {
    inputTokens: 400,
    outputTokens: 200,
    cacheReadTokens: 800,
    cacheWriteTokens: 0,
  });

  const result = calculateAgentTokenCharge({
    usage: { inputTokens: 400, outputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 100 },
    pricing: {
      input_price: 0.225,
      output_price: 1.35,
      cache_read_price: 0.03,
      cache_write_price: 0.3,
    },
  });
  assert.equal(result.pointsCost, 1);
});

test("a fixed-price Agent model is represented outside token arithmetic", () => {
  assert.equal(calculateAgentTokenCharge({
    usage: { inputTokens: 0, outputTokens: 0 },
    pricing: {
      input_price: 1,
      output_price: 1,
      minimum_points: 1,
    },
  }).pointsCost, 1);
});
