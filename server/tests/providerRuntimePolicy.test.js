import test from "node:test";
import assert from "node:assert/strict";

import {
  areProviderMocksEnabled,
  isProductionRuntime,
} from "../infrastructure/providerRuntimePolicy.js";

test("provider mocks fail closed unless explicitly enabled outside production", () => {
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "development" }), false);
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "test", PROVIDER_MOCKS_ENABLED: "false" }), false);
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "development", PROVIDER_MOCKS_ENABLED: "true" }), true);
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "test", PROVIDER_MOCKS_ENABLED: "1" }), true);
});

test("production never enables provider mocks", () => {
  assert.equal(isProductionRuntime({ NODE_ENV: "production" }), true);
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "production", PROVIDER_MOCKS_ENABLED: "true" }), false);
  assert.equal(areProviderMocksEnabled({ NODE_ENV: "PRODUCTION", PROVIDER_MOCKS_ENABLED: "1" }), false);
});

