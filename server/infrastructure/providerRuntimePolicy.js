const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

export const isProductionRuntime = (env = process.env) =>
  String(env?.NODE_ENV || "").trim().toLowerCase() === "production";

/**
 * Provider mocks are an explicit local-development capability, never a
 * fallback for a billable request.  Production always fails closed even if a
 * stale environment variable accidentally enables mocks.
 */
export const areProviderMocksEnabled = (env = process.env) =>
  !isProductionRuntime(env)
  && ENABLED_VALUES.has(String(env?.PROVIDER_MOCKS_ENABLED || "false").trim().toLowerCase());

