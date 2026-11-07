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
    } catch {
      // Fall back to parsing a comma-separated legacy tag string.
    }

    return trimmed
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((item) => item.replace(/^"+|"+$/g, "").trim())
      .filter(Boolean);
  }

  return [];
};

export const normalizeTemplate = (template) => ({
  ...template,
  tags: normalizeTemplateTags(template?.tags),
  preview_image_url: typeof template?.preview_image_url === "string" ? template.preview_image_url.trim() : template?.preview_image_url || "",
  preview_video_url: typeof template?.preview_video_url === "string" ? template.preview_video_url.trim() : template?.preview_video_url || "",
  preview_title: typeof template?.preview_title === "string" ? template.preview_title.trim() : template?.preview_title || "",
  preview_description: typeof template?.preview_description === "string" ? template.preview_description.trim() : template?.preview_description || "",
  starter_prompt: typeof template?.starter_prompt === "string" ? template.starter_prompt.trim() : template?.starter_prompt || "",
  placeholder_text: typeof template?.placeholder_text === "string" ? template.placeholder_text.trim() : template?.placeholder_text || "",
  requires_reference: Boolean(template?.requires_reference),
  is_featured: Boolean(template?.is_featured),
  is_active: "is_active" in (template || {}) ? Boolean(template?.is_active) : true,
});

export const normalizeTemplates = (templates) =>
  Array.isArray(templates) ? templates.map(normalizeTemplate) : [];

export const isAnonymousTemplateAsset = (template) =>
  template?.visibility === "public" && template?.approval_status === "approved";
