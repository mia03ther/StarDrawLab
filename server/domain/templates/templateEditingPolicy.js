import { createHash } from "node:crypto";

const fail = (message, code = "INVALID_TEMPLATE") => {
  throw Object.assign(new Error(message), { status: 400, code });
};
const own = (object, key) => Object.hasOwn(object || {}, key);
const text = (value, label, max, required = false) => {
  if (value != null && typeof value !== "string") fail(`${label} must be text`);
  const result = String(value ?? "").trim();
  if ((required && !result) || result.length > max) fail(`${label} is invalid`);
  return result;
};
export const templateBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).toLowerCase())) return false;
  return fallback;
};
const integer = (value, fallback, max = 100000) => {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || Math.abs(number) > max) fail("Template ordering is invalid");
  return number;
};

export const isTemplateAdministrator = (actor) => ["admin", "root"].includes(actor?.role);
export const isAdministratorEditableTemplate = (row) => Boolean(row && (row.owner_user_id == null || row.visibility === "public" || (row.visibility === "private" && row.approval_status === "pending" && row.publication_requested_at)));
export const isAdministratorHiddenTemplate = (row) => row?.approval_status === "rejected";
export const userTemplatePublication = (existing, requestedActive) => ({
  visibility: existing ? existing.visibility : "public",
  approvalStatus: existing ? existing.approval_status : "approved",
  isActive: isAdministratorHiddenTemplate(existing) ? false : templateBoolean(requestedActive, existing?.is_active ?? true),
});
export const templateManagementRow = (row, actor) => ({
  ...row,
  is_owner: row?.owner_user_id != null && String(row.owner_user_id) === String(actor?.userId),
  can_edit: (row?.owner_user_id != null && String(row.owner_user_id) === String(actor?.userId))
    || (isTemplateAdministrator(actor) && isAdministratorEditableTemplate(row)),
  can_manage_marketplace: isTemplateAdministrator(actor) && isAdministratorEditableTemplate(row),
});

export const normalizeTemplateEdit = (body = {}, existing = null, { userId = "platform", idempotencyKey = "" } = {}) => {
  const get = (key) => own(body, key) ? body[key] : existing?.[key];
  const outputType = text(get("output_type") || "image", "output_type", 20, true).toLowerCase();
  if (!["image", "video"].includes(outputType)) fail("output_type must be image or video");
  const sameOutput = existing?.output_type === outputType;
  const requestedKey = text(body.scene_key, "scene_key", 120);
  const sceneKey = existing?.scene_key || requestedKey || `template_${createHash("sha256").update(`${userId}\0${idempotencyKey}`).digest("hex").slice(0, 24)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(sceneKey) || (!existing && sceneKey.startsWith("freeform_"))) fail("scene_key is invalid");
  const tagsInput = get("tags");
  const tags = [...new Set((Array.isArray(tagsInput) ? tagsInput : String(tagsInput ?? "").split(/[,，]/))
    .map((tag) => text(tag, "tag", 40)).filter(Boolean))];
  if (tags.length > 20) fail("A template may have at most 20 tags");
  const secondsInput = own(body, "default_seconds") ? body.default_seconds : sameOutput ? existing?.default_seconds : null;
  const seconds = outputType === "video" && secondsInput != null && secondsInput !== "" ? Number(secondsInput) : null;
  if (seconds != null && (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 180)) fail("default_seconds is invalid");
  const size = text(own(body, "default_size") ? body.default_size : sameOutput ? existing?.default_size : "", "default_size", 40);
  if (size && !/^(?:\d{2,5}x\d{2,5}|\d{1,2}:\d{1,2})$/.test(size)) fail("default_size is invalid");
  return {
    sceneKey, sceneName: text(get("scene_name"), "scene_name", 160, true), outputType,
    defaultModel: text(own(body, "default_model") ? body.default_model : sameOutput ? existing?.default_model : "", "default_model", 100),
    defaultSeconds: seconds, defaultSize: size,
    systemPrompt: text(get("system_prompt"), "system_prompt", 20000, true),
    previewTitle: text(get("preview_title"), "preview_title", 160),
    previewDescription: text(get("preview_description"), "preview_description", 2000),
    starterPrompt: text(get("starter_prompt"), "starter_prompt", 4000),
    placeholderText: text(get("placeholder_text"), "placeholder_text", 500),
    requiresReference: templateBoolean(get("requires_reference"), Boolean(existing?.requires_reference)), tags,
    displayOrder: integer(get("display_order"), existing?.display_order ?? 0),
    featuredOrder: integer(get("featured_order"), existing?.featured_order ?? 0),
    isFeatured: templateBoolean(get("is_featured"), Boolean(existing?.is_featured)),
    isActive: templateBoolean(get("is_active"), existing?.is_active ?? true),
    requiredMembershipTier: text(get("required_membership_tier") || "free", "required_membership_tier", 20),
  };
};

export const applyTemplateModelDefaults = (draft, model = {}) => {
  const capabilities = model.capabilities || {};
  const durations = capabilities.durations || capabilities.duration_seconds || capabilities.supported_seconds || [];
  const seconds = (Array.isArray(durations) ? durations : String(durations).split(",")).map(Number).find((n) => Number.isSafeInteger(n) && n > 0 && n <= 180);
  const resolutions = Array.isArray(model.resolutions) ? model.resolutions : [];
  const size = resolutions.find((value) => typeof value === "string" && /^\d{2,5}x\d{2,5}$/.test(value));
  return {
    ...draft,
    defaultSize: draft.defaultSize || size || (draft.outputType === "video" ? "1280x720" : "1024x1024"),
    defaultSeconds: draft.outputType === "video" ? draft.defaultSeconds ?? seconds ?? 8 : null,
  };
};
