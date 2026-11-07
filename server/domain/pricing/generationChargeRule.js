const OUTPUT_TYPES = new Set(["image", "video", "agent"]);
const MEDIA_OUTPUT_TYPES = new Set(["image", "video"]);
const GENERATION_MODES = new Set(["all", "freeform", "template"]);
const BILLING_TYPES = new Set(["fixed", "per_minute", "token_usage"]);
const IMAGE_QUALITIES = new Set(["1k", "2k", "4k"]);
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SIZE_PATTERN = /^\d{1,5}x\d{1,5}$/;

const fail = (message, code = "INVALID_GENERATION_CHARGE_RULE") => {
  throw Object.assign(new Error(message), { status: 400, code });
};

const clean = (value, max) => String(value ?? "").trim().slice(0, max);

const optionalString = (value, max) => {
  const normalized = clean(value, max);
  return normalized || null;
};

const integer = (value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    fail(`${name} must be an integer between ${min} and ${max}`);
  }
  return normalized;
};

const number = (value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    fail(`${name} must be a number between ${min} and ${max}`);
  }
  return normalized;
};

const optionalInteger = (value, name, options) => {
  if (value === undefined || value === null || value === "") return null;
  return integer(value, null, name, options);
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

// Preserve an existing value only when the caller omitted both accepted field names.
// This lets update requests explicitly clear nullable match conditions with null.
const inputValue = (input, camelKey, snakeKey, fallback) => {
  if (hasOwn(input, camelKey)) return input[camelKey];
  if (hasOwn(input, snakeKey)) return input[snakeKey];
  return fallback;
};

const normalizeMetaRule = (value, outputType = "") => {
  const meta = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  const billingType = String(meta.billing_type || "fixed").trim().toLowerCase();
  if (!BILLING_TYPES.has(billingType)) fail("meta_rule.billing_type must be fixed, per_minute, or token_usage");

  const normalized = { ...meta, billing_type: billingType };
  if (billingType === "per_minute") {
    normalized.points_per_minute = integer(meta.points_per_minute, 0, "meta_rule.points_per_minute", { min: 1, max: 2_147_483_647 });
    normalized.minimum_points = integer(meta.minimum_points, 0, "meta_rule.minimum_points", { min: 0, max: 2_147_483_647 });
  } else if (billingType === "token_usage") {
    if (String(outputType).trim().toLowerCase() !== "agent") {
      fail("token_usage billing is only valid for Agent rules");
    }
    normalized.unit_tokens = integer(meta.unit_tokens, 1_000_000, "meta_rule.unit_tokens", { min: 1, max: 2_147_483_647 });
    normalized.points_per_currency_unit = integer(
      meta.points_per_currency_unit,
      100,
      "meta_rule.points_per_currency_unit",
      { min: 1, max: 2_147_483_647 },
    );
    normalized.input_price = number(meta.input_price, 0, "meta_rule.input_price", { min: Number.EPSILON });
    normalized.output_price = number(meta.output_price, 0, "meta_rule.output_price", { min: Number.EPSILON });
    normalized.cache_read_price = number(meta.cache_read_price, 0, "meta_rule.cache_read_price");
    normalized.cache_write_price = number(meta.cache_write_price, 0, "meta_rule.cache_write_price");
    normalized.minimum_points = integer(meta.minimum_points, 1, "meta_rule.minimum_points", { min: 1, max: 2_147_483_647 });
    delete normalized.points_per_minute;
  } else {
    delete normalized.points_per_minute;
    delete normalized.minimum_points;
    delete normalized.unit_tokens;
    delete normalized.points_per_currency_unit;
    delete normalized.input_price;
    delete normalized.output_price;
    delete normalized.cache_read_price;
    delete normalized.cache_write_price;
  }
  if (String(outputType).trim().toLowerCase() === "image" && meta.image_quality != null && String(meta.image_quality).trim()) {
    const quality = String(meta.image_quality).trim().toLowerCase();
    if (!IMAGE_QUALITIES.has(quality)) fail("meta_rule.image_quality must be 1k, 2k, or 4k");
    normalized.image_quality = quality;
  } else {
    delete normalized.image_quality;
  }
  if (JSON.stringify(normalized).length > 20_000) fail("meta_rule is too large");
  return normalized;
};

export const inferGenerationMode = ({ outputType, sceneKey } = {}) => {
  const type = String(outputType || "").trim().toLowerCase();
  const scene = String(sceneKey || "").trim().toLowerCase();
  if (!MEDIA_OUTPUT_TYPES.has(type) || !scene) return "all";
  if (MEDIA_OUTPUT_TYPES.has(type) && scene === `freeform_${type}`) return "freeform";
  return "template";
};

export const normalizeGenerationMode = (value, outputType = "") => {
  const mode = String(value || "all").trim().toLowerCase() || "all";
  if (!GENERATION_MODES.has(mode)) fail("generation_mode must be all, freeform, or template");
  if (mode !== "all" && !MEDIA_OUTPUT_TYPES.has(String(outputType || "").trim().toLowerCase())) {
    fail("freeform and template modes are only valid for image or video rules");
  }
  return mode;
};

export const normalizeGenerationChargeRule = (input = {}, existing = null) => {
  const outputType = clean(inputValue(input, "outputType", "output_type", existing?.output_type), 20).toLowerCase();
  const provider = clean(inputValue(input, "provider", "provider", existing?.provider), 50).toLowerCase();
  const sceneKey = optionalString(inputValue(input, "sceneKey", "scene_key", existing?.scene_key), 50);
  const model = optionalString(inputValue(input, "model", "model", existing?.model), 100)?.toLowerCase() || null;
  const seconds = optionalInteger(inputValue(input, "seconds", "seconds", existing?.seconds), "seconds", { min: 1, max: 180 });
  const size = optionalString(inputValue(input, "size", "size", existing?.size), 20);
  const pointsCost = integer(inputValue(input, "pointsCost", "points_cost", existing?.points_cost), null, "points_cost", { min: 1, max: 2_147_483_647 });
  const priority = integer(inputValue(input, "priority", "priority", existing?.priority), 100, "priority", { min: 0, max: 1_000_000 });
  const generationMode = normalizeGenerationMode(
    inputValue(input, "generationMode", "generation_mode", existing?.generation_mode ?? "all"),
    outputType,
  );
  const metaRule = normalizeMetaRule(inputValue(input, "metaRule", "meta_rule", existing?.meta_rule), outputType);
  const isActiveInput = inputValue(input, "isActive", "is_active", existing?.is_active);

  if (!OUTPUT_TYPES.has(outputType)) fail("output_type must be image, video, or agent");
  if (!PROVIDER_KEY_PATTERN.test(provider)) fail("provider is invalid");
  if (sceneKey && /[^a-zA-Z0-9._:-]/.test(sceneKey)) fail("scene_key contains unsupported characters");
  if (model && !MODEL_KEY_PATTERN.test(model)) fail("model is invalid");
  if (size && !SIZE_PATTERN.test(size)) fail("size must use WIDTHxHEIGHT format");
  if (metaRule.billing_type === "per_minute" && outputType !== "video") {
    fail("per_minute billing is only valid for video rules");
  }

  return {
    outputType,
    provider,
    sceneKey,
    model,
    seconds,
    size,
    pointsCost,
    priority,
    generationMode,
    isActive: isActiveInput == null ? true : Boolean(isActiveInput),
    metaRule,
  };
};

export const generationChargeRuleModes = Object.freeze([...GENERATION_MODES]);
export const generationChargeRuleOutputTypes = Object.freeze([...OUTPUT_TYPES]);
