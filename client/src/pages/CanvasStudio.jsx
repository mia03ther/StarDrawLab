import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssAudio, OssBackground, OssImage, OssVideo } from "../components/OssMedia";
import StoryboardPanel from "../components/StoryboardPanel";
import TimelinePanel from "../components/TimelinePanel";
import VisualParameterPicker from "../components/VisualParameterPicker";
import Director3DPanel from "../components/Director3DPanel";
import CanvasAgentPanel from "../components/canvas/CanvasAgentPanel";
import CanvasIconButton from "../components/canvas/CanvasIconButton";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import IntegratedCanvasWorkflow from "../components/canvas/IntegratedCanvasWorkflow";
import CanvasHistoryDialog from "../components/canvas/CanvasHistoryDialog";
import AssetPreviewModal from "../components/AssetPreviewModal";
import { renderSingleVideoTrack } from "../utils/browserTimelineRenderer";
import { getStoryboardBoundElement, upsertStoryboardTimelineClip } from "../utils/storyboardWorkflow";
import { normalizeTemplate, normalizeTemplates } from "../utils/templateData";
import {
  getModelByKey,
  getModelSizeOptions,
  modelSupportsReferenceImages,
  normalizeModelCatalogResponse,
  resolveSupportedModel,
  resolveSupportedValue,
  SAFE_IMAGE_SIZE_OPTIONS,
  SAFE_VIDEO_SIZE_OPTIONS,
} from "../utils/modelCapabilities";
import {
  createCanvasAssetElement,
  getCanvasAssetType,
  getCanvasDropPoint,
  uploadCanvasAsset,
} from "../utils/canvasAssetUpload";
import {
  mergeGeneratedCanvasMediaFromServer,
  mergeWorkflowCanvasMediaElement,
} from "../utils/workflowCanvasResults";
import {
  activateCanvasVideoAudio,
  muteCanvasVideo,
} from "../utils/canvasVideoPlayback";

const DEFAULT_VIEWPORT = { x: 0, y: 0, scale: 1 };
const SNAP_DISTANCE = 12;
const MIN_VIEWPORT_SCALE = 0.05;
const MAX_VIEWPORT_SCALE = 10;
const MIN_TEXT_WIDTH = 180;
const MIN_TEXT_HEIGHT = 120;
const MIN_MEDIA_WIDTH = 160;
const MIN_MEDIA_HEIGHT = 120;
const MAX_CANVAS_COORD = 1000000000;
const MAX_ELEMENT_SIZE = 200000;
const FOCUS_SURFACE_WIDTH = 1600;
const FOCUS_SURFACE_HEIGHT = 960;
const FOCUS_SURFACE_X = -FOCUS_SURFACE_WIDTH / 2;
const FOCUS_SURFACE_Y = -FOCUS_SURFACE_HEIGHT / 2;
const RULER_SIZE = 28;
const MINIMAP_WIDTH = 220;
const MINIMAP_HEIGHT = 164;
const ROTATE_HANDLE_OFFSET = 44;
const AGENT_PANEL_MIN_WIDTH = 360;
const AGENT_PANEL_DEFAULT_WIDTH = 460;
const AGENT_PANEL_MAX_WIDTH = 760;
const AGENT_INPUT_MIN_HEIGHT = 52;
const AGENT_INPUT_MAX_HEIGHT = 180;
const MAX_AGENT_TEMPLATE_PAYLOAD = 48;
const AGENT_ACCESS_MODES = [
  { key: "ask_for_approval", zh: "每次询问", en: "Ask for approval" },
  { key: "approve_for_me", zh: "自动执行安全操作", en: "Approve for me" },
  { key: "full_access", zh: "完全访问", en: "Full Access" },
];
const AGENT_MODEL_LABEL = "GPT";
const LEGACY_CANVAS_AGENT_PANEL_ENABLED = false;
const waitForCanvasRetry = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const MIXED_CANVAS_ENABLED = import.meta.env.VITE_FEATURE_MIXED_CANVAS !== "false";
const STUDIO_MODES = [
  { key: "canvas", icon: "gesture", zh: "画布", en: "Canvas" },
  { key: "storyboard", icon: "view_carousel", zh: "分镜", en: "Storyboard" },
  { key: "timeline", icon: "movie", zh: "剪辑", en: "Edit" },
  { key: "director3d", icon: "deployed_code", zh: "3D 导演台", en: "3D Director" },
];
const VIEWPORT_ANIMATION_DURATION = 260;
const VIEWPORT_GESTURE_RESPONSE = 0.24;
const VIEWPORT_GESTURE_PAN_RESPONSE = 0.28;
const VIEWPORT_GESTURE_PINCH_RESPONSE = 0.34;
const VIEWPORT_GESTURE_PAN_RESPONSE_MAX = 0.38;
const VIEWPORT_GESTURE_PINCH_RESPONSE_MAX = 0.42;
const WHEEL_GESTURE_IDLE_MS = 144;
const WHEEL_ZOOM_SENSITIVITY = 0.00172;
const ZOOM_BADGE_SCRUB_SENSITIVITY = 0.0028;
const ZOOM_TOOL_CLICK_IN_FACTOR = 1.32;
const ZOOM_TOOL_CLICK_OUT_FACTOR = 0.76;
const ZOOM_TOOL_SCRUB_SENSITIVITY = 0.0034;
const GESTURE_INTENSITY_DEADZONE = 0.055;
const GESTURE_INPUT_EXPONENT = 0.9;
const WHEEL_ZOOM_DEADZONE = 1.4;
const WHEEL_PAN_DEADZONE = 0.9;
const WHEEL_ZOOM_DELTA_LIMIT = 88;
const WHEEL_PAN_DELTA_LIMIT = 132;
const MOUSE_WHEEL_ZOOM_DELTA = 38;
const MOUSE_WHEEL_MAX_CROSS_AXIS = 3;
const SCRUB_DEADZONE = 1.6;
const SCRUB_DELTA_LIMIT = 320;
const GESTURE_CENTER_MIX = 0.32;
const GESTURE_RESPONSE_MIX = 0.42;
const AUTO_PAN_EDGE_SIZE = 96;
const AUTO_PAN_MAX_SPEED = 24;
const PAN_INERTIA_DECAY = 0.9;
const PAN_INERTIA_MIN_START_VELOCITY = 0.06;
const PAN_INERTIA_STOP_VELOCITY = 0.012;
const PAN_INERTIA_MAX_VELOCITY = 2.6;
const PAN_VELOCITY_RESPONSE = 0.36;
const RESIZE_HANDLES = [
  { key: "nw", cursor: "nwse-resize" },
  { key: "n", cursor: "ns-resize" },
  { key: "ne", cursor: "nesw-resize" },
  { key: "e", cursor: "ew-resize" },
  { key: "se", cursor: "nwse-resize" },
  { key: "s", cursor: "ns-resize" },
  { key: "sw", cursor: "nesw-resize" },
  { key: "w", cursor: "ew-resize" },
];

const FALLBACK_CANVAS_AI_IMAGE_MODELS = [{ model_key: "nano-banana-2", display_name: "Nano Banana 2" }];
const normalizeCanvasImageModel = (value) => String(value || "").trim() === "image2" ? "gpt-image-2" : String(value || "").trim();

const FALLBACK_CANVAS_VIDEO_MODELS = [{ model_key: "veo-3-1", display_name: "Veo 3.1" }];

const getAgentPanelMaxWidth = () => {
  if (typeof window === "undefined") return AGENT_PANEL_MAX_WIDTH;
  return Math.min(
    AGENT_PANEL_MAX_WIDTH,
    Math.max(AGENT_PANEL_MIN_WIDTH, window.innerWidth - 24),
  );
};

const normalizeStarDrawTheme = (value) => (value === "day" ? "day" : "night");

const readStarDrawTheme = () => {
  if (typeof window === "undefined") return "night";
  return normalizeStarDrawTheme(window.localStorage.getItem("stardraw_theme"));
};

const writeStarDrawTheme = (nextTheme) => {
  if (typeof window === "undefined") return;
  const normalized = normalizeStarDrawTheme(nextTheme);
  window.localStorage.setItem("stardraw_theme", normalized);
  document.documentElement.dataset.stardrawTheme = normalized;
  window.dispatchEvent(new CustomEvent("stardraw:theme-change", { detail: { theme: normalized } }));
};

const CANVAS_THEME_TOKENS = {
  day: {
    page: "#fbfaf8",
    panel: "rgba(255,255,255,0.92)",
    panelSolid: "#ffffff",
    panelStrong: "rgba(255,255,255,0.96)",
    panelTranslucent: "rgba(255,255,255,0.7)",
    inspectorCard: "rgba(255,255,255,0.74)",
    inspectorInput: "rgba(255,255,255,0.92)",
    soft: "#f6f5f2",
    soft2: "#eeece7",
    line: "#e7e3dc",
    line2: "#d5d0c8",
    text: "#171717",
    muted: "#60646c",
    faint: "#8b8f97",
    accent: "#202124",
    accentText: "#ffffff",
    blue: "#2f80ed",
    blueSoft: "rgba(47,128,237,0.09)",
    blueLine: "rgba(47,128,237,0.2)",
    gold: "#111827",
    goldSoft: "rgba(17,24,39,0.07)",
    goldLine: "rgba(217,119,6,0.16)",
    danger: "#dc2626",
    dangerSoft: "rgba(220,38,38,0.09)",
    dangerLine: "rgba(220,38,38,0.16)",
    canvasGrid: "rgba(17,24,39,0.045)",
    shadow: "0 20px 60px rgba(17,24,39,0.08)",
    softShadow: "0 10px 30px rgba(17,24,39,0.055)",
    stageShadow: "0 34px 80px rgba(17,24,39,0.12)",
    pageGlow: "radial-gradient(circle at 34% 24%, rgba(47,128,237,0.035) 0%, rgba(47,128,237,0) 32%)",
    pageGlowWarm: "radial-gradient(circle at 62% 72%, rgba(17,24,39,0.025) 0%, rgba(17,24,39,0) 34%)",
    pageGlowSoft: "linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(251,250,248,1) 100%)",
    topFade: "linear-gradient(180deg, rgba(251,250,248,0.92) 0%, rgba(251,250,248,0.55) 58%, rgba(251,250,248,0) 100%)",
    inputInset: "inset 0 1px 0 rgba(255,255,255,0.6)",
    elementBg: "#ffffff",
    mediaTitleGradient: "linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.92) 100%)",
    handleBg: "#ffffff",
    selectionLabelBg: "rgba(255,255,255,0.92)",
    hudBg: "rgba(255,255,255,0.9)",
    rulerBg: "rgba(255,255,255,0.84)",
    rulerCornerBg: "rgba(255,255,255,0.92)",
    aiPanel: "rgba(255,255,255,0.96)",
    aiPanelShadow: "-18px 0 50px rgba(17,24,39,0.06)",
  },
  night: {
    page: "#101317",
    panel: "rgba(24,27,32,0.92)",
    panelSolid: "#171a20",
    panelStrong: "rgba(24,27,32,0.96)",
    panelTranslucent: "rgba(24,27,32,0.74)",
    inspectorCard: "rgba(24,27,32,0.78)",
    inspectorInput: "rgba(14,17,22,0.92)",
    soft: "#20242b",
    soft2: "#252a32",
    line: "rgba(255,255,255,0.11)",
    line2: "rgba(255,255,255,0.18)",
    text: "#f4f4f5",
    muted: "#b2b7c2",
    faint: "#7f8794",
    accent: "#f4f4f5",
    accentText: "#101317",
    blue: "#7db4ff",
    blueSoft: "rgba(125,180,255,0.12)",
    blueLine: "rgba(125,180,255,0.24)",
    gold: "#f3ca61",
    goldSoft: "rgba(243,202,97,0.12)",
    goldLine: "rgba(243,202,97,0.22)",
    danger: "#ff9b92",
    dangerSoft: "rgba(255,155,146,0.12)",
    dangerLine: "rgba(255,155,146,0.22)",
    canvasGrid: "rgba(255,255,255,0.055)",
    shadow: "0 24px 70px rgba(0,0,0,0.38)",
    softShadow: "0 12px 34px rgba(0,0,0,0.28)",
    stageShadow: "0 34px 80px rgba(0,0,0,0.42)",
    pageGlow: "radial-gradient(circle at 34% 24%, rgba(125,180,255,0.08) 0%, rgba(125,180,255,0) 34%)",
    pageGlowWarm: "radial-gradient(circle at 62% 72%, rgba(243,202,97,0.06) 0%, rgba(243,202,97,0) 36%)",
    pageGlowSoft: "linear-gradient(180deg, rgba(16,19,23,0.98) 0%, rgba(10,12,16,1) 100%)",
    topFade: "linear-gradient(180deg, rgba(16,19,23,0.94) 0%, rgba(16,19,23,0.56) 58%, rgba(16,19,23,0) 100%)",
    inputInset: "inset 0 1px 0 rgba(255,255,255,0.05)",
    elementBg: "#11151b",
    mediaTitleGradient: "linear-gradient(180deg, rgba(10,12,16,0) 0%, rgba(10,12,16,0.88) 100%)",
    handleBg: "#f8fafc",
    selectionLabelBg: "rgba(24,27,32,0.94)",
    hudBg: "rgba(24,27,32,0.9)",
    rulerBg: "rgba(24,27,32,0.84)",
    rulerCornerBg: "rgba(24,27,32,0.92)",
    aiPanel: "rgba(16,19,23,0.96)",
    aiPanelShadow: "-18px 0 58px rgba(0,0,0,0.38)",
  },
};

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
};

const getAgentMentionTrigger = (value, caretPosition) => {
  const text = String(value || "");
  const caret = Math.min(text.length, Math.max(0, Number(caretPosition) || 0));
  const beforeCaret = text.slice(0, caret);
  const match = beforeCaret.match(/(^|\s)@([^\s@]{0,40})$/u);
  if (!match) return null;

  return {
    start: beforeCaret.lastIndexOf("@"),
    end: caret,
    query: match[2] || "",
  };
};

const clipAgentTemplateText = (value, max = 180) => String(value || "").trim().slice(0, max);

const compactAgentTemplate = (scene) => {
  if (!scene?.scene_key) return null;

  return {
    scene_key: clipAgentTemplateText(scene.scene_key, 80),
    scene_name: clipAgentTemplateText(scene.scene_name || scene.preview_title || scene.scene_key, 120),
    preview_description: clipAgentTemplateText(scene.preview_description, 220),
    starter_prompt: clipAgentTemplateText(scene.starter_prompt, 360),
    tags: Array.isArray(scene.tags)
      ? scene.tags.slice(0, 8).map((tag) => clipAgentTemplateText(tag, 40)).filter(Boolean)
      : [],
    requires_reference: Boolean(scene.requires_reference),
    is_featured: Boolean(scene.is_featured),
    default_model: clipAgentTemplateText(scene.default_model, 80),
    default_size: clipAgentTemplateText(scene.default_size, 40),
  };
};

const compactAgentTemplates = (scenes, type = "image") => {
  if (!Array.isArray(scenes)) return [];

  const rows = scenes.map(compactAgentTemplate).filter(Boolean);
  if (rows.length <= MAX_AGENT_TEMPLATE_PAYLOAD) return rows;

  const prioritized = [];
  const pushUnique = (scene) => {
    if (!scene?.scene_key || prioritized.some((item) => item.scene_key === scene.scene_key)) return;
    prioritized.push(scene);
  };

  rows.filter((scene) => isFreeformScene(scene, type)).forEach(pushUnique);
  rows.filter((scene) => scene.is_featured && !isFreeformScene(scene, type)).forEach(pushUnique);
  rows.forEach(pushUnique);

  return prioritized.slice(0, MAX_AGENT_TEMPLATE_PAYLOAD);
};

const isFreeformScene = (scene, type = "image") => {
  if (!scene) return false;
  const expectedKey = type === "video" ? "freeform_video" : "freeform_image";
  const text = `${scene.scene_key || ""} ${scene.scene_name || ""}`.toLowerCase();
  return scene.scene_key === expectedKey
    || /freeform|自由/.test(text)
    || (Array.isArray(scene.tags)
      && scene.tags.some((tag) => /freeform|自由/i.test(String(tag || ""))));
};

const findFreeformScene = (scenes, type = "image") => (
  Array.isArray(scenes)
    ? scenes.find((scene) => isFreeformScene(scene, type)) || null
    : null
);

const mix = (from, to, progress) => from + (to - from) * progress;

const shapeGestureDelta = (delta, options = {}) => {
  const magnitude = Math.abs(Number(delta) || 0);
  const deadzone = Math.max(0, Number(options.deadzone) || 0);
  if (magnitude <= deadzone) return 0;

  const exponent = Number(options.exponent) || 1;
  const limit = Math.max(0, Number(options.limit) || 0);
  const normalized = Math.max(0, magnitude - deadzone);
  const shaped = normalized ** exponent;
  const signed = Math.sign(delta || 0) * shaped;
  if (!limit) return signed;
  return clamp(signed, -limit, limit, 0);
};

const createElementId = (prefix) => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
};

const toRadians = (degrees) => degrees * (Math.PI / 180);

const normalizeAngle = (degrees) => {
  const numeric = Number(degrees) || 0;
  let normalized = ((numeric % 360) + 360) % 360;
  if (normalized > 180) normalized -= 360;
  return normalized;
};

const getElementRotation = (element) => normalizeAngle(element?.rotation || 0);

const rotatePoint = (point, center, angle) => {
  const radians = toRadians(angle);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
};

const getElementAxisAlignedBounds = (element) => {
  const x = Number(element?.x || 0);
  const y = Number(element?.y || 0);
  const width = Math.max(1, Number(element?.width || 0));
  const height = Math.max(1, Number(element?.height || 0));
  const rotation = getElementRotation(element);

  if (!rotation) {
    return {
      minX: x,
      minY: y,
      maxX: x + width,
      maxY: y + height,
    };
  }

  const center = { x: x + width / 2, y: y + height / 2 };
  const corners = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ].map((corner) => rotatePoint(corner, center, rotation));

  return corners.reduce((acc, corner) => ({
    minX: Math.min(acc.minX, corner.x),
    minY: Math.min(acc.minY, corner.y),
    maxX: Math.max(acc.maxX, corner.x),
    maxY: Math.max(acc.maxY, corner.y),
  }), {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
};

const getGroupedSelectionIds = (elementId, elements) => {
  const target = elements.find((item) => item.id === elementId);
  if (!target) return [];
  if (!target.groupId) return [elementId];
  return elements.filter((item) => item.groupId === target.groupId).map((item) => item.id);
};

const expandGroupedSelectionIds = (elementIds, elements) => {
  const nextIds = new Set();
  elementIds.forEach((elementId) => {
    getGroupedSelectionIds(elementId, elements).forEach((groupedId) => {
      nextIds.add(groupedId);
    });
  });
  return Array.from(nextIds);
};

const reorderElementSet = (items, elementIds, direction) => {
  if (!Array.isArray(elementIds) || elementIds.length === 0) return items;

  const selectedSet = new Set(elementIds);
  if (selectedSet.size === 1) {
    const [elementId] = elementIds;
    const index = items.findIndex((item) => item.id === elementId);
    if (index === -1) return items;

    const next = [...items];
    const [target] = next.splice(index, 1);

    if (direction === "front") next.push(target);
    else if (direction === "back") next.unshift(target);
    else if (direction === "forward") next.splice(Math.min(next.length, index + 1), 0, target);
    else if (direction === "backward") next.splice(Math.max(0, index - 1), 0, target);
    else next.splice(index, 0, target);

    return next;
  }

  const selectedItems = items.filter((item) => selectedSet.has(item.id));
  const unselectedItems = items.filter((item) => !selectedSet.has(item.id));

  if (direction === "front" || direction === "forward") {
    return [...unselectedItems, ...selectedItems];
  }

  if (direction === "back" || direction === "backward") {
    return [...selectedItems, ...unselectedItems];
  }

  return items;
};

const EMPTY_PROJECT_MODEL = Object.freeze({
  schemaVersion: 2,
  background: { mode: "grid" },
  workflow: { nodes: [], edges: [] },
  storyboard: { shots: [] },
  timeline: { fps: 30, tracks: [] },
  director3d: {
    enabled: false,
    scene: "",
    camera: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      focalLength: 50,
    },
    lighting: "",
    environment: "",
  },
});

const normalizeCanvasState = (state) => ({
  viewport: {
    x: clamp(state?.viewport?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
    y: clamp(state?.viewport?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, 0),
    scale: clamp(state?.viewport?.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, 1),
  },
  elements: Array.isArray(state?.elements) ? state.elements : [],
  projectModel: {
    schemaVersion: Number(state?.schemaVersion) || EMPTY_PROJECT_MODEL.schemaVersion,
    background: state?.background && typeof state.background === "object"
      ? state.background : EMPTY_PROJECT_MODEL.background,
    workflow: state?.workflow && typeof state.workflow === "object"
      ? state.workflow : EMPTY_PROJECT_MODEL.workflow,
    storyboard: state?.storyboard && typeof state.storyboard === "object"
      ? state.storyboard : EMPTY_PROJECT_MODEL.storyboard,
    timeline: state?.timeline && typeof state.timeline === "object"
      ? state.timeline : EMPTY_PROJECT_MODEL.timeline,
    director3d: state?.director3d && typeof state.director3d === "object"
      ? state.director3d : EMPTY_PROJECT_MODEL.director3d,
  },
});

const getElementMinSize = (element) => ({
  width: element?.type === "text" ? MIN_TEXT_WIDTH : MIN_MEDIA_WIDTH,
  height: element?.type === "text" ? MIN_TEXT_HEIGHT : MIN_MEDIA_HEIGHT,
});

const getFixedScreenValue = (screenPixels, viewportScale) =>
  screenPixels / Math.max(MIN_VIEWPORT_SCALE, Number(viewportScale) || 1);

const getResizeHandleStyle = (handleKey, viewportScale, screenSize = 14) => {
  const size = getFixedScreenValue(screenSize, viewportScale);
  const half = size / 2;
  const edgeStyle = {
    width: size,
    height: size,
    borderWidth: getFixedScreenValue(2, viewportScale),
    boxShadow: `0 0 0 ${getFixedScreenValue(3, viewportScale)}px rgba(37,99,235,0.18)`,
  };

  const positions = {
    nw: { left: -half, top: -half },
    n: { left: "50%", top: -half, marginLeft: -half },
    ne: { right: -half, top: -half },
    e: { right: -half, top: "50%", marginTop: -half },
    se: { right: -half, bottom: -half },
    s: { left: "50%", bottom: -half, marginLeft: -half },
    sw: { left: -half, bottom: -half },
    w: { left: -half, top: "50%", marginTop: -half },
  };

  return {
    ...edgeStyle,
    ...(positions[handleKey] || positions.se),
  };
};

const getCanvasBounds = (elements = [], options = {}) => {
  const {
    includeSurface = false,
    padding = 0,
  } = options;

  const seed = includeSurface
    ? {
        minX: FOCUS_SURFACE_X,
        minY: FOCUS_SURFACE_Y,
        maxX: FOCUS_SURFACE_X + FOCUS_SURFACE_WIDTH,
        maxY: FOCUS_SURFACE_Y + FOCUS_SURFACE_HEIGHT,
      }
    : {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      };

  const bounds = elements.reduce((acc, item) => ({
    ...(() => {
      const itemBounds = getElementAxisAlignedBounds(item);
      return {
        minX: Math.min(acc.minX, itemBounds.minX),
        minY: Math.min(acc.minY, itemBounds.minY),
        maxX: Math.max(acc.maxX, itemBounds.maxX),
        maxY: Math.max(acc.maxY, itemBounds.maxY),
      };
    })(),
  }), seed);

  if (!Number.isFinite(bounds.minX)) {
    return {
      minX: FOCUS_SURFACE_X - padding,
      minY: FOCUS_SURFACE_Y - padding,
      maxX: FOCUS_SURFACE_X + FOCUS_SURFACE_WIDTH + padding,
      maxY: FOCUS_SURFACE_Y + FOCUS_SURFACE_HEIGHT + padding,
    };
  }

  return {
    minX: bounds.minX - padding,
    minY: bounds.minY - padding,
    maxX: bounds.maxX + padding,
    maxY: bounds.maxY + padding,
  };
};

const getBoundsFromElements = (items = []) => {
  if (!Array.isArray(items) || items.length === 0) return null;

  return items.reduce((acc, item) => {
    const itemBounds = getElementAxisAlignedBounds(item);
    return {
      minX: Math.min(acc.minX, itemBounds.minX),
      minY: Math.min(acc.minY, itemBounds.minY),
      maxX: Math.max(acc.maxX, itemBounds.maxX),
      maxY: Math.max(acc.maxY, itemBounds.maxY),
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
};

const getRulerStep = (scale) => {
  const steps = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  return steps.find((step) => step * scale >= 56) || steps[steps.length - 1];
};

const getImageAssetUrl = (item) =>
  item.src || item.content || item.url || item.reference_preview_url || item.preview_image_url || item.thumbnail_url || item.poster || "";

const getVideoPosterUrl = (item) =>
  item.poster || item.preview_image_url || item.thumbnail_url || item.reference_preview_url || "";

const getVideoAssetUrl = (item) =>
  item.src || item.preview_video_url || item.content || "";

const getAudioAssetUrl = (item) =>
  item.src || item.audio_url || item.content || item.url || "";

const getImageExtensionFromMime = (mimeType = "") => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  return "jpg";
};

const getAssetExtensionFromMime = (mimeType = "", fallback = "jpg") => {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized.includes("mp4")) return "mp4";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("quicktime")) return "mov";
  if (normalized.includes("png")) return "png";
  if (normalized.includes("webp")) return "webp";
  if (normalized.includes("gif")) return "gif";
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  if (normalized.includes("audio/mp4")) return "m4a";
  if (normalized.includes("jpeg") || normalized.includes("jpg")) return "jpg";
  return fallback;
};

const getFetchableAssetUrl = (url) => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) return raw;
  try {
    const parsed = new URL(raw);
    if (typeof window !== "undefined" && parsed.origin === window.location.origin) {
      return `${parsed.pathname}${parsed.search}`;
    }
    if (parsed.pathname.startsWith("/oss-proxy/") || parsed.pathname.startsWith("/api/proxy/")) {
      return `${parsed.pathname}${parsed.search}`;
    }
  } catch {
    return raw;
  }
  return raw;
};

const fetchCanvasImageAsFile = async (url, index = 0, resolvePrivateUrl) => {
  const authorizedUrl = await resolvePrivateUrl(url);
  const response = await fetch(getFetchableAssetUrl(authorizedUrl), { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Failed to load reference image (${response.status})`);
  }

  const blob = await response.blob();
  const type = blob.type || response.headers.get("content-type") || "image/jpeg";
  return new File(
    [blob],
    `canvas-reference-${index + 1}.${getImageExtensionFromMime(type)}`,
    { type },
  );
};

const parseCanvasImageSize = (size = "1024x1024") => {
  const [, rawWidth, rawHeight] = String(size).match(/^(\d+)x(\d+)$/) || [];
  const width = Number(rawWidth) || 1024;
  const height = Number(rawHeight) || 1024;
  const maxSide = 380;
  const scale = maxSide / Math.max(width, height);
  return {
    width: Math.max(180, Math.round(width * scale)),
    height: Math.max(140, Math.round(height * scale)),
  };
};

const canUseAsset = (item) => {
  if (!item) return false;
  if (item.source === "canvas_upload") {
    if (item.type === "video") return Boolean(getVideoAssetUrl(item));
    if (item.type === "audio") return Boolean(getAudioAssetUrl(item));
    return Boolean(getImageAssetUrl(item));
  }
  if (item.status !== "completed") return false;
  if (item.expires_at && new Date(item.expires_at) < new Date()) return false;
  if (item.type === "video") return Boolean(getVideoAssetUrl(item));
  if (item.type === "audio") return Boolean(getAudioAssetUrl(item));
  return Boolean(getImageAssetUrl(item));
};

const isDownloadableCanvasMedia = (item) =>
  Boolean(item && ["image", "video", "audio"].includes(item.type) && (
    item.creationId ||
    (item.type === "video" ? getVideoAssetUrl(item) : item.type === "audio" ? getAudioAssetUrl(item) : getImageAssetUrl(item))
  ));

const createDownload = (url, filename) => {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const loadImage = (src) => new Promise((resolve, reject) => {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.onload = () => resolve(image);
  image.onerror = reject;
  image.src = src;
});

const drawRoundedRect = (ctx, x, y, width, height, radius) => {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.arcTo(x + width, y, x + width, y + height, safeRadius);
  ctx.arcTo(x + width, y + height, x, y + height, safeRadius);
  ctx.arcTo(x, y + height, x, y, safeRadius);
  ctx.arcTo(x, y, x + width, y, safeRadius);
  ctx.closePath();
};

const wrapText = (ctx, text, maxWidth) => {
  const lines = [];
  const rawLines = String(text || "").split("\n");

  rawLines.forEach((rawLine) => {
    if (!rawLine) {
      lines.push("");
      return;
    }

    let current = "";
    rawLine.split("").forEach((char) => {
      const next = `${current}${char}`;
      if (ctx.measureText(next).width > maxWidth && current) {
        lines.push(current);
        current = char;
      } else {
        current = next;
      }
    });

    if (current) lines.push(current);
  });

  return lines;
};

const getTouchDistance = (firstTouch, secondTouch) => {
  const deltaX = secondTouch.clientX - firstTouch.clientX;
  const deltaY = secondTouch.clientY - firstTouch.clientY;
  return Math.hypot(deltaX, deltaY);
};

const getTouchCenter = (firstTouch, secondTouch) => ({
  clientX: (firstTouch.clientX + secondTouch.clientX) / 2,
  clientY: (firstTouch.clientY + secondTouch.clientY) / 2,
});

const getWheelDeltaScale = (deltaMode, pageSize = 720) => {
  if (deltaMode === 1) return 16;
  if (deltaMode === 2) return Math.max(320, pageSize);
  return 1;
};

const buildAxisGuides = (element, axis, guideValue, compareElement) => {
  if (axis === "x") {
    const top = Math.min(element.y, compareElement.y);
    const bottom = Math.max(element.y + element.height, compareElement.y + compareElement.height);
    return [{ axis: "x", value: guideValue, start: top, end: bottom }];
  }

  const left = Math.min(element.x, compareElement.x);
  const right = Math.max(element.x + element.width, compareElement.x + compareElement.width);
  return [{ axis: "y", value: guideValue, start: left, end: right }];
};

const getSnapResult = ({ elementId, x, y, width, height, elements }) => {
  const current = { x, y, width, height };
  const others = elements.filter((item) => item.id !== elementId);
  const guides = [];

  let nextX = x;
  let nextY = y;

  const currentXPoints = [
    { key: "left", value: x },
    { key: "center", value: x + width / 2 },
    { key: "right", value: x + width },
  ];
  const currentYPoints = [
    { key: "top", value: y },
    { key: "middle", value: y + height / 2 },
    { key: "bottom", value: y + height },
  ];

  let bestX = null;
  let bestY = null;

  others.forEach((other) => {
    const otherXPoints = [
      { value: other.x },
      { value: other.x + other.width / 2 },
      { value: other.x + other.width },
    ];
    const otherYPoints = [
      { value: other.y },
      { value: other.y + other.height / 2 },
      { value: other.y + other.height },
    ];

    currentXPoints.forEach((point) => {
      otherXPoints.forEach((target) => {
        const distance = Math.abs(point.value - target.value);
        if (distance > SNAP_DISTANCE) return;
        if (!bestX || distance < bestX.distance) {
          bestX = {
            distance,
            nextValue: target.value - (point.value - x),
            guideValue: target.value,
            compareElement: other,
          };
        }
      });
    });

    currentYPoints.forEach((point) => {
      otherYPoints.forEach((target) => {
        const distance = Math.abs(point.value - target.value);
        if (distance > SNAP_DISTANCE) return;
        if (!bestY || distance < bestY.distance) {
          bestY = {
            distance,
            nextValue: target.value - (point.value - y),
            guideValue: target.value,
            compareElement: other,
          };
        }
      });
    });
  });

  if (bestX) {
    nextX = bestX.nextValue;
    guides.push(...buildAxisGuides(
      { ...current, x: nextX, y: nextY },
      "x",
      bestX.guideValue,
      bestX.compareElement,
    ));
  }

  if (bestY) {
    nextY = bestY.nextValue;
    guides.push(...buildAxisGuides(
      { ...current, x: nextX, y: nextY },
      "y",
      bestY.guideValue,
      bestY.compareElement,
    ));
  }

  return { x: nextX, y: nextY, guides };
};

const getResizeSnapResult = ({ elementId, x, y, width, height, elements, direction, minWidth, minHeight }) => {
  const others = elements.filter((item) => item.id !== elementId);
  const right = x + width;
  const bottom = y + height;

  let nextX = x;
  let nextY = y;
  let nextWidth = width;
  let nextHeight = height;
  const guides = [];
  let bestX = null;
  let bestY = null;

  others.forEach((other) => {
    [other.x, other.x + other.width / 2, other.x + other.width].forEach((value) => {
      const movingEdge = direction.includes("w") ? x : right;
      const distance = Math.abs(movingEdge - value);
      if (distance > SNAP_DISTANCE) return;
      if (!bestX || distance < bestX.distance) {
        if (direction.includes("w")) {
          const snappedWidth = right - value;
          if (snappedWidth < minWidth) return;
          bestX = {
            distance,
            nextX: value,
            nextWidth: snappedWidth,
            guideValue: value,
            compareElement: other,
          };
        } else {
          const snappedWidth = value - x;
          if (snappedWidth < minWidth) return;
          bestX = {
            distance,
            nextX: x,
            nextWidth: snappedWidth,
            guideValue: value,
            compareElement: other,
          };
        }
      }
    });

    [other.y, other.y + other.height / 2, other.y + other.height].forEach((value) => {
      const movingEdge = direction.includes("n") ? y : bottom;
      const distance = Math.abs(movingEdge - value);
      if (distance > SNAP_DISTANCE) return;
      if (!bestY || distance < bestY.distance) {
        if (direction.includes("n")) {
          const snappedHeight = bottom - value;
          if (snappedHeight < minHeight) return;
          bestY = {
            distance,
            nextY: value,
            nextHeight: snappedHeight,
            guideValue: value,
            compareElement: other,
          };
        } else {
          const snappedHeight = value - y;
          if (snappedHeight < minHeight) return;
          bestY = {
            distance,
            nextY: y,
            nextHeight: snappedHeight,
            guideValue: value,
            compareElement: other,
          };
        }
      }
    });
  });

  if (bestX) {
    nextX = bestX.nextX;
    nextWidth = bestX.nextWidth;
    guides.push(...buildAxisGuides(
      { x: nextX, y: nextY, width: nextWidth, height: nextHeight },
      "x",
      bestX.guideValue,
      bestX.compareElement,
    ));
  }

  if (bestY) {
    nextY = bestY.nextY;
    nextHeight = bestY.nextHeight;
    guides.push(...buildAxisGuides(
      { x: nextX, y: nextY, width: nextWidth, height: nextHeight },
      "y",
      bestY.guideValue,
      bestY.compareElement,
    ));
  }

  return { x: nextX, y: nextY, width: nextWidth, height: nextHeight, guides };
};

const CanvasStudio = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { t, isZh } = useLanguage();
  const pageRef = useRef(null);
  const boardRef = useRef(null);
  const interactionRef = useRef(null);
  const gestureZoomRef = useRef(null);
  const touchGestureRef = useRef(null);
  const viewportAnimationRef = useRef(null);
  const viewportGestureFrameRef = useRef(null);
  const viewportGestureTargetRef = useRef(null);
  const viewportGestureResponseRef = useRef(VIEWPORT_GESTURE_RESPONSE);
  const autoPanFrameRef = useRef(null);
  const autoPanPointerRef = useRef(null);
  const panInertiaFrameRef = useRef(null);
  const wheelGestureRef = useRef({ mode: "", lastTs: 0, anchorX: null, anchorY: null, response: null });
  const wheelFrameRef = useRef(null);
  const wheelPendingRef = useRef(null);
  const saveTimerRef = useRef(null);
  const canvasUpdatedAtRef = useRef("");
  const canvasBaselineElementIdsRef = useRef(new Set());
  const hudTimerRef = useRef(null);
  const zoomPulseTimerRef = useRef(null);
  const suspendAutosaveRef = useRef(true);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const elementsRef = useRef([]);
  const marqueeRef = useRef(null);
  const clipboardRef = useRef(null);
  const assetInputRef = useRef(null);
  const agentInputRef = useRef(null);
  const agentMessagesEndRef = useRef(null);
  const agentMentionsRef = useRef([]);
  const agentRunMentionsRef = useRef([]);
  const elementVideoRefs = useRef({});
  const spacePanRef = useRef(false);
  const handToolRef = useRef(false);
  const handToolPinnedRef = useRef(false);
  const zoomToolRef = useRef(false);
  const zoomToolPinnedRef = useRef(false);
  const zoomBadgeDragRef = useRef(null);
  const timelineRenderAbortRef = useRef(null);
  const agentConversationHydratedRef = useRef(false);
  const agentConversationSaveErrorRef = useRef(false);

  const [canvases, setCanvases] = useState([]);
  const [activeCanvasId, setActiveCanvasId] = useState("");
  const [canvasTitle, setCanvasTitle] = useState("");
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [elements, setElements] = useState([]);
  const [audibleVideoId, setAudibleVideoId] = useState("");
  const [canvasPreviewElement, setCanvasPreviewElement] = useState(null);
  const [projectModel, setProjectModel] = useState(EMPTY_PROJECT_MODEL);
  const [workspaceMode, setWorkspaceMode] = useState("canvas");
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [assets, setAssets] = useState([]);
  const [assetDragActive, setAssetDragActive] = useState(false);
  const [layerQuery, setLayerQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingCanvas, setLoadingCanvas] = useState(false);
  const [creatingCanvas, setCreatingCanvas] = useState(false);
  const [deletingCanvas, setDeletingCanvas] = useState(false);
  const [_uploadingAsset, setUploadingAsset] = useState(false);
  const [exportingCanvas, setExportingCanvas] = useState(false);
  const [renderingTimeline, setRenderingTimeline] = useState(false);
  const [timelineRenderProgress, setTimelineRenderProgress] = useState(0);
  const [saveState, setSaveState] = useState("saved");
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const [isPanActive, setIsPanActive] = useState(false);
  const [showLeftPanel, setShowLeftPanel] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(true);
  const [showWorkflowLayer, setShowWorkflowLayer] = useState(true);
  const [canvasHistoryOpen, setCanvasHistoryOpen] = useState(false);
  const [canvasRevisionEpoch, setCanvasRevisionEpoch] = useState(0);
  const [rightPanelTab, setRightPanelTab] = useState("layers");
  const [isCanvasFullscreen, setIsCanvasFullscreen] = useState(false);
  const [inlineAiOpen, setInlineAiOpen] = useState(false);
  const [lastInlineAiSelectionKey, setLastInlineAiSelectionKey] = useState("");
  const [spacePanMode, setSpacePanMode] = useState(false);
  const [handToolMode, setHandToolMode] = useState(false);
  const [handToolPinned, setHandToolPinned] = useState(false);
  const [zoomToolMode, setZoomToolMode] = useState(false);
  const [zoomToolPinned, setZoomToolPinned] = useState(false);
  const [zoomToolZoomOut, setZoomToolZoomOut] = useState(false);
  const [boardSize, setBoardSize] = useState({ width: 0, height: 0 });
  const [interactionHud, setInteractionHud] = useState(null);
  const [zoomPulse, setZoomPulse] = useState(null);
  const [imageScenes, setImageScenes] = useState([]);
  const [videoScenes, setVideoScenes] = useState([]);
  const [selectedImageSceneKey, setSelectedImageSceneKey] = useState("");
  const [selectedVideoSceneKey, setSelectedVideoSceneKey] = useState("");
  const [canvasAiPrompt, setCanvasAiPrompt] = useState("");
  const [canvasAiSize, setCanvasAiSize] = useState("1024x1024");
  const [canvasAiModel, setCanvasAiModel] = useState("nano-banana-2");
  const [canvasAiModels, setCanvasAiModels] = useState(FALLBACK_CANVAS_AI_IMAGE_MODELS);
  const [canvasVisualParameters, setCanvasVisualParameters] = useState({});
  const [canvasAiUseSelection, setCanvasAiUseSelection] = useState(true);
  const [canvasAiGenerating, setCanvasAiGenerating] = useState(false);
  const canvasImageSubmitRef = useRef(false);
  const [_canvasAiResult, setCanvasAiResult] = useState(null);
  const [canvasVideoPrompt, setCanvasVideoPrompt] = useState("");
  const [canvasVideoSize, setCanvasVideoSize] = useState("720x1280");
  const [canvasVideoModel, setCanvasVideoModel] = useState("veo-3-1");
  const [canvasVideoModels, setCanvasVideoModels] = useState(FALLBACK_CANVAS_VIDEO_MODELS);
  const [canvasVideoUseSelection, setCanvasVideoUseSelection] = useState(true);
  const [canvasVideoGenerating, setCanvasVideoGenerating] = useState(false);
  const canvasVideoSubmitRef = useRef(false);
  const [_canvasVideoTask, setCanvasVideoTask] = useState(null);
  const [agentBrief, setAgentBrief] = useState("");
  const [agentAccessMode, setAgentAccessMode] = useState(() => {
    if (typeof window === "undefined") return "approve_for_me";
    const saved = window.localStorage.getItem("stardraw_agent_access_mode");
    const legacyModes = { ask: "ask_for_approval", approve: "approve_for_me", full: "full_access" };
    const normalized = legacyModes[saved] || saved;
    return AGENT_ACCESS_MODES.some((item) => item.key === normalized) ? normalized : "approve_for_me";
  });
  const [agentSessionId, setAgentSessionId] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [_agentPlan, setAgentPlan] = useState(null);
  const [agentMessages, setAgentMessages] = useState([]);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [expandedAgentDetails, setExpandedAgentDetails] = useState(() => new Set());
  const [pendingAgentImageGeneration, setPendingAgentImageGeneration] = useState(null);
  const [pendingAgentVideoGeneration, setPendingAgentVideoGeneration] = useState(null);
  const [agentMentions, setAgentMentions] = useState([]);
  const [agentMentionState, setAgentMentionState] = useState({
    open: false,
    query: "",
    start: 0,
    end: 0,
    activeIndex: 0,
  });
  const [agentPanelWidth, setAgentPanelWidth] = useState(() => {
    if (typeof window === "undefined") return AGENT_PANEL_DEFAULT_WIDTH;
    return clamp(
      window.localStorage.getItem("stardraw_canvas_agent_width"),
      AGENT_PANEL_MIN_WIDTH,
      getAgentPanelMaxWidth(),
      AGENT_PANEL_DEFAULT_WIDTH,
    );
  });
  const [assetQuery, setAssetQuery] = useState("");
  const [theme, setTheme] = useState(readStarDrawTheme);
  // Legacy inline Agent state is intentionally disconnected from persistence.
  // CanvasAgentPanel owns the independent conversation and run interfaces.
  const agentConversations = [];
  const activeAgentConversation = null;
  const agentConversationLoading = false;
  const createAgentConversation = useCallback(async () => null, []);
  const openAgentConversation = useCallback(async () => null, []);
  const saveAgentConversation = useCallback(async () => null, []);

  viewportRef.current = viewport;
  elementsRef.current = elements;
  agentMentionsRef.current = agentMentions;
  const ui = CANVAS_THEME_TOKENS[theme] || CANVAS_THEME_TOKENS.night;

  useEffect(() => {
    if (!activeAgentConversation?.id) {
      setAgentSessionId("");
      return;
    }
    agentConversationHydratedRef.current = false;
    setAgentSessionId(activeAgentConversation.id);
    setAgentMessages(Array.isArray(activeAgentConversation.messages) ? activeAgentConversation.messages : []);
    setAgentBrief(String(activeAgentConversation.runtime_state?.brief || ""));
    setAgentMentions([]);
    setExpandedAgentDetails(new Set());
    setPendingAgentImageGeneration(null);
    setPendingAgentVideoGeneration(null);
    try { window.sessionStorage.setItem("stardraw_agent_session_id", activeAgentConversation.id); } catch { /* no-op */ }
    const frame = window.requestAnimationFrame(() => { agentConversationHydratedRef.current = true; });
    return () => window.cancelAnimationFrame(frame);
  }, [activeAgentConversation?.id]);

  const persistCurrentCanvasAgentConversation = useCallback(() => {
    const firstUserMessage = agentMessages.find((message) => message?.role === "user" && String(message?.content || "").trim());
    return saveAgentConversation({
      title: firstUserMessage?.content || t("新对话", "New conversation"),
      messages: agentMessages,
      runtimeState: { brief: agentBrief },
    });
  }, [agentBrief, agentMessages, saveAgentConversation, t]);

  useEffect(() => {
    if (!agentSessionId || !agentConversationHydratedRef.current || agentConversationLoading) return undefined;
    const timer = window.setTimeout(() => {
      persistCurrentCanvasAgentConversation().then(() => {
        agentConversationSaveErrorRef.current = false;
      }).catch((error) => {
        if (agentConversationSaveErrorRef.current) return;
        agentConversationSaveErrorRef.current = true;
        toast.error(error.response?.data?.message || t("对话记录保存失败", "Unable to save conversation"));
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [agentConversationLoading, agentSessionId, persistCurrentCanvasAgentConversation, t]);

  const resizeAgentInput = useCallback(() => {
    const input = agentInputRef.current;
    if (!input) return;

    input.style.height = "auto";
    const nextHeight = clamp(input.scrollHeight, AGENT_INPUT_MIN_HEIGHT, AGENT_INPUT_MAX_HEIGHT, AGENT_INPUT_MIN_HEIGHT);
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > AGENT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    resizeAgentInput();
  }, [agentBrief, agentMentions.length, resizeAgentInput, showAiPanel]);

  useEffect(() => {
    if (!showAiPanel) return;
    window.requestAnimationFrame(() => {
      agentMessagesEndRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "end",
      });
    });
  }, [agentMessages, agentRunning, showAiPanel]);

  const setMarqueeState = useCallback((nextValue) => {
    if (typeof nextValue === "function") {
      setMarquee((prev) => {
        const resolved = nextValue(prev);
        marqueeRef.current = resolved;
        return resolved;
      });
      return;
    }

    marqueeRef.current = nextValue;
    setMarquee(nextValue);
  }, []);

  const selectedElements = useMemo(
    () => elements.filter((item) => selectedIds.includes(item.id)),
    [elements, selectedIds],
  );
  const selectedUnlockedElements = useMemo(
    () => selectedElements.filter((item) => !item.locked),
    [selectedElements],
  );
  const selectedBounds = useMemo(
    () => getBoundsFromElements(selectedElements),
    [selectedElements],
  );
  const selectedUnlockedBounds = useMemo(
    () => getBoundsFromElements(selectedUnlockedElements),
    [selectedUnlockedElements],
  );
  const filteredLayerElements = useMemo(() => {
    const query = layerQuery.trim().toLowerCase();
    const reversed = [...elements].reverse();
    if (!query) return reversed;
    return reversed.filter((item) => {
      const label = `${item.title || ""} ${item.type || ""}`.toLowerCase();
      return label.includes(query);
    });
  }, [elements, layerQuery]);
  const selectedElement = useMemo(
    () => (selectedIds.length === 1 ? elements.find((item) => item.id === selectedId) || null : null),
    [elements, selectedId, selectedIds],
  );
  const selectedImageElements = useMemo(
    () => selectedElements
      .filter((item) => item.type === "image" && getImageAssetUrl(item))
      .slice(0, 4),
    [selectedElements],
  );
  const resolveAgentImageReferences = useCallback((mentions = []) => {
    const rows = [];
    const seen = new Set();
    const elementMap = new Map(elementsRef.current.map((item) => [item.id, item]));

    (Array.isArray(mentions) ? mentions : []).forEach((mention) => {
      const element = mention?.elementId ? elementMap.get(mention.elementId) : null;
      const assetType = element?.type || mention?.assetType;
      if (assetType !== "image") return;

      const url = element ? getImageAssetUrl(element) : mention?.url;
      if (!url) return;

      const key = element?.id || mention?.assetId || mention?.key || url;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        id: key,
        type: "image",
        title: element?.title || mention?.title || mention?.label || "",
        src: url,
        source: "agent_reference",
      });
    });

    return rows.slice(0, 4);
  }, []);
  const selectedImageSelectionKey = useMemo(
    () => selectedImageElements.map((item) => item.id).join("|"),
    [selectedImageElements],
  );
  const selectedImageScene = useMemo(
    () => imageScenes.find((item) => item.scene_key === selectedImageSceneKey) || imageScenes[0] || null,
    [imageScenes, selectedImageSceneKey],
  );
  const selectedVideoScene = useMemo(
    () => videoScenes.find((item) => item.scene_key === selectedVideoSceneKey) || videoScenes[0] || null,
    [videoScenes, selectedVideoSceneKey],
  );
  const activeCanvasImageModel = useMemo(
    () => getModelByKey(canvasAiModels, canvasAiModel),
    [canvasAiModel, canvasAiModels],
  );
  const canvasImageSupportsReferences = modelSupportsReferenceImages(activeCanvasImageModel);
  const canvasImageSizeOptions = useMemo(() => getModelSizeOptions({
    model: activeCanvasImageModel,
    outputType: "image",
    fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
  }), [activeCanvasImageModel]);
  const activeCanvasVideoModel = useMemo(
    () => getModelByKey(canvasVideoModels, canvasVideoModel),
    [canvasVideoModel, canvasVideoModels],
  );
  const canvasVideoSupportsReferences = modelSupportsReferenceImages(activeCanvasVideoModel);
  const canvasVideoSizeOptions = useMemo(() => getModelSizeOptions({
    model: activeCanvasVideoModel,
    outputType: "video",
    fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
  }), [activeCanvasVideoModel]);
  const freeformImageScene = useMemo(
    () => findFreeformScene(imageScenes, "image"),
    [imageScenes],
  );
  const freeformVideoScene = useMemo(
    () => findFreeformScene(videoScenes, "video"),
    [videoScenes],
  );
  const resolveImageSceneForGeneration = useCallback((requestedScene, useReferences) => {
    if (!requestedScene) return null;
    if (useReferences || !requestedScene.requires_reference) return requestedScene;
    return findFreeformScene(imageScenes, "image")
      || imageScenes.find((scene) => !scene.requires_reference)
      || requestedScene;
  }, [imageScenes]);
  const resolveVideoSceneForGeneration = useCallback((requestedScene, useReferences) => {
    if (!requestedScene) return null;
    if (useReferences || !requestedScene.requires_reference) return requestedScene;
    return findFreeformScene(videoScenes, "video")
      || videoScenes.find((scene) => !scene.requires_reference)
      || requestedScene;
  }, [videoScenes]);
  const describeSceneSwitch = useCallback((requestedScene, resolvedScene, useReferences, outputType = "image") => {
    if (!requestedScene?.scene_key || !resolvedScene?.scene_key) return "";
    if (requestedScene.scene_key === resolvedScene.scene_key) return "";
    if (useReferences || !requestedScene.requires_reference) return "";

    const requestedName = requestedScene.scene_name || requestedScene.preview_title || requestedScene.scene_key;
    const resolvedName = resolvedScene.scene_name || resolvedScene.preview_title || resolvedScene.scene_key;
    return outputType === "video"
      ? t(
        `原视频模板「${requestedName}」需要参考图，Agent 已自动切换到「${resolvedName}」继续生成。`,
        `The requested video template "${requestedName}" needs a reference image, so Agent switched to "${resolvedName}" automatically.`,
      )
      : t(
        `原图片模板「${requestedName}」需要参考图，Agent 已自动切换到「${resolvedName}」继续生成。`,
        `The requested image template "${requestedName}" needs reference images, so Agent switched to "${resolvedName}" automatically.`,
      );
  }, [t]);
  const filteredAssets = useMemo(() => {
    const query = assetQuery.trim().toLowerCase();
    const historyAssets = assets.filter((asset) => asset.source !== "canvas_upload");
    if (!query) return historyAssets;
    return historyAssets.filter((asset) => [
      asset.scene_name,
      asset.title,
      asset.type,
      asset.status,
      asset.prompt,
    ].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [assetQuery, assets]);
  const filteredAssetGroups = useMemo(() => ([
    {
      key: "image",
      icon: "image",
      title: t("图片历史", "Image History"),
      items: filteredAssets.filter((asset) => asset.type !== "video"),
    },
    {
      key: "video",
      icon: "movie_filter",
      title: t("视频历史", "Video History"),
      items: filteredAssets.filter((asset) => asset.type === "video"),
    },
  ]), [filteredAssets, t]);
  const agentMentionOptions = useMemo(() => {
    const rows = [];
    const selectedSet = new Set(selectedIds);
    const pushUnique = (item) => {
      if (!item?.key || rows.some((row) => row.key === item.key)) return;
      rows.push(item);
    };
    const elementToMention = (element, selected = false) => ({
      key: `element:${element.id}`,
      type: "element",
      label: element.title || (element.type === "text" ? t("便签", "Note") : element.type === "video" ? t("画布视频", "Canvas Video") : t("画布图片", "Canvas Image")),
      title: element.title || element.id,
      subtitle: selected ? t("当前选中元素", "Selected canvas element") : t("画布元素", "Canvas element"),
      icon: element.type === "text" ? "sticky_note_2" : element.type === "video" ? "movie_filter" : "image",
      elementId: element.id,
      assetType: element.type,
      url: element.type === "video" ? getVideoAssetUrl(element) : getImageAssetUrl(element),
      poster: element.type === "video" ? getVideoPosterUrl(element) : "",
      prompt: element.prompt || element.text || "",
    });
    const assetToMention = (asset) => {
      const isVideo = asset.type === "video";
      const title = asset.scene_name || asset.title || (isVideo ? t("历史视频", "History Video") : t("历史图片", "History Image"));
      return {
        key: `asset:${asset.id || asset.content || asset.url || title}`,
        type: "asset",
        label: title,
        title,
        subtitle: isVideo ? t("历史视频素材", "History video asset") : t("历史图片素材", "History image asset"),
        icon: isVideo ? "movie_filter" : "image",
        assetId: String(asset.id || ""),
        assetType: isVideo ? "video" : "image",
        url: isVideo ? getVideoAssetUrl(asset) : getImageAssetUrl(asset),
        poster: isVideo ? getVideoPosterUrl(asset) : "",
        prompt: asset.prompt || asset.scene_name || "",
      };
    };
    const templateToMention = (scene, type) => {
      const isVideo = type === "video_template";
      const title = scene.preview_title || scene.scene_name || scene.scene_key || (isVideo ? t("视频模板", "Video Template") : t("图片模板", "Image Template"));
      return {
        key: `${type}:${scene.scene_key}`,
        type,
        label: title,
        title,
        subtitle: isVideo ? t("视频模板", "Video template") : t("图片模板", "Image template"),
        icon: isVideo ? "movie_filter" : "auto_awesome",
        sceneKey: scene.scene_key,
        assetType: isVideo ? "video" : "image",
        prompt: scene.starter_prompt || scene.preview_description || "",
        defaultModel: scene.default_model || "",
        defaultSize: scene.default_size || "",
      };
    };

    selectedElements.forEach((element) => pushUnique(elementToMention(element, true)));
    elements
      .filter((element) => !selectedSet.has(element.id))
      .slice(0, 24)
      .forEach((element) => pushUnique(elementToMention(element, false)));
    assets.slice(0, 24).forEach((asset) => pushUnique(assetToMention(asset)));
    imageScenes.slice(0, 16).forEach((scene) => pushUnique(templateToMention(scene, "image_template")));
    videoScenes.slice(0, 16).forEach((scene) => pushUnique(templateToMention(scene, "video_template")));

    const query = agentMentionState.query.trim().toLowerCase();
    const filtered = query
      ? rows.filter((item) => [
          item.label,
          item.title,
          item.subtitle,
          item.type,
          item.assetType,
          item.sceneKey,
          item.prompt,
        ].filter(Boolean).join(" ").toLowerCase().includes(query))
      : rows;

    return filtered.slice(0, 12);
  }, [
    agentMentionState.query,
    assets,
    elements,
    imageScenes,
    selectedElements,
    selectedIds,
    t,
    videoScenes,
  ]);
  const activeMentionIndex = agentMentionOptions.length > 0
    ? Math.min(agentMentionState.activeIndex, agentMentionOptions.length - 1)
    : -1;
  const selectedRotation = selectedElement ? getElementRotation(selectedElement) : 0;
  const selectToolMode = !handToolMode && !zoomToolMode;
  const canResizeSelection = selectedIds.length > 1
    && selectedUnlockedElements.length === selectedIds.length
    && Boolean(selectedUnlockedBounds);
  const allSelectedLocked = selectedElements.length > 0
    && selectedElements.every((item) => item.locked);
  const allSelectedInSameGroup = selectedElements.length > 1
    && selectedElements.every((item) => item.groupId && item.groupId === selectedElements[0]?.groupId);
  const selectedScreenBounds = useMemo(() => {
    if (!selectedBounds) return null;
    return {
      left: selectedBounds.minX * viewport.scale + viewport.x,
      top: selectedBounds.minY * viewport.scale + viewport.y,
      width: (selectedBounds.maxX - selectedBounds.minX) * viewport.scale,
      height: (selectedBounds.maxY - selectedBounds.minY) * viewport.scale,
    };
  }, [selectedBounds, viewport.scale, viewport.x, viewport.y]);
  const selectionToolbarPosition = useMemo(() => {
    if (!selectedScreenBounds || !boardSize.width || !boardSize.height) return null;

    const availableWidth = Math.max(248, boardSize.width - RULER_SIZE - 24);
    const toolbarWidth = selectedImageElements.length > 0
      ? Math.min(456, availableWidth)
      : Math.min(424, Math.max(248, boardSize.width - 24));
    const rawLeft = selectedScreenBounds.left + selectedScreenBounds.width / 2 - toolbarWidth / 2;
    const left = clamp(rawLeft, RULER_SIZE + 12, Math.max(RULER_SIZE + 12, boardSize.width - toolbarWidth - 12), RULER_SIZE + 12);
    const top = Math.max(RULER_SIZE + 12, selectedScreenBounds.top - (selectedImageElements.length > 0 ? 58 : 68));

    return {
      left,
      top,
      maxWidth: availableWidth,
      width: toolbarWidth,
    };
  }, [boardSize.height, boardSize.width, selectedImageElements.length, selectedScreenBounds]);
  const inlineAiPanelPosition = useMemo(() => {
    if (!selectedScreenBounds || selectedImageElements.length === 0 || !boardSize.width || !boardSize.height) return null;

    const panelWidth = Math.min(680, Math.max(320, boardSize.width - RULER_SIZE - 36));
    const panelHeight = 246;
    const rawLeft = selectedScreenBounds.left + selectedScreenBounds.width / 2 - panelWidth / 2;
    const belowTop = selectedScreenBounds.top + selectedScreenBounds.height + 16;
    const aboveTop = selectedScreenBounds.top - panelHeight - 16;
    const hasBelowSpace = belowTop + panelHeight <= boardSize.height - 12;
    const rawTop = hasBelowSpace ? belowTop : aboveTop;

    return {
      left: clamp(rawLeft, RULER_SIZE + 12, Math.max(RULER_SIZE + 12, boardSize.width - panelWidth - 12), RULER_SIZE + 12),
      top: clamp(rawTop, RULER_SIZE + 12, Math.max(RULER_SIZE + 12, boardSize.height - panelHeight - 12), RULER_SIZE + 12),
      width: panelWidth,
    };
  }, [boardSize.height, boardSize.width, selectedImageElements.length, selectedScreenBounds]);
  const selectionMetrics = useMemo(() => {
    if (!selectedBounds) return null;
    return {
      x: Math.round(selectedBounds.minX),
      y: Math.round(selectedBounds.minY),
      width: Math.max(1, Math.round(selectedBounds.maxX - selectedBounds.minX)),
      height: Math.max(1, Math.round(selectedBounds.maxY - selectedBounds.minY)),
    };
  }, [selectedBounds]);
  const selectionAngleLabel = useMemo(() => {
    if (selectedIds.length === 1 && selectedElement) {
      return `${Math.round(selectedRotation)}deg`;
    }
    if (selectedIds.length > 1) {
      const uniqueAngles = [...new Set(selectedElements.map((item) => Math.round(getElementRotation(item))))];
      return uniqueAngles.length === 1 ? `${uniqueAngles[0]}deg` : t("混合", "Mixed");
    }
    return "";
  }, [selectedElement, selectedElements, selectedIds.length, selectedRotation, t]);

  const isSelected = useCallback((elementId) => selectedIds.includes(elementId), [selectedIds]);

  const clearSelection = useCallback(() => {
    setSelectedId("");
    setSelectedIds([]);
  }, []);

  const toggleCanvasVideoAudio = useCallback(async (event, elementId) => {
    event.preventDefault();
    event.stopPropagation();
    const video = elementVideoRefs.current[elementId];
    if (!video) return;
    if (!video.muted) {
      muteCanvasVideo(video);
      setAudibleVideoId("");
      return;
    }
    const activated = await activateCanvasVideoAudio({
      videos: elementVideoRefs.current,
      elementId,
    });
    if (activated) setAudibleVideoId(String(elementId));
  }, []);

  useEffect(() => {
    if (!audibleVideoId) return;
    const remainsSelected = selectedIds.includes(audibleVideoId);
    const remainsOnCanvas = elements.some((element) => element.id === audibleVideoId && element.type === "video");
    if (remainsSelected && remainsOnCanvas) return;
    muteCanvasVideo(elementVideoRefs.current[audibleVideoId]);
    setAudibleVideoId("");
  }, [audibleVideoId, elements, selectedIds]);

  const clearInteractionHud = useCallback(() => {
    if (hudTimerRef.current) {
      window.clearTimeout(hudTimerRef.current);
      hudTimerRef.current = null;
    }
    setInteractionHud(null);
  }, []);

  const flashZoomPulse = useCallback((clientX, clientY, zoomOut = false) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (zoomPulseTimerRef.current) {
      window.clearTimeout(zoomPulseTimerRef.current);
      zoomPulseTimerRef.current = null;
    }

    setZoomPulse({
      left: clamp(clientX - rect.left, 24, Math.max(24, rect.width - 24), rect.width / 2 || 24),
      top: clamp(clientY - rect.top, 24, Math.max(24, rect.height - 24), rect.height / 2 || 24),
      zoomOut,
      key: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    });

    zoomPulseTimerRef.current = window.setTimeout(() => {
      setZoomPulse(null);
      zoomPulseTimerRef.current = null;
    }, 260);
  }, []);

  const deactivateHandTool = useCallback(() => {
    handToolRef.current = false;
    handToolPinnedRef.current = false;
    setHandToolMode(false);
    setHandToolPinned(false);
  }, []);

  const activateZoomTool = useCallback((pinned = false) => {
    handToolRef.current = false;
    handToolPinnedRef.current = false;
    setHandToolMode(false);
    setHandToolPinned(false);
    zoomToolRef.current = true;
    zoomToolPinnedRef.current = pinned;
    setZoomToolMode(true);
    setZoomToolPinned(pinned);
  }, []);

  const deactivateZoomTool = useCallback(() => {
    zoomToolRef.current = false;
    zoomToolPinnedRef.current = false;
    setZoomToolMode(false);
    setZoomToolPinned(false);
  }, []);

  const activateHandTool = useCallback((pinned = false) => {
    zoomToolRef.current = false;
    zoomToolPinnedRef.current = false;
    setZoomToolMode(false);
    setZoomToolPinned(false);
    handToolRef.current = true;
    handToolPinnedRef.current = pinned;
    setHandToolMode(true);
    setHandToolPinned(pinned);
  }, []);

  const togglePinnedHandTool = useCallback(() => {
    if (handToolPinnedRef.current) {
      deactivateHandTool();
      return;
    }
    activateHandTool(true);
  }, [activateHandTool, deactivateHandTool]);

  const togglePinnedZoomTool = useCallback(() => {
    if (zoomToolPinnedRef.current) {
      deactivateZoomTool();
      return;
    }
    activateZoomTool(true);
  }, [activateZoomTool, deactivateZoomTool]);

  const toggleCanvasFullscreen = useCallback(async () => {
    const node = pageRef.current;
    if (!node) return;

    try {
      if (document.fullscreenElement === node) {
        await document.exitFullscreen?.();
        return;
      }

      if (!node.requestFullscreen) {
        toast.error(t("当前浏览器不支持全屏模式", "Fullscreen is not supported by this browser"));
        return;
      }

      await node.requestFullscreen();
    } catch (err) {
      toast.error(err?.message || t("切换全屏失败", "Failed to toggle fullscreen"));
    }
  }, [t]);

  const activateSelectTool = useCallback(() => {
    deactivateHandTool();
    deactivateZoomTool();
    setZoomToolZoomOut(false);
  }, [deactivateHandTool, deactivateZoomTool]);

  const showInteractionHud = useCallback((label, options = {}) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const anchorX = options.clientX != null && rect ? options.clientX - rect.left : boardSize.width / 2;
    const anchorY = options.clientY != null && rect ? options.clientY - rect.top : boardSize.height / 2;

    if (hudTimerRef.current) {
      window.clearTimeout(hudTimerRef.current);
      hudTimerRef.current = null;
    }

    setInteractionHud({
      label,
      left: clamp(anchorX, 72, Math.max(72, boardSize.width - 72), boardSize.width / 2 || 72),
      top: clamp(anchorY, 72, Math.max(72, boardSize.height - 72), boardSize.height / 2 || 72),
    });

    if (options.persist) return;
    hudTimerRef.current = window.setTimeout(() => {
      setInteractionHud(null);
      hudTimerRef.current = null;
    }, options.duration ?? 720);
  }, [boardSize.height, boardSize.width]);

  const selectElementCluster = useCallback((elementId) => {
    const nextIds = elementId ? getGroupedSelectionIds(elementId, elementsRef.current) : [];
    setSelectedId(nextIds[nextIds.length - 1] || "");
    setSelectedIds(nextIds);
  }, []);

  const toggleSelection = useCallback((elementId) => {
    const clusterIds = getGroupedSelectionIds(elementId, elementsRef.current);
    setSelectedIds((prev) => {
      const isActive = clusterIds.every((id) => prev.includes(id));
      if (isActive) {
        const next = prev.filter((id) => !clusterIds.includes(id));
        setSelectedId((current) => (clusterIds.includes(current) ? next[0] || "" : current));
        return next;
      }
      const next = [...new Set([...prev, ...clusterIds])];
      setSelectedId(clusterIds[clusterIds.length - 1] || "");
      return next;
    });
  }, []);

  const clearAutoPan = useCallback(() => {
    autoPanPointerRef.current = null;
    if (autoPanFrameRef.current) {
      window.cancelAnimationFrame(autoPanFrameRef.current);
      autoPanFrameRef.current = null;
    }
  }, []);

  const clearPanInertia = useCallback(() => {
    if (panInertiaFrameRef.current) {
      window.cancelAnimationFrame(panInertiaFrameRef.current);
      panInertiaFrameRef.current = null;
    }
  }, []);

  const startViewportInertia = useCallback((velocityX = 0, velocityY = 0) => {
    let vx = clamp(velocityX, -PAN_INERTIA_MAX_VELOCITY, PAN_INERTIA_MAX_VELOCITY, 0);
    let vy = clamp(velocityY, -PAN_INERTIA_MAX_VELOCITY, PAN_INERTIA_MAX_VELOCITY, 0);
    if (Math.hypot(vx, vy) < PAN_INERTIA_MIN_START_VELOCITY) return;

    clearPanInertia();

    let lastTime = null;
    const step = (timestamp) => {
      if (lastTime == null) {
        lastTime = timestamp;
      }
      const deltaMs = clamp(timestamp - lastTime, 1, 32, 16);
      lastTime = timestamp;
      const decay = PAN_INERTIA_DECAY ** (deltaMs / 16.67);
      vx *= decay;
      vy *= decay;

      setViewport((prev) => ({
        ...prev,
        x: clamp(prev.x + vx * deltaMs, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, prev.x),
        y: clamp(prev.y + vy * deltaMs, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, prev.y),
      }));

      if (Math.hypot(vx, vy) <= PAN_INERTIA_STOP_VELOCITY) {
        panInertiaFrameRef.current = null;
        return;
      }

      panInertiaFrameRef.current = window.requestAnimationFrame(step);
    };

    panInertiaFrameRef.current = window.requestAnimationFrame(step);
  }, [clearPanInertia]);

  const stopViewportAnimation = useCallback(() => {
    clearAutoPan();
    clearPanInertia();
    if (viewportAnimationRef.current) {
      window.cancelAnimationFrame(viewportAnimationRef.current);
      viewportAnimationRef.current = null;
    }
    if (viewportGestureFrameRef.current) {
      window.cancelAnimationFrame(viewportGestureFrameRef.current);
      viewportGestureFrameRef.current = null;
    }
    viewportGestureTargetRef.current = null;
    wheelGestureRef.current = { mode: "", lastTs: 0, anchorX: null, anchorY: null, response: null };
    wheelPendingRef.current = null;
    if (wheelFrameRef.current) {
      window.cancelAnimationFrame(wheelFrameRef.current);
      wheelFrameRef.current = null;
    }
  }, [clearAutoPan, clearPanInertia]);

  const applyCanvas = useCallback((canvas) => {
    const safeState = normalizeCanvasState(canvas?.state || {});
    stopViewportAnimation();
    suspendAutosaveRef.current = true;
    canvasUpdatedAtRef.current = String(canvas?.updated_at || canvas?.updatedAt || "");
    canvasBaselineElementIdsRef.current = new Set(safeState.elements.map((element) => String(element.id)));
    setCanvasTitle(canvas?.title || "");
    setViewport(safeState.viewport);
    setElements(safeState.elements);
    setProjectModel(safeState.projectModel);
    clearSelection();
    setSaveState("saved");
    window.requestAnimationFrame(() => {
      suspendAutosaveRef.current = false;
    });
  }, [clearSelection, stopViewportAnimation]);

  const mergeCanvasMeta = useCallback((canvas) => {
    if (!canvas?.id) return;
    setCanvases((prev) => {
      const next = [...prev.filter((item) => item.id !== canvas.id), {
        id: canvas.id,
        title: canvas.title,
        created_at: canvas.created_at,
        updated_at: canvas.updated_at,
        element_count: canvas.element_count ?? canvas.state?.elements?.length ?? 0,
      }];
      return next.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    });
  }, []);

  const loadCanvas = useCallback(async (canvasId) => {
    if (!canvasId) return;
    setLoadingCanvas(true);
    try {
      const { data } = await authAxios.get(`/api/canvases/${canvasId}`);
      applyCanvas(data?.data);
      mergeCanvasMeta(data?.data);
    } catch (err) {
      toast.error(err.response?.data?.message || t("画布加载失败", "Failed to load canvas"));
    } finally {
      setLoadingCanvas(false);
    }
  }, [applyCanvas, authAxios, mergeCanvasMeta, t]);

  const createCanvas = useCallback(async () => {
    setCreatingCanvas(true);
    try {
      const { data } = await authAxios.post("/api/canvases", {
        title: t("未命名画布", "Untitled Canvas"),
        state: { viewport: DEFAULT_VIEWPORT, elements: [], ...EMPTY_PROJECT_MODEL },
      });
      const canvas = data?.data;
      if (!canvas) throw new Error("invalid canvas");
      mergeCanvasMeta(canvas);
      setActiveCanvasId(canvas.id);
      applyCanvas(canvas);
      return canvas;
    } catch (err) {
      toast.error(err.response?.data?.message || t("新建画布失败", "Failed to create canvas"));
      return null;
    } finally {
      setCreatingCanvas(false);
    }
  }, [applyCanvas, authAxios, mergeCanvasMeta, t]);

  const loadCanvases = useCallback(async () => {
    setLoading(true);
    try {
      const [canvasResponse, assetsResponse] = await Promise.all([
        authAxios.get("/api/canvases"),
        Promise.all([
          authAxios.get("/api/user/get-user-creations?page_size=50&status=completed&type=image"),
          authAxios.get("/api/user/get-user-creations?page_size=50&status=completed&type=video"),
        ]),
      ]);

      const canvasRows = canvasResponse.data?.data || [];
      const nextAssets = assetsResponse
        .flatMap((response) => response.data?.creations || [])
        .filter(canUseAsset)
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

      setCanvases(canvasRows);
      setAssets(nextAssets);

      if (canvasRows.length > 0) {
        const firstCanvasId = canvasRows[0].id;
        setActiveCanvasId(firstCanvasId);
        await loadCanvas(firstCanvasId);
      } else {
        const created = await createCanvas();
        if (created?.id) {
          setActiveCanvasId(created.id);
        }
      }
    } catch (err) {
      toast.error(err.response?.data?.message || t("画布中心加载失败", "Failed to load canvas studio"));
    } finally {
      setLoading(false);
    }
  }, [authAxios, createCanvas, loadCanvas, t]);

  useEffect(() => {
    void loadCanvases();
  }, [loadCanvases]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncTheme = (event) => {
      setTheme(normalizeStarDrawTheme(event?.detail?.theme || readStarDrawTheme()));
    };

    const handleStorage = (event) => {
      if (event.key === "stardraw_theme") syncTheme(event);
    };

    window.addEventListener("stardraw:theme-change", syncTheme);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("stardraw:theme-change", syncTheme);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!selectedImageSelectionKey) {
      setInlineAiOpen(false);
      setLastInlineAiSelectionKey("");
      return;
    }

    if (selectedImageSelectionKey !== lastInlineAiSelectionKey) {
      setCanvasAiUseSelection(true);
      setLastInlineAiSelectionKey(selectedImageSelectionKey);
    }
  }, [lastInlineAiSelectionKey, selectedImageSelectionKey]);

  useEffect(() => {
    let cancelled = false;

    authAxios.get("/api/template-studio/catalog?output_type=image&featured_only=true&include_freeform=true&limit=100")
      .then((response) => {
        if (cancelled) return;
        const rows = normalizeTemplates(response.data?.data || []);
        setImageScenes(rows);
        const preferred = rows.find((item) => item.is_featured) || rows[0] || null;
        if (preferred) {
          setSelectedImageSceneKey((prev) => prev || preferred.scene_key);
          setCanvasAiPrompt((prev) => prev || preferred.starter_prompt || "");
          if (preferred.default_size) {
            setCanvasAiSize((prev) => prev || preferred.default_size);
          }
          if (preferred.default_model) setCanvasAiModel((prev) => prev || normalizeCanvasImageModel(preferred.default_model));
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t("加载图片模板失败", "Failed to load image templates"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authAxios, t]);

  useEffect(() => {
    let cancelled = false;
    authAxios.get("/api/ai/models?output_type=image")
      .then((response) => {
        if (cancelled) return;
        const rows = normalizeModelCatalogResponse(response.data, FALLBACK_CANVAS_AI_IMAGE_MODELS);
        if (!rows.length) return;
        setCanvasAiModels(rows);
        setCanvasAiModel((current) => resolveSupportedModel(rows, current, rows[0].model_key));
      })
      .catch(() => {
        if (!cancelled) toast.error(t("加载模型失败", "Failed to load models"));
      });
    return () => { cancelled = true; };
  }, [authAxios, t]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      authAxios.get("/api/template-studio/catalog?output_type=video&featured_only=true&include_freeform=true&limit=100"),
      authAxios.get("/api/ai/models?output_type=video"),
    ])
      .then(([response, modelResponse]) => {
        if (cancelled) return;
        const rows = normalizeTemplates(response.data?.data || []);
        const models = normalizeModelCatalogResponse(modelResponse.data, FALLBACK_CANVAS_VIDEO_MODELS)
          .filter((item) => item.capabilities?.digital_human !== true && item.model_key !== "video-agent");
        setVideoScenes(rows);
        setCanvasVideoModels(models.length ? models : FALLBACK_CANVAS_VIDEO_MODELS);
        const preferred = rows.find((item) => item.is_featured) || rows[0] || null;
        if (preferred) {
          setSelectedVideoSceneKey((prev) => prev || preferred.scene_key);
          setCanvasVideoPrompt((prev) => prev || preferred.starter_prompt || "");
          if (preferred.default_size) {
            setCanvasVideoSize((prev) => prev || preferred.default_size);
          }
          setCanvasVideoModel(resolveSupportedModel(models, preferred.default_model, FALLBACK_CANVAS_VIDEO_MODELS[0].model_key));
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t("加载视频模板失败", "Failed to load video templates"));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authAxios, t]);

  useEffect(() => {
    if (!selectedImageScene || !canvasAiModels.length) return;
    const preferredModel = normalizeCanvasImageModel(selectedImageScene.default_model);
    const nextModel = resolveSupportedModel(canvasAiModels, preferredModel, canvasAiModels[0].model_key);
    setCanvasAiModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(canvasAiModels, nextModel),
      outputType: "image",
      fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
    });
    setCanvasAiSize(resolveSupportedValue(selectedImageScene.default_size, nextOptions, nextOptions[0]?.value));
  }, [canvasAiModels, selectedImageScene]);

  useEffect(() => {
    if (!selectedVideoScene || !canvasVideoModels.length) return;
    const nextModel = resolveSupportedModel(canvasVideoModels, selectedVideoScene.default_model, canvasVideoModels[0].model_key);
    setCanvasVideoModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(canvasVideoModels, nextModel),
      outputType: "video",
      fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
    });
    setCanvasVideoSize(resolveSupportedValue(selectedVideoScene.default_size, nextOptions, nextOptions[0]?.value));
  }, [canvasVideoModels, selectedVideoScene]);

  const handleCanvasImageModelChange = (nextModel) => {
    setCanvasAiModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(canvasAiModels, nextModel),
      outputType: "image",
      fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
    });
    setCanvasAiSize((current) => resolveSupportedValue(current, nextOptions, nextOptions[0]?.value));
  };

  const handleCanvasVideoModelChange = (nextModel) => {
    setCanvasVideoModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(canvasVideoModels, nextModel),
      outputType: "video",
      fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
    });
    setCanvasVideoSize((current) => resolveSupportedValue(current, nextOptions, nextOptions[0]?.value));
  };

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (hudTimerRef.current) window.clearTimeout(hudTimerRef.current);
    if (zoomPulseTimerRef.current) window.clearTimeout(zoomPulseTimerRef.current);
    if (panInertiaFrameRef.current) {
      window.cancelAnimationFrame(panInertiaFrameRef.current);
      panInertiaFrameRef.current = null;
    }
    if (viewportAnimationRef.current) {
      window.cancelAnimationFrame(viewportAnimationRef.current);
      viewportAnimationRef.current = null;
    }
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsCanvasFullscreen(document.fullscreenElement === pageRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    handleFullscreenChange();

    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    const node = boardRef.current;
    if (!node) return undefined;

    const syncBoardSize = () => {
      const rect = node.getBoundingClientRect();
      setBoardSize({ width: rect.width, height: rect.height });
    };

    syncBoardSize();

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(syncBoardSize);
      observer.observe(node);
      return () => observer.disconnect();
    }

    window.addEventListener("resize", syncBoardSize);
    return () => window.removeEventListener("resize", syncBoardSize);
  }, [loading]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncAgentPanelWidth = () => {
      setAgentPanelWidth((prev) => clamp(
        prev,
        AGENT_PANEL_MIN_WIDTH,
        getAgentPanelMaxWidth(),
        AGENT_PANEL_DEFAULT_WIDTH,
      ));
    };

    window.addEventListener("resize", syncAgentPanelWidth);
    return () => window.removeEventListener("resize", syncAgentPanelWidth);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("stardraw_canvas_agent_width", String(Math.round(agentPanelWidth)));
  }, [agentPanelWidth]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("stardraw_agent_access_mode", agentAccessMode);
  }, [agentAccessMode]);

  useEffect(() => {
    if (typeof window === "undefined" || !activeCanvasId) return;
    window.localStorage.setItem("stardraw_active_canvas_id", String(activeCanvasId));
  }, [activeCanvasId]);

  const startAgentPanelResize = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = agentPanelWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      const delta = startX - moveEvent.clientX;
      setAgentPanelWidth(clamp(
        startWidth + delta,
        AGENT_PANEL_MIN_WIDTH,
        getAgentPanelMaxWidth(),
        AGENT_PANEL_DEFAULT_WIDTH,
      ));
    };

    const cleanup = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  }, [agentPanelWidth]);

  const saveCanvas = useCallback(async () => {
    if (!activeCanvasId) return null;
    setSaveState("saving");
    try {
      const currentElementIds = new Set(elements.map((element) => String(element.id)));
      const deletedElementIds = [...canvasBaselineElementIdsRef.current]
        .filter((elementId) => !currentElementIds.has(elementId));
      const { data } = await authAxios.put(`/api/canvases/${activeCanvasId}`, {
        title: canvasTitle,
        state: { viewport, elements, ...projectModel },
        baseUpdatedAt: canvasUpdatedAtRef.current || null,
        deletedElementIds,
      });
      const savedCanvas = data?.data || null;
      mergeCanvasMeta(savedCanvas);
      if (savedCanvas?.state) {
        const savedState = normalizeCanvasState(savedCanvas.state);
        const responseUpdatedAt = String(savedCanvas.updated_at || savedCanvas.updatedAt || "");
        const responseTime = Date.parse(responseUpdatedAt);
        const currentTime = Date.parse(canvasUpdatedAtRef.current);
        if (!Number.isFinite(currentTime) || !Number.isFinite(responseTime) || responseTime >= currentTime) {
          canvasUpdatedAtRef.current = responseUpdatedAt;
          canvasBaselineElementIdsRef.current = new Set(savedState.elements.map((element) => String(element.id)));
        }
        const preservedIds = new Set((savedCanvas.concurrency?.preservedElementIds || []).map(String));
        if (preservedIds.size) {
          const preservedElements = savedState.elements.filter((element) => preservedIds.has(String(element.id)));
          setElements((current) => mergeGeneratedCanvasMediaFromServer({
            localElements: current,
            serverElements: preservedElements,
          }).elements);
        }
      }
      setSaveState("saved");
      return savedCanvas;
    } catch (err) {
      setSaveState("error");
      toast.error(err.response?.data?.message || t("画布保存失败", "Failed to save canvas"));
      return null;
    }
  }, [activeCanvasId, authAxios, canvasTitle, elements, mergeCanvasMeta, projectModel, t, viewport]);

  useEffect(() => {
    if (!activeCanvasId || suspendAutosaveRef.current) return undefined;
    setSaveState("dirty");
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      void saveCanvas();
    }, 700);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [activeCanvasId, canvasTitle, elements, saveCanvas, viewport]);

  const getBoardCenterWorld = useCallback(() => {
    const rect = boardRef.current?.getBoundingClientRect();
    const centerX = rect ? rect.width / 2 : 640;
    const centerY = rect ? rect.height / 2 : 360;
    return {
      x: (centerX - viewportRef.current.x) / viewportRef.current.scale,
      y: (centerY - viewportRef.current.y) / viewportRef.current.scale,
    };
  }, []);

  const resolveWheelGestureContext = useCallback((mode, timestamp, anchor, targetResponse) => {
    const nextTs = Number.isFinite(timestamp) ? timestamp : Date.now();
    const gestureState = wheelGestureRef.current;
    const isContinuation = (
      gestureState.mode === mode
      && nextTs - gestureState.lastTs <= WHEEL_GESTURE_IDLE_MS
      && viewportGestureTargetRef.current
    );

    const nextAnchorX = isContinuation && Number.isFinite(gestureState.anchorX)
      ? mix(gestureState.anchorX, anchor?.x ?? gestureState.anchorX, GESTURE_CENTER_MIX)
      : anchor?.x;
    const nextAnchorY = isContinuation && Number.isFinite(gestureState.anchorY)
      ? mix(gestureState.anchorY, anchor?.y ?? gestureState.anchorY, GESTURE_CENTER_MIX)
      : anchor?.y;
    const nextResponse = isContinuation && Number.isFinite(gestureState.response)
      ? mix(gestureState.response, targetResponse, GESTURE_RESPONSE_MIX)
      : targetResponse;

    wheelGestureRef.current = {
      mode,
      lastTs: nextTs,
      anchorX: Number.isFinite(nextAnchorX) ? nextAnchorX : null,
      anchorY: Number.isFinite(nextAnchorY) ? nextAnchorY : null,
      response: Number.isFinite(nextResponse) ? nextResponse : null,
    };

    return {
      baseViewport: isContinuation ? viewportGestureTargetRef.current : viewportRef.current,
      anchorX: Number.isFinite(nextAnchorX) ? nextAnchorX : anchor?.x,
      anchorY: Number.isFinite(nextAnchorY) ? nextAnchorY : anchor?.y,
      response: Number.isFinite(nextResponse) ? nextResponse : targetResponse,
    };
  }, []);

  const getGestureResponse = useCallback((baseResponse, maxResponse, intensity) => {
    const raw = clamp(intensity, 0, 1, 0);
    if (raw <= GESTURE_INTENSITY_DEADZONE) {
      return baseResponse;
    }

    const normalized = clamp(
      (raw - GESTURE_INTENSITY_DEADZONE) / (1 - GESTURE_INTENSITY_DEADZONE),
      0,
      1,
      0,
    );
    const eased = 1 - ((1 - normalized) ** 1.35);
    return mix(baseResponse, maxResponse, eased);
  }, []);

  const getViewportGestureIntensity = useCallback((fromViewport, targetViewport) => {
    const startViewport = fromViewport || viewportRef.current;
    const endViewport = targetViewport || startViewport;
    const boardDiagonal = Math.hypot(boardSize.width || 1280, boardSize.height || 720);
    const panDistance = Math.hypot(
      (endViewport.x || 0) - (startViewport.x || 0),
      (endViewport.y || 0) - (startViewport.y || 0),
    );
    const panIntensity = clamp(
      panDistance / Math.max(320, boardDiagonal * 0.68),
      0,
      1,
      0,
    );
    const safeStartScale = Math.max(MIN_VIEWPORT_SCALE, Number(startViewport.scale) || 1);
    const safeEndScale = Math.max(MIN_VIEWPORT_SCALE, Number(endViewport.scale) || safeStartScale);
    const scaleIntensity = clamp(
      Math.abs(Math.log(safeEndScale / safeStartScale)) / 0.5,
      0,
      1,
      0,
    );

    return clamp(
      Math.max(panIntensity, scaleIntensity) * 0.88 + ((panIntensity + scaleIntensity) * 0.06),
      0,
      1,
      0,
    );
  }, [boardSize.height, boardSize.width]);

  const getViewportAtScale = useCallback((nextScale, anchorX, anchorY, baseViewport = viewportRef.current) => {
    const safeScale = clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, baseViewport.scale);
    const worldX = (anchorX - baseViewport.x) / baseViewport.scale;
    const worldY = (anchorY - baseViewport.y) / baseViewport.scale;
    return {
      x: anchorX - worldX * safeScale,
      y: anchorY - worldY * safeScale,
      scale: safeScale,
    };
  }, []);

  const animateViewportTo = useCallback((targetViewport, options = {}) => {
    const safeTarget = {
      x: clamp(targetViewport?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.x),
      y: clamp(targetViewport?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.y),
      scale: clamp(targetViewport?.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale),
    };

    stopViewportAnimation();

    const startViewport = { ...viewportRef.current };
    const duration = Math.max(0, Number(options.duration) || VIEWPORT_ANIMATION_DURATION);
    if (
      duration === 0
      || (
        Math.abs(startViewport.x - safeTarget.x) < 0.1
        && Math.abs(startViewport.y - safeTarget.y) < 0.1
        && Math.abs(startViewport.scale - safeTarget.scale) < 0.0005
      )
    ) {
      setViewport(safeTarget);
      return;
    }

    let startTime = null;
    const easeOutCubic = (progress) => 1 - ((1 - progress) ** 3);

    const step = (timestamp) => {
      if (startTime == null) {
        startTime = timestamp;
      }

      const elapsed = timestamp - startTime;
      const progress = Math.min(1, elapsed / duration);
      const eased = easeOutCubic(progress);
      const nextViewport = {
        x: startViewport.x + (safeTarget.x - startViewport.x) * eased,
        y: startViewport.y + (safeTarget.y - startViewport.y) * eased,
        scale: startViewport.scale + (safeTarget.scale - startViewport.scale) * eased,
      };

      setViewport(nextViewport);

      if (progress < 1) {
        viewportAnimationRef.current = window.requestAnimationFrame(step);
      } else {
        viewportAnimationRef.current = null;
        setViewport(safeTarget);
      }
    };

    viewportAnimationRef.current = window.requestAnimationFrame(step);
  }, [stopViewportAnimation]);

  const animateViewportGestureTo = useCallback((targetViewport, options = {}) => {
    const safeTarget = {
      x: clamp(targetViewport?.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.x),
      y: clamp(targetViewport?.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.y),
      scale: clamp(targetViewport?.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale),
    };

    viewportGestureTargetRef.current = safeTarget;
    viewportGestureResponseRef.current = clamp(
      options.response,
      0.08,
      0.45,
      VIEWPORT_GESTURE_RESPONSE,
    );

    if (viewportGestureFrameRef.current) {
      return;
    }

    const step = () => {
      const target = viewportGestureTargetRef.current;
      if (!target) {
        viewportGestureFrameRef.current = null;
        return;
      }

      const current = viewportRef.current;
      const response = clamp(
        viewportGestureResponseRef.current,
        0.08,
        0.45,
        VIEWPORT_GESTURE_RESPONSE,
      );
      const nextViewport = {
        x: current.x + (target.x - current.x) * response,
        y: current.y + (target.y - current.y) * response,
        scale: current.scale + (target.scale - current.scale) * response,
      };

      setViewport(nextViewport);

      if (
        Math.abs(nextViewport.x - target.x) < 0.16
        && Math.abs(nextViewport.y - target.y) < 0.16
        && Math.abs(nextViewport.scale - target.scale) < 0.0007
      ) {
        viewportGestureTargetRef.current = null;
        viewportGestureFrameRef.current = null;
        setViewport(target);
        return;
      }

      viewportGestureFrameRef.current = window.requestAnimationFrame(step);
    };

    viewportGestureFrameRef.current = window.requestAnimationFrame(step);
  }, []);

  const getBoardAnchorFromClientPoint = useCallback((clientX, clientY) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const fallbackX = boardSize.width / 2 || 640;
    const fallbackY = boardSize.height / 2 || 360;
    if (!rect) {
      return {
        x: fallbackX,
        y: fallbackY,
        inside: false,
      };
    }

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    return {
      x: clamp(localX, 0, rect.width, rect.width / 2),
      y: clamp(localY, 0, rect.height, rect.height / 2),
      inside: localX >= 0 && localX <= rect.width && localY >= 0 && localY <= rect.height,
    };
  }, [boardSize.height, boardSize.width]);

  const setViewportScaleAtBoardPoint = useCallback((nextScale, anchorX, anchorY, options = {}) => {
    const nextViewport = getViewportAtScale(nextScale, anchorX, anchorY);
    if (options.animated) {
      animateViewportTo(nextViewport, options);
      return;
    }

    stopViewportAnimation();
    setViewport(nextViewport);
  }, [animateViewportTo, getViewportAtScale, stopViewportAnimation]);

  const gestureViewportScaleAtBoardPoint = useCallback((nextScale, anchorX, anchorY, options = {}) => {
    const baseViewport = options.baseViewport || viewportRef.current;
    const nextViewport = getViewportAtScale(nextScale, anchorX, anchorY, baseViewport);
    const response = options.response == null
      ? getGestureResponse(
          VIEWPORT_GESTURE_PINCH_RESPONSE,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          getViewportGestureIntensity(baseViewport, nextViewport),
        )
      : clamp(
          options.response,
          VIEWPORT_GESTURE_PINCH_RESPONSE,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
        );

    animateViewportGestureTo(nextViewport, {
      response,
    });
  }, [animateViewportGestureTo, getGestureResponse, getViewportAtScale, getViewportGestureIntensity]);

  const _setViewportScaleAtCenter = useCallback((nextScale, options = {}) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const anchorX = rect ? rect.width / 2 : 640;
    const anchorY = rect ? rect.height / 2 : 360;
    setViewportScaleAtBoardPoint(nextScale, anchorX, anchorY, options);
  }, [setViewportScaleAtBoardPoint]);

  const gestureViewportScaleAtCenter = useCallback((nextScale, options = {}) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const anchorX = rect ? rect.width / 2 : 640;
    const anchorY = rect ? rect.height / 2 : 360;
    gestureViewportScaleAtBoardPoint(nextScale, anchorX, anchorY, options);
  }, [gestureViewportScaleAtBoardPoint]);

  const focusBounds = useCallback((bounds, options = {}) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || !bounds) return;

    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const padding = options.padding ?? 140;
    const maxScale = options.maxScale ?? Math.min(4.5, MAX_VIEWPORT_SCALE);
    const nextScale = clamp(
      Math.min((rect.width - padding) / width, (rect.height - padding) / height),
      MIN_VIEWPORT_SCALE,
      maxScale,
      1,
    );

    const nextViewport = {
      x: rect.width / 2 - (bounds.minX + width / 2) * nextScale,
      y: rect.height / 2 - (bounds.minY + height / 2) * nextScale,
      scale: nextScale,
    };

    if (options.animated === false) {
      stopViewportAnimation();
      setViewport(nextViewport);
      return;
    }

    if (options.motion === "gesture") {
      const response = options.response == null
        ? getGestureResponse(
            VIEWPORT_GESTURE_PAN_RESPONSE,
            VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
            getViewportGestureIntensity(viewportRef.current, nextViewport),
          )
        : clamp(
            options.response,
            0.08,
            0.45,
            VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          );

      animateViewportGestureTo(nextViewport, {
        response,
      });
      return;
    }

    animateViewportTo(nextViewport, options);
  }, [animateViewportGestureTo, animateViewportTo, getGestureResponse, getViewportGestureIntensity, stopViewportAnimation]);

  const focusSurface = useCallback(() => {
    focusBounds({
      minX: FOCUS_SURFACE_X,
      minY: FOCUS_SURFACE_Y,
      maxX: FOCUS_SURFACE_X + FOCUS_SURFACE_WIDTH,
      maxY: FOCUS_SURFACE_Y + FOCUS_SURFACE_HEIGHT,
    }, {
      motion: "gesture",
      padding: 180,
      maxScale: 2,
    });
  }, [focusBounds]);

  const focusSelection = useCallback(() => {
    if (!selectedBounds) return;
    focusBounds(selectedBounds, {
      motion: "gesture",
      padding: 220,
      maxScale: 5,
    });
  }, [focusBounds, selectedBounds]);

  const fitToContent = useCallback(() => {
    if (elementsRef.current.length === 0) {
      focusSurface();
      return;
    }

    const bounds = getBoundsFromElements(elementsRef.current);
    if (!bounds) return;
    focusBounds(bounds, { motion: "gesture" });
  }, [focusBounds, focusSurface]);

  const minimapBounds = useMemo(() => getCanvasBounds(elements, {
    includeSurface: true,
    padding: 480,
  }), [elements]);

  const minimapMetrics = useMemo(() => {
    const width = Math.max(1, minimapBounds.maxX - minimapBounds.minX);
    const height = Math.max(1, minimapBounds.maxY - minimapBounds.minY);
    const scale = Math.min((MINIMAP_WIDTH - 16) / width, (MINIMAP_HEIGHT - 16) / height);
    const contentWidth = width * scale;
    const contentHeight = height * scale;
    const offsetX = (MINIMAP_WIDTH - contentWidth) / 2;
    const offsetY = (MINIMAP_HEIGHT - contentHeight) / 2;

    return {
      width,
      height,
      scale,
      offsetX,
      offsetY,
    };
  }, [minimapBounds]);

  const viewportWorldRect = useMemo(() => {
    const safeWidth = boardSize.width || 1280;
    const safeHeight = boardSize.height || 720;
    return {
      minX: (0 - viewport.x) / viewport.scale,
      minY: (0 - viewport.y) / viewport.scale,
      maxX: (safeWidth - viewport.x) / viewport.scale,
      maxY: (safeHeight - viewport.y) / viewport.scale,
    };
  }, [boardSize.height, boardSize.width, viewport.scale, viewport.x, viewport.y]);

  const minimapViewportStyle = useMemo(() => ({
    left: minimapMetrics.offsetX + (viewportWorldRect.minX - minimapBounds.minX) * minimapMetrics.scale,
    top: minimapMetrics.offsetY + (viewportWorldRect.minY - minimapBounds.minY) * minimapMetrics.scale,
    width: Math.max(24, (viewportWorldRect.maxX - viewportWorldRect.minX) * minimapMetrics.scale),
    height: Math.max(24, (viewportWorldRect.maxY - viewportWorldRect.minY) * minimapMetrics.scale),
  }), [
    minimapBounds.minX,
    minimapBounds.minY,
    minimapMetrics.offsetX,
    minimapMetrics.offsetY,
    minimapMetrics.scale,
    viewportWorldRect.maxX,
    viewportWorldRect.maxY,
    viewportWorldRect.minX,
    viewportWorldRect.minY,
  ]);

  const rulerTicks = useMemo(() => {
    const safeWidth = boardSize.width || 0;
    const safeHeight = boardSize.height || 0;
    if (!safeWidth || !safeHeight) {
      return { horizontal: [], vertical: [] };
    }

    const majorStep = getRulerStep(viewport.scale);
    const minorStep = majorStep / 2;
    const minX = viewportWorldRect.minX;
    const maxX = viewportWorldRect.maxX;
    const minY = viewportWorldRect.minY;
    const maxY = viewportWorldRect.maxY;

    const horizontal = [];
    for (let value = Math.floor(minX / minorStep) * minorStep; value <= maxX; value += minorStep) {
      const isMajor = Math.round(value / majorStep) * majorStep === value;
      horizontal.push({
        value,
        major: isMajor,
        screen: value * viewport.scale + viewport.x,
      });
    }

    const vertical = [];
    for (let value = Math.floor(minY / minorStep) * minorStep; value <= maxY; value += minorStep) {
      const isMajor = Math.round(value / majorStep) * majorStep === value;
      vertical.push({
        value,
        major: isMajor,
        screen: value * viewport.scale + viewport.y,
      });
    }

    return { horizontal, vertical };
  }, [boardSize.height, boardSize.width, viewport.scale, viewport.x, viewport.y, viewportWorldRect.maxX, viewportWorldRect.maxY, viewportWorldRect.minX, viewportWorldRect.minY]);

  const updateElement = useCallback((elementId, updater) => {
    setElements((prev) => prev.map((item) => (
      item.id === elementId ? { ...item, ...(typeof updater === "function" ? updater(item) : updater) } : item
    )));
  }, []);

  const reorderElement = useCallback((elementId, direction) => {
    setElements((prev) => reorderElementSet(prev, [elementId], direction));
  }, []);

  const reorderSelection = useCallback((direction) => {
    if (selectedIds.length === 0) return;
    setElements((prev) => reorderElementSet(prev, selectedIds, direction));
  }, [selectedIds]);

  const groupSelectedElements = useCallback(() => {
    if (selectedIds.length < 2) return;
    const nextGroupId = createElementId("group");
    setElements((prev) => prev.map((item) => (
      selectedIds.includes(item.id) ? { ...item, groupId: nextGroupId } : item
    )));
  }, [selectedIds]);

  const ungroupSelectedElements = useCallback(() => {
    if (selectedIds.length === 0) return;
    setElements((prev) => prev.map((item) => (
      selectedIds.includes(item.id) ? { ...item, groupId: "" } : item
    )));
  }, [selectedIds]);

  const toggleLockSelection = useCallback((nextLocked) => {
    if (selectedIds.length === 0) return;
    setElements((prev) => prev.map((item) => (
      selectedIds.includes(item.id) ? { ...item, locked: nextLocked } : item
    )));
  }, [selectedIds]);

  const toggleLayerLock = useCallback((elementId) => {
    const clusterIds = getGroupedSelectionIds(elementId, elementsRef.current);
    const clusterSet = new Set(clusterIds);
    const target = elementsRef.current.find((item) => item.id === elementId);
    const nextLocked = !target?.locked;
    setElements((prev) => prev.map((item) => (
      clusterSet.has(item.id) ? { ...item, locked: nextLocked } : item
    )));
  }, []);

  const deleteLayerElement = useCallback((elementId) => {
    const removableIds = expandGroupedSelectionIds([elementId], elementsRef.current).filter((id) => {
      const target = elementsRef.current.find((item) => item.id === id);
      return target && !target.locked;
    });
    if (removableIds.length === 0) return;
    const removableSet = new Set(removableIds);
    setElements((prev) => prev.filter((item) => !removableSet.has(item.id)));
    setSelectedIds((prev) => {
      const next = prev.filter((id) => !removableSet.has(id));
      setSelectedId(next[next.length - 1] || "");
      return next;
    });
  }, []);

  const reorderLayerCluster = useCallback((elementId, direction) => {
    const clusterIds = getGroupedSelectionIds(elementId, elementsRef.current);
    setElements((prev) => reorderElementSet(prev, clusterIds, direction));
  }, []);

  const selectAllElements = useCallback(() => {
    const nextIds = elementsRef.current.map((item) => item.id);
    setSelectedIds(nextIds);
    setSelectedId(nextIds[nextIds.length - 1] || "");
  }, []);

  const alignSelection = useCallback((mode) => {
    if (selectedUnlockedElements.length < 2) return;

    const minX = Math.min(...selectedUnlockedElements.map((item) => item.x));
    const maxRight = Math.max(...selectedUnlockedElements.map((item) => item.x + item.width));
    const centerX = (minX + maxRight) / 2;
    const minY = Math.min(...selectedUnlockedElements.map((item) => item.y));
    const maxBottom = Math.max(...selectedUnlockedElements.map((item) => item.y + item.height));
    const centerY = (minY + maxBottom) / 2;
    const selectedSet = new Set(selectedUnlockedElements.map((item) => item.id));

    setElements((prev) => prev.map((item) => {
      if (!selectedSet.has(item.id)) return item;

      if (mode === "left") return { ...item, x: minX };
      if (mode === "center") return { ...item, x: centerX - item.width / 2 };
      if (mode === "right") return { ...item, x: maxRight - item.width };
      if (mode === "top") return { ...item, y: minY };
      if (mode === "middle") return { ...item, y: centerY - item.height / 2 };
      if (mode === "bottom") return { ...item, y: maxBottom - item.height };
      return item;
    }));
  }, [selectedUnlockedElements]);

  const distributeSelection = useCallback((axis) => {
    if (selectedUnlockedElements.length < 3) return;

    const sorted = [...selectedUnlockedElements].sort((a, b) => (
      axis === "x" ? a.x - b.x : a.y - b.y
    ));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalSize = sorted.reduce((sum, item) => (
      sum + (axis === "x" ? item.width : item.height)
    ), 0);
    const available = (axis === "x"
      ? (last.x + last.width) - first.x
      : (last.y + last.height) - first.y) - totalSize;
    const gap = available / (sorted.length - 1);

    const positions = {};
    let cursor = axis === "x" ? first.x : first.y;
    sorted.forEach((item) => {
      positions[item.id] = cursor;
      cursor += (axis === "x" ? item.width : item.height) + gap;
    });

    setElements((prev) => prev.map((item) => {
      if (!(item.id in positions)) return item;
      return axis === "x"
        ? { ...item, x: positions[item.id] }
        : { ...item, y: positions[item.id] };
    }));
  }, [selectedUnlockedElements]);

  const applyCanvasAiScene = useCallback((scene) => {
    if (!scene) return;
    const safeScene = normalizeTemplate(scene);
    setSelectedImageSceneKey(safeScene.scene_key);
    setCanvasAiPrompt(safeScene.starter_prompt || "");
    setCanvasAiResult(null);
    if (safeScene.default_size) {
      setCanvasAiSize(safeScene.default_size);
    }
    if (safeScene.default_model) setCanvasAiModel(normalizeCanvasImageModel(safeScene.default_model));
  }, []);

  const _applyCanvasVideoScene = useCallback((scene) => {
    if (!scene) return;
    const safeScene = normalizeTemplate(scene);
    setSelectedVideoSceneKey(safeScene.scene_key);
    setCanvasVideoPrompt(safeScene.starter_prompt || "");
    setCanvasVideoTask(null);
    if (safeScene.default_size) {
      setCanvasVideoSize(safeScene.default_size);
    }
  }, []);

  const _optimizeCanvasImagePrompt = useCallback(() => {
    const base = canvasAiPrompt.trim() || selectedImageScene?.starter_prompt || "";
    if (!base) {
      toast.error(t("请先填写图片提示词", "Enter an image prompt first"));
      return;
    }
    const suffix = t(
      "主体清晰，构图干净，商业级视觉质感，细节丰富，光影自然，高分辨率，无文字无水印。",
      "Clear subject, clean composition, commercial visual quality, rich detail, natural lighting, high resolution, no text, no watermark.",
    );
    setCanvasAiPrompt(base.includes(suffix) ? base : `${base}\n\n${suffix}`);
  }, [canvasAiPrompt, selectedImageScene?.starter_prompt, t]);

  const _optimizeCanvasVideoPrompt = useCallback(() => {
    const base = canvasVideoPrompt.trim() || selectedVideoScene?.starter_prompt || "";
    if (!base) {
      toast.error(t("请先填写视频提示词", "Enter a video prompt first"));
      return;
    }
    const suffix = t(
      "镜头运动稳定自然，主体始终清晰，适合电商短视频节奏，光影高级，画面干净，无文字无水印。",
      "Stable natural camera motion, consistently clear subject, ecommerce short-video pacing, premium lighting, clean frame, no text, no watermark.",
    );
    setCanvasVideoPrompt(base.includes(suffix) ? base : `${base}\n\n${suffix}`);
  }, [canvasVideoPrompt, selectedVideoScene?.starter_prompt, t]);

  const _applyAgentSuggestion = useCallback(() => {
    const brief = agentBrief.trim();
    const imagePart = selectedImageScene?.starter_prompt || selectedImageScene?.preview_description || "";
    const videoPart = selectedVideoScene?.starter_prompt || selectedVideoScene?.preview_description || "";
    const composed = [brief, imagePart].filter(Boolean).join("\n\n");
    const videoComposed = [brief, videoPart].filter(Boolean).join("\n\n");

    if (composed) setCanvasAiPrompt(composed);
    if (videoComposed) setCanvasVideoPrompt(videoComposed);
    if (!brief && !imagePart && !videoPart) {
      toast.error(t("请先填写智能体目标或选择模板", "Enter an agent goal or select templates first"));
      return;
    }
    toast.success(t("已把智能体建议写入图片/视频提示词", "Agent suggestion applied to image/video prompts"));
  }, [agentBrief, selectedImageScene, selectedVideoScene, t]);

  const closeAgentMentionPicker = useCallback(() => {
    setAgentMentionState((prev) => ({ ...prev, open: false, activeIndex: 0 }));
  }, []);

  const syncAgentMentionState = useCallback((value, caretPosition) => {
    const trigger = getAgentMentionTrigger(value, caretPosition);
    if (!trigger) {
      closeAgentMentionPicker();
      return;
    }
    setAgentMentionState({
      open: true,
      query: trigger.query,
      start: trigger.start,
      end: trigger.end,
      activeIndex: 0,
    });
  }, [closeAgentMentionPicker]);

  const selectAgentMention = useCallback((option) => {
    if (!option) return;
    const mentionText = `@${option.label} `;
    const nextValue = [
      agentBrief.slice(0, agentMentionState.start),
      mentionText,
      agentBrief.slice(agentMentionState.end),
    ].join("");
    const nextCaret = agentMentionState.start + mentionText.length;

    setAgentBrief(nextValue);
    setAgentMentions((prev) => [
      ...prev.filter((item) => item.key !== option.key),
      option,
    ].slice(-12));
    closeAgentMentionPicker();

    window.requestAnimationFrame(() => {
      agentInputRef.current?.focus();
      agentInputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });
  }, [agentBrief, agentMentionState.end, agentMentionState.start, closeAgentMentionPicker]);

  const removeAgentMention = useCallback((key) => {
    setAgentMentions((prev) => prev.filter((item) => item.key !== key));
  }, []);

  const serializeAgentMentions = useCallback((mentions) => mentions.slice(0, 12).map((mention) => ({
    key: mention.key,
    type: mention.type,
    label: mention.label,
    title: mention.title,
    subtitle: mention.subtitle,
    elementId: mention.elementId || "",
    assetId: mention.assetId || "",
    assetType: mention.assetType || "",
    sceneKey: mention.sceneKey || "",
    url: mention.url || "",
    poster: mention.poster || "",
    prompt: mention.prompt || "",
    defaultModel: mention.defaultModel || "",
    defaultSize: mention.defaultSize || "",
  })), []);

  const handleAgentBriefChange = useCallback((event) => {
    const nextValue = event.target.value;
    setAgentBrief(nextValue);
    syncAgentMentionState(nextValue, event.target.selectionStart);
  }, [syncAgentMentionState]);

  const handleAgentInputSelect = useCallback((event) => {
    syncAgentMentionState(event.target.value, event.target.selectionStart);
  }, [syncAgentMentionState]);

  const isCanvasClipboardPlaceholder = useCallback((instruction) => (
    /^\s*\d+\s+StarDraw canvas element\(s\)\s*$/i.test(String(instruction || ""))
  ), []);

  const createAgentMentionFromCanvasElement = useCallback((element) => {
    if (!element?.id) return null;
    const isVideo = element.type === "video";
    const isText = element.type === "text";
    const label = element.title || (isText ? t("便签", "Note") : isVideo ? t("画布视频", "Canvas Video") : t("画布图片", "Canvas Image"));
    return {
      key: `element:${element.id}`,
      type: "element",
      label,
      title: label,
      subtitle: t("画布元素", "Canvas element"),
      icon: isText ? "sticky_note_2" : isVideo ? "movie_filter" : "image",
      elementId: element.id,
      assetType: element.type,
      url: isVideo ? getVideoAssetUrl(element) : getImageAssetUrl(element),
      poster: isVideo ? getVideoPosterUrl(element) : "",
      prompt: element.prompt || element.text || "",
    };
  }, [t]);

  const applyAgentCanvasElementMentions = useCallback((rawElements, inputTarget) => {
    const sourceElements = Array.isArray(rawElements) ? rawElements : [];
    const currentElementMap = new Map(elementsRef.current.map((item) => [item.id, item]));
    const resolvedElements = sourceElements
      .map((item) => currentElementMap.get(item.id) || item)
      .filter((item) => item?.id);
    const mentions = resolvedElements
      .map((item) => createAgentMentionFromCanvasElement(item))
      .filter(Boolean);

    if (mentions.length === 0) return false;

    const knownIds = resolvedElements
      .map((item) => item.id)
      .filter((id) => currentElementMap.has(id));
    if (knownIds.length > 0) {
      setSelectedIds(knownIds);
      setSelectedId(knownIds[knownIds.length - 1] || "");
    }

    setAgentMentions((prev) => [
      ...prev.filter((item) => !mentions.some((mention) => mention.key === item.key)),
      ...mentions,
    ].slice(-12));

    const target = inputTarget || agentInputRef.current;
    const value = target?.value ?? agentBrief;
    const start = Number.isFinite(target?.selectionStart) ? target.selectionStart : value.length;
    const end = Number.isFinite(target?.selectionEnd) ? target.selectionEnd : start;
    const mentionText = `${mentions.map((mention) => `@${mention.label}`).join(" ")} `;
    const nextValue = `${value.slice(0, start)}${mentionText}${value.slice(end)}`;
    const nextCaret = start + mentionText.length;
    setAgentBrief(nextValue);
    closeAgentMentionPicker();

    window.requestAnimationFrame(() => {
      agentInputRef.current?.focus();
      agentInputRef.current?.setSelectionRange(nextCaret, nextCaret);
    });

    toast.success(t("已把画布元素作为 Agent 引用", "Canvas element added as an Agent reference"));
    return true;
  }, [agentBrief, closeAgentMentionPicker, createAgentMentionFromCanvasElement, t]);

  const handleAgentInputPaste = useCallback((event) => {
    const customData = event.clipboardData?.getData("application/x-stardraw-canvas");
    if (customData) {
      try {
        const payload = JSON.parse(customData);
        if (applyAgentCanvasElementMentions(payload?.elements || [], event.currentTarget)) {
          event.preventDefault();
          return;
        }
      } catch {
        // Fall through to plain-text handling below.
      }
    }

    const plainText = event.clipboardData?.getData("text/plain") || "";
    if (isCanvasClipboardPlaceholder(plainText) && selectedElements.length > 0) {
      event.preventDefault();
      applyAgentCanvasElementMentions(selectedElements, event.currentTarget);
    }
  }, [applyAgentCanvasElementMentions, isCanvasClipboardPlaceholder, selectedElements]);

  const updateAgentMessage = useCallback((messageId, patch) => {
    if (!messageId) return;
    setAgentMessages((prev) => prev.map((message) => {
      if (message.id !== messageId) return message;
      const nextPatch = typeof patch === "function" ? patch(message) : patch;
      return { ...message, ...nextPatch };
    }));
  }, []);

  const toggleAgentDetails = useCallback((messageId) => {
    if (!messageId) return;
    setExpandedAgentDetails((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const isPromptRewriteOnlyRequest = useCallback((instruction) => {
    const text = String(instruction || "");
    return /优化|润色|改写|rewrite|polish|optimi[sz]e/i.test(text) && /提示词|prompt/i.test(text);
  }, []);

  const hasGenerationVerb = useCallback((instruction) => (
    /生成|生图|出图|绘制|画|做|制作|来一张|create|generate|draw|make|produce/i.test(String(instruction || ""))
  ), []);

  const hasImageEditIntent = useCallback((instruction) => (
    /改为|改成|修改|编辑|替换|换成|换掉|换背景|去掉|移除|抹掉|擦除|修复|重绘|扩图|改字|字改|文字|文案|字体|replace|edit|change|remove|erase|fix|inpaint|outpaint/i
      .test(String(instruction || ""))
  ), []);

  const shouldAutoGenerateImageFromAgent = useCallback((instruction, actions = []) => {
    const text = String(instruction || "");
    if (isCanvasClipboardPlaceholder(text)) return true;
    if (isPromptRewriteOnlyRequest(text)) return false;
    const hasVideoIntent = /视频|短视频|动画|video|clip|motion/i.test(text);
    const hasImageIntent = /图片|图像|主图|海报|视觉|image|picture|poster|visual/i.test(text);
    const hasImagePromptAction = actions.some((action) => action?.type === "set_image_prompt" && action.prompt);
    const hasGenerationOrEditIntent = hasGenerationVerb(text) || hasImageEditIntent(text);
    if (hasImagePromptAction && !hasVideoIntent) return true;
    if (hasImagePromptAction && hasGenerationOrEditIntent && (!hasVideoIntent || hasImageIntent)) return true;
    if (!hasGenerationOrEditIntent) return false;
    if (hasVideoIntent && !hasImageIntent) return false;
    return hasImageIntent || hasImageEditIntent(text);
  }, [hasGenerationVerb, hasImageEditIntent, isCanvasClipboardPlaceholder, isPromptRewriteOnlyRequest]);

  const shouldAutoGenerateVideoFromAgent = useCallback((instruction, actions = []) => {
    const text = String(instruction || "");
    if (isPromptRewriteOnlyRequest(text)) return false;
    const hasVideoIntent = /视频|短视频|动画|video|clip|motion/i.test(text);
    const hasVideoPromptAction = actions.some((action) => action?.type === "set_video_prompt" && action.prompt);
    if (hasVideoPromptAction && hasVideoIntent) return true;
    if (hasVideoPromptAction && hasGenerationVerb(text)) return true;

    return hasVideoIntent && hasGenerationVerb(text);
  }, [hasGenerationVerb, isPromptRewriteOnlyRequest]);

  const buildAgentImagePrompt = useCallback((instruction) => {
    if (isCanvasClipboardPlaceholder(instruction)) {
      return t(
        "基于当前选中的画布图片生成一张高质量商业图片，保持主体清晰，构图干净，光影自然。",
        "Generate a high-quality commercial image based on the currently selected canvas image, with a clear subject, clean composition, and natural lighting.",
      );
    }
    return String(instruction || "").trim();
  }, [isCanvasClipboardPlaceholder, t]);

  const shouldAgentUseSelectedReferences = useCallback((instruction, action = {}) => {
    const hasReferenceImages = selectedImageElements.length > 0
      || resolveAgentImageReferences(agentRunMentionsRef.current).length > 0;
    if (!hasReferenceImages) return false;
    if (Boolean(action?.useSelection) || isCanvasClipboardPlaceholder(instruction)) return true;

    return /参考|基于|根据|当前|选中|这张|这幅|这个|素材|图片|原图|reference|based on|current|selected|this image|from this|use this/i
      .test(String(instruction || ""));
  }, [isCanvasClipboardPlaceholder, resolveAgentImageReferences, selectedImageElements.length]);

  const applyCanvasAgentPlan = useCallback((plan) => {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];
    if (actions.length === 0) {
      toast.error(t("Agent 没有返回可执行动作", "Agent returned no executable actions"));
      return;
    }

    let nextElements = elementsRef.current.map((item) => ({ ...item }));
    let nextSelectedIds = [...selectedIds];
    let nextProjectModel = {
      ...projectModel,
      storyboard: {
        ...(projectModel.storyboard || {}),
        shots: Array.isArray(projectModel.storyboard?.shots)
          ? projectModel.storyboard.shots.map((shot) => ({ ...shot }))
          : [],
      },
      timeline: {
        ...(projectModel.timeline || {}),
        tracks: Array.isArray(projectModel.timeline?.tracks)
          ? projectModel.timeline.tracks.map((track) => ({
              ...track,
              clips: Array.isArray(track.clips) ? track.clips.map((clip) => ({ ...clip })) : [],
            }))
          : [],
      },
    };
    let elementsChanged = false;
    let selectionChanged = false;
    let projectModelChanged = false;
    let appliedCount = 0;
    let focusTarget = null;
    const center = getBoardCenterWorld();
    const agentMentionMap = new Map((agentRunMentionsRef.current || []).map((mention) => [mention.key, mention]));

    const currentIdSet = () => new Set(nextElements.map((item) => item.id));
    const normalizeIds = (ids) => {
      const knownIds = currentIdSet();
      return [...new Set((Array.isArray(ids) ? ids : [])
        .map((id) => String(id || ""))
        .filter((id) => knownIds.has(id)))];
    };
    const boundsForIds = (ids) => getBoundsFromElements(nextElements.filter((item) => ids.includes(item.id)));
    const setSelection = (ids) => {
      nextSelectedIds = normalizeIds(ids);
      selectionChanged = true;
    };

    actions.forEach((action, actionIndex) => {
      const type = action?.type;

      if (type === "add_storyboard_shot") {
        const shotId = String(action.id || createElementId("shot")).slice(0, 80);
        nextProjectModel.storyboard.shots = [
          ...nextProjectModel.storyboard.shots,
          {
            id: shotId,
            title: String(action.title || t("Agent 镜头", "Agent Shot")).slice(0, 120),
            prompt: String(action.prompt || "").slice(0, 4000),
            description: String(action.description || "").slice(0, 1000),
            duration: clamp(action.duration, 0.1, 3600, 3),
            camera: String(action.camera || "").slice(0, 80),
            style: String(action.style || "").slice(0, 120),
            assetId: String(action.assetId || "").slice(0, 80),
          },
        ];
        projectModelChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "update_storyboard_shot" && action.id) {
        let changed = false;
        nextProjectModel.storyboard.shots = nextProjectModel.storyboard.shots.map((shot) => {
          if (String(shot.id) !== String(action.id)) return shot;
          changed = true;
          const shotPatch = Object.fromEntries(Object.entries(action).filter(([key]) => key !== "type"));
          return { ...shot, ...shotPatch };
        });
        if (changed) {
          projectModelChanged = true;
          appliedCount += 1;
        }
        return;
      }

      if (type === "delete_storyboard_shots") {
        const ids = new Set((Array.isArray(action.ids) ? action.ids : []).map(String));
        const nextShots = nextProjectModel.storyboard.shots.filter((shot) => !ids.has(String(shot.id)));
        if (nextShots.length !== nextProjectModel.storyboard.shots.length) {
          nextProjectModel.storyboard.shots = nextShots;
          projectModelChanged = true;
          appliedCount += 1;
        }
        return;
      }

      if (type === "add_timeline_clip" && action.assetId) {
        const tracks = nextProjectModel.timeline.tracks;
        let trackIndex = tracks.findIndex((track) => String(track.id) === String(action.trackId));
        if (trackIndex < 0) trackIndex = tracks.findIndex((track) => String(track.type || "video") === "video");
        if (trackIndex < 0) {
          tracks.push({ id: createElementId("track"), type: "video", name: t("视频 1", "Video 1"), clips: [] });
          trackIndex = tracks.length - 1;
        }
        const track = tracks[trackIndex];
        track.clips = Array.isArray(track.clips) ? track.clips : [];
        track.clips.push({
          id: String(action.id || createElementId("clip")).slice(0, 80),
          assetId: String(action.assetId).slice(0, 80),
          start: clamp(action.start, 0, 86400, 0),
          duration: clamp(action.duration, 0.1, 86400, 3),
          sourceStart: clamp(action.sourceStart, 0, 86400, 0),
          sourceDuration: clamp(action.sourceDuration, 0, 86400, 0),
        });
        projectModelChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "update_timeline_clip" && action.id) {
        let changed = false;
        nextProjectModel.timeline.tracks = nextProjectModel.timeline.tracks.map((track) => ({
          ...track,
          clips: (Array.isArray(track.clips) ? track.clips : []).map((clip) => {
            if (String(clip.id) !== String(action.id)) return clip;
            changed = true;
            const clipPatch = Object.fromEntries(Object.entries(action).filter(([key]) => key !== "type" && key !== "id"));
            return { ...clip, ...clipPatch };
          }),
        }));
        if (changed) {
          projectModelChanged = true;
          appliedCount += 1;
        }
        return;
      }

      if (type === "delete_timeline_clips") {
        const ids = new Set((Array.isArray(action.ids) ? action.ids : []).map(String));
        let changed = false;
        nextProjectModel.timeline.tracks = nextProjectModel.timeline.tracks.map((track) => {
          const clips = Array.isArray(track.clips) ? track.clips : [];
          const filtered = clips.filter((clip) => !ids.has(String(clip.id)));
          changed = changed || filtered.length !== clips.length;
          return { ...track, clips: filtered };
        });
        if (changed) {
          projectModelChanged = true;
          appliedCount += 1;
        }
        return;
      }

      if (type === "set_director3d") {
        nextProjectModel.director3d = {
          ...(projectModel.director3d || {}),
          enabled: Boolean(action.enabled),
          scene: String(action.scene || "").slice(0, 120),
          lighting: String(action.lighting || "").slice(0, 120),
          environment: String(action.environment || "").slice(0, 120),
          camera: action.camera && typeof action.camera === "object" ? action.camera : (projectModel.director3d?.camera || {}),
        };
        projectModelChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "set_title" && action.title) {
        setCanvasTitle(String(action.title).slice(0, 120));
        appliedCount += 1;
        return;
      }

      if (type === "add_note" && action.text) {
        const width = clamp(action.width, 180, MAX_ELEMENT_SIZE, 360);
        const height = clamp(action.height, 120, MAX_ELEMENT_SIZE, 220);
        const nextId = createElementId("agent_note");
        const nextElement = {
          id: nextId,
          type: "text",
          x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.x - width / 2 + actionIndex * 36),
          y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.y - height / 2 + actionIndex * 36),
          width,
          height,
          title: String(action.title || t("Agent 便签", "Agent Note")).slice(0, 120),
          text: String(action.text || "").slice(0, 4000),
          background: action.background || "#eef2ff",
          color: action.color || "#312e81",
          fontSize: clamp(action.fontSize, 14, 48, 17),
        };
        nextElements = [...nextElements, nextElement];
        setSelection([nextId]);
        focusTarget = {
          minX: nextElement.x,
          minY: nextElement.y,
          maxX: nextElement.x + nextElement.width,
          maxY: nextElement.y + nextElement.height,
        };
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "add_asset") {
        const mention = agentMentionMap.get(action.mentionKey || action.key);
        if (!mention || mention.type !== "asset" || !mention.url) return;
        const isVideo = mention.assetType === "video";
        const width = clamp(action.width, 160, MAX_ELEMENT_SIZE, isVideo ? 360 : 320);
        const height = clamp(action.height, 120, MAX_ELEMENT_SIZE, isVideo ? 202 : 320);
        const nextId = createElementId(isVideo ? "agent_video" : "agent_image");
        const nextElement = {
          id: nextId,
          type: isVideo ? "video" : "image",
          x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.x - width / 2 + actionIndex * 36),
          y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.y - height / 2 + actionIndex * 36),
          width,
          height,
          title: String(action.title || mention.title || mention.label || t("Agent 素材", "Agent Asset")).slice(0, 120),
          creationId: mention.assetId || "",
          src: mention.url,
          poster: isVideo ? mention.poster || "" : "",
          source: "agent_mention_asset",
          objectKey: "",
          prompt: mention.prompt || "",
        };
        nextElements = [...nextElements, nextElement];
        setSelection([nextId]);
        focusTarget = {
          minX: nextElement.x,
          minY: nextElement.y,
          maxX: nextElement.x + nextElement.width,
          maxY: nextElement.y + nextElement.height,
        };
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "update_text" && action.id) {
        let changed = false;
        nextElements = nextElements.map((item) => {
          if (item.id !== action.id || item.type !== "text" || item.locked) return item;
          changed = true;
          return {
            ...item,
            title: action.title ? String(action.title).slice(0, 120) : item.title,
            text: action.text ? String(action.text).slice(0, 4000) : item.text,
            background: action.background || item.background,
            color: action.color || item.color,
            fontSize: action.fontSize ? clamp(action.fontSize, 14, 48, item.fontSize || 17) : item.fontSize,
          };
        });
        elementsChanged = elementsChanged || changed;
        if (changed) appliedCount += 1;
        return;
      }

      if (type === "move_elements") {
        const ids = normalizeIds(action.ids);
        if (ids.length === 0) return;
        const dx = clamp(action.dx, -5000, 5000, 0);
        const dy = clamp(action.dy, -5000, 5000, 0);
        nextElements = nextElements.map((item) => (
          ids.includes(item.id) && !item.locked
            ? {
                ...item,
                x: clamp((item.x || 0) + dx, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, item.x || 0),
                y: clamp((item.y || 0) + dy, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, item.y || 0),
              }
            : item
        ));
        setSelection(ids);
        focusTarget = boundsForIds(ids);
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "arrange_grid") {
        const ids = normalizeIds(action.ids);
        if (ids.length === 0) return;
        const columns = clamp(action.columns, 1, 8, 3);
        const gap = clamp(action.gap, 0, 320, 32);
        const startX = clamp(action.startX, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.x - 360);
        const startY = clamp(action.startY, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, center.y - 220);
        nextElements = nextElements.map((item) => {
          const index = ids.indexOf(item.id);
          if (index < 0 || item.locked) return item;
          const width = action.itemWidth ? clamp(action.itemWidth, 160, MAX_ELEMENT_SIZE, item.width || 320) : item.width;
          const height = action.itemHeight ? clamp(action.itemHeight, 120, MAX_ELEMENT_SIZE, item.height || 240) : item.height;
          const col = index % columns;
          const row = Math.floor(index / columns);
          return {
            ...item,
            width,
            height,
            x: startX + col * ((width || 320) + gap),
            y: startY + row * ((height || 240) + gap),
          };
        });
        setSelection(ids);
        focusTarget = boundsForIds(ids);
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "resize_elements") {
        const ids = normalizeIds(action.ids);
        if (ids.length === 0) return;
        nextElements = nextElements.map((item) => (
          ids.includes(item.id) && !item.locked
            ? {
                ...item,
                width: clamp(action.width, 160, MAX_ELEMENT_SIZE, item.width || 320),
                height: clamp(action.height, 120, MAX_ELEMENT_SIZE, item.height || 240),
              }
            : item
        ));
        setSelection(ids);
        focusTarget = boundsForIds(ids);
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "set_selection") {
        setSelection(action.ids);
        appliedCount += 1;
        return;
      }

      if (type === "set_viewport") {
        setViewport({
          x: clamp(action.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.x),
          y: clamp(action.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, viewportRef.current.y),
          scale: clamp(action.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale),
        });
        appliedCount += 1;
        return;
      }

      if (type === "set_image_prompt" && action.prompt) {
        setCanvasAiPrompt(String(action.prompt).slice(0, 3000));
        setCanvasAiUseSelection(Boolean(action.useSelection));
        if (action.sceneKey && imageScenes.some((scene) => scene.scene_key === action.sceneKey)) {
          setSelectedImageSceneKey(action.sceneKey);
        }
        setShowAiPanel(true);
        appliedCount += 1;
        return;
      }

      if (type === "set_video_prompt" && action.prompt) {
        setCanvasVideoPrompt(String(action.prompt).slice(0, 3000));
        setCanvasVideoUseSelection(Boolean(action.useSelection));
        if (action.sceneKey && videoScenes.some((scene) => scene.scene_key === action.sceneKey)) {
          setSelectedVideoSceneKey(action.sceneKey);
        }
        setShowAiPanel(true);
        appliedCount += 1;
        return;
      }

      if (type === "lock_elements" || type === "unlock_elements") {
        const ids = normalizeIds(action.ids);
        if (ids.length === 0) return;
        nextElements = nextElements.map((item) => (
          ids.includes(item.id) ? { ...item, locked: type === "lock_elements" } : item
        ));
        setSelection(ids);
        elementsChanged = true;
        appliedCount += 1;
        return;
      }

      if (type === "delete_elements") {
        const ids = normalizeIds(action.ids);
        if (ids.length === 0) return;
        nextElements = nextElements.filter((item) => !ids.includes(item.id) || item.locked);
        setSelection([]);
        elementsChanged = true;
        appliedCount += 1;
      }
    });

    if (elementsChanged) {
      setElements(nextElements);
    }
    if (projectModelChanged) {
      setProjectModel(nextProjectModel);
    }
    if (selectionChanged) {
      setSelectedIds(nextSelectedIds);
      setSelectedId(nextSelectedIds[0] || "");
    }
    if (focusTarget) {
      window.requestAnimationFrame(() => {
        focusBounds(focusTarget, {
          motion: "gesture",
          padding: 260,
          maxScale: 2.4,
        });
      });
    }

    setAgentPlan(plan);
    if (appliedCount > 0) {
      toast.success(plan?.summary || t("Agent 已执行画布动作", "Agent applied canvas actions"));
    } else {
      toast.error(t("Agent 返回的动作没有命中当前画布", "Agent actions did not match the current canvas"));
    }
    return { appliedCount, actions };
  }, [focusBounds, getBoardCenterWorld, imageScenes, projectModel, selectedIds, t, videoScenes]);

  const _runLegacyCanvasAgent = useCallback(async (overrideInstruction = "", options = {}) => {
    const instruction = String(overrideInstruction || agentBrief).trim();
    if (!instruction) {
      toast.error(t("请先告诉 Agent 你想怎么调整画布", "Tell the Agent what to do with the canvas first"));
      return;
    }

    if (agentAccessMode !== "full") {
      const modeLabel = agentAccessMode === "ask"
        ? t("每个工具调用都需要确认", "each tool call requires approval")
        : t("本次计划需要确认", "this plan requires approval");
      if (!window.confirm(`${t("StarDraw Agent 将执行", "StarDraw Agent will execute")} ${modeLabel}。\n\n${instruction.slice(0, 600)}`)) {
        return;
      }
    }

    const mentionsForRequest = serializeAgentMentions(
      overrideInstruction && !options.keepMentions ? [] : agentMentionsRef.current,
    );
    agentRunMentionsRef.current = mentionsForRequest;
    const planMessageId = createElementId("agent_plan");
    setAgentRunning(true);
    setAgentBrief("");
    setAgentMentions([]);
    closeAgentMentionPicker();
    setAgentMessages((prev) => [
      ...prev,
      {
        id: createElementId("agent_user"),
        role: "user",
        content: instruction,
        mentions: mentionsForRequest,
      },
      {
        id: planMessageId,
        role: "assistant",
        title: t("Agent 正在执行", "Agent is working"),
        content: t(
          "正在理解你的指令，并选择合适的画布动作、模板或自由生成方式。",
          "Understanding your instruction and choosing the right canvas actions, template, or freeform workflow.",
        ),
        kind: "agent_planning",
        status: "running",
        progress: 18,
        steps: [
          { label: t("理解指令", "Understand instruction"), status: "running" },
          { label: t("选择动作/模板", "Choose actions/templates"), status: "pending" },
          { label: t("执行画布动作", "Apply canvas actions"), status: "pending" },
        ],
      },
    ]);
    try {
      let approvalToken = "";
      if (agentAccessMode === "ask") {
        throw new Error(t("旧版画布 Agent 已停用，请使用独立画布 Agent", "The legacy Canvas Agent is disabled. Use the independent Canvas Agent."));
      }
      const { data } = await authAxios.post("/api/canvases/legacy-agent-disabled", {
        instruction,
        agentMode: agentAccessMode,
        sessionId: agentSessionId,
        approvalToken,
        language: isZh ? "zh" : "en",
        selectedIds,
        canvas: {
          id: activeCanvasId,
          title: canvasTitle,
          state: {
            viewport,
            elements: elementsRef.current,
            ...projectModel,
          },
        },
        templates: {
          image: selectedImageScene ? {
            scene_key: selectedImageScene.scene_key,
            scene_name: selectedImageScene.scene_name,
            starter_prompt: selectedImageScene.starter_prompt,
            default_model: selectedImageScene.default_model,
            default_size: selectedImageScene.default_size,
            requires_reference: Boolean(selectedImageScene.requires_reference),
          } : null,
          video: selectedVideoScene ? {
            scene_key: selectedVideoScene.scene_key,
            scene_name: selectedVideoScene.scene_name,
            starter_prompt: selectedVideoScene.starter_prompt,
            default_model: selectedVideoScene.default_model,
            default_size: selectedVideoScene.default_size,
            requires_reference: Boolean(selectedVideoScene.requires_reference),
          } : null,
          availableImages: compactAgentTemplates(imageScenes, "image"),
          availableVideos: compactAgentTemplates(videoScenes, "video"),
        },
        visualParameters: canvasVisualParameters,
        mentions: mentionsForRequest,
      }, {
        headers: { "X-Idempotency-Key": `canvas-agent:${planMessageId}` },
      });

      if (!data?.success) {
        throw new Error(data?.message || t("Agent 执行失败", "Agent failed"));
      }

      const plan = data.data;
      const actions = Array.isArray(plan?.actions) ? plan.actions : [];
      let approvedActions = actions;
      if (agentAccessMode === "ask") {
        approvedActions = actions.filter((action) => window.confirm(
          `${t("确认执行工具", "Approve tool call")}: ${String(action?.type || "unknown").slice(0, 80)}`,
        ));
      } else if (agentAccessMode === "approve") {
        const sensitiveActions = actions.filter((action) => [
          "delete_elements", "delete_canvas", "publish_template", "external_mcp", "update_model_config",
        ].includes(action?.type));
        if (sensitiveActions.length > 0 && !window.confirm(
          t("计划包含删除、发布、系统配置或外部 MCP 操作，确认继续？", "This plan includes delete, publish, system configuration, or external MCP actions. Continue?"),
        )) {
          approvedActions = actions.filter((action) => !sensitiveActions.includes(action));
        }
      }
      const approvedPlan = { ...plan, actions: approvedActions };
      const execution = applyCanvasAgentPlan(approvedPlan);
      const executableActions = execution?.actions || plan?.actions || [];
      const imagePromptAction = executableActions
        .find((action) => action?.type === "set_image_prompt" && action.prompt);
      const videoPromptAction = executableActions
        .find((action) => action?.type === "set_video_prompt" && action.prompt);
      const willAutoGenerateImage = agentAccessMode !== "ask"
        && shouldAutoGenerateImageFromAgent(instruction, executableActions);
      const willAutoGenerateVideo = agentAccessMode !== "ask"
        && shouldAutoGenerateVideoFromAgent(instruction, executableActions);
      const referenceImagesForRequest = resolveAgentImageReferences(mentionsForRequest);
      const promptDrafts = executableActions
        .filter((action) => (
          (action?.type === "set_image_prompt" || action?.type === "set_video_prompt")
          && String(action.prompt || "").trim()
        ))
        .map((action) => ({
          type: action.type,
          label: action.type === "set_image_prompt"
            ? t("图片提示词", "Image prompt")
            : t("视频提示词", "Video prompt"),
          prompt: String(action.prompt || "").trim(),
          sceneKey: action.sceneKey || "",
          visualParameters: action.visualParameters || {},
          useSelection: shouldAgentUseSelectedReferences(instruction, action),
          autoRun: action.type === "set_image_prompt" ? willAutoGenerateImage : willAutoGenerateVideo,
          referenceImages: referenceImagesForRequest,
        }));
      const promptDraftText = promptDrafts
        .map((draft) => `${draft.label}:\n${draft.prompt}`)
        .join("\n\n");
      const isAutoGenerating = willAutoGenerateImage || willAutoGenerateVideo;
      if (promptDraftText && !isAutoGenerating && isPromptRewriteOnlyRequest(instruction)) {
        setAgentBrief(promptDraftText);
        window.requestAnimationFrame(() => {
          agentInputRef.current?.focus();
        });
      }
      const autoRunLines = [
        willAutoGenerateImage ? t("图片生成已自动开始，完成后会放入画布。", "Image generation started automatically and will be added to the canvas.") : "",
        willAutoGenerateVideo ? t("视频生成已自动开始，完成后会放入画布。", "Video generation started automatically and will be added to the canvas.") : "",
      ].filter(Boolean);
      updateAgentMessage(planMessageId, {
        title: isAutoGenerating
          ? t("已开始自动执行", "Auto execution started")
          : t("已完成画布指令", "Canvas command completed"),
        content: [
          plan?.summary || t("已执行画布动作", "Canvas actions applied"),
          ...autoRunLines,
        ].filter(Boolean).join("\n\n"),
        status: "completed",
        progress: 100,
        steps: [
          { label: t("理解指令", "Understand instruction"), status: "completed" },
          { label: t("选择动作/模板", "Choose actions/templates"), status: "completed" },
          { label: t("执行画布动作", "Apply canvas actions"), status: "completed" },
          ...(isAutoGenerating ? [{ label: t("启动自动生成", "Start automatic generation"), status: "completed" }] : []),
        ],
        actions: approvedPlan.actions || [],
        appliedCount: execution?.appliedCount || 0,
        promptDrafts,
        provider: plan?.provider || "agent",
        model: plan?.model || "",
      });

      if (willAutoGenerateImage) {
        setPendingAgentImageGeneration({
          id: createElementId("agent_image_request"),
          prompt: String(imagePromptAction?.prompt || buildAgentImagePrompt(instruction)).slice(0, 3000),
          sceneKey: imagePromptAction?.sceneKey || "",
          useSelection: shouldAgentUseSelectedReferences(instruction, imagePromptAction),
          referenceImages: referenceImagesForRequest,
          visualParameters: imagePromptAction?.visualParameters || canvasVisualParameters,
        });
      }

      if (willAutoGenerateVideo) {
        setPendingAgentVideoGeneration({
          id: createElementId("agent_video_request"),
          prompt: String(videoPromptAction?.prompt || instruction).slice(0, 3000),
          sceneKey: videoPromptAction?.sceneKey || "",
          useSelection: shouldAgentUseSelectedReferences(instruction, videoPromptAction),
          referenceImages: referenceImagesForRequest,
          visualParameters: videoPromptAction?.visualParameters || canvasVisualParameters,
        });
      }
    } catch (err) {
      const message = err.response?.data?.message || err.message || t("Agent 执行失败", "Agent failed");
      updateAgentMessage(planMessageId, {
        title: t("Agent 执行失败", "Agent failed"),
        content: message,
        status: "failed",
        progress: 100,
        error: true,
        steps: [
          { label: t("理解指令", "Understand instruction"), status: "completed" },
          { label: t("选择动作/模板", "Choose actions/templates"), status: "failed" },
          { label: t("执行画布动作", "Apply canvas actions"), status: "pending" },
        ],
      });
      toast.error(message);
    } finally {
      setAgentRunning(false);
    }
  }, [
    activeCanvasId,
    agentAccessMode,
    agentBrief,
    agentSessionId,
    applyCanvasAgentPlan,
    authAxios,
    buildAgentImagePrompt,
    canvasTitle,
    canvasVisualParameters,
    closeAgentMentionPicker,
    isZh,
    imageScenes,
    isPromptRewriteOnlyRequest,
    projectModel,
    resolveAgentImageReferences,
    selectedIds,
    selectedImageScene,
    selectedVideoScene,
    serializeAgentMentions,
    shouldAutoGenerateImageFromAgent,
    shouldAutoGenerateVideoFromAgent,
    shouldAgentUseSelectedReferences,
    t,
    updateAgentMessage,
    videoScenes,
    viewport,
  ]);

  const runCanvasAgent = useCallback(async (overrideInstruction = "", options = {}) => {
    const instruction = String(overrideInstruction || agentBrief).trim();
    if (!instruction) {
      toast.error(t("请先告诉 Agent 你想怎么调整画布", "Tell the Agent what to do with the canvas first"));
      return;
    }
    if (agentRunning) return;
    if (!activeCanvasId) {
      toast.error(t("请先创建或打开一个画布", "Create or open a canvas first"));
      return;
    }
    if (!agentSessionId || agentConversationLoading) {
      toast.error(t("Agent 对话正在加载，请稍候", "The Agent conversation is still loading"));
      return;
    }

    const mentionsForRequest = serializeAgentMentions(
      overrideInstruction && !options.keepMentions ? [] : agentMentionsRef.current,
    );
    const messageId = createElementId("agent_react");

    setAgentRunning(true);
    setAgentBrief("");
    setAgentMentions([]);
    closeAgentMentionPicker();
    setAgentMessages((previous) => [
      ...previous,
      { id: createElementId("agent_user"), role: "user", content: instruction, mentions: mentionsForRequest },
      {
        id: messageId,
        role: "assistant",
        title: t("画布 Agent 已接收", "Canvas Agent received the request"),
        content: t(
          "当前画布已保存。独立画布 Agent 将根据真实工具结果逐步执行。",
          "The canvas is saved. The independent Canvas Agent will proceed step by step from real tool results.",
        ),
        kind: "agent_reactive",
        status: "running",
        progress: 5,
        steps: [
          { label: t("保存当前画布", "Save current canvas"), status: "running" },
          { label: t("启动逐步执行", "Start step-by-step execution"), status: "pending" },
        ],
      },
    ]);

    try {
      const savedCanvas = await saveCanvas();
      if (!savedCanvas) throw new Error(t("当前画布保存失败，Agent 未启动", "The canvas could not be saved, so Agent was not started"));
      window.localStorage.setItem("stardraw_active_canvas_id", String(activeCanvasId));
      updateAgentMessage(messageId, {
        title: t("请使用独立画布 Agent", "Use the independent Canvas Agent"),
        content: t("请在当前画布 Agent 面板中查看实时步骤、审批和结果。", "Follow live steps, approvals, and results in the Canvas Agent panel."),
        status: "completed",
        progress: 100,
        steps: [
          { label: t("保存当前画布", "Save current canvas"), status: "completed" },
          { label: t("启动逐步执行", "Start step-by-step execution"), status: "completed" },
        ],
      });
    } catch (error) {
      const message = error.response?.data?.message || error.message || t("Agent 启动失败", "Agent could not start");
      updateAgentMessage(messageId, {
        title: t("Agent 启动失败", "Agent could not start"),
        content: message,
        status: "failed",
        progress: 100,
        error: true,
      });
      toast.error(message);
    } finally {
      setAgentRunning(false);
    }
  }, [
    activeCanvasId,
    agentBrief,
    agentConversationLoading,
    agentRunning,
    agentSessionId,
    closeAgentMentionPicker,
    saveCanvas,
    serializeAgentMentions,
    t,
    updateAgentMessage,
  ]);

  const startNewCanvasAgentConversation = useCallback(async () => {
    if (agentRunning || agentConversationLoading || !activeCanvasId) return;
    try {
      if (agentConversationHydratedRef.current && agentSessionId) await persistCurrentCanvasAgentConversation();
      agentConversationHydratedRef.current = false;
      setAgentMessages([]);
      setAgentBrief("");
      setAgentMentions([]);
      setExpandedAgentDetails(new Set());
      closeAgentMentionPicker();
      await createAgentConversation({ title: t("新对话", "New conversation") });
      setAgentHistoryOpen(false);
    } catch (error) {
      toast.error(error.response?.data?.message || t("新建对话失败", "Unable to create conversation"));
    }
  }, [activeCanvasId, agentConversationLoading, agentRunning, agentSessionId, closeAgentMentionPicker, createAgentConversation, persistCurrentCanvasAgentConversation, t]);

  const selectCanvasAgentConversation = useCallback(async (conversationId) => {
    if (!conversationId || conversationId === agentSessionId || agentRunning || agentConversationLoading) {
      setAgentHistoryOpen(false);
      return;
    }
    try {
      if (agentConversationHydratedRef.current && agentSessionId) await persistCurrentCanvasAgentConversation();
      agentConversationHydratedRef.current = false;
      await openAgentConversation(conversationId);
      setAgentHistoryOpen(false);
    } catch (error) {
      toast.error(error.response?.data?.message || t("对话记录加载失败", "Unable to load conversation"));
    }
  }, [agentConversationLoading, agentRunning, agentSessionId, openAgentConversation, persistCurrentCanvasAgentConversation, t]);

  const handleAgentInputKeyDown = useCallback((event) => {
    if (agentMentionState.open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAgentMentionState((prev) => ({
          ...prev,
          activeIndex: agentMentionOptions.length > 0
            ? (prev.activeIndex + 1) % agentMentionOptions.length
            : 0,
        }));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAgentMentionState((prev) => ({
          ...prev,
          activeIndex: agentMentionOptions.length > 0
            ? (prev.activeIndex - 1 + agentMentionOptions.length) % agentMentionOptions.length
            : 0,
        }));
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && activeMentionIndex >= 0) {
        event.preventDefault();
        selectAgentMention(agentMentionOptions[activeMentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeAgentMentionPicker();
        return;
      }
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void runCanvasAgent();
  }, [
    activeMentionIndex,
    agentMentionOptions,
    agentMentionState.open,
    closeAgentMentionPicker,
    runCanvasAgent,
    selectAgentMention,
  ]);

  const addTextNote = () => {
    const center = getBoardCenterWorld();
    const nextId = createElementId("note");
    const nextElement = {
      id: nextId,
      type: "text",
      x: center.x - 160,
      y: center.y - 110,
      width: 320,
      height: 220,
      title: t("便签", "Note"),
      text: t("在这里记录镜头、构图、提示词或剪辑思路。", "Capture composition notes, prompts, or shot ideas here."),
      background: ui.soft,
      color: ui.text,
      fontSize: 18,
    };

    setElements((prev) => [
      ...prev,
      nextElement,
    ]);
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 260,
        maxScale: 2.8,
      });
    });
  };

  const addAssetToCanvas = useCallback((asset, options = {}) => {
    const center = getBoardCenterWorld();
    const normalizedType = String(asset?.type || asset?.media_type || "").toLowerCase();
    const isVideo = normalizedType === "video";
    const isAudio = normalizedType === "audio";
    const nextId = createElementId(isVideo ? "video" : isAudio ? "audio" : "image");
    const nextElement = createCanvasAssetElement({
      asset,
      elementId: nextId,
      center,
      position: options.position,
      fallbackTitle: t("生成资产", "Generated Asset"),
    });

    if (!nextElement) {
      if (options.showError !== false) {
        toast.error(t("这个素材当前无法加入画布", "This asset cannot be added to the canvas right now"));
      }
      return null;
    }

    setElements((prev) => [...prev, nextElement]);
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 300,
        maxScale: isVideo ? 2.2 : 2.8,
      });
    });
    return nextElement;
  }, [focusBounds, getBoardCenterWorld, t]);

  useEffect(() => {
    if (loading || !activeCanvasId) return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem("stardraw_canvas_import_asset");
    if (!raw) return;

    try {
      const asset = JSON.parse(raw);
      window.sessionStorage.removeItem("stardraw_canvas_import_asset");
      if (!canUseAsset(asset)) {
        toast.error(t("这个历史素材暂时不能加入画布", "This history asset cannot be added to the canvas right now"));
        return;
      }
      setAssets((prev) => [asset, ...prev.filter((item) => String(item.id) !== String(asset.id))].slice(0, 32));
      addAssetToCanvas(asset);
      toast.success(t("历史素材已加入画布", "History asset added to canvas"));
    } catch {
      window.sessionStorage.removeItem("stardraw_canvas_import_asset");
      toast.error(t("导入历史素材失败", "Failed to import history asset"));
    }
  }, [activeCanvasId, addAssetToCanvas, loading, location.search, t]);

  const addGeneratedImageToCanvas = useCallback((generation, scene, promptText, options = {}) => {
    const imageUrl = generation?.content || generation?.thumbnail_url;
    if (!imageUrl) {
      toast.error(t("生成结果没有可用图片地址", "Generated result has no usable image URL"));
      return null;
    }

    const center = getBoardCenterWorld();
    const displaySize = parseCanvasImageSize(canvasAiSize);
    const anchorElement = options.anchorElement || null;
    const nextId = createElementId("ai_image");
    const nextElement = {
      id: nextId,
      type: "image",
      x: Number.isFinite(anchorElement?.x) ? anchorElement.x : center.x - displaySize.width / 2,
      y: Number.isFinite(anchorElement?.y) ? anchorElement.y : center.y - displaySize.height / 2,
      width: displaySize.width,
      height: displaySize.height,
      title: scene?.scene_name || scene?.preview_title || t("AI 图片", "AI Image"),
      creationId: generation.creation_id || "",
      src: imageUrl,
      poster: "",
      source: "ai_generation",
      objectKey: "",
      prompt: promptText,
      shotId: options.shotId || "",
      storyboardShotId: options.shotId || "",
      generationType: "image",
    };

    setElements((prev) => {
      if (!options.replaceElementId) return [...prev, nextElement];
      return prev.map((item) => (item.id === options.replaceElementId ? nextElement : item));
    });
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    setAssets((prev) => [{
      id: generation.creation_id,
      type: "image",
      status: "completed",
      scene_name: nextElement.title,
      title: nextElement.title,
      content: imageUrl,
      points_cost: generation.points_charged || 0,
      expires_at: generation.expires_at,
    }, ...prev].filter((item) => item.id).slice(0, 32));

    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 300,
        maxScale: 2.8,
      });
    });

    return nextElement;
  }, [canvasAiSize, focusBounds, getBoardCenterWorld, t]);

  const addGeneratedVideoToCanvas = useCallback((generation, scene, promptText, options = {}) => {
    const videoUrl = generation?.content || generation?.preview_video_url;
    if (!videoUrl) {
      toast.error(t("生成结果没有可用视频地址", "Generated result has no usable video URL"));
      return null;
    }

    const center = getBoardCenterWorld();
    const nextId = createElementId("ai_video");
    const anchorElement = options.anchorElement || null;
    const width = 380;
    const height = canvasVideoSize === "720x1280" ? 676 : 214;
    const nextElement = {
      id: nextId,
      type: "video",
      x: Number.isFinite(anchorElement?.x) ? anchorElement.x : center.x - width / 2,
      y: Number.isFinite(anchorElement?.y) ? anchorElement.y : center.y - height / 2,
      width,
      height,
      title: scene?.scene_name || scene?.preview_title || t("AI 视频", "AI Video"),
      creationId: generation.creation_id || "",
      src: videoUrl,
      poster: generation.thumbnail_url || generation.preview_image_url || "",
      source: "ai_video_generation",
      objectKey: "",
      prompt: promptText,
      shotId: options.shotId || "",
      storyboardShotId: options.shotId || "",
      generationType: "video",
    };

    setElements((prev) => {
      if (!options.replaceElementId) return [...prev, nextElement];
      return prev.map((item) => (item.id === options.replaceElementId ? nextElement : item));
    });
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    setAssets((prev) => [{
      id: generation.creation_id,
      type: "video",
      status: "completed",
      scene_name: nextElement.title,
      title: nextElement.title,
      content: videoUrl,
      preview_video_url: videoUrl,
      thumbnail_url: nextElement.poster,
      points_cost: generation.points_charged || 0,
      expires_at: generation.expires_at,
    }, ...prev].filter((item) => item.id).slice(0, 32));

    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 320,
        maxScale: 2.2,
      });
    });

    return nextElement;
  }, [canvasVideoSize, focusBounds, getBoardCenterWorld, t]);

  const handleWorkflowCanvasResult = useCallback(({ element, nodeKey, anchor, ordinal = 0 }) => {
    const rect = boardRef.current?.getBoundingClientRect();
    const merged = mergeWorkflowCanvasMediaElement({
      elements: elementsRef.current,
      element,
      nodeKey,
      anchor,
      viewport: viewportRef.current,
      boardSize: {
        width: rect?.width || boardSize.width,
        height: rect?.height || boardSize.height,
      },
      ordinal,
    });
    if (!merged.inserted || !merged.element) return;

    // Cancel a pending save of the pre-workflow snapshot before publishing the
    // merged state. The next render schedules a save containing both local edits
    // and the server-created media element.
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    elementsRef.current = merged.elements;
    setElements(merged.elements);
    setSelectedId(merged.element.id);
    setSelectedIds([merged.element.id]);
    setAssets((current) => [{
      id: merged.element.creationId,
      type: merged.element.type,
      status: "completed",
      scene_name: merged.element.title,
      title: merged.element.title,
      content: merged.element.src,
      preview_video_url: merged.element.type === "video" ? merged.element.src : "",
      thumbnail_url: merged.element.poster || "",
      prompt: merged.element.prompt || "",
      source: "workflow_generation",
    }, ...current.filter((asset) => String(asset.id) !== String(merged.element.creationId))]
      .filter((asset) => asset.id)
      .slice(0, 32));

    window.requestAnimationFrame(() => {
      focusBounds({
        minX: Number.isFinite(Number(anchor?.x)) ? Math.min(Number(anchor.x), merged.element.x) : merged.element.x,
        minY: Number.isFinite(Number(anchor?.y)) ? Math.min(Number(anchor.y), merged.element.y) : merged.element.y,
        maxX: merged.element.x + merged.element.width,
        maxY: merged.element.y + merged.element.height,
      }, {
        motion: "gesture",
        padding: merged.element.type === "video" ? 320 : 300,
        maxScale: merged.element.type === "video" ? 2.2 : 2.8,
      });
    });
    toast.success(merged.element.type === "video"
      ? t("工作流视频已加入画布", "Workflow video added to canvas")
      : t("工作流图片已加入画布", "Workflow image added to canvas"));
  }, [boardSize.height, boardSize.width, focusBounds, t]);

  const downloadCanvasMediaElement = useCallback(async (element) => {
    if (!element || !["image", "video", "audio"].includes(element.type)) return;

    const fallbackUrl = element.type === "video" ? getVideoAssetUrl(element) : element.type === "audio" ? getAudioAssetUrl(element) : getImageAssetUrl(element);
    const extension = element.type === "video" ? "mp4" : element.type === "audio" ? "mp3" : "png";
    const baseName = String(element.title || element.type || "asset")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 80) || "asset";

    try {
      let providerDownloadError = null;
      if (element.creationId) {
        try {
        const { data } = await authAxios.get(`/api/user/creations/${element.creationId}/download`);
        const downloadUrl = data?.data?.download_url;
        if (downloadUrl) {
          createDownload(await resolvePrivateUrl(downloadUrl), `${baseName}.${extension}`);
          return;
        }
        } catch (err) {
          providerDownloadError = err;
        }
      }

      if (!fallbackUrl) {
        throw providerDownloadError || new Error(t("没有可下载的素材地址", "No downloadable asset URL"));
      }

      const authorizedFallbackUrl = await resolvePrivateUrl(fallbackUrl);
      const response = await fetch(getFetchableAssetUrl(authorizedFallbackUrl), { credentials: "include" });
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      createDownload(url, `${baseName}.${getAssetExtensionFromMime(blob.type, extension)}`);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || t("下载失败", "Download failed"));
    }
  }, [authAxios, resolvePrivateUrl, t]);

  const addAiGenerationPlaceholderToCanvas = useCallback((scene, promptText, usingReferences, options = {}) => {
    const center = getBoardCenterWorld();
    const width = 340;
    const height = 190;
    const nextId = createElementId("ai_task");
    const x = selectedBounds
      ? selectedBounds.maxX + 36
      : center.x - width / 2;
    const y = selectedBounds
      ? selectedBounds.minY
      : center.y - height / 2;
    const nextElement = {
      id: nextId,
      type: "text",
      x,
      y,
      width,
      height,
      title: t("AI 生成中", "AI Generating"),
      text: `${usingReferences ? t("正在基于所选图片生成修改版。", "Generating an edited version from the selected image.") : t("正在生成新图片。", "Generating a new image.")}\n\n${scene?.default_model || "nano-banana-2"} · ${scene?.scene_name || scene?.scene_key || t("图片模型", "Image model")}\n\n${promptText.slice(0, 180)}`,
      background: ui.goldSoft,
      color: ui.gold,
      fontSize: 16,
      source: "ai_generation_pending",
      shotId: options.shotId || "",
      storyboardShotId: options.shotId || "",
      generationType: "image",
    };

    setElements((prev) => [...prev, nextElement]);
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 320,
        maxScale: 2.4,
      });
    });

    return nextElement;
  }, [focusBounds, getBoardCenterWorld, selectedBounds, t, ui]);

  const addAiVideoPlaceholderToCanvas = useCallback((scene, promptText, usingReferences, options = {}) => {
    const center = getBoardCenterWorld();
    const width = 360;
    const height = 210;
    const nextId = createElementId("ai_video_task");
    const x = selectedBounds
      ? selectedBounds.maxX + 36
      : center.x - width / 2;
    const y = selectedBounds
      ? selectedBounds.minY
      : center.y - height / 2;
    const nextElement = {
      id: nextId,
      type: "text",
      x,
      y,
      width,
      height,
      title: t("AI 视频生成中", "AI Video Generating"),
      text: `${usingReferences ? t("正在基于所选图片生成视频。", "Generating video from the selected image.") : t("正在生成新视频。", "Generating a new video.")}\n\n${scene?.default_model || "video"} · ${scene?.scene_name || scene?.scene_key || t("视频模型", "Video model")}\n\n${promptText.slice(0, 180)}`,
      background: ui.blueSoft,
      color: ui.blue,
      fontSize: 16,
      source: "ai_video_pending",
      shotId: options.shotId || "",
      storyboardShotId: options.shotId || "",
      generationType: "video",
    };

    setElements((prev) => [...prev, nextElement]);
    setSelectedId(nextId);
    setSelectedIds([nextId]);
    window.requestAnimationFrame(() => {
      focusBounds({
        minX: nextElement.x,
        minY: nextElement.y,
        maxX: nextElement.x + nextElement.width,
        maxY: nextElement.y + nextElement.height,
      }, {
        motion: "gesture",
        padding: 320,
        maxScale: 2.2,
      });
    });

    return nextElement;
  }, [focusBounds, getBoardCenterWorld, selectedBounds, t, ui]);

  const uploadAssetFile = useCallback(async (file, { idempotencyKey = null, position = null } = {}) => {
    if (!file) return null;

    setUploadingAsset(true);
    try {
      const uploadKey = idempotencyKey || createElementId("canvas_upload");
      let uploadedAsset;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          uploadedAsset = await uploadCanvasAsset({
            client: authAxios,
            file,
            idempotencyKey: uploadKey,
          });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const status = Number(error.response?.status || 0);
          const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
          if (!retryable || attempt === 2) throw error;
          await waitForCanvasRetry(400 * (attempt + 1));
        }
      }
      if (lastError) throw lastError;

      const addedElement = addAssetToCanvas(uploadedAsset, { position, showError: false });
      if (!addedElement) {
        throw new Error(t("这个素材当前无法加入画布", "This asset cannot be added to the canvas right now"));
      }
      setAssets((prev) => [uploadedAsset, ...prev].slice(0, 32));
      return uploadedAsset;
    } finally {
      setUploadingAsset(false);
    }
  }, [addAssetToCanvas, authAxios, t]);

  const openAssetPicker = useCallback(() => {
    if (_uploadingAsset) return;
    const input = assetInputRef.current;
    if (!input) {
      toast.error(t("素材选择器暂时不可用", "The asset picker is temporarily unavailable"));
      return;
    }

    // Reset before opening so selecting the same file twice still emits change.
    input.value = "";
    try {
      if (typeof input.showPicker === "function") {
        input.showPicker();
        return;
      }
    } catch {
      // Some browsers expose showPicker but only allow the legacy click path.
    }
    input.click();
  }, [_uploadingAsset, t]);

  const handleCanvasAiGenerate = useCallback(async (options = {}) => {
    const shotId = String(options.shotId || "");
    const reportFailure = (error) => options.onFailed?.(error instanceof Error ? error : new Error(String(error || "generation failed")));
    const requestedScene = options.sceneOverride || selectedImageScene;
    const promptText = String(options.promptOverride ?? canvasAiPrompt).trim();
    const agentProgress = Boolean(options.agentProgress);
    const progressMessageId = options.progressMessageId || (agentProgress ? createElementId("agent_image_progress") : "");
    const optionReferenceImages = Array.isArray(options.referenceImages)
      ? options.referenceImages.filter((item) => getImageAssetUrl(item)).slice(0, 4)
      : [];
    const referenceImageItems = optionReferenceImages.length > 0 ? optionReferenceImages : selectedImageElements;
    const shouldUseReferences = (options.useSelection ?? canvasAiUseSelection) && referenceImageItems.length > 0;
    const scene = resolveImageSceneForGeneration(requestedScene, shouldUseReferences);
    const sceneSwitchNotice = describeSceneSwitch(requestedScene, scene, shouldUseReferences, "image");
    if (!scene) {
      const message = t("请先选择图片模板", "Select an image template first");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("图片生成未开始", "Image generation not started"),
          content: t("无法生成图片：请先选择图片模板。", "Cannot generate image: select an image template first."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (requestedScene?.scene_key && scene.scene_key !== requestedScene.scene_key) {
      setSelectedImageSceneKey(scene.scene_key);
    }
    if (!promptText) {
      const message = t("请填写生成或修改要求", "Enter generation or edit instructions");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("图片生成未开始", "Image generation not started"),
          content: t("无法生成图片：缺少图片提示词。", "Cannot generate image: image prompt is missing."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }

    if (scene.requires_reference && !shouldUseReferences) {
      const message = t("这个模板需要先选中画布里的图片作为参考", "This template needs a selected canvas image as reference");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("图片生成未开始", "Image generation not started"),
          content: t("无法生成图片：这个模板需要先选中画布里的参考图片。", "Cannot generate image: this template needs selected reference images on the canvas."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (shouldUseReferences && !canvasImageSupportsReferences) {
      const message = t(
        "当前图片模型不支持参考图，请改选支持图片编辑的模型",
        "The selected image model does not support references. Choose an image-edit model.",
      );
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("图片生成未开始", "Image generation not started"),
          content: message,
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (canvasImageSubmitRef.current) return;

    canvasImageSubmitRef.current = true;
    setCanvasAiGenerating(true);
    setCanvasAiResult(null);
    const selectedVisualParameters = options.visualParameters || canvasVisualParameters;
    const retryDraft = {
      type: "set_image_prompt",
      label: t("图片提示词", "Image prompt"),
      prompt: promptText,
      sceneKey: scene.scene_key,
      useSelection: shouldUseReferences,
      referenceImages: referenceImageItems,
      visualParameters: selectedVisualParameters,
    };
    if (agentProgress) {
      setAgentMessages((prev) => [...prev, {
        id: progressMessageId,
        role: "assistant",
        title: shouldUseReferences
          ? t("正在修改图片", "Editing image")
          : t("正在生成图片", "Generating image"),
        content: [
          sceneSwitchNotice,
          shouldUseReferences
            ? t("已开始基于所选图片生成修改版，通常需要几十秒。", "Started editing from the selected image. This usually takes tens of seconds.")
            : t("已开始生成图片，通常需要几十秒。", "Started generating the image. This usually takes tens of seconds."),
        ].filter(Boolean).join("\n\n"),
        kind: "image_generation",
        status: "running",
        progress: 35,
        steps: [
          { label: t("理解指令", "Understand instruction"), status: "completed" },
          {
            label: sceneSwitchNotice
              ? t("自动切换可用模板", "Switch template automatically")
              : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
            status: "completed",
          },
          {
            label: shouldUseReferences
              ? t("读取参考图", "Read reference images")
              : t("准备生成参数", "Prepare generation parameters"),
            status: "running",
          },
          { label: t("写入画布", "Add to canvas"), status: "pending" },
        ],
        actions: [{ type: "generate_image" }],
      }]);
    }
    const placeholder = addAiGenerationPlaceholderToCanvas(scene, promptText, shouldUseReferences, { shotId });
    options.onPlaceholder?.(placeholder);

    try {
      const formData = new FormData();
      formData.append("scene_key", scene.scene_key);
      formData.append("user_prompt", promptText);
      formData.append("model", canvasAiModel || scene.default_model || "nano-banana-2");
      formData.append("size", canvasAiSize);
      formData.append("visual_parameters", JSON.stringify(selectedVisualParameters));

      if (shouldUseReferences) {
        const referenceFiles = await Promise.all(
          referenceImageItems.map((item, index) => fetchCanvasImageAsFile(getImageAssetUrl(item), index, resolvePrivateUrl)),
        );
        referenceFiles.forEach((file) => formData.append("images", file));
      }

      const { data } = await authAxios.post("/api/ai/generate-scene-image", formData);
      setCanvasAiResult(data);
      if (data?.status !== "completed" || !data?.content) {
        throw new Error(data?.message || t("生成失败", "Generation failed"));
      }

      const generatedElement = addGeneratedImageToCanvas(data, scene, promptText, {
        replaceElementId: placeholder?.id,
        anchorElement: placeholder,
        shotId,
      });
      options.onCompleted?.({ element: generatedElement, generation: data, scene, prompt: promptText });
      if (agentProgress) {
        updateAgentMessage(progressMessageId, {
          title: shouldUseReferences
            ? t("图片修改完成", "Image edit completed")
            : t("图片生成完成", "Image generation completed"),
          content: [
            sceneSwitchNotice,
            shouldUseReferences
              ? t("图片修改完成，已加入画布。", "Image edit completed and was added to the canvas.")
              : t("图片生成完成，已加入画布。", "Image generation completed and was added to the canvas."),
          ].filter(Boolean).join("\n\n"),
          status: "completed",
          progress: 100,
          steps: [
            { label: t("理解指令", "Understand instruction"), status: "completed" },
            {
              label: sceneSwitchNotice
                ? t("自动切换可用模板", "Switch template automatically")
                : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
              status: "completed",
            },
            {
              label: shouldUseReferences
                ? t("读取参考图", "Read reference images")
                : t("提交图片生成", "Submit image generation"),
              status: "completed",
            },
            { label: t("写入画布", "Add to canvas"), status: "completed" },
          ],
          imageUrl: data.content,
          creationId: data.creation_id,
          actions: [{ type: "image_completed" }],
        });
      }
      window.dispatchEvent(new Event("stardraw:points-updated"));
      toast.success(shouldUseReferences
        ? t("图片修改完成，已加入画布", "Image edited and added to canvas")
        : t("图片生成完成，已加入画布", "Image generated and added to canvas"));
    } catch (err) {
      const errData = err.response?.data;
      if (errData?.code === "INSUFFICIENT_POINTS") {
        toast.error(t(
          `积分不足，需要 ${errData.required_points}，当前 ${errData.available_points}`,
          `Insufficient points — need ${errData.required_points}, have ${errData.available_points}`,
        ));
      } else {
        toast.error(errData?.message || err.message || t("AI 图片生成失败", "AI image generation failed"));
      }
      if (agentProgress) {
        updateAgentMessage(progressMessageId, {
          title: t("图片生成失败", "Image generation failed"),
          content: [
            sceneSwitchNotice,
            `${t("图片生成失败。", "Image generation failed.")}\n\n${errData?.message || err.message || t("未知错误", "Unknown error")}`,
          ].filter(Boolean).join("\n\n"),
          status: "failed",
          progress: 100,
          steps: [
            { label: t("理解指令", "Understand instruction"), status: "completed" },
            {
              label: sceneSwitchNotice
                ? t("自动切换可用模板", "Switch template automatically")
                : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
              status: "completed",
            },
            { label: t("提交图片生成", "Submit image generation"), status: "failed" },
            { label: t("写入画布", "Add to canvas"), status: "pending" },
          ],
          error: true,
          actions: [{ type: "image_failed" }],
          retryDraft,
        });
      }
      if (placeholder?.id) {
        updateElement(placeholder.id, {
          title: t("AI 生成失败", "AI Generation Failed"),
          text: `${t("这次生成没有完成，原图未受影响。", "This generation did not complete. The original image was not changed.")}\n\n${errData?.message || err.message || t("未知错误", "Unknown error")}`,
          background: ui.dangerSoft,
          color: ui.danger,
        });
      }
      reportFailure(err);
    } finally {
      window.dispatchEvent(new Event("stardraw:points-updated"));
      canvasImageSubmitRef.current = false;
      setCanvasAiGenerating(false);
    }
  }, [
    addAiGenerationPlaceholderToCanvas,
    addGeneratedImageToCanvas,
    authAxios,
    canvasAiPrompt,
    canvasAiModel,
    canvasVisualParameters,
    canvasAiSize,
    canvasAiUseSelection,
    canvasImageSupportsReferences,
    describeSceneSwitch,
    resolveImageSceneForGeneration,
    resolvePrivateUrl,
    selectedImageElements,
    selectedImageScene,
    t,
    ui,
    updateElement,
    updateAgentMessage,
  ]);

  const pollCanvasVideoTask = useCallback((creationId, placeholder, scene, promptText, options = {}) => {
    let attempts = 0;
    const shotId = String(options.shotId || "");
    const progressMessageId = options.progressMessageId || "";
    const retryDraft = options.retryDraft || null;
    const sceneSwitchNotice = options.sceneSwitchNotice || "";
    const tick = async () => {
      attempts += 1;
      try {
        const { data } = await authAxios.get(`/api/ai/video-status/${creationId}`);
        setCanvasVideoTask(data);

        if (data.status === "completed") {
          window.dispatchEvent(new Event("stardraw:points-updated"));
          const generatedElement = addGeneratedVideoToCanvas(data, scene, promptText, {
            replaceElementId: placeholder?.id,
            anchorElement: placeholder,
            shotId,
          });
          options.onCompleted?.({ element: generatedElement, generation: data, scene, prompt: promptText });
          if (progressMessageId) {
            updateAgentMessage(progressMessageId, {
              title: t("视频生成完成", "Video generation completed"),
              content: [
                sceneSwitchNotice,
                t("视频生成完成，已加入画布。", "Video generation completed and was added to the canvas."),
              ].filter(Boolean).join("\n\n"),
              status: "completed",
              progress: 100,
              videoUrl: data.content || data.preview_video_url || "",
              poster: data.thumbnail_url || data.preview_image_url || "",
              creationId,
              actions: [{ type: "video_completed" }],
            });
            updateAgentMessage(progressMessageId, (message) => ({
              steps: Array.isArray(message.steps)
                ? message.steps.map((step) => ({ ...step, status: "completed" }))
                : undefined,
            }));
          }
          toast.success(t("视频生成完成，已加入画布", "Video generated and added to canvas"));
          canvasVideoSubmitRef.current = false;
          setCanvasVideoGenerating(false);
          return;
        }

        if (data.status === "failed") {
          window.dispatchEvent(new Event("stardraw:points-updated"));
          updateElement(placeholder.id, {
            title: t("AI 视频生成失败", "AI Video Failed"),
            text: `${t("视频任务失败，积分已按后端状态处理。", "Video task failed. Points were handled by the backend state.")}\n\n${data.error_message || t("未知错误", "Unknown error")}`,
            background: ui.dangerSoft,
            color: ui.danger,
          });
          if (progressMessageId) {
            updateAgentMessage(progressMessageId, {
              title: t("视频生成失败", "Video generation failed"),
              content: [
                sceneSwitchNotice,
                `${t("视频生成失败。", "Video generation failed.")}\n\n${data.error_message || t("未知错误", "Unknown error")}`,
              ].filter(Boolean).join("\n\n"),
              status: "failed",
              progress: 100,
              error: true,
              actions: [{ type: "video_failed" }],
              retryDraft,
            });
            updateAgentMessage(progressMessageId, (message) => ({
              steps: Array.isArray(message.steps)
                ? message.steps.map((step, index) => ({
                  ...step,
                  status: index <= 2 ? "completed" : index === 3 ? "failed" : "pending",
                }))
                : undefined,
            }));
          }
          toast.error(data.error_message || t("AI 视频生成失败", "AI video generation failed"));
          options.onFailed?.(new Error(data.error_message || t("AI 视频生成失败", "AI video generation failed")));
          canvasVideoSubmitRef.current = false;
          setCanvasVideoGenerating(false);
          return;
        }

        if (progressMessageId && attempts === 1) {
          updateAgentMessage(progressMessageId, {
            title: t("正在轮询视频结果", "Polling video result"),
            content: [
              sceneSwitchNotice,
              t("视频任务已提交，正在轮询生成状态。视频通常需要更久，请保持页面打开。", "Video task submitted. Polling generation status. Videos usually take longer; keep this page open."),
            ].filter(Boolean).join("\n\n"),
            status: "running",
            progress: 58,
          });
        }

        if (attempts < 90) {
          window.setTimeout(tick, 4000);
        } else {
          updateElement(placeholder.id, {
            title: t("AI 视频仍在生成", "AI Video Still Running"),
            text: t("任务仍在后台生成，可稍后到历史记录或重新打开画布查看。", "The task is still running. Check history or reopen the canvas later."),
            background: ui.goldSoft,
            color: ui.gold,
          });
          if (progressMessageId) {
            updateAgentMessage(progressMessageId, {
              title: t("视频仍在后台生成", "Video still running"),
              content: [
                sceneSwitchNotice,
                t("视频仍在后台生成。你可以稍后在历史记录或重新打开画布查看结果。", "The video is still generating in the background. Check History or reopen the canvas later."),
              ].filter(Boolean).join("\n\n"),
              status: "running",
              progress: 82,
              actions: [{ type: "video_still_running" }],
            });
            updateAgentMessage(progressMessageId, (message) => ({
              steps: Array.isArray(message.steps)
                ? message.steps.map((step, index) => ({
                  ...step,
                  status: index <= 2 ? "completed" : index === 3 ? "running" : "pending",
                }))
                : undefined,
            }));
          }
          canvasVideoSubmitRef.current = false;
          setCanvasVideoGenerating(false);
        }
      } catch (err) {
        if (attempts < 5) {
          window.setTimeout(tick, 5000);
          return;
        }
        updateElement(placeholder.id, {
          title: t("视频状态查询失败", "Video Status Failed"),
          text: err.response?.data?.message || err.message || t("状态查询失败", "Status polling failed"),
          background: ui.dangerSoft,
          color: ui.danger,
        });
        if (progressMessageId) {
          updateAgentMessage(progressMessageId, {
            title: t("视频状态查询失败", "Video status failed"),
            content: [
              sceneSwitchNotice,
              `${t("视频状态查询失败。", "Video status polling failed.")}\n\n${err.response?.data?.message || err.message || t("状态查询失败", "Status polling failed")}`,
            ].filter(Boolean).join("\n\n"),
            status: "failed",
            progress: 100,
            error: true,
            actions: [{ type: "video_status_failed" }],
            retryDraft,
          });
          updateAgentMessage(progressMessageId, (message) => ({
            steps: Array.isArray(message.steps)
              ? message.steps.map((step, index) => ({
                ...step,
                status: index <= 2 ? "completed" : index === 3 ? "failed" : "pending",
              }))
              : undefined,
          }));
        }
        options.onFailed?.(err instanceof Error ? err : new Error(t("视频状态查询失败", "Video status failed")));
        canvasVideoSubmitRef.current = false;
        setCanvasVideoGenerating(false);
      }
    };

    window.setTimeout(tick, 3500);
  }, [addGeneratedVideoToCanvas, authAxios, t, ui, updateAgentMessage, updateElement]);

  const handleCanvasVideoGenerate = useCallback(async (options = {}) => {
    const shotId = String(options.shotId || "");
    const reportFailure = (error) => options.onFailed?.(error instanceof Error ? error : new Error(String(error || "generation failed")));
    const requestedScene = options.sceneOverride || selectedVideoScene;
    const promptText = String(options.promptOverride ?? canvasVideoPrompt).trim();
    const agentProgress = Boolean(options.agentProgress);
    const progressMessageId = options.progressMessageId || (agentProgress ? createElementId("agent_video_progress") : "");
    const optionReferenceImages = Array.isArray(options.referenceImages)
      ? options.referenceImages.filter((item) => getImageAssetUrl(item)).slice(0, 1)
      : [];
    const referenceImageItems = optionReferenceImages.length > 0 ? optionReferenceImages : selectedImageElements;
    const shouldUseReferences = (options.useSelection ?? canvasVideoUseSelection) && referenceImageItems.length > 0;
    const scene = resolveVideoSceneForGeneration(requestedScene, shouldUseReferences);
    const sceneSwitchNotice = describeSceneSwitch(requestedScene, scene, shouldUseReferences, "video");
    if (!scene) {
      const message = t("请先选择视频模板", "Select a video template first");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("视频生成未开始", "Video generation not started"),
          content: t("无法生成视频：请先选择视频模板。", "Cannot generate video: select a video template first."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (requestedScene?.scene_key && scene.scene_key !== requestedScene.scene_key) {
      setSelectedVideoSceneKey(scene.scene_key);
    }
    if (!promptText) {
      const message = t("请填写视频生成要求", "Enter video generation instructions");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("视频生成未开始", "Video generation not started"),
          content: t("无法生成视频：缺少视频提示词。", "Cannot generate video: video prompt is missing."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }

    if (scene.requires_reference && !shouldUseReferences) {
      const message = t("这个视频模板需要先选中一张图片作为参考", "This video template needs a selected image as reference");
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("视频生成未开始", "Video generation not started"),
          content: t("无法生成视频：这个模板需要先选中画布里的参考图片。", "Cannot generate video: this template needs a selected reference image on the canvas."),
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (shouldUseReferences && !canvasVideoSupportsReferences) {
      const message = t(
        "当前视频模型不支持参考图，请改选支持图生视频的模型",
        "The selected video model does not support references. Choose an image-to-video model.",
      );
      toast.error(message);
      reportFailure(new Error(message));
      if (agentProgress) {
        setAgentMessages((prev) => [...prev, {
          id: progressMessageId,
          role: "assistant",
          title: t("视频生成未开始", "Video generation not started"),
          content: message,
          status: "failed",
          error: true,
        }]);
      }
      return;
    }
    if (canvasVideoSubmitRef.current) return;

    canvasVideoSubmitRef.current = true;
    setCanvasVideoGenerating(true);
    setCanvasVideoTask(null);
    const selectedVisualParameters = options.visualParameters || canvasVisualParameters;
    const retryDraft = {
      type: "set_video_prompt",
      label: t("视频提示词", "Video prompt"),
      prompt: promptText,
      sceneKey: scene.scene_key,
      useSelection: shouldUseReferences,
      referenceImages: referenceImageItems.slice(0, 1),
      visualParameters: selectedVisualParameters,
    };
    if (agentProgress) {
      setAgentMessages((prev) => [...prev, {
        id: progressMessageId,
        role: "assistant",
        title: shouldUseReferences
          ? t("正在用参考图生成视频", "Generating video from reference")
          : t("正在生成视频", "Generating video"),
        content: [
          sceneSwitchNotice,
          shouldUseReferences
            ? t("已开始基于所选图片生成视频，正在提交任务。", "Started generating a video from the selected image. Submitting the task.")
            : t("已开始生成视频，正在提交任务。", "Started generating the video. Submitting the task."),
        ].filter(Boolean).join("\n\n"),
        kind: "video_generation",
        status: "running",
        progress: 20,
        steps: [
          { label: t("理解指令", "Understand instruction"), status: "completed" },
          {
            label: sceneSwitchNotice
              ? t("自动切换可用模板", "Switch template automatically")
              : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
            status: "completed",
          },
          { label: t("提交视频任务", "Submit video task"), status: "running" },
          { label: t("轮询生成结果", "Poll generation result"), status: "pending" },
          { label: t("写入画布", "Add to canvas"), status: "pending" },
        ],
        actions: [{ type: "generate_video" }],
      }]);
    }
    const placeholder = addAiVideoPlaceholderToCanvas(scene, promptText, shouldUseReferences, { shotId });
    options.onPlaceholder?.(placeholder);

    try {
      const formData = new FormData();
      formData.append("scene_key", scene.scene_key);
      formData.append("user_prompt", promptText);
      formData.append("model", canvasVideoModel || scene.default_model || "");
      formData.append("size", canvasVideoSize);
      formData.append("visual_parameters", JSON.stringify(selectedVisualParameters));

      if (shouldUseReferences) {
        const file = await fetchCanvasImageAsFile(getImageAssetUrl(referenceImageItems[0]), 0, resolvePrivateUrl);
        formData.append("images", file);
      }

      const { data } = await authAxios.post("/api/ai/generate-sora-video", formData);
      if (!data?.success || !data?.creation_id) {
        throw new Error(data?.message || t("视频任务提交失败", "Video task submission failed"));
      }

      setCanvasVideoTask(data);
      options.onSubmitted?.(data);
      window.dispatchEvent(new Event("stardraw:points-updated"));
      if (agentProgress) {
        updateAgentMessage(progressMessageId, {
          title: t("视频任务已提交", "Video task submitted"),
          content: [
            sceneSwitchNotice,
            t("视频任务已提交，正在等待供应商返回结果。", "Video task submitted. Waiting for the provider result."),
          ].filter(Boolean).join("\n\n"),
          status: "running",
          progress: 45,
          steps: [
            { label: t("理解指令", "Understand instruction"), status: "completed" },
            {
              label: sceneSwitchNotice
                ? t("自动切换可用模板", "Switch template automatically")
                : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
              status: "completed",
            },
            { label: t("提交视频任务", "Submit video task"), status: "completed" },
            { label: t("轮询生成结果", "Poll generation result"), status: "running" },
            { label: t("写入画布", "Add to canvas"), status: "pending" },
          ],
          creationId: data.creation_id,
          actions: [{ type: "video_submitted" }],
          retryDraft,
        });
      }
      toast(t("视频任务已提交，生成完成后会自动放入画布", "Video task submitted. It will be added to the canvas when ready."), { icon: "⏳" });
      pollCanvasVideoTask(data.creation_id, placeholder, scene, promptText, {
        progressMessageId,
        retryDraft,
        sceneSwitchNotice,
        shotId,
        onCompleted: options.onCompleted,
        onFailed: options.onFailed,
      });
    } catch (err) {
      const errData = err.response?.data;
      if (errData?.code === "INSUFFICIENT_POINTS") {
        toast.error(t(
          `积分不足，需要 ${errData.required_points}，当前 ${errData.available_points}`,
          `Insufficient points — need ${errData.required_points}, have ${errData.available_points}`,
        ));
      } else {
        toast.error(errData?.message || err.message || t("AI 视频生成失败", "AI video generation failed"));
      }
      if (agentProgress) {
        updateAgentMessage(progressMessageId, {
          title: t("视频提交失败", "Video submission failed"),
          content: [
            sceneSwitchNotice,
            `${t("视频生成任务提交失败。", "Video generation task submission failed.")}\n\n${errData?.message || err.message || t("未知错误", "Unknown error")}`,
          ].filter(Boolean).join("\n\n"),
          status: "failed",
          progress: 100,
          steps: [
            { label: t("理解指令", "Understand instruction"), status: "completed" },
            {
              label: sceneSwitchNotice
                ? t("自动切换可用模板", "Switch template automatically")
                : t(`选择模板：${scene.scene_name || scene.scene_key}`, `Choose template: ${scene.scene_name || scene.scene_key}`),
              status: "completed",
            },
            { label: t("提交视频任务", "Submit video task"), status: "failed" },
            { label: t("轮询生成结果", "Poll generation result"), status: "pending" },
            { label: t("写入画布", "Add to canvas"), status: "pending" },
          ],
          error: true,
          actions: [{ type: "video_submit_failed" }],
          retryDraft,
        });
      }
      updateElement(placeholder.id, {
        title: t("AI 视频生成失败", "AI Video Failed"),
        text: `${t("任务未能提交，原画布内容未受影响。", "The task was not submitted. Existing canvas content is unchanged.")}\n\n${errData?.message || err.message || t("未知错误", "Unknown error")}`,
        background: ui.dangerSoft,
        color: ui.danger,
      });
      reportFailure(err);
      canvasVideoSubmitRef.current = false;
      setCanvasVideoGenerating(false);
      window.dispatchEvent(new Event("stardraw:points-updated"));
    }
  }, [
    addAiVideoPlaceholderToCanvas,
    authAxios,
    canvasVideoModel,
    canvasVideoPrompt,
    canvasVideoSize,
    canvasVisualParameters,
    canvasVideoUseSelection,
    canvasVideoSupportsReferences,
    describeSceneSwitch,
    pollCanvasVideoTask,
    resolveVideoSceneForGeneration,
    resolvePrivateUrl,
    selectedImageElements,
    selectedVideoScene,
    t,
    ui,
    updateAgentMessage,
    updateElement,
  ]);

  const patchStoryboardShot = useCallback((shotId, patch) => {
    setProjectModel((current) => ({
      ...current,
      storyboard: {
        ...(current.storyboard || {}),
        shots: (Array.isArray(current.storyboard?.shots) ? current.storyboard.shots : []).map((shot) => (
          String(shot?.id || "") === String(shotId)
            ? { ...shot, ...(typeof patch === "function" ? patch(shot) : patch) }
            : shot
        )),
      },
    }));
  }, []);

  const finishStoryboardGeneration = useCallback((shot, generationType, payload) => {
    const element = payload?.element;
    if (!element?.id) {
      patchStoryboardShot(shot.id, {
        generationStatus: "failed",
        generationError: t("生成结果无法写入画布", "The generated result could not be added to the canvas"),
        pendingElementId: null,
      });
      return;
    }

    setProjectModel((current) => {
      const currentShots = Array.isArray(current.storyboard?.shots) ? current.storyboard.shots : [];
      const currentShot = currentShots.find((item) => String(item?.id || "") === String(shot.id));
      if (!currentShot) return current;
      let completedShot = {
        ...currentShot,
        elementId: element.id,
        pendingElementId: null,
        generationType,
        generationStatus: "completed",
        generationError: "",
        creationId: payload?.generation?.creation_id || element.creationId || null,
        resultUrl: generationType === "video" ? getVideoAssetUrl(element) : getImageAssetUrl(element),
        generatedAt: new Date().toISOString(),
      };
      let timeline = current.timeline;
      if (currentShot.timelineClipId) {
        const result = upsertStoryboardTimelineClip({
          timeline,
          shot: completedShot,
          element,
          createId: createElementId,
          trackName: t("分镜轨道", "Storyboard"),
        });
        timeline = result.timeline;
        completedShot = {
          ...completedShot,
          timelineClipId: result.clipId,
          timelineTrackId: result.trackId,
        };
      }
      return {
        ...current,
        timeline,
        storyboard: {
          ...(current.storyboard || {}),
          shots: currentShots.map((item) => (
            String(item?.id || "") === String(shot.id) ? completedShot : item
          )),
        },
      };
    });
  }, [patchStoryboardShot, t]);

  const failStoryboardGeneration = useCallback((shotId, error) => {
    patchStoryboardShot(shotId, {
      generationStatus: "failed",
      generationError: String(error?.response?.data?.message || error?.message || t("生成失败", "Generation failed")).slice(0, 500),
      pendingElementId: null,
    });
  }, [patchStoryboardShot, t]);

  const composeStoryboardPrompt = useCallback((shot) => [
    String(shot?.prompt || "").trim(),
    shot?.description ? `${t("镜头描述", "Shot description")}: ${String(shot.description).trim()}` : "",
    shot?.camera ? `${t("摄影与运镜", "Camera")}: ${String(shot.camera).trim()}` : "",
    shot?.style ? `${t("画风", "Visual style")}: ${String(shot.style).trim()}` : "",
  ].filter(Boolean).join("\n"), [t]);

  const generateStoryboardImage = useCallback((shot) => {
    const prompt = composeStoryboardPrompt(shot);
    if (!prompt) {
      toast.error(t("请先填写镜头提示词", "Enter a shot prompt first"));
      return;
    }
    patchStoryboardShot(shot.id, {
      generationType: "image",
      generationStatus: "generating",
      generationError: "",
      pendingElementId: null,
    });
    void handleCanvasAiGenerate({
      shotId: shot.id,
      promptOverride: prompt,
      useSelection: canvasAiUseSelection,
      visualParameters: canvasVisualParameters,
      onPlaceholder: (element) => patchStoryboardShot(shot.id, { pendingElementId: element?.id || null }),
      onCompleted: (payload) => finishStoryboardGeneration(shot, "image", payload),
      onFailed: (error) => failStoryboardGeneration(shot.id, error),
    });
  }, [canvasAiUseSelection, canvasVisualParameters, composeStoryboardPrompt, failStoryboardGeneration, finishStoryboardGeneration, handleCanvasAiGenerate, patchStoryboardShot, t]);

  const generateStoryboardVideo = useCallback((shot) => {
    const prompt = composeStoryboardPrompt(shot);
    if (!prompt) {
      toast.error(t("请先填写镜头提示词", "Enter a shot prompt first"));
      return;
    }
    const boundImage = getStoryboardBoundElement(shot, elementsRef.current);
    const shotReferenceImages = boundImage?.type === "image" ? [boundImage] : [];
    patchStoryboardShot(shot.id, {
      generationType: "video",
      generationStatus: "generating",
      generationError: "",
      pendingElementId: null,
    });
    void handleCanvasVideoGenerate({
      shotId: shot.id,
      promptOverride: prompt,
      useSelection: shotReferenceImages.length > 0 ? true : canvasVideoUseSelection,
      referenceImages: shotReferenceImages,
      visualParameters: canvasVisualParameters,
      onPlaceholder: (element) => patchStoryboardShot(shot.id, { pendingElementId: element?.id || null }),
      onSubmitted: (generation) => patchStoryboardShot(shot.id, { creationId: generation?.creation_id || null }),
      onCompleted: (payload) => finishStoryboardGeneration(shot, "video", payload),
      onFailed: (error) => failStoryboardGeneration(shot.id, error),
    });
  }, [canvasVideoUseSelection, canvasVisualParameters, composeStoryboardPrompt, failStoryboardGeneration, finishStoryboardGeneration, handleCanvasVideoGenerate, patchStoryboardShot, t]);

  const addStoryboardShotToTimeline = useCallback((shot, elementOverride = null) => {
    const element = elementOverride || getStoryboardBoundElement(shot, elementsRef.current);
    if (!element) {
      toast.error(t("请先为镜头生成图片或视频", "Generate an image or video for this shot first"));
      return;
    }
    let result = null;
    setProjectModel((current) => {
      result = upsertStoryboardTimelineClip({
        timeline: current.timeline,
        shot,
        element,
        createId: createElementId,
        trackName: t("分镜轨道", "Storyboard"),
      });
      return {
        ...current,
        timeline: result.timeline,
        storyboard: {
          ...(current.storyboard || {}),
          shots: (Array.isArray(current.storyboard?.shots) ? current.storyboard.shots : []).map((item) => (
            String(item?.id || "") === String(shot.id)
              ? { ...item, timelineClipId: result.clipId, timelineTrackId: result.trackId }
              : item
          )),
        },
      };
    });
    toast.success(shot.timelineClipId
      ? t("时间线片段已更新", "Timeline clip updated")
      : t("镜头已加入时间线", "Shot added to timeline"));
  }, [t]);

  const focusStoryboardElement = useCallback((elementId) => {
    const element = elementsRef.current.find((item) => String(item?.id || "") === String(elementId));
    if (!element) return;
    setWorkspaceMode("canvas");
    setSelectedId(element.id);
    setSelectedIds([element.id]);
    window.requestAnimationFrame(() => focusBounds({
      minX: element.x,
      minY: element.y,
      maxX: element.x + element.width,
      maxY: element.y + element.height,
    }, { motion: "gesture", padding: 300, maxScale: element.type === "video" ? 2.2 : 2.8 }));
  }, [focusBounds]);

  const copyAgentText = useCallback(async (text) => {
    const value = String(text || "");
    if (!value.trim()) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      toast.success(t("已复制提示词", "Prompt copied"));
    } catch {
      toast.error(t("复制失败", "Copy failed"));
    }
  }, [t]);

  const applyAgentPromptDraft = useCallback((draft, options = {}) => {
    if (!draft?.prompt) return;
    const updateInput = options.updateInput !== false;
    const showToast = options.showToast !== false;
    const prompt = String(draft.prompt || "").slice(0, 3000);
    if (draft.type === "set_video_prompt") {
      setCanvasVideoPrompt(prompt);
      setCanvasVideoUseSelection(Boolean(draft.useSelection));
      setCanvasVisualParameters(draft.visualParameters || {});
      if (draft.sceneKey && videoScenes.some((scene) => scene.scene_key === draft.sceneKey)) {
        setSelectedVideoSceneKey(draft.sceneKey);
      }
      if (updateInput) setAgentBrief(prompt);
      if (showToast) toast.success(t("已填入视频提示词", "Video prompt applied"));
      return;
    }

    setCanvasAiPrompt(prompt);
    setCanvasAiUseSelection(Boolean(draft.useSelection));
    setCanvasVisualParameters(draft.visualParameters || {});
    if (draft.sceneKey && imageScenes.some((scene) => scene.scene_key === draft.sceneKey)) {
      setSelectedImageSceneKey(draft.sceneKey);
    }
    if (updateInput) setAgentBrief(prompt);
    if (showToast) toast.success(t("已填入图片提示词", "Image prompt applied"));
  }, [imageScenes, t, videoScenes]);

  const generateFromAgentPromptDraft = useCallback((draft) => {
    if (!draft?.prompt) return;
    applyAgentPromptDraft(draft, { updateInput: false, showToast: false });

    if (draft.type === "set_video_prompt") {
      const scene = draft.sceneKey
        ? videoScenes.find((item) => item.scene_key === draft.sceneKey) || selectedVideoScene
        : freeformVideoScene || selectedVideoScene;
      void handleCanvasVideoGenerate({
        sceneOverride: scene,
        promptOverride: draft.prompt,
        useSelection: Boolean(draft.useSelection),
        referenceImages: draft.referenceImages || [],
        visualParameters: draft.visualParameters || {},
        agentProgress: true,
      });
      return;
    }

    const scene = draft.sceneKey
      ? imageScenes.find((item) => item.scene_key === draft.sceneKey) || selectedImageScene
      : freeformImageScene || selectedImageScene;
    void handleCanvasAiGenerate({
      sceneOverride: scene,
      promptOverride: draft.prompt,
      useSelection: Boolean(draft.useSelection),
      referenceImages: draft.referenceImages || [],
      visualParameters: draft.visualParameters || {},
      agentProgress: true,
    });
  }, [
    applyAgentPromptDraft,
    freeformImageScene,
    freeformVideoScene,
    handleCanvasAiGenerate,
    handleCanvasVideoGenerate,
    imageScenes,
    selectedImageScene,
    selectedVideoScene,
    videoScenes,
  ]);

  useEffect(() => {
    if (!pendingAgentImageGeneration) return;
    const request = pendingAgentImageGeneration;
    setPendingAgentImageGeneration(null);
    const scene = request.sceneKey
      ? imageScenes.find((item) => item.scene_key === request.sceneKey) || selectedImageScene
      : freeformImageScene || selectedImageScene;

    void handleCanvasAiGenerate({
      sceneOverride: scene,
      promptOverride: request.prompt,
      useSelection: request.useSelection,
      referenceImages: request.referenceImages || [],
      visualParameters: request.visualParameters || {},
      agentProgress: true,
      progressMessageId: request.id,
    });
  }, [freeformImageScene, handleCanvasAiGenerate, imageScenes, pendingAgentImageGeneration, selectedImageScene]);

  useEffect(() => {
    if (!pendingAgentVideoGeneration) return;
    const request = pendingAgentVideoGeneration;
    setPendingAgentVideoGeneration(null);
    const scene = request.sceneKey
      ? videoScenes.find((item) => item.scene_key === request.sceneKey) || selectedVideoScene
      : freeformVideoScene || selectedVideoScene;

    void handleCanvasVideoGenerate({
      sceneOverride: scene,
      promptOverride: request.prompt,
      useSelection: request.useSelection,
      referenceImages: request.referenceImages || [],
      visualParameters: request.visualParameters || {},
      agentProgress: true,
      progressMessageId: request.id,
    });
  }, [freeformVideoScene, handleCanvasVideoGenerate, pendingAgentVideoGeneration, selectedVideoScene, videoScenes]);

  const copySelectedElements = useCallback(() => {
    if (selectedElements.length === 0) return null;

    const payload = {
      source: "stardraw-canvas",
      version: 1,
      canvasId: activeCanvasId,
      copiedAt: Date.now(),
      elements: selectedElements.map((item) => ({
        ...item,
      })),
    };

    clipboardRef.current = payload;
    return payload;
  }, [activeCanvasId, selectedElements]);

  const pasteCanvasElements = useCallback((payload) => {
    const copiedElements = Array.isArray(payload?.elements) ? payload.elements : [];
    if (copiedElements.length === 0) return false;

    const groupMap = {};
    const newIds = [];
    const bounds = copiedElements.reduce((acc, item) => ({
      minX: Math.min(acc.minX, item.x),
      minY: Math.min(acc.minY, item.y),
      maxX: Math.max(acc.maxX, item.x + item.width),
      maxY: Math.max(acc.maxY, item.y + item.height),
    }), {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    });

    const sameCanvas = payload?.canvasId && payload.canvasId === activeCanvasId;
    const center = getBoardCenterWorld();
    const offsetX = sameCanvas
      ? 48
      : center.x - (bounds.minX + Math.max(1, bounds.maxX - bounds.minX) / 2);
    const offsetY = sameCanvas
      ? 48
      : center.y - (bounds.minY + Math.max(1, bounds.maxY - bounds.minY) / 2);

    const duplicates = copiedElements.map((item) => {
      const nextItem = {
        ...item,
        id: createElementId(item.type || "item"),
        x: Number(item.x || 0) + offsetX,
        y: Number(item.y || 0) + offsetY,
        groupId: item.groupId
          ? (groupMap[item.groupId] ||= createElementId("group"))
          : "",
      };
      newIds.push(nextItem.id);
      return nextItem;
    });

    setElements((prev) => [...prev, ...duplicates]);
    setSelectedId(newIds[newIds.length - 1] || "");
    setSelectedIds(newIds);
    return true;
  }, [activeCanvasId, getBoardCenterWorld]);

  const duplicateElementBatch = useCallback((items, options = {}) => {
    const groupMap = {};
    const idMap = {};
    const offsetX = options.offsetX ?? 36;
    const offsetY = options.offsetY ?? 36;

    const duplicates = items.map((item) => {
      const nextId = createElementId(item.type || "item");
      idMap[item.id] = nextId;
      return {
        ...item,
        id: nextId,
        x: Number(item.x || 0) + offsetX,
        y: Number(item.y || 0) + offsetY,
        groupId: item.groupId
          ? (groupMap[item.groupId] ||= createElementId("group"))
          : "",
      };
    });

    return { duplicates, idMap };
  }, []);

  const duplicateSelected = useCallback(() => {
    if (selectedElements.length === 0) return;
    const { duplicates } = duplicateElementBatch(selectedElements);
    setElements((prev) => [...prev, ...duplicates]);
    setSelectedId(duplicates[duplicates.length - 1]?.id || "");
    setSelectedIds(duplicates.map((item) => item.id));
  }, [duplicateElementBatch, selectedElements]);

  const getMinimapWorldPointFromClient = useCallback((clientX, clientY) => {
    const rect = document.getElementById("canvas-minimap")?.getBoundingClientRect();
    if (!rect) return null;

    const localX = clamp(clientX - rect.left, 0, rect.width, rect.width / 2);
    const localY = clamp(clientY - rect.top, 0, rect.height, rect.height / 2);
    return {
      x: (localX - minimapMetrics.offsetX) / minimapMetrics.scale + minimapBounds.minX,
      y: (localY - minimapMetrics.offsetY) / minimapMetrics.scale + minimapBounds.minY,
    };
  }, [minimapBounds.minX, minimapBounds.minY, minimapMetrics.offsetX, minimapMetrics.offsetY, minimapMetrics.scale]);

  const navigateMinimap = useCallback((clientX, clientY, options = {}) => {
    const worldPoint = getMinimapWorldPointFromClient(clientX, clientY);
    if (!worldPoint || !boardSize.width || !boardSize.height) return;

    const worldX = worldPoint.x;
    const worldY = worldPoint.y;
    const baseViewport = viewportRef.current;
    const nextViewport = {
      ...baseViewport,
      x: boardSize.width / 2 - worldX * baseViewport.scale,
      y: boardSize.height / 2 - worldY * baseViewport.scale,
    };
    const response = options.response == null
      ? getGestureResponse(
          VIEWPORT_GESTURE_PAN_RESPONSE,
          VIEWPORT_GESTURE_PAN_RESPONSE_MAX,
          getViewportGestureIntensity(baseViewport, nextViewport),
        )
      : clamp(
          options.response,
          VIEWPORT_GESTURE_PAN_RESPONSE,
          VIEWPORT_GESTURE_PAN_RESPONSE_MAX,
          VIEWPORT_GESTURE_PAN_RESPONSE_MAX,
        );

    animateViewportGestureTo(nextViewport, {
      response,
    });
  }, [animateViewportGestureTo, boardSize.height, boardSize.width, getGestureResponse, getMinimapWorldPointFromClient, getViewportGestureIntensity]);

  const deleteSelected = useCallback(() => {
    const removableIds = selectedElements.filter((item) => !item.locked).map((item) => item.id);
    if (removableIds.length === 0) return;
    setElements((prev) => prev.filter((item) => !removableIds.includes(item.id)));
    clearSelection();
  }, [clearSelection, selectedElements]);

  useEffect(() => {
    const isTypingTarget = (target) => {
      const tagName = String(target?.tagName || "").toLowerCase();
      return tagName === "input" || tagName === "textarea" || target?.isContentEditable;
    };

    const handleKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "=" || event.key === "+" || event.key === "-" || event.key === "_" || event.key === "0")) {
        event.preventDefault();

        if (event.key === "0") {
          gestureViewportScaleAtCenter(1);
          return;
        }

        if (event.key === "=" || event.key === "+") {
          gestureViewportScaleAtCenter(viewportRef.current.scale * 1.12);
          return;
        }

        gestureViewportScaleAtCenter(viewportRef.current.scale * 0.88);
        return;
      }

      if (event.code === "Space" && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (!spacePanRef.current) {
          spacePanRef.current = true;
          setSpacePanMode(true);
        }
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.code === "Digit0") {
          event.preventDefault();
          gestureViewportScaleAtCenter(1);
          return;
        }

        if (event.code === "Digit1") {
          event.preventDefault();
          fitToContent();
          return;
        }

        if (event.code === "Digit2" && selectedIds.length > 0) {
          event.preventDefault();
          focusSelection();
          return;
        }
      }

      if (event.key === "Alt" && zoomToolRef.current) {
        setZoomToolZoomOut(true);
      }

      if (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        void toggleCanvasFullscreen();
        return;
      }

      if (event.key.toLowerCase() === "h" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        togglePinnedHandTool();
        return;
      }

      if (event.key.toLowerCase() === "v" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        activateSelectTool();
        return;
      }

      if (event.key.toLowerCase() === "z" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        if (handToolPinnedRef.current) return;
        if (!zoomToolRef.current) {
          activateZoomTool(false);
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAllElements();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && selectedIds.length > 0) {
        copySelectedElements();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && selectedIds.length > 0) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (event.key === "Escape") {
        if (handToolPinnedRef.current) {
          deactivateHandTool();
          return;
        }
        if (zoomToolPinnedRef.current) {
          deactivateZoomTool();
          return;
        }
        clearSelection();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedIds.length > 0) {
        event.preventDefault();
        deleteSelected();
        return;
      }

      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        gestureViewportScaleAtCenter(viewportRef.current.scale * 1.12);
        return;
      }

      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        gestureViewportScaleAtCenter(viewportRef.current.scale * 0.88);
        return;
      }

      if (event.key === "0") {
        event.preventDefault();
        focusSurface();
        return;
      }

      if (event.key === "1") {
        event.preventDefault();
        fitToContent();
        return;
      }

      if (event.key === "2" && selectedIds.length > 0) {
        event.preventDefault();
        focusSelection();
        return;
      }

      if (selectedIds.length === 0) return;

      const nudge = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setElements((prev) => prev.map((item) => (
          selectedIds.includes(item.id) && !item.locked ? { ...item, x: item.x - nudge } : item
        )));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setElements((prev) => prev.map((item) => (
          selectedIds.includes(item.id) && !item.locked ? { ...item, x: item.x + nudge } : item
        )));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setElements((prev) => prev.map((item) => (
          selectedIds.includes(item.id) && !item.locked ? { ...item, y: item.y - nudge } : item
        )));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setElements((prev) => prev.map((item) => (
          selectedIds.includes(item.id) && !item.locked ? { ...item, y: item.y + nudge } : item
        )));
      }
    };

    const handleKeyUp = (event) => {
      if (event.code === "Space") {
        spacePanRef.current = false;
        setSpacePanMode(false);
        return;
      }

      if (event.key === "Alt") {
        setZoomToolZoomOut(false);
      }

      if (event.key.toLowerCase() === "z" && !zoomToolPinnedRef.current) {
        deactivateZoomTool();
      }
    };

    const handleWindowBlur = () => {
      spacePanRef.current = false;
      setSpacePanMode(false);
      setIsPanActive(false);
      setZoomToolZoomOut(false);
      if (!handToolPinnedRef.current) {
        deactivateHandTool();
      }
      if (!zoomToolPinnedRef.current) {
        deactivateZoomTool();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [activateSelectTool, activateZoomTool, clearSelection, copySelectedElements, deactivateHandTool, deactivateZoomTool, deleteSelected, duplicateSelected, fitToContent, focusSelection, focusSurface, gestureViewportScaleAtCenter, selectAllElements, selectedIds, toggleCanvasFullscreen, togglePinnedHandTool]);

  useEffect(() => {
    const handleCopy = (event) => {
      const tagName = String(event.target?.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea") return;
      if (selectedIds.length === 0) return;

      const payload = copySelectedElements();
      if (!payload) return;

      event.preventDefault();
      const serialized = JSON.stringify(payload);
      event.clipboardData?.setData("application/x-stardraw-canvas", serialized);
      event.clipboardData?.setData("text/plain", `${payload.elements.length} StarDraw canvas element(s)`);
      toast.success(t("已复制所选元素", "Selection copied"));
    };

    const handlePaste = async (event) => {
      const tagName = String(event.target?.tagName || "").toLowerCase();
      if (tagName === "input" || tagName === "textarea") return;

      const customData = event.clipboardData?.getData("application/x-stardraw-canvas");
      if (customData) {
        try {
          const payload = JSON.parse(customData);
          event.preventDefault();
          if (pasteCanvasElements(payload)) {
            clipboardRef.current = payload;
            toast.success(t("已粘贴画布元素", "Canvas elements pasted"));
            return;
          }
        } catch {
          // Ignore malformed clipboard payload and continue with file/text paste.
        }
      }

      const imageFile = Array.from(event.clipboardData?.items || [])
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();

      if (imageFile) {
        event.preventDefault();
        try {
          await uploadAssetFile(imageFile);
          toast.success(t("剪贴板图片已加入画布", "Clipboard image added to the canvas"));
        } catch (err) {
          toast.error(err.response?.data?.message || err.message || t("粘贴图片失败", "Failed to paste image"));
        }
        return;
      }

      if (clipboardRef.current?.elements?.length) {
        event.preventDefault();
        if (pasteCanvasElements(clipboardRef.current)) {
          toast.success(t("已粘贴画布元素", "Canvas elements pasted"));
        }
      }
    };

    window.addEventListener("copy", handleCopy);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("paste", handlePaste);
    };
  }, [copySelectedElements, pasteCanvasElements, selectedIds.length, t, uploadAssetFile]);

  const getBoardPoint = useCallback((clientX, clientY) => {
    const rect = boardRef.current?.getBoundingClientRect();
    return {
      x: clientX - (rect?.left || 0),
      y: clientY - (rect?.top || 0),
    };
  }, []);

  const commitMarqueeSelection = useCallback((selectionRect, appendSelection = false) => {
    const left = Math.min(selectionRect.startX, selectionRect.currentX);
    const right = Math.max(selectionRect.startX, selectionRect.currentX);
    const top = Math.min(selectionRect.startY, selectionRect.currentY);
    const bottom = Math.max(selectionRect.startY, selectionRect.currentY);

    const hitIds = elementsRef.current
      .filter((item) => {
        const itemBounds = getElementAxisAlignedBounds(item);
        const screenLeft = itemBounds.minX * viewportRef.current.scale + viewportRef.current.x;
        const screenTop = itemBounds.minY * viewportRef.current.scale + viewportRef.current.y;
        const screenRight = itemBounds.maxX * viewportRef.current.scale + viewportRef.current.x;
        const screenBottom = itemBounds.maxY * viewportRef.current.scale + viewportRef.current.y;
        return screenRight >= left && screenLeft <= right && screenBottom >= top && screenTop <= bottom;
      })
      .map((item) => item.id);
    const expandedHitIds = expandGroupedSelectionIds(hitIds, elementsRef.current);

    setSelectedIds((prev) => {
      const next = appendSelection ? [...new Set([...prev, ...expandedHitIds])] : expandedHitIds;
      setSelectedId(next[next.length - 1] || "");
      return next;
    });
  }, []);

  const applyZoomMarquee = useCallback((selectionRect, zoomOut = false) => {
    const left = Math.min(selectionRect.startX, selectionRect.currentX);
    const right = Math.max(selectionRect.startX, selectionRect.currentX);
    const top = Math.min(selectionRect.startY, selectionRect.currentY);
    const bottom = Math.max(selectionRect.startY, selectionRect.currentY);
    const width = right - left;
    const height = bottom - top;

    if (width < 10 || height < 10) {
      const anchorX = selectionRect.currentX;
      const anchorY = selectionRect.currentY;
      const factor = zoomOut ? 0.75 : 1.35;
      gestureViewportScaleAtBoardPoint(viewportRef.current.scale * factor, anchorX, anchorY);
      return;
    }

    const worldLeft = (left - viewportRef.current.x) / viewportRef.current.scale;
    const worldTop = (top - viewportRef.current.y) / viewportRef.current.scale;
    const worldRight = (right - viewportRef.current.x) / viewportRef.current.scale;
    const worldBottom = (bottom - viewportRef.current.y) / viewportRef.current.scale;

    if (zoomOut) {
      const centerX = (worldLeft + worldRight) / 2;
      const centerY = (worldTop + worldBottom) / 2;
      const rectWidth = Math.max(1, worldRight - worldLeft);
      const rectHeight = Math.max(1, worldBottom - worldTop);
      focusBounds({
        minX: centerX - rectWidth * 1.3,
        minY: centerY - rectHeight * 1.3,
        maxX: centerX + rectWidth * 1.3,
        maxY: centerY + rectHeight * 1.3,
      }, {
        motion: "gesture",
        padding: 160,
        maxScale: 4.5,
      });
      return;
    }

    focusBounds({
      minX: worldLeft,
      minY: worldTop,
      maxX: worldRight,
      maxY: worldBottom,
    }, {
      motion: "gesture",
      padding: 120,
      maxScale: 6,
    });
  }, [focusBounds, gestureViewportScaleAtBoardPoint]);

  const applyZoomStep = useCallback((clientX, clientY, zoomOut = false) => {
    const anchor = getBoardAnchorFromClientPoint(clientX, clientY);
    const anchorX = anchor.inside ? anchor.x : (boardSize.width / 2 || anchor.x);
    const anchorY = anchor.inside ? anchor.y : (boardSize.height / 2 || anchor.y);
    const factor = zoomOut ? ZOOM_TOOL_CLICK_OUT_FACTOR : ZOOM_TOOL_CLICK_IN_FACTOR;
    const nextScale = viewportRef.current.scale * factor;
    gestureViewportScaleAtBoardPoint(nextScale, anchorX, anchorY);
    flashZoomPulse(clientX, clientY, zoomOut);
    window.requestAnimationFrame(() => {
      showInteractionHud(`${Math.round(clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale) * 100)}%`, {
        clientX,
        clientY,
      });
    });
  }, [boardSize.height, boardSize.width, flashZoomPulse, gestureViewportScaleAtBoardPoint, getBoardAnchorFromClientPoint, showInteractionHud]);

  const getAutoPanVelocity = useCallback((clientX, clientY) => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const resolveAxis = (position, size) => {
      if (position < 0 || position > size) return 0;
      if (position < AUTO_PAN_EDGE_SIZE) {
        const intensity = (AUTO_PAN_EDGE_SIZE - position) / AUTO_PAN_EDGE_SIZE;
        return (intensity ** 1.35) * AUTO_PAN_MAX_SPEED;
      }
      if (position > size - AUTO_PAN_EDGE_SIZE) {
        const intensity = (position - (size - AUTO_PAN_EDGE_SIZE)) / AUTO_PAN_EDGE_SIZE;
        return -(intensity ** 1.35) * AUTO_PAN_MAX_SPEED;
      }
      return 0;
    };

    return {
      x: resolveAxis(localX, rect.width),
      y: resolveAxis(localY, rect.height),
    };
  }, []);

  const startAutoPan = useCallback((clientX, clientY) => {
    autoPanPointerRef.current = { clientX, clientY };
    if (autoPanFrameRef.current) return;

    const tick = () => {
      const pointer = autoPanPointerRef.current;
      const interaction = interactionRef.current || touchGestureRef.current;
      if (!pointer || !interaction) {
        autoPanFrameRef.current = null;
        return;
      }

      const shouldAutoPan = ["drag", "resize", "resize-group", "marquee", "zoom-marquee"].includes(interaction.type);
      if (!shouldAutoPan) {
        autoPanFrameRef.current = null;
        return;
      }

      const velocity = getAutoPanVelocity(pointer.clientX, pointer.clientY);
      if (Math.abs(velocity.x) > 0.1 || Math.abs(velocity.y) > 0.1) {
        const scale = Math.max(MIN_VIEWPORT_SCALE, viewportRef.current.scale || 1);
        interaction.autoPanWorldX = (interaction.autoPanWorldX || 0) - (velocity.x / scale);
        interaction.autoPanWorldY = (interaction.autoPanWorldY || 0) - (velocity.y / scale);
        setViewport((prev) => ({
          ...prev,
          x: clamp(prev.x + velocity.x, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, prev.x),
          y: clamp(prev.y + velocity.y, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, prev.y),
        }));

        if (interaction.type === "drag") {
          const target = elementsRef.current.find((item) => item.id === interaction.elementId);
          if (target) {
            const pointerDx = (pointer.clientX - interaction.startX) / scale + (interaction.autoPanWorldX || 0);
            const pointerDy = (pointer.clientY - interaction.startY) / scale + (interaction.autoPanWorldY || 0);
            const snapped = getSnapResult({
              elementId: interaction.elementId,
              x: interaction.originX + pointerDx,
              y: interaction.originY + pointerDy,
              width: target.width,
              height: target.height,
              elements: elementsRef.current,
            });
            setGuides(snapped.guides);
            const deltaX = snapped.x - interaction.originX;
            const deltaY = snapped.y - interaction.originY;
            const originMap = interaction.originPositions || {};

            setElements((prev) => prev.map((item) => {
              if (!originMap[item.id]) return item;
              return {
                ...item,
                x: originMap[item.id].x + deltaX,
                y: originMap[item.id].y + deltaY,
              };
            }));
          }
        }
      }

      autoPanFrameRef.current = window.requestAnimationFrame(tick);
    };

    autoPanFrameRef.current = window.requestAnimationFrame(tick);
  }, [getAutoPanVelocity]);

  const attachWindowInteraction = useCallback(() => {
    const handleMouseMove = (event) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      startAutoPan(event.clientX, event.clientY);

      if (interaction.type === "pan") {
        const now = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
        const previousTime = Number.isFinite(interaction.lastTs) ? interaction.lastTs : now;
        const elapsed = Math.max(1, now - previousTime);
        const previousX = Number.isFinite(interaction.lastClientX) ? interaction.lastClientX : interaction.startX;
        const previousY = Number.isFinite(interaction.lastClientY) ? interaction.lastClientY : interaction.startY;
        const instantVelocityX = (event.clientX - previousX) / elapsed;
        const instantVelocityY = (event.clientY - previousY) / elapsed;
        interaction.velocityX = mix(interaction.velocityX || 0, instantVelocityX, PAN_VELOCITY_RESPONSE);
        interaction.velocityY = mix(interaction.velocityY || 0, instantVelocityY, PAN_VELOCITY_RESPONSE);
        interaction.lastClientX = event.clientX;
        interaction.lastClientY = event.clientY;
        interaction.lastTs = now;
        setViewport({
          x: interaction.originX + (event.clientX - interaction.startX),
          y: interaction.originY + (event.clientY - interaction.startY),
          scale: interaction.scale,
        });
        return;
      }

      if (interaction.type === "drag") {
        const dx = (event.clientX - interaction.startX) / viewportRef.current.scale + (interaction.autoPanWorldX || 0);
        const dy = (event.clientY - interaction.startY) / viewportRef.current.scale + (interaction.autoPanWorldY || 0);
        const target = elementsRef.current.find((item) => item.id === interaction.elementId);
        if (!target) return;

        const snapped = getSnapResult({
          elementId: interaction.elementId,
          x: interaction.originX + dx,
          y: interaction.originY + dy,
          width: target.width,
          height: target.height,
          elements: elementsRef.current,
        });

        setGuides(snapped.guides);
        const deltaX = snapped.x - interaction.originX;
        const deltaY = snapped.y - interaction.originY;
        const originMap = interaction.originPositions || {};

        setElements((prev) => prev.map((item) => {
          if (!originMap[item.id]) return item;
          return {
            ...item,
            x: originMap[item.id].x + deltaX,
            y: originMap[item.id].y + deltaY,
          };
        }));
        return;
      }

      if (interaction.type === "marquee") {
        const point = getBoardPoint(event.clientX, event.clientY);
        setMarqueeState((prev) => (prev ? { ...prev, currentX: point.x, currentY: point.y } : prev));
        return;
      }

      if (interaction.type === "zoom-scrub") {
        const deltaY = interaction.startY - event.clientY;
        const deltaX = event.clientX - interaction.startX;
        const zoomDelta = deltaY + deltaX * 0.35;
        const shapedZoomDelta = shapeGestureDelta(zoomDelta, {
          deadzone: SCRUB_DEADZONE,
          exponent: GESTURE_INPUT_EXPONENT,
          limit: SCRUB_DELTA_LIMIT,
        });
        const factor = Math.exp(shapedZoomDelta * ZOOM_TOOL_SCRUB_SENSITIVITY);
        const baseScale = interaction.originScale || viewportRef.current.scale;
        const nextScale = interaction.free
          ? baseScale * factor
          : interaction.zoomOut
            ? baseScale / factor
            : baseScale * factor;
        const baseViewport = interaction.originViewport || viewportRef.current;
        const nextViewport = getViewportAtScale(
          nextScale,
          interaction.anchorX,
          interaction.anchorY,
          baseViewport,
        );
        const response = getGestureResponse(
          VIEWPORT_GESTURE_PINCH_RESPONSE,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          getViewportGestureIntensity(baseViewport, nextViewport),
        );
        animateViewportGestureTo(nextViewport, {
          response,
        });
        showInteractionHud(
          `${Math.round(clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale) * 100)}%`,
          { clientX: event.clientX, clientY: event.clientY, persist: true },
        );
        return;
      }

      if (interaction.type === "resize") {
        const dx = (event.clientX - interaction.startX) / viewportRef.current.scale + (interaction.autoPanWorldX || 0);
        const dy = (event.clientY - interaction.startY) / viewportRef.current.scale + (interaction.autoPanWorldY || 0);
        const target = elementsRef.current.find((item) => item.id === interaction.elementId);
        if (!target) return;
        const minSize = getElementMinSize(target);
        const preserveRatio = event.shiftKey;
        const resizeFromCenter = event.altKey;
        const rotation = interaction.originRotation || 0;
        const localDelta = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -rotation);
        const localDx = localDelta.x;
        const localDy = localDelta.y;
        const aspectRatio = interaction.originWidth / Math.max(1, interaction.originHeight);
        const originRight = interaction.originX + interaction.originWidth;
        const originBottom = interaction.originY + interaction.originHeight;
        const originCenterX = interaction.originX + interaction.originWidth / 2;
        const originCenterY = interaction.originY + interaction.originHeight / 2;

        let nextX = interaction.originX;
        let nextY = interaction.originY;
        let nextWidth = interaction.originWidth;
        let nextHeight = interaction.originHeight;

        if (interaction.direction.includes("e")) {
          nextWidth = clamp(
            interaction.originWidth + localDx * (resizeFromCenter ? 2 : 1),
            minSize.width,
            MAX_ELEMENT_SIZE,
            interaction.originWidth,
          );
          if (resizeFromCenter) {
            nextX = originCenterX - nextWidth / 2;
          }
        }
        if (interaction.direction.includes("s")) {
          nextHeight = clamp(
            interaction.originHeight + localDy * (resizeFromCenter ? 2 : 1),
            minSize.height,
            MAX_ELEMENT_SIZE,
            interaction.originHeight,
          );
          if (resizeFromCenter) {
            nextY = originCenterY - nextHeight / 2;
          }
        }
        if (interaction.direction.includes("w")) {
          nextWidth = clamp(
            interaction.originWidth - localDx * (resizeFromCenter ? 2 : 1),
            minSize.width,
            MAX_ELEMENT_SIZE,
            interaction.originWidth,
          );
          if (resizeFromCenter) {
            nextX = originCenterX - nextWidth / 2;
          } else {
            nextX = originRight - nextWidth;
          }
        }
        if (interaction.direction.includes("n")) {
          nextHeight = clamp(
            interaction.originHeight - localDy * (resizeFromCenter ? 2 : 1),
            minSize.height,
            MAX_ELEMENT_SIZE,
            interaction.originHeight,
          );
          if (resizeFromCenter) {
            nextY = originCenterY - nextHeight / 2;
          } else {
            nextY = originBottom - nextHeight;
          }
        }

        if (preserveRatio) {
          const horizontalOnly = !interaction.direction.includes("n") && !interaction.direction.includes("s");
          const verticalOnly = !interaction.direction.includes("e") && !interaction.direction.includes("w");
          const minUniformScale = Math.max(
            minSize.width / Math.max(1, interaction.originWidth),
            minSize.height / Math.max(1, interaction.originHeight),
          );

          let uniformScale = 1;
          if (horizontalOnly) {
            uniformScale = nextWidth / Math.max(1, interaction.originWidth);
          } else if (verticalOnly) {
            uniformScale = nextHeight / Math.max(1, interaction.originHeight);
          } else {
            const scaleX = nextWidth / Math.max(1, interaction.originWidth);
            const scaleY = nextHeight / Math.max(1, interaction.originHeight);
            uniformScale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
          }

          uniformScale = Math.max(minUniformScale, uniformScale);
          nextWidth = clamp(interaction.originWidth * uniformScale, minSize.width, MAX_ELEMENT_SIZE, interaction.originWidth);
          nextHeight = clamp(nextWidth / Math.max(0.0001, aspectRatio), minSize.height, MAX_ELEMENT_SIZE, interaction.originHeight);
          nextWidth = nextHeight * aspectRatio;

          if (resizeFromCenter) {
            nextX = originCenterX - nextWidth / 2;
            nextY = originCenterY - nextHeight / 2;
          } else if (horizontalOnly) {
            if (interaction.direction.includes("w")) {
              nextX = originRight - nextWidth;
            } else {
              nextX = interaction.originX;
            }
            nextY = originCenterY - nextHeight / 2;
          } else if (verticalOnly) {
            if (interaction.direction.includes("n")) {
              nextY = originBottom - nextHeight;
            } else {
              nextY = interaction.originY;
            }
            nextX = originCenterX - nextWidth / 2;
          } else {
            if (interaction.direction.includes("w")) {
              nextX = originRight - nextWidth;
            } else {
              nextX = interaction.originX;
            }

            if (interaction.direction.includes("n")) {
              nextY = originBottom - nextHeight;
            } else {
              nextY = interaction.originY;
            }
          }
        }

        const snapped = getResizeSnapResult({
          elementId: interaction.elementId,
          x: nextX,
          y: nextY,
          width: nextWidth,
          height: nextHeight,
          elements: elementsRef.current,
          direction: interaction.direction,
          minWidth: minSize.width,
          minHeight: minSize.height,
        });

        setGuides(snapped.guides);
        updateElement(interaction.elementId, {
          x: snapped.x,
          y: snapped.y,
          width: snapped.width,
          height: snapped.height,
        });
        showInteractionHud(
          `${Math.round(snapped.width)} × ${Math.round(snapped.height)}`,
          { clientX: event.clientX, clientY: event.clientY, persist: true },
        );
        return;
      }

      if (interaction.type === "rotate") {
        const currentAngle = Math.atan2(
          event.clientY - interaction.centerClientY,
          event.clientX - interaction.centerClientX,
        ) * (180 / Math.PI);
        let delta = currentAngle - interaction.startPointerAngle;
        if (event.shiftKey) {
          delta = Math.round(delta / 15) * 15;
        }
        updateElement(interaction.elementId, {
          rotation: normalizeAngle(interaction.originRotation + delta),
        });
        showInteractionHud(
          `${Math.round(normalizeAngle(interaction.originRotation + delta))}°`,
          { clientX: event.clientX, clientY: event.clientY, persist: true },
        );
        return;
      }

      if (interaction.type === "resize-group") {
        const dx = (event.clientX - interaction.startX) / viewportRef.current.scale + (interaction.autoPanWorldX || 0);
        const dy = (event.clientY - interaction.startY) / viewportRef.current.scale + (interaction.autoPanWorldY || 0);
        const {
          direction,
          originBounds,
          originElements,
          minGroupWidth,
          minGroupHeight,
        } = interaction;
        const preserveRatio = event.shiftKey;
        const resizeFromCenter = event.altKey;
        const originRight = originBounds.maxX;
        const originBottom = originBounds.maxY;
        const originWidth = Math.max(1, originBounds.maxX - originBounds.minX);
        const originHeight = Math.max(1, originBounds.maxY - originBounds.minY);
        const originCenterX = originBounds.minX + originWidth / 2;
        const originCenterY = originBounds.minY + originHeight / 2;

        let nextLeft = originBounds.minX;
        let nextTop = originBounds.minY;
        let nextRight = originRight;
        let nextBottom = originBottom;

        if (direction.includes("w")) {
          const nextWidth = clamp(
            originWidth - dx * (resizeFromCenter ? 2 : 1),
            minGroupWidth,
            MAX_ELEMENT_SIZE,
            originWidth,
          );
          if (resizeFromCenter) {
            nextLeft = originCenterX - nextWidth / 2;
            nextRight = originCenterX + nextWidth / 2;
          } else {
            nextLeft = originRight - nextWidth;
          }
        }
        if (direction.includes("e")) {
          const nextWidth = clamp(
            originWidth + dx * (resizeFromCenter ? 2 : 1),
            minGroupWidth,
            MAX_ELEMENT_SIZE,
            originWidth,
          );
          if (resizeFromCenter) {
            nextLeft = originCenterX - nextWidth / 2;
            nextRight = originCenterX + nextWidth / 2;
          } else {
            nextRight = originBounds.minX + nextWidth;
          }
        }
        if (direction.includes("n")) {
          const nextHeight = clamp(
            originHeight - dy * (resizeFromCenter ? 2 : 1),
            minGroupHeight,
            MAX_ELEMENT_SIZE,
            originHeight,
          );
          if (resizeFromCenter) {
            nextTop = originCenterY - nextHeight / 2;
            nextBottom = originCenterY + nextHeight / 2;
          } else {
            nextTop = originBottom - nextHeight;
          }
        }
        if (direction.includes("s")) {
          const nextHeight = clamp(
            originHeight + dy * (resizeFromCenter ? 2 : 1),
            minGroupHeight,
            MAX_ELEMENT_SIZE,
            originHeight,
          );
          if (resizeFromCenter) {
            nextTop = originCenterY - nextHeight / 2;
            nextBottom = originCenterY + nextHeight / 2;
          } else {
            nextBottom = originBounds.minY + nextHeight;
          }
        }

        let nextWidth = Math.max(minGroupWidth, nextRight - nextLeft);
        let nextHeight = Math.max(minGroupHeight, nextBottom - nextTop);

        if (preserveRatio) {
          const horizontalOnly = !direction.includes("n") && !direction.includes("s");
          const verticalOnly = !direction.includes("e") && !direction.includes("w");
          const minUniformScale = Math.max(
            minGroupWidth / originWidth,
            minGroupHeight / originHeight,
          );

          let uniformScale = 1;
          if (horizontalOnly) {
            uniformScale = nextWidth / originWidth;
          } else if (verticalOnly) {
            uniformScale = nextHeight / originHeight;
          } else {
            const scaleX = nextWidth / originWidth;
            const scaleY = nextHeight / originHeight;
            uniformScale = Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY;
          }

          uniformScale = Math.max(minUniformScale, uniformScale);
          nextWidth = originWidth * uniformScale;
          nextHeight = originHeight * uniformScale;

          if (resizeFromCenter) {
            nextLeft = originCenterX - nextWidth / 2;
            nextTop = originCenterY - nextHeight / 2;
            nextRight = originCenterX + nextWidth / 2;
            nextBottom = originCenterY + nextHeight / 2;
          } else if (horizontalOnly) {
            if (direction.includes("w")) {
              nextLeft = originRight - nextWidth;
              nextRight = originRight;
            } else {
              nextLeft = originBounds.minX;
              nextRight = originBounds.minX + nextWidth;
            }
            nextTop = originCenterY - nextHeight / 2;
            nextBottom = nextTop + nextHeight;
          } else if (verticalOnly) {
            if (direction.includes("n")) {
              nextTop = originBottom - nextHeight;
              nextBottom = originBottom;
            } else {
              nextTop = originBounds.minY;
              nextBottom = originBounds.minY + nextHeight;
            }
            nextLeft = originCenterX - nextWidth / 2;
            nextRight = nextLeft + nextWidth;
          } else {
            if (direction.includes("w")) {
              nextLeft = originRight - nextWidth;
              nextRight = originRight;
            } else {
              nextLeft = originBounds.minX;
              nextRight = originBounds.minX + nextWidth;
            }

            if (direction.includes("n")) {
              nextTop = originBottom - nextHeight;
              nextBottom = originBottom;
            } else {
              nextTop = originBounds.minY;
              nextBottom = originBounds.minY + nextHeight;
            }
          }
        }

        const scaleX = nextWidth / originWidth;
        const scaleY = nextHeight / originHeight;

        setElements((prev) => prev.map((item) => {
          const origin = originElements[item.id];
          if (!origin) return item;

          return {
            ...item,
            x: nextLeft + (origin.x - originBounds.minX) * scaleX,
            y: nextTop + (origin.y - originBounds.minY) * scaleY,
            width: origin.width * scaleX,
            height: origin.height * scaleY,
          };
        }));
        showInteractionHud(
          `${Math.round(nextWidth)} × ${Math.round(nextHeight)}`,
          { clientX: event.clientX, clientY: event.clientY, persist: true },
        );
        return;
      }

      if (interaction.type === "rotate-group") {
        const currentAngle = Math.atan2(
          event.clientY - interaction.centerClientY,
          event.clientX - interaction.centerClientX,
        ) * (180 / Math.PI);
        let delta = currentAngle - interaction.startPointerAngle;
        if (event.shiftKey) {
          delta = Math.round(delta / 15) * 15;
        }

        setElements((prev) => prev.map((item) => {
          const origin = interaction.originElements[item.id];
          if (!origin) return item;

          const rotatedCenter = rotatePoint(
            {
              x: interaction.originCenter.x + origin.offsetX,
              y: interaction.originCenter.y + origin.offsetY,
            },
            interaction.originCenter,
            delta,
          );

          return {
            ...item,
            x: rotatedCenter.x - origin.width / 2,
            y: rotatedCenter.y - origin.height / 2,
            rotation: normalizeAngle(origin.rotation + delta),
          };
        }));
        showInteractionHud(
          `${Math.round(delta)}°`,
          { clientX: event.clientX, clientY: event.clientY, persist: true },
        );
        return;
      }
    };

    const handleMouseUp = () => {
      const interaction = interactionRef.current;
      const activeMarquee = marqueeRef.current;
      clearAutoPan();
      if (interaction?.type === "marquee" && activeMarquee) {
        commitMarqueeSelection(activeMarquee, interaction.appendSelection);
      }
      if (interaction?.type === "zoom-marquee" && activeMarquee) {
        applyZoomMarquee(activeMarquee, interaction.zoomOut);
      }
      if (interaction?.type === "zoom-scrub") {
        clearInteractionHud();
      }
      if (interaction?.type === "pan") {
        setIsPanActive(false);
        startViewportInertia(interaction.velocityX || 0, interaction.velocityY || 0);
      }
      interactionRef.current = null;
      setGuides([]);
      setMarqueeState(null);
      clearInteractionHud();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [animateViewportGestureTo, applyZoomMarquee, clearAutoPan, clearInteractionHud, commitMarqueeSelection, getBoardPoint, getGestureResponse, getViewportAtScale, getViewportGestureIntensity, setMarqueeState, showInteractionHud, startAutoPan, startViewportInertia, updateElement]);

  const startPan = (event) => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    stopViewportAnimation();
    const forcePan = spacePanRef.current || handToolRef.current || event.button === 1 || event.button === 2;
    const useZoomTool = zoomToolRef.current && event.button === 0 && !forcePan;

    if (useZoomTool) {
      const point = getBoardPoint(event.clientX, event.clientY);
      if (event.shiftKey) {
        interactionRef.current = {
          type: "zoom-scrub",
          zoomOut: event.altKey,
          startX: event.clientX,
          startY: event.clientY,
          anchorX: point.x,
          anchorY: point.y,
          originScale: viewportRef.current.scale,
          originViewport: { ...viewportRef.current },
        };
        showInteractionHud(t("连续缩放", "Scrub Zoom"), {
          clientX: event.clientX,
          clientY: event.clientY,
          persist: true,
        });
        attachWindowInteraction();
        return;
      }
      interactionRef.current = {
        type: "zoom-marquee",
        zoomOut: event.altKey,
      };
      setMarqueeState({
        mode: "zoom",
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      });
      attachWindowInteraction();
      return;
    }

    if (!forcePan && event.altKey && event.button === 0) {
      const point = getBoardPoint(event.clientX, event.clientY);
      interactionRef.current = {
        type: "zoom-scrub",
        free: true,
        startX: event.clientX,
        startY: event.clientY,
        anchorX: point.x,
        anchorY: point.y,
        originScale: viewportRef.current.scale,
        originViewport: { ...viewportRef.current },
      };
      showInteractionHud(t("自由缩放", "Scrub Zoom"), {
        clientX: event.clientX,
        clientY: event.clientY,
        persist: true,
      });
      attachWindowInteraction();
      return;
    }

    if (!forcePan && event.button === 0) {
      const point = getBoardPoint(event.clientX, event.clientY);
      interactionRef.current = {
        type: "marquee",
        appendSelection: event.shiftKey,
      };
      setMarqueeState({
        mode: "select",
        startX: point.x,
        startY: point.y,
        currentX: point.x,
        currentY: point.y,
      });
      attachWindowInteraction();
      return;
    }

    interactionRef.current = {
      type: "pan",
      startX: event.clientX,
      startY: event.clientY,
      originX: viewportRef.current.x,
      originY: viewportRef.current.y,
      scale: viewportRef.current.scale,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      lastTs: Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now(),
      velocityX: 0,
      velocityY: 0,
    };
    setIsPanActive(true);
    attachWindowInteraction();
  };

  const startDrag = (event, elementId) => {
    event.stopPropagation();
    stopViewportAnimation();
    if (handToolRef.current || spacePanRef.current || event.button === 1 || event.button === 2) {
      startPan(event);
      return;
    }
    if (zoomToolRef.current && event.button === 0) {
      if (event.shiftKey) {
        const point = getBoardPoint(event.clientX, event.clientY);
        interactionRef.current = {
          type: "zoom-scrub",
          zoomOut: event.altKey,
          startX: event.clientX,
          startY: event.clientY,
          anchorX: point.x,
          anchorY: point.y,
          originScale: viewportRef.current.scale,
          originViewport: { ...viewportRef.current },
        };
        showInteractionHud(t("连续缩放", "Scrub Zoom"), {
          clientX: event.clientX,
          clientY: event.clientY,
          persist: true,
        });
        attachWindowInteraction();
        return;
      }

      applyZoomStep(event.clientX, event.clientY, event.altKey);
      return;
    }
    const target = elementsRef.current.find((item) => item.id === elementId);
    if (!target) return;
    if (event.shiftKey) {
      toggleSelection(elementId);
      return;
    }

    if (target.locked) {
      selectElementCluster(elementId);
      return;
    }

    const clusterIds = getGroupedSelectionIds(elementId, elementsRef.current);
    const nextSelectedIds = isSelected(elementId) ? selectedIds : clusterIds;
    if (!isSelected(elementId)) {
      selectElementCluster(elementId);
    }
    const movableIds = elementsRef.current
      .filter((item) => nextSelectedIds.includes(item.id) && !item.locked)
      .map((item) => item.id);
    if (movableIds.length === 0) return;

    if (event.altKey) {
      const movableItems = elementsRef.current.filter((item) => movableIds.includes(item.id));
      const { duplicates, idMap } = duplicateElementBatch(movableItems, { offsetX: 28, offsetY: 28 });
      const duplicateIds = duplicates.map((item) => item.id);
      const duplicateTarget = duplicates.find((item) => item.id === idMap[elementId]) || duplicates[duplicates.length - 1];
      if (!duplicateTarget) return;

      setElements((prev) => [...prev, ...duplicates]);
      setSelectedId(duplicateTarget.id);
      setSelectedIds(duplicateIds);
      interactionRef.current = {
        type: "drag",
        elementId: duplicateTarget.id,
        startX: event.clientX,
        startY: event.clientY,
        originX: duplicateTarget.x,
        originY: duplicateTarget.y,
        originPositions: Object.fromEntries(
          duplicates.map((item) => [item.id, { x: item.x, y: item.y }]),
        ),
      };
      attachWindowInteraction();
      return;
    }

    interactionRef.current = {
      type: "drag",
      elementId,
      startX: event.clientX,
      startY: event.clientY,
      originX: target.x,
      originY: target.y,
      originPositions: Object.fromEntries(
        elementsRef.current
          .filter((item) => movableIds.includes(item.id))
          .map((item) => [item.id, { x: item.x, y: item.y }]),
      ),
    };
    attachWindowInteraction();
  };

  const startElementTouchInteraction = useCallback((event, elementId) => {
    const touch = event.touches?.[0];
    if (!touch) return;

    event.preventDefault();
    event.stopPropagation();
    stopViewportAnimation();

    if (handToolRef.current || spacePanRef.current) {
      touchGestureRef.current = {
        type: "pan",
        startX: touch.clientX,
        startY: touch.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
        scale: viewportRef.current.scale,
      };
      return;
    }

    const target = elementsRef.current.find((item) => item.id === elementId);
    if (!target) return;

    if (zoomToolRef.current) {
      applyZoomStep(touch.clientX, touch.clientY, false);
      return;
    }

    if (target.locked) {
      selectElementCluster(elementId);
      touchGestureRef.current = {
        type: "touch-select",
        touchId: touch.identifier,
        moved: false,
      };
      return;
    }

    const clusterIds = getGroupedSelectionIds(elementId, elementsRef.current);
    const nextSelectedIds = isSelected(elementId) ? selectedIds : clusterIds;
    if (!isSelected(elementId)) {
      selectElementCluster(elementId);
    }

    const movableIds = elementsRef.current
      .filter((item) => nextSelectedIds.includes(item.id) && !item.locked)
      .map((item) => item.id);
    if (movableIds.length === 0) return;

    touchGestureRef.current = {
      type: "drag",
      touchId: touch.identifier,
      elementId,
      startX: touch.clientX,
      startY: touch.clientY,
      originX: target.x,
      originY: target.y,
      originPositions: Object.fromEntries(
        elementsRef.current
          .filter((item) => movableIds.includes(item.id))
          .map((item) => [item.id, { x: item.x, y: item.y }]),
      ),
      moved: false,
    };
  }, [applyZoomStep, isSelected, selectElementCluster, selectedIds, stopViewportAnimation]);

  const startResize = (event, elementId, direction = "se") => {
    event.stopPropagation();
    stopViewportAnimation();
    const target = elementsRef.current.find((item) => item.id === elementId);
    if (!target) return;
    if (target.locked) {
      selectElementCluster(elementId);
      return;
    }
    selectElementCluster(elementId);
    interactionRef.current = {
      type: "resize",
      elementId,
      direction,
      startX: event.clientX,
      startY: event.clientY,
      originX: target.x,
      originY: target.y,
      originWidth: target.width,
      originHeight: target.height,
      originRotation: getElementRotation(target),
    };
    attachWindowInteraction();
  };

  const startRotate = useCallback((event, elementId) => {
    event.stopPropagation();
    stopViewportAnimation();
    const target = elementsRef.current.find((item) => item.id === elementId);
    if (!target || target.locked) return;

    selectElementCluster(elementId);
    const rect = boardRef.current?.getBoundingClientRect();
    const centerWorld = {
      x: target.x + target.width / 2,
      y: target.y + target.height / 2,
    };
    const centerClientX = (rect?.left || 0) + viewportRef.current.x + centerWorld.x * viewportRef.current.scale;
    const centerClientY = (rect?.top || 0) + viewportRef.current.y + centerWorld.y * viewportRef.current.scale;

    interactionRef.current = {
      type: "rotate",
      elementId,
      centerClientX,
      centerClientY,
      startPointerAngle: Math.atan2(event.clientY - centerClientY, event.clientX - centerClientX) * (180 / Math.PI),
      originRotation: getElementRotation(target),
    };
    attachWindowInteraction();
  }, [attachWindowInteraction, selectElementCluster, stopViewportAnimation]);

  const startGroupResize = useCallback((event, direction = "se") => {
    event.stopPropagation();
    stopViewportAnimation();
    if (!canResizeSelection || !selectedUnlockedBounds) return;

    const originWidth = Math.max(1, selectedUnlockedBounds.maxX - selectedUnlockedBounds.minX);
    const originHeight = Math.max(1, selectedUnlockedBounds.maxY - selectedUnlockedBounds.minY);
    const originElements = Object.fromEntries(
      selectedUnlockedElements.map((item) => [item.id, {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }]),
    );

    const minScaleX = Math.max(
      ...selectedUnlockedElements.map((item) => getElementMinSize(item).width / Math.max(1, item.width)),
    );
    const minScaleY = Math.max(
      ...selectedUnlockedElements.map((item) => getElementMinSize(item).height / Math.max(1, item.height)),
    );

    interactionRef.current = {
      type: "resize-group",
      direction,
      startX: event.clientX,
      startY: event.clientY,
      originBounds: selectedUnlockedBounds,
      originElements,
      minGroupWidth: originWidth * minScaleX,
      minGroupHeight: originHeight * minScaleY,
    };
    attachWindowInteraction();
  }, [attachWindowInteraction, canResizeSelection, selectedUnlockedBounds, selectedUnlockedElements, stopViewportAnimation]);

  const startGroupRotate = useCallback((event) => {
    event.stopPropagation();
    stopViewportAnimation();
    if (!canResizeSelection || !selectedUnlockedBounds) return;

    const rect = boardRef.current?.getBoundingClientRect();
    const originCenter = {
      x: (selectedUnlockedBounds.minX + selectedUnlockedBounds.maxX) / 2,
      y: (selectedUnlockedBounds.minY + selectedUnlockedBounds.maxY) / 2,
    };
    const centerClientX = (rect?.left || 0) + viewportRef.current.x + originCenter.x * viewportRef.current.scale;
    const centerClientY = (rect?.top || 0) + viewportRef.current.y + originCenter.y * viewportRef.current.scale;

    interactionRef.current = {
      type: "rotate-group",
      centerClientX,
      centerClientY,
      startPointerAngle: Math.atan2(event.clientY - centerClientY, event.clientX - centerClientX) * (180 / Math.PI),
      originCenter,
      originElements: Object.fromEntries(
        selectedUnlockedElements.map((item) => {
          const centerX = item.x + item.width / 2;
          const centerY = item.y + item.height / 2;
          return [item.id, {
            width: item.width,
            height: item.height,
            rotation: getElementRotation(item),
            offsetX: centerX - originCenter.x,
            offsetY: centerY - originCenter.y,
          }];
        }),
      ),
    };
    attachWindowInteraction();
  }, [attachWindowInteraction, canResizeSelection, selectedUnlockedBounds, selectedUnlockedElements, stopViewportAnimation]);

  const flushWheelGesture = useCallback(() => {
    wheelFrameRef.current = null;
    const pending = wheelPendingRef.current;
    wheelPendingRef.current = null;
    if (!pending) return;
    if (viewportAnimationRef.current) {
      window.cancelAnimationFrame(viewportAnimationRef.current);
      viewportAnimationRef.current = null;
    }

    const deltaScale = getWheelDeltaScale(pending.deltaMode, boardSize.height || 720);
    const rawDeltaX = pending.deltaX * deltaScale;
    const rawDeltaY = pending.deltaY * deltaScale;
    if (Math.abs(rawDeltaX) + Math.abs(rawDeltaY) < 0.42) {
      return;
    }

    const anchor = getBoardAnchorFromClientPoint(pending.clientX, pending.clientY);
    const rawMouseX = anchor.inside ? anchor.x : (boardSize.width / 2 || anchor.x);
    const rawMouseY = anchor.inside ? anchor.y : (boardSize.height / 2 || anchor.y);
    const isLikelyMouseWheel = pending.deltaMode !== 0 || (
      Math.abs(rawDeltaY) >= MOUSE_WHEEL_ZOOM_DELTA
      && Math.abs(rawDeltaX) <= MOUSE_WHEEL_MAX_CROSS_AXIS
    );
    const isZoomGesture = !pending.shiftKey && (
      pending.ctrlKey
      || pending.metaKey
      || pending.altKey
      || zoomToolRef.current
      || isLikelyMouseWheel
    );
    const wheelTimestamp = Number.isFinite(pending.timeStamp) ? pending.timeStamp : Date.now();
    const deltaX = shapeGestureDelta(rawDeltaX, {
      deadzone: WHEEL_PAN_DEADZONE,
      exponent: GESTURE_INPUT_EXPONENT,
      limit: WHEEL_PAN_DELTA_LIMIT,
    });
    const deltaY = shapeGestureDelta(rawDeltaY, {
      deadzone: isZoomGesture ? WHEEL_ZOOM_DEADZONE : WHEEL_PAN_DEADZONE,
      exponent: GESTURE_INPUT_EXPONENT,
      limit: isZoomGesture ? WHEEL_ZOOM_DELTA_LIMIT : WHEEL_PAN_DELTA_LIMIT,
    });
    if (Math.abs(deltaX) + Math.abs(deltaY) < 0.08) {
      return;
    }
    const wheelIntensity = clamp(
      (Math.hypot(deltaX * 0.72, deltaY) - 6) / 196,
      0,
      1,
      0,
    );
    const targetResponse = getGestureResponse(
      isZoomGesture ? VIEWPORT_GESTURE_PINCH_RESPONSE : VIEWPORT_GESTURE_PAN_RESPONSE,
      isZoomGesture ? VIEWPORT_GESTURE_PINCH_RESPONSE_MAX : VIEWPORT_GESTURE_PAN_RESPONSE_MAX,
      wheelIntensity,
    );
    const gestureContext = resolveWheelGestureContext(
      isZoomGesture ? "zoom" : "pan",
      wheelTimestamp,
      { x: rawMouseX, y: rawMouseY },
      targetResponse,
    );
    const interactionBaseViewport = gestureContext.baseViewport;
    const mouseX = gestureContext.anchorX ?? rawMouseX;
    const mouseY = gestureContext.anchorY ?? rawMouseY;
    const wheelResponse = gestureContext.response ?? targetResponse;

    if (isZoomGesture) {
      const zoomFactor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);
      const nextScale = interactionBaseViewport.scale * zoomFactor;
      const nextViewport = getViewportAtScale(nextScale, mouseX, mouseY, interactionBaseViewport);
      animateViewportGestureTo(nextViewport, {
        response: wheelResponse,
      });
      window.requestAnimationFrame(() => {
        showInteractionHud(`${Math.round(clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale) * 100)}%`, {
          clientX: pending.clientX,
          clientY: pending.clientY,
        });
      });
      return;
    }

    const panX = pending.shiftKey && Math.abs(deltaX) < 0.01 ? deltaY : deltaX;
    const panY = pending.shiftKey && Math.abs(deltaX) < 0.01 ? 0 : deltaY;

    animateViewportGestureTo({
      ...interactionBaseViewport,
      x: interactionBaseViewport.x - panX,
      y: interactionBaseViewport.y - panY,
    }, {
      response: wheelResponse,
    });
    showInteractionHud(t("平移", "Pan"), {
      clientX: pending.clientX,
      clientY: pending.clientY,
      duration: 220,
    });
  }, [animateViewportGestureTo, boardSize.height, boardSize.width, getBoardAnchorFromClientPoint, getGestureResponse, getViewportAtScale, resolveWheelGestureContext, showInteractionHud, t]);

  const handleWheel = useCallback((event) => {
    if (event.cancelable) {
      event.preventDefault();
    }

    const previous = wheelPendingRef.current;
    wheelPendingRef.current = {
      deltaX: (previous?.deltaX || 0) + event.deltaX,
      deltaY: (previous?.deltaY || 0) + event.deltaY,
      clientX: event.clientX,
      clientY: event.clientY,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      deltaMode: event.deltaMode,
      timeStamp: Number.isFinite(event.timeStamp) ? event.timeStamp : Date.now(),
    };

    if (wheelFrameRef.current) {
      return;
    }
    wheelFrameRef.current = window.requestAnimationFrame(flushWheelGesture);
  }, [flushWheelGesture]);

  const startZoomBadgeScrub = useCallback((startClientX, startClientY, options = {}) => {
    stopViewportAnimation();
    const rect = boardRef.current?.getBoundingClientRect();
    zoomBadgeDragRef.current = {
      startClientX,
      startClientY,
      originScale: viewportRef.current.scale,
      originViewport: { ...viewportRef.current },
      anchorX: rect ? rect.width / 2 : (boardSize.width / 2 || 640),
      anchorY: rect ? rect.height / 2 : (boardSize.height / 2 || 360),
      moved: false,
    };
    showInteractionHud(t("缩放调节", "Zoom Scrub"), {
      clientX: startClientX,
      clientY: startClientY,
      persist: true,
    });

    const applyScrub = (clientX, clientY) => {
      const dragState = zoomBadgeDragRef.current;
      if (!dragState) return;

      const deltaX = clientX - dragState.startClientX;
      const deltaY = dragState.startClientY - clientY;
      const zoomDelta = deltaY + deltaX * 0.6;
      if (Math.abs(zoomDelta) > 3) {
        dragState.moved = true;
      }

      const shapedZoomDelta = shapeGestureDelta(zoomDelta, {
        deadzone: SCRUB_DEADZONE,
        exponent: GESTURE_INPUT_EXPONENT,
        limit: SCRUB_DELTA_LIMIT,
      });
      const nextScale = dragState.originScale * Math.exp(shapedZoomDelta * ZOOM_BADGE_SCRUB_SENSITIVITY);
      const nextViewport = getViewportAtScale(
        nextScale,
        dragState.anchorX,
        dragState.anchorY,
        dragState.originViewport,
      );
      animateViewportGestureTo(nextViewport, {
        response: getGestureResponse(
          VIEWPORT_GESTURE_PINCH_RESPONSE,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          getViewportGestureIntensity(dragState.originViewport, nextViewport),
        ),
      });
      showInteractionHud(`${Math.round(clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, dragState.originScale) * 100)}%`, {
        clientX,
        clientY,
        persist: true,
      });
    };

    const finishScrub = () => {
      const dragState = zoomBadgeDragRef.current;
      zoomBadgeDragRef.current = null;
      clearInteractionHud();
      if (!dragState?.moved && options.resetOnTap) {
        gestureViewportScaleAtCenter(1);
      }
    };

    const handleMouseMove = (moveEvent) => {
      applyScrub(moveEvent.clientX, moveEvent.clientY);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      finishScrub();
    };

    const handleTouchMove = (moveEvent) => {
      const touch = moveEvent.touches?.[0];
      if (!touch) return;
      moveEvent.preventDefault();
      applyScrub(touch.clientX, touch.clientY);
    };

    const handleTouchEnd = () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      finishScrub();
    };

    if (options.touch) {
      window.addEventListener("touchmove", handleTouchMove, { passive: false });
      window.addEventListener("touchend", handleTouchEnd);
      window.addEventListener("touchcancel", handleTouchEnd);
      return;
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [animateViewportGestureTo, boardSize.height, boardSize.width, clearInteractionHud, getGestureResponse, gestureViewportScaleAtCenter, getViewportAtScale, getViewportGestureIntensity, showInteractionHud, stopViewportAnimation, t]);

  const handleZoomBadgeMouseDown = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    startZoomBadgeScrub(event.clientX, event.clientY, { resetOnTap: true });
  }, [startZoomBadgeScrub]);

  const handleZoomBadgeTouchStart = useCallback((event) => {
    const touch = event.touches?.[0];
    if (!touch) return;
    event.preventDefault();
    event.stopPropagation();
    startZoomBadgeScrub(touch.clientX, touch.clientY, { resetOnTap: true, touch: true });
  }, [startZoomBadgeScrub]);

  useEffect(() => {
    const pageNode = pageRef.current;
    const boardNode = boardRef.current;
    if (!pageNode || !boardNode) return undefined;

    const isInsidePage = (target) => target instanceof Node && pageNode.contains(target);
    const isInsideBoard = (target) => target instanceof Node && boardNode.contains(target);

    const handleBoardWheel = (event) => {
      handleWheel(event);
    };

    const handlePageWheel = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (!isInsidePage(event.target) || isInsideBoard(event.target)) return;
      handleWheel(event);
    };

    const handleGestureStart = (event) => {
      if (!isInsidePage(event.target)) return;
      if (event.cancelable) {
        event.preventDefault();
      }
      stopViewportAnimation();

      const anchor = getBoardAnchorFromClientPoint(event.clientX, event.clientY);
      gestureZoomRef.current = {
        lastScale: Number(event.scale) || 1,
        anchorX: anchor.inside ? anchor.x : (boardSize.width / 2 || anchor.x),
        anchorY: anchor.inside ? anchor.y : (boardSize.height / 2 || anchor.y),
        response: null,
      };
    };

    const handleGestureChange = (event) => {
      if (!gestureZoomRef.current || !isInsidePage(event.target)) return;
      if (event.cancelable) {
        event.preventDefault();
      }

      const gestureState = gestureZoomRef.current;
      const currentScale = Number(event.scale) || gestureState.lastScale || 1;
      const zoomFactor = currentScale / (gestureState.lastScale || 1);
      gestureState.lastScale = currentScale;

      const anchor = getBoardAnchorFromClientPoint(event.clientX, event.clientY);
      const rawAnchorX = anchor.inside ? anchor.x : (boardSize.width / 2 || gestureState.anchorX);
      const rawAnchorY = anchor.inside ? anchor.y : (boardSize.height / 2 || gestureState.anchorY);
      const anchorX = Number.isFinite(gestureState.anchorX)
        ? mix(gestureState.anchorX, rawAnchorX, GESTURE_CENTER_MIX)
        : rawAnchorX;
      const anchorY = Number.isFinite(gestureState.anchorY)
        ? mix(gestureState.anchorY, rawAnchorY, GESTURE_CENTER_MIX)
        : rawAnchorY;
      gestureState.anchorX = anchorX;
      gestureState.anchorY = anchorY;

      const interactionBaseViewport = viewportGestureTargetRef.current || viewportRef.current;
      const nextScale = interactionBaseViewport.scale * zoomFactor;
      const nextViewport = getViewportAtScale(nextScale, anchorX, anchorY, interactionBaseViewport);
      const targetResponse = getGestureResponse(
        VIEWPORT_GESTURE_PINCH_RESPONSE,
        VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
        getViewportGestureIntensity(interactionBaseViewport, nextViewport),
      );
      const nextResponse = Number.isFinite(gestureState.response)
        ? mix(gestureState.response, targetResponse, GESTURE_RESPONSE_MIX)
        : targetResponse;
      gestureState.response = nextResponse;
      animateViewportGestureTo(nextViewport, {
        response: nextResponse,
      });
      window.requestAnimationFrame(() => {
        showInteractionHud(`${Math.round(clamp(nextScale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale) * 100)}%`, {
          clientX: event.clientX,
          clientY: event.clientY,
        });
      });
    };

    const handleGestureEnd = (event) => {
      if (!isInsidePage(event.target)) return;
      if (event.cancelable) {
        event.preventDefault();
      }
      gestureZoomRef.current = null;
    };

    boardNode.addEventListener("wheel", handleBoardWheel, { passive: false });
    pageNode.addEventListener("wheel", handlePageWheel, { capture: true, passive: false });
    pageNode.addEventListener("gesturestart", handleGestureStart, { passive: false });
    pageNode.addEventListener("gesturechange", handleGestureChange, { passive: false });
    pageNode.addEventListener("gestureend", handleGestureEnd, { passive: false });

    return () => {
      boardNode.removeEventListener("wheel", handleBoardWheel);
      pageNode.removeEventListener("wheel", handlePageWheel, true);
      pageNode.removeEventListener("gesturestart", handleGestureStart);
      pageNode.removeEventListener("gesturechange", handleGestureChange);
      pageNode.removeEventListener("gestureend", handleGestureEnd);
      gestureZoomRef.current = null;
    };
  }, [animateViewportGestureTo, boardSize.height, boardSize.width, getBoardAnchorFromClientPoint, getGestureResponse, getViewportAtScale, getViewportGestureIntensity, handleWheel, showInteractionHud, stopViewportAnimation]);

  useEffect(() => {
    const boardNode = boardRef.current;
    if (!boardNode) return undefined;

    const isInteractiveTarget = (target) => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          "button, input, textarea, select, a, video, [contenteditable='true'], [data-touch-ignore='true']",
        ),
      );
    };

    const startSingleFingerPan = (touch) => {
      const now = performance.now();
      touchGestureRef.current = {
        type: "pan",
        startX: touch.clientX,
        startY: touch.clientY,
        originX: viewportRef.current.x,
        originY: viewportRef.current.y,
        scale: viewportRef.current.scale,
        lastClientX: touch.clientX,
        lastClientY: touch.clientY,
        lastTs: now,
        velocityX: 0,
        velocityY: 0,
      };
    };

    const startPinchGesture = (firstTouch, secondTouch) => {
      const center = getTouchCenter(firstTouch, secondTouch);
      const anchor = getBoardAnchorFromClientPoint(center.clientX, center.clientY);
      const anchorX = anchor.inside ? anchor.x : (boardSize.width / 2 || anchor.x);
      const anchorY = anchor.inside ? anchor.y : (boardSize.height / 2 || anchor.y);

      touchGestureRef.current = {
        type: "pinch",
        lastDistance: Math.max(1, getTouchDistance(firstTouch, secondTouch)),
        anchorX,
        anchorY,
        response: null,
      };
    };

    const handleTouchStart = (event) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
        stopViewportAnimation();
        const [firstTouch, secondTouch] = event.touches;
        startPinchGesture(firstTouch, secondTouch);
        return;
      }

      if (event.touches.length !== 1) return;
      if (isInteractiveTarget(event.target)) return;

      event.preventDefault();
      stopViewportAnimation();
      startSingleFingerPan(event.touches[0]);
    };

    const handleTouchMove = (event) => {
      const gesture = touchGestureRef.current;
      if (!gesture) return;

      if (gesture.type === "pan" && event.touches.length === 1) {
        event.preventDefault();
        const touch = event.touches[0];
        const now = Number.isFinite(event.timeStamp) ? event.timeStamp : performance.now();
        const previousTime = Number.isFinite(gesture.lastTs) ? gesture.lastTs : now;
        const elapsed = Math.max(1, now - previousTime);
        const previousX = Number.isFinite(gesture.lastClientX) ? gesture.lastClientX : gesture.startX;
        const previousY = Number.isFinite(gesture.lastClientY) ? gesture.lastClientY : gesture.startY;
        const instantVelocityX = (touch.clientX - previousX) / elapsed;
        const instantVelocityY = (touch.clientY - previousY) / elapsed;
        gesture.velocityX = mix(gesture.velocityX || 0, instantVelocityX, PAN_VELOCITY_RESPONSE);
        gesture.velocityY = mix(gesture.velocityY || 0, instantVelocityY, PAN_VELOCITY_RESPONSE);
        gesture.lastClientX = touch.clientX;
        gesture.lastClientY = touch.clientY;
        gesture.lastTs = now;
        setViewport({
          x: gesture.originX + (touch.clientX - gesture.startX),
          y: gesture.originY + (touch.clientY - gesture.startY),
          scale: gesture.scale,
        });
        showInteractionHud(t("平移", "Pan"), {
          clientX: touch.clientX,
          clientY: touch.clientY,
          duration: 180,
        });
        return;
      }

      if (gesture.type === "drag" && event.touches.length === 1) {
        event.preventDefault();
        const touch = event.touches[0];
        startAutoPan(touch.clientX, touch.clientY);
        const dx = (touch.clientX - gesture.startX) / viewportRef.current.scale + (gesture.autoPanWorldX || 0);
        const dy = (touch.clientY - gesture.startY) / viewportRef.current.scale + (gesture.autoPanWorldY || 0);
        const target = elementsRef.current.find((item) => item.id === gesture.elementId);
        if (!target) return;

        if (Math.abs(touch.clientX - gesture.startX) + Math.abs(touch.clientY - gesture.startY) > 6) {
          gesture.moved = true;
        }

        const snapped = getSnapResult({
          elementId: gesture.elementId,
          x: gesture.originX + dx,
          y: gesture.originY + dy,
          width: target.width,
          height: target.height,
          elements: elementsRef.current,
        });

        setGuides(snapped.guides);
        const deltaX = snapped.x - gesture.originX;
        const deltaY = snapped.y - gesture.originY;
        const originMap = gesture.originPositions || {};

        setElements((prev) => prev.map((item) => {
          if (!originMap[item.id]) return item;
          return {
            ...item,
            x: originMap[item.id].x + deltaX,
            y: originMap[item.id].y + deltaY,
          };
        }));
        return;
      }

      if (event.touches.length >= 2) {
        event.preventDefault();
        const [firstTouch, secondTouch] = event.touches;
        if (gesture.type !== "pinch") {
          startPinchGesture(firstTouch, secondTouch);
          return;
        }

        const center = getTouchCenter(firstTouch, secondTouch);
        const currentDistance = Math.max(1, getTouchDistance(firstTouch, secondTouch));
        const previousDistance = Math.max(1, gesture.lastDistance || currentDistance);
        const scaleFactor = currentDistance / previousDistance;
        gesture.lastDistance = currentDistance;
        const anchor = getBoardAnchorFromClientPoint(center.clientX, center.clientY);
        const rawAnchorX = anchor.inside ? anchor.x : (boardSize.width / 2 || gesture.anchorX);
        const rawAnchorY = anchor.inside ? anchor.y : (boardSize.height / 2 || gesture.anchorY);
        const anchorX = Number.isFinite(gesture.anchorX)
          ? mix(gesture.anchorX, rawAnchorX, GESTURE_CENTER_MIX)
          : rawAnchorX;
        const anchorY = Number.isFinite(gesture.anchorY)
          ? mix(gesture.anchorY, rawAnchorY, GESTURE_CENTER_MIX)
          : rawAnchorY;
        gesture.anchorX = anchorX;
        gesture.anchorY = anchorY;
        const interactionBaseViewport = viewportGestureTargetRef.current || viewportRef.current;
        const nextScale = interactionBaseViewport.scale * scaleFactor;
        const nextViewport = getViewportAtScale(
          nextScale,
          anchorX,
          anchorY,
          interactionBaseViewport,
        );
        const safeScale = clamp(nextViewport.scale, MIN_VIEWPORT_SCALE, MAX_VIEWPORT_SCALE, viewportRef.current.scale);
        const targetResponse = getGestureResponse(
          VIEWPORT_GESTURE_PINCH_RESPONSE,
          VIEWPORT_GESTURE_PINCH_RESPONSE_MAX,
          getViewportGestureIntensity(interactionBaseViewport, nextViewport),
        );
        const nextResponse = Number.isFinite(gesture.response)
          ? mix(gesture.response, targetResponse, GESTURE_RESPONSE_MIX)
          : targetResponse;
        gesture.response = nextResponse;

        animateViewportGestureTo(nextViewport, {
          response: nextResponse,
        });
        showInteractionHud(`${Math.round(safeScale * 100)}%`, {
          clientX: center.clientX,
          clientY: center.clientY,
          persist: true,
        });
      }
    };

    const handleTouchEnd = (event) => {
      const gesture = touchGestureRef.current;
      if (!gesture) return;

      if (event.touches.length >= 2) {
        const [firstTouch, secondTouch] = event.touches;
        setGuides([]);
        startPinchGesture(firstTouch, secondTouch);
        return;
      }

      if (event.touches.length === 1 && gesture.type === "pinch") {
        startSingleFingerPan(event.touches[0]);
        return;
      }

      if (gesture.type === "drag") {
        setGuides([]);
      }

      if (gesture.type === "pan") {
        startViewportInertia(gesture.velocityX || 0, gesture.velocityY || 0);
      }

      touchGestureRef.current = null;
      clearAutoPan();
      clearInteractionHud();
    };

    boardNode.addEventListener("touchstart", handleTouchStart, { passive: false });
    boardNode.addEventListener("touchmove", handleTouchMove, { passive: false });
    boardNode.addEventListener("touchend", handleTouchEnd, { passive: false });
    boardNode.addEventListener("touchcancel", handleTouchEnd, { passive: false });

    return () => {
      boardNode.removeEventListener("touchstart", handleTouchStart);
      boardNode.removeEventListener("touchmove", handleTouchMove);
      boardNode.removeEventListener("touchend", handleTouchEnd);
      boardNode.removeEventListener("touchcancel", handleTouchEnd);
      touchGestureRef.current = null;
      clearAutoPan();
    };
  }, [animateViewportGestureTo, boardSize.height, boardSize.width, clearAutoPan, clearInteractionHud, getBoardAnchorFromClientPoint, getGestureResponse, getViewportAtScale, getViewportGestureIntensity, showInteractionHud, startAutoPan, startViewportInertia, stopViewportAnimation, t]);

  const handleMinimapPointerDown = useCallback((event) => {
    event.preventDefault();
    navigateMinimap(event.clientX, event.clientY);

    const handleMove = (moveEvent) => {
      navigateMinimap(moveEvent.clientX, moveEvent.clientY);
    };

    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [navigateMinimap]);

  const handleMinimapViewportPointerDown = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();

    const origin = getMinimapWorldPointFromClient(event.clientX, event.clientY);
    if (!origin) return;

    const offsetX = origin.x - viewportWorldRect.minX;
    const offsetY = origin.y - viewportWorldRect.minY;

    const moveViewportWindow = (clientX, clientY) => {
      const worldPoint = getMinimapWorldPointFromClient(clientX, clientY);
      if (!worldPoint) return;

      stopViewportAnimation();
      setViewport((prev) => ({
        ...prev,
        x: -(worldPoint.x - offsetX) * prev.scale,
        y: -(worldPoint.y - offsetY) * prev.scale,
      }));
    };

    const handleMove = (moveEvent) => {
      moveViewportWindow(moveEvent.clientX, moveEvent.clientY);
    };

    const handleUp = () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };

    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
  }, [getMinimapWorldPointFromClient, stopViewportAnimation, viewportWorldRect.minX, viewportWorldRect.minY]);

  const handleMinimapTouchStart = useCallback((event) => {
    const firstTouch = event.touches?.[0];
    if (!firstTouch) return;

    event.preventDefault();
    navigateMinimap(firstTouch.clientX, firstTouch.clientY);

    const handleMove = (moveEvent) => {
      const nextTouch = moveEvent.touches?.[0];
      if (!nextTouch) return;
      moveEvent.preventDefault();
      navigateMinimap(nextTouch.clientX, nextTouch.clientY);
    };

    const handleEnd = () => {
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", handleEnd);
    };

    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
    window.addEventListener("touchcancel", handleEnd);
  }, [navigateMinimap]);

  const handleMinimapViewportTouchStart = useCallback((event) => {
    const firstTouch = event.touches?.[0];
    if (!firstTouch) return;

    event.preventDefault();
    event.stopPropagation();

    const origin = getMinimapWorldPointFromClient(firstTouch.clientX, firstTouch.clientY);
    if (!origin) return;

    const offsetX = origin.x - viewportWorldRect.minX;
    const offsetY = origin.y - viewportWorldRect.minY;

    const moveViewportWindow = (clientX, clientY) => {
      const worldPoint = getMinimapWorldPointFromClient(clientX, clientY);
      if (!worldPoint) return;

      stopViewportAnimation();
      setViewport((prev) => ({
        ...prev,
        x: -(worldPoint.x - offsetX) * prev.scale,
        y: -(worldPoint.y - offsetY) * prev.scale,
      }));
    };

    const handleMove = (moveEvent) => {
      const nextTouch = moveEvent.touches?.[0];
      if (!nextTouch) return;
      moveEvent.preventDefault();
      moveViewportWindow(nextTouch.clientX, nextTouch.clientY);
    };

    const handleEnd = () => {
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleEnd);
      window.removeEventListener("touchcancel", handleEnd);
    };

    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleEnd);
    window.addEventListener("touchcancel", handleEnd);
  }, [getMinimapWorldPointFromClient, stopViewportAnimation, viewportWorldRect.minX, viewportWorldRect.minY]);

  const deleteCanvas = async () => {
    if (!activeCanvasId || deletingCanvas) return;
    const confirmed = window.confirm(t(
      "确认删除当前画布？会员用户可在 14 天内从回收站恢复，Free 用户删除后不可恢复。",
      "Delete the current canvas? Members can restore it from the recycle bin for 14 days. Free accounts cannot undo deletion.",
    ));
    if (!confirmed) return;

    setDeletingCanvas(true);
    try {
      const { data } = await authAxios.delete(`/api/canvases/${activeCanvasId}`);
      const remaining = canvases.filter((item) => item.id !== activeCanvasId);
      setCanvases(remaining);
      clearSelection();
      if (remaining[0]?.id) {
        setActiveCanvasId(remaining[0].id);
        await loadCanvas(remaining[0].id);
      } else {
        const created = await createCanvas();
        if (created?.id) {
          setActiveCanvasId(created.id);
        }
      }
      toast.success(data?.data?.mode === "recycle_bin"
        ? t("画布已移入回收站", "Canvas moved to the recycle bin")
        : t("画布已删除", "Canvas deleted"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("删除画布失败", "Failed to delete canvas"));
    } finally {
      setDeletingCanvas(false);
    }
  };

  const handleAssetUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (!getCanvasAssetType(file)) {
      toast.error(t("仅支持上传图片、视频或音频文件", "Only image, video, or audio files are supported"));
      return;
    }

    try {
      await uploadAssetFile(file);
      toast.success(t("素材已上传到画布", "Asset uploaded to the canvas"));
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || t("素材上传失败", "Failed to upload asset"));
    }
  };

  const canvasDragContainsFiles = useCallback((dataTransfer) => {
    const transferTypes = Array.from(dataTransfer?.types || []);
    return transferTypes.some((type) => String(type).toLowerCase() === "files")
      || Array.from(dataTransfer?.items || []).some((item) => item.kind === "file")
      || Array.from(dataTransfer?.files || []).length > 0;
  }, []);

  const handleCanvasAssetDragEnter = useCallback((event) => {
    if (!canvasDragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setAssetDragActive(true);
  }, [canvasDragContainsFiles]);

  const handleCanvasAssetDragOver = useCallback((event) => {
    if (!canvasDragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setAssetDragActive(true);
  }, [canvasDragContainsFiles]);

  const handleCanvasAssetDragLeave = useCallback((event) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget && event.currentTarget.contains(nextTarget)) return;
    setAssetDragActive(false);
  }, []);

  const handleCanvasAssetDrop = useCallback(async (event) => {
    if (!canvasDragContainsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setAssetDragActive(false);

    const droppedFiles = Array.from(event.dataTransfer?.files || []);
    const file = droppedFiles.find((item) => getCanvasAssetType(item));
    if (!file) {
      toast.error(t("仅支持拖入图片、视频或音频文件", "Only image, video, or audio files can be dropped here"));
      return;
    }

    const assetType = getCanvasAssetType(file);
    const elementWidth = assetType === "video" ? 360 : 320;
    const elementHeight = assetType === "video" ? 202 : assetType === "audio" ? 120 : 320;
    const position = getCanvasDropPoint({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: boardRef.current?.getBoundingClientRect(),
      viewport: viewportRef.current,
      elementWidth,
      elementHeight,
    });

    try {
      await uploadAssetFile(file, { position });
      toast.success(t("素材已上传到拖放位置", "Asset uploaded at the drop position"));
      if (droppedFiles.length > 1) {
        toast(t("当前一次加入一个文件，请继续拖入其余文件", "One file is added at a time; drop the remaining files again"));
      }
    } catch (err) {
      toast.error(err.response?.data?.message || err.message || t("拖放上传失败", "Drop upload failed"));
    }
  }, [canvasDragContainsFiles, t, uploadAssetFile]);

  const exportCanvasAsImage = async () => {
    if (elements.length === 0) {
      toast.error(t("画布里还没有内容可导出", "There is nothing on the canvas to export"));
      return null;
    }

    setExportingCanvas(true);
    try {
      const bounds = getBoundsFromElements(elements);
      if (!bounds) {
        throw new Error(t("导出失败", "Export failed"));
      }

      const padding = 80;
      const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
      const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
      const scale = clamp(Math.min(2400 / contentWidth, 1800 / contentHeight), 0.5, 2, 1.2);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round((contentWidth + padding * 2) * scale);
      canvas.height = Math.round((contentHeight + padding * 2) * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");

      ctx.fillStyle = "#0a0e14";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.scale(scale, scale);
      ctx.translate(-bounds.minX + padding, -bounds.minY + padding);

      for (const element of elements) {
        const rotation = getElementRotation(element);
        const centerX = element.x + element.width / 2;
        const centerY = element.y + element.height / 2;
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(toRadians(rotation));
        ctx.translate(-element.width / 2, -element.height / 2);

	        if (element.type === "text") {
	          drawRoundedRect(ctx, 0, 0, element.width, element.height, 24);
	          ctx.fillStyle = element.background || ui.soft;
	          ctx.fill();
	          ctx.strokeStyle = ui.line;
	          ctx.lineWidth = 1;
	          ctx.stroke();

	          ctx.fillStyle = ui.faint;
	          ctx.font = "600 10px Inter, sans-serif";
	          ctx.fillText(element.title || t("便签", "Note"), 20, 28);

	          ctx.fillStyle = element.color || ui.text;
	          ctx.font = `${element.fontSize || 18}px Inter, sans-serif`;
          const lines = wrapText(ctx, element.text || "", Math.max(40, element.width - 40));
          const lineHeight = Math.max(24, (element.fontSize || 18) * 1.45);
          lines.slice(0, 16).forEach((line, index) => {
            ctx.fillText(line, 20, 68 + index * lineHeight);
          });
          ctx.restore();
          continue;
        }

        drawRoundedRect(ctx, 0, 0, element.width, element.height, 24);
        ctx.clip();

        if (element.type === "video") {
          const mountedVideo = elementVideoRefs.current[element.id];
          if (mountedVideo && mountedVideo.readyState >= 2) {
            ctx.drawImage(mountedVideo, 0, 0, element.width, element.height);
          } else if (element.poster) {
            const poster = await loadImage(element.poster);
            ctx.drawImage(poster, 0, 0, element.width, element.height);
	          } else {
	            ctx.fillStyle = ui.soft;
	            ctx.fillRect(0, 0, element.width, element.height);
	          }
        } else if (element.src) {
          const image = await loadImage(element.src);
          ctx.drawImage(image, 0, 0, element.width, element.height);
        }

        ctx.restore();
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(toRadians(rotation));
        ctx.translate(-element.width / 2, -element.height / 2);
	        ctx.strokeStyle = ui.line;
        ctx.lineWidth = 1;
        drawRoundedRect(ctx, 0, 0, element.width, element.height, 24);
        ctx.stroke();

        if (element.title) {
          const gradient = ctx.createLinearGradient(0, element.height - 72, 0, element.height);
          gradient.addColorStop(0, "rgba(10,14,20,0)");
          gradient.addColorStop(1, "rgba(10,14,20,0.88)");
          ctx.fillStyle = gradient;
          ctx.fillRect(0, element.height - 72, element.width, 72);
	          ctx.fillStyle = "#ffffff";
          ctx.font = "700 16px Manrope, sans-serif";
          ctx.fillText(element.title, 18, element.height - 24);
        }
        ctx.restore();
      }

      ctx.restore();

      const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });

      if (!blob) {
        throw new Error(t("导出失败", "Export failed"));
      }

      const url = URL.createObjectURL(blob);
      const fileName = `${(canvasTitle || "canvas").trim() || "canvas"}.png`;
      createDownload(url, fileName);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { fileName };
    } catch (err) {
      toast.error(err.message || t("导出失败", "Export failed"));
      return null;
    } finally {
      setExportingCanvas(false);
    }
  };

  const resolveTimelineAssetUrl = useCallback(async (assetId) => {
    const element = elements.find((item) => String(item.id) === String(assetId) && ["image", "video", "audio"].includes(item.type));
    const rawUrl = element?.type === "audio"
      ? getAudioAssetUrl(element)
      : element?.type === "image"
        ? getImageAssetUrl(element)
        : element ? getVideoAssetUrl(element) : "";
    return rawUrl ? resolvePrivateUrl(rawUrl) : "";
  }, [elements, resolvePrivateUrl]);

  const renderTimelineLocally = async ({ uploadIdempotencyKey = null } = {}) => {
    if (renderingTimeline) return;
    const abortController = new AbortController();
    timelineRenderAbortRef.current = abortController;
    setRenderingTimeline(true);
    setTimelineRenderProgress(0);
    try {
      const blob = await renderSingleVideoTrack({
        timeline: projectModel.timeline,
        format: "mp4",
        mp4Fallback: "webm",
        signal: abortController.signal,
        resolveAssetUrl: resolveTimelineAssetUrl,
        onProgress: setTimelineRenderProgress,
      });
      const baseName = (canvasTitle || "timeline").trim().replace(/[\\/:*?"<>|]/g, "_") || "timeline";
      const extension = getAssetExtensionFromMime(blob.type, "webm");
      const fileName = `${baseName}.${extension}`;
      const renderedFile = new File([blob], fileName, { type: blob.type || `video/${extension}` });
      const uploadedAsset = await uploadAssetFile(renderedFile, { idempotencyKey: uploadIdempotencyKey });
      const url = URL.createObjectURL(blob);
      createDownload(url, fileName);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(t("时间线已本地渲染并上传到私有素材库", "Timeline rendered locally and uploaded to private assets"));
      return {
        fileName,
        uploadedAssetId: uploadedAsset?.resource_id || uploadedAsset?.resourceId || uploadedAsset?.id || null,
      };
    } catch (err) {
      if (err?.code === "TIMELINE_RENDER_CANCELLED" || err?.code === "MP4_TRANSCODE_CANCELLED") {
        toast(t("已取消时间线渲染", "Timeline render cancelled"));
      } else {
        toast.error(err.message || t("时间线渲染失败", "Timeline render failed"));
      }
      return null;
    } finally {
      if (timelineRenderAbortRef.current === abortController) timelineRenderAbortRef.current = null;
      setRenderingTimeline(false);
    }
  };

  const cancelTimelineRender = () => timelineRenderAbortRef.current?.abort();

  const saveStateLabel = {
    dirty: t("待保存", "Pending Save"),
    saving: t("保存中", "Saving"),
    saved: t("已保存", "Saved"),
    error: t("保存失败", "Save Failed"),
  }[saveState] || t("已保存", "Saved");
  const inlineAiQuickActions = [
    t("保持主体不变，优化光影、质感和画面高级感。", "Keep the subject unchanged and improve lighting, texture, and premium visual quality."),
    t("更换为干净的电商摄影背景，突出主体。", "Replace with a clean ecommerce photography background and highlight the subject."),
    t("生成同款风格变体，保持构图和主体一致。", "Create a same-style variation while keeping composition and subject consistent."),
    t("把这张图改成更适合社媒广告的视觉。", "Turn this into a stronger social ad visual."),
  ];
  const agentQuickPrompts = [
    t("把选中的素材排成两列，并在左侧加一张策略便签。", "Arrange selected assets into two columns and add a strategy note on the left."),
    t("整理当前画布：对齐素材，聚焦主要内容，并写出下一步生成建议。", "Organize this canvas: align assets, focus the main content, and write next generation suggestions."),
    t("根据当前素材，优化图片和视频提示词，适合电商投放。", "Optimize image and video prompts from current assets for ecommerce ads."),
  ];
  const agentSkillSuggestions = [
    {
      icon: "view_quilt",
      label: t("画布整理", "Board Cleanup"),
      prompt: agentQuickPrompts[1],
    },
    {
      icon: "auto_awesome_motion",
      label: t("素材排版", "Asset Layout"),
      prompt: agentQuickPrompts[0],
    },
    {
      icon: "draw",
      label: t("提示词优化", "Prompt Rewrite"),
      prompt: agentQuickPrompts[2],
    },
    {
      icon: "sticky_note_2",
      label: t("生成策略便签", "Strategy Note"),
      prompt: t("根据当前画布素材，生成一张投放策略便签，并放在画布右侧。", "Create an ad strategy note from the current canvas assets and place it on the right side of the board."),
    },
    {
      icon: "grid_view",
      label: t("九宫格排布", "Grid Layout"),
      prompt: t("把当前素材按整齐网格排布，保持统一间距，并聚焦到完整视图。", "Arrange the current assets into a clean grid with consistent spacing and focus the full view."),
    },
  ];
  const getAgentStatusMeta = (message) => {
    if (message?.error || message?.status === "failed") {
      return { icon: "error", label: t("失败", "Failed"), tone: "danger" };
    }
    if (message?.status === "running") {
      return { icon: "progress_activity", label: t("执行中", "Running"), tone: "gold" };
    }
    if (message?.status === "completed") {
      return { icon: "check_circle", label: t("已完成", "Completed"), tone: "blue" };
    }
    return { icon: "auto_awesome", label: t("Agent", "Agent"), tone: "blue" };
  };
  const getAgentActionMeta = (action) => {
    const idsCount = Array.isArray(action?.ids) ? action.ids.length : 0;
    const promptLabel = action?.type === "set_video_prompt"
      ? t("视频提示词", "Video prompt")
      : t("图片提示词", "Image prompt");

    switch (action?.type) {
      case "set_title":
        return { icon: "title", label: t("重命名画布", "Rename board"), detail: action.title || "" };
      case "add_note":
        return { icon: "sticky_note_2", label: t("添加便签", "Add note"), detail: action.title || t("策略便签", "Strategy note") };
      case "add_asset":
        return { icon: "add_photo_alternate", label: t("导入素材", "Import asset"), detail: action.title || action.mentionKey || "" };
      case "update_text":
        return { icon: "edit_note", label: t("更新便签", "Update note"), detail: action.title || action.id || "" };
      case "move_elements":
        return { icon: "open_with", label: t("移动元素", "Move elements"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "arrange_grid":
        return { icon: "grid_view", label: t("网格排版", "Grid layout"), detail: t(`${idsCount} 个元素 · ${action.columns || 3} 列`, `${idsCount} elements · ${action.columns || 3} columns`) };
      case "resize_elements":
        return { icon: "aspect_ratio", label: t("调整尺寸", "Resize elements"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "set_selection":
        return { icon: "select", label: t("更新选择", "Update selection"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "set_viewport":
        return { icon: "center_focus_strong", label: t("调整视图", "Adjust viewport"), detail: `${Math.round((action.scale || 1) * 100)}%` };
      case "set_image_prompt":
      case "set_video_prompt":
        return { icon: action.type === "set_video_prompt" ? "movie_filter" : "image", label: promptLabel, detail: action.sceneKey || t("已写入生成面板", "Applied to generation panel") };
      case "lock_elements":
        return { icon: "lock", label: t("锁定元素", "Lock elements"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "unlock_elements":
        return { icon: "lock_open", label: t("解锁元素", "Unlock elements"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "delete_elements":
        return { icon: "delete", label: t("删除元素", "Delete elements"), detail: t(`${idsCount} 个元素`, `${idsCount} elements`) };
      case "generate_image":
        return { icon: "image", label: t("启动图片生成", "Start image generation"), detail: t("正在提交图片任务", "Submitting image task") };
      case "image_completed":
        return { icon: "check_circle", label: t("图片已加入画布", "Image added to canvas"), detail: t("可继续编辑或生成视频", "Ready for editing or video") };
      case "image_failed":
        return { icon: "error", label: t("图片生成失败", "Image generation failed"), detail: t("请调整提示词后重试", "Adjust prompt and retry") };
      case "generate_video":
        return { icon: "movie_filter", label: t("启动视频生成", "Start video generation"), detail: t("正在提交视频任务", "Submitting video task") };
      case "video_submitted":
        return { icon: "hourglass_top", label: t("视频任务已提交", "Video task submitted"), detail: t("正在等待供应商结果", "Waiting for provider result") };
      case "video_completed":
        return { icon: "check_circle", label: t("视频已加入画布", "Video added to canvas"), detail: t("可直接预览播放", "Ready to preview") };
      case "video_failed":
      case "video_submit_failed":
      case "video_status_failed":
        return { icon: "error", label: t("视频生成失败", "Video generation failed"), detail: t("请稍后重试或更换模板", "Retry later or switch template") };
      case "video_still_running":
        return { icon: "hourglass_empty", label: t("后台继续生成", "Still running"), detail: t("稍后可在历史记录查看", "Check History later") };
      default:
        return { icon: "bolt", label: t("执行动作", "Run action"), detail: action?.type || "" };
    }
  };
  const zoomPercent = Math.round(viewport.scale * 100);
  const saveStateTone = {
    dirty: { background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.goldLine}` },
    saving: { background: ui.blueSoft, color: ui.blue, border: `1px solid ${ui.blueLine}` },
    saved: { background: ui.goldSoft, color: ui.text, border: `1px solid ${ui.line}` },
    error: { background: ui.dangerSoft, color: ui.danger, border: `1px solid ${ui.dangerLine}` },
  }[saveState] || { background: ui.goldSoft, color: ui.text, border: `1px solid ${ui.line}` };
  const panelChromeStyle = {
    background: ui.panel,
    border: `1px solid ${ui.line}`,
    boxShadow: ui.shadow,
    backdropFilter: "blur(18px)",
  };
  const leftPanelChromeStyle = {
    background: theme === "day" ? "rgba(255,255,255,0.82)" : "rgba(17,19,24,0.76)",
    border: `1px solid ${theme === "day" ? "rgba(17,24,39,0.08)" : "rgba(255,255,255,0.08)"}`,
    boxShadow: theme === "day" ? "0 18px 46px rgba(15,23,42,0.10)" : "0 18px 46px rgba(0,0,0,0.30)",
    backdropFilter: "blur(24px)",
  };
  const leftPanelCardStyle = {
    background: theme === "day" ? "rgba(255,255,255,0.62)" : "rgba(255,255,255,0.045)",
    border: `1px solid ${theme === "day" ? "rgba(17,24,39,0.07)" : "rgba(255,255,255,0.07)"}`,
    boxShadow: theme === "day" ? "0 8px 24px rgba(15,23,42,0.055)" : "0 8px 24px rgba(0,0,0,0.18)",
  };
  const subtleButtonStyle = {
    background: ui.panelSolid,
    color: ui.text,
    border: `1px solid ${ui.line}`,
    boxShadow: ui.softShadow,
  };
  const floatingToolButtonStyle = {
    background: "transparent",
    color: ui.text,
    border: "1px solid transparent",
  };
  const activeFloatingToolStyle = {
    background: ui.accent,
    color: ui.accentText,
    border: `1px solid ${theme === "day" ? "rgba(17,24,39,0.12)" : "rgba(255,255,255,0.16)"}`,
    boxShadow: ui.softShadow,
  };
  const tintedButtonStyle = {
    background: ui.blueSoft,
    color: ui.blue,
    border: `1px solid ${ui.blueLine}`,
    boxShadow: ui.softShadow,
  };
  const goldButtonStyle = {
    background: ui.goldSoft,
    color: ui.gold,
    border: `1px solid ${ui.goldLine}`,
    boxShadow: ui.softShadow,
  };
  const dangerButtonStyle = {
    background: ui.dangerSoft,
    color: ui.danger,
    border: `1px solid ${ui.dangerLine}`,
    boxShadow: ui.softShadow,
  };
  const inspectorCardStyle = {
    background: ui.inspectorCard,
    border: `1px solid ${ui.line}`,
    boxShadow: ui.softShadow,
  };
  const inspectorInputStyle = {
    background: ui.inspectorInput,
    color: ui.text,
    border: `1px solid ${ui.line}`,
    boxShadow: ui.inputInset,
  };

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: ui.page }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: ui.accent, borderTopColor: "transparent" }} />
          <p className="text-sm" style={{ color: ui.faint }}>
            {t("正在加载工作流画布…", "Loading workflow canvas…")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={pageRef}
      className="h-screen overflow-hidden relative"
      style={{
        background: ui.page,
        color: ui.text,
        fontFamily: "Inter, Space Grotesk, sans-serif",
        overscrollBehavior: "none",
      }}
    >
      <style>
        {`
          @keyframes canvasZoomPulse {
            0% { opacity: 0; transform: translate(-50%, -50%) scale(0.72); }
            35% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            100% { opacity: 0; transform: translate(-50%, -50%) scale(1.18); }
          }
          .canvas-toolbar-scroll::-webkit-scrollbar {
            display: none;
          }
          .canvas-slim-scroll {
            scrollbar-width: thin;
            scrollbar-color: rgba(148,163,184,0.36) transparent;
          }
          .canvas-slim-scroll::-webkit-scrollbar {
            width: 6px;
          }
          .canvas-slim-scroll::-webkit-scrollbar-track {
            background: transparent;
          }
          .canvas-slim-scroll::-webkit-scrollbar-thumb {
            background: rgba(148,163,184,0.34);
            border-radius: 999px;
          }
          .canvas-slim-scroll::-webkit-scrollbar-thumb:hover {
            background: rgba(100,116,139,0.46);
          }
          @keyframes canvasAgentGlow {
            0%, 100% { box-shadow: 0 0 0 1px rgba(217, 170, 92, 0.18), 0 0 18px rgba(217, 170, 92, 0.04); }
            50% { box-shadow: 0 0 0 1px rgba(217, 170, 92, 0.72), 0 0 30px rgba(217, 170, 92, 0.22); }
          }
          .canvas-agent-running { animation: canvasAgentGlow 2.4s ease-in-out infinite; }
        `}
      </style>
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0" style={{ background: ui.pageGlow }} />
        <div className="absolute inset-0" style={{ background: ui.pageGlowWarm }} />
        <div className="absolute inset-0" style={{ background: ui.pageGlowSoft }} />
      </div>
      <div
        className="absolute inset-x-0 top-0 z-50 px-3 pt-3 pb-2 flex items-start justify-between gap-4 pointer-events-none"
        style={{
          background: ui.topFade,
          right: showAiPanel ? agentPanelWidth : 0,
        }}
      >
        <div className="flex items-center gap-2 min-w-0 pointer-events-auto">
	              <button
            type="button"
            onClick={() => navigate("/ai")}
            aria-label={t("返回总览", "Back to dashboard")}
            title={t("返回总览", "Back to dashboard")}
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }}
          >
            <span className="material-symbols-outlined text-[17px]">gesture</span>
          </button>
          <div
            className="min-w-0 rounded-lg px-2.5 py-1.5 flex items-center gap-2.5"
            style={{
              background: ui.panelStrong,
              border: `1px solid ${ui.line}`,
              boxShadow: ui.softShadow,
              backdropFilter: "blur(18px)",
            }}
          >
            <div className="min-w-0">
              <input
                value={canvasTitle}
                onChange={(event) => setCanvasTitle(event.target.value)}
                className="bg-transparent outline-none text-xs font-semibold w-[168px] max-w-full"
                style={{ color: ui.text, fontFamily: "Inter, Space Grotesk, sans-serif" }}
              />
            </div>
            <div className="hidden md:block w-px h-6" style={{ background: ui.line }} />
            <div className="hidden md:flex items-center gap-2">
              <div className="inline-flex h-6 items-center rounded-md px-2 text-[9px] font-semibold" style={saveStateTone}>
                {saveStateLabel}
              </div>
              <button
                type="button"
                onClick={() => void saveCanvas()}
                className="w-7 h-7 rounded-md flex items-center justify-center"
                style={subtleButtonStyle}
                title={t("立即保存", "Save now")}
              >
	                <span className="material-symbols-outlined text-[14px]">save</span>
	              </button>
	              <button
	                type="button"
	                onClick={() => setCanvasHistoryOpen(true)}
	                disabled={!activeCanvasId}
                className="w-7 h-7 rounded-md flex items-center justify-center disabled:opacity-40"
	                style={subtleButtonStyle}
	                title={t("画布历史", "Canvas history")}
	              >
	                <span className="material-symbols-outlined text-[14px]">history</span>
	              </button>
            </div>
          </div>
        </div>

        <div
          className="canvas-toolbar-scroll flex items-center gap-2 pointer-events-auto min-w-0 max-w-full overflow-x-auto pb-1"
          style={{ scrollbarWidth: "none" }}
        >
          {MIXED_CANVAS_ENABLED && (
            <div className="flex items-center gap-0.5 rounded-lg p-0.5 flex-shrink-0" style={{ background: ui.panelSolid, border: `1px solid ${ui.line}` }}>
              {STUDIO_MODES.map((mode) => (
                <button
                  key={mode.key}
                  type="button"
                  onClick={() => setWorkspaceMode(mode.key)}
                  className="h-7 rounded-md px-2 flex items-center gap-1 text-[9px] font-semibold whitespace-nowrap"
                  style={workspaceMode === mode.key ? tintedButtonStyle : { background: "transparent", color: ui.muted }}
                  title={t(mode.zh, mode.en)}
                >
                  <span className="material-symbols-outlined text-[14px]">{mode.icon}</span>
                  <span className="hidden 2xl:inline">{t(mode.zh, mode.en)}</span>
                </button>
              ))}
            </div>
          )}
          <CanvasIconButton label={t("切换左侧面板", "Toggle left panel")} tooltipSide="bottom" onClick={() => setShowLeftPanel((prev) => !prev)} active={showLeftPanel} style={{ ...(showLeftPanel ? tintedButtonStyle : subtleButtonStyle), backdropFilter: "blur(16px)" }}>
            <span className="material-symbols-outlined text-[14px]">left_panel_open</span>
          </CanvasIconButton>
          <CanvasIconButton label={t("切换右侧面板", "Toggle right panel")} tooltipSide="bottom" onClick={() => setShowRightPanel((prev) => !prev)} active={showRightPanel} style={{ ...(showRightPanel ? tintedButtonStyle : subtleButtonStyle), backdropFilter: "blur(16px)" }}>
            <span className="material-symbols-outlined text-[14px]">right_panel_open</span>
          </CanvasIconButton>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("添加便签", "Add note")} tooltipSide="bottom" onClick={addTextNote} style={tintedButtonStyle}><span className="material-symbols-outlined text-[14px]">sticky_note_2</span></CanvasIconButton></span>
          <CanvasIconButton label={_uploadingAsset ? t("正在上传素材", "Uploading asset") : t("上传素材", "Upload asset")} tooltipSide="bottom" onClick={openAssetPicker} disabled={_uploadingAsset} style={subtleButtonStyle}><span className={`material-symbols-outlined text-[14px] ${_uploadingAsset ? "animate-pulse" : ""}`}>upload_file</span></CanvasIconButton>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("打开画布 Agent", "Open Canvas Agent")} tooltipSide="bottom" onClick={() => setShowAiPanel((prev) => !prev)} active={showAiPanel} style={showAiPanel ? goldButtonStyle : tintedButtonStyle}><span className="material-symbols-outlined text-[14px]">auto_awesome</span></CanvasIconButton></span>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("切换画布工作流", "Toggle canvas workflow")} tooltipSide="bottom" onClick={() => setShowWorkflowLayer((current) => !current)} active={showWorkflowLayer} style={showWorkflowLayer ? goldButtonStyle : subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">account_tree</span></CanvasIconButton></span>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("切换日夜主题", "Toggle day/night theme")} tooltipSide="bottom" onClick={() => writeStarDrawTheme(theme === "night" ? "day" : "night")} style={subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">{theme === "night" ? "dark_mode" : "light_mode"}</span></CanvasIconButton></span>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("适配视图", "Fit view")} tooltipSide="bottom" onClick={fitToContent} style={subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">fit_screen</span></CanvasIconButton></span>
          <span className="hidden md:inline-flex"><CanvasIconButton label={t("切换画布全屏", "Toggle canvas fullscreen")} tooltipSide="bottom" onClick={() => void toggleCanvasFullscreen()} active={isCanvasFullscreen} style={isCanvasFullscreen ? goldButtonStyle : subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">{isCanvasFullscreen ? "fullscreen_exit" : "fullscreen"}</span></CanvasIconButton></span>
          <span className="hidden 2xl:inline-flex"><CanvasIconButton label={t("选择工具", "Select tool")} tooltipSide="bottom" onClick={activateSelectTool} active={selectToolMode} style={selectToolMode ? tintedButtonStyle : subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">arrow_selector_tool</span></CanvasIconButton></span>
          <span className="hidden 2xl:inline-flex"><CanvasIconButton label={t("抓手工具", "Hand tool")} tooltipSide="bottom" onClick={togglePinnedHandTool} active={handToolPinned} style={handToolPinned ? tintedButtonStyle : subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">pan_tool</span></CanvasIconButton></span>
          <span className="hidden 2xl:inline-flex"><CanvasIconButton label={t("缩放工具", "Zoom tool")} tooltipSide="bottom" onClick={togglePinnedZoomTool} active={zoomToolPinned} style={zoomToolPinned ? goldButtonStyle : subtleButtonStyle}><span className="material-symbols-outlined text-[14px]">search</span></CanvasIconButton></span>
          <CanvasIconButton label={deletingCanvas ? t("正在删除画布", "Deleting canvas") : t("删除当前画布", "Delete current canvas")} tooltipSide="bottom" onClick={() => void deleteCanvas()} disabled={!activeCanvasId || deletingCanvas || creatingCanvas || loadingCanvas} style={dangerButtonStyle}><span className={`material-symbols-outlined text-[14px] ${deletingCanvas ? "animate-pulse" : ""}`}>delete</span></CanvasIconButton>
          <CanvasIconButton label={t("导出画布 PNG", "Export canvas PNG")} tooltipSide="bottom" onClick={() => void exportCanvasAsImage()} disabled={exportingCanvas} style={{ background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }}><span className={`material-symbols-outlined text-[14px] ${exportingCanvas ? "animate-pulse" : ""}`}>download</span></CanvasIconButton>
        </div>
      </div>

      {LEGACY_CANVAS_AGENT_PANEL_ENABLED && showAiPanel && (
        <aside
          data-touch-ignore="true"
          className="absolute right-0 top-0 bottom-0 z-40 max-w-[calc(100vw-24px)] overflow-hidden"
          style={{
            width: agentPanelWidth,
            background: ui.aiPanel,
            borderLeft: `1px solid ${ui.line}`,
            boxShadow: ui.aiPanelShadow,
            backdropFilter: "blur(22px)",
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t("拖拽调整 Agent 面板宽度", "Drag to resize Agent panel")}
            onPointerDown={startAgentPanelResize}
            className="absolute left-0 top-0 bottom-0 z-50 w-3 cursor-ew-resize group"
            style={{ touchAction: "none" }}
          >
            <span
              className="absolute left-[5px] top-1/2 h-16 w-0.5 -translate-y-1/2 rounded-full opacity-50 transition-opacity group-hover:opacity-100"
              style={{ background: ui.blue }}
            />
          </button>

          <div className="relative h-full flex flex-col px-3 py-3 pl-4">
            <div className="h-11 flex items-center justify-between gap-3 flex-shrink-0">
              <div className="min-w-0 flex items-center gap-2">
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{ background: ui.accent, color: ui.accentText }}
                >
                  <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-black truncate" style={{ color: ui.text }}>
                    {activeAgentConversation?.title || t("新对话", "New chat")}
                  </p>
                  <div className="mt-0.5 flex items-center gap-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.14em]" style={{ color: ui.faint }}>
                      {agentRunning ? t("Agent 思考中", "Agent thinking") : AGENT_MODEL_LABEL}
                    </p>
                    <CanvasRoundedSelect label={t("Agent 权限模式", "Agent access mode")} value={agentAccessMode} onChange={setAgentAccessMode} options={AGENT_ACCESS_MODES.map((mode) => ({ value: mode.key, label: t(mode.zh, mode.en) }))} ui={ui} className="min-w-[118px]" triggerClassName="h-7 w-full rounded-lg px-1.5 text-[10px] font-bold" menuMinWidth={190} />
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="hidden sm:inline-flex rounded-full px-2 py-1 text-[10px] font-black"
                  style={selectedIds.length > 0 ? tintedButtonStyle : subtleButtonStyle}
                >
                  {selectedIds.length}/{elements.length}
                </span>
	                <button
	                  type="button"
	                  onClick={() => setAgentHistoryOpen((current) => !current)}
	                  className="w-8 h-8 rounded-full flex items-center justify-center"
	                  style={agentHistoryOpen ? tintedButtonStyle : subtleButtonStyle}
	                  title={t("历史对话", "Conversation history")}
	                  aria-expanded={agentHistoryOpen}
	                >
	                  <span className="material-symbols-outlined text-[16px]">history</span>
	                </button>
	                <button
	                  type="button"
		                  onClick={() => void startNewCanvasAgentConversation()}
	                  disabled={agentRunning || agentConversationLoading || !activeCanvasId}
	                  className="w-8 h-8 rounded-full flex items-center justify-center disabled:opacity-40"
	                  style={subtleButtonStyle}
	                  title={t("新建对话", "New chat")}
                >
                  <span className="material-symbols-outlined text-[16px]">edit_square</span>
                </button>
                <button
                  type="button"
                  onClick={() => setShowAiPanel(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center"
                  style={subtleButtonStyle}
                  title={t("关闭", "Close")}
                >
                  <span className="material-symbols-outlined text-[16px]">close</span>
                </button>
              </div>
            </div>

            {agentHistoryOpen && (
              <div
                className="absolute left-4 right-3 top-14 z-[70] max-h-80 overflow-y-auto rounded-[20px] p-2"
                style={{
                  background: ui.panelStrong,
                  border: `1px solid ${ui.line}`,
                  boxShadow: theme === "day" ? "0 18px 56px rgba(17,24,39,0.16)" : "0 24px 70px rgba(0,0,0,0.5)",
                  backdropFilter: "blur(20px)",
                }}
              >
                <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                  <p className="text-[10px] font-black uppercase tracking-[0.16em]" style={{ color: ui.faint }}>
                    {t("历史对话", "Conversation history")}
                  </p>
                  <button
                    type="button"
                    onClick={() => void startNewCanvasAgentConversation()}
                    className="text-[10px] font-black"
                    style={{ color: ui.blue }}
                  >
                    {t("新建", "New")}
                  </button>
                </div>
                {agentConversations.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs" style={{ color: ui.faint }}>
                    {t("当前画布暂无历史对话", "No conversations for this canvas")}
                  </p>
                ) : agentConversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => void selectCanvasAgentConversation(conversation.id)}
                    className="mb-1 block w-full rounded-2xl px-3 py-2.5 text-left last:mb-0"
                    style={conversation.id === agentSessionId ? tintedButtonStyle : subtleButtonStyle}
                  >
                    <span className="block truncate text-xs font-black" style={{ color: ui.text }}>
                      {conversation.title || t("新对话", "New chat")}
                    </span>
                    <span className="mt-1 flex items-center justify-between gap-2 text-[10px]" style={{ color: ui.faint }}>
                      <span>{t(`${conversation.message_count || 0} 条消息`, `${conversation.message_count || 0} messages`)}</span>
                      <span>{new Date(conversation.updated_at || conversation.created_at).toLocaleString(isZh ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-hidden">
              <div className="h-full overflow-y-auto px-2 py-3">
                {agentMessages.length === 0 && !agentRunning ? (
                  <div className="min-h-full flex flex-col items-center justify-center text-center px-2">
                    <div
                      className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
                      style={{ background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.goldLine}` }}
                    >
                      <span className="material-symbols-outlined">auto_awesome</span>
                    </div>
                    <p className="text-sm font-black" style={{ color: ui.text }}>
                      {t("试试 StarDraw Agent 技能", "Try these StarDraw Agent skills")}
                    </p>
                    <p className="mt-2 max-w-[300px] text-xs leading-relaxed" style={{ color: ui.muted }}>
                      {t("用自然语言让 Agent 直接整理画布、生成便签、优化提示词或调用模板工作流。", "Use natural language to organize the board, create notes, rewrite prompts, or trigger template workflows.")}
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                      {agentSkillSuggestions.map((skill) => (
                        <button
                          key={skill.label}
                          type="button"
                          onClick={() => void runCanvasAgent(skill.prompt)}
                          disabled={agentRunning}
                          className="rounded-full px-3 py-2 text-xs font-bold disabled:opacity-45 flex items-center gap-1.5"
                          style={subtleButtonStyle}
                        >
                          <span className="material-symbols-outlined text-[15px]">{skill.icon}</span>
                          {skill.label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => void runCanvasAgent(t("请列出你能对当前画布执行的操作，并给出三个建议。", "List what you can do on this canvas and give me three suggestions."))}
                      className="mt-3 rounded-full px-3 py-2 text-xs font-bold"
                      style={tintedButtonStyle}
                    >
                      {t("全部能力", "All skills")}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {agentMessages.map((message) => {
                      const isUser = message.role === "user";
                      const statusMeta = getAgentStatusMeta(message);
                      const statusStyle = statusMeta.tone === "danger"
                        ? dangerButtonStyle
                        : statusMeta.tone === "gold"
                          ? goldButtonStyle
                          : tintedButtonStyle;
                      const progressValue = Number.isFinite(Number(message.progress))
                        ? clamp(message.progress, 0, 100, 0)
                        : null;
                      const hasActions = !isUser && Array.isArray(message.actions) && message.actions.length > 0;
                      const actionMetas = hasActions
                        ? message.actions.map((action) => getAgentActionMeta(action))
                        : [];
                      const actionDetailsOpen = expandedAgentDetails.has(message.id);
                      const actionPreview = actionMetas.slice(0, 3);

                      return (
                        <div key={message.id} className={`flex gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
                          {!isUser && (
                            <span
                              className="mt-1 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                              style={statusStyle}
                            >
                              <span className="material-symbols-outlined text-[15px]">
                                {statusMeta.icon}
                              </span>
                            </span>
                          )}
                          <div
                            className={`${isUser ? "max-w-[84%]" : "max-w-[92%]"} rounded-[22px] px-4 py-3`}
                            style={isUser
                              ? { background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }
                              : {
                                  background: message.error ? ui.dangerSoft : ui.panelSolid,
                                  color: message.error ? ui.danger : ui.text,
                                  border: `1px solid ${message.error ? ui.dangerLine : ui.line}`,
                                  boxShadow: ui.softShadow,
                                }}
                          >
                            {!isUser && (message.title || message.status) && (
                              <div className="mb-2 flex items-center justify-between gap-3">
                                <div className="min-w-0 flex items-center gap-2">
                                  <span
                                    className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                                    style={statusStyle}
                                  >
                                    <span className="material-symbols-outlined text-[14px]">{statusMeta.icon}</span>
                                  </span>
                                  <span className="text-xs font-black truncate" style={{ color: message.error ? ui.danger : ui.text }}>
                                    {message.title || statusMeta.label}
                                  </span>
                                </div>
                                <span className="rounded-full px-2 py-1 text-[10px] font-black flex-shrink-0" style={statusStyle}>
                                  {statusMeta.label}
                                </span>
                              </div>
                            )}
                            {progressValue !== null && (
                              <div className="mb-3 h-1.5 overflow-hidden rounded-full" style={{ background: ui.soft2 }}>
                                <div
                                  className="h-full rounded-full transition-all duration-500"
                                  style={{
                                    width: `${progressValue}%`,
                                    background: statusMeta.tone === "danger" ? ui.danger : statusMeta.tone === "gold" ? ui.gold : ui.blue,
                                  }}
                                />
                              </div>
                            )}
                            {message.content && (
                              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                                {message.content}
                              </p>
                            )}
                            {!isUser && Array.isArray(message.steps) && message.steps.length > 0 && (
                              <div className="mt-3 grid gap-1.5">
                                {message.steps.map((step, index) => {
                                  const stepStatus = step?.status || "pending";
                                  const isStepFailed = stepStatus === "failed";
                                  const isStepRunning = stepStatus === "running";
                                  const isStepCompleted = stepStatus === "completed";
                                  const stepStyle = isStepFailed
                                    ? dangerButtonStyle
                                    : isStepRunning
                                      ? goldButtonStyle
                                      : isStepCompleted
                                        ? tintedButtonStyle
                                        : subtleButtonStyle;
                                  const stepIcon = isStepFailed
                                    ? "error"
                                    : isStepRunning
                                      ? "progress_activity"
                                      : isStepCompleted
                                        ? "check_circle"
                                        : "radio_button_unchecked";

                                  return (
                                    <div
                                      key={`${message.id}_step_${index}`}
                                      className="flex items-center gap-2 rounded-2xl px-2.5 py-2 text-xs font-bold"
                                      style={{
                                        ...stepStyle,
                                        justifyContent: "flex-start",
                                      }}
                                    >
                                      <span className={`material-symbols-outlined text-[15px] ${isStepRunning ? "animate-spin" : ""}`}>
                                        {stepIcon}
                                      </span>
                                      <span className="min-w-0 truncate">
                                        {step.label}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {!isUser && Array.isArray(message.promptDrafts) && message.promptDrafts.length > 0 && (
                              <div className="mt-3 space-y-2">
                                {message.promptDrafts.map((draft, index) => {
                                  const isVideoDraft = draft.type === "set_video_prompt";
                                  return (
                                    <div
                                      key={`${message.id}_prompt_${index}`}
                                      className="rounded-[18px] p-3"
                                      style={{ background: ui.soft, border: `1px solid ${ui.line}` }}
                                    >
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0 flex items-center gap-2">
                                          <span className="w-8 h-8 rounded-2xl flex items-center justify-center flex-shrink-0" style={isVideoDraft ? goldButtonStyle : tintedButtonStyle}>
                                            <span className="material-symbols-outlined text-[16px]">
                                              {isVideoDraft ? "movie_filter" : "image"}
                                            </span>
                                          </span>
                                          <div className="min-w-0">
                                            <p className="text-xs font-black truncate" style={{ color: ui.text }}>
                                              {draft.label}
                                            </p>
                                            <p className="text-[10px] font-bold" style={{ color: ui.faint }}>
                                              {draft.useSelection
                                                ? t("使用选中参考图", "Uses selected references")
                                                : t("不使用参考图", "No references")}
                                              {draft.sceneKey ? ` · ${draft.sceneKey}` : ""}
                                            </p>
                                          </div>
                                        </div>
                                        {draft.autoRun && (
                                          <span
                                            className="rounded-full px-2.5 py-1 text-[10px] font-black flex-shrink-0"
                                            style={isVideoDraft ? goldButtonStyle : tintedButtonStyle}
                                          >
                                            {t("已自动执行", "Auto started")}
                                          </span>
                                        )}
                                      </div>
                                      <p className="mt-2 max-h-36 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap" style={{ color: ui.muted }}>
                                        {draft.prompt}
                                      </p>
                                      {draft.autoRun && (
                                        <div
                                          className="mt-3 flex items-start gap-2 rounded-2xl px-3 py-2"
                                          style={isVideoDraft ? goldButtonStyle : tintedButtonStyle}
                                        >
                                          <span className="material-symbols-outlined text-[15px] mt-0.5">
                                            task_alt
                                          </span>
                                          <span className="text-[11px] font-bold leading-relaxed">
                                            {t(
                                              "Agent 已自动提交这次生成任务，完成后会写入画布；下方按钮仅用于复制或重新执行。",
                                              "Agent already submitted this generation task and will add the result to the canvas; buttons below are only for copy or rerun.",
                                            )}
                                          </span>
                                        </div>
                                      )}
                                      <div className="mt-3 flex flex-wrap gap-2">
                                        <button
                                          type="button"
                                          onClick={() => void copyAgentText(draft.prompt)}
                                          className="rounded-full px-3 py-1.5 text-[11px] font-black"
                                          style={subtleButtonStyle}
                                        >
                                          {t("复制", "Copy")}
                                        </button>
                                        {!draft.autoRun && (
                                          <button
                                            type="button"
                                            onClick={() => applyAgentPromptDraft(draft)}
                                            className="rounded-full px-3 py-1.5 text-[11px] font-black"
                                            style={tintedButtonStyle}
                                          >
                                            {t("填入", "Apply")}
                                          </button>
                                        )}
                                        <button
                                          type="button"
                                          onClick={() => generateFromAgentPromptDraft(draft)}
                                          disabled={isVideoDraft ? canvasVideoGenerating : canvasAiGenerating}
                                          className="rounded-full px-3 py-1.5 text-[11px] font-black disabled:opacity-45"
                                          style={draft.autoRun
                                            ? subtleButtonStyle
                                            : isVideoDraft
                                              ? goldButtonStyle
                                              : { background: ui.accent, color: ui.accentText, border: `1px solid ${ui.line}`, boxShadow: ui.softShadow }}
                                        >
                                          {draft.autoRun
                                            ? t("重新执行", "Run Again")
                                            : isVideoDraft
                                              ? t("生成视频", "Generate Video")
                                              : t("生成图片", "Generate Image")}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                            {!isUser && (message.error || message.status === "failed") && message.retryDraft?.prompt && (
                              <div className="mt-3 rounded-[18px] p-3" style={{ background: ui.soft, border: `1px solid ${ui.dangerLine}` }}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="text-xs font-black" style={{ color: ui.text }}>
                                      {t("可以直接重试这次任务", "You can retry this task directly")}
                                    </p>
                                    <p className="mt-1 text-[10px] truncate" style={{ color: ui.faint }}>
                                      {message.retryDraft.sceneKey || t("自由生成", "Freeform")}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => generateFromAgentPromptDraft(message.retryDraft)}
                                    disabled={message.retryDraft.type === "set_video_prompt" ? canvasVideoGenerating : canvasAiGenerating}
                                    className="rounded-full px-3 py-1.5 text-[11px] font-black disabled:opacity-45 flex-shrink-0"
                                    style={message.retryDraft.type === "set_video_prompt" ? goldButtonStyle : { background: ui.accent, color: ui.accentText, border: `1px solid ${ui.line}`, boxShadow: ui.softShadow }}
                                  >
                                    {message.retryDraft.type === "set_video_prompt"
                                      ? t("重试视频", "Retry Video")
                                      : t("重试图片", "Retry Image")}
                                  </button>
                                </div>
                              </div>
                            )}
                            {message.imageUrl && (
                              <div className="mt-3 overflow-hidden rounded-2xl" style={{ border: `1px solid ${ui.line}`, background: ui.soft }}>
                                <OssImage src={message.imageUrl} alt="" className="w-full max-h-56 object-cover" />
                              </div>
                            )}
                            {message.videoUrl && (
                              <div className="mt-3 overflow-hidden rounded-2xl" style={{ border: `1px solid ${ui.line}`, background: ui.soft }}>
                                <OssVideo
                                  src={message.videoUrl}
                                  poster={message.poster || undefined}
                                  controls
                                  className="w-full max-h-56 object-cover"
                                />
                              </div>
                            )}
                            {isUser && Array.isArray(message.mentions) && message.mentions.length > 0 && (
                              <div className="mt-3 flex flex-wrap gap-1.5">
                                {message.mentions.map((mention) => (
                                  <span
                                    key={`${message.id}_${mention.key}`}
                                    className="rounded-full px-2 py-1 text-[10px] font-black"
                                    style={{ background: "rgba(255,255,255,0.16)", color: "currentColor", border: "1px solid rgba(255,255,255,0.2)" }}
                                  >
                                    @{mention.label}
                                  </span>
                                ))}
                              </div>
                            )}
                            {hasActions && (
                              <div className="mt-3 rounded-[18px] p-2.5" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-[10px] font-black uppercase tracking-[0.16em]" style={{ color: ui.faint }}>
                                      {t("执行概览", "Execution Summary")}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-1.5">
                                      {actionPreview.map((actionMeta, index) => (
                                        <span
                                          key={`${message.id}_summary_${index}`}
                                          className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black"
                                          style={tintedButtonStyle}
                                        >
                                          <span className="material-symbols-outlined text-[13px]">{actionMeta.icon}</span>
                                          <span className="truncate">{actionMeta.label}</span>
                                        </span>
                                      ))}
                                      {message.actions.length > actionPreview.length && (
                                        <span className="rounded-full px-2 py-1 text-[10px] font-black" style={subtleButtonStyle}>
                                          +{message.actions.length - actionPreview.length}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => toggleAgentDetails(message.id)}
                                    className="rounded-full px-2.5 py-1.5 text-[10px] font-black flex items-center gap-1 flex-shrink-0"
                                    style={subtleButtonStyle}
                                  >
                                    {actionDetailsOpen ? t("收起", "Hide") : t("查看细节", "Details")}
                                    <span className="material-symbols-outlined text-[14px]">
                                      {actionDetailsOpen ? "expand_less" : "expand_more"}
                                    </span>
                                  </button>
                                </div>

                                {actionDetailsOpen && (
                                  <div className="mt-2 space-y-1.5">
                                    {message.actions.map((action, index) => {
                                      const actionMeta = actionMetas[index] || getAgentActionMeta(action);
                                      return (
                                        <div
                                          key={`${message.id}_${action.type}_${index}`}
                                          className="flex items-center gap-2 rounded-2xl px-2.5 py-2"
                                          style={{ background: ui.panelSolid, border: `1px solid ${ui.line}` }}
                                        >
                                          <span className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={tintedButtonStyle}>
                                            <span className="material-symbols-outlined text-[15px]">{actionMeta.icon}</span>
                                          </span>
                                          <span className="min-w-0 flex-1">
                                            <span className="block text-xs font-black truncate" style={{ color: ui.text }}>
                                              {actionMeta.label}
                                            </span>
                                            {actionMeta.detail && (
                                              <span className="block text-[10px] truncate" style={{ color: ui.faint }}>
                                                {actionMeta.detail}
                                              </span>
                                            )}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            )}
                            {!isUser && (message.provider || message.model || Number.isFinite(Number(message.appliedCount))) && (
                              <p className="text-[10px] mt-2 font-bold uppercase tracking-[0.14em]" style={{ color: ui.faint }}>
                                {message.provider || "agent"}{message.model ? ` · ${message.model}` : ""}
                                {Number.isFinite(Number(message.appliedCount)) ? ` · ${t(`执行 ${message.appliedCount} 个动作`, `${message.appliedCount} actions`)}` : ""}
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {agentRunning && !agentMessages.some((message) => message.kind === "agent_planning" && message.status === "running") && (
                      <div className="flex justify-start gap-2">
                        <span className="mt-1 w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0" style={goldButtonStyle}>
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: ui.gold, borderTopColor: "transparent" }} />
                        </span>
                        <div className="rounded-[22px] px-4 py-3" style={inspectorCardStyle}>
                          <span className="text-sm font-bold" style={{ color: ui.text }}>
                            {t("Agent 正在规划画布动作…", "Agent is planning canvas actions...")}
                          </span>
                        </div>
                      </div>
                    )}
                    <div ref={agentMessagesEndRef} className="h-1" aria-hidden="true" />
                  </div>
                )}
              </div>
            </div>

            <div className="flex-shrink-0 pt-2">
              <div className="canvas-toolbar-scroll flex items-center gap-2 overflow-x-auto pb-2">
                {agentQuickPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void runCanvasAgent(prompt)}
                    disabled={agentRunning}
                    className="rounded-full px-3 py-1.5 text-[11px] font-bold whitespace-nowrap disabled:opacity-45"
                    style={subtleButtonStyle}
                  >
                    {prompt}
                  </button>
                ))}
              </div>

	              <form
	                className="relative rounded-[26px] p-2"
	                style={{
	                  background: ui.inspectorInput,
	                  border: `1px solid ${ui.line}`,
	                  boxShadow: theme === "day" ? "0 18px 46px rgba(17,24,39,0.09)" : "0 20px 54px rgba(0,0,0,0.36)",
                }}
                onSubmit={(event) => {
	                  event.preventDefault();
	                  void runCanvasAgent();
	                }}
	              >
	                {agentMentionState.open && (
	                  <div
	                    className="absolute left-2 right-2 bottom-[calc(100%+8px)] z-50 max-h-80 overflow-y-auto rounded-[22px] p-2"
	                    style={{
	                      background: ui.panelStrong,
	                      border: `1px solid ${ui.line}`,
	                      boxShadow: theme === "day" ? "0 18px 60px rgba(17,24,39,0.14)" : "0 22px 70px rgba(0,0,0,0.48)",
	                      backdropFilter: "blur(20px)",
	                    }}
	                  >
	                    <div className="px-2 pb-2 flex items-center justify-between gap-3">
	                      <p className="text-[10px] font-black uppercase tracking-[0.18em]" style={{ color: ui.faint }}>
	                        {t("@ 素材 / 模板", "@ Assets / Templates")}
	                      </p>
	                      <p className="text-[10px]" style={{ color: ui.faint }}>
	                        {t("回车插入", "Enter to insert")}
	                      </p>
	                    </div>
	                    {agentMentionOptions.length === 0 ? (
	                      <div className="rounded-2xl px-3 py-4 text-sm text-center" style={{ color: ui.muted, background: ui.soft }}>
	                        {t("没有匹配的素材或模板", "No matching assets or templates")}
	                      </div>
	                    ) : agentMentionOptions.map((option, index) => (
	                      <button
	                        key={option.key}
	                        type="button"
	                        onMouseDown={(event) => {
	                          event.preventDefault();
	                          selectAgentMention(option);
	                        }}
	                        className="w-full rounded-2xl px-3 py-2.5 text-left flex items-center gap-3 transition-colors"
	                        style={index === activeMentionIndex ? tintedButtonStyle : { color: ui.text }}
	                      >
	                        <span
	                          className="w-9 h-9 rounded-2xl flex items-center justify-center flex-shrink-0"
	                          style={option.type === "asset" ? goldButtonStyle : tintedButtonStyle}
	                        >
	                          <span className="material-symbols-outlined text-[17px]">{option.icon}</span>
	                        </span>
	                        <span className="min-w-0 flex-1">
	                          <span className="block text-sm font-black truncate" style={{ color: ui.text }}>
	                            {option.label}
	                          </span>
	                          <span className="block text-[11px] truncate" style={{ color: ui.faint }}>
	                            {option.subtitle}
	                            {option.elementId ? ` · ${option.elementId}` : ""}
	                            {option.sceneKey ? ` · ${option.sceneKey}` : ""}
	                          </span>
	                        </span>
	                        <span className="text-[10px] font-black uppercase tracking-[0.12em]" style={{ color: ui.faint }}>
	                          {option.assetType || option.type}
	                        </span>
	                      </button>
	                    ))}
	                  </div>
	                )}
	                {agentMentions.length > 0 && (
	                  <div className="px-2 pb-1 flex flex-wrap gap-1.5">
	                    {agentMentions.map((mention) => (
	                      <button
	                        key={mention.key}
	                        type="button"
	                        onClick={() => removeAgentMention(mention.key)}
	                        className="rounded-full px-2.5 py-1 text-[11px] font-black flex items-center gap-1"
	                        style={mention.type === "asset" ? goldButtonStyle : tintedButtonStyle}
	                        title={t("点击移除引用", "Click to remove mention")}
	                      >
	                        <span className="material-symbols-outlined text-[14px]">{mention.icon}</span>
	                        @{mention.label}
	                        <span className="material-symbols-outlined text-[13px]">close</span>
	                      </button>
	                    ))}
	                  </div>
	                )}
	                <textarea
	                  ref={agentInputRef}
	                  value={agentBrief}
	                  onChange={handleAgentBriefChange}
	                  onSelect={handleAgentInputSelect}
	                  onKeyDown={handleAgentInputKeyDown}
	                  onPaste={handleAgentInputPaste}
	                  onInput={resizeAgentInput}
	                  rows={2}
	                  className="w-full bg-transparent px-3 py-2 outline-none resize-none text-sm leading-relaxed"
	                  style={{
	                    color: ui.text,
	                    minHeight: AGENT_INPUT_MIN_HEIGHT,
	                    maxHeight: AGENT_INPUT_MAX_HEIGHT,
	                    overflowY: "hidden",
	                  }}
                  placeholder={t("从一个想法开始，或输入 @ 调用模板/素材…", "Start with an idea, or type @ to mention templates/assets...")}
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={openAssetPicker}
                      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                      style={subtleButtonStyle}
                      title={t("上传素材", "Upload asset")}
                    >
                      <span className="material-symbols-outlined text-[16px]">add</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void runCanvasAgent(
                        `${agentBrief.trim()}\n\n${t("请直接生成图片并加入画布。", "Generate an image directly and add it to the canvas.")}`,
                        { keepMentions: true },
                      )}
                      disabled={agentRunning || !agentBrief.trim()}
                      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                      style={tintedButtonStyle}
                      title={t("让 Agent 生成图片", "Ask Agent to generate an image")}
                    >
                      <span className="material-symbols-outlined text-[16px]">image</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void runCanvasAgent(
                        `${agentBrief.trim()}\n\n${t("请直接生成视频并加入画布。", "Generate a video directly and add it to the canvas.")}`,
                        { keepMentions: true },
                      )}
                      disabled={agentRunning || !agentBrief.trim()}
                      className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 disabled:opacity-40"
                      style={goldButtonStyle}
                      title={t("让 Agent 生成视频", "Ask Agent to generate a video")}
                    >
                      <span className="material-symbols-outlined text-[16px]">movie_filter</span>
                    </button>
                    <span
                      className="hidden sm:inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[11px] font-black min-w-0"
                      style={subtleButtonStyle}
                    >
                      <span className="material-symbols-outlined text-[15px]">smart_toy</span>
                      {t(
                        AGENT_ACCESS_MODES.find((mode) => mode.key === agentAccessMode)?.zh || "批准后执行",
                        AGENT_ACCESS_MODES.find((mode) => mode.key === agentAccessMode)?.en || "Approve for me",
                      )}
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={agentRunning || !agentBrief.trim()}
                    className="w-9 h-9 rounded-full font-black disabled:opacity-45 flex items-center justify-center flex-shrink-0"
                    style={{ background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }}
                    title={t("发送", "Send")}
                  >
                    {agentRunning ? (
                      <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                    ) : (
                      <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                    )}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 px-2">
                  {[
                    t("Enter 发送", "Enter to send"),
                    t("Shift+Enter 换行", "Shift+Enter newline"),
                    t("@ 引用素材/模板", "@ mention assets/templates"),
                    t("图片/视频按钮会自动执行", "Image/video buttons auto-run"),
                  ].map((hint) => (
                    <span
                      key={hint}
                      className="rounded-full px-2 py-1 text-[10px] font-bold"
                      style={{ background: ui.soft, color: ui.faint, border: `1px solid ${ui.line}` }}
                    >
                      {hint}
                    </span>
                  ))}
                </div>
              </form>
            </div>
          </div>

        </aside>
      )}

      {showAiPanel && (
        <div data-touch-ignore="true" className="absolute bottom-3 right-3 top-3 z-40 max-w-[calc(100vw-30px)] overflow-hidden rounded-[28px] border" style={{ width: agentPanelWidth, borderColor: ui.line, boxShadow: ui.aiPanelShadow }} onMouseDown={(event) => event.stopPropagation()}>
          <button type="button" aria-label={t("拖拽调整 Agent 面板宽度", "Drag to resize Agent panel")} onPointerDown={startAgentPanelResize} className="absolute left-0 top-0 bottom-0 z-50 w-3 cursor-ew-resize" style={{ touchAction: "none" }}><span className="absolute left-[5px] top-1/2 h-16 w-0.5 -translate-y-1/2 rounded-full opacity-50 transition-opacity hover:opacity-100" style={{ background: ui.gold }} /></button>
          <CanvasAgentPanel open={showAiPanel} onClose={() => setShowAiPanel(false)} canvasId={activeCanvasId} authAxios={authAxios} ui={ui} theme={theme} t={t} language={isZh ? "zh" : "en"} width={agentPanelWidth} selectedImageElements={selectedImageElements} onCanvasChanged={() => { if (activeCanvasId) void loadCanvas(activeCanvasId); setCanvasRevisionEpoch((current) => current + 1); }} />
        </div>
      )}

      {workspaceMode === "canvas" && showLeftPanel && (
        <aside
          className="absolute left-3 top-[76px] bottom-3 z-30 w-[300px] md:w-[316px] rounded-[22px] p-3 flex flex-col overflow-hidden"
          style={leftPanelChromeStyle}
        >
          <div className="flex items-center justify-between gap-3 px-1 pb-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.16em]" style={{ color: ui.faint }}>
                {t("画布与素材", "Canvas & Assets")}
              </p>
              <h2 className="text-lg font-black mt-1 truncate" style={{ color: ui.text, fontFamily: "Space Grotesk, Inter, sans-serif" }}>
                {t("创意素材库", "Creative Library")}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => void createCanvas()}
              disabled={creatingCanvas}
              className="w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-40"
              style={{ background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }}
              title={t("新建画布", "New Canvas")}
            >
              {creatingCanvas
                ? <span className="w-4 h-4 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: ui.accentText, borderTopColor: "transparent" }} />
                : <span className="material-symbols-outlined text-[16px]">add</span>}
            </button>
          </div>

          <div className="canvas-slim-scroll max-h-[142px] overflow-y-auto pr-1 pb-3 space-y-1.5">
            {canvases.map((item) => {
              const isActiveCanvas = item.id === activeCanvasId;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={loadingCanvas || deletingCanvas}
                  onClick={() => {
                    setActiveCanvasId(item.id);
                    void loadCanvas(item.id);
                  }}
                  className="w-full rounded-[16px] px-3 py-2.5 text-left transition-all disabled:cursor-wait disabled:opacity-60"
                  style={{
                    background: isActiveCanvas ? ui.blueSoft : "transparent",
                    border: `1px solid ${isActiveCanvas ? ui.blueLine : "transparent"}`,
                    boxShadow: isActiveCanvas ? "0 8px 20px rgba(37,99,235,0.10)" : "none",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-black text-sm truncate" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                      {item.title}
                    </p>
                    {isActiveCanvas && (loadingCanvas
                      ? <span className="w-3 h-3 rounded-full border-2 border-t-transparent animate-spin flex-shrink-0" style={{ borderColor: ui.blue, borderTopColor: "transparent" }} />
                      : <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ui.blue }} />)}
                  </div>
                  <p className="text-[11px] mt-1 truncate" style={{ color: ui.muted }}>
                    {item.element_count || 0} {t("个元素", "elements")} · {new Date(item.updated_at).toLocaleDateString(isZh ? "zh-CN" : "en-US")}
                  </p>
                </button>
              );
            })}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto canvas-slim-scroll pr-1">
            <div className="min-h-0 flex flex-col">
              <div className="flex items-center justify-between mb-2 px-1">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.14em] font-bold" style={{ color: ui.faint }}>
                    {t("最近资产", "Recent Assets")}
                  </p>
                  <p className="text-sm font-black mt-1 truncate" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("从历史记录加入画布", "Add from your history")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => navigate("/ai/history")}
                  className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={subtleButtonStyle}
                  title={t("打开完整历史记录", "Open full history")}
                >
                  <span className="material-symbols-outlined text-[14px]">history</span>
                </button>
              </div>

              <div className="relative mb-2">
                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[14px]" style={{ color: ui.faint }}>
                  search
                </span>
                <input
                  value={assetQuery}
                  onChange={(event) => setAssetQuery(event.target.value)}
                  placeholder={t("搜索历史素材", "Search assets")}
                  className="w-full rounded-[16px] pl-9 pr-3 py-2.5 bg-transparent outline-none text-sm"
                  style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }}
                />
              </div>

              <div className="space-y-3 pb-1">
                {filteredAssets.length === 0 ? (
                  <div className="rounded-[16px] px-3 py-5 text-sm text-center" style={{ background: ui.soft, color: ui.muted, border: `1px dashed ${ui.line2}` }}>
                    {assetQuery
                      ? t("没有匹配的素材", "No matching assets")
                      : t("历史记录里还没有可加入画布的已完成图片或视频。", "No completed history images or videos are available for the canvas yet.")}
                  </div>
                ) : filteredAssetGroups.map((group) => (
                  group.items.length > 0 && (
                    <div key={group.key} className="space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="material-symbols-outlined text-[13px]" style={{ color: ui.faint }}>
                            {group.icon}
                          </span>
                          <p className="text-[11px] font-black truncate" style={{ color: ui.muted }}>
                            {group.title}
                          </p>
                        </div>
                        <span className="text-[10px] font-bold" style={{ color: ui.faint }}>
                          {group.items.length}
                        </span>
                      </div>
                      {group.items.map((asset) => {
                        const previewUrl = asset.type === "video" ? getVideoPosterUrl(asset) : getImageAssetUrl(asset);
                        return (
                          <div key={asset.id} className="rounded-[16px] p-2 flex items-center gap-3" style={leftPanelCardStyle}>
                            <div className="relative w-16 h-16 rounded-[12px] overflow-hidden flex-shrink-0" style={{ background: ui.soft }}>
                              {previewUrl
                                ? <OssImage src={previewUrl} alt="" className="w-full h-full object-cover" />
                                : <div className="w-full h-full flex items-center justify-center">
                                    <span className="material-symbols-outlined text-[20px]" style={{ color: ui.faint }}>
                                      {asset.type === "video" ? "movie_filter" : "image"}
                                    </span>
                                  </div>}
                              {asset.type === "video" && (
                                <span className="absolute right-1.5 bottom-1.5 w-6 h-6 rounded-full flex items-center justify-center" style={{ background: "rgba(0,0,0,0.58)", color: "#fff" }}>
                                  <span className="material-symbols-outlined text-[13px]">play_arrow</span>
                                </span>
                              )}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-black text-sm truncate" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                                {asset.scene_name || asset.title || t("生成资产", "Generated Asset")}
                              </p>
                              <p className="mt-1 text-[10px] uppercase tracking-[0.12em] truncate" style={{ color: ui.faint }}>
                                {asset.type === "video" ? t("视频", "video") : t("图片", "image")}
                                {asset.created_at ? ` · ${new Date(asset.created_at).toLocaleDateString(isZh ? "zh-CN" : "en-US")}` : ""}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => addAssetToCanvas(asset)}
                              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                              style={{ background: ui.blueSoft, color: ui.blue, border: `1px solid ${ui.blueLine}` }}
                              title={t("加入画布", "Add to Canvas")}
                            >
                              <span className="material-symbols-outlined text-[15px]">add</span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )
                ))}
              </div>
            </div>
          </div>
        </aside>
      )}

      {workspaceMode === "canvas" ? (
        <section className="absolute inset-0 z-10 min-h-0">
          <div className="h-full overflow-hidden relative"
            style={{ background: "transparent" }}>
            <div className="hidden absolute top-4 left-4 right-4 z-20 flex items-center justify-between gap-4">
              <div className="rounded-2xl px-4 py-3 flex items-center gap-3"
                style={panelChromeStyle}>
                <span className="material-symbols-outlined" style={{ color: ui.blue }}>gesture</span>
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                    {t("当前画布", "Current Canvas")}
                  </p>
                  <input
                    value={canvasTitle}
                    onChange={(event) => setCanvasTitle(event.target.value)}
                    className="bg-transparent outline-none text-sm font-bold mt-1 w-56 max-w-full"
                    style={{ color: ui.text, fontFamily: "Space Grotesk, Inter, sans-serif" }}
                  />
                </div>
              </div>

              <div className="rounded-2xl px-4 py-3 flex items-center gap-3"
                style={panelChromeStyle}>
                <span className="text-xs font-bold uppercase tracking-widest" style={{ color: ui.faint }}>
                  {Math.round(viewport.scale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => gestureViewportScaleAtCenter(viewport.scale * 0.9)}
                  className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={subtleButtonStyle}
                >
                  <span className="material-symbols-outlined text-[18px]">remove</span>
                </button>
                <button
                  type="button"
                  onClick={() => gestureViewportScaleAtCenter(viewport.scale * 1.1)}
                  className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={subtleButtonStyle}
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                </button>
              </div>
            </div>

            <div
              ref={boardRef}
              className="absolute inset-0 overflow-hidden"
              style={{
                touchAction: "none",
                overscrollBehavior: "none",
                background: ui.page,
                cursor: zoomToolMode
                  ? (zoomToolZoomOut ? "zoom-out" : "zoom-in")
                  : (handToolMode || spacePanMode || isPanActive)
                    ? (isPanActive ? "grabbing" : "grab")
                    : "crosshair",
              }}
              onMouseDown={startPan}
              onDragEnter={handleCanvasAssetDragEnter}
              onDragOver={handleCanvasAssetDragOver}
              onDragLeave={handleCanvasAssetDragLeave}
              onDrop={handleCanvasAssetDrop}
              onContextMenu={(event) => event.preventDefault()}
              onDoubleClick={(event) => {
                if (zoomToolRef.current) {
                  event.preventDefault();
                  return;
                }
                event.preventDefault();
                applyZoomStep(event.clientX, event.clientY, event.altKey);
              }}
            >
              <div
                className="hidden absolute top-0 left-0 right-0 z-20 pointer-events-none"
	                style={{
	                  height: RULER_SIZE,
	                  background: ui.rulerBg,
	                  borderBottom: `1px solid ${ui.line}`,
	                  backdropFilter: "blur(14px)",
	                }}
              >
                <div
                  className="absolute top-0 left-0"
	                  style={{
	                    width: RULER_SIZE,
	                    height: RULER_SIZE,
	                    background: ui.rulerCornerBg,
	                    borderRight: `1px solid ${ui.line}`,
	                    borderBottom: `1px solid ${ui.line}`,
	                  }}
                />
                {rulerTicks.horizontal.map((tick) => (
                  <div
                    key={`ruler_x_${tick.value}`}
                    className="absolute bottom-0"
                    style={{
                      left: tick.screen,
                      width: 1,
                      height: tick.major ? 18 : 10,
                      background: tick.major ? "rgba(37,99,235,0.3)" : "rgba(148,163,184,0.35)",
                    }}
                  >
                    {tick.major && (
                      <span
                        className="absolute top-1 left-1 text-[9px] font-bold"
                        style={{ color: ui.faint }}
                      >
                        {Math.round(tick.value)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div
                className="hidden absolute top-0 bottom-0 left-0 z-20 pointer-events-none"
	                style={{
	                  width: RULER_SIZE,
	                  background: ui.rulerBg,
	                  borderRight: `1px solid ${ui.line}`,
	                  backdropFilter: "blur(14px)",
	                }}
              >
                {rulerTicks.vertical.map((tick) => (
                  <div
                    key={`ruler_y_${tick.value}`}
                    className="absolute right-0"
                    style={{
                      top: tick.screen,
                      height: 1,
                      width: tick.major ? 18 : 10,
                      background: tick.major ? "rgba(37,99,235,0.3)" : "rgba(148,163,184,0.35)",
                    }}
                  >
                    {tick.major && (
                      <span
                        className="absolute top-1 right-1 text-[9px] font-bold origin-top-right -rotate-90"
                        style={{ color: ui.faint }}
                      >
                        {Math.round(tick.value)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  backgroundColor: ui.page,
                  backgroundImage: `radial-gradient(${ui.canvasGrid} 1px, transparent 1px)`,
                  backgroundSize: `${Math.max(8, 32 * viewport.scale)}px ${Math.max(8, 32 * viewport.scale)}px`,
                  backgroundPosition: `${viewport.x}px ${viewport.y}px`,
                }}
              />
              {assetDragActive && (
                <div
                  className="absolute inset-5 z-50 pointer-events-none rounded-[30px] flex items-center justify-center"
                  style={{
                    background: ui.blueSoft,
                    border: `2px dashed ${ui.blue}`,
                    boxShadow: `inset 0 0 0 1px ${ui.blueLine}, 0 24px 80px rgba(37,99,235,0.16)`,
                    backdropFilter: "blur(5px)",
                  }}
                >
                  <div className="rounded-[24px] px-6 py-5 text-center" style={panelChromeStyle}>
                    <span className="material-symbols-outlined text-[32px]" style={{ color: ui.blue }}>upload_file</span>
                    <p className="mt-2 text-sm font-black" style={{ color: ui.text }}>
                      {t("松开即可加入画布", "Drop to add to the canvas")}
                    </p>
                    <p className="mt-1 text-xs" style={{ color: ui.muted }}>
                      {t("支持图片、视频和音频", "Images, videos, and audio are supported")}
                    </p>
                  </div>
                </div>
              )}
              <div
                className="absolute top-0 bottom-0 pointer-events-none"
                style={{
                  left: viewport.x,
                  width: 1,
                  background: "rgba(37,99,235,0.1)",
                }}
              />
              <div
                className="absolute left-0 right-0 pointer-events-none"
                style={{
                  top: viewport.y,
                  height: 1,
                  background: "rgba(37,99,235,0.1)",
                }}
              />
              <div
                className="absolute"
                style={{
                  width: 0,
                  height: 0,
                  left: 0,
                  top: 0,
                  overflow: "visible",
                  transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
                  transformOrigin: "0 0",
                  willChange: "transform",
                  backfaceVisibility: "hidden",
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage: `radial-gradient(${ui.canvasGrid} 1px, transparent 1px)`,
                    backgroundSize: "24px 24px",
                    willChange: "transform",
                  }}
                />
                {elements.map((element) => {
                  const elementIsSelected = isSelected(element.id);
                  const elementRotation = getElementRotation(element);
                  const selectedStrokeWidth = getFixedScreenValue(1.5, viewport.scale);
                  const selectedGlowWidth = getFixedScreenValue(2, viewport.scale);
                  const videoSrc = element.type === "video" ? getVideoAssetUrl(element) : "";
                  const videoPoster = element.type === "video" ? getVideoPosterUrl(element) : "";
                  const imageSrc = element.type === "image" ? getImageAssetUrl(element) : "";
                  const audioSrc = element.type === "audio" ? getAudioAssetUrl(element) : "";
                  return (
                    <div
                      key={element.id}
                      className="absolute select-none"
                      data-touch-ignore="true"
                      style={{
                        left: element.x,
                        top: element.y,
                        width: element.width,
                        height: element.height,
                        transform: `rotate(${elementRotation}deg)`,
                        transformOrigin: "center center",
                        cursor: zoomToolMode
                          ? (zoomToolZoomOut ? "zoom-out" : "zoom-in")
                          : (handToolMode || spacePanMode || isPanActive)
                            ? (isPanActive ? "grabbing" : "grab")
                            : "default",
                      }}
                      onMouseDown={(event) => startDrag(event, element.id)}
                      onTouchStart={(event) => startElementTouchInteraction(event, element.id)}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (zoomToolRef.current) {
                          event.preventDefault();
                          return;
                        }
                        selectElementCluster(element.id);
                        window.requestAnimationFrame(() => {
                          const target = elementsRef.current.find((item) => item.id === element.id);
                          if (!target) return;
                          focusBounds({
                            minX: target.x,
                            minY: target.y,
                            maxX: target.x + target.width,
                            maxY: target.y + target.height,
                          }, {
                            motion: "gesture",
                            padding: 260,
                            maxScale: 6,
                          });
                        });
                      }}
                    >
                      <div
	                        className="group relative w-full h-full rounded-[24px] overflow-hidden"
	                        style={{
	                          background: element.type === "text" ? element.background || ui.elementBg : ui.elementBg,
	                          border: `${elementIsSelected ? selectedStrokeWidth : 1}px solid ${elementIsSelected ? ui.blue : ui.line}`,
	                          boxShadow: elementIsSelected ? `0 0 0 ${selectedGlowWidth}px rgba(37,99,235,0.12)` : ui.softShadow,
	                        }}
                      >
                        {element.type === "text" ? (
                          <div className="w-full h-full p-5 flex flex-col">
                            <p className="text-[10px] uppercase tracking-widest mb-3" style={{ color: ui.faint }}>
                              {element.title || t("便签", "Note")}
                            </p>
                            <p
                              className="whitespace-pre-wrap leading-relaxed"
                              style={{ color: element.color || ui.text, fontSize: `${element.fontSize || 18}px` }}
                            >
                              {element.text}
                            </p>
                          </div>
                        ) : (
                          <>
                            {element.type === "video" ? (
                              <OssVideo
                                ref={(node) => {
                                  if (node) {
                                    elementVideoRefs.current[element.id] = node;
                                  } else {
                                    delete elementVideoRefs.current[element.id];
                                  }
                                }}
                                src={videoSrc}
                                poster={videoPoster || undefined}
                                autoPlay
                                loop
                                muted={audibleVideoId !== element.id}
                                playsInline
                                preload="metadata"
                                className="w-full h-full object-cover pointer-events-none"
                              />
                            ) : element.type === "audio" ? (
                              <div className="w-full h-full p-4 flex flex-col justify-center gap-3" style={{ background: ui.soft }}>
                                <span className="material-symbols-outlined text-4xl" style={{ color: ui.blue }}>audio_file</span>
                                <OssAudio src={audioSrc} controls className="w-full" />
                              </div>
                            ) : (
                              <>
                                <OssBackground src={imageSrc} className="absolute inset-0" />
                                <OssImage
                                  key={`${element.id}:${imageSrc}`}
                                  src={imageSrc}
                                  alt=""
                                  className="w-full h-full object-cover pointer-events-none block relative z-[1]"
                                  draggable={false}
                                />
                              </>
                            )}
	                            <div className="absolute inset-x-0 bottom-0 p-4"
	                              style={{ background: ui.mediaTitleGradient }}>
	                              <p className="text-sm font-bold truncate" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
	                                {element.title || t("生成资产", "Generated Asset")}
	                              </p>
	                            </div>
	                            {["image", "video"].includes(element.type) && (imageSrc || videoSrc) && (
	                              <button
	                                type="button"
	                                data-touch-ignore="true"
	                                onMouseDown={(event) => event.stopPropagation()}
	                                onTouchStart={(event) => event.stopPropagation()}
	                                onClick={(event) => {
	                                  event.stopPropagation();
	                                  setCanvasPreviewElement(element);
	                                }}
	                                className={`absolute top-3 z-20 flex items-center justify-center rounded-full transition-all duration-200 hover:scale-105 ${elementIsSelected ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"}`}
	                                style={{
	                                  right: getFixedScreenValue(element.locked ? 52 : 12, viewport.scale),
	                                  width: getFixedScreenValue(32, viewport.scale),
	                                  height: getFixedScreenValue(32, viewport.scale),
	                                  background: ui.selectionLabelBg,
	                                  color: ui.text,
	                                  border: `${getFixedScreenValue(1, viewport.scale)}px solid ${ui.line}`,
	                                  boxShadow: ui.softShadow,
	                                }}
	                                title={t("放大预览", "Open preview")}
	                                aria-label={t(`放大预览${element.title || "素材"}`, `Preview ${element.title || "asset"}`)}
	                              >
	                                <span className="material-symbols-outlined" style={{ fontSize: getFixedScreenValue(16, viewport.scale) }}>open_in_full</span>
	                              </button>
	                            )}
	                          </>
	                        )}

                        {element.type === "video" && elementIsSelected && selectedIds.length === 1 && (
                          <button
                            type="button"
                            data-touch-ignore="true"
                            onMouseDown={(event) => event.stopPropagation()}
                            onTouchStart={(event) => event.stopPropagation()}
                            onClick={(event) => void toggleCanvasVideoAudio(event, element.id)}
                            className="canvas-video-audio-control absolute left-3 top-3 z-20 flex items-center justify-center rounded-full pointer-events-auto"
                            style={{
                              width: getFixedScreenValue(32, viewport.scale),
                              height: getFixedScreenValue(32, viewport.scale),
                              background: ui.selectionLabelBg,
                              color: audibleVideoId === element.id ? ui.gold : ui.text,
                              border: `${getFixedScreenValue(1, viewport.scale)}px solid ${audibleVideoId === element.id ? ui.goldLine : ui.line}`,
                              boxShadow: ui.softShadow,
                            }}
                            title={audibleVideoId === element.id ? t("关闭声音", "Mute video") : t("播放声音", "Play sound")}
                            aria-label={audibleVideoId === element.id ? t("关闭声音", "Mute video") : t("播放声音", "Play sound")}
                          >
                            <span
                              className="material-symbols-outlined"
                              style={{ fontSize: getFixedScreenValue(17, viewport.scale) }}
                            >
                              {audibleVideoId === element.id ? "volume_up" : "volume_off"}
                            </span>
                          </button>
                        )}

                        {element.locked && (
	                          <div
	                            className="absolute top-3 right-3 w-8 h-8 rounded-xl flex items-center justify-center"
	                            style={{ background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.goldLine}` }}
	                          >
                            <span className="material-symbols-outlined text-[18px]">lock</span>
                          </div>
                        )}

                        {elementIsSelected && selectedIds.length === 1 && !element.locked && RESIZE_HANDLES.map((handle) => (
                          <button
                            key={`${element.id}_${handle.key}`}
                            type="button"
                            onMouseDown={(event) => startResize(event, element.id, handle.key)}
                            className="absolute w-3.5 h-3.5 rounded-full"
	                            style={{
	                              ...getResizeHandleStyle(handle.key, viewport.scale, 14),
	                              background: ui.handleBg,
	                              borderColor: "#2563eb",
	                              borderStyle: "solid",
	                              cursor: handle.cursor,
                            }}
                          />
                        ))}
                        {elementIsSelected && selectedIds.length === 1 && !element.locked && (
                          <>
                            <div
                              className="absolute left-1/2 pointer-events-none"
                              style={{
                                top: getFixedScreenValue(-ROTATE_HANDLE_OFFSET + 12, viewport.scale),
                                width: getFixedScreenValue(1, viewport.scale),
                                height: getFixedScreenValue(24, viewport.scale),
                                background: "rgba(37,99,235,0.38)",
                              }}
                            />
                            <button
                              type="button"
                              onMouseDown={(event) => startRotate(event, element.id)}
                              className="absolute left-1/2 -translate-x-1/2 w-8 h-8 rounded-full flex items-center justify-center"
                              style={{
	                                top: getFixedScreenValue(-ROTATE_HANDLE_OFFSET, viewport.scale),
	                                width: getFixedScreenValue(32, viewport.scale),
	                                height: getFixedScreenValue(32, viewport.scale),
	                                background: ui.handleBg,
	                                color: ui.blue,
	                                border: `${getFixedScreenValue(2, viewport.scale)}px solid ${ui.blue}`,
                                boxShadow: `0 ${getFixedScreenValue(14, viewport.scale)}px ${getFixedScreenValue(32, viewport.scale)}px rgba(37,99,235,0.18)`,
                                cursor: "grab",
                              }}
                            >
                              <span className="material-symbols-outlined text-[18px]" style={{ fontSize: getFixedScreenValue(18, viewport.scale) }}>rotate_right</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}

                {selectedBounds && selectedIds.length > 1 && (
                  <div
                    className="absolute pointer-events-none"
                    style={{
                      left: selectedBounds.minX,
                      top: selectedBounds.minY,
                      width: Math.max(1, selectedBounds.maxX - selectedBounds.minX),
                      height: Math.max(1, selectedBounds.maxY - selectedBounds.minY),
                    }}
                  >
                    <div
                      className="absolute inset-0 rounded-[28px]"
                      style={{
                        border: `${getFixedScreenValue(1.5, viewport.scale)}px solid ${canResizeSelection ? "rgba(77,112,255,0.92)" : "rgba(233,195,73,0.82)"}`,
                        boxShadow: canResizeSelection
                          ? `0 0 0 ${getFixedScreenValue(1, viewport.scale)}px rgba(255,255,255,0.28) inset, 0 0 0 ${getFixedScreenValue(2, viewport.scale)}px rgba(77,112,255,0.12)`
                          : `0 0 0 ${getFixedScreenValue(1, viewport.scale)}px rgba(255,255,255,0.18) inset`,
                        background: canResizeSelection ? "rgba(77,112,255,0.04)" : "rgba(233,195,73,0.04)",
                      }}
                    />
                    <div
                      className="absolute left-4 top-4 rounded-full px-3 py-1 text-[11px] font-bold tracking-[0.16em] uppercase"
	                      style={{
	                        background: ui.selectionLabelBg,
	                        color: canResizeSelection ? ui.blue : "#b45309",
	                        border: `1px solid ${canResizeSelection ? ui.blueLine : "rgba(217,119,6,0.2)"}`,
                        boxShadow: ui.softShadow,
                      }}
                    >
                      {selectedIds.length} {t("项", "items")}
                    </div>
                    {canResizeSelection && RESIZE_HANDLES.map((handle) => (
                      <button
                        key={`group_${handle.key}`}
                        type="button"
                        onMouseDown={(event) => startGroupResize(event, handle.key)}
                        className="absolute pointer-events-auto w-4 h-4 rounded-full"
	                        style={{
	                          ...getResizeHandleStyle(handle.key, viewport.scale, 16),
	                          background: ui.handleBg,
	                          borderColor: "#2563eb",
	                          borderStyle: "solid",
	                          cursor: handle.cursor,
                        }}
                      />
                    ))}
                    {canResizeSelection && (
                      <>
                        <div
                          className="absolute left-1/2 pointer-events-none"
                          style={{
                            top: getFixedScreenValue(-ROTATE_HANDLE_OFFSET + 12, viewport.scale),
                            width: getFixedScreenValue(1, viewport.scale),
                            height: getFixedScreenValue(24, viewport.scale),
                            background: "rgba(37,99,235,0.38)",
                          }}
                        />
                        <button
                          type="button"
                          onMouseDown={startGroupRotate}
                          className="absolute left-1/2 -translate-x-1/2 pointer-events-auto w-8 h-8 rounded-full flex items-center justify-center"
                          style={{
	                            top: getFixedScreenValue(-ROTATE_HANDLE_OFFSET, viewport.scale),
	                            width: getFixedScreenValue(32, viewport.scale),
	                            height: getFixedScreenValue(32, viewport.scale),
	                            background: ui.handleBg,
	                            color: ui.blue,
	                            border: `${getFixedScreenValue(2, viewport.scale)}px solid ${ui.blue}`,
                            boxShadow: `0 ${getFixedScreenValue(14, viewport.scale)}px ${getFixedScreenValue(32, viewport.scale)}px rgba(37,99,235,0.18)`,
                            cursor: "grab",
                          }}
                        >
                          <span className="material-symbols-outlined text-[18px]" style={{ fontSize: getFixedScreenValue(18, viewport.scale) }}>rotate_right</span>
                        </button>
                      </>
                    )}
                  </div>
                )}

                {guides.map((guide, index) => (
                  <div
                    key={`${guide.axis}_${guide.value}_${index}`}
                    className="absolute pointer-events-none"
                    style={guide.axis === "x"
                      ? {
                          left: guide.value,
                          top: guide.start,
                          width: 1,
                          height: Math.max(1, guide.end - guide.start),
                          background: "#e9c349",
                          boxShadow: "0 0 0 1px rgba(233,195,73,0.2)",
                        }
                      : {
                          left: guide.start,
                          top: guide.value,
                          width: Math.max(1, guide.end - guide.start),
                          height: 1,
                          background: "#e9c349",
                          boxShadow: "0 0 0 1px rgba(233,195,73,0.2)",
                        }}
                  />
                ))}
              </div>

              <IntegratedCanvasWorkflow
                canvasId={activeCanvasId}
                authAxios={authAxios}
                legacyWorkflow={projectModel.workflow}
                canvasTitle={canvasTitle}
                viewport={viewport}
                boardSize={boardSize}
                visible={showWorkflowLayer}
                revisionEpoch={canvasRevisionEpoch}
                ui={ui}
                t={t}
                onVisibilityChange={setShowWorkflowLayer}
                onCanvasResult={handleWorkflowCanvasResult}
                canvasElements={elements}
              />

              {marquee && (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    left: Math.min(marquee.startX, marquee.currentX),
                    top: Math.min(marquee.startY, marquee.currentY),
                    width: Math.abs(marquee.currentX - marquee.startX),
                    height: Math.abs(marquee.currentY - marquee.startY),
                    background: marquee.mode === "zoom" ? "rgba(217,119,6,0.12)" : "rgba(37,99,235,0.1)",
                    border: marquee.mode === "zoom" ? "1px solid rgba(217,119,6,0.42)" : "1px solid rgba(37,99,235,0.3)",
                    boxShadow: marquee.mode === "zoom" ? "0 0 0 1px rgba(233,195,73,0.16)" : "none",
                  }}
                />
              )}

              {interactionHud && (
                <div
                  className="absolute z-30 pointer-events-none -translate-x-1/2 -translate-y-1/2 rounded-2xl px-3 py-2"
                  style={{
	                    left: interactionHud.left,
	                    top: interactionHud.top,
	                    background: ui.hudBg,
	                    color: ui.text,
                    border: `1px solid ${ui.line}`,
                    backdropFilter: "blur(16px)",
                    boxShadow: ui.shadow,
                  }}
                >
                  <p className="text-xs font-black whitespace-nowrap" style={{ fontFamily: "Inter, sans-serif" }}>
                    {interactionHud.label}
                  </p>
                </div>
              )}

              {zoomPulse && (
                <div
                  key={zoomPulse.key}
                  className="absolute z-30 pointer-events-none -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: zoomPulse.left,
                    top: zoomPulse.top,
                    animation: "canvasZoomPulse 260ms cubic-bezier(0.22, 1, 0.36, 1)",
                  }}
                >
                  <div
                    className="relative w-12 h-12 rounded-full"
                    style={{
                      background: zoomPulse.zoomOut ? "rgba(217,119,6,0.12)" : "rgba(37,99,235,0.12)",
                      border: `2px solid ${zoomPulse.zoomOut ? "rgba(217,119,6,0.55)" : "rgba(37,99,235,0.55)"}`,
                      boxShadow: zoomPulse.zoomOut
                        ? "0 0 0 10px rgba(217,119,6,0.06)"
                        : "0 0 0 10px rgba(37,99,235,0.06)",
                    }}
                  >
                    <div
                      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                      style={{
                        width: 18,
                        height: 2,
                        borderRadius: 999,
                        background: zoomPulse.zoomOut ? "#d97706" : "#2563eb",
                      }}
                    />
                    {!zoomPulse.zoomOut && (
                      <div
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
                        style={{
                          width: 2,
                          height: 18,
                          borderRadius: 999,
                          background: "#2563eb",
                        }}
                      />
                    )}
                  </div>
                </div>
              )}

              {selectionToolbarPosition && (
                <div
                  data-touch-ignore="true"
                  className="canvas-toolbar-scroll absolute z-30 rounded-[24px] px-2 py-2 flex items-center gap-1.5 overflow-x-auto"
                  style={{
                    ...panelChromeStyle,
                    left: selectionToolbarPosition.left,
                    top: selectionToolbarPosition.top,
                    width: "max-content",
                    maxWidth: selectionToolbarPosition.maxWidth,
                    boxSizing: "border-box",
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {selectedImageElements.length > 0 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setCanvasAiUseSelection(true);
                          setInlineAiOpen((prev) => !prev);
                        }}
                        className="h-10 rounded-[18px] px-3.5 flex items-center gap-2 text-sm font-bold whitespace-nowrap"
                        style={inlineAiOpen ? activeFloatingToolStyle : floatingToolButtonStyle}
                        title={t("快速编辑", "Quick Edit")}
                      >
                        <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
                        {t("快速编辑", "Quick Edit")}
                      </button>
                      <div className="w-px h-7 flex-shrink-0" style={{ background: ui.line }} />
                      <button
                        type="button"
                        onClick={() => {
                          setCanvasAiPrompt(inlineAiQuickActions[2]);
                          setCanvasAiUseSelection(true);
                          setInlineAiOpen(true);
                        }}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={floatingToolButtonStyle}
                        title={t("风格变体", "Style Variant")}
                      >
                        <span className="material-symbols-outlined text-[18px]">auto_fix_high</span>
                      </button>
                      <button
                        type="button"
                        onClick={duplicateSelected}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={floatingToolButtonStyle}
                        title={t("复制", "Duplicate")}
                      >
                        <span className="material-symbols-outlined text-[18px]">content_copy</span>
                      </button>
                      {selectedElements.length === 1 && isDownloadableCanvasMedia(selectedElements[0]) && (
                        <button
                          type="button"
                          onClick={() => void downloadCanvasMediaElement(selectedElements[0])}
                          className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                          style={floatingToolButtonStyle}
                          title={t("下载素材", "Download Asset")}
                        >
                          <span className="material-symbols-outlined text-[18px]">download</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={focusSelection}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={floatingToolButtonStyle}
                        title={t("聚焦", "Focus")}
                      >
                        <span className="material-symbols-outlined text-[18px]">center_focus_strong</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => reorderSelection("front")}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={floatingToolButtonStyle}
                        title={t("置顶", "Bring Front")}
                      >
                        <span className="material-symbols-outlined text-[18px]">vertical_align_top</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleLockSelection(!allSelectedLocked)}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={allSelectedLocked ? goldButtonStyle : floatingToolButtonStyle}
                        title={allSelectedLocked ? t("解锁", "Unlock") : t("锁定", "Lock")}
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {allSelectedLocked ? "lock_open" : "lock"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelected}
                        className="w-10 h-10 rounded-[18px] flex items-center justify-center flex-shrink-0"
                        style={{ ...floatingToolButtonStyle, color: ui.danger }}
                        title={t("删除", "Delete")}
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="min-w-0 px-2">
                        <p className="text-[10px] uppercase tracking-[0.2em]" style={{ color: ui.faint }}>
                          {selectedIds.length > 1 ? t("多选", "Multi-select") : t("已选中", "Selected")}
                        </p>
                        <p className="text-xs font-bold truncate mt-1" style={{ color: ui.text }}>
                          {selectedIds.length > 1
                            ? t(`${selectedIds.length} 个元素`, `${selectedIds.length} elements`)
                            : selectedElement?.title || t("未命名元素", "Untitled Element")}
                        </p>
                      </div>
                      <div className="w-px h-10" style={{ background: ui.line }} />
                      {selectionMetrics && (
                        <div className="hidden md:block px-2">
                          <p className="text-[10px] uppercase tracking-[0.18em]" style={{ color: ui.faint }}>
                            {t("尺寸", "Metrics")}
                          </p>
                          <p className="text-[11px] font-bold mt-1 whitespace-nowrap" style={{ color: ui.text }}>
                            {selectionMetrics.width} × {selectionMetrics.height} · X {selectionMetrics.x} · Y {selectionMetrics.y}{selectionAngleLabel ? ` · ${selectionAngleLabel}` : ""}
                          </p>
                        </div>
                      )}
	                      {selectionMetrics && <div className="hidden md:block w-px h-10" style={{ background: ui.line }} />}
	                      <button
	                        type="button"
	                        onClick={duplicateSelected}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center"
                        style={tintedButtonStyle}
                        title={t("复制", "Duplicate")}
	                      >
	                        <span className="material-symbols-outlined text-[18px]">content_copy</span>
	                      </button>
                      {selectedElements.length === 1 && isDownloadableCanvasMedia(selectedElements[0]) && (
                        <button
                          type="button"
                          onClick={() => void downloadCanvasMediaElement(selectedElements[0])}
                          className="w-10 h-10 rounded-2xl flex items-center justify-center"
                          style={subtleButtonStyle}
                          title={t("下载素材", "Download Asset")}
                        >
                          <span className="material-symbols-outlined text-[18px]">download</span>
                        </button>
                      )}
	                      {selectedIds.length > 1 ? (
                        <button
                          type="button"
                          onClick={allSelectedInSameGroup ? ungroupSelectedElements : groupSelectedElements}
                          className="w-10 h-10 rounded-2xl flex items-center justify-center"
                          style={subtleButtonStyle}
                          title={allSelectedInSameGroup ? t("取消组合", "Ungroup") : t("组合", "Group")}
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            {allSelectedInSameGroup ? "shapes" : "group_work"}
                          </span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={focusSelection}
                          className="w-10 h-10 rounded-2xl flex items-center justify-center"
                          style={subtleButtonStyle}
                          title={t("聚焦所选", "Focus Selection")}
                        >
                          <span className="material-symbols-outlined text-[18px]">center_focus_strong</span>
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => reorderSelection("front")}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center"
                        style={subtleButtonStyle}
                        title={t("置顶", "Bring Front")}
                      >
                        <span className="material-symbols-outlined text-[18px]">vertical_align_top</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleLockSelection(!allSelectedLocked)}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center"
                        style={allSelectedLocked ? goldButtonStyle : subtleButtonStyle}
                        title={allSelectedLocked ? t("解锁", "Unlock") : t("锁定", "Lock")}
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {allSelectedLocked ? "lock_open" : "lock"}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelected}
                        className="w-10 h-10 rounded-2xl flex items-center justify-center"
                        style={dangerButtonStyle}
                        title={t("删除", "Delete")}
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </>
                  )}
                </div>
              )}

              {inlineAiOpen && inlineAiPanelPosition && selectedImageElements.length > 0 && (
                <div
                  data-touch-ignore="true"
                  className="absolute z-40 rounded-[28px] p-3"
                  style={{
                    ...panelChromeStyle,
                    left: inlineAiPanelPosition.left,
                    top: inlineAiPanelPosition.top,
                    width: inlineAiPanelPosition.width,
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-12 h-12 rounded-2xl overflow-hidden flex-shrink-0"
                      style={{ background: ui.soft, border: `1px solid ${ui.line}` }}
                    >
                      <OssImage src={getImageAssetUrl(selectedImageElements[0])} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[17px]" style={{ color: ui.blue }}>auto_awesome</span>
                        <p className="text-sm font-black truncate" style={{ color: ui.text }}>
                          {selectedImageElements.length > 1
                            ? t(`快速编辑 ${selectedImageElements.length} 张参考图`, `Quick edit ${selectedImageElements.length} references`)
                            : selectedImageElements[0]?.title || t("快速编辑图片", "Quick Edit Image")}
                        </p>
                      </div>
                      <p className="mt-0.5 text-[11px] truncate" style={{ color: ui.muted }}>
                        {t("生成结果会放在旁边，原图不覆盖。", "Result is added beside it without overwriting the original.")}
                      </p>
                    </div>
                    <div className="hidden md:flex items-center gap-2">
                      <CanvasRoundedSelect label={t("图片模板", "Image template")} value={selectedImageScene?.scene_key || ""} onChange={(value) => applyCanvasAiScene(imageScenes.find((scene) => scene.scene_key === value))} options={imageScenes.length === 0 ? [{ value: "", label: t("正在加载模板", "Loading templates") }] : imageScenes.map((scene) => ({ value: scene.scene_key, label: scene.scene_name || scene.scene_key }))} ui={ui} className="max-w-[220px]" triggerClassName="h-10 w-full rounded-2xl px-3 text-xs font-bold" menuMinWidth={240} />
                      <CanvasRoundedSelect label={t("图片尺寸", "Image size")} value={canvasAiSize} onChange={setCanvasAiSize} options={canvasImageSizeOptions.map((item) => ({ value: item.value, label: `${item.label} · ${isZh ? item.subZh : item.subEn}` }))} ui={ui} className="min-w-[120px]" triggerClassName="h-10 w-full rounded-2xl px-3 text-xs font-bold" menuMinWidth={190} />
                      <CanvasRoundedSelect label={t("图片模型", "Image model")} value={canvasAiModel} onChange={handleCanvasImageModelChange} options={canvasAiModels} ui={ui} className="min-w-[130px]" triggerClassName="h-10 w-full rounded-2xl px-3 text-xs font-bold" menuMinWidth={240} />
                    </div>
                    <div className="hidden md:flex items-center justify-end gap-2 mt-2">
                      <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.muted }}>
                        {t("视频", "Video")}
                      </span>
                      <CanvasRoundedSelect label={t("视频尺寸", "Video size")} value={canvasVideoSize} onChange={setCanvasVideoSize} options={canvasVideoSizeOptions.map((item) => ({ value: item.value, label: `${item.label} · ${item.value}` }))} ui={ui} className="min-w-[120px]" triggerClassName="h-10 w-full rounded-2xl px-3 text-xs font-bold" menuMinWidth={190} />
                      <CanvasRoundedSelect label={t("视频模型", "Video model")} value={canvasVideoModel} onChange={handleCanvasVideoModelChange} options={canvasVideoModels} ui={ui} className="max-w-[160px]" triggerClassName="h-10 w-full rounded-2xl px-3 text-xs font-bold" menuMinWidth={240} />
                    </div>
                    <button
                      type="button"
                      onClick={() => setInlineAiOpen(false)}
                      className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                      style={floatingToolButtonStyle}
                      title={t("关闭", "Close")}
                    >
                      <span className="material-symbols-outlined text-[18px]">close</span>
                    </button>
                  </div>

                  <div
                    className="mt-3 rounded-[24px] p-2"
                    style={{ background: ui.inspectorInput, border: `1px solid ${ui.line}`, boxShadow: ui.inputInset }}
                  >
                    <textarea
                      value={canvasAiPrompt}
                      onChange={(event) => setCanvasAiPrompt(event.target.value)}
                      rows={2}
                      className="w-full bg-transparent px-2 py-2 outline-none resize-none text-sm leading-relaxed"
                      style={{ color: ui.text }}
                      placeholder={selectedImageScene?.placeholder_text || t("输入你想怎么改：换背景、改材质、加光影、换风格…", "Describe the edit: background, material, lighting, style...")}
                    />
                    <div className="mt-2">
                      <VisualParameterPicker
                        outputType="image"
                        modelKey={canvasAiModel}
                        value={canvasVisualParameters}
                        onChange={setCanvasVisualParameters}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="canvas-toolbar-scroll flex items-center gap-1.5 overflow-x-auto min-w-0">
                        {inlineAiQuickActions.slice(0, 3).map((text) => (
                          <button
                            key={text}
                            type="button"
                            onClick={() => setCanvasAiPrompt(text)}
                            className="h-8 rounded-full px-3 text-[11px] font-bold whitespace-nowrap"
                            style={floatingToolButtonStyle}
                          >
                            {text.length > 18 ? `${text.slice(0, 18)}...` : text}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="hidden sm:inline text-[11px] font-bold" style={{ color: ui.faint }}>
                          {selectedImageScene?.estimated_points ?? "--"} {t("积分", "pts")}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCanvasVideoGenerate({
                            useSelection: true,
                            referenceImages: selectedImageElements.slice(0, 1),
                            promptOverride: canvasVideoPrompt || canvasAiPrompt || selectedImageElements[0]?.prompt || selectedImageElements[0]?.title || "",
                          })}
                          disabled={canvasVideoGenerating || !selectedVideoScene}
                          className="h-10 w-10 rounded-full font-black disabled:opacity-45 flex items-center justify-center"
                          style={goldButtonStyle}
                          title={t("用此图生成视频", "Generate video from this image")}
                        >
                          <span className="material-symbols-outlined text-[18px]">movie_filter</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCanvasAiGenerate({ useSelection: true })}
                          disabled={canvasAiGenerating || !selectedImageScene}
                          className="h-10 px-4 rounded-full font-black disabled:opacity-45 flex items-center justify-center gap-2"
                          style={{ background: ui.accent, color: ui.accentText, boxShadow: ui.softShadow }}
                        >
                          {canvasAiGenerating ? (
                            <span className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                          ) : (
                            <span className="material-symbols-outlined text-[18px]">arrow_upward</span>
                          )}
                          {t("生成", "Generate")}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div
              data-touch-ignore="true"
              className="canvas-toolbar-scroll absolute bottom-4 left-1/2 -translate-x-1/2 z-20 rounded-[28px] px-2 py-2 flex items-center gap-2 max-w-[calc(100vw-32px)] overflow-x-auto"
              style={{
                ...panelChromeStyle,
                scrollbarWidth: "none",
                WebkitOverflowScrolling: "touch",
                left: showAiPanel ? `calc((100% - ${agentPanelWidth}px) / 2)` : "50%",
              }}
            >
              <div
                className="flex items-center gap-1 rounded-[22px] p-1 flex-shrink-0"
                style={{ background: ui.panelTranslucent, border: `1px solid ${ui.line}` }}
              >
                <button
                  type="button"
                  onClick={focusSurface}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={tintedButtonStyle}
                  title={t("回原点", "Origin")}
                >
                  <span className="material-symbols-outlined text-[19px]">home_pin</span>
                </button>
                <button
                  type="button"
                  onClick={fitToContent}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={subtleButtonStyle}
                  title={t("适配全部", "Fit All")}
                >
                  <span className="material-symbols-outlined text-[19px]">fit_screen</span>
                </button>
                <button
                  type="button"
                  onClick={focusSelection}
                  disabled={selectedIds.length === 0}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center disabled:opacity-35"
                  style={subtleButtonStyle}
                  title={t("聚焦所选", "Focus Selection")}
                >
                  <span className="material-symbols-outlined text-[19px]">center_focus_strong</span>
                </button>
                <button
                  type="button"
                  onClick={() => void toggleCanvasFullscreen()}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={isCanvasFullscreen ? goldButtonStyle : subtleButtonStyle}
                  title={isCanvasFullscreen ? t("退出全屏", "Exit Fullscreen") : t("全屏", "Fullscreen")}
                >
                  <span className="material-symbols-outlined text-[19px]">
                    {isCanvasFullscreen ? "fullscreen_exit" : "fullscreen"}
                  </span>
                </button>
              </div>

              <div
                className="flex items-center gap-1 rounded-[22px] p-1 flex-shrink-0"
                style={{ background: ui.panelTranslucent, border: `1px solid ${ui.line}` }}
              >
                <button
                  type="button"
                  onClick={activateSelectTool}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={selectToolMode ? tintedButtonStyle : subtleButtonStyle}
                  title={selectToolMode ? t("选择中", "Select On") : t("选择", "Select")}
                >
                  <span className="material-symbols-outlined text-[19px]">arrow_selector_tool</span>
                </button>
                <button
                  type="button"
                  onClick={activateSelectTool}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={selectToolMode ? tintedButtonStyle : subtleButtonStyle}
                  title={t("左键框选", "Left-drag marquee")}
                >
                  <span className="material-symbols-outlined text-[19px]">select</span>
                </button>
                <button
                  type="button"
                  onClick={togglePinnedHandTool}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={handToolPinned ? tintedButtonStyle : subtleButtonStyle}
                  title={handToolPinned ? t("抓手中", "Hand On") : t("抓手", "Hand")}
                >
                  <span className="material-symbols-outlined text-[19px]">pan_tool</span>
                </button>
                <button
                  type="button"
                  onClick={togglePinnedZoomTool}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={zoomToolPinned ? goldButtonStyle : subtleButtonStyle}
                  title={zoomToolPinned ? t("缩放中", "Zooming") : t("缩放", "Zoom")}
                >
                  <span className="material-symbols-outlined text-[19px]">search</span>
                </button>
                <div className="hidden md:flex h-10 items-center rounded-[18px] px-3 text-xs font-black whitespace-nowrap" style={selectToolMode ? tintedButtonStyle : subtleButtonStyle}>
                  {handToolMode || handToolPinned
                    ? t("抓手", "Hand")
                    : zoomToolMode || zoomToolPinned
	                      ? t("缩放", "Zoom")
	                      : t("框选", "Marquee")}
	                </div>
              </div>

              <div
                className="flex items-center gap-1 rounded-[22px] p-1 flex-shrink-0"
                style={{ background: ui.panelTranslucent, border: `1px solid ${ui.line}` }}
              >
                <button
                  type="button"
                  onClick={() => gestureViewportScaleAtCenter(viewport.scale * 0.88)}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={subtleButtonStyle}
                  title={t("缩小", "Zoom Out")}
                >
                  <span className="material-symbols-outlined text-[18px]">remove</span>
                </button>
                <button
                  type="button"
                  onMouseDown={handleZoomBadgeMouseDown}
                  onTouchStart={handleZoomBadgeTouchStart}
                  className="min-w-[70px] h-10 px-3 rounded-[18px] text-sm font-black"
                  style={{ ...tintedButtonStyle, cursor: "ew-resize" }}
                  title={t("拖动调整缩放，点击回到 100%", "Drag to scrub zoom, click for 100%")}
                >
                  {zoomPercent}%
                </button>
                <button
                  type="button"
                  onClick={() => gestureViewportScaleAtCenter(viewport.scale * 1.12)}
                  className="w-10 h-10 rounded-[18px] flex items-center justify-center"
                  style={subtleButtonStyle}
                  title={t("放大", "Zoom In")}
                >
                  <span className="material-symbols-outlined text-[18px]">add</span>
                </button>
                <input
                  type="range"
                  min="5"
                  max="1000"
                  step="1"
                  value={zoomPercent}
                  onChange={(event) => gestureViewportScaleAtCenter(Number(event.target.value) / 100)}
                  className="hidden lg:block w-28 accent-[#ee9d47]"
                  title={t("缩放滑杆", "Zoom Slider")}
                />
              </div>
            </div>
            <div
              data-touch-ignore="true"
              className="absolute right-4 z-20 rounded-[28px] p-3"
              style={{ ...panelChromeStyle, bottom: 96, width: MINIMAP_WIDTH + 24 }}
            >
              <div className="flex items-center justify-between gap-3 mb-3 px-1">
                <div>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                    {t("导航小地图", "Navigator")}
                  </p>
                  <p className="text-xs mt-1" style={{ color: ui.text }}>
                    {t("拖动视口框或点击快速跳转", "Drag the viewport or click to jump")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={focusSurface}
                  className="h-8 px-3 rounded-xl text-[11px] font-bold"
                  style={tintedButtonStyle}
                >
                  {t("回原点", "Reset View")}
                </button>
              </div>
              <div
                id="canvas-minimap"
                data-touch-ignore="true"
                role="button"
                tabIndex={0}
                className="relative rounded-[20px] overflow-hidden"
                style={{
                  width: MINIMAP_WIDTH,
                  height: MINIMAP_HEIGHT,
                  background: ui.soft,
                  border: `1px solid ${ui.line}`,
                }}
                onMouseDown={handleMinimapPointerDown}
                onTouchStart={handleMinimapTouchStart}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  focusSurface();
                }}
              >
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage: `radial-gradient(${ui.canvasGrid} 1px, transparent 1px)`,
                    backgroundSize: "18px 18px",
                  }}
                />
                {elements.map((element) => (
                  (() => {
                    const elementBounds = getElementAxisAlignedBounds(element);
                    return (
                      <div
                        key={`minimap_${element.id}`}
                        className="absolute rounded-[4px]"
                        style={{
                          left: minimapMetrics.offsetX + (elementBounds.minX - minimapBounds.minX) * minimapMetrics.scale,
                          top: minimapMetrics.offsetY + (elementBounds.minY - minimapBounds.minY) * minimapMetrics.scale,
                          width: Math.max(4, (elementBounds.maxX - elementBounds.minX) * minimapMetrics.scale),
                          height: Math.max(4, (elementBounds.maxY - elementBounds.minY) * minimapMetrics.scale),
                          background: isSelected(element.id)
                            ? ui.blue
                            : element.type === "text"
                              ? "rgba(217,119,6,0.72)"
                              : element.type === "video"
                                ? "rgba(239,68,68,0.62)"
                                : "rgba(37,99,235,0.42)",
	                          border: `1px solid ${isSelected(element.id) ? ui.panelSolid : ui.line}`,
	                        }}
                      />
                    );
                  })()
                ))}
                <div
                  className="absolute rounded-[14px]"
                  style={{
                    ...minimapViewportStyle,
	                    border: `2px solid ${ui.blue}`,
	                    background: ui.blueSoft,
	                    boxShadow: `0 0 0 1px ${ui.line} inset`,
	                    cursor: "grab",
                    pointerEvents: "auto",
                  }}
                  onMouseDown={handleMinimapViewportPointerDown}
                  onTouchStart={handleMinimapViewportTouchStart}
                />
              </div>
            </div>
            <div
              className="absolute bottom-4 right-4 z-20 rounded-2xl px-4 py-3 flex items-center gap-4"
              style={{ ...panelChromeStyle, backdropFilter: "blur(16px)" }}
            >
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                  {t("贴板区", "Pasteboard")}
                </p>
                <p className="text-sm font-bold mt-1" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                  {t("无限延展", "Infinite")}
                </p>
              </div>
              <div className="w-px h-10" style={{ background: ui.line }} />
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                  {t("原点", "Origin")}
                </p>
                <p className="text-sm font-bold mt-1" style={{ color: ui.blue, fontFamily: "Inter, sans-serif" }}>
                  0, 0
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section
          className="absolute bottom-0 left-0 top-[72px] z-10 min-h-0 overflow-hidden p-3 transition-[right]"
          style={{ right: showAiPanel ? agentPanelWidth : 0 }}
        >
          <div className="h-full min-h-0 overflow-auto rounded-2xl" style={{ background: ui.panelSolid, border: `1px solid ${ui.line}` }}>
            {workspaceMode === "storyboard" && (
              <div className="mx-auto min-h-full max-w-6xl p-4 md:p-6">
                <StoryboardPanel
                  value={projectModel.storyboard}
                  onChange={(storyboard) => setProjectModel((current) => ({ ...current, storyboard }))}
                  elements={elements}
                  onGenerateImage={generateStoryboardImage}
                  onGenerateVideo={generateStoryboardVideo}
                  onAddToTimeline={addStoryboardShotToTimeline}
                  onFocusElement={focusStoryboardElement}
                  imageGenerating={canvasAiGenerating}
                  videoGenerating={canvasVideoGenerating}
                  imageModelLabel={activeCanvasImageModel?.display_name || canvasAiModel}
                  videoModelLabel={activeCanvasVideoModel?.display_name || canvasVideoModel}
                  ui={ui}
                  t={t}
                />
              </div>
            )}
            {workspaceMode === "timeline" && (
              <div className="mx-auto min-h-full max-w-7xl p-4 md:p-6">
                <TimelinePanel
                  value={projectModel.timeline}
                  elements={elements}
                  resolveAssetUrl={resolveTimelineAssetUrl}
                  onChange={(timeline) => setProjectModel((current) => ({ ...current, timeline }))}
                  onRender={() => void renderTimelineLocally()}
                  onCancel={cancelTimelineRender}
                  rendering={renderingTimeline}
                  renderProgress={timelineRenderProgress}
                  ui={ui}
                  t={t}
                />
              </div>
            )}
            {workspaceMode === "director3d" && (
              <Director3DPanel
                directorState={projectModel.director3d}
                onChange={(director3d) => setProjectModel((current) => ({ ...current, director3d }))}
              />
            )}
          </div>
        </section>
      )}

      <CanvasHistoryDialog
        open={canvasHistoryOpen}
        onClose={() => setCanvasHistoryOpen(false)}
        canvasId={activeCanvasId}
        authAxios={authAxios}
        onRestored={async (result) => {
          if (result?.canvas) {
            applyCanvas(result.canvas);
            mergeCanvasMeta({
              ...result.canvas,
              updated_at: result.canvas.updatedAt || result.canvas.updated_at,
              element_count: result.canvas.state?.elements?.length || 0,
            });
          } else if (activeCanvasId) {
            await loadCanvas(activeCanvasId);
          }
          setCanvasRevisionEpoch((current) => current + 1);
        }}
        ui={ui}
        t={t}
        locale={isZh ? "zh-CN" : "en-US"}
      />

      {canvasPreviewElement && (
        <AssetPreviewModal
          item={{
            ...canvasPreviewElement,
            status: "completed",
            scene_name: canvasPreviewElement.title || t("画布素材", "Canvas asset"),
            content: canvasPreviewElement.type === "video"
              ? getVideoAssetUrl(canvasPreviewElement)
              : getImageAssetUrl(canvasPreviewElement),
            preview_video_url: canvasPreviewElement.type === "video"
              ? getVideoAssetUrl(canvasPreviewElement)
              : "",
            preview_image_url: canvasPreviewElement.type === "video"
              ? getVideoPosterUrl(canvasPreviewElement)
              : getImageAssetUrl(canvasPreviewElement),
          }}
          onClose={() => setCanvasPreviewElement(null)}
          ui={ui}
        />
      )}

      {workspaceMode === "canvas" && showRightPanel && (
        <aside className="absolute right-4 top-20 bottom-4 z-30 w-[340px] md:w-[380px] min-h-0">
          <div className="rounded-[28px] h-full p-5 overflow-y-auto"
            style={{ background: ui.panel, border: `1px solid ${ui.line}`, boxShadow: ui.shadow, backdropFilter: "blur(18px)" }}>
            <div className="grid grid-cols-3 gap-1 rounded-2xl p-1 mb-4" style={{ background: ui.soft }}>
              {[
                ["layers", "layers", t("图层", "Layers")],
                ["storyboard", "view_carousel", t("分镜", "Storyboard")],
                ["timeline", "movie", t("时间线", "Timeline")],
              ].map(([tab, icon, label]) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setRightPanelTab(tab)}
                  className="rounded-xl px-2 py-2 text-[11px] font-bold flex items-center justify-center gap-1"
                  style={{ background: rightPanelTab === tab ? ui.panelSolid : "transparent", color: rightPanelTab === tab ? ui.blue : ui.muted }}
                >
                  <span className="material-symbols-outlined text-[13px]">{icon}</span>
                  {label}
                </button>
              ))}
            </div>

            {rightPanelTab === "storyboard" && (
              <div className="rounded-2xl p-4" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
                <StoryboardPanel
                  value={projectModel.storyboard}
                  onChange={(storyboard) => setProjectModel((current) => ({ ...current, storyboard }))}
                  elements={elements}
                  onGenerateImage={generateStoryboardImage}
                  onGenerateVideo={generateStoryboardVideo}
                  onAddToTimeline={addStoryboardShotToTimeline}
                  onFocusElement={focusStoryboardElement}
                  imageGenerating={canvasAiGenerating}
                  videoGenerating={canvasVideoGenerating}
                  imageModelLabel={activeCanvasImageModel?.display_name || canvasAiModel}
                  videoModelLabel={activeCanvasVideoModel?.display_name || canvasVideoModel}
                  ui={ui}
                  t={t}
                />
              </div>
            )}

            {rightPanelTab === "timeline" && (
              <div className="rounded-2xl p-4" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
                <TimelinePanel
                  value={projectModel.timeline}
                  elements={elements}
                  resolveAssetUrl={resolveTimelineAssetUrl}
                  onChange={(timeline) => setProjectModel((current) => ({ ...current, timeline }))}
                  onRender={() => void renderTimelineLocally()}
                  onCancel={cancelTimelineRender}
                  rendering={renderingTimeline}
                  renderProgress={timelineRenderProgress}
                  ui={ui}
                  t={t}
                />
              </div>
            )}

            {rightPanelTab === "layers" && (
            <>
            <div className="rounded-2xl p-4 mb-5" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                    {t("图层", "Layers")}
                  </p>
                  <p className="text-sm font-bold mt-1" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {elements.length} {t("个元素", "elements")}
                  </p>
                </div>
                <span className="material-symbols-outlined text-[15px]" style={{ color: ui.blue }}>layers</span>
              </div>

              <div className="relative mb-3">
	                <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[15px]" style={{ color: ui.faint }}>
                  search
                </span>
                <input
                  value={layerQuery}
                  onChange={(event) => setLayerQuery(event.target.value)}
                  placeholder={t("搜索图层标题", "Search layer titles")}
                  className="w-full rounded-2xl pl-10 pr-4 py-3 bg-transparent outline-none text-sm"
                  style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }}
                />
              </div>

              <div className="max-h-72 overflow-y-auto pr-1 space-y-2">
                {filteredLayerElements.length === 0 ? (
                  <div className="rounded-2xl px-4 py-5 text-sm text-center" style={{ background: ui.panelSolid, color: ui.muted, border: `1px dashed ${ui.line2}` }}>
                    {layerQuery
                      ? t("没有匹配的图层", "No matching layers")
                      : t("画布里还没有元素", "No layers on the canvas yet")}
                  </div>
                ) : filteredLayerElements.map((item) => {
                  const active = isSelected(item.id);
                  return (
                    <div
                      key={`layer_${item.id}`}
                      className="rounded-2xl px-3 py-3"
                      style={{
                        background: active ? ui.blueSoft : ui.panelSolid,
                        border: `1px solid ${active ? ui.blueLine : ui.line}`,
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => selectElementCluster(item.id)}
                          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                          style={{ background: ui.soft, color: item.type === "text" ? ui.gold : ui.blue, border: `1px solid ${ui.line}` }}
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            {item.type === "text" ? "sticky_note_2" : item.type === "video" ? "movie_filter" : "image"}
                          </span>
                        </button>
                        <div className="min-w-0 flex-1">
                          <button
                            type="button"
                            onClick={() => selectElementCluster(item.id)}
                            className="block text-left w-full"
                          >
                            <p className="font-bold text-sm truncate" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                              {item.title || t("未命名元素", "Untitled Element")}
                            </p>
                            <div className="flex flex-wrap items-center gap-2 mt-1">
                              <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                                {item.type} • {Math.round(item.width)} × {Math.round(item.height)} • {Math.round(getElementRotation(item))}deg
                              </p>
                              {item.groupId && (
                                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: ui.blueSoft, color: ui.blue }}>
                                  {t("组合", "Group")}
                                </span>
                              )}
                            </div>
                          </button>
                          <div className="flex items-center gap-2 mt-3">
                            <button
                              type="button"
                              onClick={() => toggleLayerLock(item.id)}
                              className="w-8 h-8 rounded-xl flex items-center justify-center"
                              style={item.locked ? goldButtonStyle : subtleButtonStyle}
                            >
                              <span className="material-symbols-outlined text-[14px]">
                                {item.locked ? "lock" : "lock_open"}
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => reorderLayerCluster(item.id, "front")}
                              className="w-8 h-8 rounded-xl flex items-center justify-center"
                              style={subtleButtonStyle}
                            >
                              <span className="material-symbols-outlined text-[14px]">vertical_align_top</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => reorderLayerCluster(item.id, "back")}
                              className="w-8 h-8 rounded-xl flex items-center justify-center"
                              style={subtleButtonStyle}
                            >
                              <span className="material-symbols-outlined text-[14px]">vertical_align_bottom</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteLayerElement(item.id)}
                              disabled={item.locked}
                              className="w-8 h-8 rounded-xl flex items-center justify-center disabled:opacity-35"
                              style={dangerButtonStyle}
                            >
                              <span className="material-symbols-outlined text-[14px]">delete</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <p className="text-[10px] uppercase tracking-[0.22em]" style={{ color: ui.faint }}>
              {t("属性面板", "Inspector")}
            </p>
            <h3 className="text-2xl font-extrabold mt-2 mb-6" style={{ color: ui.text, fontFamily: "Space Grotesk, Inter, sans-serif" }}>
              {selectedIds.length > 1
                ? t(`已选 ${selectedIds.length} 个元素`, `${selectedIds.length} Elements Selected`)
                : selectedElement
                  ? t("所选元素", "Selected Element")
                  : t("画布说明", "Canvas Notes")}
            </h3>

            {selectedIds.length > 1 ? (
              <div className="space-y-4">
                <div className="rounded-2xl p-4" style={inspectorCardStyle}>
                  <p className="font-bold text-sm mb-2" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("批量操作", "Batch Actions")}
                  </p>
                  <p className="text-sm" style={{ color: ui.muted, lineHeight: 1.7 }}>
                    {t("拖动任意已选元素可整体移动，方向键可批量微调。下面这些操作会作用到全部所选元素。", "Drag any selected element to move the group. Arrow keys nudge the whole selection. The actions below apply to every selected element.")}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={duplicateSelected}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={tintedButtonStyle}
                  >
                    {t("复制全部", "Duplicate All")}
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelected}
                    disabled={selectedUnlockedElements.length === 0}
                    className="rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-35"
                    style={dangerButtonStyle}
                  >
                    {t("删除全部", "Delete All")}
                  </button>
                  <button
                    type="button"
                    onClick={groupSelectedElements}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={tintedButtonStyle}
                  >
                    {t("组合所选", "Group Selected")}
                  </button>
                  <button
                    type="button"
                    onClick={ungroupSelectedElements}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("取消组合", "Ungroup")}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => reorderSelection("front")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("整体置顶", "Bring Group Front")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reorderSelection("back")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("整体置底", "Send Group Back")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setElements((prev) => prev.map((item) => (
                      selectedIds.includes(item.id) && !item.locked
                        ? { ...item, rotation: normalizeAngle(getElementRotation(item) - 15) }
                        : item
                    )))}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("左转 15°", "Rotate -15deg")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setElements((prev) => prev.map((item) => (
                      selectedIds.includes(item.id) && !item.locked
                        ? { ...item, rotation: normalizeAngle(getElementRotation(item) + 15) }
                        : item
                    )))}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("右转 15°", "Rotate +15deg")}
                  </button>
                </div>
                <div className="rounded-2xl p-4" style={inspectorCardStyle}>
                  <p className="font-bold text-sm mb-3" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("对齐与分布", "Align & Distribute")}
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    <button type="button" onClick={() => alignSelection("left")} className="rounded-xl px-3 py-2 text-sm font-bold" style={tintedButtonStyle}>{t("左对齐", "Align Left")}</button>
                    <button type="button" onClick={() => alignSelection("center")} className="rounded-xl px-3 py-2 text-sm font-bold" style={tintedButtonStyle}>{t("居中", "Align Center")}</button>
                    <button type="button" onClick={() => alignSelection("right")} className="rounded-xl px-3 py-2 text-sm font-bold" style={tintedButtonStyle}>{t("右对齐", "Align Right")}</button>
                    <button type="button" onClick={() => alignSelection("top")} className="rounded-xl px-3 py-2 text-sm font-bold" style={subtleButtonStyle}>{t("顶对齐", "Align Top")}</button>
                    <button type="button" onClick={() => alignSelection("middle")} className="rounded-xl px-3 py-2 text-sm font-bold" style={subtleButtonStyle}>{t("垂直居中", "Align Middle")}</button>
                    <button type="button" onClick={() => alignSelection("bottom")} className="rounded-xl px-3 py-2 text-sm font-bold" style={subtleButtonStyle}>{t("底对齐", "Align Bottom")}</button>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <button type="button" onClick={() => distributeSelection("x")} className="rounded-xl px-3 py-2 text-sm font-bold" style={subtleButtonStyle}>{t("水平分布", "Distribute X")}</button>
                    <button type="button" onClick={() => distributeSelection("y")} className="rounded-xl px-3 py-2 text-sm font-bold" style={subtleButtonStyle}>{t("垂直分布", "Distribute Y")}</button>
                  </div>
                </div>
              </div>
            ) : !selectedElement ? (
              <div className="space-y-4">
                <div className="rounded-2xl p-4" style={inspectorCardStyle}>
                  <p className="font-bold text-sm mb-2" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("这个版本的工作流画布已经支持", "This version of the workflow canvas already supports")}
                  </p>
                  <ul className="space-y-2 text-sm" style={{ color: ui.muted, lineHeight: 1.7 }}>
                    <li>{t("多画布创建与切换", "Multiple canvases with switching")}</li>
                    <li>{t("图片 / 视频素材加入与自由排版", "Image and video assets with freeform composition")}</li>
                    <li>{t("文本便签、拖拽、缩放、自动保存", "Text notes, drag, zoom, and autosave")}</li>
                  </ul>
                </div>
                <div className="rounded-2xl p-4" style={inspectorCardStyle}>
                  <p className="font-bold text-sm mb-2" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("建议用法", "Suggested flow")}
                  </p>
                  <p className="text-sm" style={{ color: ui.muted, lineHeight: 1.7 }}>
                    {t("先从左侧加入历史素材，再用便签记录镜头、构图、文案和提示词，最后整理成一个完整创意板。", "Start by adding assets from history, then use notes for shots, layout, copy, and prompts, and refine everything into one creative board.")}
                  </p>
                </div>
                <div className="rounded-2xl p-4" style={inspectorCardStyle}>
                  <p className="font-bold text-sm mb-2" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
                    {t("快捷操作", "Shortcuts")}
                  </p>
                  <ul className="space-y-2 text-sm" style={{ color: ui.muted, lineHeight: 1.7 }}>
                    <li>{t("拖拽空白区域：框选元素，贴近边缘会自动平移，Shift + 拖拽：追加框选", "Drag empty space to marquee select, edge hover auto-pans, Shift + drag adds to the selection")}</li>
                    <li>{t("触控板双指：平移画布，Shift + 滚轮：水平平移，右键或中键拖拽也可平移", "Trackpad two-finger pans the canvas, Shift + wheel pans horizontally, and right-drag or middle-drag also pans")}</li>
                    <li>{t("鼠标滚轮、Ctrl / Cmd / Alt + 滚轮、缩放工具 + 滚轮，或双指捏合：以光标为锚点缩放", "Mouse wheel, Ctrl / Cmd / Alt + wheel, zoom tool + wheel, or pinch zooms toward the cursor")}</li>
                    <li>{t("双击空白区域：按光标放大，Alt + 双击：按光标缩小", "Double-click empty space to zoom in at the cursor, Alt + double-click to zoom out")}</li>
                    <li>{t("Alt + 拖拽空白区域：连续拉近拉远视口", "Alt + drag empty space: scrub-zoom the viewport in and out")}</li>
                    <li>{t("拖动底部缩放百分比：连续缩放，轻点则回到 100%", "Drag the bottom zoom badge to scrub zoom, or tap it to return to 100%")}</li>
                    <li>{t("V：返回选择工具，H：切换抓手工具，空格 + 拖拽：临时抓手惯性平移", "V returns to the select tool, H toggles the hand tool, Space + drag gives you a temporary inertial hand pan")}</li>
                    <li>{t("触屏单指：惯性拖动画布，双指：同时平移和缩放", "Touch: one finger pans the canvas with inertia, two fingers pan and zoom together")}</li>
                    <li>{t("按住 Z 再拖拽：框选区域直接放大，贴近边缘会自动平移，Alt + Z：框选拉远", "Hold Z and drag: zoom into a region with edge auto-pan, Alt + Z: zoom back out")}</li>
                    <li>{t("缩放工具下 Shift + 拖拽：连续缩放，Alt + Shift：连续拉远", "With the zoom tool, Shift + drag scrub-zooms, Alt + Shift scrub-zooms out")}</li>
                    <li>{t("Ctrl / Cmd + A：全选当前画布", "Ctrl / Cmd + A: select all on the canvas")}</li>
                    <li>{t("Ctrl / Cmd + C / V：复制粘贴元素", "Ctrl / Cmd + C / V: copy and paste elements")}</li>
                    <li>{t("Ctrl / Cmd + D：快速复制当前所选", "Ctrl / Cmd + D: duplicate the current selection")}</li>
                    <li>{t("Alt / Option + 拖拽元素：边拖边复制", "Alt / Option + drag: duplicate while moving")}</li>
                    <li>{t("多选边框手柄：整体缩放所选元素", "Multi-select handles: resize the full selection")}</li>
                    <li>{t("Shift + 拉动缩放手柄：保持原始比例", "Shift + resize handles: preserve the original aspect ratio")}</li>
                    <li>{t("Alt / Option + 拉动缩放手柄：从中心向外缩放", "Alt / Option + resize handles: scale outward from the center")}</li>
                    <li>{t("拖动旋转手柄：自由旋转，Shift：按 15° 吸附", "Drag rotate handles: free rotate, Shift: snap every 15deg")}</li>
                    <li>{t("直接粘贴截图或剪贴板图片：自动上传到画布", "Paste screenshots or clipboard images: auto-upload to the canvas")}</li>
                    <li>{t("点击或拖动右下导航小地图：快速巡航视口", "Use or drag the navigator to move around the canvas")}</li>
                    <li>{t("Esc：清空选择，方向键：微调位置", "Esc: clear selection, arrow keys: nudge elements")}</li>
                  </ul>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                    {t("标题", "Title")}
                  </label>
                  <input
                    value={selectedElement.title || ""}
                    onChange={(event) => updateElement(selectedElement.id, { title: event.target.value })}
                    className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none"
                    style={inspectorInputStyle}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => toggleLockSelection(!selectedElement?.locked)}
                  className="w-full rounded-2xl px-4 py-3 text-sm font-bold"
                  style={selectedElement?.locked ? goldButtonStyle : subtleButtonStyle}
                >
                  {selectedElement?.locked ? t("解除锁定", "Unlock Element") : t("锁定元素", "Lock Element")}
                </button>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => selectedElement?.groupId && selectElementCluster(selectedElement.id)}
                    disabled={!selectedElement?.groupId}
                    className="rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-35"
                    style={tintedButtonStyle}
                  >
                    {selectedElement?.groupId ? t("选中整个组合", "Select Group") : t("未组合", "Not Grouped")}
                  </button>
                  <button
                    type="button"
                    onClick={() => ungroupSelectedElements()}
                    disabled={!selectedElement?.groupId}
                    className="rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-35"
                    style={subtleButtonStyle}
                  >
                    {t("取消组合", "Ungroup")}
                  </button>
                </div>

                {selectedElement.type === "text" ? (
                  <>
                    <div>
                      <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                        {t("内容", "Content")}
                      </label>
                      <textarea
                        value={selectedElement.text || ""}
                        onChange={(event) => updateElement(selectedElement.id, { text: event.target.value })}
                        rows={8}
                        className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none resize-none"
                        style={inspectorInputStyle}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                          {t("字号", "Font Size")}
                        </label>
                        <input
                          type="range"
                          min="14"
                          max="48"
                          value={selectedElement.fontSize || 18}
                          onChange={(event) => updateElement(selectedElement.id, { fontSize: Number(event.target.value) })}
                          className="w-full"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                          {t("文字颜色", "Text Color")}
                        </label>
                        <input
                          type="color"
                          value={selectedElement.color || ui.text}
                          onChange={(event) => updateElement(selectedElement.id, { color: event.target.value })}
                          className="w-full h-12 rounded-xl"
                          style={{ ...inspectorInputStyle, padding: 4 }}
                        />
                      </div>
                    </div>
                  </>
                ) : (
	                  <div className="rounded-2xl overflow-hidden" style={inspectorCardStyle}>
	                  <div className="relative aspect-[4/3]" style={{ background: ui.soft2 }}>
                      {selectedElement.type === "video" ? (
                        <OssVideo
                          src={getVideoAssetUrl(selectedElement)}
                          poster={getVideoPosterUrl(selectedElement) || undefined}
                          controls
                          className="w-full h-full object-cover"
                          style={{ transform: `rotate(${selectedRotation}deg)` }}
                        />
                      ) : selectedElement.type === "audio" ? (
                        <div className="w-full h-full p-5 flex flex-col justify-center gap-4" style={{ background: ui.soft }}>
                          <span className="material-symbols-outlined text-5xl" style={{ color: ui.blue }}>audio_file</span>
                          <OssAudio src={getAudioAssetUrl(selectedElement)} controls className="w-full" />
                        </div>
                      ) : (
                        <OssBackground
                          src={getImageAssetUrl(selectedElement)}
                          className="w-full h-full"
                          style={{
                            transform: `rotate(${selectedRotation}deg)`,
                          }}
                        >
                          <OssImage
                            src={getImageAssetUrl(selectedElement)}
                            alt=""
                            className="w-full h-full object-cover block"
                          />
                        </OssBackground>
	                      )}
	                      {["image", "video"].includes(selectedElement.type) && (
	                        <button
	                          type="button"
	                          onClick={() => setCanvasPreviewElement(selectedElement)}
	                          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full transition hover:scale-105"
	                          style={{ background: ui.selectionLabelBg, color: ui.text, border: `1px solid ${ui.line}`, boxShadow: ui.softShadow }}
	                          title={t("放大预览", "Open preview")}
	                          aria-label={t("放大预览素材", "Open asset preview")}
	                        >
	                          <span className="material-symbols-outlined text-[17px]">open_in_full</span>
	                        </button>
	                      )}
	                    </div>
	                    <div className="px-4 py-3">
	                      <p className="text-sm font-bold" style={{ color: ui.text, fontFamily: "Inter, sans-serif" }}>
	                        {selectedElement.type === "video" ? t("视频素材", "Video Asset") : selectedElement.type === "audio" ? t("音频素材", "Audio Asset") : t("图片素材", "Image Asset")}
	                      </p>
	                      <p className="text-xs mt-1" style={{ color: ui.muted }}>
	                        {selectedElement.creationId ? `${t("来源记录", "Source record")} #${selectedElement.creationId}` : t("已加入画布", "Added to canvas")}
	                      </p>
                      <div className="grid grid-cols-2 gap-2 mt-3">
                        {selectedElement.type === "image" && (
                          <button
                            type="button"
                            onClick={() => void handleCanvasVideoGenerate({
                              useSelection: true,
                              referenceImages: [selectedElement],
                              promptOverride: canvasVideoPrompt || selectedElement.prompt || selectedElement.title || "",
                            })}
                            disabled={canvasVideoGenerating || !selectedVideoScene}
                            className="rounded-xl px-3 py-2 text-xs font-bold disabled:opacity-35"
                            style={goldButtonStyle}
                          >
                            {t("生成视频", "Make Video")}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void downloadCanvasMediaElement(selectedElement)}
                          className="rounded-xl px-3 py-2 text-xs font-bold"
                          style={subtleButtonStyle}
                        >
                          {t("下载素材", "Download")}
                        </button>
                      </div>
	                    </div>
	                  </div>
	                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      X
                    </label>
                    <input
                      type="number"
                      value={Math.round(selectedElement.x || 0)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, {
                        x: clamp(event.target.value, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, selectedElement.x || 0),
                      })}
                      className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none disabled:opacity-40"
                      style={inspectorInputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      Y
                    </label>
                    <input
                      type="number"
                      value={Math.round(selectedElement.y || 0)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, {
                        y: clamp(event.target.value, -MAX_CANVAS_COORD, MAX_CANVAS_COORD, selectedElement.y || 0),
                      })}
                      className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none disabled:opacity-40"
                      style={inspectorInputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      {t("宽度", "Width")}
                    </label>
                    <input
                      type="number"
                      value={Math.round(selectedElement.width || 0)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, { width: clamp(event.target.value, 160, MAX_ELEMENT_SIZE, selectedElement.width) })}
                      className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none disabled:opacity-40"
                      style={inspectorInputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      {t("高度", "Height")}
                    </label>
                    <input
                      type="number"
                      value={Math.round(selectedElement.height || 0)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, { height: clamp(event.target.value, 120, MAX_ELEMENT_SIZE, selectedElement.height) })}
                      className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none disabled:opacity-40"
                      style={inspectorInputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      {t("旋转", "Rotation")}
                    </label>
                    <input
                      type="number"
                      value={Math.round(selectedRotation)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, {
                        rotation: normalizeAngle(event.target.value),
                      })}
                      className="w-full rounded-2xl px-4 py-3 bg-transparent outline-none disabled:opacity-40"
                      style={inspectorInputStyle}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] uppercase tracking-widest mb-2" style={{ color: ui.faint }}>
                      {t("旋转滑杆", "Rotation Slider")}
                    </label>
                    <input
                      type="range"
                      min="-180"
                      max="180"
                      value={Math.round(selectedRotation)}
                      disabled={selectedElement.locked}
                      onChange={(event) => updateElement(selectedElement.id, {
                        rotation: normalizeAngle(event.target.value),
                      })}
                      className="w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => reorderElement(selectedElement.id, "front")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={tintedButtonStyle}
                  >
                    {t("置于顶层", "Bring to Front")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reorderElement(selectedElement.id, "back")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("移到底层", "Send to Back")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reorderElement(selectedElement.id, "forward")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("上移一层", "Move Forward")}
                  </button>
                  <button
                    type="button"
                    onClick={() => reorderElement(selectedElement.id, "backward")}
                    className="rounded-2xl px-4 py-3 text-sm font-bold"
                    style={subtleButtonStyle}
                  >
                    {t("下移一层", "Move Backward")}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={deleteSelected}
                  disabled={selectedElement?.locked}
                  className="w-full rounded-2xl px-4 py-3 text-sm font-bold disabled:opacity-35"
                  style={dangerButtonStyle}
                >
                  {t("删除所选元素", "Delete Selected Element")}
                </button>
              </div>
            )}
            </>
            )}
          </div>
        </aside>
      )}
      <input
        ref={assetInputRef}
        type="file"
        accept="image/*,video/*,audio/*"
        className="fixed left-[-9999px] top-0 h-px w-px opacity-0 pointer-events-none"
        tabIndex={-1}
        aria-hidden="true"
        onClick={(event) => {
          event.currentTarget.value = "";
        }}
        onChange={handleAssetUpload}
      />
    </div>
  );
};

export default CanvasStudio;
