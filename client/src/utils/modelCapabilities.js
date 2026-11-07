const IMAGE_SIZE_BY_RESOLUTION = {
  "1K": { width: 1024, height: 1024 },
  "2K": { width: 2048, height: 2048 },
  "4K": { width: 4096, height: 4096 },
};

const IMAGE_RATIOS = [
  ["1:1", 1, 1],
  ["9:16", 9, 16],
  ["16:9", 16, 9],
  ["21:9", 21, 9],
  ["4:3", 4, 3],
  ["3:4", 3, 4],
];

const IMAGE_RESOLUTION_OPTIONS = [
  ["1K", "1024x1024"], ["1K", "576x1024"], ["1K", "1024x576"], ["1K", "1024x439"], ["1K", "1024x768"], ["1K", "768x1024"],
  ["2K", "2048x2048"], ["2K", "1152x2048"], ["2K", "2048x1152"], ["2K", "2048x878"], ["2K", "2048x1536"], ["2K", "1536x2048"],
  ["4K", "4096x4096"], ["4K", "2304x4096"], ["4K", "4096x2304"], ["4K", "4096x1755"], ["4K", "4096x3072"], ["4K", "3072x4096"],
];

const VIDEO_RESOLUTION_OPTIONS = [
  ["720p", "720x1280"], ["720p", "1280x720"], ["720p", "1680x720"], ["720p", "960x720"], ["720p", "720x960"], ["720p", "720x720"],
  ["1080p", "1080x1920"], ["1080p", "1920x1080"], ["1080p", "2520x1080"], ["1080p", "1440x1080"], ["1080p", "1080x1440"], ["1080p", "1080x1080"],
  ["2K", "1440x2560"], ["2K", "2560x1440"], ["2K", "3360x1440"], ["2K", "1920x1440"], ["2K", "1440x1920"], ["2K", "1440x1440"],
  ["4K", "2160x3840"], ["4K", "3840x2160"], ["4K", "5040x2160"], ["4K", "2880x2160"], ["4K", "2160x2880"], ["4K", "2160x2160"],
];

const ratioLabels = {
  "1:1": ["1:1", "方图", "Square"],
  "9:16": ["9:16", "竖屏", "Portrait"],
  "16:9": ["16:9", "横屏", "Landscape"],
  "21:9": ["21:9", "超宽", "Ultrawide"],
  "4:3": ["4:3", "横屏", "Landscape"],
  "3:4": ["3:4", "竖屏", "Portrait"],
};

const normalizeToken = (value) => String(value ?? "")
  .trim()
  .replace(/[×*]/g, "x")
  .replace(/\s+/g, "")
  .toLowerCase();

const normalizeResolution = (value) => {
  const token = normalizeToken(value);
  if (!token) return "";
  if (/^\d+k$/.test(token)) return `${token.slice(0, -1)}K`;
  if (/^\d+p$/.test(token)) return token;
  if (token === "1k" || token === "2k" || token === "4k") return token.toUpperCase();
  return token;
};

export const normalizeAspectRatio = (value) => {
  const token = normalizeToken(value).replace("/", ":");
  if ({ square: "1:1", portrait: "9:16", landscape: "16:9", ultrawide: "21:9" }[token]) {
    return { square: "1:1", portrait: "9:16", landscape: "16:9", ultrawide: "21:9" }[token];
  }
  const match = token.match(/^(\d+):(\d+)$/);
  return match ? `${Number(match[1])}:${Number(match[2])}` : "";
};

const toList = (value) => {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string" || typeof item === "number");
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return toList(parsed);
  } catch {
    // Admin forms historically stored comma-separated capability values.
  }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
};

const firstNonEmptyList = (...values) => {
  for (const value of values) {
    const list = toList(value);
    if (list.length) return list;
  }
  return [];
};

const extractRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const value of [payload.data, payload.models, payload.items, payload.results]) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = extractRows(value);
      if (nested.length) return nested;
    }
  }
  return [];
};

export const normalizeModelCatalogResponse = (payload, fallbackModels = []) => {
  const rows = extractRows(payload);
  const source = rows.length ? rows : fallbackModels;
  return source.map((row) => {
    if (typeof row === "string") return { model_key: row, display_name: row, resolutions: [], aspect_ratios: [], capabilities: {} };
    const capabilities = row?.capabilities && typeof row.capabilities === "object" && !Array.isArray(row.capabilities)
      ? row.capabilities
      : {};
    return {
      ...row,
      model_key: String(row?.model_key ?? row?.modelKey ?? row?.id ?? row?.value ?? "").trim(),
      display_name: row?.display_name || row?.displayName || row?.name || row?.model_key || row?.modelKey || "",
      resolutions: firstNonEmptyList(row?.resolutions, row?.resolution, capabilities.resolutions, capabilities.resolution),
      aspect_ratios: firstNonEmptyList(row?.aspect_ratios, row?.aspectRatios, row?.aspect_ratio, capabilities.aspect_ratios, capabilities.aspectRatios, capabilities.aspect_ratio),
      capabilities,
    };
  }).filter((row) => row.model_key);
};

const inferRatio = (width, height) => {
  let best = "";
  let difference = Infinity;
  for (const [ratio, ratioWidth, ratioHeight] of IMAGE_RATIOS) {
    const nextDifference = Math.abs((width / height) - (ratioWidth / ratioHeight));
    if (nextDifference < difference) {
      best = ratio;
      difference = nextDifference;
    }
  }
  return best;
};

const makeOption = (resolution, value, ratio) => {
  const [label, subZh, subEn] = ratioLabels[ratio] || [ratio || value, "自定义", "Custom"];
  return { value, resolution, aspect_ratio: ratio, label: `${resolution} · ${label}`, subZh, subEn };
};

const catalogOptions = (outputType) => {
  const entries = outputType === "video" ? VIDEO_RESOLUTION_OPTIONS : IMAGE_RESOLUTION_OPTIONS;
  return entries.map(([resolution, value]) => {
    const [width, height] = value.split("x").map(Number);
    return makeOption(resolution, value, inferRatio(width, height));
  });
};

export const IMAGE_SIZE_OPTIONS = catalogOptions("image");
export const VIDEO_SIZE_OPTIONS = catalogOptions("video");
export const SAFE_IMAGE_SIZE_OPTIONS = IMAGE_SIZE_OPTIONS;
export const SAFE_VIDEO_SIZE_OPTIONS = VIDEO_SIZE_OPTIONS.filter((item) => item.resolution === "720p" && ["9:16", "16:9"].includes(item.aspect_ratio));

const matchesResolution = (option, resolutions) => {
  const normalized = resolutions.map(normalizeResolution);
  return normalized.includes(normalizeResolution(option.resolution)) || normalized.includes(normalizeToken(option.value));
};

export const getModelSizeOptions = ({ model, outputType, fallbackOptions } = {}) => {
  const safeFallback = fallbackOptions || (outputType === "video" ? SAFE_VIDEO_SIZE_OPTIONS : SAFE_IMAGE_SIZE_OPTIONS);
  const catalog = catalogOptions(outputType);
  if (!model) return safeFallback;
  const resolutions = toList(model.resolutions);
  const ratios = toList(model.aspect_ratios).map(normalizeAspectRatio).filter(Boolean);
  const directSizes = resolutions.map((value) => String(value).replace(/[×*]/g, "x").replace(/\s+/g, "").toLowerCase())
    .filter((value) => /^\d+x\d+$/.test(value));
  const hasResolutionDeclaration = resolutions.length > 0;
  const hasRatioDeclaration = ratios.length > 0;
  if (!hasResolutionDeclaration && !hasRatioDeclaration) return safeFallback;
  const candidates = [...catalog];
  directSizes.forEach((value) => {
    if (!candidates.some((item) => item.value.toLowerCase() === value)) {
      const [width, height] = value.split("x").map(Number);
      candidates.push(makeOption(value, value, inferRatio(width, height)));
    }
  });
  const result = candidates.filter((option) =>
    (!hasResolutionDeclaration || matchesResolution(option, resolutions))
    && (!hasRatioDeclaration || ratios.includes(option.aspect_ratio)),
  );
  return result.length ? result : safeFallback;
};

export const getModelByKey = (models, modelKey) => {
  const normalizedKey = String(modelKey || "").trim().toLowerCase();
  return (models || []).find((model) => String(model.model_key || "").trim().toLowerCase() === normalizedKey) || null;
};

export const modelSupportsReferenceImages = (model) =>
  model?.capabilities?.reference_images !== false;

export const resolveSupportedValue = (value, options, preferredValue = "") => {
  const values = (options || []).map((option) => typeof option === "string" ? option : option.value);
  return values.includes(value) ? value : values.includes(preferredValue) ? preferredValue : values[0] || "";
};

const numericCapabilityList = (...values) => values.flatMap((value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "number") return [value];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Legacy model capability fields may be comma-separated strings.
  }
  return value.split(",");
}).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0 && value <= 600);

const firstNumericCapabilityList = (...values) => {
  for (const value of values) {
    const parsed = numericCapabilityList(value);
    if (parsed.length) return parsed;
  }
  return [];
};

export const getModelDurationOptions = ({ model, fallbackSeconds, ...directModel } = {}, fallback = 8) => {
  const source = model || directModel;
  const capabilities = source?.capabilities && typeof source.capabilities === "object" ? source.capabilities : {};
  const declared = firstNumericCapabilityList(
    source?.durations,
    source?.duration_seconds,
    source?.durationSeconds,
    source?.supported_durations,
    source?.supported_seconds,
    source?.duration_options,
    source?.duration,
    source?.seconds,
    capabilities.durations,
    capabilities.duration_seconds,
    capabilities.durationSeconds,
    capabilities.supported_durations,
    capabilities.supported_seconds,
    capabilities.duration_options,
    capabilities.duration,
    capabilities.seconds,
  );
  const fallbackValue = numericCapabilityList(fallbackSeconds ?? fallback)[0] || fallback;
  return [...new Set(declared.length ? declared : [fallbackValue])];
};

export const resolveSupportedModel = (models, preferredValue = "", fallbackValue = "") => {
  const keys = (models || []).map((model) => model.model_key);
  return keys.includes(preferredValue) ? preferredValue : keys.includes(fallbackValue) ? fallbackValue : keys[0] || "";
};
