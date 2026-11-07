/**
 * Mirrmart image provider wrapper.
 * Images use the asynchronous POST /v1/videos contract and are completed by
 * polling GET /v1/videos/{task_id}.
 * 若环境未配置 IMAGE_PROVIDER_KEY，则退回 mock 模式（仅用于开发联调）。
 */
import logger from "../configs/logger.js";

const CONFIGURED_BASE_URL = String(
  process.env.IMAGE_PROVIDER_BASE_URL
    || process.env.SORA_BASE_URL
    || "https://www.aimh8.com/agent/openapi/fpbrowser2api",
).trim().replace(/\/$/, "");
const IS_MIRRMART = /aimh8\.com\/agent\/openapi\/fpbrowser2api/i.test(CONFIGURED_BASE_URL);
// The image and video products intentionally share the Mirrmart account. Do
// not accidentally use a stale APIKL key when only the image URL is switched.
const API_KEY = String(
  (IS_MIRRMART ? process.env.SORA_API_KEY : process.env.IMAGE_PROVIDER_KEY)
    || process.env.IMAGE_PROVIDER_KEY
    || process.env.SORA_API_KEY
    || "",
).trim();
const API_V1_BASE_URL = CONFIGURED_BASE_URL.endsWith("/v1")
  ? CONFIGURED_BASE_URL
  : `${CONFIGURED_BASE_URL}/v1`;
const normalizeModelAlias = (value) => {
  const model = String(value || "").trim();
  // image2 was never a separate provider model. Keep old persisted/client
  // values working while always sending the canonical model id upstream.
  return model === "image2" ? "gpt-image-2" : model;
};
const DEFAULT_MODEL = normalizeModelAlias(process.env.IMAGE_PROVIDER_MODEL) || "gpt-image-2";
const FALLBACK_MODEL = normalizeModelAlias(process.env.IMAGE_PROVIDER_FALLBACK_MODEL) || DEFAULT_MODEL;
const configuredTimeoutMs = Number(process.env.IMAGE_PROVIDER_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = Number.isSafeInteger(configuredTimeoutMs) && configuredTimeoutMs >= 30_000
  ? Math.min(configuredTimeoutMs, 290_000)
  : 240_000;
const CONFIGURED_MODELS = String(process.env.IMAGE_PROVIDER_MODELS || DEFAULT_MODEL)
  .split(",")
  .map(normalizeModelAlias)
  .filter(Boolean);
const ALLOWED_MODELS = new Set([
  ...CONFIGURED_MODELS,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
]);
const DEFAULT_REFERENCE_IMAGE_MODELS = ["gpt-image-2"];
const REFERENCE_IMAGE_MODELS = new Set(
  String(process.env.IMAGE_PROVIDER_REFERENCE_IMAGE_MODELS || DEFAULT_REFERENCE_IMAGE_MODELS.join(","))
    .split(",")
    .map(normalizeModelAlias)
    .filter(Boolean),
);
const ALLOWED_SIZES = new Set([
  "1024x1024", "576x1024", "1024x576", "1024x439", "768x1024", "1024x768",
  "720x1280", "1280x720",
  "1152x2048", "2048x1152", "2048x878", "2048x1536", "1536x2048", "2048x2048",
  "2304x4096", "1755x4096", "4096x1755", "4096x2304", "4096x3072", "3072x4096", "4096x4096",
]);
const pollIntervalMs = Number(process.env.IMAGE_PROVIDER_POLL_INTERVAL_MS);
const POLL_INTERVAL_MS = Number.isSafeInteger(pollIntervalMs) && pollIntervalMs >= 500
  ? Math.min(pollIntervalMs, 15_000)
  : 2_000;

const normalizeMirrmartModelAlias = (value) => {
  const model = normalizeModelAlias(value);
  return model.replace(/^gpt-image-2-(1k|2k|4k)$/, "gpt-image2-$1");
};

const resolveMirrmartModel = (model, size) => {
  const normalized = normalizeMirrmartModelAlias(model);
  if (normalized !== "gpt-image-2") return normalized;

  const [width, height] = String(size || "1024x1024").split("x").map(Number);
  const longestSide = Math.max(width || 1024, height || 1024);
  return longestSide >= 3000 ? "gpt-image2-4k" : longestSide >= 1500 ? "gpt-image2-2k" : "gpt-image2-1k";
};

const SUPPORTED_IMAGE_ASPECT_RATIOS = [
  ["1:1", 1],
  ["9:16", 9 / 16],
  ["16:9", 16 / 9],
  ["21:9", 21 / 9],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
];

const resolveImageAspectRatio = (size) => {
  const [width, height] = String(size || "").split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  return SUPPORTED_IMAGE_ASPECT_RATIOS.reduce((closest, candidate) => (
    Math.abs(ratio - candidate[1]) < Math.abs(ratio - closest[1]) ? candidate : closest
  ))[0];
};

export const normalizeImageModel = (value) => {
  const requested = normalizeModelAlias(value);
  if (!requested) return DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(requested)) {
    throw Object.assign(new Error(`Image model is not available: ${requested}`), {
      status: 400,
      code: "IMAGE_MODEL_UNAVAILABLE",
      model: requested,
    });
  }
  return requested;
};

export const normalizeImageSize = (value, fallback = "1024x1024") => {
  const requested = String(value || fallback).trim();
  return ALLOWED_SIZES.has(requested) ? requested : fallback;
};

export const imageModelSupportsReferenceImages = (value) =>
  REFERENCE_IMAGE_MODELS.has(normalizeModelAlias(value));

/**
 * 生成图片
 * @param {string} prompt       - 最终提示词（system_prompt + user_prompt 拼接后）
 * @param {string} size         - 例："1024x1024"
 * @param {Array<{buffer: Buffer, mimetype?: string, originalname?: string}>} referenceImages
 * @param {string} model        - Provider model, defaults to IMAGE_PROVIDER_MODEL
 * @param {string[]} referenceImageUrls - Short-lived provider-readable URLs
 * @returns {{ imageUrl: string | null, imageBuffer: Buffer | null, imageContentType: string, providerMode: string, providerRaw: object }}
 */
export const generateImage = async (
  prompt,
  size = "1024x1024",
  referenceImages = [],
  model = DEFAULT_MODEL,
  referenceImageUrls = [],
) => {
  const requestedModel = normalizeImageModel(model);
  const finalSize = normalizeImageSize(size);
  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  const providerReferenceImageUrls = Array.isArray(referenceImageUrls)
    ? referenceImageUrls.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];
  if (hasReferences && !imageModelSupportsReferenceImages(requestedModel)) {
    throw Object.assign(new Error("The selected image model does not support reference images. Please choose a model with image-edit support."), {
      status: 400,
      code: "IMAGE_MODEL_REFERENCE_IMAGES_UNSUPPORTED",
      model: requestedModel,
    });
  }
  // Mirrmart's image endpoint accepts references as provider-readable URLs.
  // Generic OpenAI-compatible adapters still use the multipart contract and
  // can consume the staged Buffers directly.
  if (hasReferences && IS_MIRRMART && providerReferenceImageUrls.length === 0) {
    throw Object.assign(new Error("Reference images require provider-readable URLs."), {
      status: 422,
      code: "IMAGE_PROVIDER_REFERENCE_URL_REQUIRED",
    });
  }
  const effectiveModel = requestedModel;

  if (!API_KEY) {
    if (process.env.NODE_ENV !== "production") {
      logger.warn("imageProvider: IMAGE_PROVIDER_KEY not set, using mock");
      return mockGenerate(prompt, finalSize, referenceImages, effectiveModel);
    }
    throw Object.assign(new Error("IMAGE_PROVIDER_KEY is not configured"), {
      status: 503,
      code: "IMAGE_PROVIDER_NOT_CONFIGURED",
    });
  }

  const providerMode = hasReferences ? "edits" : "generations";

  try {
    const data = await requestProviderImage({
      prompt,
      size: finalSize,
      referenceImages,
      referenceImageUrls: providerReferenceImageUrls,
      model: effectiveModel,
    });

    const normalized = normalizeImageResult(data.task);

    logger.info("imageProvider.generate.success", {
      size: finalSize,
      model: effectiveModel,
      requestedModel,
      providerMode,
      referenceImageCount: referenceImages.length,
    });

    return {
      ...normalized,
      providerMode,
      providerRaw: {
        ...data.task,
        requested_model: requestedModel,
        effective_model: effectiveModel,
        upstream_model: data.upstreamModel,
      },
    };
  } catch (err) {
    if (shouldRetryWithFallbackModel(err, effectiveModel)) {
      logger.warn("imageProvider.generate.retryFallback", {
        requestedModel,
        effectiveModel,
        fallbackModel: FALLBACK_MODEL,
        status: err.status,
        providerMode,
        details: err.details,
      });

      const data = await requestProviderImage({
        prompt,
        size: finalSize,
        referenceImages,
        referenceImageUrls: providerReferenceImageUrls,
        model: FALLBACK_MODEL,
      });
      const normalized = normalizeImageResult(data.task);

      logger.info("imageProvider.generate.success", {
        size: finalSize,
        model: FALLBACK_MODEL,
        requestedModel,
        effectiveModel,
        providerMode,
        referenceImageCount: referenceImages.length,
      });

      return {
        ...normalized,
        providerMode,
        providerRaw: {
          ...data.task,
          requested_model: requestedModel,
          effective_model: FALLBACK_MODEL,
          upstream_model: data.upstreamModel,
          fallback_model: FALLBACK_MODEL,
        },
      };
    }

    if (isProviderDiskOverloaded(err)) {
      err.code = "IMAGE_PROVIDER_TEMPORARILY_OVERLOADED";
      err.message = "Image provider is temporarily overloaded. Please retry shortly.";
    }

    logger.error("imageProvider.generate.error", {
      message: err.message,
      status: err.status,
      providerMode,
      referenceImageCount: referenceImages.length,
      details: err.details,
    });
    throw err;
  }
};

const shouldRetryWithFallbackModel = (err, finalModel) => {
  if (!FALLBACK_MODEL || finalModel === FALLBACK_MODEL) return false;
  if (err?.status !== 503) return false;

  return isDeterministicNoChannelResponse(err.status, err.details)
    || /no available channel|无可用渠道/i.test(String(err?.message || ""));
};

const isDeterministicNoChannelResponse = (status, details) => {
  if (status !== 503) return false;
  const message = String(details?.error?.message || "");
  return message.includes("无可用渠道") || /no available channel/i.test(message);
};

const providerErrorMessage = (error) => String(
  error?.details?.error?.message
  || error?.details?.message
  || error?.message
  || "",
).toLowerCase();

const isProviderDiskOverloaded = (error) => (
  error?.status === 503
  && /system disk overloaded|disk.*overload/.test(providerErrorMessage(error))
);

const providerHeaders = () => ({
  Accept: "application/json",
  "Content-Type": "application/json",
  ...(API_KEY
    ? {
      "x-api-key": API_KEY,
      Authorization: `Bearer ${API_KEY}`,
    }
    : {}),
});

const sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

const parseJsonResponse = async (response) => {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    return {
      error: {
        message: rawText.slice(0, 500) || `HTTP ${response.status}`,
        type: "non_json_response",
      },
    };
  }
};

const createProviderError = ({ response, data, method }) => {
  const status = Number(response?.status) || 502;
  const message = String(
    data?.error?.message
      || data?.message
      || `Image provider request failed with HTTP ${status}.`,
  ).trim().slice(0, 500);
  const error = new Error(message);
  error.status = status;
  error.code = status === 429
    ? "IMAGE_PROVIDER_RATE_LIMITED"
    : status >= 500
      ? "IMAGE_PROVIDER_UPSTREAM_ERROR"
      : "IMAGE_PROVIDER_HTTP_ERROR";
  error.providerCode = data?.error?.code || data?.code || null;
  error.details = data;
  error.retryable = [408, 425, 429].includes(status) || status >= 500;
  // A POST may have reached the provider even when its response is an error.
  error.outcomeUnknown = method !== "GET" && status >= 500;
  return error;
};

const requestMirrmartJson = async (path, { method = "GET", body, timeoutMs } = {}) => {
  const requestTimeoutMs = Math.max(1_000, Math.min(timeoutMs || 30_000, REQUEST_TIMEOUT_MS));
  let response;
  try {
    response = await fetch(`${API_V1_BASE_URL}${path}`, {
      method,
      headers: providerHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    const providerError = Object.assign(
      new Error(timeout ? "Image provider request timed out." : `Image provider request failed: ${error.message}`),
      {
        status: timeout ? 504 : 502,
        code: timeout ? "IMAGE_PROVIDER_UPSTREAM_TIMEOUT" : "IMAGE_PROVIDER_UNAVAILABLE",
        retryable: method === "GET",
        outcomeUnknown: method !== "GET",
        cause: error,
      },
    );
    throw providerError;
  }

  const data = await parseJsonResponse(response);
  if (!response.ok) throw createProviderError({ response, data, method });
  return data;
};

const buildMirrmartImagePayload = ({ prompt, size, model, referenceImageUrls }) => {
  const upstreamModel = resolveMirrmartModel(model, size);
  const aspectRatio = resolveImageAspectRatio(size);
  const payload = {
    prompt,
    model: upstreamModel,
    size,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
  };
  const urls = Array.isArray(referenceImageUrls) ? referenceImageUrls : [];

  if (urls.length > 0) {
    if (upstreamModel.startsWith("gpt-image2-")) {
      payload.image_urls = urls;
    } else if (urls.length === 1) {
      payload.input_reference = urls[0];
    } else {
      payload.reference_images = urls;
    }
  }

  return { payload, upstreamModel };
};

const isTerminalImageStatus = (status) => [
  "completed", "success", "failed", "error", "cancelled", "canceled", "expired",
].includes(String(status || "").toLowerCase());

const pollMirrmartImageTask = async (taskId) => {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const task = await requestMirrmartJson(`/videos/${encodeURIComponent(taskId)}`, {
        method: "GET",
        timeoutMs: Math.min(30_000, Math.max(1_000, deadline - Date.now())),
      });
      const status = String(task?.status || "queued").toLowerCase();
      if (status === "completed" || status === "success") return task;
      if (["failed", "error", "cancelled", "canceled", "expired"].includes(status)) {
        const error = new Error(String(task?.error?.message || task?.message || "Image provider task failed"));
        error.status = 502;
        error.code = "IMAGE_PROVIDER_TASK_FAILED";
        error.details = task;
        error.retryable = false;
        throw error;
      }
      lastError = null;
    } catch (error) {
      lastError = error;
      if (!error.retryable) throw error;
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(250, deadline - Date.now())));
  }

  const timeout = Object.assign(
    new Error(lastError?.message || "Image provider task polling timed out."),
    {
      status: 504,
      code: "IMAGE_PROVIDER_UPSTREAM_TIMEOUT",
      retryable: false,
      outcomeUnknown: true,
      details: lastError?.details || null,
    },
  );
  throw timeout;
};

const requestProviderImage = async ({ prompt, size, referenceImages, referenceImageUrls, model, waitForCompletion = true }) => {
  if (!IS_MIRRMART) {
    return requestLegacyProviderImage({ prompt, size, referenceImages, model });
  }

  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  const { payload, upstreamModel } = buildMirrmartImagePayload({ prompt, size, model, referenceImageUrls });
  const submitted = await requestMirrmartJson("/videos", {
    method: "POST",
    body: payload,
    timeoutMs: Math.min(30_000, REQUEST_TIMEOUT_MS),
  });
  const taskId = submitted?.id || submitted?.task_id;
  if (!taskId) {
    const error = new Error("Image provider returned no task ID.");
    error.status = 502;
    error.code = "IMAGE_PROVIDER_TASK_ID_MISSING";
    error.details = submitted;
    error.outcomeUnknown = true;
    throw error;
  }

  const status = String(submitted?.status || "").toLowerCase();
  const task = isTerminalImageStatus(status) || !waitForCompletion
    ? submitted
    : await pollMirrmartImageTask(taskId);
  logger.info(waitForCompletion ? "imageProvider.mirrmart.completed" : "imageProvider.mirrmart.submitted", {
    taskId: String(taskId),
    model: upstreamModel,
    providerMode: hasReferences ? "edits" : "generations",
  });
  return { task, upstreamModel };
};

const normalizeImageSubmissionFailure = (task) => {
  const status = String(task?.status || "").toLowerCase();
  if (!isTerminalImageStatus(status) || ["completed", "success"].includes(status)) return null;
  const error = new Error(String(task?.error?.message || task?.message || "Image provider task failed"));
  error.status = 502;
  error.code = "IMAGE_PROVIDER_TASK_FAILED";
  error.details = task;
  error.retryable = false;
  return error;
};

/**
 * Submit an image request without waiting for the provider's asynchronous task.
 * Mirrmart's /videos endpoint is intentionally kept outside the HTTP request
 * lifetime; the worker owns the later status check and OSS settlement.
 */
export const submitImage = async ({
  prompt,
  size = "1024x1024",
  referenceImages = [],
  model = DEFAULT_MODEL,
  referenceImageUrls = [],
} = {}) => {
  const requestedModel = normalizeImageModel(model);
  const finalSize = normalizeImageSize(size);
  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  const providerReferenceImageUrls = Array.isArray(referenceImageUrls)
    ? referenceImageUrls.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim())
    : [];

  if (hasReferences && !imageModelSupportsReferenceImages(requestedModel)) {
    throw Object.assign(new Error("The selected image model does not support reference images. Please choose a model with image-edit support."), {
      status: 400,
      code: "IMAGE_MODEL_REFERENCE_IMAGES_UNSUPPORTED",
      model: requestedModel,
    });
  }
  if (hasReferences && IS_MIRRMART && providerReferenceImageUrls.length === 0) {
    throw Object.assign(new Error("Reference images require provider-readable URLs."), {
      status: 422,
      code: "IMAGE_PROVIDER_REFERENCE_URL_REQUIRED",
    });
  }

  if (!API_KEY) {
    if (process.env.NODE_ENV !== "production") {
      const mock = await mockGenerate(prompt, finalSize, referenceImages, requestedModel);
      return { ...mock, success: true, status: "completed", providerStatus: "completed" };
    }
    throw Object.assign(new Error("IMAGE_PROVIDER_KEY is not configured"), {
      status: 503,
      code: "IMAGE_PROVIDER_NOT_CONFIGURED",
    });
  }

  const providerMode = hasReferences ? "edits" : "generations";
  try {
    const data = await requestProviderImage({
      prompt,
      size: finalSize,
      referenceImages,
      referenceImageUrls: providerReferenceImageUrls,
      model: requestedModel,
      waitForCompletion: false,
    });
    const task = data.task || {};
    if (!IS_MIRRMART) {
      const normalized = normalizeImageResult(task);
      return {
        ...normalized,
        success: true,
        status: "completed",
        providerStatus: "completed",
        providerMode,
        providerRaw: task,
      };
    }
    const taskId = String(task.id || task.task_id || "").trim();
    if (!taskId) {
      const error = new Error("Image provider returned no task ID.");
      error.status = 502;
      error.code = "IMAGE_PROVIDER_TASK_ID_MISSING";
      error.details = task;
      error.outcomeUnknown = true;
      throw error;
    }

    const failed = normalizeImageSubmissionFailure(task);
    if (failed) throw failed;
    const status = String(task.status || "queued").toLowerCase();
    if (["completed", "success"].includes(status)) {
      const normalized = normalizeImageResult(task);
      return {
        ...normalized,
        success: true,
        status: "completed",
        providerStatus: status,
        providerMode,
        taskId,
        providerRaw: { ...task, requested_model: requestedModel, upstream_model: data.upstreamModel },
      };
    }
    return {
      success: true,
      status,
      providerStatus: status || "queued",
      taskId,
      providerMode,
      providerRaw: { ...task, requested_model: requestedModel, upstream_model: data.upstreamModel },
    };
  } catch (err) {
    if (isProviderDiskOverloaded(err)) {
      err.code = "IMAGE_PROVIDER_TEMPORARILY_OVERLOADED";
      err.message = "Image provider is temporarily overloaded. Please retry shortly.";
    }
    logger.error("imageProvider.submit.error", {
      message: err.message,
      status: err.status,
      providerMode,
      referenceImageCount: referenceImages.length,
      details: err.details,
    });
    throw err;
  }
};

export const checkImage = async (taskId) => {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) {
    throw Object.assign(new Error("Image provider task ID is required."), {
      status: 400,
      code: "IMAGE_PROVIDER_TASK_ID_REQUIRED",
    });
  }
  if (!IS_MIRRMART) {
    throw Object.assign(new Error("Image status checks are unavailable for this provider."), {
      status: 503,
      code: "IMAGE_PROVIDER_STATUS_UNAVAILABLE",
      retryable: false,
    });
  }

  const task = await requestMirrmartJson(`/videos/${encodeURIComponent(normalizedTaskId)}`, {
    method: "GET",
    timeoutMs: 30_000,
  });
  const status = String(task?.status || "queued").toLowerCase();
  if (["failed", "error", "cancelled", "canceled", "expired"].includes(status)) {
    return {
      success: true,
      status: "failed",
      message: String(task?.error?.message || task?.message || "Image provider task failed"),
      raw: task,
    };
  }
  if (["completed", "success"].includes(status)) {
    let normalized = {};
    try {
      normalized = normalizeImageResult(task);
    } catch (error) {
      return { success: true, status: "completed", progress: 100, message: error.message, raw: task };
    }
    return {
      success: true,
      status: "completed",
      progress: 100,
      url: normalized.imageUrl,
      imageBuffer: normalized.imageBuffer,
      imageContentType: normalized.imageContentType,
      raw: task,
    };
  }
  return {
    success: true,
    status,
    progress: Number.isFinite(Number(task?.progress)) ? Number(task.progress) : null,
    raw: task,
  };
};

// Keep the provider boundary compatible with OpenAI Images API deployments.
// This path is selected only for a non-Mirrmart base URL; production's
// Mirrmart path above remains the documented asynchronous /videos contract.
const legacyProviderHeaders = ({ multipart = false } = {}) => ({
  Accept: "application/json",
  Authorization: `Bearer ${API_KEY}`,
  "x-api-key": API_KEY,
  ...(multipart ? {} : { "Content-Type": "application/json" }),
});

const createLegacyProviderError = ({ response, data }) => {
  const status = Number(response?.status) || 502;
  if (status === 504) {
    return Object.assign(new Error("Image provider request timed out."), {
      status,
      code: "IMAGE_PROVIDER_UPSTREAM_TIMEOUT",
      details: data,
      retryable: false,
      outcomeUnknown: true,
    });
  }
  return createProviderError({ response, data, method: "POST" });
};

const requestLegacyProvider = async (path, { body, multipart = false } = {}) => {
  let response;
  try {
    response = await fetch(`${API_V1_BASE_URL}${path}`, {
      method: "POST",
      headers: legacyProviderHeaders({ multipart }),
      body: multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw Object.assign(
      new Error(timeout ? "Image provider request timed out." : `Image provider request failed: ${error.message}`),
      {
        status: timeout ? 504 : 502,
        code: timeout ? "IMAGE_PROVIDER_UPSTREAM_TIMEOUT" : "IMAGE_PROVIDER_UNAVAILABLE",
        retryable: false,
        outcomeUnknown: true,
        cause: error,
      },
    );
  }

  const data = await parseJsonResponse(response);
  if (!response.ok) throw createLegacyProviderError({ response, data });
  return data;
};

const requestLegacyProviderImage = async ({ prompt, size, referenceImages, model }) => {
  const hasReferences = Array.isArray(referenceImages) && referenceImages.length > 0;
  if (!hasReferences) {
    const task = await requestLegacyProvider("/images/generations", {
      body: {
        model,
        prompt,
        n: 1,
        size,
        response_format: "url",
      },
    });
    return { task, upstreamModel: model };
  }

  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("response_format", "url");
  if (size) form.append("size", size);
  referenceImages.forEach((file, index) => {
    form.append(
      "image",
      new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
      file.originalname || `reference-${index + 1}.png`,
    );
  });

  const task = await requestLegacyProvider("/images/edits", { body: form, multipart: true });
  return { task, upstreamModel: model };
};

const normalizeImageResult = (data) => {
  const firstOutput = Array.isArray(data?.output)
    ? data.output.find((item) => item?.type === "image" && item?.url) || data.output.find((item) => item?.url)
    : null;
  const imageUrl = data?.image_url
    || data?.result?.image_url
    || firstOutput?.url
    || data?.video_url
    || data?.result?.video_url
    || data?.data?.[0]?.url
    || null;

  const firstLegacyOutput = data?.data?.[0];
  if (firstLegacyOutput?.b64_json) {
    return {
      imageUrl: null,
      imageBuffer: Buffer.from(firstLegacyOutput.b64_json, "base64"),
      imageContentType: "image/png",
    };
  }

  if (!imageUrl) throw new Error("Provider returned no image output.");
  return {
    imageUrl,
    imageBuffer: null,
    imageContentType: /\.png(?:[?#]|$)/i.test(imageUrl) ? "image/png" : "image/jpeg",
  };
};

const mockGenerate = async (prompt, size, referenceImages = [], model = DEFAULT_MODEL) => {
  await new Promise((r) => setTimeout(r, 1500));
  const providerMode = referenceImages.length > 0 ? "edits" : "generations";
  logger.info("imageProvider.mock", { prompt: prompt.slice(0, 80), size, model, providerMode });
  return {
    imageUrl:
      "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=1024&q=80",
    imageBuffer: null,
    imageContentType: "image/jpeg",
    providerMode,
    providerRaw: { mock: true, model, prompt, size, providerMode },
  };
};
