const MAX_TEXT_LENGTH = 4000;
const MAX_PROMPT_LENGTH = 4000;
const MAX_ELEMENTS = 200;
const MAX_CANVAS_COORD = 1_000_000_000;
const MAX_ELEMENT_SIZE = 200_000;
const MAX_MEDIA_URL_LENGTH = 2048;

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const normalizeAngle = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  let normalized = ((numeric % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
};

const normalizeHexColor = (value, fallback) => {
  const color = String(value || "").trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : fallback;
};

const normalizeMediaUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw || raw.length > MAX_MEDIA_URL_LENGTH) return "";

  // A protocol-relative URL starts with // and must not be mistaken for an
  // application-owned path. Relative paths are intentionally restricted to
  // absolute-path references so javascript:, data: and filesystem URLs never
  // survive canvas persistence.
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      return "";
    }
    return raw;
  } catch {
    return "";
  }
};

const normalizeObjectKey = (value) => {
  const key = String(value || "").trim();
  if (!key || key.length > 255) return "";
  if (key.startsWith("/") || key.includes("\\") || /[\u0000-\u001f\u007f]/.test(key)) return "";
  if (/(^|\/)\.\.?($|\/)/.test(key) || /%(?:2f|5c)/i.test(key)) return "";
  return key;
};

const normalizeSource = (value) => {
  const source = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_.:-]{1,40}$/.test(source) ? source : "";
};

const parseCanvasStateValue = (value) => {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value : {};
};

const normalizeViewport = (value) => ({
  x: clamp(value?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
  y: clamp(value?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
  scale: clamp(value?.scale, 0.05, 10, 1),
});

const safeIdentifier = (value, fallback, max = 80) => String(value || fallback).trim().slice(0, max);
const safeLabel = (value, max = 160) => String(value || "").trim().slice(0, max);
const safePrompt = (value, max = MAX_PROMPT_LENGTH) => String(value || "").slice(0, max);

const normalizeWorkflowConfig = (value) => {
  const budget = { remaining: 400 };
  const visit = (candidate, depth = 0) => {
    if (budget.remaining <= 0 || depth > 8) return null;
    budget.remaining -= 1;
    if (candidate == null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (typeof candidate === "string") return candidate.slice(0, MAX_PROMPT_LENGTH);
    if (Array.isArray(candidate)) return candidate.slice(0, 100).map((item) => visit(item, depth + 1));
    if (typeof candidate !== "object") return null;

    const entries = Object.entries(candidate).slice(0, 100)
      .filter(([key]) => key.length <= 120 && !["__proto__", "constructor", "prototype"].includes(key));
    return Object.fromEntries(entries.map(([key, item]) => [key, visit(item, depth + 1)]));
  };

  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return visit(value) || {};
};

const normalizeWorkflowState = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes.slice(0, MAX_ELEMENTS).map((node, index) => {
    const config = normalizeWorkflowConfig(node?.config);
    return {
      id: safeIdentifier(node?.id || node?.nodeKey || node?.node_key, `node_${index + 1}`),
      type: safeIdentifier(node?.type || node?.nodeType || node?.node_type, "noop", 80).toLowerCase(),
      x: clamp(node?.x ?? node?.position?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, index * 48),
      y: clamp(node?.y ?? node?.position?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, index * 48),
      label: safeLabel(node?.label || node?.title || config.title),
      title: safeLabel(node?.title || node?.label || config.title),
      prompt: safePrompt(node?.prompt ?? config.prompt, 4000),
      sceneKey: safeIdentifier(node?.sceneKey || node?.scene_key || config.sceneKey || config.scene_key, "", 120),
      model: safeIdentifier(node?.model || config.model, "", 100),
      tool: safeIdentifier(node?.tool || node?.toolKey || node?.tool_key || config.tool || config.toolKey, "", 160),
      size: safeIdentifier(node?.size || config.size, "", 40),
      pointsEstimate: Math.floor(clamp(
        node?.pointsEstimate ?? node?.points_estimate ?? node?.pointsCost ?? node?.points_cost ?? config.pointsEstimate,
        0,
        1_000_000,
        0,
      )),
      dependsOn: Array.isArray(node?.dependsOn || node?.depends_on || config.dependsOn)
        ? [...new Set((node.dependsOn || node.depends_on || config.dependsOn)
          .map((item) => safeIdentifier(item, ""))
          .filter(Boolean))].slice(0, MAX_ELEMENTS)
        : [],
      config,
    };
  }) : [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const normalizedNodes = nodes.map((node) => ({
    ...node,
    dependsOn: node.dependsOn.filter((dependency) => dependency !== node.id && nodeIds.has(dependency)),
  }));
  const edges = Array.isArray(source.edges) ? source.edges.slice(0, MAX_ELEMENTS * 2)
    .map((edge) => {
      const from = safeIdentifier(edge?.from || edge?.source, "");
      const to = safeIdentifier(edge?.to || edge?.target, "");
      return { id: safeIdentifier(edge?.id, `${from}->${to}`, 180), from, to };
    })
    .filter((edge) => edge.from && edge.to && edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to)) : [];
  return {
    version: Math.floor(clamp(source.version, 1, 1000, 1)),
    nodes: normalizedNodes,
    edges,
  };
};

const normalizeStoryboardState = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const shots = Array.isArray(source.shots) ? source.shots.slice(0, MAX_ELEMENTS).map((shot, index) => ({
    id: safeIdentifier(shot?.id, `shot_${index + 1}`),
    order: clamp(shot?.order, 0, MAX_ELEMENTS, index),
    title: safeLabel(shot?.title || shot?.name),
    prompt: safePrompt(shot?.prompt),
    description: safePrompt(shot?.description, 1000),
    notes: safePrompt(shot?.notes, 2000),
    duration: clamp(shot?.duration, 0, 3600, 0),
    camera: safeIdentifier(shot?.camera, "", 80),
    shotSize: safeIdentifier(shot?.shotSize || shot?.shot_size, "", 60),
    cameraMovement: safeIdentifier(shot?.cameraMovement || shot?.camera_movement, "", 80),
    cameraAngle: safeIdentifier(shot?.cameraAngle || shot?.camera_angle, "", 80),
    style: safeIdentifier(shot?.style, "", 120),
    lighting: safeIdentifier(shot?.lighting, "", 120),
    background: safeIdentifier(shot?.background, "", 120),
    assetId: safeIdentifier(shot?.assetId || shot?.asset_id, "", 80),
  })) : [];
  return { shots };
};

const normalizeTimelineState = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const tracks = Array.isArray(source.tracks) ? source.tracks.slice(0, 32).map((track, trackIndex) => ({
    id: safeIdentifier(track?.id, `track_${trackIndex + 1}`),
    type: ["video", "audio", "caption", "effect"].includes(String(track?.type || "").toLowerCase())
      ? String(track.type).toLowerCase() : "video",
    name: safeLabel(track?.name || track?.title),
    muted: Boolean(track?.muted),
    clips: Array.isArray(track?.clips) ? track.clips.slice(0, MAX_ELEMENTS).map((clip, clipIndex) => ({
      id: safeIdentifier(clip?.id, `clip_${trackIndex + 1}_${clipIndex + 1}`),
      assetId: safeIdentifier(clip?.assetId || clip?.asset_id, "", 80),
      start: clamp(clip?.start, 0, 86400, 0),
      duration: clamp(clip?.duration, 0, 86400, 0),
      sourceStart: clamp(clip?.sourceStart || clip?.source_start, 0, 86400, 0),
      sourceDuration: clamp(clip?.sourceDuration || clip?.source_duration, 0, 86400, 0),
      speed: clamp(clip?.speed, 0.1, 8, 1),
      volume: clamp(clip?.volume, 0, 2, 1),
      text: safePrompt(clip?.text, 2000),
      transition: safeIdentifier(clip?.transition, "", 80),
    })) : [],
  })) : [];
  return { fps: clamp(source.fps, 1, 120, 30), tracks };
};

const normalizeDirector3dState = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const vector = (candidate, fallback = 0) => ({
    x: clamp(candidate?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, fallback),
    y: clamp(candidate?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, fallback),
    z: clamp(candidate?.z, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, fallback),
  });
  const cameraSource = source.camera && typeof source.camera === "object" ? source.camera : {};
  return {
    enabled: Boolean(source.enabled),
    scene: safeIdentifier(source.scene, "", 120),
    camera: {
      position: vector(cameraSource.position),
      rotation: vector(cameraSource.rotation),
      focalLength: clamp(cameraSource.focalLength || cameraSource.focal_length, 1, 500, 50),
    },
    lighting: safeIdentifier(source.lighting, "", 120),
    environment: safeIdentifier(source.environment, "", 120),
  };
};

const normalizeCommonElementFields = (element, index, type, defaults) => ({
  id: String(element?.id || `${type}_${index + 1}`).slice(0, 80),
  type,
  x: clamp(element?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, index * 48),
  y: clamp(element?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, index * 48),
  width: clamp(element?.width, defaults.minWidth, MAX_ELEMENT_SIZE, defaults.width),
  height: clamp(element?.height, defaults.minHeight, MAX_ELEMENT_SIZE, defaults.height),
  rotation: normalizeAngle(element?.rotation),
  title: String(element?.title || "").slice(0, 120),
  locked: Boolean(element?.locked),
  groupId: String(element?.groupId || "").slice(0, 80),
});

const normalizeTextElement = (element, index) => ({
  ...normalizeCommonElementFields(element, index, "text", {
    minWidth: 180,
    minHeight: 120,
    width: 320,
    height: 220,
  }),
  text: String(element?.text || "").slice(0, MAX_TEXT_LENGTH),
  background: normalizeHexColor(element?.background, "#1c2026"),
  color: normalizeHexColor(element?.color, "#dfe2eb"),
  fontSize: clamp(element?.fontSize, 14, 48, 18),
  source: normalizeSource(element?.source),
});

const normalizeMediaElement = (element, index, type) => {
  const resolvedSrc = normalizeMediaUrl(
    element?.src
    || element?.content
    || element?.url
    || element?.preview_image_url
    || element?.thumbnail_url
    || element?.reference_preview_url
    || element?.poster,
  );
  const resolvedPoster = normalizeMediaUrl(
    element?.poster
    || element?.preview_image_url
    || element?.thumbnail_url
    || element?.reference_preview_url
    || (type === "image" ? resolvedSrc : ""),
  );

  return {
    ...normalizeCommonElementFields(element, index, type, {
      minWidth: 160,
      minHeight: 120,
      width: type === "video" ? 360 : 320,
      height: type === "audio" ? 120 : 320,
    }),
    src: resolvedSrc,
    poster: resolvedPoster,
    assetType: type,
    creationId: String(element?.creationId || element?.creation_id || "").slice(0, 80),
    resourceId: safeIdentifier(element?.resourceId || element?.resource_id, "", 80),
    source: normalizeSource(element?.source),
    workflowNodeKey: String(element?.workflowNodeKey || element?.workflow_node_key || "").trim().slice(0, 128),
    workflowRunId: String(element?.workflowRunId || element?.workflow_run_id || "").trim().slice(0, 80),
    canvasAnchorElementId: String(element?.canvasAnchorElementId || element?.canvas_anchor_element_id || "").trim().slice(0, 80),
    canvasAgentRunId: String(element?.canvasAgentRunId || element?.canvas_agent_run_id || "").trim().slice(0, 80),
    objectKey: normalizeObjectKey(element?.objectKey || element?.object_key),
    prompt: String(element?.prompt || "").slice(0, MAX_PROMPT_LENGTH),
  };
};

const normalizeElement = (element, index) => {
  const type = String(element?.type || "").trim().toLowerCase();
  if (type === "text") return normalizeTextElement(element, index);
  if (type === "video") return normalizeMediaElement(element, index, "video");
  if (type === "audio") return normalizeMediaElement(element, index, "audio");
  return normalizeMediaElement(element, index, "image");
};

export const normalizeCanvasState = (value) => {
  const parsed = parseCanvasStateValue(value);
  const elements = Array.isArray(parsed?.elements)
    ? parsed.elements.slice(0, MAX_ELEMENTS).map((element, index) => normalizeElement(element, index))
    : [];
  const groupCounts = new Map();

  elements.forEach((element) => {
    if (!element.groupId) return;
    groupCounts.set(element.groupId, (groupCounts.get(element.groupId) || 0) + 1);
  });

  const normalizedElements = elements.map((element) => {
    if (!element.groupId) return element;
    if ((groupCounts.get(element.groupId) || 0) > 1) return element;
    return { ...element, groupId: "" };
  });

  return {
    schemaVersion: 2,
    viewport: normalizeViewport(parsed?.viewport),
    elements: normalizedElements,
    background: { mode: "grid" },
    workflow: normalizeWorkflowState(parsed?.workflow),
    storyboard: normalizeStoryboardState(parsed?.storyboard),
    timeline: normalizeTimelineState(parsed?.timeline),
    director3d: normalizeDirector3dState(parsed?.director3d || parsed?.director_3d),
  };
};

const GENERATED_MEDIA_SOURCES = new Set([
  "canvas_agent_generation",
  "workflow_generation",
]);

const timestamp = (value) => {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const elementIdentityMatches = (first, second) => {
  const firstId = String(first?.id || "").trim();
  const secondId = String(second?.id || "").trim();
  if (firstId && secondId && firstId === secondId) return true;
  const firstCreationId = String(first?.creationId || first?.creation_id || "").trim();
  const secondCreationId = String(second?.creationId || second?.creation_id || "").trim();
  return Boolean(firstCreationId && secondCreationId && firstCreationId === secondCreationId);
};

/**
 * Preserve media written by an Agent/Worker after the browser's last loaded
 * canvas version. New clients send explicit deletion ids so intentional user
 * deletions still win; clients without a baseline are treated as stale.
 */
export const mergeConcurrentGeneratedCanvasMedia = ({
  currentState,
  incomingState,
  baseUpdatedAt,
  currentUpdatedAt,
  deletedElementIds = [],
} = {}) => {
  const current = normalizeCanvasState(currentState || {});
  const incoming = normalizeCanvasState(incomingState || {});
  const baseTime = timestamp(baseUpdatedAt);
  const currentTime = timestamp(currentUpdatedAt);
  const concurrent = baseTime == null || currentTime == null || currentTime > baseTime;
  if (!concurrent) return { state: incoming, concurrent: false, preservedElementIds: [] };

  const deleted = new Set((Array.isArray(deletedElementIds) ? deletedElementIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean));
  const preserved = current.elements.filter((element) => (
    GENERATED_MEDIA_SOURCES.has(String(element?.source || "").toLowerCase())
    && !deleted.has(String(element?.id || ""))
    && !incoming.elements.some((candidate) => elementIdentityMatches(element, candidate))
  ));
  if (!preserved.length) return { state: incoming, concurrent: true, preservedElementIds: [] };

  const state = normalizeCanvasState({
    ...incoming,
    elements: [...incoming.elements, ...preserved],
  });
  return {
    state,
    concurrent: true,
    preservedElementIds: preserved.map((element) => element.id),
  };
};
