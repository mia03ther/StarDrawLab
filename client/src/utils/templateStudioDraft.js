import { normalizeTemplate } from "./templateData.js";

export const TEMPLATE_POINTS = 18;
export const DEFAULT_TEMPLATE_TAGS = ["插画", "二次元", "电商", "海报", "贺卡", "头像", "手办", "视频"];

export const normalizeStudioTags = (value) => {
  const values = Array.isArray(value) ? value : String(value || "").split(/[,，、;；\n]/);
  return [...new Set(values.map((item) => String(item).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
};

export const createTemplateDraft = (id = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`) => ({
  id: null, scene_key: `user_${String(id).replace(/[^A-Za-z0-9_-]/g, "_")}`, scene_name: "", output_type: "image",
  target_provider: "", default_model: "", default_seconds: "", default_size: "", system_prompt: "",
  display_order: 0, is_active: true, is_featured: false, featured_order: 0,
  preview_title: "", preview_description: "", starter_prompt: "", placeholder_text: "", requires_reference: false,
  tags: [], points_cost: TEMPLATE_POINTS, preview_image_url: "", preview_video_url: "",
});

export const toTemplateDraft = (template) => {
  const normalized = normalizeTemplate(template);
  return {
    ...createTemplateDraft(), ...normalized,
    original_scene_name: normalized.scene_name || "",
    default_seconds: normalized.default_seconds ?? "", default_size: normalized.default_size || "",
    tags: normalizeStudioTags(normalized.tags), points_cost: TEMPLATE_POINTS,
  };
};

export const changeTemplateOutputType = (draft, outputType) => {
  if (outputType === draft.output_type) return draft;
  return { ...draft, output_type: outputType, target_provider: "", default_model: "", default_seconds: "", default_size: "" };
};

export const buildTemplatePayload = (draft) => {
  const sceneName = String(draft.scene_name || "").trim();
  const prompt = String(draft.system_prompt || "").trim();
  if (!sceneName) throw Object.assign(new Error("Template name is required"), { field: "scene_name" });
  if (!prompt) throw Object.assign(new Error("Template prompt is required"), { field: "system_prompt" });
  const seconds = draft.default_seconds === "" || draft.default_seconds == null ? null : Number(draft.default_seconds);
  if (seconds !== null && (!Number.isSafeInteger(seconds) || seconds <= 0)) {
    throw Object.assign(new Error("Video duration must be a positive integer"), { field: "default_seconds" });
  }
  return {
    scene_key: String(draft.scene_key || "").trim(), scene_name: sceneName, output_type: draft.output_type,
    target_provider: String(draft.target_provider || "").trim(), default_model: String(draft.default_model || "").trim(),
    default_seconds: seconds, default_size: String(draft.default_size || "").trim(), system_prompt: prompt,
    display_order: Number(draft.display_order || 0), is_active: Boolean(draft.is_active), is_featured: Boolean(draft.is_featured),
    featured_order: Number(draft.featured_order || 0),
    preview_title: draft.original_scene_name && sceneName !== draft.original_scene_name ? sceneName : String(draft.preview_title || sceneName).trim(),
    preview_description: String(draft.preview_description || "").trim(), starter_prompt: String(draft.starter_prompt || ""),
    placeholder_text: String(draft.placeholder_text || ""), requires_reference: Boolean(draft.requires_reference),
    tags: normalizeStudioTags(draft.tags), points_cost: TEMPLATE_POINTS,
  };
};

export const mergeStudioTagChoices = (...groups) => [...new Set(groups
  .flatMap((group) => Array.isArray(group) ? group : normalizeStudioTags(group))
  .map((tag) => String(tag).trim().slice(0, 40)).filter(Boolean))].slice(0, 80);

// Local keyword suggestions are editable and never make a model request or spend points.
export const suggestTemplateTags = ({ scene_name = "", system_prompt = "", output_type = "image" } = {}) => {
  const text = `${scene_name} ${system_prompt}`;
  const rules = [
    ["二次元", /二次元|动漫|anime|manga|卡通/i], ["电商", /电商|商品|产品|ecommerce|product/i],
    ["贺卡", /贺卡|祝福|greeting|card/i], ["海报", /海报|poster/i], ["头像", /头像|avatar|profile portrait/i],
    ["手办", /手办|立绘|figurine|figure|钥匙扣|亚克力/i], ["像素", /像素|pixel/i], ["写实", /写实|摄影|photograph|realistic/i],
    ["插画", /插画|绘画|illustration|painting/i], ["场景", /场景|风景|landscape|scenery/i],
  ];
  const tags = rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
  if (output_type === "video") tags.push("视频");
  return [...new Set(tags)].slice(0, 6);
};
