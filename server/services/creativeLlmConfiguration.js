import { resolveActiveModelRoute } from "./modelConfigurationService.js";

export const DEFAULT_CREATIVE_LLM_MODEL_KEY = "gpt-5.6-sol";
export const CREATIVE_LLM_PROVIDER_KEY = "canvas_agent";

const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

const clean = (value) => String(value || "").trim();

export const getCreativeLlmModelKey = () => (
  clean(process.env.CREATIVE_LLM_MODEL_KEY) || DEFAULT_CREATIVE_LLM_MODEL_KEY
).toLowerCase();

const normalizeReasoningEffort = (value) => {
  const effort = clean(value).toLowerCase();
  return REASONING_EFFORTS.has(effort) ? effort : "medium";
};

export const resolveCreativeLlmConfiguration = async ({ userId, resolvedRoute = null, requestedReasoningEffort = "" } = {}) => {
  const modelKey = clean(resolvedRoute?.model_key || getCreativeLlmModelKey()).toLowerCase();
  const route = resolvedRoute || await resolveActiveModelRoute({
    modelKey,
    outputType: "agent",
    userId,
  });

  if (route.model_key !== modelKey || route.provider_key !== CREATIVE_LLM_PROVIDER_KEY) {
    throw Object.assign(new Error("The active creative LLM route uses an unsupported provider adapter"), {
      status: 503,
      code: "MODEL_ROUTE_INVALID",
    });
  }

  const apiKey = clean(
    process.env.CREATIVE_LLM_API_KEY
    || process.env.IMAGE_PROVIDER_KEY
    || process.env.CANVAS_AGENT_KEY
    || process.env.OPENAI_API_KEY,
  );
  if (!apiKey) {
    throw Object.assign(new Error("CREATIVE_LLM_API_KEY is not configured"), {
      status: 503,
      code: "AGENT_PROVIDER_NOT_CONFIGURED",
    });
  }

  const baseUrl = clean(
    process.env.CREATIVE_LLM_BASE_URL
    || process.env.CANVAS_AGENT_BASE_URL
    || "https://hkg.apikl.ai/v1",
  ).replace(/\/+$/, "");

  return {
    key: apiKey,
    baseUrl,
    model: route.upstream_model_id,
    modelKey,
    routeId: route.id,
    reasoningEffort: normalizeReasoningEffort(
      requestedReasoningEffort || route.route_config?.reasoning_effort || process.env.CREATIVE_LLM_REASONING_EFFORT,
    ),
  };
};

export const withCreativeLlmOptions = (config, body) => ({
  ...body,
  model: config.model,
  reasoning_effort: config.reasoningEffort,
});
