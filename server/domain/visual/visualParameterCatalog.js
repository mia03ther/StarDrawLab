// User and Agent prompts are expected to be multiline. Keep the printable
// whitespace characters used by textareas (tab, LF and CR), while rejecting
// the remaining C0 controls and DEL before prompts reach providers or logs.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PARAMETER_KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
const OPTION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{1,79}$/;

export const VISUAL_PARAMETER_GROUPS = Object.freeze([
  { parameter_key: "style", display_name: "画风", display_name_en: "Style", display_order: 10 },
  { parameter_key: "camera", display_name: "摄影效果", display_name_en: "Camera", display_order: 20 },
  { parameter_key: "lighting", display_name: "灯光", display_name_en: "Lighting", display_order: 30 },
  { parameter_key: "background", display_name: "背景", display_name_en: "Background", display_order: 40 },
  { parameter_key: "shot", display_name: "景别", display_name_en: "Shot", display_order: 50 },
  { parameter_key: "motion", display_name: "运镜", display_name_en: "Motion", display_order: 60 },
]);

const GROUP_ORDER = new Map(VISUAL_PARAMETER_GROUPS.map((group) => [group.parameter_key, group.display_order]));

const DEFAULT_OPTIONS = [
  ["style", "commercial", "商业广告", "Commercial", "clean commercial product photography, premium brand language"],
  ["style", "cinematic", "电影感", "Cinematic", "cinematic visual language, controlled contrast, rich depth and intentional composition"],
  ["style", "photorealistic", "写实摄影", "Photorealistic", "photorealistic detail, physically plausible materials and natural proportions"],
  ["style", "3d-render", "3D 渲染", "3D Render", "high-end 3D render, polished materials, precise product geometry"],
  ["style", "illustration", "插画", "Illustration", "refined editorial illustration, expressive shapes and controlled color palette"],
  ["camera", "static", "稳定定机", "Static", "locked-off camera, stable framing"],
  ["camera", "dolly-in", "缓慢推进", "Dolly In", "slow dolly-in, gradual emphasis on the subject"],
  ["camera", "orbit", "环绕主体", "Orbit", "smooth orbit around the subject, consistent perspective"],
  ["camera", "handheld", "轻微手持", "Handheld", "subtle handheld camera texture, restrained and intentional movement"],
  ["camera", "overhead", "俯拍", "Overhead", "overhead camera angle with clear top-down composition"],
  ["lighting", "softbox", "柔光箱", "Softbox", "large softbox lighting, gentle shadows and clean highlights"],
  ["lighting", "golden-hour", "黄金时刻", "Golden Hour", "warm golden-hour light, long soft shadows and a natural glow"],
  ["lighting", "high-key", "高调明亮", "High Key", "bright high-key lighting, soft low-contrast shadows"],
  ["lighting", "low-key", "低调戏剧光", "Low Key", "low-key cinematic lighting, controlled deep shadows and focused highlights"],
  ["lighting", "neon", "霓虹光", "Neon", "stylized neon rim light with controlled colored reflections"],
  ["background", "studio", "纯净影棚", "Studio", "minimal seamless studio background, no distracting objects"],
  ["background", "gradient", "渐变背景", "Gradient", "clean premium gradient background matched to the subject"],
  ["background", "marble", "大理石台面", "Marble", "elegant marble surface with a refined commercial setting"],
  ["background", "nature", "自然环境", "Nature", "natural outdoor environment with believable atmospheric depth"],
  ["background", "urban", "城市环境", "Urban", "modern urban environment with readable architectural depth"],
  ["shot", "macro", "微距", "Macro", "macro close-up, fine material texture and shallow depth of field"],
  ["shot", "close-up", "近景", "Close Up", "close-up framing that keeps the subject prominent and detailed"],
  ["shot", "medium", "中景", "Medium", "medium shot with balanced subject and environment"],
  ["shot", "wide", "广角全景", "Wide", "wide establishing shot with clear spatial relationships"],
  ["shot", "detail", "细节特写", "Detail", "focused detail shot highlighting the most important feature"],
  ["motion", "none", "无运镜", "None", "no camera movement, maintain a stable visual focus"],
  ["motion", "pan", "水平摇镜", "Pan", "slow controlled horizontal pan"],
  ["motion", "push-in", "推进", "Push In", "smooth forward push-in toward the subject"],
  ["motion", "orbit-reveal", "环绕揭示", "Orbit Reveal", "smooth orbit that reveals the subject progressively"],
  ["motion", "pull-back", "拉远", "Pull Back", "smooth pull-back to reveal context and scale"],
];

export const DEFAULT_VISUAL_PARAMETER_OPTIONS = Object.freeze(DEFAULT_OPTIONS.map(([parameterKey, optionKey, displayName, displayNameEn, promptFragment], index) => Object.freeze({
  id: `fallback-${parameterKey}-${optionKey}`,
  parameter_key: parameterKey,
  option_key: optionKey,
  display_name: displayName,
  display_name_en: displayNameEn,
  description: null,
  prompt_fragment: promptFragment,
  negative_prompt_fragment: "text, watermark, logo, unintended extra objects",
  supported_output_types: ["image", "video"],
  model_keys: [],
  display_order: index + 1,
  is_active: true,
  metadata: { source: "safe_fallback" },
}))); 

const cleanText = (value, maxLength) => {
  const text = String(value ?? "").trim();
  if (text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text)) {
    throw Object.assign(new Error("Visual parameter text is invalid"), { status: 400, code: "INVALID_VISUAL_PARAMETER_TEXT" });
  }
  return text;
};

const normalizeStringArray = (value, maxItems, maxItemLength) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, maxItemLength)).filter(Boolean))].slice(0, maxItems);
};

export const normalizeVisualParameterOption = (body = {}, existing = null) => {
  const parameterKey = cleanText(body.parameter_key ?? existing?.parameter_key, 40).toLowerCase();
  const optionKey = cleanText(body.option_key ?? existing?.option_key, 80).toLowerCase();
  if (!PARAMETER_KEY_PATTERN.test(parameterKey) || !GROUP_ORDER.has(parameterKey)) {
    throw Object.assign(new Error("Unknown visual parameter group"), { status: 400, code: "INVALID_VISUAL_PARAMETER_GROUP" });
  }
  if (!OPTION_KEY_PATTERN.test(optionKey)) {
    throw Object.assign(new Error("Invalid visual parameter option key"), { status: 400, code: "INVALID_VISUAL_PARAMETER_OPTION" });
  }
  const displayName = cleanText(body.display_name ?? existing?.display_name, 160);
  if (!displayName) {
    throw Object.assign(new Error("display_name is required"), { status: 400, code: "VISUAL_PARAMETER_NAME_REQUIRED" });
  }
  const supportedOutputTypes = normalizeStringArray(body.supported_output_types ?? existing?.supported_output_types ?? ["image", "video"], 2, 20)
    .filter((value) => ["image", "video"].includes(value));
  if (!supportedOutputTypes.length) {
    throw Object.assign(new Error("At least one supported output type is required"), { status: 400, code: "VISUAL_PARAMETER_OUTPUT_TYPE_REQUIRED" });
  }
  const modelKeys = normalizeStringArray(body.model_keys ?? existing?.model_keys, 30, 100).map((value) => value.toLowerCase());
  const displayOrderValue = body.display_order ?? existing?.display_order ?? 0;
  const displayOrder = Number(displayOrderValue);
  if (!Number.isSafeInteger(displayOrder) || displayOrder < 0 || displayOrder > 100000) {
    throw Object.assign(new Error("display_order must be a non-negative integer"), { status: 400, code: "INVALID_VISUAL_PARAMETER_ORDER" });
  }
  return {
    parameterKey,
    optionKey,
    displayName,
    displayNameEn: cleanText(body.display_name_en ?? existing?.display_name_en, 160) || displayName,
    description: cleanText(body.description ?? existing?.description, 1000) || null,
    promptFragment: cleanText(body.prompt_fragment ?? existing?.prompt_fragment, 1200),
    negativePromptFragment: cleanText(body.negative_prompt_fragment ?? existing?.negative_prompt_fragment, 1200) || null,
    supportedOutputTypes,
    modelKeys,
    displayOrder,
    isActive: typeof body.is_active === "boolean" ? body.is_active : Boolean(existing?.is_active),
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : (existing?.metadata || {}),
  };
};

export const groupVisualParameterRows = (rows = []) => VISUAL_PARAMETER_GROUPS.map((group) => ({
  ...group,
  options: rows
    .filter((row) => row.parameter_key === group.parameter_key)
    .sort((left, right) => Number(left.display_order || 0) - Number(right.display_order || 0) || String(left.option_key).localeCompare(String(right.option_key))),
}));

export const normalizeVisualParameterSelection = (selection = {}) => {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw Object.assign(new Error("visual_parameters must be an object"), { status: 400, code: "INVALID_VISUAL_PARAMETER_SELECTION" });
  }
  const result = {};
  for (const group of VISUAL_PARAMETER_GROUPS) {
    const value = selection[group.parameter_key];
    if (value == null || value === "") continue;
    const optionKey = cleanText(value, 80).toLowerCase();
    if (!OPTION_KEY_PATTERN.test(optionKey)) {
      throw Object.assign(new Error("Invalid visual parameter selection"), { status: 400, code: "INVALID_VISUAL_PARAMETER_SELECTION" });
    }
    result[group.parameter_key] = optionKey;
  }
  return result;
};

export const compileVisualPrompt = ({ basePrompt = "", selection = {}, rows = [], outputType = null, modelKey = null }) => {
  const normalizedBase = cleanText(basePrompt, 9000);
  const normalizedSelection = normalizeVisualParameterSelection(selection);
  const applicableRows = rows.filter((row) => Boolean(row.is_active)
    && (!outputType || (Array.isArray(row.supported_output_types) && row.supported_output_types.includes(outputType)))
    && (!modelKey || !Array.isArray(row.model_keys) || row.model_keys.length === 0 || row.model_keys.includes(modelKey)));
  const byKey = new Map(applicableRows.map((row) => [`${row.parameter_key}:${row.option_key}`, row]));
  const selectedRows = Object.entries(normalizedSelection).map(([parameterKey, optionKey]) => {
    const row = byKey.get(`${parameterKey}:${optionKey}`);
    if (!row) {
      throw Object.assign(new Error(`Visual parameter option is unavailable: ${parameterKey}/${optionKey}`), { status: 400, code: "VISUAL_PARAMETER_UNAVAILABLE" });
    }
    return row;
  });
  const promptFragments = selectedRows.map((row) => row.prompt_fragment).filter(Boolean);
  const negativeFragments = [...new Set(selectedRows.map((row) => row.negative_prompt_fragment).filter(Boolean))];
  const prompt = [normalizedBase, ...promptFragments].filter(Boolean).join("\n\n");
  if (prompt.length > 9000) {
    throw Object.assign(new Error("Combined visual prompt is too long"), { status: 400, code: "VISUAL_PROMPT_TOO_LONG" });
  }
  return { prompt, negativePrompt: negativeFragments.join(", "), selections: normalizedSelection, selectedRows };
};
