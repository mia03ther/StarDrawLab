/**
 * HeyGen Video Agent provider.
 *
 * Base URL: https://api.heygen.com
 * Auth: X-Api-Key: <HEYGEN_API_KEY>
 *
 * Flow:
 *   POST /v3/video-agents -> session_id
 *   GET  /v3/video-agents/{session_id} -> video_id
 *   GET  /v3/videos/{video_id} -> completed video_url
 */
import axios from "axios";
import logger from "../configs/logger.js";
import { applyHeyGenDurationDirective } from "../utils/heygenDuration.js";
import { areProviderMocksEnabled } from "../infrastructure/providerRuntimePolicy.js";

export { applyHeyGenDurationDirective } from "../utils/heygenDuration.js";

const API_KEY = (process.env.HEYGEN_API_KEY || "").trim();
const BASE_URL = (process.env.HEYGEN_BASE_URL || "https://api.heygen.com").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.HEYGEN_VIDEO_AGENT_MODEL || "video-agent";

if (!API_KEY && process.env.NODE_ENV === "production") {
  logger.warn("HEYGEN_API_KEY is not set - external HeyGen rendering is disabled; offline template render can still run");
}

const heygenClient = axios.create({
  baseURL: BASE_URL,
  timeout: 120_000,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(API_KEY ? { "X-Api-Key": API_KEY } : {}),
  },
});

const firstNonEmpty = (...values) =>
  values.find((value) => typeof value === "string" && value.trim()) || null;

const normalizeHeyGenErrorMessage = (err, fallback = "HeyGen video task submission failed") => {
  const status = err.response?.status;
  const providerMessage =
    err.response?.data?.message ||
    err.response?.data?.error?.message ||
    err.response?.data?.error ||
    err.response?.data?.msg;

  if (providerMessage) {
    return typeof providerMessage === "string" ? providerMessage : JSON.stringify(providerMessage);
  }

  if (err.code === "ETIMEDOUT" || err.code === "ECONNABORTED" || /timeout/i.test(err.message || "")) {
    return "HeyGen API connection timed out. Check server network access to api.heygen.com or configure HEYGEN_BASE_URL to a reachable proxy.";
  }

  if (err.code === "ENETUNREACH" || err.code === "ECONNREFUSED" || err.code === "EHOSTUNREACH") {
    return `HeyGen API is unreachable from this server (${err.code}).`;
  }

  if (status) return `HeyGen API request failed with HTTP ${status}.`;
  return err.message || fallback;
};

const safeErrorData = (data) => {
  if (!data) return null;
  try {
    return JSON.stringify(data).slice(0, 800);
  } catch {
    return String(data).slice(0, 800);
  }
};

const normalizeStatus = (status, hasVideoUrl) => {
  const value = String(status || "").toLowerCase();
  if (hasVideoUrl) return "completed";
  if (["completed", "complete", "success", "succeeded", "done"].includes(value)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(value)) return "failed";
  if (["queued", "pending", "waiting"].includes(value)) return "queued";
  return "in_progress";
};

const normalizeProgress = (status, explicitProgress) => {
  const rawStatus = String(status || "").toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(rawStatus)) return 100;
  if (["failed", "failure", "error", "cancelled", "canceled"].includes(rawStatus)) return 0;
  const numeric = Number(explicitProgress);
  if (Number.isFinite(numeric)) return Math.max(0, Math.min(99, numeric));
  if (["queued", "pending", "waiting"].includes(rawStatus)) return 10;
  return 50;
};

export const isHeyGenProvider = (provider) =>
  ["heygen", "heygen_video_agent", "heygen-digital-human"].includes(
    String(provider || "").trim().toLowerCase()
  );

export const normalizeHeyGenModel = (model) => {
  const requested = String(model || "").trim();
  return requested || DEFAULT_MODEL;
};

export const normalizeHeyGenSize = (size) => {
  const requested = String(size || "").trim();
  if (requested === "720x1280") return "9:16";
  if (requested === "1280x720") return "16:9";
  if (["16:9", "9:16", "1:1", "auto"].includes(requested)) return requested;
  return "16:9";
};

export const submitHeyGenVideoAgentTask = async (prompt, options = {}) => {
  const finalPrompt = applyHeyGenDurationDirective(prompt, options.seconds);
  if (!API_KEY) {
    if (areProviderMocksEnabled()) {
      logger.warn("heygenAPI.submit: API_KEY not set, using mock");
      return mockSubmit(finalPrompt, options);
    }
    return { success: false, message: "HEYGEN_API_KEY is not configured" };
  }

  const payload = {
    prompt: finalPrompt,
  };

  const aspectRatio = normalizeHeyGenSize(options.size);
  if (aspectRatio) payload.aspect_ratio = aspectRatio;
  if (options.callbackUrl) payload.callback_url = options.callbackUrl;

  if (options.avatarId) payload.avatar_id = options.avatarId;
  if (options.voiceId) payload.voice_id = options.voiceId;
  if (Array.isArray(options.fileIds) && options.fileIds.length > 0) payload.file_ids = options.fileIds;

  try {
    logger.info("heygenAPI.submit.request", {
      aspectRatio,
      hasAvatar: Boolean(options.avatarId),
      hasVoice: Boolean(options.voiceId),
      prompt: finalPrompt.slice(0, 80),
    });

    const response = await heygenClient.post("/v3/video-agents", payload);
    const data = response.data;
    const sessionId =
      data?.data?.session_id ||
      data?.session_id ||
      data?.data?.id ||
      data?.id;

    if (!sessionId) {
      throw new Error(`No session_id in HeyGen response: ${JSON.stringify(data).slice(0, 500)}`);
    }

    return {
      success: true,
      taskId: sessionId,
      providerStatus: data?.data?.status || data?.status || "generating",
      model: normalizeHeyGenModel(options.model),
      raw: data,
    };
  } catch (err) {
    const message = normalizeHeyGenErrorMessage(err);
    logger.error("heygenAPI.submit.error", {
      message,
      rawMessage: err.message,
      code: err.code,
      status: err.response?.status,
      data: safeErrorData(err.response?.data),
      baseUrl: BASE_URL,
    });

    if (areProviderMocksEnabled()) {
      return mockSubmit(finalPrompt, options);
    }

    return {
      success: false,
      message,
      details: err.response?.data,
    };
  }
};

export const checkHeyGenVideoAgentStatus = async (sessionId) => {
  if (String(sessionId || "").startsWith("mock_heygen_session_")) {
    return mockCheck(sessionId);
  }

  try {
    const sessionResponse = await heygenClient.get(`/v3/video-agents/${sessionId}`);
    const sessionData = sessionResponse.data;
    const session = sessionData?.data || sessionData || {};
    const videoId = firstNonEmpty(session.video_id, session.videoId, session.video?.id);

    logger.info("heygenAPI.session.response", {
      sessionId,
      status: session.status,
      hasVideoId: Boolean(videoId),
    });

    if (!videoId) {
      const rawStatus = normalizeStatus(session.status, false);
      return {
        success: true,
        status: rawStatus,
        url: null,
        thumbUrl: null,
        progress: normalizeProgress(rawStatus, session.progress),
        message: session.failure_message || session.error || null,
        raw: {
          session: sessionData,
        },
      };
    }

    const videoResponse = await heygenClient.get(`/v3/videos/${videoId}`);
    const videoData = videoResponse.data;
    const video = videoData?.data || videoData || {};
    const videoUrl = firstNonEmpty(video.video_url, video.url, video.download_url);
    const thumbUrl = firstNonEmpty(video.thumbnail_url, video.preview_image_url, video.cover_url);
    const rawStatus = normalizeStatus(video.status || session.status, videoUrl);

    logger.info("heygenAPI.video.response", {
      sessionId,
      videoId,
      status: rawStatus,
      hasVideoUrl: Boolean(videoUrl),
    });

    return {
      success: true,
      status: rawStatus,
      url: videoUrl,
      thumbUrl,
      progress: normalizeProgress(rawStatus, video.progress || session.progress),
      message: video.failure_message || video.error || session.failure_message || session.error || null,
      raw: {
        session: sessionData,
        video: videoData,
        video_id: videoId,
      },
    };
  } catch (err) {
    const message = normalizeHeyGenErrorMessage(err, "HeyGen status query failed");
    logger.error("heygenAPI.check.error", {
      sessionId,
      message,
      rawMessage: err.message,
      code: err.code,
      status: err.response?.status,
      data: safeErrorData(err.response?.data),
      baseUrl: BASE_URL,
    });

    return {
      success: false,
      message,
      details: err.response?.data,
    };
  }
};

const MOCK_TASKS = new Map();

const mockSubmit = async (_prompt, options = {}) => {
  const taskId = `mock_heygen_session_${Date.now()}`;
  MOCK_TASKS.set(taskId, {
    status: "generating",
    createdAt: Date.now(),
    readyAt: Date.now() + 15_000,
    options,
  });

  return {
    success: true,
    taskId,
    providerStatus: "generating",
    model: normalizeHeyGenModel(options.model),
    raw: { mock: true, session_id: taskId },
  };
};

const mockCheck = async (sessionId) => {
  const task = MOCK_TASKS.get(sessionId);
  if (!task) return { success: false, message: "Mock HeyGen task not found" };

  if (Date.now() >= task.readyAt) {
    return {
      success: true,
      status: "completed",
      url: "https://www.w3schools.com/html/mov_bbb.mp4",
      thumbUrl: null,
      progress: 100,
      raw: { mock: true, session_id: sessionId, video_id: `mock_video_${sessionId}` },
    };
  }

  return {
    success: true,
    status: "in_progress",
    url: null,
    thumbUrl: null,
    progress: Math.min(90, Math.floor(((Date.now() - task.createdAt) / (task.readyAt - task.createdAt)) * 100)),
    raw: { mock: true, session_id: sessionId },
  };
};
