import logger from "../configs/logger.js";
import { requestChatCompletionStream } from "./openAICompatibleStream.js";
import {
  resolveCreativeLlmConfiguration,
  withCreativeLlmOptions,
} from "../services/creativeLlmConfiguration.js";
import { agentModelUsesTokenPricing } from "../domain/pricing/agentTokenPricing.js";

const MAX_INPUT_LENGTH = 2400;
const MAX_OUTPUT_LENGTH = 2600;

const shortText = (value, max = MAX_INPUT_LENGTH) => String(value || "").trim().slice(0, max);

const getOptimizerConfig = async (userId, resolvedRoute = null) => resolveCreativeLlmConfiguration({
  userId,
  resolvedRoute,
});

export const optimizeDigitalHumanScript = async ({
  userId,
  brief,
  language = "zh",
  durationSeconds = 30,
  modelRoute = null,
}) => {
  const config = await getOptimizerConfig(userId, modelRoute);
  const safeBrief = shortText(brief);
  const safeLanguage = language === "en" ? "en" : "zh";
  const safeDuration = Math.min(180, Math.max(15, Number(durationSeconds) || 30));

  if (!safeBrief) {
    throw new Error("Brief is required");
  }

  const systemPrompt = safeLanguage === "zh"
    ? [
        "你是 StarDraw 的数字人口播脚本导演。",
        "任务：把用户输入的粗略 brief 改写成可直接交给 HeyGen Video Agent 的高质量数字人视频提示词。",
        "要求：只输出优化后的提示词，不要解释，不要 Markdown。",
        "提示词应包含：数字人角色设定、受众、视频目标、自然口播结构、3 个核心要点、结尾行动号召、语气、节奏、画面风格。",
        "避免夸张承诺、避免空泛形容，保留用户给出的产品名、事实、数字和限制。",
        `目标时长约 ${safeDuration} 秒。`,
      ].join("\n")
    : [
        "You are StarDraw's presenter-video script director.",
        "Rewrite the user's rough brief into a high-quality prompt ready for HeyGen Video Agent.",
        "Output only the improved prompt. No explanations. No Markdown.",
        "Include presenter persona, audience, video goal, natural spoken structure, three key points, closing call to action, tone, pacing, and visual style.",
        "Avoid exaggerated claims and generic filler. Preserve product names, facts, numbers, and constraints from the user.",
        `Target duration is about ${safeDuration} seconds.`,
      ].join("\n");

  const userPrompt = safeLanguage === "zh"
    ? `原始 brief：\n${safeBrief}\n\n请优化成数字人视频生成提示词。`
    : `Original brief:\n${safeBrief}\n\nRewrite this as a digital presenter video prompt.`;

  try {
    const result = await requestChatCompletionStream({
      baseUrl: config.baseUrl,
      apiKey: config.key,
      timeoutMs: Number(process.env.AGENT_PROVIDER_TIMEOUT_MS || 120_000),
      label: "Script optimizer",
      body: withCreativeLlmOptions(config, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.35,
        max_tokens: 1200,
      }),
      includeUsage: agentModelUsesTokenPricing(config.modelKey),
    });

    const optimized = String(result.content || "").trim();

    if (!optimized) {
      throw new Error("Script optimizer returned empty content.");
    }

    return {
      success: true,
      optimized: optimized.slice(0, MAX_OUTPUT_LENGTH),
      model: config.model,
      model_key: config.modelKey,
      model_route_id: config.routeId,
      provider: "canvas_agent_llm",
      streamed: result.streamed,
      usage: result.usage || null,
    };
  } catch (err) {
    logger.error("scriptOptimizer.error", {
      message: err.message,
      status: err.status,
      details: err.details,
      model: config.model,
      baseUrl: config.baseUrl,
    });
    throw err;
  }
};
