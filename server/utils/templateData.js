import { getTemplatePriceFields } from "../domain/pricing/templatePricingPolicy.js";

export const normalizeTemplateTags = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item).trim()).filter(Boolean);
      }
    } catch (_) {}

    return trimmed
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.replace(/^"+|"+$/g, "").trim())
      .filter(Boolean);
  }

  return [];
};

export const normalizeTemplateRow = (row) => ({
  ...row,
  version: Number.isSafeInteger(Number(row?.version)) && Number(row.version) > 0 ? Number(row.version) : 1,
  tags: normalizeTemplateTags(row?.tags),
  preview_image_url: typeof row?.preview_image_url === "string" ? row.preview_image_url.trim() : row?.preview_image_url || null,
  preview_video_url: typeof row?.preview_video_url === "string" ? row.preview_video_url.trim() : row?.preview_video_url || null,
  preview_title: typeof row?.preview_title === "string" ? row.preview_title.trim() : row?.preview_title || null,
  preview_description: typeof row?.preview_description === "string" ? row.preview_description.trim() : row?.preview_description || null,
  starter_prompt: typeof row?.starter_prompt === "string" ? row.starter_prompt.trim() : row?.starter_prompt || null,
  placeholder_text: typeof row?.placeholder_text === "string" ? row.placeholder_text.trim() : row?.placeholder_text || null,
  requires_reference: Boolean(row?.requires_reference),
  is_featured: Boolean(row?.is_featured),
  ...getTemplatePriceFields(row),
});
