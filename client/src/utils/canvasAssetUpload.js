const MIME_TO_ASSET_TYPE = new Map([
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["image/gif", "image"],
  ["image/bmp", "image"],
  ["image/x-ms-bmp", "image"],
  ["image/heic", "image"],
  ["image/heif", "image"],
  ["image/avif", "image"],
  ["video/mp4", "video"],
  ["video/webm", "video"],
  ["video/quicktime", "video"],
  ["video/x-m4v", "video"],
  ["video/x-msvideo", "video"],
  ["video/avi", "video"],
  ["video/mpeg", "video"],
  ["video/x-matroska", "video"],
  ["audio/webm", "audio"],
  ["audio/mpeg", "audio"],
  ["audio/mp3", "audio"],
  ["audio/wav", "audio"],
  ["audio/x-wav", "audio"],
  ["audio/ogg", "audio"],
  ["audio/mp4", "audio"],
  ["audio/x-m4a", "audio"],
  ["audio/aac", "audio"],
  ["audio/flac", "audio"],
  ["audio/x-flac", "audio"],
]);

const EXTENSION_TO_ASSET_TYPE = new Map([
  ["jpg", "image"],
  ["jpeg", "image"],
  ["png", "image"],
  ["webp", "image"],
  ["gif", "image"],
  ["bmp", "image"],
  ["heic", "image"],
  ["heif", "image"],
  ["avif", "image"],
  ["mp4", "video"],
  ["webm", "video"],
  ["mov", "video"],
  ["m4v", "video"],
  ["avi", "video"],
  ["mpeg", "video"],
  ["mpg", "video"],
  ["mkv", "video"],
  ["mp3", "audio"],
  ["wav", "audio"],
  ["m4a", "audio"],
  ["ogg", "audio"],
  ["aac", "audio"],
  ["flac", "audio"],
]);

export const getCanvasAssetType = (file) => {
  const mimeType = String(file?.type || "").toLowerCase();
  if (MIME_TO_ASSET_TYPE.has(mimeType)) return MIME_TO_ASSET_TYPE.get(mimeType);

  const fileName = String(file?.name || "").toLowerCase();
  const extension = fileName.includes(".") ? fileName.split(".").pop() : "";
  return EXTENSION_TO_ASSET_TYPE.get(extension) || null;
};

export const createCanvasAssetUploadConfig = (file, idempotencyKey) => {
  const type = getCanvasAssetType(file);
  if (!type) throw new Error("Unsupported canvas asset type");

  const key = String(idempotencyKey || "").trim();
  if (!key) throw new Error("Canvas asset upload idempotency key is required");

  return {
    type,
    headers: { "X-Idempotency-Key": key },
  };
};

const parseUploadedAsset = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const objectKeyToProxyUrl = (objectKey) => {
  const normalized = String(objectKey || "").trim().replace(/^\/+/, "");
  if (!normalized) return "";
  return `/oss-proxy/${normalized.split("/").map(encodeURIComponent).join("/")}`;
};

const resolveAssetSource = (asset, type, objectKey) => {
  const common = asset.src
    || asset.url
    || asset.asset_url
    || asset.media_url
    || asset.content;
  if (common) return String(common).trim();
  if (type === "video") {
    return String(asset.video_url || asset.preview_video_url || objectKeyToProxyUrl(objectKey)).trim();
  }
  if (type === "audio") {
    return String(asset.audio_url || objectKeyToProxyUrl(objectKey)).trim();
  }
  return String(
    asset.image_url
      || asset.reference_preview_url
      || asset.preview_image_url
      || asset.thumbnail_url
      || asset.poster
      || objectKeyToProxyUrl(objectKey),
  ).trim();
};

export const normalizeCanvasAssetUploadResponse = (value) => {
  let asset = parseUploadedAsset(value);
  if (asset?.data && typeof asset.data === "object" && !asset.type && !asset.media_type) {
    asset = asset.data;
  }
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) return null;

  const type = String(asset.type || asset.media_type || asset.mediaType || "").trim().toLowerCase();
  const objectKey = String(asset.objectKey || asset.object_key || "").trim();
  const src = resolveAssetSource(asset, type, objectKey);

  if (!["image", "video", "audio"].includes(type) || !src) return null;
  return {
    ...asset,
    type,
    src,
    url: asset.url || src,
    objectKey,
    resourceId: String(asset.resourceId || asset.resource_id || "").trim(),
    source: asset.source || "canvas_upload",
  };
};

export const createCanvasAssetElement = ({
  asset: rawAsset,
  elementId,
  center = { x: 0, y: 0 },
  position = null,
  fallbackTitle = "Generated Asset",
} = {}) => {
  const rawWasObject = Boolean(rawAsset && typeof rawAsset === "object" && !Array.isArray(rawAsset));
  const asset = normalizeCanvasAssetUploadResponse(rawAsset);
  const id = String(elementId || "").trim();
  if (!asset || !id) return null;
  const source = rawWasObject ? String(rawAsset.source || "").trim() : asset.source;

  const dimensions = asset.type === "video"
    ? { width: 360, height: 202 }
    : asset.type === "audio"
      ? { width: 320, height: 120 }
      : { width: 320, height: 320 };
  const hasPosition = Number.isFinite(Number(position?.x)) && Number.isFinite(Number(position?.y));
  const x = hasPosition ? Number(position.x) : Number(center?.x || 0) - dimensions.width / 2;
  const y = hasPosition ? Number(position.y) : Number(center?.y || 0) - dimensions.height / 2;
  const poster = asset.type === "video"
    ? String(asset.poster || asset.preview_image_url || asset.thumbnail_url || asset.reference_preview_url || "").trim()
    : "";

  return {
    id,
    type: asset.type,
    x,
    y,
    ...dimensions,
    title: asset.scene_name || asset.title || fallbackTitle,
    creationId: source === "canvas_upload" ? "" : asset.id,
    src: asset.src,
    poster,
    source,
    objectKey: asset.objectKey || "",
    resourceId: asset.resourceId || "",
  };
};

export const uploadCanvasAsset = async ({ client, file, idempotencyKey }) => {
  if (!client || typeof client.post !== "function") {
    throw new Error("Canvas asset upload client is required");
  }

  const config = createCanvasAssetUploadConfig(file, idempotencyKey);
  const formData = new FormData();
  formData.append("asset", file);
  formData.append("type", config.type);

  const response = await client.post("/api/canvases/assets", formData, {
    headers: config.headers,
  });
  const uploadedAsset = normalizeCanvasAssetUploadResponse(response?.data?.data);
  if (!uploadedAsset) throw new Error("Invalid canvas asset upload response");
  return uploadedAsset;
};

export const getCanvasDropPoint = ({
  clientX,
  clientY,
  rect,
  viewport,
  elementWidth,
  elementHeight,
}) => {
  const safeScale = Number(viewport?.scale) > 0 ? Number(viewport.scale) : 1;
  const localX = Number(clientX) - Number(rect?.left || 0);
  const localY = Number(clientY) - Number(rect?.top || 0);
  const worldX = (localX - Number(viewport?.x || 0)) / safeScale;
  const worldY = (localY - Number(viewport?.y || 0)) / safeScale;

  return {
    x: worldX - Number(elementWidth || 0) / 2,
    y: worldY - Number(elementHeight || 0) / 2,
  };
};
