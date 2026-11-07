export const REFERENCE_DRAG_MIME = "application/x-stardraw-reference";

const INTERNAL_MEDIA_LINK_PATTERN = /\[([^\]]+)\]\(\s*(?:https?:\/\/[^\s/]+)?\/(?:oss-proxy|api\/proxy\/oss)\/[^)]+\)/gi;
const INTERNAL_MEDIA_URL_PATTERN = /https?:\/\/[^\s"'<>，。！？；：、）》】]*\/(?:oss-proxy|api\/proxy\/oss)\/[^\s"'<>，。！？；：、）》】]+|\/(?:oss-proxy|api\/proxy\/oss)\/[^\s"'<>，。！？；：、）》】]+/gi;
const INTERNAL_MEDIA_LABEL_PATTERN = /(?:^|\/)(?:oss-proxy|api\/proxy\/oss)\/|(?:^|\/)(?:image|video)_\d+_[a-z0-9-]+\.[a-z0-9]+$/i;
const INTERNAL_MEDIA_FILENAME_PATTERN = /(?<![a-z0-9_-])(?:image|video)_\d+_[a-z0-9-]+\.[a-z0-9]+/gi;

// Storage object keys are implementation details. The Agent result card owns
// the actual preview, so assistant text should keep only the human label.
export const cleanAgentReply = (value) => String(value || "")
  .replace(INTERNAL_MEDIA_LINK_PATTERN, "$1")
  .replace(INTERNAL_MEDIA_URL_PATTERN, "")
  .replace(INTERNAL_MEDIA_FILENAME_PATTERN, "")
  .trim();

const asText = (value) => String(value || "").trim();
const humanMediaTitle = (value) => {
  const title = asText(value);
  return title && !INTERNAL_MEDIA_LABEL_PATTERN.test(title) ? title : "参考图";
};

export const getAgentReferenceTitle = (value) => humanMediaTitle(value);

export const getFullMediaUrl = (item) => asText(item?.content)
  || asText(item?.previewUrl)
  || asText(item?.thumbnail_url)
  || asText(item?.preview_image_url);

// Community cards should use the provider's preview object whenever one exists.
// Full media remains available for the modal and for Agent references.
export const getGridMediaUrl = (item) => asText(item?.thumbnail_url)
  || asText(item?.preview_image_url)
  || getFullMediaUrl(item);

export const getReferencePreviewUrl = (item) => item?.type === "video"
  ? asText(item?.thumbnail_url) || asText(item?.preview_image_url) || asText(item?.content)
  : getFullMediaUrl(item);

export const createReferenceAsset = (item) => {
  const previewUrl = getReferencePreviewUrl(item);
  if (!previewUrl) return null;
  const rawId = asText(item?.id);
  const creationId = asText(item?.creationId || item?.creation_id)
    || (rawId && !rawId.startsWith("template-") ? rawId : "");
  const templateId = asText(item?.templateId || item?.template_id);
  const uploadId = asText(item?.uploadId || item?.upload_id || item?.resourceId || item?.resource_id);
  return {
    id: rawId || templateId || uploadId || previewUrl,
    title: humanMediaTitle(item?.title),
    previewUrl,
    creationId,
    templateId,
    ...(uploadId ? { uploadId } : {}),
  };
};

// Planning only needs to know that a usable reference is attached. Resource
// identifiers stay in the execution payload, where the server re-checks
// ownership before downloading any bytes.
export const getAgentReferenceContext = (items) => {
  const rawItems = Array.isArray(items) ? items : [items];
  const seen = new Set();
  return rawItems
    .map((item) => item?.previewUrl ? item : createReferenceAsset(item))
    .filter((reference) => {
      if (!reference?.previewUrl) return false;
      const identity = asText(reference.id) || asText(reference.uploadId) || asText(reference.creationId)
        || asText(reference.templateId) || asText(reference.previewUrl);
      if (!identity || seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, 4)
    .map((reference) => ({
      type: "image",
      title: asText(reference.title) || "参考图",
      source: reference.uploadId ? "upload" : reference.creationId ? "creation" : reference.templateId ? "template" : "attached",
    }));
};

export const serializeReferenceDragPayload = (item) => {
  const reference = createReferenceAsset(item);
  return reference ? JSON.stringify(reference) : "";
};

export const parseReferenceDragPayload = (value) => {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed?.previewUrl ? createReferenceAsset(parsed) : null;
  } catch {
    return null;
  }
};
