import { requestChatCompletionStream } from "../../providers/openAICompatibleStream.js";
import { agentRetryDelayMs, isRetryableAgentError } from "../../domain/agent/retryPolicy.js";
import {
  agentModelUsesTokenPricing,
  sumAgentTokenUsage,
} from "../../domain/pricing/agentTokenPricing.js";
import { resolveActiveModelRoute } from "../../services/modelConfigurationService.js";
import logger from "../../configs/logger.js";

const REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const CONTEXT_SAFETY_MARGIN_TOKENS = 512;
const MIN_OUTPUT_TOKENS = 512;
const MAX_OUTPUT_TOKENS = 32_000;
const TRANSIENT_PROVIDER_STATUSES = new Set([429, 500, 502, 503, 504]);

const fail = (message, code = "CANVAS_AGENT_PROVIDER_FAILED", status = 502) => {
  throw Object.assign(new Error(message), { code, status });
};

const clean = (value) => String(value || "").trim();
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const requestWithProviderRetry = async (request, { model, routeId } = {}) => {
  const configuredAttempts = Number(process.env.AGENT_PROVIDER_MAX_ATTEMPTS || 6);
  const maxAttempts = Number.isSafeInteger(configuredAttempts)
    ? Math.min(6, Math.max(1, configuredAttempts))
    : 6;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = Number(error?.status);
      const retryAfterMs = agentRetryDelayMs(error?.retryAfterMs);
      const retryable = isRetryableAgentError(error)
        && (TRANSIENT_PROVIDER_STATUSES.has(status) || retryAfterMs !== null);
      if (!retryable || attempt >= maxAttempts) throw error;

      const configuredDelay = Number(process.env.AGENT_PROVIDER_RETRY_DELAY_MS || 750);
      const delayMs = retryAfterMs !== null
        ? retryAfterMs
        : Math.min(5_000, Math.max(100, configuredDelay) * attempt);
      logger.warn("canvasAgent.provider.retry", {
        attempt,
        status: status || null,
        code: String(error?.code || "AGENT_PROVIDER_UNAVAILABLE").slice(0, 120),
        delayMs,
        model: String(model || "").slice(0, 120),
        routeId: routeId || null,
      });
      await wait(delayMs);
    }
  }

  throw Object.assign(new Error("Canvas Agent provider is unavailable"), {
    status: 503,
    code: "AGENT_PROVIDER_UNAVAILABLE",
  });
};

const configuredContextWindow = () => {
  const value = Number(process.env.CANVAS_AGENT_CONTEXT_WINDOW_TOKENS || DEFAULT_CONTEXT_WINDOW_TOKENS);
  return Number.isSafeInteger(value) && value >= 4_096 ? value : DEFAULT_CONTEXT_WINDOW_TOKENS;
};

const estimateMessageTokens = (messages) => {
  const bytes = Buffer.byteLength(JSON.stringify(messages || []), "utf8");
  // This intentionally overestimates CJK-heavy prompts. The provider, not the
  // application, remains the source of truth; this guard prevents avoidable
  // context-window rejections before the request leaves the server.
  return Math.ceil(bytes / 2);
};

const resolveOutputTokens = ({ messages, requested }) => {
  const desired = Number.isSafeInteger(Number(requested))
    ? Math.min(MAX_OUTPUT_TOKENS, Math.max(MIN_OUTPUT_TOKENS, Number(requested)))
    : MIN_OUTPUT_TOKENS;
  const available = configuredContextWindow()
    - estimateMessageTokens(messages)
    - CONTEXT_SAFETY_MARGIN_TOKENS;
  if (available < MIN_OUTPUT_TOKENS) {
    throw Object.assign(new Error("Canvas Agent request context is too large."), {
      status: 413,
      code: "CANVAS_AGENT_CONTEXT_TOO_LARGE",
      details: {
        estimatedInputTokens: estimateMessageTokens(messages),
        contextWindowTokens: configuredContextWindow(),
      },
    });
  }
  return Math.min(desired, available);
};

const providerDetailText = (error) => {
  const detail = error?.details;
  if (!detail) return "";
  const message = detail?.error?.message || detail?.message || detail?.error?.code;
  return clean(message).slice(0, 500);
};

const isContextLimitError = (error) => /context|maximum context|too many tokens|token limit|prompt is too long|request too large/i
  .test(providerDetailText(error));

const shouldRetryWithoutJsonFormat = (error) => {
  if (Number(error?.status) !== 400 || isContextLimitError(error)) return false;
  const detail = providerDetailText(error);
  return !detail || /response.?format|json.?object|structured output|json mode|unsupported parameter/i.test(detail);
};

const parseJsonObject = (value) => {
  const raw = clean(value);
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) candidates.push(fenced.trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next safe extraction.
    }
  }
  fail("Canvas Agent model returned invalid JSON", "CANVAS_AGENT_INVALID_RESPONSE");
};

export const resolveCanvasAgentLlmConfiguration = async ({ userId, modelKey, resolvedRoute = null } = {}) => {
  const requestedModel = clean(resolvedRoute?.model_key || modelKey).toLowerCase();
  if (!requestedModel) fail("Canvas Agent text model is required", "CANVAS_AGENT_MODEL_REQUIRED", 400);
  const route = resolvedRoute || await resolveActiveModelRoute({ modelKey: requestedModel, outputType: "agent", userId });
  if (route.provider_key !== "canvas_agent") {
    fail("The selected text model has no Canvas Agent provider adapter", "CANVAS_AGENT_MODEL_ROUTE_UNSUPPORTED", 409);
  }
  const apiKey = clean(
    process.env.CANVAS_AGENT_LLM_API_KEY
    || process.env.CREATIVE_LLM_API_KEY
    || process.env.CANVAS_AGENT_KEY
    || process.env.OPENAI_API_KEY,
  );
  if (!apiKey) fail("Canvas Agent LLM key is not configured", "CANVAS_AGENT_PROVIDER_NOT_CONFIGURED", 503);
  const baseUrl = clean(
    process.env.CANVAS_AGENT_LLM_BASE_URL
    || process.env.CREATIVE_LLM_BASE_URL
    || process.env.CANVAS_AGENT_BASE_URL
    || "https://hkg.apikl.ai/v1",
  ).replace(/\/+$/, "");
  const requestedEffort = clean(route.route_config?.reasoning_effort || process.env.CANVAS_AGENT_REASONING_EFFORT || "medium").toLowerCase();
  return {
    apiKey,
    baseUrl,
    modelKey: requestedModel,
    model: route.upstream_model_id,
    routeId: route.id,
    reasoningEffort: REASONING_EFFORTS.has(requestedEffort) ? requestedEffort : "medium",
  };
};

export const requestCanvasAgentJson = async ({
  userId,
  modelKey,
  system,
  messages = [],
  temperature = 0.2,
  maxTokens = 2400,
  timeoutMs = 60_000,
  modelRoute = null,
} = {}) => {
  const config = await resolveCanvasAgentLlmConfiguration({ userId, modelKey, resolvedRoute: modelRoute });
  const baseMessages = [
    { role: "system", content: String(system || "") },
    ...messages.map((message) => ({ role: message.role, content: String(message.content || "") })),
  ];
  const request = (requestMessages, requestTemperature = temperature, useJsonResponseFormat = true) => {
    const effectiveMaxTokens = resolveOutputTokens({ messages: requestMessages, requested: maxTokens });
    return requestWithProviderRetry(
      () => requestChatCompletionStream({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        label: "Canvas Agent",
        timeoutMs,
        body: {
          model: config.model,
          reasoning_effort: config.reasoningEffort,
          temperature: requestTemperature,
          max_tokens: effectiveMaxTokens,
          ...(useJsonResponseFormat ? { response_format: { type: "json_object" } } : {}),
          messages: requestMessages,
        },
        includeUsage: agentModelUsesTokenPricing(config.modelKey),
      }),
      { model: config.model, routeId: config.routeId },
    );
  };

  let response;
  try {
    response = await request(baseMessages);
  } catch (error) {
    if (!shouldRetryWithoutJsonFormat(error)) throw error;
    logger.warn("canvasAgent.responseFormatRetry", {
      model: config.model,
      routeId: config.routeId,
      detail: providerDetailText(error) || null,
    });
    response = await request(baseMessages, temperature, false);
  }
  let data;
  let totalUsage = response.usage || null;
  try {
    data = parseJsonObject(response.content);
  } catch (error) {
    if (error?.code !== "CANVAS_AGENT_INVALID_RESPONSE") throw error;
    logger.warn("canvasAgent.independent.repairInvalidResponse", {
      model: config.model,
      routeId: config.routeId,
      contentLength: String(response.content || "").length,
    });
    const previousContent = String(response.content || "").slice(0, 4_000);
    const repaired = await request([
      ...baseMessages,
      ...(previousContent ? [{ role: "assistant", content: previousContent }] : []),
      {
        role: "user",
        content: "Your previous answer was not valid JSON. Return only one valid JSON object matching the required schema. Do not include markdown, explanation, or multiple alternatives.",
      },
    ], 0);
    totalUsage = sumAgentTokenUsage(totalUsage, repaired.usage);
    try {
      data = parseJsonObject(repaired.content);
    } catch (repairError) {
      if (repairError?.code !== "CANVAS_AGENT_INVALID_RESPONSE") throw repairError;
      throw Object.assign(new Error("Canvas Agent model returned invalid JSON after one repair attempt"), {
        code: "CANVAS_AGENT_INVALID_RESPONSE",
        status: 502,
        cause: repairError,
        details: {
          attempts: 2,
          firstContentLength: String(response.content || "").length,
          secondContentLength: String(repaired.content || "").length,
        },
      });
    }
  }
  return {
    data,
    model: config.modelKey,
    routeId: config.routeId,
    usage: totalUsage,
  };
};

export const requestCanvasAgentText = async ({ userId, modelKey, modelRoute = null, system, prompt, timeoutMs = 60_000 } = {}) => {
  const response = await requestCanvasAgentJson({
    userId,
    modelKey,
    modelRoute,
    system,
    messages: [{ role: "user", content: `${String(prompt || "")}\n\nReturn JSON: {\"content\":\"...\"}` }],
    timeoutMs,
  });
  return { ...response, content: String(response.data?.content || "").trim() };
};
