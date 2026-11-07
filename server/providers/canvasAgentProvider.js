import logger from "../configs/logger.js";
import { agentRetryDelayMs, isRetryableAgentError } from "../domain/agent/retryPolicy.js";
import { requestChatCompletionStream, stringifyMessageContent } from "./openAICompatibleStream.js";
import { getAgentSkillRegistry } from "../services/agentSkillRegistry.js";
import { compileConfiguredVisualPrompt } from "../services/visualParameterService.js";
import { serializeGlobalAgentContext } from "../services/globalAgentContextSerialization.js";
import {
  resolveCreativeLlmConfiguration,
  withCreativeLlmOptions,
} from "../services/creativeLlmConfiguration.js";
import {
  agentModelUsesTokenPricing,
  sumAgentTokenUsage,
} from "../domain/pricing/agentTokenPricing.js";

const MAX_AGENT_ACTIONS = 16;
const MAX_AGENT_MENTIONS = 24;
const MAX_AGENT_TEMPLATES = 48;
const MAX_PROMPT_LENGTH = 2400;
const MAX_NOTE_TEXT_LENGTH = 1800;
const MAX_CANVAS_COORD = 1000000000;
const MAX_AGENT_DELTA = 5000;
const MAX_AGENT_ELEMENT_SIZE = 6000;
const MAX_GLOBAL_AGENT_CALLS = 12;
const MEDIA_GENERATION_TOOLS = new Set(["media.generate.image", "media.generate.video"]);
const GLOBAL_TOOL_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const TRANSIENT_AGENT_PROVIDER_STATUSES = new Set([429, 500, 502, 503, 504]);
const SIMPLE_CONVERSATION_PATTERN = /^(?:(?:你好|您好|嗨|哈喽|hello|hi)|(?:(?:你好|您好|嗨|哈喽|hello|hi)[，,\s]*)?(?:你会做什么(?:呢)?|你能做什么(?:呢)?|你可以做什么(?:呢)?|介绍一下你|what can you do))[!！,.，。?？\s]*$/i;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const shortText = (value, max = 240) => String(value || "").trim().slice(0, max);
const isSimpleConversation = (value) => SIMPLE_CONVERSATION_PATTERN.test(shortText(value, MAX_PROMPT_LENGTH));

const normalizeHexColor = (value, fallback) => {
  const color = shortText(value, 16);
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : fallback;
};

const getAgentConfig = async (userId, resolvedRoute = null, requestedReasoningEffort = "") => resolveCreativeLlmConfiguration({
  userId,
  resolvedRoute,
  requestedReasoningEffort,
});

const shouldSkipJsonResponseFormat = (config) => {
  const model = String(config?.model || "").toLowerCase();
  const baseUrl = String(config?.baseUrl || "").toLowerCase();
  return model.includes("kimi") || model.includes("moonshot") || baseUrl.includes("ranai");
};

const compactCanvas = (canvas = {}) => ({
  title: shortText(canvas.title, 120),
  viewport: canvas.state?.viewport || {},
  elements: Array.isArray(canvas.state?.elements)
    ? canvas.state.elements.slice(0, 80).map((element) => ({
        id: shortText(element.id, 80),
        type: shortText(element.type, 16),
        title: shortText(element.title, 80),
        x: Math.round(Number(element.x || 0)),
        y: Math.round(Number(element.y || 0)),
        width: Math.round(Number(element.width || 0)),
        height: Math.round(Number(element.height || 0)),
        locked: Boolean(element.locked),
        text: element.type === "text" ? shortText(element.text, 220) : "",
      }))
    : [],
  storyboard: {
    shots: Array.isArray(canvas.state?.storyboard?.shots)
      ? canvas.state.storyboard.shots.slice(0, 80).map((shot, index) => ({
          id: shortText(shot?.id || `shot_${index + 1}`, 80),
          title: shortText(shot?.title, 120),
          prompt: shortText(shot?.prompt, 700),
          description: shortText(shot?.description, 300),
          duration: clamp(shot?.duration, 0.1, 3600, 3),
          camera: shortText(shot?.camera || shot?.cameraMovement, 80),
          style: shortText(shot?.style, 120),
          assetId: shortText(shot?.assetId || shot?.elementId, 80),
        }))
      : [],
  },
  timeline: {
    fps: clamp(canvas.state?.timeline?.fps, 1, 120, 30),
    tracks: Array.isArray(canvas.state?.timeline?.tracks)
      ? canvas.state.timeline.tracks.slice(0, 16).map((track, trackIndex) => ({
          id: shortText(track?.id || `track_${trackIndex + 1}`, 80),
          type: shortText(track?.type || "video", 20),
          name: shortText(track?.name, 80),
          clips: Array.isArray(track?.clips) ? track.clips.slice(0, 120).map((clip, clipIndex) => ({
            id: shortText(clip?.id || `clip_${trackIndex + 1}_${clipIndex + 1}`, 80),
            assetId: shortText(clip?.assetId || clip?.elementId, 80),
            start: clamp(clip?.start, 0, 86400, 0),
            duration: clamp(clip?.duration, 0.1, 86400, 3),
            sourceStart: clamp(clip?.sourceStart, 0, 86400, 0),
            sourceDuration: clamp(clip?.sourceDuration, 0, 86400, 0),
          })) : [],
        }))
      : [],
  },
  director3d: {
    enabled: Boolean(canvas.state?.director3d?.enabled),
    scene: shortText(canvas.state?.director3d?.scene, 120),
    lighting: shortText(canvas.state?.director3d?.lighting, 120),
    environment: shortText(canvas.state?.director3d?.environment, 120),
    camera: canvas.state?.director3d?.camera || {},
  },
});

const normalizeTemplate = (template) => {
  const sceneKey = shortText(template?.scene_key, 80);
  if (!sceneKey) return null;

  return {
    scene_key: sceneKey,
    scene_name: shortText(template?.scene_name || template?.preview_title || sceneKey, 120),
    preview_description: shortText(template?.preview_description, 220),
    starter_prompt: shortText(template?.starter_prompt, 360),
    tags: Array.isArray(template?.tags)
      ? template.tags.slice(0, 8).map((tag) => shortText(tag, 40)).filter(Boolean)
      : [],
    requires_reference: Boolean(template?.requires_reference),
    is_featured: Boolean(template?.is_featured),
    default_model: shortText(template?.default_model, 80),
    default_size: shortText(template?.default_size, 40),
  };
};

const isFreeformTemplate = (template) => {
  const text = `${template?.scene_key || ""} ${template?.scene_name || ""}`.toLowerCase();
  return /freeform|自由/.test(text)
    || (Array.isArray(template?.tags)
      && template.tags.some((tag) => /freeform|自由/i.test(String(tag || ""))));
};

const normalizeTemplateList = (templates = []) => {
  if (!Array.isArray(templates)) return [];
  const rows = [];
  const seen = new Set();

  templates.forEach((template) => {
    const normalized = normalizeTemplate(template);
    if (!normalized || seen.has(normalized.scene_key)) return;
    seen.add(normalized.scene_key);
    rows.push(normalized);
  });

  if (rows.length <= MAX_AGENT_TEMPLATES) return rows;

  const prioritized = [];
  const pushUnique = (template) => {
    if (!template || prioritized.some((item) => item.scene_key === template.scene_key)) return;
    prioritized.push(template);
  };

  rows.filter(isFreeformTemplate).forEach(pushUnique);
  rows.filter((template) => template.is_featured && !isFreeformTemplate(template)).forEach(pushUnique);
  rows.forEach(pushUnique);

  return prioritized.slice(0, MAX_AGENT_TEMPLATES);
};

const normalizeTemplatesPayload = (templates = {}) => {
  const image = normalizeTemplate(templates.image);
  const video = normalizeTemplate(templates.video);
  const availableImages = normalizeTemplateList([
    ...(image ? [image] : []),
    ...(Array.isArray(templates.availableImages) ? templates.availableImages : []),
  ]);
  const availableVideos = normalizeTemplateList([
    ...(video ? [video] : []),
    ...(Array.isArray(templates.availableVideos) ? templates.availableVideos : []),
  ]);

  return {
    image,
    video,
    availableImages,
    availableVideos,
  };
};

const normalizeMentions = (mentions = []) => {
  if (!Array.isArray(mentions)) return [];

  return mentions
    .slice(0, MAX_AGENT_MENTIONS)
    .map((mention, index) => {
      const type = shortText(mention?.type, 40);
      if (!["asset", "element", "image_template", "video_template"].includes(type)) return null;

      const key = shortText(mention?.key || `${type}:${index + 1}`, 140);
      if (!key) return null;

      return {
        key,
        type,
        label: shortText(mention?.label || mention?.title || key, 120),
        title: shortText(mention?.title || mention?.label || key, 120),
        subtitle: shortText(mention?.subtitle, 120),
        elementId: shortText(mention?.elementId, 80),
        assetId: shortText(mention?.assetId, 80),
        assetType: shortText(mention?.assetType, 16),
        sceneKey: shortText(mention?.sceneKey, 80),
        url: shortText(mention?.url, 2048),
        poster: shortText(mention?.poster, 2048),
        prompt: shortText(mention?.prompt, 700),
        defaultModel: shortText(mention?.defaultModel, 80),
        defaultSize: shortText(mention?.defaultSize, 40),
      };
    })
    .filter(Boolean);
};

const stripJsonMarkdownFence = (text) => String(text || "")
  .trim()
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```$/i, "")
  .trim();

const extractJsonSlice = (text) => {
  const raw = stripJsonMarkdownFence(text);
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return raw;
  return raw.slice(start, end + 1);
};

const repairLooseJsonStringQuotes = (value) => {
  const input = String(value || "");
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (!inString) {
      if (char === "\"") inString = true;
      output += char;
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      const rest = input.slice(index + 1);
      const nextSignificant = rest.match(/\S/)?.[0] || "";
      if (!nextSignificant || [":", ",", "}", "]"].includes(nextSignificant)) {
        inString = false;
        output += char;
      } else {
        output += "\\\"";
      }
      continue;
    }

    output += char;
  }

  return output;
};

const repairLooseJson = (value) => {
  const sliced = extractJsonSlice(value)
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[“”]/g, "\"");
  return repairLooseJsonStringQuotes(sliced);
};

const extractJsonObject = (text) => {
  const raw = stripJsonMarkdownFence(text);
  if (!raw) throw new Error("Canvas agent returned an empty response.");

  try {
    return JSON.parse(raw);
  } catch (firstErr) {
    const sliced = extractJsonSlice(raw);
    if (!sliced.includes("{") || !sliced.includes("}")) {
      throw new Error("Canvas agent returned non-JSON content.");
    }

    try {
      return JSON.parse(sliced);
    } catch {
      try {
        return JSON.parse(repairLooseJson(sliced));
      } catch {
        throw firstErr;
      }
    }
  }
};

const providerContent = (data) => stringifyMessageContent(
  data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.output_text,
);

const providerContentDiagnostics = (data) => {
  const content = providerContent(data);
  return {
    contentLength: content.length,
    hasJsonObject: content.includes("{") && content.includes("}"),
    finishReason: shortText(
      data?.last_chunk?.choices?.[0]?.finish_reason
      || data?.choices?.[0]?.finish_reason,
      40,
    ) || null,
  };
};

const isRecoverableGlobalPlanOutputError = (error) => (
  error?.code === "AGENT_PROVIDER_EMPTY_PLAN"
  || error instanceof SyntaxError
  || /^Canvas agent returned (?:an empty response|non-JSON content)\.?$/i.test(String(error?.message || ""))
);

const invalidGlobalPlanResponseError = (error, data) => Object.assign(
  new Error("Canvas agent returned an invalid planning response."),
  {
    status: 502,
    code: "AGENT_PROVIDER_INVALID_RESPONSE",
    cause: error,
    details: providerContentDiagnostics(data),
  },
);

const providerRequest = async (body, config) => {
  // One initial request plus up to five safe replays. Planning is idempotent;
  // tool execution happens only after a plan is durably accepted.
  const configuredAttempts = Number(process.env.AGENT_PROVIDER_MAX_ATTEMPTS || 6);
  const maxAttempts = Number.isSafeInteger(configuredAttempts)
    ? Math.min(6, Math.max(1, configuredAttempts))
    : 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestChatCompletionStream({
        baseUrl: config.baseUrl,
        apiKey: config.key,
        body,
        timeoutMs: Number(process.env.AGENT_PROVIDER_TIMEOUT_MS || 120_000),
        label: "Canvas agent",
        includeUsage: agentModelUsesTokenPricing(config.modelKey),
      });
      return {
        ...(result.data || {}),
        usage: result.usage || result.data?.usage || null,
      };
    } catch (error) {
      const transient = isRetryableAgentError(error)
        && TRANSIENT_AGENT_PROVIDER_STATUSES.has(Number(error?.status));
      if (!transient || attempt >= maxAttempts) throw error;
      const configuredDelay = Number(process.env.AGENT_PROVIDER_RETRY_DELAY_MS || 750);
      const retryAfterMs = agentRetryDelayMs(error?.retryAfterMs);
      const delayMs = retryAfterMs !== null
        ? retryAfterMs
        : Math.min(5_000, Math.max(100, configuredDelay) * attempt);
      logger.warn("canvasAgent.provider.retry", {
        attempt,
        status: Number(error?.status) || null,
        code: String(error?.code || "AGENT_PROVIDER_UNAVAILABLE").slice(0, 120),
        delayMs,
      });
      await wait(delayMs);
    }
  }
  throw Object.assign(new Error("Canvas agent provider is unavailable"), {
    status: 503,
    code: "AGENT_PROVIDER_UNAVAILABLE",
  });
};

const requestPlanFromProvider = async (messages, config) => {
  const baseBody = withCreativeLlmOptions(config, {
    messages,
    temperature: 0.2,
    max_tokens: 1600,
  });

  if (shouldSkipJsonResponseFormat(config)) {
    return providerRequest(baseBody, config);
  }

  try {
    return await providerRequest({
      ...baseBody,
      response_format: { type: "json_object" },
    }, config);
  } catch (err) {
    if (err.status !== 400) throw err;
    logger.warn("canvasAgent.responseFormatRetry", { message: err.message });
    return providerRequest(baseBody, config);
  }
};

const normalizeIdList = (ids, elementIdSet) => {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => shortText(id, 80)).filter((id) => elementIdSet.has(id)))].slice(0, 80);
};

const hasNoTemplateIntent = (instruction) => (
  /不用模板|不使用模板|不要模板|无模板|不套用|不走模板|自由生成|自由修改|freeform|no template|without template/i
    .test(String(instruction || ""))
);

const hasTemplateIntent = (instruction) => (
  /模板|模版|template|套用|同款|preset/i.test(String(instruction || ""))
);

const hasImageEditIntent = (instruction) => (
  /改为|改成|修改|编辑|替换|换成|换掉|换背景|去掉|移除|抹掉|擦除|修复|重绘|扩图|改字|字改|文字|文案|字体|replace|edit|change|remove|erase|fix|inpaint|outpaint/i
    .test(String(instruction || ""))
);

const hasReferenceIntent = (instruction) => (
  /参考|基于|根据|当前|选中|这张|这幅|这个|素材|图片|原图|reference|based on|current|selected|this image|from this|use this/i
    .test(String(instruction || ""))
);

const hasVideoIntent = (instruction) => (
  /视频|短视频|动画|镜头|video|clip|motion/i.test(String(instruction || ""))
);

const hasImageIntent = (instruction) => (
  /图片|图像|主图|海报|视觉|画面|image|picture|poster|visual/i.test(String(instruction || ""))
);

const hasGenerationIntent = (instruction) => (
  /生成|生图|出图|绘制|画|做|制作|来一张|create|generate|draw|make|produce/i
    .test(String(instruction || ""))
);

const hasNoteIntent = (instruction) => (
  /便签|备注|笔记|策略卡|说明卡|note|sticky|memo/i.test(String(instruction || ""))
);

const getFreeformSceneKey = (templates = [], outputType = "image") => {
  const expectedKey = outputType === "video" ? "freeform_video" : "freeform_image";
  const direct = templates.find((template) => template.scene_key === expectedKey);
  if (direct) return direct.scene_key;

  const tagged = templates.find((template) => (
    Array.isArray(template.tags)
    && template.tags.some((tag) => String(tag).toLowerCase() === "freeform")
  ));
  if (tagged) return tagged.scene_key;

  const named = templates.find((template) => /自由|freeform/i.test(`${template.scene_key} ${template.scene_name}`));
  return named?.scene_key || "";
};

const hasReferenceContext = (context) => {
  const selectedIds = new Set(context?.selectedIds || []);
  const selectedImage = (context?.canvas?.state?.elements || [])
    .some((element) => selectedIds.has(element.id) && element.type === "image");
  if (selectedImage) return true;

  return (context?.mentions || []).some((mention) => (
    (mention.type === "asset" || mention.type === "element")
    && mention.assetType === "image"
    && (mention.url || mention.elementId)
  ));
};

const shouldUseReferenceForAction = (action, context) => {
  if (!hasReferenceContext(context)) return false;
  if (Boolean(action?.useSelection)) return true;
  return hasImageEditIntent(context?.instruction) || hasReferenceIntent(context?.instruction);
};

const chooseSceneKeyForPromptAction = ({
  rawSceneKey,
  action,
  context,
  outputType,
  templateList,
  allowedSceneKeys,
}) => {
  const freeformSceneKey = getFreeformSceneKey(templateList, outputType);
  const useReference = shouldUseReferenceForAction(action, context);

  if (hasNoTemplateIntent(context?.instruction)) {
    return { sceneKey: freeformSceneKey || "", useReference };
  }

  const rawTemplate = rawSceneKey && allowedSceneKeys?.has(rawSceneKey)
    ? templateList.find((template) => template.scene_key === rawSceneKey)
    : null;

  if (rawTemplate && (!rawTemplate.requires_reference || useReference)) {
    return { sceneKey: rawTemplate.scene_key, useReference };
  }

  const locallyChosenSceneKey = chooseTemplateSceneKey(
    templateList,
    useReference,
    context?.instruction || "",
    outputType,
  );

  return {
    sceneKey: locallyChosenSceneKey || freeformSceneKey || "",
    useReference,
  };
};

const normalizeAgentAction = (action, context) => {
  const type = shortText(action?.type, 40);
  const { elementIdSet, instruction } = context;
  const allowDelete = /删除|移除|清空|delete|remove|clear/i.test(instruction || "");

  if (type === "add_storyboard_shot") {
    const title = shortText(action.title, 120) || "Agent Shot";
    const prompt = shortText(action.prompt, MAX_PROMPT_LENGTH);
    return {
      type,
      id: shortText(action.id, 80),
      title,
      prompt,
      description: shortText(action.description, 1000),
      duration: clamp(action.duration, 0.1, 3600, 3),
      camera: shortText(action.camera, 80),
      style: shortText(action.style, 120),
      assetId: shortText(action.assetId || action.elementId, 80),
    };
  }

  if (type === "update_storyboard_shot") {
    const id = shortText(action.id, 80);
    if (!id || !context.storyboardShotIdSet?.has(id)) return null;
    return {
      type,
      id,
      ...(action.title != null ? { title: shortText(action.title, 120) } : {}),
      ...(action.prompt != null ? { prompt: shortText(action.prompt, MAX_PROMPT_LENGTH) } : {}),
      ...(action.description != null ? { description: shortText(action.description, 1000) } : {}),
      ...(action.duration != null ? { duration: clamp(action.duration, 0.1, 3600, 3) } : {}),
      ...(action.camera != null ? { camera: shortText(action.camera, 80) } : {}),
      ...(action.style != null ? { style: shortText(action.style, 120) } : {}),
      ...(action.assetId != null ? { assetId: shortText(action.assetId, 80) } : {}),
    };
  }

  if (type === "delete_storyboard_shots") {
    const ids = normalizeIdList(action.ids, context.storyboardShotIdSet || new Set());
    return allowDelete && ids.length > 0 ? { type, ids } : null;
  }

  if (type === "add_timeline_clip") {
    const assetId = shortText(action.assetId || action.elementId, 80);
    if (!assetId || !elementIdSet.has(assetId)) return null;
    return {
      type,
      id: shortText(action.id, 80),
      trackId: shortText(action.trackId, 80),
      assetId,
      start: clamp(action.start, 0, 86400, 0),
      duration: clamp(action.duration, 0.1, 86400, 3),
      sourceStart: clamp(action.sourceStart, 0, 86400, 0),
      sourceDuration: clamp(action.sourceDuration, 0, 86400, 0),
    };
  }

  if (type === "update_timeline_clip") {
    const id = shortText(action.id, 80);
    if (!id || !context.timelineClipIdSet?.has(id)) return null;
    return {
      type,
      id,
      ...(action.trackId != null ? { trackId: shortText(action.trackId, 80) } : {}),
      ...(action.assetId != null && elementIdSet.has(shortText(action.assetId, 80)) ? { assetId: shortText(action.assetId, 80) } : {}),
      ...(action.start != null ? { start: clamp(action.start, 0, 86400, 0) } : {}),
      ...(action.duration != null ? { duration: clamp(action.duration, 0.1, 86400, 3) } : {}),
      ...(action.sourceStart != null ? { sourceStart: clamp(action.sourceStart, 0, 86400, 0) } : {}),
      ...(action.sourceDuration != null ? { sourceDuration: clamp(action.sourceDuration, 0, 86400, 0) } : {}),
    };
  }

  if (type === "delete_timeline_clips") {
    const ids = normalizeIdList(action.ids, context.timelineClipIdSet || new Set());
    return allowDelete && ids.length > 0 ? { type, ids } : null;
  }

  if (type === "set_director3d") {
    const camera = action.camera && typeof action.camera === "object" ? action.camera : {};
    return {
      type,
      enabled: Boolean(action.enabled),
      scene: shortText(action.scene, 120),
      lighting: shortText(action.lighting, 120),
      environment: shortText(action.environment, 120),
      camera: {
        position: {
          x: clamp(camera.position?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
          y: clamp(camera.position?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
          z: clamp(camera.position?.z, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
        },
        rotation: {
          x: clamp(camera.rotation?.x, -360, 360, 0),
          y: clamp(camera.rotation?.y, -360, 360, 0),
          z: clamp(camera.rotation?.z, -360, 360, 0),
        },
        focalLength: clamp(camera.focalLength, 1, 500, 50),
      },
    };
  }

  if (type === "set_title") {
    const title = shortText(action.title, 120);
    return title ? { type, title } : null;
  }

  if (type === "add_note") {
    const text = shortText(action.text, MAX_NOTE_TEXT_LENGTH);
    if (!text) return null;
    return {
      type,
      title: shortText(action.title, 80) || "Agent Note",
      text,
      x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      width: clamp(action.width, 180, MAX_AGENT_ELEMENT_SIZE, 360),
      height: clamp(action.height, 120, MAX_AGENT_ELEMENT_SIZE, 220),
      background: normalizeHexColor(action.background, "#eef2ff"),
      color: normalizeHexColor(action.color, "#312e81"),
      fontSize: clamp(action.fontSize, 14, 48, 17),
    };
  }

  if (type === "add_asset") {
    const mentionKey = shortText(action.mentionKey || action.key, 140);
    const mention = context.mentionMap?.get(mentionKey);
    if (!mention || mention.type !== "asset" || !mention.url) return null;
    return {
      type,
      mentionKey,
      title: shortText(action.title || mention.title || mention.label, 120),
      width: clamp(action.width, 160, MAX_AGENT_ELEMENT_SIZE, mention.assetType === "video" ? 360 : 320),
      height: clamp(action.height, 120, MAX_AGENT_ELEMENT_SIZE, mention.assetType === "video" ? 202 : 320),
      ...(Number.isFinite(Number(action.x)) ? { x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0) } : {}),
      ...(Number.isFinite(Number(action.y)) ? { y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0) } : {}),
    };
  }

  if (type === "update_text") {
    const id = shortText(action.id, 80);
    if (!elementIdSet.has(id)) return null;
    return {
      type,
      id,
      title: shortText(action.title, 80),
      text: shortText(action.text, MAX_NOTE_TEXT_LENGTH),
      background: action.background ? normalizeHexColor(action.background, "#eef2ff") : "",
      color: action.color ? normalizeHexColor(action.color, "#312e81") : "",
      fontSize: action.fontSize ? clamp(action.fontSize, 14, 48, 17) : undefined,
    };
  }

  if (type === "move_elements") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    if (ids.length === 0) return null;
    return {
      type,
      ids,
      dx: clamp(action.dx, -MAX_AGENT_DELTA, MAX_AGENT_DELTA, 0),
      dy: clamp(action.dy, -MAX_AGENT_DELTA, MAX_AGENT_DELTA, 0),
    };
  }

  if (type === "arrange_grid") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    if (ids.length === 0) return null;
    return {
      type,
      ids,
      columns: clamp(action.columns, 1, 8, 3),
      gap: clamp(action.gap, 0, 320, 32),
      startX: clamp(action.startX, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      startY: clamp(action.startY, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      itemWidth: action.itemWidth ? clamp(action.itemWidth, 160, MAX_AGENT_ELEMENT_SIZE, 320) : undefined,
      itemHeight: action.itemHeight ? clamp(action.itemHeight, 120, MAX_AGENT_ELEMENT_SIZE, 240) : undefined,
    };
  }

  if (type === "resize_elements") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    if (ids.length === 0) return null;
    return {
      type,
      ids,
      width: clamp(action.width, 160, MAX_AGENT_ELEMENT_SIZE, 320),
      height: clamp(action.height, 120, MAX_AGENT_ELEMENT_SIZE, 240),
    };
  }

  if (type === "set_selection") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    return { type, ids };
  }

  if (type === "set_viewport") {
    return {
      type,
      x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
      scale: clamp(action.scale, 0.05, 10, 1),
    };
  }

  if (type === "set_image_prompt" || type === "set_video_prompt") {
    const prompt = shortText(action.prompt, MAX_PROMPT_LENGTH);
    const rawSceneKey = shortText(action.sceneKey, 80);
    const outputType = type === "set_video_prompt" ? "video" : "image";
    const templateList = type === "set_video_prompt"
      ? context.templates?.availableVideos || []
      : context.templates?.availableImages || [];
    const allowedSceneKeys = type === "set_video_prompt"
      ? context.videoSceneKeys
      : context.imageSceneKeys;
    const { sceneKey, useReference } = chooseSceneKeyForPromptAction({
      rawSceneKey,
      action,
      context,
      outputType,
      templateList,
      allowedSceneKeys,
    });
    return prompt ? {
      type,
      prompt,
      useSelection: useReference,
      sceneKey,
      visualParameters: action.visualParameters && typeof action.visualParameters === "object" && !Array.isArray(action.visualParameters)
        ? action.visualParameters
        : context.visualParameters,
    } : null;
  }

  if (type === "lock_elements" || type === "unlock_elements") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    return ids.length > 0 ? { type, ids } : null;
  }

  if (type === "delete_elements") {
    const ids = normalizeIdList(action.ids, elementIdSet);
    return allowDelete && ids.length > 0 ? { type, ids } : null;
  }

  return null;
};

const normalizePlan = (plan, context) => {
  const elementIdSet = new Set(context.canvas.state.elements.map((element) => element.id));
  const mentionMap = new Map((context.mentions || []).map((mention) => [mention.key, mention]));
  const storyboardShotIdSet = new Set((context.canvas.state.storyboard?.shots || []).map((shot) => String(shot?.id || "").trim()).filter(Boolean));
  const timelineClipIdSet = new Set((context.canvas.state.timeline?.tracks || [])
    .flatMap((track) => Array.isArray(track?.clips) ? track.clips : [])
    .map((clip) => String(clip?.id || "").trim()).filter(Boolean));
  const imageSceneKeys = new Set((context.templates?.availableImages || []).map((template) => template.scene_key));
  const videoSceneKeys = new Set((context.templates?.availableVideos || []).map((template) => template.scene_key));
  const normalizedContext = {
    ...context,
    elementIdSet,
    mentionMap,
    storyboardShotIdSet,
    timelineClipIdSet,
    imageSceneKeys,
    videoSceneKeys,
  };
  const normalizedActions = Array.isArray(plan?.actions)
    ? plan.actions
        .slice(0, MAX_AGENT_ACTIONS)
        .map((action) => normalizeAgentAction(action, normalizedContext))
        .filter(Boolean)
    : [];
  const actions = ensureRequiredGenerationActions(normalizedActions, normalizedContext);

  return {
    summary: shortText(plan?.summary, 500) || fallbackSummary(context.language),
    actions,
    model: shortText(plan?.model || context.model, 80),
    model_key: shortText(context.modelKey, 100),
    model_route_id: context.modelRouteId || null,
    provider: shortText(plan?.provider || "llm", 40),
  };
};

const fallbackSummary = (language) =>
  language === "zh"
    ? "已生成一个基础画布执行计划。"
    : "Generated a basic canvas execution plan.";

const TEMPLATE_KEYWORD_GROUPS = [
  ["商品", "电商", "主图", "product", "ecommerce", "commercial", "ad", "广告", "投放", "推广"],
  ["贺卡", "卡片", "card", "greeting"],
  ["宠物", "动物", "猫", "狗", "pet", "animal", "sticker", "贴纸"],
  ["手办", "模型", "figure", "pvc", "toy", "亚克力"],
  ["首饰", "项链", "珠宝", "necklace", "jewelry", "ring", "bracelet"],
  ["衣服", "上衣", "穿搭", "通勤", "服装", "clothing", "shirt", "outfit", "office"],
  ["视频", "短视频", "动画", "镜头", "video", "clip", "motion"],
  ["海报", "poster", "banner", "banner"],
];

const scoreTemplateForInstruction = (template, instruction, useReference) => {
  const input = String(instruction || "").toLowerCase();
  const haystack = [
    template.scene_key,
    template.scene_name,
    template.preview_description,
    template.starter_prompt,
    ...(Array.isArray(template.tags) ? template.tags : []),
  ].join(" ").toLowerCase();

  let score = 0;
  if (template.is_featured) score += 3;
  if (useReference && template.requires_reference) score += 4;
  if (!useReference && template.requires_reference) score -= 80;
  if (isFreeformTemplate(template)) score -= 8;

  TEMPLATE_KEYWORD_GROUPS.forEach((group) => {
    const inputHit = group.some((word) => input.includes(word.toLowerCase()));
    const templateHit = group.some((word) => haystack.includes(word.toLowerCase()));
    if (inputHit && templateHit) score += 18;
  });

  if (Array.isArray(template.tags)) {
    template.tags.forEach((tag) => {
      const normalized = String(tag || "").trim().toLowerCase();
      if (normalized && normalized.length >= 2 && input.includes(normalized)) score += 10;
    });
  }

  return score;
};

const chooseTemplateSceneKey = (templates = [], useReference = false, instruction = "", outputType = "image") => {
  if (!Array.isArray(templates) || templates.length === 0) return "";
  const freeformSceneKey = getFreeformSceneKey(templates, outputType);
  const candidates = templates.filter((template) => useReference || !template.requires_reference);
  const usableTemplates = candidates.length > 0 ? candidates : templates;
  const ranked = usableTemplates
    .map((template) => ({
      template,
      score: scoreTemplateForInstruction(template, instruction, useReference),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (freeformSceneKey && (!best || best.score < 10)) return freeformSceneKey;
  return best?.template?.scene_key || freeformSceneKey || "";
};

const getGenerationIntent = (context) => {
  const { instruction, selectedIds } = context;
  const useReference = hasReferenceContext(context)
    && (selectedIds.length > 0 || hasImageEditIntent(instruction) || hasReferenceIntent(instruction));
  const noTemplate = hasNoTemplateIntent(instruction);
  const imageEdit = hasImageEditIntent(instruction);
  const wantsVideo = hasVideoIntent(instruction);
  const wantsImage = imageEdit || hasImageIntent(instruction) || (hasGenerationIntent(instruction) && !wantsVideo && !hasNoteIntent(instruction));

  return {
    useReference,
    noTemplate,
    imageEdit,
    wantsVideo,
    wantsImage,
  };
};

const buildGenerationPrompt = (context, outputType = "image") => {
  const { instruction, language } = context;
  const imageEdit = hasImageEditIntent(instruction);

  if (outputType === "video") {
    return language === "zh"
      ? `${instruction}\n\n请生成一个镜头稳定、主体清晰、适合投放的短视频。`
      : `${instruction}\n\nGenerate a stable, clear, ad-ready short video.`;
  }

  return language === "zh"
    ? imageEdit
      ? `${instruction}\n\n严格按上面的编辑要求修改参考图，保持其他主体、构图、风格和画质不变。`
      : `${instruction}\n\n请生成一张商业级、高质量、主体清晰、构图干净的图片。`
    : imageEdit
      ? `${instruction}\n\nEdit the reference image exactly as requested while preserving other subjects, composition, style, and image quality.`
      : `${instruction}\n\nGenerate a high-quality commercial image with a clear subject and clean composition.`;
};

const buildRequiredGenerationActions = (context) => {
  const { instruction } = context;
  const {
    useReference,
    noTemplate,
    imageEdit,
    wantsVideo,
    wantsImage,
  } = getGenerationIntent(context);

  const imageSceneKey = (noTemplate || imageEdit)
    ? getFreeformSceneKey(context.templates?.availableImages, "image") || chooseTemplateSceneKey(context.templates?.availableImages, useReference, instruction, "image")
    : chooseTemplateSceneKey(context.templates?.availableImages, useReference, instruction, "image");
  const videoSceneKey = noTemplate
    ? getFreeformSceneKey(context.templates?.availableVideos, "video") || chooseTemplateSceneKey(context.templates?.availableVideos, useReference, instruction, "video")
    : chooseTemplateSceneKey(context.templates?.availableVideos, useReference, instruction, "video");
  const actions = [];

  if (wantsImage) {
    actions.push({
      type: "set_image_prompt",
      prompt: buildGenerationPrompt(context, "image"),
      useSelection: useReference,
      sceneKey: imageSceneKey,
    });
  }
  if (wantsVideo) {
    actions.push({
      type: "set_video_prompt",
      prompt: buildGenerationPrompt(context, "video"),
      useSelection: useReference,
      sceneKey: videoSceneKey,
    });
  }

  return actions;
};

const ensureRequiredGenerationActions = (actions, context) => {
  const requiredActions = buildRequiredGenerationActions(context);
  if (requiredActions.length === 0) return actions;

  const hasImageAction = actions.some((action) => action?.type === "set_image_prompt" && action.prompt);
  const hasVideoAction = actions.some((action) => action?.type === "set_video_prompt" && action.prompt);
  const additions = requiredActions.filter((action) => (
    action.type === "set_image_prompt" ? !hasImageAction : !hasVideoAction
  ));

  return [...actions, ...additions].slice(0, MAX_AGENT_ACTIONS);
};

const applyVisualParametersToActions = async (actions, context) => Promise.all(actions.map(async (action) => {
  if (!action || !["set_image_prompt", "set_video_prompt"].includes(action.type)) return action;
  const outputType = action.type === "set_video_prompt" ? "video" : "image";
  const compiled = await compileConfiguredVisualPrompt({
    basePrompt: action.prompt,
    selection: action.visualParameters || context.visualParameters || {},
    outputType,
    modelKey: null,
  });
  return {
    ...action,
    prompt: shortText(
      compiled.negativePrompt ? `${compiled.prompt}\n\nAvoid: ${compiled.negativePrompt}` : compiled.prompt,
      MAX_PROMPT_LENGTH,
    ),
    negativePrompt: shortText(compiled.negativePrompt, 600),
    visualParameters: compiled.selections,
  };
}));

export const generateCanvasAgentPlan = async ({
  userId,
  instruction,
  canvas,
  selectedIds = [],
  templates = {},
  mentions = [],
  visualParameters = {},
  language = "zh",
  modelRoute = null,
}) => {
  const config = await getAgentConfig(userId, modelRoute);
  const safeInstruction = shortText(instruction, 2000);
  const safeCanvas = compactCanvas(canvas);
  const safeSelectedIds = normalizeIdList(selectedIds, new Set(safeCanvas.elements.map((element) => element.id)));
  const safeMentions = normalizeMentions(mentions);
  const safeTemplates = normalizeTemplatesPayload(templates);
  const configuredSkillContext = await getAgentSkillRegistry().contextForInstruction(safeInstruction);
  const context = {
    instruction: safeInstruction,
    canvas: { ...canvas, state: { ...canvas.state, elements: safeCanvas.elements } },
    selectedIds: safeSelectedIds,
    mentions: safeMentions,
    templates: safeTemplates,
    language,
    model: config.model,
    modelKey: config.modelKey,
    modelRouteId: config.routeId,
    visualParameters,
  };

  if (!config.key) {
    logger.error("canvasAgent.noKey");
    throw Object.assign(new Error("Canvas agent provider is not configured"), {
      status: 503,
      code: "AGENT_PROVIDER_NOT_CONFIGURED",
    });
  }

  const systemPrompt = [
    "You are StarDraw Canvas Agent, a precise controller for an infinite canvas.",
    "Return only a valid JSON object. Do not include markdown.",
    "The frontend will execute only these whitelisted actions:",
    "set_title, add_note, add_asset, update_text, move_elements, arrange_grid, resize_elements, set_selection, set_viewport, set_image_prompt, set_video_prompt, lock_elements, unlock_elements, delete_elements, add_storyboard_shot, update_storyboard_shot, delete_storyboard_shots, add_timeline_clip, update_timeline_clip, delete_timeline_clips, set_director3d.",
    "Use existing element ids exactly as provided. Never invent media URLs.",
    "The user may mention assets/templates/elements with @. These are provided in mentions[].",
    "For mentioned canvas elements, use mention.elementId as an action id.",
    "For mentioned image/video templates, use mention.sceneKey in set_image_prompt or set_video_prompt.",
    "To place a mentioned history asset onto the canvas, return add_asset with mentionKey exactly matching that asset mention. Never use add_asset for unmentioned assets.",
    "Do not delete elements unless the user explicitly asks to delete/remove/clear.",
    "For image or video creation, write prompts with set_image_prompt or set_video_prompt instead of inventing output assets.",
    "If no business template fits, choose freeform_image/freeform_video when available instead of forcing an unrelated template. If the user asks for no template/freeform, always choose those freeform sceneKeys instead of business templates.",
    "When you do choose a generation template, sceneKey must be one of templates.availableImages[].scene_key for set_image_prompt or templates.availableVideos[].scene_key for set_video_prompt.",
    "If the user did not select reference images, prefer templates whose requires_reference is false. If references are selected or mentioned, you may choose reference templates and set useSelection true.",
    "Use the template descriptions, tags, and starter prompts to pick the best fit automatically. Do not ask the user to pick a template unless there is no usable option.",
    "Prefer practical actions that directly change the canvas layout, storyboard, timeline, director3d state or generation prompts.",
    "Include storyboard and timeline actions when the user asks for shots, sequencing, timing, camera direction, or editing. Use existing ids for update/delete; add actions may omit id and the client will create one. For timeline clips use a video canvas element id as assetId.",
    configuredSkillContext ? `Root-configured skills are instructions only; follow them when relevant:\n${configuredSkillContext}` : "",
    "JSON schema: {\"summary\":\"short user-facing summary\",\"actions\":[{\"type\":\"add_storyboard_shot\",\"title\":\"...\",\"prompt\":\"...\",\"duration\":3,\"camera\":\"dolly\"},{\"type\":\"add_timeline_clip\",\"assetId\":\"video_element_id\",\"start\":0,\"duration\":3},{\"type\":\"set_director3d\",\"enabled\":true,\"scene\":\"...\"},{\"type\":\"set_image_prompt\",\"prompt\":\"...\",\"useSelection\":true,\"sceneKey\":\"...\"}]}",
  ].join("\n");

  const userPayload = {
    instruction: safeInstruction,
    language,
    selectedIds: safeSelectedIds,
    canvas: safeCanvas,
    templates: safeTemplates,
    mentions: safeMentions,
    visualParameters: context.visualParameters,
  };

  try {
    const data = await requestPlanFromProvider([
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ], config);
    const content = stringifyMessageContent(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.output_text);
    const rawPlan = extractJsonObject(content);
    const normalized = normalizePlan({
      ...rawPlan,
      model: config.model,
      provider: "llm",
    }, context);

    normalized.actions = await applyVisualParametersToActions(normalized.actions, context);

    if (normalized.actions.length === 0) {
      throw Object.assign(new Error("Canvas agent provider returned an empty plan"), {
        status: 502,
        code: "AGENT_PROVIDER_EMPTY_PLAN",
      });
    }

    return { ...normalized, usage: data?.usage || null };
  } catch (err) {
    logger.error("canvasAgent.provider.error", {
      message: err.message,
      status: err.status,
      details: err.details,
    });
    if (!err.status) err.status = 502;
    if (!err.code) err.code = "AGENT_PROVIDER_FAILED";
    throw err;
  }
};

const normalizeGlobalToolCatalog = (tools = []) => (Array.isArray(tools) ? tools : [])
  .slice(0, 160)
  .map((tool) => ({
    toolKey: shortText(tool?.toolKey, 128).toLowerCase(),
    name: shortText(tool?.name, 160),
    description: shortText(tool?.description, 600),
    operationClass: shortText(tool?.operationClass, 40),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : null,
  }))
  .filter((tool) => GLOBAL_TOOL_KEY_PATTERN.test(tool.toolKey));

const canvasBoundGlobalTools = new Set([
  "canvas.read", "canvas.edit", "canvas.patch", "canvas.asset.attach_creation", "canvas.asset.upload", "canvas.export.image",
  "workflow.read", "workflow.save", "workflow.patch", "workflow.run", "workflow.estimate",
  "storyboard.edit", "storyboard.patch", "timeline.edit", "timeline.render", "director3d.edit",
]);

const routeLikeResourceId = (value) => {
  const candidate = String(value || "").trim();
  return candidate.startsWith("/") || /^https?:\/\//i.test(candidate) || candidate.includes("/ai/canvas");
};

const observedCanvasVersion = (context, canvasId) => {
  const observations = Array.isArray(context?.observations) ? [...context.observations].reverse() : [];
  for (const observation of observations) {
    if (!["canvas.read", "workflow.read"].includes(String(observation?.toolKey || ""))) continue;
    const result = observation?.result;
    const resultCanvasId = String(result?.canvasId || result?.id || "");
    if (canvasId && resultCanvasId && resultCanvasId !== String(canvasId)) continue;
    const updatedAt = result?.updatedAt || result?.timestamps?.updatedAt;
    if (updatedAt) return String(updatedAt);
  }
  return "";
};

const isWorkflowBuildInstruction = (instruction) => {
  const value = String(instruction || "").toLowerCase();
  const build = /(搭建|创建|新建|设计|编排|制作|做一个|build|create|design).{0,16}(工作流|workflow)|(工作流|workflow).{0,16}(搭建|创建|新建|设计|编排|制作)/i.test(value);
  const execute = /(运行|执行|启动|立即开始|run|execute|start).{0,12}(工作流|workflow)|(工作流|workflow).{0,12}(运行|执行|启动|run|execute|start)/i.test(value);
  return build && !execute;
};

const applyGlobalAgentMediaPreferences = (toolKey, parameters, preferences = {}) => {
  const next = { ...parameters };
  const outputType = ["media.generate.image", "media.remove-background", "media.remove-object"].includes(toolKey)
    || (toolKey === "media.estimate" && next.outputType === "image")
    ? "image"
    : toolKey === "media.generate.video" || (toolKey === "media.estimate" && next.outputType === "video")
      ? "video"
      : "";
  if (outputType === "image") {
    if (preferences.imageModel) next.model = preferences.imageModel;
    if (preferences.imageSize) next.size = preferences.imageSize;
  }
  if (outputType === "video") {
    if (preferences.videoModel) next.model = preferences.videoModel;
    if (preferences.videoSize) next.size = preferences.videoSize;
    if (preferences.videoSeconds != null) next.seconds = preferences.videoSeconds;
  }
  return next;
};

const normalizeGlobalMediaGenerationParameters = (toolKey, parameters, context = {}) => {
  if (!MEDIA_GENERATION_TOOLS.has(toolKey)) return parameters;
  const next = { ...parameters };
  const outputType = toolKey === "media.generate.video" ? "video" : "image";
  const freeformSceneKey = outputType === "video" ? "freeform_video" : "freeform_image";
  const requestedTemplate = context?.requestedTemplate;
  const selectedTemplateMatches = requestedTemplate
    && requestedTemplate.output_type === outputType;
  const explicitTemplate = Boolean(selectedTemplateMatches) || hasTemplateIntent(context?.instruction);
  const forceFreeform = hasNoTemplateIntent(context?.instruction) || !explicitTemplate;
  const promptCandidate = next.userModification
    || next.user_modification
    || next.userPrompt
    || next.user_prompt
    || next.prompt
    || context?.instruction;

  if (forceFreeform) {
    next.sceneKey = freeformSceneKey;
    delete next.templateId;
    delete next.template_id;
    delete next.templateVersion;
    delete next.template_version;
    next.userModification = String(context?.instruction || promptCandidate || "").trim().slice(0, MAX_PROMPT_LENGTH);
  } else if (selectedTemplateMatches) {
    next.templateId = String(requestedTemplate.id);
    next.templateVersion = Number(requestedTemplate.version || 1);
    next.sceneKey = requestedTemplate.scene_key;
    next.userModification = String(promptCandidate || "").trim().slice(0, MAX_PROMPT_LENGTH);
  } else {
    next.userModification = String(promptCandidate || "").trim().slice(0, MAX_PROMPT_LENGTH);
  }

  delete next.user_modification;
  delete next.userPrompt;
  delete next.user_prompt;
  delete next.prompt;
  return next;
};

const normalizeGlobalCall = (call, allowedTools, index, context = {}) => {
  let toolKey = shortText(call?.toolKey || call?.tool_key, 128).toLowerCase();
  if (!GLOBAL_TOOL_KEY_PATTERN.test(toolKey) || !allowedTools.has(toolKey)) return null;
  const parameters = call?.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return null;
  let normalizedParameters = applyGlobalAgentMediaPreferences(
    toolKey,
    parameters,
    context.agentPreferences,
  );
  normalizedParameters = normalizeGlobalMediaGenerationParameters(toolKey, normalizedParameters, context);
  const trustedCanvasId = String(context?.currentCanvas?.id || "").trim();
  const requestedCanvasId = String(normalizedParameters.canvasId || normalizedParameters.canvas_id || "").trim();

  if (canvasBoundGlobalTools.has(toolKey)) {
    if ((!requestedCanvasId || routeLikeResourceId(requestedCanvasId)) && trustedCanvasId) {
      normalizedParameters.canvasId = trustedCanvasId;
      delete normalizedParameters.canvas_id;
    } else if (routeLikeResourceId(requestedCanvasId) && allowedTools.has("canvas.list")) {
      toolKey = "canvas.list";
      normalizedParameters = {};
    }
  }

  const effectiveCanvasId = String(normalizedParameters.canvasId || normalizedParameters.canvas_id || trustedCanvasId || "").trim();
  if (["workflow.save", "workflow.patch"].includes(toolKey)
      && !normalizedParameters.expectedUpdatedAt
      && !normalizedParameters.expected_updated_at) {
    const updatedAt = observedCanvasVersion(context, effectiveCanvasId);
    if (updatedAt) normalizedParameters.expectedUpdatedAt = updatedAt;
  }

  if (toolKey === "workflow.run" && isWorkflowBuildInstruction(context?.instruction)) {
    const definition = normalizedParameters.definition || normalizedParameters.workflow || null;
    const updatedAt = observedCanvasVersion(context, effectiveCanvasId);
    const hasCatalogObservation = (context?.observations || []).some((observation) => observation?.toolKey === "workflow.catalog");
    const hasSavedObservation = (context?.observations || []).some((observation) => (
      ["workflow.save", "workflow.patch"].includes(observation?.toolKey)
      && observation?.status === "completed"
    ));
    if (hasSavedObservation) return null;
    if (definition && effectiveCanvasId && updatedAt && allowedTools.has("workflow.save")) {
      toolKey = "workflow.save";
      normalizedParameters = { canvasId: effectiveCanvasId, expectedUpdatedAt: updatedAt, definition };
    } else if (!hasCatalogObservation && allowedTools.has("workflow.catalog")) {
      toolKey = "workflow.catalog";
      normalizedParameters = {};
    } else if (effectiveCanvasId && allowedTools.has("workflow.read")) {
      toolKey = "workflow.read";
      normalizedParameters = { canvasId: effectiveCanvasId };
    } else if (allowedTools.has("canvas.list")) {
      toolKey = "canvas.list";
      normalizedParameters = {};
    }
  }

  const serialized = JSON.stringify(normalizedParameters);
  if (serialized.length > 32_000) return null;
  const requestedId = shortText(call?.id || call?.stepId || call?.step_id || call?.name, 80);
  const id = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(requestedId) ? requestedId : `step_${index + 1}`;
  return {
    id,
    name: shortText(call?.name || call?.label, 160) || id,
    toolKey,
    parameters: JSON.parse(serialized),
    reason: shortText(call?.reason, 500),
  };
};

const normalizeGlobalPlan = (plan, context) => {
  const allowedTools = new Set(context.tools.map((tool) => tool.toolKey));
  const reactive = Boolean(context.reactive);
  const response = shortText(
    plan?.response || plan?.reply || plan?.final_response || plan?.finalResponse,
    2_400,
  );
  const hasObservations = Array.isArray(context.observations) && context.observations.length > 0;
  const allowEmpty = (reactive && hasObservations) || Boolean(response);
  const calls = Array.isArray(plan?.calls)
    ? plan.calls.slice(0, reactive ? 1 : MAX_GLOBAL_AGENT_CALLS)
      .map((call, index) => normalizeGlobalCall(call, allowedTools, index, context))
      .filter(Boolean)
    : [];
  if (calls.length === 0 && !allowEmpty) {
    throw Object.assign(new Error("Agent returned no executable tool calls"), {
      status: 502,
      code: "AGENT_PROVIDER_EMPTY_PLAN",
    });
  }
  return {
    summary: shortText(plan?.summary, 800) || (context.language === "en" ? "Plan ready." : "执行计划已准备。"),
    response,
    final_response: calls.length === 0 ? response : "",
    calls,
    execution_mode: "reactive",
    executionMode: "reactive",
    react_context: context.reactContext || { reactive: true, observations: context.observations || [] },
    model: context.model,
    model_key: context.modelKey,
    model_route_id: context.modelRouteId,
    provider: "llm",
  };
};

export const generateGlobalAgentPlan = async ({
  userId,
  instruction,
  tools = [],
  context = {},
  language = "zh",
  modelRoute = null,
}) => {
  const safeInstruction = shortText(instruction, 2400);
  if (!safeInstruction) throw Object.assign(new Error("instruction is required"), { status: 400, code: "AGENT_INSTRUCTION_REQUIRED" });
  if (isSimpleConversation(safeInstruction)) {
    const response = language === "en"
      ? "Hi, I'm StarDraw's creative Agent. I can help you generate images and videos, use templates, organize canvases, and run creative workflows. Tell me what you want to make."
      : "你好，我是 StarDraw 的创作 Agent。我可以帮你生成图片和视频、使用模板、整理画布，并执行创作工作流。告诉我你想做什么就可以了。";
    return {
      summary: language === "en" ? "Ready to help." : "随时可以开始。",
      response,
      final_response: response,
      billing: "none",
      calls: [],
      execution_mode: "reactive",
      executionMode: "reactive",
      react_context: { reactive: true, observations: [] },
      provider: "direct",
    };
  }
  const config = await getAgentConfig(userId, modelRoute, context?.agentPreferences?.reasoningEffort);
  if (!config.key) {
    throw Object.assign(new Error("Agent provider is not configured"), {
      status: 503,
      code: "AGENT_PROVIDER_NOT_CONFIGURED",
    });
  }
  const safeTools = normalizeGlobalToolCatalog(tools);
  // Global plans run as a durable ReAct loop: the provider proposes only the
  // next tool and receives persisted observations before the next proposal.
  const safeContext = serializeGlobalAgentContext({ ...context, reactive: true });
  const providerContext = JSON.parse(safeContext);
  const hasObservations = Array.isArray(providerContext.observations) && providerContext.observations.length > 0;
  const configuredSkillContext = await getAgentSkillRegistry().contextForInstruction(safeInstruction);
  const systemPrompt = [
    "You are StarDraw's global creative workflow Agent.",
    "Return only JSON. Never invent tools, ids, URLs, provider names, or credentials.",
    "Respond to the user naturally and decide whether a server tool is actually needed.",
    hasObservations
      ? "Use ReAct: consider context.observations, then either return the next tool call or finish with an empty calls array and a concise response that explains the result to the user."
      : "For greetings, capability questions, general conversation, or requests that need clarification, answer directly in response and return an empty calls array. Do not create a fake task or call agent.capability.search for a simple conversational answer.",
    "When an action is needed, return exactly one next tool call. Keep summary and response user-facing: never describe the user in the third person and never expose internal planning language.",
    "Only use toolKey values from tools[]. All tool calls are re-authorized by the server before execution.",
    "Respect context.agentPreferences when present: selected media models, sizes and video duration are user defaults; leave parameters empty when the preference is automatic.",
    "If context.attachedReferenceImages is non-empty, the user has already attached reference image(s). For image/video generation, use the attached reference and do not ask the user to upload it again; the executor binds and validates the resource separately.",
    "The disclosed tools are intentionally limited to the current intent. If none clearly fits, call agent.capability.search, observe its result, and then choose the concrete tool on the next turn.",
    "Copy toolKey exactly from tools[]. parameters must always be a JSON object that follows that tool's inputSchema.",
    "Never include payment, refund, or account-security actions unless the user explicitly requests them.",
    "The context.templates catalog is a compact index. It intentionally omits full starter prompts; use template.search or template.use when deeper template details are needed.",
    "context.currentPath is only a browser route, never a canvas id or resource id. If no trusted canvas id is present, call canvas.list before canvas.read.",
    "If context.currentCanvas.id exists, use that exact id for canvas and workflow tools. Never copy context.currentPath into canvasId.",
    "To build or edit a workflow, use workflow.catalog, workflow.read, then workflow.save or workflow.patch. Building a workflow must persist it to the canvas and must not call workflow.run unless the user explicitly asks to run or execute it.",
    "workflow.run may receive only canvasId to execute the workflow already saved in that canvas.",
    "Never use a template id or sceneKey outside the trusted catalog or a completed template.search/template.use result.",
    "For image/video generation, use freeform_image/freeform_video by default unless the user explicitly selected or requested a template.",
    "If context.requestedTemplate is present, preserve its id, scene_key, version, default model, and output type in the generation call.",
    "For image/video generation pass templateId, templateVersion, sceneKey, and the user's requested changes in userModification. The server performs final template prompt fusion.",
    "A pending media generation is an accepted task, not a failed attempt. Observe that exact creation with creation.get until it reaches completed, failed, or cancelled; never call media.generate.image or media.generate.video again while the original creation is pending.",
    "Give every call a unique ASCII id using letters, numbers, underscore, or hyphen.",
    "When a later call needs an earlier result, use an exact reference such as {{steps.generate.result.creationId}} or {{steps.read.result.state}}. Never guess generated ids.",
    "Before any canvas, storyboard, timeline, or director3d mutation, read that canvas and pass {{steps.read.result.updatedAt}} as expectedUpdatedAt.",
    "JSON schema: {\"summary\":\"short user-facing status\",\"response\":\"natural-language answer, or empty while more tools are needed\",\"execution_mode\":\"reactive\",\"calls\":[{\"id\":\"next\",\"name\":\"Next action\",\"toolKey\":\"media.generate.image\",\"parameters\":{},\"reason\":\"...\"}]}.",
    configuredSkillContext ? `Skills are instructions only:\n${configuredSkillContext}` : "",
  ].filter(Boolean).join("\n");
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify({ instruction: safeInstruction, language, context: providerContext, tools: safeTools }) },
  ];
  const normalizationContext = {
    tools: safeTools,
    language,
    reactive: true,
    observations: providerContext.observations,
    currentCanvas: providerContext.currentCanvas,
    requestedTemplate: providerContext.requestedTemplate,
    agentPreferences: providerContext.agentPreferences,
    reactContext: providerContext,
    instruction: safeInstruction,
    model: config.model,
    modelKey: config.modelKey,
    modelRouteId: config.routeId,
  };
  const normalizeProviderData = (data) => normalizeGlobalPlan(
    extractJsonObject(providerContent(data)),
    normalizationContext,
  );

  const data = await requestPlanFromProvider(messages, config);
  try {
    return { ...normalizeProviderData(data), usage: data?.usage || null };
  } catch (error) {
    if (!isRecoverableGlobalPlanOutputError(error)) throw error;
    if (error?.code === "AGENT_PROVIDER_EMPTY_PLAN" && hasObservations) throw error;
    logger.warn("canvasAgent.globalPlan.repairInvalidResponse", {
      model: config.model,
      toolCount: safeTools.length,
      errorCode: error?.code || "AGENT_PROVIDER_INVALID_RESPONSE",
      ...providerContentDiagnostics(data),
    });
    const previousContent = providerContent(data).slice(0, 4_000);
    const repaired = await requestPlanFromProvider([
      ...messages,
      ...(previousContent ? [{ role: "assistant", content: previousContent }] : []),
      {
        role: "user",
        content: hasObservations
          ? "Your previous answer was not valid JSON. Return one valid object matching the schema. Use exactly one tools[].toolKey for the next call, or finish with an empty calls array and a natural response when the observations prove the task is complete."
          : "Your previous answer was not valid JSON. Return one valid object matching the schema. For conversation or clarification, provide a natural response with an empty calls array; otherwise provide exactly one call using an exact tools[].toolKey.",
      },
    ], config);
    try {
      return {
        ...normalizeProviderData(repaired),
        usage: sumAgentTokenUsage(data?.usage, repaired?.usage),
      };
    } catch (repairError) {
      if (!isRecoverableGlobalPlanOutputError(repairError)) throw repairError;
      throw invalidGlobalPlanResponseError(repairError, repaired);
    }
  }
};
