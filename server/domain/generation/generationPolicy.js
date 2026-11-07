import { createHash } from "node:crypto";
import { assertTemplateMembership } from "../templates/templateAccessPolicy.js";

export { assertTemplateMembership } from "../templates/templateAccessPolicy.js";
export { inferGenerationMode } from "../pricing/generationChargeRule.js";

export const normalizeGenerationPrompt = (value) => {
  if (typeof value !== "string") {
    throw Object.assign(new Error("user_prompt must be a string"), {
      status: 400,
      code: "INVALID_GENERATION_PROMPT",
    });
  }
  const prompt = value.trim();
  if (!prompt || prompt.length > 6000) {
    throw Object.assign(new Error("user_prompt must contain between 1 and 6000 characters"), {
      status: 400,
      code: "INVALID_GENERATION_PROMPT",
    });
  }
  return prompt;
};

const MIN_DUPLICATE_PROMPT_LENGTH = 32;
export const IMAGE_PROVIDER_PROMPT_UTF8_BUDGET = 4_500;

const normalizePromptForDuplicateComparison = (value) => String(value || "")
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[\p{White_Space}\p{Punctuation}\p{Symbol}]+/gu, "");

/**
 * Remove only formatting-equivalent content that is already fully present in
 * the hidden template system prompt. Original template and creation records
 * remain untouched; this only changes the provider-bound prompt.
 */
export const deduplicateTemplateUserPrompt = ({ systemPrompt, starterPrompt, userPrompt } = {}) => {
  const prompt = String(userPrompt || "").trim();
  const starter = String(starterPrompt || "").trim();
  const normalizedPrompt = normalizePromptForDuplicateComparison(prompt);
  const normalizedSystem = normalizePromptForDuplicateComparison(systemPrompt);
  const normalizedStarter = normalizePromptForDuplicateComparison(starter);
  const duplicate = normalizedPrompt.length >= MIN_DUPLICATE_PROMPT_LENGTH
    && normalizedSystem.includes(normalizedPrompt);

  if (duplicate) {
    return {
      prompt: "",
      removed: true,
      reason: normalizedStarter && normalizedPrompt === normalizedStarter
        ? "starter_prompt_duplicate"
        : "system_prompt_duplicate",
    };
  }

  const starterIsInSystem = normalizedStarter.length >= MIN_DUPLICATE_PROMPT_LENGTH
    && normalizedSystem.includes(normalizedStarter);
  if (starterIsInSystem && starter && prompt.startsWith(starter)) {
    return {
      prompt: prompt.slice(starter.length).trim(),
      removed: true,
      reason: "starter_prompt_removed_from_user_prompt",
    };
  }

  return { prompt, removed: false, reason: null };
};

const truncateUtf8 = (value, maxBytes) => {
  if (maxBytes <= 0) return "";
  let result = "";
  let usedBytes = 0;
  for (const character of String(value || "")) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result.trimEnd();
};

/**
 * Keep provider-bound image prompts below the upstream byte budget. User
 * instructions have priority over template guidance when trimming is needed.
 */
export const composeImageProviderPrompt = ({
  systemPrompt,
  userPrompt,
  negativePrompt,
  maxUtf8Bytes = IMAGE_PROVIDER_PROMPT_UTF8_BUDGET,
} = {}) => {
  const budget = Number.isSafeInteger(maxUtf8Bytes) && maxUtf8Bytes > 0
    ? maxUtf8Bytes
    : IMAGE_PROVIDER_PROMPT_UTF8_BUDGET;
  const system = String(systemPrompt || "").trim();
  const user = String(userPrompt || "").trim();
  const negative = String(negativePrompt || "").trim();
  const negativeInstruction = negative ? `Avoid: ${negative}` : "";
  const originalPrompt = [system, user, negativeInstruction].filter(Boolean).join("\n\n");
  const originalUtf8Bytes = Buffer.byteLength(originalPrompt, "utf8");

  if (originalUtf8Bytes <= budget) {
    return {
      prompt: originalPrompt,
      truncated: false,
      originalUtf8Bytes,
      finalUtf8Bytes: originalUtf8Bytes,
    };
  }

  const userPart = truncateUtf8(user, budget);
  let remainingBytes = budget - Buffer.byteLength(userPart, "utf8");
  let negativePart = "";
  if (negativeInstruction && remainingBytes > 2) {
    negativePart = truncateUtf8(negativeInstruction, remainingBytes - (userPart ? 2 : 0));
    remainingBytes -= Buffer.byteLength(negativePart, "utf8") + (userPart && negativePart ? 2 : 0);
  }

  const suffix = [userPart, negativePart].filter(Boolean).join("\n\n");
  const systemSeparatorBytes = system && suffix ? 2 : 0;
  const systemPart = truncateUtf8(system, Math.max(0, remainingBytes - systemSeparatorBytes));
  const prompt = [systemPart, suffix].filter(Boolean).join("\n\n");

  return {
    prompt,
    truncated: true,
    originalUtf8Bytes,
    finalUtf8Bytes: Buffer.byteLength(prompt, "utf8"),
  };
};

export const parseVisualParameterSelection = (value) => {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length > 8000) {
    throw Object.assign(new Error("visual_parameters must be a JSON object"), {
      status: 400,
      code: "INVALID_VISUAL_PARAMETER_SELECTION",
    });
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw Object.assign(new Error("visual_parameters must be valid JSON"), {
      status: 400,
      code: "INVALID_VISUAL_PARAMETER_SELECTION",
    });
  }
};

export const appendVisualNegativePrompt = (prompt, negativePrompt) => negativePrompt
  ? `${prompt}\n\nAvoid: ${negativePrompt}`
  : prompt;

export const normalizeVideoDuration = ({ requestedSeconds, defaultSeconds, isDigitalHuman = false, isHeyGen = false }) => {
  const digitalHuman = Boolean(isDigitalHuman || isHeyGen);
  const hasRequestedValue = requestedSeconds !== undefined
    && requestedSeconds !== null
    && String(requestedSeconds).trim() !== "";
  const rawValue = hasRequestedValue
    ? requestedSeconds
    : (defaultSeconds ?? (digitalHuman ? 30 : 8));
  const isIntegerText = typeof rawValue !== "string" || /^\d+$/.test(rawValue.trim());
  const normalized = Number(rawValue);
  const minimum = digitalHuman ? 15 : 1;
  const maximum = 180;

  if (!isIntegerText || !Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw Object.assign(
      new Error(`Video duration must be an integer between ${minimum} and ${maximum} seconds`),
      {
        status: hasRequestedValue ? 400 : 503,
        code: hasRequestedValue ? "INVALID_VIDEO_DURATION" : "INVALID_TEMPLATE_DURATION",
      },
    );
  }
  return normalized;
};

export const normalizeGenerationMetadata = (value) => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
};

export const hashGenerationRequest = (fields, referenceImages = []) => {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(fields));
  for (const image of referenceImages) {
    hash.update("\0reference\0");
    hash.update(image.buffer);
  }
  return hash.digest("hex");
};

export const assertCreationIdempotencyMatch = (existing, requestHash) => {
  const meta = normalizeGenerationMetadata(existing?.meta_info);
  if (!requestHash || meta.request_hash !== requestHash) {
    throw Object.assign(new Error("X-Idempotency-Key was already used with a different generation request"), {
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  }
};

export const requireExpectedModelProvider = (route, allowedProviders) => {
  if (!route || !Array.isArray(allowedProviders) || !allowedProviders.includes(route.provider_key)) {
    throw Object.assign(new Error("The selected model route is incompatible with this generation endpoint"), {
      status: 409,
      code: "MODEL_ROUTE_INCOMPATIBLE",
    });
  }
  return route;
};
