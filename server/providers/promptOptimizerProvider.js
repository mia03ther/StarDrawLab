import logger from "../configs/logger.js";
import {
  resolveCreativeLlmConfiguration,
  withCreativeLlmOptions,
} from "../services/creativeLlmConfiguration.js";
import { requestChatCompletionStream } from "./openAICompatibleStream.js";
import { agentModelUsesTokenPricing } from "../domain/pricing/agentTokenPricing.js";

const MAX_INPUT_LENGTH = 4000;
const MAX_OUTPUT_LENGTH = 5000;

const shortText = (value, max = MAX_INPUT_LENGTH) => String(value || "").trim().slice(0, max);

const IMAGE_ASPECT_RATIOS = [
  ["1:1", 1],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["21:9", 21 / 9],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
];

const resolveAspectRatio = (size) => {
  const [width, height] = String(size || "").split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return "";
  const ratio = width / height;
  return IMAGE_ASPECT_RATIOS.reduce((closest, candidate) => (
    Math.abs(ratio - candidate[1]) < Math.abs(ratio - closest[1]) ? candidate : closest
  ))[0];
};

const cleanOptimizedPrompt = (value) => {
  const text = String(value || "")
    .trim()
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed.trim();
    } catch {
      // Keep the provider text when it is not a JSON string.
    }
  }
  return text;
};

const buildSystemPrompt = ({ outputType, language, template, model, size, seconds }) => {
  const isVideo = outputType === "video";
  const templateContext = [
    template?.sceneName ? `Template: ${shortText(template.sceneName, 160)}` : "",
    template?.systemPrompt ? `Template system direction: ${shortText(template.systemPrompt, 1800)}` : "",
    template?.starterPrompt ? `Template starter prompt: ${shortText(template.starterPrompt, 800)}` : "",
    model ? `Target model: ${shortText(model, 100)}` : "",
    size ? `Output pixel size: ${shortText(size, 60)}` : "",
    size && !isVideo && resolveAspectRatio(size) ? `Output aspect ratio: ${resolveAspectRatio(size)}` : "",
    isVideo && seconds ? `Duration: ${Number(seconds)} seconds` : "",
  ].filter(Boolean).join("\n");

  const taskRules = isVideo
    ? [
        "Improve subject motion, camera movement, shot progression, timing, continuity, physical plausibility, lighting, atmosphere, and ending frame only where relevant.",
        "Make the result directly usable by a text-to-video or image-to-video model.",
      ]
    : [
        "Improve subject detail, composition, framing, camera or lens language, lighting, materials, color, background, atmosphere, and production finish only where relevant.",
        "Respect the requested output aspect ratio when describing composition and framing. Do not default to square composition when another ratio is provided.",
        "Make the result directly usable by a text-to-image or image-editing model.",
      ];

  return [
    `You are StarDraw's professional ${isVideo ? "video" : "image"} generation prompt editor.`,
    "Rewrite the user's prompt into a precise, coherent production prompt.",
    "Preserve the user's intent, named subjects, quantities, facts, required text, constraints, and requested changes.",
    "Do not invent product claims, people, brands, or requirements that the user did not provide.",
    "Do not add generic quality filler, forced watermark rules, or unrelated visual styles.",
    "Use the template context to complement the prompt, but do not repeat the template system direction verbatim.",
    ...taskRules,
    `Write in ${language === "en" ? "English" : "Simplified Chinese"}.`,
    "Output only the optimized prompt. Do not explain, label sections, quote the result, or use Markdown.",
    templateContext,
  ].filter(Boolean).join("\n");
};

export const optimizeGenerationPrompt = async ({
  userId,
  prompt,
  outputType,
  language = "zh",
  template = {},
  model = "",
  size = "",
  seconds = null,
  modelRoute = null,
}) => {
  const safePrompt = shortText(prompt);
  const safeOutputType = outputType === "video" ? "video" : "image";
  const safeLanguage = language === "en" ? "en" : "zh";
  if (!safePrompt) throw Object.assign(new Error("Prompt is required"), { status: 400, code: "PROMPT_REQUIRED" });

  const config = await resolveCreativeLlmConfiguration({ userId, resolvedRoute: modelRoute });
  try {
    const result = await requestChatCompletionStream({
      baseUrl: config.baseUrl,
      apiKey: config.key,
      timeoutMs: Number(process.env.AGENT_PROVIDER_TIMEOUT_MS || 120_000),
      label: "Prompt optimizer",
      body: withCreativeLlmOptions(config, {
        messages: [
          { role: "system", content: buildSystemPrompt({
            outputType: safeOutputType,
            language: safeLanguage,
            template,
            model,
            size,
            seconds,
          }) },
          { role: "user", content: safePrompt },
        ],
        max_tokens: 1800,
      }),
      includeUsage: agentModelUsesTokenPricing(config.modelKey),
    });
    const optimized = cleanOptimizedPrompt(result.content);
    if (!optimized) {
      throw Object.assign(new Error("Prompt optimizer returned empty content"), {
        status: 502,
        code: "AGENT_PROVIDER_INVALID_RESPONSE",
      });
    }
    return {
      success: true,
      optimized: optimized.slice(0, MAX_OUTPUT_LENGTH),
      model: config.model,
      model_key: config.modelKey,
      model_route_id: config.routeId,
      provider: "creative_llm",
      streamed: result.streamed,
      usage: result.usage || null,
    };
  } catch (error) {
    logger.error("promptOptimizer.error", {
      message: error.message,
      status: error.status,
      code: error.code,
      model: config.model,
      baseUrl: config.baseUrl,
    });
    throw error;
  }
};
