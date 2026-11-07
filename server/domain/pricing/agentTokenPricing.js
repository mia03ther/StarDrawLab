const TOKEN_UNIT = 1_000_000;
export const AGENT_TOKEN_BILLING_TYPE = "token_usage";
export const AGENT_POINTS_PER_CNY = 100;

const cleanObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const nonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const nonNegativeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const positiveInteger = (value, fallback = 1) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const firstTokenCount = (...values) => values.reduce((found, value) => (
  found > 0 ? found : nonNegativeInteger(value)
), 0);

/**
 * Normalizes OpenAI-compatible and Anthropic-style usage payloads. OpenAI
 * reports cached input inside prompt_tokens; Anthropic-style APIs report cache
 * counters separately, so only the former is subtracted from regular input.
 */
export const normalizeAgentTokenUsage = (value) => {
  const usage = cleanObject(value);
  const promptDetails = cleanObject(usage.prompt_tokens_details || usage.promptTokensDetails);
  const inputDetails = cleanObject(usage.input_tokens_details || usage.inputTokensDetails);
  const cacheReadTokens = firstTokenCount(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cached_input_tokens,
    usage.cachedInputTokens,
    inputDetails.cache_read_input_tokens,
    inputDetails.cacheReadInputTokens,
    promptDetails.cached_tokens,
    promptDetails.cachedTokens,
  );
  const cacheWriteTokens = firstTokenCount(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cache_write_input_tokens,
    usage.cacheWriteInputTokens,
    inputDetails.cache_creation_input_tokens,
    inputDetails.cacheCreationInputTokens,
    inputDetails.cache_write_input_tokens,
    inputDetails.cacheWriteInputTokens,
    promptDetails.cache_creation_tokens,
    promptDetails.cacheCreationTokens,
  );
  const promptTokens = firstTokenCount(usage.prompt_tokens, usage.promptTokens);
  const inputTokens = promptTokens > 0
    ? Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens)
    : firstTokenCount(usage.input_tokens, usage.inputTokens);
  const outputTokens = firstTokenCount(
    usage.completion_tokens,
    usage.completionTokens,
    usage.output_tokens,
    usage.outputTokens,
  );

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
};

export const hasAgentTokenUsage = (value) => {
  const usage = normalizeAgentTokenUsage(value);
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0;
};

export const sumAgentTokenUsage = (...values) => values.reduce((total, value) => {
  const usage = normalizeAgentTokenUsage(value);
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    cacheReadTokens: total.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + usage.cacheWriteTokens,
  };
}, {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export const normalizeAgentTokenPricing = (value, { fallbackMinimumPoints = 1 } = {}) => {
  const source = cleanObject(value);
  const pricing = {
    unitTokens: positiveInteger(source.unit_tokens ?? source.unitTokens, TOKEN_UNIT),
    pointsPerCurrencyUnit: positiveInteger(
      source.points_per_currency_unit ?? source.pointsPerCurrencyUnit,
      AGENT_POINTS_PER_CNY,
    ),
    inputPrice: nonNegativeNumber(source.input_price ?? source.inputPrice),
    outputPrice: nonNegativeNumber(source.output_price ?? source.outputPrice),
    cacheReadPrice: nonNegativeNumber(source.cache_read_price ?? source.cacheReadPrice),
    cacheWritePrice: nonNegativeNumber(source.cache_write_price ?? source.cacheWritePrice),
    minimumPoints: positiveInteger(source.minimum_points ?? source.minimumPoints, fallbackMinimumPoints),
  };

  if (pricing.inputPrice <= 0 || pricing.outputPrice <= 0) {
    throw Object.assign(new Error("Agent token pricing requires positive input and output prices"), {
      status: 503,
      code: "INVALID_AGENT_TOKEN_PRICING",
    });
  }
  return pricing;
};

export const calculateAgentTokenCharge = ({ usage, pricing, fallbackMinimumPoints = 1 } = {}) => {
  const normalizedUsage = normalizeAgentTokenUsage(usage);
  const normalizedPricing = normalizeAgentTokenPricing(pricing, { fallbackMinimumPoints });
  const currencyCost = (
    (normalizedUsage.inputTokens * normalizedPricing.inputPrice)
    + (normalizedUsage.outputTokens * normalizedPricing.outputPrice)
    + (normalizedUsage.cacheReadTokens * normalizedPricing.cacheReadPrice)
    + (normalizedUsage.cacheWriteTokens * normalizedPricing.cacheWritePrice)
  ) / normalizedPricing.unitTokens;
  const rawPoints = currencyCost * normalizedPricing.pointsPerCurrencyUnit;
  const roundedPoints = Math.ceil(rawPoints - Number.EPSILON);

  return {
    pointsCost: Math.max(normalizedPricing.minimumPoints, roundedPoints),
    currencyCost,
    rawPoints,
    usage: normalizedUsage,
    pricing: normalizedPricing,
  };
};

export const agentModelUsesTokenPricing = (modelKey) => ![
  "step-3.7-flash",
  "minimax-m3",
].includes(String(modelKey || "").trim().toLowerCase());

