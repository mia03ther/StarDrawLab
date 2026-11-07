/**
 * Video Provider wrapper for an OpenAI-compatible asynchronous video API.
 *
 * Production currently uses Mirrmart's fpbrowser2api gateway.
 * Auth: x-api-key and Authorization bearer headers
 *
 * API Docs:
 *   POST /v1/videos - Create video task
 *   GET /v1/videos/{task_id} - Query task status
 *
 * Response format:
 *   Submit: { id, status, model, ... }
 *   Status: { id, status, progress, video_url, result: { share_url, thumb_url }, ... }
 */
import axios from "axios";
import logger from "../configs/logger.js";
import { areProviderMocksEnabled } from "../infrastructure/providerRuntimePolicy.js";

const API_KEY  = (process.env.SORA_API_KEY || "").trim();
export const normalizeVideoProviderBaseUrl = (value) => {
  const base = String(value || "https://www.aimh8.com/agent/openapi/fpbrowser2api").trim().replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? base : `${base}/v1`;
};
const BASE_URL = normalizeVideoProviderBaseUrl(process.env.SORA_BASE_URL);
const MODEL    = process.env.VIDEO_MODEL || "veo-3-1";
const VEO_ALIASES = new Set(["veo3.1", "veo-3.1", "veo31"]);
export const isGrokVideoModel = model => /^grok-imagine-video(?:-[a-z0-9.-]+)?$/i.test(String(model || "").trim());
const SUPPORTED_VIDEO_SIZES = new Set(["720x1280", "1280x720"]);

export const resolveVideoSubmitPath = (model, baseUrl = BASE_URL) => {
  if (!isGrokVideoModel(model)) return "/videos";
  const endpoint = new URL(baseUrl);
  // Grok model names do not imply that a gateway implements xAI's protocol.
  // Mirrmart's native creation contract has not been verified; its xAI path is 404.
  if (endpoint.origin !== "https://api.x.ai") {
    const message = "当前视频供应商的 Grok 创建协议尚未验证，未提交生成请求。";
    throw Object.assign(new Error(message), {response:{status:422,data:{code:"VIDEO_PROVIDER_PROTOCOL_UNVERIFIED",message}}});
  }
  return "/videos/generations";
};


if (!API_KEY && process.env.NODE_ENV === "production") {
  logger.error("SORA_API_KEY is not set — video generation will fail in production");
}

const apiClient = axios.create({
  baseURL: BASE_URL,
  timeout: 120_000,
  headers: {
    "Content-Type": "application/json",
    "Accept": "application/json",
    ...(API_KEY ? {
      "x-api-key": API_KEY,
      "Authorization": `Bearer ${API_KEY}`,
    } : {}),
  },
});

export const normalizeVideoProviderModel = (model) => {
  const requested = String(model || "").trim();
  if (!requested || requested.toLowerCase() === "sora") return MODEL;
  const key = requested.toLowerCase();
  if (VEO_ALIASES.has(key)) return "veo-3-1";
  if (key === "sora-2" || key === "sora2") return "sora2";
  return requested;
};

export const normalizeVideoProviderSize = (size) => {
  const requested = String(size || "").trim();
  return SUPPORTED_VIDEO_SIZES.has(requested) ? requested : "720x1280";
};

export const buildSoraVideoPayload = ({ prompt, model, seconds, size, imageUrl = null, imageUrls = [] }) => {
  const finalModel = normalizeVideoProviderModel(model);
  const finalSize = normalizeVideoProviderSize(size);
  if (isGrokVideoModel(finalModel)) {
    const refs = [...new Set([...(Array.isArray(imageUrls) ? imageUrls : []), imageUrl].map(value => String(value || "").trim()).filter(Boolean))];
    const duration = Number(seconds ?? 6);
    const invalid = message => { throw Object.assign(new Error(message), {response:{status:400,data:{code:"GROK_VIDEO_PARAMETERS_INVALID",message}}}); };
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) invalid("Grok video duration must be an integer from 1 to 15 seconds");
    if (refs.length > 1) invalid("Multiple Grok references require a separately verified reference-to-video contract");
    return { model: finalModel, prompt, duration, aspect_ratio: finalSize === "720x1280" ? "9:16" : "16:9", resolution: "720p", ...(refs.length ? {image:{url:refs[0]}} : {}) };
  }
  const payload = {
    model: finalModel,
    prompt,
    size: finalSize,
  };

  const referenceUrls = [...new Set([
    ...(Array.isArray(imageUrls) ? imageUrls : []),
    imageUrl,
  ].map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 4);
  if (referenceUrls.length === 1) {
    payload.input_reference = referenceUrls[0];
  } else if (referenceUrls.length > 1) {
    payload.input_mode = "multi_frame_reference";
    payload.reference_images = referenceUrls;
  }

  if (finalModel === "veo-3-1") {
    // Mirrmart's Veo 3.1 workflow is fixed at 240 frames. Supplying duration
    // selects a different legacy contract and is rejected by this endpoint.
    payload.n_frames = 240;
  } else if (seconds && ["sora2", "sora-2"].includes(finalModel.toLowerCase())) {
    payload.duration = Number(seconds);
  }

  return payload;
};

const providerErrorValue = (data, field) => data?.error?.[field] ?? data?.[field] ?? null;

export const normalizeSoraProviderFailure = (error) => {
  const details = error?.response?.data ?? null;
  const upstreamMessage = String(
    providerErrorValue(details, "message")
      || (typeof details?.error === "string" ? details.error : "")
      || error?.message
      || "Video provider request failed",
  ).trim().slice(0, 500);
  const channelUnavailable = /无可用渠道|no available (?:channel|route)/i.test(upstreamMessage);
  const durationMatch = upstreamMessage.match(/only supports duration\s*=\s*(\d+)/i);
  const responseStatus = Number(error?.response?.status);
  const status = Number.isInteger(responseStatus) && responseStatus >= 400 && responseStatus <= 599
    ? responseStatus
    : 502;

  return {
    success: false,
    status: channelUnavailable ? 503 : durationMatch ? 422 : status,
    code: providerErrorValue(details, "code") === "VIDEO_PROVIDER_PROTOCOL_UNVERIFIED" ? "VIDEO_PROVIDER_PROTOCOL_UNVERIFIED" : channelUnavailable ? "VIDEO_PROVIDER_CHANNEL_UNAVAILABLE" : durationMatch
      ? "VIDEO_PROVIDER_DURATION_UNSUPPORTED"
      : status === 429
        ? "VIDEO_PROVIDER_RATE_LIMITED"
        : status >= 500
          ? "VIDEO_PROVIDER_UNAVAILABLE"
          : "VIDEO_PROVIDER_REQUEST_REJECTED",
    message: channelUnavailable ? "视频供应商当前没有可用生成渠道，请稍后重试或联系客服。" : durationMatch
      ? `视频模型仅支持 ${durationMatch[1]} 秒`
      : upstreamMessage,
    providerCode: providerErrorValue(details, "code"),
    providerStatus: status,
    details,
  };
};

// Some gateway deployments wrap the same task document in { data: task }.
// Preserve the original top-level contract and never reinterpret output arrays
// or an unrelated metadata object as a task.
export const normalizeSoraTaskResponse = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const wrapped = value.data;
  const hasTaskFields = (task) => task && typeof task === "object" && !Array.isArray(task)
    && ["id", "task_id", "request_id", "status"].some((key) => task[key] != null);
  const hasTaskId = (task) => task && (task.id != null || task.task_id != null || task.request_id != null);
  return !hasTaskId(value) && hasTaskFields(wrapped)
    && (hasTaskId(wrapped) || !hasTaskFields(value)) ? wrapped : value;
};

const invalidProviderResponse = (data) => Object.assign(
  new Error(String(providerErrorValue(data, "message") || (typeof data?.error === "string" ? data.error : "Video provider returned an invalid task response")).slice(0, 500)),
  { response: { status: 502, data } },
);
const providerExplicitlyRejected = (data) => data?.success === false
  || Boolean(data?.error && !data?.id && !data?.task_id && !data?.status);

const firstOutputUrl = (output, type) => {
  if (!Array.isArray(output)) return null;
  const typed = output.find((item) => !type || item?.type === type);
  return typed?.url || (!output.some(item => item?.type) ? output.find(item => item?.url)?.url : null) || null;
};

/**
 * 提交视频生成任务
 * @param {string} prompt - 视频描述
 * @param {string} model - 模型名称 (veo-3-1, sora2, etc.)
 * @param {number} seconds - 时长（部分模型支持）
 * @param {string} size - 分辨率 (e.g., "1280x720")
 * @param {string|null} imageUrl - 兼容单张图生视频参考图 URL
 * @param {string[]} imageUrls - 最多四张图生视频参考图 URL
 * @returns {{ success, taskId, providerStatus, raw }}
 */
export const submitSoraVideoTask = async (prompt, model, seconds = 6, size = "1280x720", imageUrl = null, imageUrls = []) => {
  if (!API_KEY) {
    if (areProviderMocksEnabled()) {
      logger.warn("soraAPI.submit: API_KEY not set, using mock");
      return mockSubmit(prompt, model, seconds, size, imageUrl, imageUrls);
    }
    return { success: false, message: "SORA_API_KEY is not configured" };
  }

  try {
    const finalModel = normalizeVideoProviderModel(model);
    const finalSize = normalizeVideoProviderSize(size);
    const submitPath = resolveVideoSubmitPath(finalModel);
    const payload = buildSoraVideoPayload({ prompt, model: finalModel, seconds, size: finalSize, imageUrl, imageUrls });

    logger.info("soraAPI.submit.request", {
      model: finalModel,
      seconds,
      size: finalSize,
      referenceImageCount: Array.isArray(payload.reference_images) ? payload.reference_images.length : payload.input_reference ? 1 : 0,
      prompt: prompt.slice(0, 80),
    });

    const response = await apiClient.post(submitPath, payload);
    if (providerExplicitlyRejected(response.data)) throw invalidProviderResponse(response.data);
    const data = normalizeSoraTaskResponse(response.data);
    if (providerExplicitlyRejected(data)) throw invalidProviderResponse(data);

    logger.info("soraAPI.submit.response", { data: JSON.stringify(data).slice(0, 300) });

    // OpenAI-compatible response: { id, status, model }
    const taskId = data?.id || data?.task_id || data?.request_id;

    if (!taskId) {
      if (areProviderMocksEnabled()) {
        logger.warn("soraAPI.submit: no taskId in response, falling back to mock");
        return mockSubmit(prompt, model, seconds, size, imageUrl, imageUrls);
      }
      throw new Error(`No taskId in provider response: ${JSON.stringify(data)}`);
    }

    const providerStatus = data?.status || "queued";

    return { success: true, taskId, providerStatus, model: finalModel, raw: data };
  } catch (err) {
    logger.error("soraAPI.submit.error", {
      message: err.message,
      status: err.response?.status,
      data: JSON.stringify(err.response?.data || {}).slice(0, 300),
    });

    if (areProviderMocksEnabled()) {
      return mockSubmit(prompt, model, seconds, size, imageUrl, imageUrls);
    }
    return normalizeSoraProviderFailure(err);
  }
};

/**
 * 查询视频任务状态
 * @param {string} taskId - 任务ID
 * @returns {{ success, status, url, thumbUrl, progress, message, raw }}
 */
export const checkSoraVideoStatus = async (value) => {
  const validType = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
  const taskId = validType ? String(value).trim() : "";
  if (!taskId || taskId === "." || taskId === ".." || taskId.length > 512 || /[\x00-\x1f\x7f]/.test(taskId)) {
    return { success: false, status: 400, code: "VIDEO_TASK_ID_INVALID", message: "Video task ID is invalid" };
  }
  if (taskId.startsWith("mock_task_")) {
    return mockCheck(taskId);
  }

  try {
    const response = await apiClient.get(`/videos/${encodeURIComponent(taskId)}`);
    if (providerExplicitlyRejected(response.data)) throw invalidProviderResponse(response.data);
    const data = normalizeSoraTaskResponse(response.data);
    if (providerExplicitlyRejected(data) || typeof data.status !== "string" || !data.status.trim()) throw invalidProviderResponse(data);

    logger.info("soraAPI.check.response", { taskId, data: JSON.stringify(data).slice(0, 300) });

    const upstreamStatus = String(data.status).trim().toLowerCase();
    const rawStatus = upstreamStatus === "done" ? "completed" : upstreamStatus;

    // 优先使用供应商自有可下载地址，避免回落到 videos.openai.com 之类的分享链接。
    const videoUrl =
      data?.result?.watermark_free_url ||
      data?.result?.watermark_free_url_src ||
      data?.result?.video_url ||
      data?.video_url ||
      data?.video?.url ||
      firstOutputUrl(data?.output, "video") ||
      data?.data?.[0]?.url ||
      data?.url ||
      null;

    const thumbUrl =
      data?.result?.preview_image_url ||
      data?.image_url ||
      data?.result?.thumb_url ||
      null;

  const progress =
    ["completed", "success"].includes(rawStatus) ? 100 :
    ["failed", "error", "cancelled", "expired"].includes(rawStatus) ? 0 :
      (data?.progress ?? 50);

    return {
      success: true,
      status: rawStatus,
      url: videoUrl,
      thumbUrl,
      progress,
      message: providerErrorValue(data, "message") || (typeof data?.error === "string" ? data.error : null),
      raw: data,
    };
  } catch (err) {
    logger.error("soraAPI.check.error", {
      taskId,
      message: err.message,
      status: err.response?.status,
      data: JSON.stringify(err.response?.data || {}).slice(0, 200),
    });
    return normalizeSoraProviderFailure(err);
  }
};

// ─── Mock（开发联调用）─────────────────────────────────
const MOCK_TASKS = new Map();

const mockSubmit = async (prompt, model, seconds, size, imageUrl = null, imageUrls = []) => {
  const taskId = `mock_task_${Date.now()}`;
  MOCK_TASKS.set(taskId, {
    status: "queued",
    createdAt: Date.now(),
    readyAt: Date.now() + 15_000,
    imageUrl,
    imageUrls,
  });

  logger.info("soraAPI.mock.submit", { taskId });

  return { success: true, taskId, providerStatus: "queued", raw: { mock: true } };
};

const mockCheck = async (taskId) => {
  const task = MOCK_TASKS.get(taskId);
  if (!task) return { success: false, message: "Mock task not found" };

  if (Date.now() >= task.readyAt) {
    MOCK_TASKS.set(taskId, { ...task, status: "completed" });
    return {
      success: true,
      status: "completed",
      url: "https://www.w3schools.com/html/mov_bbb.mp4",
      thumbUrl: null,
      progress: 100,
      raw: { mock: true },
    };
  }

  return {
    success: true,
    status: "in_progress",
    url: null,
    thumbUrl: null,
    progress: Math.min(90, Math.floor(((Date.now() - task.createdAt) / (task.readyAt - task.createdAt)) * 100)),
    raw: { mock: true },
  };
};
