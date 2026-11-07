import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, BrainCircuit, CheckCircle2, ChevronDown, Download, Eye, Film, History, Image as ImageIcon, ImagePlus, LayoutTemplate, LoaderCircle, MessageSquarePlus, MonitorPlay, Play, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Terminal, Trash2, Wrench, X, XCircle } from "lucide-react";
import toast from "react-hot-toast";
import { getGenerationErrorMessage } from "../utils/generationErrors";
import GenerationErrorMessage from "../components/GenerationErrorMessage";
import useAuthAxios from "../hooks/useAuthAxios";
import useTaskStream from "../hooks/useTaskStream";
import useAgentConversationHistory from "../hooks/useAgentConversationHistory";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { getAgentExecutionView, getAgentToolLabel, getAgentCallDisplayStatus } from "../utils/agentExecutionView";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import AssetPreviewModal from "../components/AssetPreviewModal";
import { OssImage, OssVideo } from "../components/OssMedia";
import { cleanAgentReply, getAgentReferenceContext, getAgentReferenceTitle, parseReferenceDragPayload, REFERENCE_DRAG_MIME } from "../utils/agentHomeMedia";
import { getCanvasAssetType, uploadCanvasAsset } from "../utils/canvasAssetUpload";
import { isOversizedReferenceImage } from "../utils/mediaUploadLimits";
import {
  getModelByKey,
  getModelDurationOptions,
  getModelSizeOptions,
  normalizeModelCatalogResponse,
  SAFE_IMAGE_SIZE_OPTIONS,
  SAFE_VIDEO_SIZE_OPTIONS,
} from "../utils/modelCapabilities";

const MODES = [
  { key: "ask_for_approval", zh: "逐项确认", en: "Ask for approval" },
  { key: "approve_for_me", zh: "自动执行安全操作", en: "Approve for me" },
  { key: "full_access", zh: "完全自动执行", en: "Full access" },
];

const MODE_KEYS = new Set(MODES.map((item) => item.key));
const GLOBAL_AGENT_PREFERENCES_KEY = "stardraw_global_agent_preferences";
const EMPTY_AGENT_PREFERENCES = Object.freeze({
  agentModel: "",
  imageModel: "",
  videoModel: "",
  imageSize: "",
  videoSize: "",
  videoSeconds: "",
  reasoningEffort: "",
});
const readAgentPreferences = () => {
  try {
    const stored = JSON.parse(window.localStorage.getItem(GLOBAL_AGENT_PREFERENCES_KEY) || "null");
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? { ...EMPTY_AGENT_PREFERENCES, ...stored }
      : { ...EMPTY_AGENT_PREFERENCES };
  } catch {
    return { ...EMPTY_AGENT_PREFERENCES };
  }
};
const modelDisplayName = (model, fallback = "GPT") => model?.display_name || model?.displayName || model?.model_key || fallback;
const autoOptionLabel = (t) => t("自动选择", "Auto");
const idempotencyKey = (prefix) => `${prefix}:${crypto.randomUUID()}`;
const CLIENT_COMPLETION_STORAGE_PREFIX = "stardraw_agent_client_completion";
const CLIENT_COMPLETION_MAX_AGE_MS = 30 * 60 * 1000;
const isLegacyStepReferenceFailure = (value) => {
  const runError = value?.run?.error;
  const messages = [
    runError?.message,
    typeof runError === "string" ? runError : "",
    ...(Array.isArray(value?.calls) ? value.calls.map((call) => call?.error) : []),
  ].filter(Boolean).map((item) => String(item));
  return value?.run?.status === "failed"
    && (runError?.code === "AGENT_STEP_REFERENCE_UNRESOLVED"
      || messages.some((message) => message.includes("Unresolved Agent step reference")));
};
const clientCompletionStorageKey = (runId, stepId) => (
  `${CLIENT_COMPLETION_STORAGE_PREFIX}:${String(runId)}:${String(stepId)}`
);
const clientEffectIdempotencyKey = (runId, stepId) => (
  `agent-browser:${String(runId)}:${String(stepId)}:effect`.slice(0, 128)
);
const readStoredClientCompletion = (runId, stepId) => {
  try {
    const key = clientCompletionStorageKey(runId, stepId);
    const stored = JSON.parse(window.sessionStorage.getItem(key) || "null");
    const createdAt = Date.parse(stored?.createdAt || "");
    if (!stored?.result || typeof stored.result !== "object" || Array.isArray(stored.result)
        || !Number.isFinite(createdAt) || Date.now() - createdAt > CLIENT_COMPLETION_MAX_AGE_MS) {
      if (stored) window.sessionStorage.removeItem(key);
      return null;
    }
    return stored.result;
  } catch {
    window.sessionStorage.removeItem(clientCompletionStorageKey(runId, stepId));
    return null;
  }
};
const wait = (milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const RESULT_STATUS_LABELS = {
  pending: ["等待中", "Pending"],
  queued: ["排队中", "Queued"],
  processing: ["处理中", "Processing"],
  running: ["运行中", "Running"],
  paused: ["已暂停", "Paused"],
  waiting_approval: ["等待确认", "Waiting for approval"],
  waiting_client: ["等待浏览器执行", "Waiting for browser"],
  submitted: ["已提交", "Submitted"],
  completed: ["已完成", "Completed"],
  succeeded: ["已成功", "Succeeded"],
  success: ["成功", "Success"],
  failed: ["失败", "Failed"],
  cancelled: ["已取消", "Cancelled"],
};
const CANVAS_MUTATION_TOOLS = new Set([
  "canvas.edit", "canvas.patch", "canvas.asset.attach_creation",
  "workflow.save", "workflow.patch",
  "storyboard.edit", "storyboard.patch",
  "timeline.edit", "director3d.edit",
]);
const localizedStatus = (status, t) => {
  if (status === "stopped") return t("已停止", "Stopped");
  const key = String(status || "").trim().toLowerCase();
  const labels = RESULT_STATUS_LABELS[key];
  return labels ? t(labels[0], labels[1]) : String(status || "");
};
const summarizeResult = (result, t) => {
  if (!result || typeof result !== "object") return "";
  const creationId = result.creationId || result.creation_id;
  const taskId = result.taskId || result.task_id || result.runId || result.run_id;
  const status = localizedStatus(result.status || result.kind, t);
  if (creationId) return t(`作品 #${creationId} · ${status || "已提交"}`, `Creation #${creationId} · ${status || "Submitted"}`);
  if (taskId) return t(`任务 ${taskId} · ${status || "已提交"}`, `Task ${taskId} · ${status || "Submitted"}`);
  return status || t("调用已完成", "Call completed");
};

const renderableMediaUrl = (value) => {
  const url = String(value || "").trim();
  return /^(https?:\/\/|\/|blob:|data:image\/)/i.test(url) ? url : "";
};

const mediaFromAgentResult = (result) => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const nested = result.creation && typeof result.creation === "object" ? result.creation : {};
  const output = Array.isArray(result.output) ? result.output.find((item) => item?.url) || {} : {};
  const source = { ...nested, ...result };
  const content = renderableMediaUrl(
    source.content || source.content_url || source.image_url || source.video_url || output.url,
  );
  const status = String(source.status || "").trim().toLowerCase();
  if (!content || (status && !["completed", "succeeded", "success"].includes(status))) return null;
  const hintedType = String(source.type || output.type || "").toLowerCase();
  const type = hintedType === "video" || /\.(mp4|webm|mov)(?:$|\?)/i.test(content) ? "video" : "image";
  return {
    id: String(source.id || source.creationId || source.creation_id || content),
    creation_id: String(source.id || source.creationId || source.creation_id || ""),
    type,
    status: "completed",
    content,
    thumbnail_url: renderableMediaUrl(source.thumbnail_url || source.preview_image_url || source.poster),
    scene_name: String(source.scene_name || source.title || ""),
    prompt: String(source.prompt || ""),
  };
};

const completedMediaFromCalls = (calls = []) => {
  const unique = new Map();
  for (const call of calls) {
    const media = mediaFromAgentResult(call?.result);
    if (media) unique.set(media.creation_id || media.content, media);
  }
  return [...unique.values()];
};

const GlobalAgent = ({
  embedded = false,
  home = false,
  initialInstruction = "",
  onInitialInstructionConsumed,
  externalRequest = null,
  onExternalRequestConsumed,
  onExecutionStateChange,
  floating = false,
  dockExpanded = false,
  onDockExpandedChange,
  referenceAssets = [],
  onReferenceAssetsChange,
  // Retained for consumers outside /home that have not adopted multi-reference state yet.
  referenceAsset = null,
  onReferenceAssetChange,
  onReferenceDrop,
}) => {
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState(() => {
    const saved = window.localStorage.getItem("stardraw_agent_access_mode");
    return MODE_KEYS.has(saved) ? saved : "approve_for_me";
  });
  const [agentPreferences, setAgentPreferences] = useState(readAgentPreferences);
  const [accountPreferencesLoaded, setAccountPreferencesLoaded] = useState(false);
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false);
  const [modelCatalogs, setModelCatalogs] = useState({ agent: [], image: [], video: [] });
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [calls, setCalls] = useState([]);
  const [run, setRun] = useState(null);
  const [assistantReply, setAssistantReply] = useState("");
  const [executionDetailsOpen, setExecutionDetailsOpen] = useState(false);
  const [previewMedia, setPreviewMedia] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState("");
  const [focusedCallId, setFocusedCallId] = useState("");
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateOptions, setTemplateOptions] = useState([]);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [referenceDropActive, setReferenceDropActive] = useState(false);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const referenceDragDepthRef = useRef(0);
  const referenceFileInputRef = useRef(null);
  const notifiedCanvasStepsRef = useRef(new Set());
  const requestInFlightRef = useRef(false);
  const handledExternalRequestsRef = useRef(new Set());
  const initialInstructionAppliedRef = useRef(false);
  const runSyncErrorShownRef = useRef(false);
  const liveOperationRef = useRef(null);
  const pointsStateRef = useRef("");
  const conversationHydratedRef = useRef(false);
  const conversationSaveErrorRef = useRef(false);
  const accountPreferencesSaveErrorRef = useRef(false);
  const normalizedReferenceAssets = useMemo(() => {
    const candidates = Array.isArray(referenceAssets) && referenceAssets.length > 0
      ? referenceAssets
      : referenceAsset ? [referenceAsset] : [];
    const seen = new Set();
    return candidates
      .filter((reference) => reference?.previewUrl)
      .filter((reference) => {
        const identity = String(reference.id || reference.uploadId || reference.creationId || reference.templateId || reference.previewUrl);
        if (!identity || seen.has(identity)) return false;
        seen.add(identity);
        return true;
      })
      .slice(0, 4);
  }, [referenceAsset, referenceAssets]);
  const {
    conversations,
    activeConversation,
    loading: conversationLoading,
    createConversation,
    deleteConversation,
    openConversation,
    saveConversation,
  } = useAgentConversationHistory({ surface: "global" });
  const sessionId = activeConversation?.id || "";
  const running = ["queued", "running"].includes(run?.status);
  const activeRun = ["queued", "running", "waiting_approval", "waiting_client"].includes(run?.status);
  const executionActive = planning || actionBusy || activeRun;
  const settingsDisabled = Boolean(planning || actionBusy || activeRun);
  const homeRunStarted = Boolean(run?.id);
  const showLiveOperation = home ? homeRunStarted : Boolean(planning || actionBusy || run);
  const showExecutionPlan = Boolean(plan && (!home || homeRunStarted));
  const showExecutionDetails = !home || executionActive || executionDetailsOpen;
  const executionLanguage = document.documentElement.lang === "en" ? "en" : "zh";
  const selectedImageModel = getModelByKey(modelCatalogs.image, agentPreferences.imageModel);
  const selectedVideoModel = getModelByKey(modelCatalogs.video, agentPreferences.videoModel);
  const imageSizeOptions = useMemo(() => getModelSizeOptions({
    model: selectedImageModel,
    outputType: "image",
    fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
  }), [selectedImageModel]);
  const videoSizeOptions = useMemo(() => getModelSizeOptions({
    model: selectedVideoModel,
    outputType: "video",
    fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
  }), [selectedVideoModel]);
  const videoDurationOptions = useMemo(() => getModelDurationOptions({
    model: selectedVideoModel,
    fallbackSeconds: 8,
  }), [selectedVideoModel]);
  const executionView = getAgentExecutionView({ planning, actionBusy, run, calls, language: executionLanguage });
  const taskStream = useTaskStream({
    page: 1,
    pageSize: 50,
    type: "agent_plan",
    enabled: Boolean(run?.id && activeRun),
  });
  useEffect(() => {
    window.localStorage.setItem("stardraw_agent_access_mode", mode);
  }, [mode]);

  useEffect(() => {
    try {
      window.localStorage.setItem(GLOBAL_AGENT_PREFERENCES_KEY, JSON.stringify(agentPreferences));
    } catch {
      // Browser storage is a convenience fallback; conversation persistence remains authoritative.
    }
  }, [agentPreferences]);

  useEffect(() => {
    if (!home) return undefined;
    let cancelled = false;
    setModelCatalogLoading(true);
    Promise.all([
      authAxios.get("/api/ai/models?output_type=agent"),
      authAxios.get("/api/ai/models?output_type=image"),
      authAxios.get("/api/ai/models?output_type=video"),
    ])
      .then(([agentResponse, imageResponse, videoResponse]) => {
        if (cancelled) return;
        setModelCatalogs({
          agent: normalizeModelCatalogResponse(agentResponse.data),
          image: normalizeModelCatalogResponse(imageResponse.data),
          video: normalizeModelCatalogResponse(videoResponse.data),
        });
      })
      .catch(() => {
        if (!cancelled) setModelCatalogs({ agent: [], image: [], video: [] });
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [authAxios, home]);

  useEffect(() => {
    if (!home) {
      setAccountPreferencesLoaded(false);
      return undefined;
    }
    let cancelled = false;
    setAccountPreferencesLoaded(false);
    authAxios.get("/api/agent/preferences")
      .then(({ data }) => {
        if (cancelled) return;
        const saved = data?.data || {};
        if (MODE_KEYS.has(saved.mode)) setMode(saved.mode);
        if (saved.agentPreferences && typeof saved.agentPreferences === "object") {
          setAgentPreferences((current) => ({ ...current, ...saved.agentPreferences }));
        }
      })
      .catch(() => {
        // Browser and conversation state remain usable if the additive
        // account-preferences migration is still rolling out.
      })
      .finally(() => {
        if (!cancelled) setAccountPreferencesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [authAxios, home]);

  useEffect(() => {
    if (!home || !accountPreferencesLoaded || conversationLoading || settingsDisabled) return undefined;
    const timer = window.setTimeout(() => {
      authAxios.put("/api/agent/preferences", {
        mode,
        agentPreferences,
      }).then(() => {
        accountPreferencesSaveErrorRef.current = false;
      }).catch((error) => {
        if (accountPreferencesSaveErrorRef.current) return;
        accountPreferencesSaveErrorRef.current = true;
        toast.error(error.response?.data?.message || t("Agent 设置保存失败", "Unable to save Agent settings"));
      });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [accountPreferencesLoaded, agentPreferences, authAxios, conversationLoading, home, mode, settingsDisabled, t]);

  useEffect(() => {
    if (modelCatalogLoading) return;
    setAgentPreferences((current) => {
      const next = { ...current };
      let changed = false;
      const modelFields = [["agentModel", modelCatalogs.agent], ["imageModel", modelCatalogs.image], ["videoModel", modelCatalogs.video]];
      for (const [field, catalog] of modelFields) {
        if (catalog.length > 0 && next[field] && !catalog.some((model) => model.model_key === next[field])) {
          next[field] = "";
          changed = true;
        }
      }
      if (next.imageSize && !imageSizeOptions.some((option) => option.value === next.imageSize)) {
        next.imageSize = "";
        changed = true;
      }
      if (next.videoSize && !videoSizeOptions.some((option) => option.value === next.videoSize)) {
        next.videoSize = "";
        changed = true;
      }
      if (next.videoSeconds && !videoDurationOptions.includes(Number(next.videoSeconds))) {
        next.videoSeconds = "";
        changed = true;
      }
      return changed ? next : current;
    });
  }, [imageSizeOptions, modelCatalogLoading, modelCatalogs, videoDurationOptions, videoSizeOptions]);

  useEffect(() => {
    onExecutionStateChange?.(executionActive, {
      status: planning ? "planning" : actionBusy ? "working" : run?.status || "idle",
      progress: Number(run?.progress || 0),
      label: executionView.title,
    });
  }, [actionBusy, executionActive, executionView.title, onExecutionStateChange, planning, run?.progress, run?.status]);

  useEffect(() => {
    if (!activeConversation?.id) return;
    conversationHydratedRef.current = false;
    const restored = activeConversation.runtime_state || {};
    const invalidLegacyRun = isLegacyStepReferenceFailure(restored);
    setInstruction(invalidLegacyRun ? "" : String(restored.instruction || ""));
    setPlan(invalidLegacyRun ? null : restored.plan || null);
    setCalls(invalidLegacyRun || !Array.isArray(restored.calls) ? [] : restored.calls);
    setRun(invalidLegacyRun ? null : restored.run || null);
    setAssistantReply(invalidLegacyRun ? "" : String(restored.assistantReply || restored.run?.finalResponse || restored.plan?.response || ""));
    setExecutionDetailsOpen(false);
    setPreviewMedia(null);
    setSelectedTemplate(restored.selectedTemplate || null);
    if (!home && restored.agentPreferences && typeof restored.agentPreferences === "object") {
      setAgentPreferences((current) => ({ ...current, ...restored.agentPreferences }));
    }
    if (!home && MODE_KEYS.has(restored.mode)) setMode(restored.mode);
    window.localStorage.setItem("stardraw_global_agent_session", activeConversation.id);
    const frame = window.requestAnimationFrame(() => { conversationHydratedRef.current = true; });
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversation?.id, activeConversation?.runtime_state, home]);

  useEffect(() => {
    const requestedInstruction = String(initialInstruction || "").trim();
    if (!home || !requestedInstruction || !activeConversation?.id || conversationLoading || initialInstructionAppliedRef.current) return;
    initialInstructionAppliedRef.current = true;

    const applyInitialInstruction = async () => {
      try {
        const runtimeState = activeConversation.runtime_state || {};
        const hasExistingConversation = Boolean(
          runtimeState.instruction
          || runtimeState.plan
          || runtimeState.run
          || (Array.isArray(activeConversation.messages) && activeConversation.messages.length),
        );
        if (!hasExistingConversation) {
          setInstruction(requestedInstruction);
          setPlan(null);
          setCalls([]);
          setRun(null);
          return;
        }

        const conversation = await createConversation({ title: requestedInstruction });
        if (!conversation?.id) throw new Error(t("无法创建新对话", "Unable to create a new conversation"));
        await authAxios.put(`/api/agent/conversations/${encodeURIComponent(conversation.id)}`, {
          title: requestedInstruction,
          messages: [],
          runtime_state: {
            instruction: requestedInstruction,
            mode,
            plan: null,
            calls: [],
            run: null,
          },
        });
        await openConversation(conversation.id);
      } catch (error) {
        initialInstructionAppliedRef.current = false;
        toast.error(error.response?.data?.message || error.message || t("无法载入首页指令", "Unable to load the landing instruction"));
        return;
      }
    };

    void applyInitialInstruction().finally(() => {
      if (!initialInstructionAppliedRef.current) return;
      onInitialInstructionConsumed?.();
    });
  }, [activeConversation, authAxios, conversationLoading, createConversation, home, initialInstruction, mode, onInitialInstructionConsumed, openConversation, t]);

  useEffect(() => {
    if (!home || !templatePickerOpen || templateLoaded || templateLoading) return;
    setTemplateLoading(true);
    authAxios.get("/api/public/community/bootstrap")
      .then(({ data }) => {
        const templates = (data?.data?.templates || []).map((template) => ({
          id: String(template.id || ""),
          sceneKey: String(template.scene_key || ""),
          title: template.preview_title || template.scene_name || template.scene_key || t("未命名模板", "Untitled template"),
          description: template.preview_description || "",
          outputType: template.output_type || "image",
          preview: template.preview_image_url || template.preview_video_url || "",
          tags: Array.isArray(template.tags) ? template.tags : [],
        })).filter((template) => template.id && template.title);
        setTemplateOptions(templates);
      })
      .catch((error) => {
        toast.error(error.response?.data?.message || t("模板加载失败", "Unable to load templates"));
      })
      .finally(() => {
        setTemplateLoading(false);
        setTemplateLoaded(true);
      });
  }, [authAxios, home, templateLoaded, templateLoading, templatePickerOpen, t]);

  const persistCurrentConversation = useCallback(() => {
    const persistedReply = cleanAgentReply(assistantReply || run?.finalResponse || plan?.response || "");
    const messages = instruction.trim() ? [
      { id: `user_${sessionId}`, role: "user", content: instruction.trim() },
      ...(plan || persistedReply ? [{
        id: `assistant_${run?.id || sessionId}`,
        role: "assistant",
        content: persistedReply || String(run?.summary || plan?.summary || ""),
        status: run?.status || "planned",
        run_id: run?.id || null,
      }] : []),
    ] : [];
    return saveConversation({
      title: instruction.trim() || t("新对话", "New conversation"),
      messages,
      runtimeState: { instruction, mode, plan, calls, run, assistantReply: persistedReply, selectedTemplate, agentPreferences },
    });
  }, [agentPreferences, assistantReply, calls, instruction, mode, plan, run, saveConversation, selectedTemplate, sessionId, t]);

  useEffect(() => {
    if (!sessionId || !conversationHydratedRef.current || conversationLoading) return undefined;
    const timer = window.setTimeout(() => {
      persistCurrentConversation().then(() => {
        conversationSaveErrorRef.current = false;
      }).catch((error) => {
        if (conversationSaveErrorRef.current) return;
        conversationSaveErrorRef.current = true;
        toast.error(error.response?.data?.message || t("对话记录保存失败", "Unable to save conversation"));
      });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [conversationLoading, persistCurrentConversation, sessionId, t]);

  const syncRun = useCallback((nextRun) => {
    if (!nextRun) return;
    const mediaPointState = (nextRun.steps || [])
      .filter((step) => ["media.generate.image", "media.generate.video", "creation.get"].includes(String(step.toolKey || "").trim().toLowerCase()))
      .map((step) => ({
        id: step.id || step.callId || null,
        status: step.status || null,
        creationId: step.result?.creationId || step.result?.creation_id || step.resolvedParameters?.creationId || null,
        resultStatus: step.result?.status || step.result?.creation?.status || null,
        providerStatus: step.result?.providerStatus || step.result?.provider_status || null,
        pointsReserved: step.result?.pointsReserved ?? step.result?.points_reserved ?? null,
        pointsCharged: step.result?.pointsCharged ?? step.result?.points_charged ?? null,
        chargeStatus: step.result?.chargeStatus || step.result?.charge_status || null,
      }));
    const nextPointsState = JSON.stringify(mediaPointState);
    if (nextPointsState !== pointsStateRef.current) {
      pointsStateRef.current = nextPointsState;
      window.dispatchEvent(new Event("stardraw:points-updated"));
    }
    for (const step of nextRun.steps || []) {
      if (step.status !== "completed" || !CANVAS_MUTATION_TOOLS.has(step.toolKey)) continue;
      const notificationKey = `${nextRun.id}:${step.id}:${step.timestamps?.completedAt || "completed"}`;
      if (notifiedCanvasStepsRef.current.has(notificationKey)) continue;
      notifiedCanvasStepsRef.current.add(notificationKey);
      const canvasId = step.result?.canvasId || step.result?.id || step.resolvedParameters?.canvasId || step.parameters?.canvasId;
      if (!canvasId) continue;
      window.dispatchEvent(new CustomEvent("stardraw:agent-canvas-updated", {
        detail: { canvasId: String(canvasId), toolKey: step.toolKey, runId: nextRun.id, stepId: step.id },
      }));
    }
    setRun(nextRun);
    setCalls((nextRun.steps || []).map((step) => ({
      ...step,
      callId: step.callId,
      callName: step.callName,
      error: step.error?.message || null,
    })));
    setPlan((current) => current || { summary: nextRun.summary, calls: [] });
  }, []);

  useEffect(() => {
    if (!run?.id || !activeRun) return undefined;
    let cancelled = false;
    let refreshing = false;
    const refresh = async () => {
      if (cancelled || refreshing) return;
      refreshing = true;
      try {
        const { data } = await authAxios.get(`/api/agent/runs/${run.id}`);
        if (!cancelled) {
          runSyncErrorShownRef.current = false;
          syncRun(data?.data);
        }
      } catch (error) {
        if (!cancelled && error.response?.status !== 404 && !runSyncErrorShownRef.current) {
          runSyncErrorShownRef.current = true;
          toast.error(error.response?.data?.message || t("Agent 状态同步失败", "Unable to sync Agent status"));
        }
      } finally {
        refreshing = false;
      }
    };
    const timer = window.setInterval(refresh, 1500);
    const handleVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", handleVisibility);
    void refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [activeRun, authAxios, run?.id, syncRun, t]);

  useEffect(() => {
    const status = String(run?.status || "").toLowerCase();
    if (!["completed", "succeeded", "success", "failed", "cancelled"].includes(status)) return;
    if (run?.finalResponse) setAssistantReply(String(run.finalResponse));
    setExecutionDetailsOpen(false);
  }, [run?.finalResponse, run?.status]);

  useEffect(() => {
    if (!executionActive) return;
    const frame = window.requestAnimationFrame(() => {
      liveOperationRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [executionActive, executionView.phase, executionView.toolKey]);

  const requestAgentPlan = useCallback(async (requestedInstruction, { currentCanvasId = "", template = selectedTemplate } = {}) => {
      const { data } = await authAxios.post("/api/agent/plan", {
        instruction: requestedInstruction,
        sessionId,
        language: document.documentElement.lang === "en" ? "en" : "zh",
        context: {
          source: "global_agent",
          currentPath: window.location.pathname,
          currentCanvasId: currentCanvasId || (window.location.pathname.startsWith("/ai/canvas")
            ? window.localStorage.getItem("stardraw_active_canvas_id") || ""
            : ""),
          selectedTemplate: template ? {
            id: template.id,
            sceneKey: template.sceneKey,
            title: template.title,
            outputType: template.outputType,
          } : null,
          attachedReferenceImages: getAgentReferenceContext(normalizedReferenceAssets),
          agentPreferences,
        },
      }, { headers: { "X-Idempotency-Key": idempotencyKey("global-agent-plan") } });
      const nextPlan = data?.data || null;
      const usedCallIds = new Set();
      const collectReferenceIds = (field) => [...new Set(normalizedReferenceAssets
        .map((reference) => String(reference?.[field] || "").trim())
        .filter(Boolean))].slice(0, 4);
      const referenceCreationIds = collectReferenceIds("creationId");
      const referenceTemplateIds = collectReferenceIds("templateId");
      const referenceUploadIds = collectReferenceIds("uploadId");
      const preparedCalls = (nextPlan?.calls || []).map((call, index) => {
        const planCallId = String(call.id || call.stepId || call.callId || call.name || "").trim() || `step_${index + 1}`;
        let callId = planCallId;
        if (usedCallIds.has(callId)) callId = `${planCallId}_${index + 1}`;
        usedCallIds.add(callId);
        const mediaReferenceParameters = ["media.generate.image", "media.generate.video"].includes(String(call.toolKey || call.tool_key || "").trim().toLowerCase())
          ? {
            ...(referenceCreationIds.length ? { referenceCreationIds } : {}),
            ...(referenceTemplateIds.length ? { referenceTemplateIds } : {}),
            ...(referenceUploadIds.length ? { referenceUploadIds } : {}),
          }
          : {};
        return {
          ...call,
          parameters: { ...(call.parameters || {}), ...mediaReferenceParameters },
          planCallId,
          callId,
          callName: String(call.name || call.label || planCallId),
          idempotencyKey: idempotencyKey("global-agent-tool"),
          status: "ready",
          result: null,
        };
      });
      return { nextPlan, preparedCalls };
  }, [agentPreferences, authAxios, normalizedReferenceAssets, selectedTemplate, sessionId]);

  const filteredTemplates = templateOptions.filter((template) => {
    const query = templateQuery.trim().toLowerCase();
    if (!query) return true;
    return [template.title, template.sceneKey, template.description, ...(template.tags || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  }).slice(0, 12);

  const chooseTemplate = (template) => {
    setSelectedTemplate(template);
    setInstruction((current) => {
      const marker = t(`模板：${template.title}（ID：${template.id}）`, `Template: ${template.title} (ID: ${template.id})`);
      if (current.includes(marker)) return current;
      return current.trim() ? `${current.trim()}\n\n${marker}` : t(`使用模板“${template.title}”完成我的创作要求。`, `Use the “${template.title}” template for my creative request.`);
    });
    setTemplatePickerOpen(false);
    setTemplateQuery("");
  };

  const updateAgentPreferences = (patch) => {
    setAgentPreferences((current) => ({ ...current, ...patch }));
  };

  const selectedModeLabel = MODES.find((item) => item.key === mode);

  const startAgentRun = useCallback(async ({ requestedInstruction, nextPlan, preparedCalls, requestedMode }) => {
    const { data } = await authAxios.post("/api/agent/runs", {
      agentMode: requestedMode,
      sessionId,
      instruction: requestedInstruction,
      language: document.documentElement.lang === "en" ? "en" : "zh",
      plan: { ...nextPlan, calls: preparedCalls },
    }, { headers: { "X-Idempotency-Key": idempotencyKey("global-agent-run") } });
    syncRun(data?.data);
  }, [authAxios, sessionId, syncRun]);

  const planRequest = async () => {
    const requestedInstruction = instruction.trim();
    if (!sessionId || conversationLoading || !requestedInstruction || planning || activeRun || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setPlanning(true);
    setPlan(null);
    setCalls([]);
    setRun(null);
    setAssistantReply("");
    setExecutionDetailsOpen(false);
    try {
      const { nextPlan, preparedCalls } = await requestAgentPlan(requestedInstruction);
      setPlan(nextPlan);
      setCalls(preparedCalls);
      if (!preparedCalls.length) {
        setAssistantReply(String(nextPlan?.response || nextPlan?.reply || nextPlan?.summary || t("我可以帮你生成图片、视频、模板和工作流。请告诉我你想完成什么。", "I can help with images, videos, templates, and workflows. Tell me what you want to create.")));
        return;
      }
    } catch (error) {
      toast.error(getGenerationErrorMessage(error, t));
    } finally {
      setPlanning(false);
      requestInFlightRef.current = false;
    }
  };

  const runPlan = async () => {
    if (!calls.length || running || actionBusy || run?.id || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setActionBusy(true);
    try {
      await startAgentRun({
        requestedInstruction: instruction.trim(),
        nextPlan: plan,
        preparedCalls: calls,
        requestedMode: mode,
      });
    } catch (error) {
      toast.error(getGenerationErrorMessage(error, t));
    } finally {
      setActionBusy(false);
      requestInFlightRef.current = false;
    }
  };

  const submitHomeRequest = async () => {
    const requestedInstruction = instruction.trim();
    if (!sessionId || conversationLoading || !requestedInstruction || planning || activeRun || requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    setPlanning(true);
    setPlan(null);
    setCalls([]);
    setRun(null);
    setAssistantReply("");
    setExecutionDetailsOpen(true);
    try {
      const { nextPlan, preparedCalls } = await requestAgentPlan(requestedInstruction);
      setPlan(nextPlan);
      setCalls(preparedCalls);
      if (!preparedCalls.length) {
        setAssistantReply(String(nextPlan?.response || nextPlan?.reply || nextPlan?.summary || t("我可以帮你生成图片、视频、模板和工作流。请告诉我你想完成什么。", "I can help with images, videos, templates, and workflows. Tell me what you want to create.")));
        setExecutionDetailsOpen(false);
        return;
      }
      setPlanning(false);
      setActionBusy(true);
      await startAgentRun({
        requestedInstruction,
        nextPlan,
        preparedCalls,
        requestedMode: mode,
      });
    } catch (error) {
      toast.error(getGenerationErrorMessage(error, t));
    } finally {
      setPlanning(false);
      setActionBusy(false);
      requestInFlightRef.current = false;
    }
  };

  useEffect(() => {
    const requestId = String(externalRequest?.id || "");
    const requestedInstruction = String(externalRequest?.instruction || "").trim();
    if (!sessionId || conversationLoading || !requestId || !requestedInstruction || handledExternalRequestsRef.current.has(requestId)) return;
    handledExternalRequestsRef.current.add(requestId);

    const submit = async () => {
      if (requestInFlightRef.current || activeRun) {
        toast.error(t("Agent 正在执行另一项任务，请等待完成后再试", "Agent is already running another task"));
        onExternalRequestConsumed?.(requestId);
        return;
      }
      const requestedMode = MODE_KEYS.has(externalRequest?.mode) ? externalRequest.mode : mode;
      requestInFlightRef.current = true;
      setInstruction(requestedInstruction);
      setMode(requestedMode);
      setPlan(null);
      setCalls([]);
      setRun(null);
      setAssistantReply("");
      setExecutionDetailsOpen(true);
      setPlanning(true);
      try {
        const { nextPlan, preparedCalls } = await requestAgentPlan(requestedInstruction, {
          currentCanvasId: String(externalRequest?.currentCanvasId || ""),
        });
        setPlan(nextPlan);
        setCalls(preparedCalls);
        if (!preparedCalls.length) {
          setAssistantReply(String(nextPlan?.response || nextPlan?.reply || nextPlan?.summary || t("我可以帮你生成图片、视频、模板和工作流。请告诉我你想完成什么。", "I can help with images, videos, templates, and workflows. Tell me what you want to create.")));
          setExecutionDetailsOpen(false);
          return;
        }
        setPlanning(false);
        setActionBusy(true);
        await startAgentRun({
          requestedInstruction,
          nextPlan,
          preparedCalls,
          requestedMode,
        });
      } catch (error) {
        toast.error(getGenerationErrorMessage(error, t));
      } finally {
        setPlanning(false);
        setActionBusy(false);
        requestInFlightRef.current = false;
        onExternalRequestConsumed?.(requestId);
      }
    };

    void submit();
  }, [activeRun, conversationLoading, externalRequest, mode, onExternalRequestConsumed, requestAgentPlan, sessionId, startAgentRun, t]);

  const approveStep = async (call) => {
    if (!run?.id || actionBusy) return;
    const accepted = window.confirm(t(
      `Agent 将调用“${call.toolKey}”。确认后后台任务会继续执行，是否继续？`,
      `Agent will call “${call.toolKey}”. The background plan will resume after approval. Continue?`,
    ));
    if (!accepted) return;
    setActionBusy(true);
    try {
      const { data } = await authAxios.post(`/api/agent/runs/${run.id}/steps/${call.id}/approve`, { confirmed: true });
      syncRun(data?.data);
    } catch (error) {
      toast.error(error.response?.data?.message || t("确认失败", "Approval failed"));
    } finally {
      setActionBusy(false);
    }
  };

  const completeClientStep = async (call, result) => {
    const resultBytes = new TextEncoder().encode(JSON.stringify(result ?? {})).byteLength;
    if (resultBytes > 16 * 1024) {
      throw new Error(t("浏览器操作结果过大，未提交给 Agent", "Browser action result is too large to submit to Agent"));
    }
    const storageKey = clientCompletionStorageKey(run.id, call.id);
    window.sessionStorage.setItem(storageKey, JSON.stringify({ result, createdAt: new Date().toISOString() }));
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const { data } = await authAxios.post(`/api/agent/runs/${run.id}/steps/${call.id}/client-complete`, {
          confirmed: true,
          result,
        });
        window.sessionStorage.removeItem(storageKey);
        syncRun(data?.data);
        return;
      } catch (error) {
        lastError = error;
        const status = Number(error.response?.status || 0);
        if ([404, 409].includes(status)) {
          window.sessionStorage.removeItem(storageKey);
          throw error;
        }
        if (attempt < 2) await wait(350 * (attempt + 1));
      }
    }
    throw lastError;
  };

  const postClientEffect = async (call, url, body, config = {}) => {
    const headers = {
      ...(config.headers || {}),
      "X-Idempotency-Key": clientEffectIdempotencyKey(run.id, call.id),
    };
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await authAxios.post(url, body, { ...config, headers });
      } catch (error) {
        lastError = error;
        const status = Number(error.response?.status || 0);
        const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
        if (!retryable || attempt === 2) throw error;
        await wait(400 * (attempt + 1));
      }
    }
    throw lastError;
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = String(filename || "download").replace(/[\\/:*?"<>|]/g, "_");
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const chooseLocalFile = (accept) => new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept || "";
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    let focusTimer;
    const cleanup = () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("focus", handleWindowFocus);
      input.remove();
    };
    const finish = (error, file = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(file);
    };
    const cancelledError = () => new Error(t("已取消文件选择", "File selection cancelled"));
    function handleWindowFocus() {
      focusTimer = window.setTimeout(() => {
        const file = input.files?.[0] || null;
        if (file) finish(null, file);
        else finish(cancelledError());
      }, 350);
    }
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      if (file) finish(null, file);
      else finish(new Error(t("未选择文件", "No file was selected")));
    }, { once: true });
    input.addEventListener("cancel", () => {
      finish(cancelledError());
    }, { once: true });
    window.addEventListener("focus", handleWindowFocus);
    try {
      input.click();
    } catch (error) {
      finish(error);
    }
  });

  const executeClientAction = async (call) => {
    if (!run?.id || actionBusy) return;
    const action = call?.result?.clientAction;
    if (!action?.type) return;
    setActionBusy(true);
    try {
      const storedResult = readStoredClientCompletion(run.id, call.id);
      if (storedResult) {
        await completeClientStep(call, storedResult);
        toast.success(t("浏览器操作结果已恢复，Agent 将继续执行", "Browser action result restored. Agent will continue."));
        return;
      }
      if (action.type === "creation.download.batch") {
        const response = await authAxios.post(
          "/api/user/creations/download/batch",
          { creation_ids: action.creationIds || [] },
          { responseType: "blob" },
        );
        downloadBlob(response.data, action.filename || "creations.zip");
        await completeClientStep(call, { downloaded: true, filename: action.filename || "creations.zip" });
        toast.success(t("批量下载已开始", "Batch download started"));
        return;
      }
      if (action.type === "creation.download") {
        const { data } = await authAxios.get(
          `/api/user/creations/${encodeURIComponent(action.creationId)}/download`,
        );
        const source = data?.data?.download_url;
        if (!source) throw new Error(t("作品下载地址不可用", "Creation download is unavailable"));
        const downloadUrl = await resolvePrivateUrl(source);
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = String(action.filename || `creation_${action.creationId}`).replace(/[\\/:*?"<>|]/g, "_");
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        await completeClientStep(call, {
          downloaded: true,
          creationId: String(action.creationId),
          filename: action.filename || `creation_${action.creationId}`,
        });
        toast.success(t("作品下载已开始", "Creation download started"));
        return;
      }
      if (action.type === "creation.export.csv") {
        const response = await authAxios.get("/api/user/creations/export/csv", { responseType: "blob" });
        downloadBlob(response.data, action.filename || "creations.csv");
        await completeClientStep(call, { downloaded: true, filename: action.filename || "creations.csv" });
        toast.success(t("CSV 导出已开始", "CSV export started"));
        return;
      }
      if (action.type === "canvas.asset.upload") {
        const file = await chooseLocalFile(action.accept);
        const formData = new FormData();
        formData.append("asset", file);
        if (action.mediaType) formData.append("type", action.mediaType);
        const { data } = await postClientEffect(call, "/api/canvases/assets", formData);
        const asset = data?.data || {};
        await completeClientStep(call, {
          uploaded: true,
          canvasId: action.canvasId,
          asset: {
            id: asset.id,
            resourceId: asset.resource_id,
            type: asset.type,
            title: asset.title,
            src: asset.src || asset.url,
            poster: asset.poster || "",
            objectKey: asset.objectKey || "",
            source: asset.source || "canvas_upload",
          },
        });
        toast.success(t("素材已上传，Agent 将继续执行", "Asset uploaded. Agent will continue."));
        return;
      }
      if (action.type === "profile.avatar.upload") {
        const file = await chooseLocalFile("image/*");
        const formData = new FormData();
        formData.append("avatar", file);
        const { data } = await postClientEffect(call, "/api/user/profile/avatar", formData);
        const profile = data?.data || {};
        await completeClientStep(call, {
          uploaded: true,
          avatarUrl: profile.avatar_url || profile.avatarUrl || null,
        });
        toast.success(t("头像已上传", "Avatar uploaded"));
        return;
      }
      if (action.type === "template.preview.upload") {
        const file = await chooseLocalFile(action.accept);
        const formData = new FormData();
        formData.append("preview", file);
        const { data } = await postClientEffect(
          call,
          `/api/template-studio/prompt-templates/${encodeURIComponent(action.templateId)}/preview`,
          formData,
          { headers: { "X-Preview-Asset-Kind": action.previewKind } },
        );
        const template = data?.data || {};
        await completeClientStep(call, {
          uploaded: true,
          templateId: String(template.id || action.templateId),
          previewKind: data?.preview_kind || action.previewKind,
          version: Number(template.version || action.templateVersion || 1),
          previewUrl: action.previewKind === "video" ? template.preview_video_url : template.preview_image_url,
        });
        toast.success(t("模板预览已上传", "Template preview uploaded"));
        return;
      }
      if (action.type === "digital-human.role.asset.upload") {
        const file = await chooseLocalFile(action.accept);
        const formData = new FormData();
        formData.append("asset", file);
        const { data } = await postClientEffect(
          call,
          `/api/digital-human/roles/${encodeURIComponent(action.roleId)}/assets`,
          formData,
          { headers: { "X-Role-Asset-Kind": action.assetKind } },
        );
        const role = data?.data || {};
        await completeClientStep(call, {
          uploaded: true,
          roleId: String(role.id || action.roleId),
          assetKind: action.assetKind,
          status: role.status,
          avatarUrl: role.avatar_url || null,
          demoVideoUrl: role.demo_video_url || null,
          readyAt: role.ready_at || null,
        });
        toast.success(t("数字人素材已上传", "Digital-human asset uploaded"));
        return;
      }
      if (["canvas.export.image", "timeline.render"].includes(action.type)) {
        window.sessionStorage.setItem("stardraw_agent_browser_action", JSON.stringify({
          runId: run.id,
          stepId: call.id,
          action,
          createdAt: new Date().toISOString(),
        }));
        const query = new URLSearchParams({ agentAction: action.type, canvasId: action.canvasId || "" });
        window.location.assign(`/ai/canvas?${query.toString()}`);
        return;
      }
      throw new Error(t("这个浏览器操作暂不受支持", "This browser action is not supported"));
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("浏览器操作失败", "Browser action failed"));
    } finally {
      setActionBusy(false);
    }
  };

  const cancelRun = async () => {
    if (!run?.id || actionBusy || !["queued", "running", "waiting_approval", "waiting_client"].includes(run.status)) return;
    setActionBusy(true);
    try {
      const { data } = await authAxios.post(`/api/agent/runs/${run.id}/cancel`, {
        reason: "Cancelled by user",
      }, { headers: { "X-Idempotency-Key": idempotencyKey("global-agent-cancel") } });
      syncRun(data?.data);
    } catch (error) {
      toast.error(error.response?.data?.message || t("取消失败", "Cancellation failed"));
    } finally {
      setActionBusy(false);
    }
  };

  const clearRun = () => {
    setPlan(null);
    setCalls([]);
    setRun(null);
    setExecutionDetailsOpen(false);
  };

  const resetConversationView = () => {
    setInstruction("");
    setPlan(null);
    setCalls([]);
    setRun(null);
    setAssistantReply("");
    setExecutionDetailsOpen(false);
    setPreviewMedia(null);
    setSelectedTemplate(null);
    setTemplatePickerOpen(false);
    notifiedCanvasStepsRef.current = new Set();
  };

  const startNewConversation = async () => {
    if (planning || actionBusy) return;
    try {
      if (conversationHydratedRef.current && sessionId) await persistCurrentConversation();
      conversationHydratedRef.current = false;
      resetConversationView();
      await createConversation({ title: t("新对话", "New conversation") });
      setHistoryOpen(false);
    } catch (error) {
      toast.error(error.response?.data?.message || t("新建对话失败", "Unable to create conversation"));
    }
  };

  const selectConversation = async (conversationId) => {
    if (!conversationId || conversationId === sessionId || planning || actionBusy) {
      setHistoryOpen(false);
      return;
    }
    try {
      if (conversationHydratedRef.current && sessionId) await persistCurrentConversation();
      conversationHydratedRef.current = false;
      await openConversation(conversationId);
      setHistoryOpen(false);
    } catch (error) {
      toast.error(error.response?.data?.message || t("对话记录加载失败", "Unable to load conversation"));
    }
  };

  const removeConversation = async (conversationId) => {
    if (!conversationId || deletingConversationId || (conversationId === sessionId && executionActive)) return;
    const confirmed = window.confirm(t("删除这条对话？对话会从列表中移除。", "Delete this conversation? It will be removed from the list."));
    if (!confirmed) return;
    setDeletingConversationId(conversationId);
    try {
      await deleteConversation(conversationId);
      toast.success(t("对话已删除", "Conversation deleted"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("删除对话失败", "Unable to delete conversation"));
    } finally {
      setDeletingConversationId("");
    }
  };

  const statusIcon = (status) => {
    if (status === "running") return <LoaderCircle size={16} className="animate-spin" style={{ color: ui.primary }} />;
    if (status === "waiting_approval") return <ShieldCheck size={16} style={{ color: ui.primary }} />;
    if (status === "waiting_client") return <MonitorPlay size={16} style={{ color: ui.primary }} />;
    if (status === "completed") return <CheckCircle2 size={16} style={{ color: "#4ade80" }} />;
    if (["failed", "cancelled", "stopped"].includes(status)) return <XCircle size={16} style={{ color: ui.danger }} />;
    return <Terminal size={16} style={{ color: ui.faint }} />;
  };

  const phaseIndex = {
    idle: -1,
    think: 0,
    queue: 0,
    approval: 1,
    client: 1,
    tool: 1,
    observe: 2,
    done: 2,
    failed: 2,
  }[executionView.phase] ?? -1;
  const liveDescription = executionView.description || ({
    think: t("正在结合当前页面和已有结果确定下一项操作。", "Considering the current page and previous results."),
    queue: t("操作已进入后台队列，正在等待 Worker 接管。", "The operation is queued for the background worker."),
    tool: t("服务端正在调用工具，完成后会自动读取结果。", "The server is calling the tool and will read its result automatically."),
    observe: t("已收到工具结果，正在判断任务是否完成或需要继续。", "The tool result is available and Agent is deciding what comes next."),
    approval: t("此操作需要你的明确确认，确认后从当前步骤继续。", "This operation needs your approval before continuing."),
    client: t("此步骤需要在当前浏览器中完成。", "This step needs to run in this browser."),
    done: t("所有已规划步骤均已完成。", "All planned steps are complete."),
    failed: t("执行已停止，已完成步骤的结果仍保留在下方。", "Execution stopped. Results from completed steps remain below."),
  }[executionView.phase] || "");
  const reactivePhases = [
    { key: "think", label: t("思考", "Think"), Icon: BrainCircuit },
    { key: "tool", label: t("调用工具", "Act"), Icon: Wrench },
    { key: "observe", label: t("观察结果", "Observe"), Icon: Eye },
  ];
  const completedMedia = completedMediaFromCalls(calls);
  const activeCallId = executionView.call ? String(executionView.call.id || executionView.call.callId) : "";
  const callStack = [...calls]
    .map((call, index) => ({ call, index }))
    .sort((left, right) => {
      const rank = (item) => {
        const call = item.call;
        const id = String(call.id || call.callId || "");
        if (id && id === activeCallId) return 0;
        if (["running", "queued", "waiting_approval", "waiting_client", "processing"].includes(String(call.status || "").toLowerCase())) return 0;
        if (["completed", "succeeded", "success", "failed", "cancelled"].includes(String(call.status || "").toLowerCase())) return 1;
        return 2;
      };
      return rank(left) - rank(right) || left.index - right.index;
    });
  useEffect(() => {
    setFocusedCallId("");
  }, [activeCallId]);
  const homeReply = !home || (!assistantReply && !planning && !actionBusy && !plan && !run)
    ? ""
    : !run?.id && assistantReply
      ? assistantReply
      : run?.status === "failed" || run?.status === "cancelled"
        ? run.status === "cancelled" ? t("任务已取消。", "The task was cancelled.") : getGenerationErrorMessage(run.error, t)
        : ["completed", "succeeded", "success"].includes(String(run?.status || "").toLowerCase())
          ? assistantReply || run?.finalResponse || (completedMedia.length
            ? t(`已经生成完成，${completedMedia.length > 1 ? `下面是 ${completedMedia.length} 个作品` : "作品在下面，可以直接查看或播放"}。`, `Generation is complete. ${completedMedia.length > 1 ? `${completedMedia.length} creations are shown below` : "You can view or play the result below"}.`)
            : run?.summary || t("已经处理完成，结果如下。", "Done. Here is the result."))
          : activeRun
            ? t(`我正在${executionView.toolKey ? getAgentToolLabel(executionView.call || { toolKey: executionView.toolKey }, executionLanguage) : "处理你的要求"}，完成后会直接把结果放在这里。`, `I'm ${executionView.toolKey ? getAgentToolLabel(executionView.call || { toolKey: executionView.toolKey }, executionLanguage).toLowerCase() : "working on your request"}. The result will appear here when it is ready.`)
            : planning
              ? t("我正在理解你的要求，马上开始。", "I'm understanding your request and will start shortly.")
              : assistantReply || plan?.response || t("我已经准备好执行，确认后会继续。", "I'm ready to proceed after confirmation.");

  const conversationHistory = historyOpen && <div
    className={home ? "global-agent-home-history-popover" : "absolute left-3 right-3 top-14 z-30 max-h-72 overflow-y-auto rounded-xl p-2"}
    style={{ background: ui.surface, border: `1px solid ${ui.lineStrong}`, boxShadow: ui.shadow }}
  >
    <div className="global-agent-history-heading">
      <span style={{ color: ui.faint }}>{t("历史对话", "History")}</span>
      <button type="button" onClick={startNewConversation} disabled={planning || actionBusy || conversationLoading} style={{ color: ui.primary }}>
        <MessageSquarePlus size={13} />{t("新建", "New")}
      </button>
    </div>
    <div className="global-agent-history-list">
      {conversations.length === 0 ? <p className="global-agent-history-empty" style={{ color: ui.faint }}>{t("暂无历史对话", "No conversation history")}</p> : conversations.map((conversation) => {
        const isActiveConversation = conversation.id === sessionId;
        const deleteDisabled = Boolean(deletingConversationId || (isActiveConversation && executionActive));
        return <div
          key={conversation.id}
          className="global-agent-history-item"
          style={{ background: isActiveConversation ? ui.primarySoft : ui.surfaceAlt, border: `1px solid ${isActiveConversation ? ui.primary : ui.line}` }}
        >
          <button type="button" onClick={() => void selectConversation(conversation.id)} className="global-agent-history-select">
            <span style={{ color: ui.text }}>{conversation.title || t("新对话", "New conversation")}</span>
            <small style={{ color: ui.faint }}>
              {new Date(conversation.updated_at || conversation.created_at).toLocaleString(executionLanguage === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </small>
          </button>
          <button
            type="button"
            className="global-agent-history-delete"
            disabled={deleteDisabled}
            onClick={() => void removeConversation(conversation.id)}
            aria-label={t("删除对话", "Delete conversation")}
            title={isActiveConversation && executionActive ? t("任务执行期间不能删除当前对话", "The active conversation cannot be deleted while a task is running") : t("删除对话", "Delete conversation")}
            style={{ color: ui.faint }}
          >{deletingConversationId === conversation.id ? <LoaderCircle size={14} className="animate-spin" /> : <Trash2 size={14} />}</button>
        </div>;
      })}
    </div>
  </div>;

  const isReferenceDrag = (event) => Array.from(event.dataTransfer?.types || []).includes(REFERENCE_DRAG_MIME);
  const isLocalFileDrag = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const isSupportedReferenceDrag = (event) => isReferenceDrag(event) || isLocalFileDrag(event);
  const mergeReferenceAssets = useCallback((current, incoming) => {
    const merged = [];
    const seen = new Set();
    for (const reference of [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [incoming])]) {
      if (!reference?.previewUrl) continue;
      const identity = String(reference.id || reference.uploadId || reference.creationId || reference.templateId || reference.previewUrl);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      merged.push(reference);
      if (merged.length === 4) break;
    }
    return merged;
  }, []);
  const appendReferenceAssets = useCallback((incoming) => {
    if (onReferenceAssetsChange) {
      onReferenceAssetsChange((current) => mergeReferenceAssets(current, incoming));
      return;
    }
    const next = mergeReferenceAssets(normalizedReferenceAssets, incoming);
    onReferenceAssetChange?.(next[0] || null);
  }, [mergeReferenceAssets, normalizedReferenceAssets, onReferenceAssetChange, onReferenceAssetsChange]);
  const removeReferenceAsset = useCallback((identity) => {
    const remove = (current) => (Array.isArray(current) ? current : []).filter((reference) => (
      String(reference?.id || reference?.uploadId || reference?.creationId || reference?.templateId || reference?.previewUrl) !== identity
    ));
    if (onReferenceAssetsChange) {
      onReferenceAssetsChange(remove);
      return;
    }
    const next = remove(normalizedReferenceAssets);
    onReferenceAssetChange?.(next[0] || null);
  }, [normalizedReferenceAssets, onReferenceAssetChange, onReferenceAssetsChange]);
  const uploadLocalReferences = async (files) => {
    if (!home || referenceUploading || activeRun) return;
    const selectedFiles = Array.from(files || []);
    if (!selectedFiles.length) return;
    const imageFiles = selectedFiles.filter((file) => getCanvasAssetType(file) === "image");
    if (imageFiles.length !== selectedFiles.length) {
      toast.error(t("请选择 JPG、PNG、WebP、GIF、BMP、HEIC 或 AVIF 图片", "Choose a JPG, PNG, WebP, GIF, BMP, HEIC, or AVIF image"));
    }
    const validFiles = imageFiles.filter((file) => !isOversizedReferenceImage(file));
    if (validFiles.length !== imageFiles.length) {
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
    }
    const remaining = Math.max(0, 4 - normalizedReferenceAssets.length);
    if (remaining === 0) {
      toast.error(t("最多可添加 4 张参考图", "You can attach up to four reference images."));
      return;
    }
    const filesToUpload = validFiles.slice(0, remaining);
    if (validFiles.length > filesToUpload.length) toast(t("最多添加 4 张参考图，已忽略多余图片", "Only four reference images can be attached; extras were skipped."));
    if (!filesToUpload.length) return;
    setReferenceUploading(true);
    setTemplatePickerOpen(false);
    setAgentSettingsOpen(false);
    let addedCount = 0;
    try {
      for (const file of filesToUpload) {
        const uploaded = await uploadCanvasAsset({
          client: authAxios,
          file,
          idempotencyKey: idempotencyKey("global-agent-reference"),
        });
        if (!uploaded.resourceId) throw new Error(t("参考图上传记录无效", "The uploaded reference record is invalid"));
        appendReferenceAssets({
          id: `upload-${uploaded.resourceId}`,
          title: getAgentReferenceTitle(uploaded.title || file.name || t("本地参考图", "Local reference")),
          previewUrl: uploaded.src,
          uploadId: uploaded.resourceId,
        });
        addedCount += 1;
      }
      toast.success(t(`已添加 ${addedCount} 张参考图`, `${addedCount} reference image${addedCount === 1 ? "" : "s"} added`));
    } catch (error) {
      toast.error(addedCount > 0
        ? t(`已添加 ${addedCount} 张，其他图片上传失败`, `${addedCount} added; the remaining images failed to upload`)
        : error.response?.data?.message || error.message || t("参考图上传失败", "Unable to upload reference image"));
    } finally {
      setReferenceUploading(false);
      if (referenceFileInputRef.current) referenceFileInputRef.current.value = "";
    }
  };
  const handleReferenceDragEnter = (event) => {
    if (!home || activeRun || !isSupportedReferenceDrag(event)) return;
    event.preventDefault();
    referenceDragDepthRef.current += 1;
    setReferenceDropActive(true);
  };
  const handleReferenceDragOver = (event) => {
    if (!home || activeRun || !isSupportedReferenceDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const handleReferenceDragLeave = (event) => {
    if (!home || !isSupportedReferenceDrag(event)) return;
    event.preventDefault();
    referenceDragDepthRef.current = Math.max(0, referenceDragDepthRef.current - 1);
    if (referenceDragDepthRef.current === 0) setReferenceDropActive(false);
  };
  const handleReferenceDrop = (event) => {
    if (!home || activeRun || !isSupportedReferenceDrag(event)) return;
    event.preventDefault();
    referenceDragDepthRef.current = 0;
    setReferenceDropActive(false);
    const localFiles = Array.from(event.dataTransfer?.files || []);
    if (localFiles.length > 0) {
      void uploadLocalReferences(localFiles);
      return;
    }
    if (isLocalFileDrag(event)) {
      toast.error(t("拖入的文件不是支持的图片格式", "The dropped file is not a supported image"));
      return;
    }
    const reference = parseReferenceDragPayload(event.dataTransfer.getData(REFERENCE_DRAG_MIME));
    if (reference) {
      if (onReferenceDrop) onReferenceDrop(reference);
      else appendReferenceAssets(reference);
    }
  };

  return (
    <main className={embedded ? "h-full min-h-0 overflow-y-auto px-4 pb-6 pt-4" : home ? "global-agent-home-runtime" : "mx-auto max-w-6xl p-5 md:p-8"}>
      {!embedded && <div className={home ? "global-agent-home-intro" : "mb-8 flex flex-wrap items-end justify-between gap-4"}>
        <div><p className="text-[10px] font-black uppercase tracking-[.24em]" style={{ color: ui.primary }}>StarDraw Agent</p><h1 className="mt-2 text-3xl font-black" style={{ color: ui.text }}>{home ? t("开启你的 Agent 模式", "Start in Agent mode") : t("全局 Agent", "Global Agent")}</h1><p className="mt-2 text-sm" style={{ color: ui.muted }}>{home ? t("说出目标，Agent 会理解上下文、调用工具并逐步完成。", "Describe the outcome. Agent understands context, calls tools, and works through it step by step.") : t("把画布、模板、工作流和生成任务交给一个可审计的执行助手。", "Plan and run canvas, template, workflow, and generation tasks through one audited assistant.")}</p></div>
        {!home && <div className="flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}><ShieldCheck size={16} /> GPT</div>}
      </div>}
      <section
        className={`relative rounded-2xl ${home ? `global-agent-home-composer ${floating ? "is-docked" : ""} ${floating && !dockExpanded ? "is-collapsed" : "is-expanded"} ${referenceDropActive ? "is-reference-drop-target" : ""}` : ""} ${embedded ? "p-3" : "p-4 md:p-6"}`}
        style={{ background: ui.surface, border: `1px solid ${referenceDropActive ? ui.primary : ui.line}`, boxShadow: embedded ? "none" : ui.shadow }}
        onDragEnter={handleReferenceDragEnter}
        onDragOver={handleReferenceDragOver}
        onDragLeave={handleReferenceDragLeave}
        onDrop={handleReferenceDrop}
      >
        {home && floating && !dockExpanded && <button
          type="button"
          className="global-agent-home-dock-trigger"
          onClick={() => onDockExpandedChange?.(true)}
          style={{ color: ui.text }}
          aria-label={t("展开 Agent", "Open Agent")}
          title={t("展开 Agent", "Open Agent")}
        >
          <span className="global-agent-home-dock-mark" style={{ background: ui.primarySoft, color: ui.primary }}><Sparkles size={14} /></span>
          <span className="global-agent-home-dock-copy"><strong>{t("继续创作", "Continue creating")}</strong><small>{t("让 Agent 帮你完成下一步", "Ask Agent for the next step")}</small></span>
          <ArrowUp size={15} style={{ color: ui.primary }} />
        </button>}
        <div className={`mb-3 flex items-center justify-between gap-2 ${home ? "global-agent-home-conversation" : ""}`}>
          <div className="min-w-0">
            <p className="truncate text-xs font-black" style={{ color: ui.text }}>
              {activeConversation?.title || t("新对话", "New conversation")}
            </p>
            <p className="mt-0.5 text-[10px] font-bold" style={{ color: ui.faint }}>
              {conversationLoading ? t("正在加载对话", "Loading conversation") : t(`${conversations.length} 条历史对话`, `${conversations.length} conversations`)}
            </p>
          </div>
          {home && <div className="global-agent-home-header-actions">
            <div className="global-agent-history-anchor">
              <button
                type="button"
                onClick={() => setHistoryOpen((current) => !current)}
                className={historyOpen ? "is-active" : ""}
                style={{ color: historyOpen ? ui.primary : ui.muted, background: historyOpen ? ui.primarySoft : ui.surfaceAlt, borderColor: historyOpen ? ui.primary : ui.line }}
                title={t("历史对话", "Conversation history")}
                aria-expanded={historyOpen}
              ><History size={15} /></button>
              {conversationHistory}
            </div>
            <button
              type="button"
              disabled={planning || actionBusy || conversationLoading}
              onClick={startNewConversation}
              style={{ color: ui.primary, background: ui.primarySoft, borderColor: ui.line }}
              title={t("新建对话", "New conversation")}
              aria-label={t("新建对话", "New conversation")}
            ><MessageSquarePlus size={15} /></button>
          </div>}
          {!home && <div className="flex flex-none items-center gap-1">
            <button
              type="button"
              onClick={() => setHistoryOpen((current) => !current)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full"
              style={{ color: historyOpen ? ui.primary : ui.muted, background: historyOpen ? ui.primarySoft : ui.surfaceAlt, border: `1px solid ${historyOpen ? ui.primary : ui.line}` }}
              title={t("历史对话", "Conversation history")}
              aria-expanded={historyOpen}
            ><History size={16} /></button>
            <button
              type="button"
              disabled={planning || actionBusy || conversationLoading}
              onClick={startNewConversation}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full disabled:opacity-40"
              style={{ color: ui.primary, background: ui.primarySoft, border: `1px solid ${ui.line}` }}
              title={t("新建对话", "New conversation")}
            ><MessageSquarePlus size={16} /></button>
          </div>}
        </div>
        {!home && conversationHistory}
        {home ? <>
          <textarea
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitHomeRequest();
              }
            }}
            rows={5}
            maxLength={2400}
            placeholder={t("输入想法、脚本或目标。你也可以让 Agent 调用模板、生成内容、管理资产或完成一组连续操作。", "Enter an idea, script, or outcome. Agent can use templates, generate content, manage assets, and complete multi-step work.")}
            className="global-agent-home-input"
            style={{ color: ui.text }}
          />
          {normalizedReferenceAssets.length > 0 && <div className="global-agent-home-references" style={{ background: ui.surfaceAlt, borderColor: ui.line }}>
            <div className="global-agent-home-reference-heading" style={{ color: ui.primary }}><ImagePlus size={12} />{t(`已附加 ${normalizedReferenceAssets.length}/4 张参考图`, `${normalizedReferenceAssets.length}/4 references attached`)}</div>
            <div className="global-agent-home-reference-list">
              {normalizedReferenceAssets.map((reference) => {
                const identity = String(reference.id || reference.uploadId || reference.creationId || reference.templateId || reference.previewUrl);
                return <div key={identity} className="global-agent-home-reference" title={reference.title || t("参考图", "Reference image")}>
                  <OssImage src={reference.previewUrl} authorize={Boolean(reference.uploadId)} alt="" />
                  <button type="button" onClick={() => removeReferenceAsset(identity)} aria-label={t("移除参考图", "Remove reference")} title={t("移除参考图", "Remove reference")} style={{ color: ui.muted }}><X size={12} /></button>
                </div>;
              })}
            </div>
          </div>}
          <div className="global-agent-home-controls">
            <div className="global-agent-home-control-group">
              <input
                ref={referenceFileInputRef}
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp,image/gif,image/bmp,image/heic,image/heif,image/avif"
                className="global-agent-reference-file-input"
                onChange={(event) => void uploadLocalReferences(event.target.files)}
              />
              {floating && dockExpanded && <button
                type="button"
                className="global-agent-home-dock-minimize"
                onClick={() => onDockExpandedChange?.(false)}
                style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.muted }}
                title={t("收起 Agent", "Minimize Agent")}
                aria-label={t("收起 Agent", "Minimize Agent")}
              ><ChevronDown size={14} /></button>}
              <button
                type="button"
                className="global-agent-home-pill global-agent-reference-upload-trigger"
                disabled={referenceUploading || activeRun}
                onClick={() => referenceFileInputRef.current?.click()}
                style={{ background: normalizedReferenceAssets.length ? ui.primarySoft : ui.surfaceAlt, borderColor: normalizedReferenceAssets.length ? ui.primary : ui.line, color: normalizedReferenceAssets.length ? ui.primary : ui.muted }}
                title={t("上传本地图片作为生成参考", "Upload a local image as a generation reference")}
                aria-label={t("上传参考图", "Upload reference image")}
              >{referenceUploading ? <LoaderCircle size={13} className="animate-spin" /> : <ImagePlus size={13} />}{referenceUploading ? t("上传中", "Uploading") : t(`参考图 ${normalizedReferenceAssets.length}/4`, `References ${normalizedReferenceAssets.length}/4`)}</button>
              <button
                type="button"
                className="global-agent-home-settings-trigger"
                disabled={settingsDisabled}
                style={{ background: agentSettingsOpen ? ui.primarySoft : ui.surfaceAlt, borderColor: agentSettingsOpen ? ui.primary : ui.line, color: agentSettingsOpen ? ui.primary : ui.muted }}
                onClick={() => { setAgentSettingsOpen((current) => !current); setTemplatePickerOpen(false); }}
                title={t("Agent 设置：权限、模型与生成参数", "Agent settings: permissions, models, and generation parameters")}
                aria-expanded={agentSettingsOpen}
              ><Settings2 size={13} />{t("设置", "Settings")}</button>
              <span className="global-agent-home-pill" style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.muted }} title={t("当前 Agent 操作权限", "Current Agent permission mode")}><ShieldCheck size={13} />{selectedModeLabel ? t(selectedModeLabel.zh, selectedModeLabel.en) : t("自动", "Auto")}</span>
              <span className="global-agent-home-pill" style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.muted }} title={t("当前对话模型：可在设置中切换", "Conversation model: change it in settings")}><Sparkles size={13} />{modelDisplayName(getModelByKey(modelCatalogs.agent, agentPreferences.agentModel), "GPT")}</span>
              <span className="global-agent-home-pill" style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.muted }} title={t("可调用平台工具与已授权 MCP", "Can call platform tools and authorized MCP tools")}><Wrench size={13} />{t("工具已就绪", "Tools ready")}</span>
              <button
                type="button"
                className="global-agent-home-pill global-agent-template-trigger"
                style={{ background: selectedTemplate ? ui.primarySoft : ui.surfaceAlt, borderColor: selectedTemplate ? ui.primary : ui.line, color: selectedTemplate ? ui.primary : ui.muted }}
                onClick={() => { setTemplatePickerOpen((current) => !current); setAgentSettingsOpen(false); }}
                title={t("选择模板", "Choose a template")}
                aria-expanded={templatePickerOpen}
              ><LayoutTemplate size={13} />{selectedTemplate ? selectedTemplate.title : t("模板", "Template")}</button>
            </div>
            <button
              type="button"
              disabled={conversationLoading || !sessionId || !instruction.trim() || planning || actionBusy || activeRun || referenceUploading}
              onClick={submitHomeRequest}
              className="global-agent-home-submit"
              style={{ background: ui.primary, color: ui.primaryText }}
              aria-label={planning || actionBusy ? t("Agent 正在启动", "Agent is starting") : t("发送并执行", "Send and run")}
              title={planning || actionBusy ? t("Agent 正在启动", "Agent is starting") : t("发送并执行", "Send and run")}
            >
              {planning || actionBusy ? <LoaderCircle size={18} className="animate-spin" /> : <ArrowUp size={18} strokeWidth={2.6} />}
            </button>
          </div>
          {agentSettingsOpen && <div className="global-agent-settings-popover" style={{ background: ui.surface, borderColor: ui.lineStrong, boxShadow: ui.shadow }}>
            <div className="global-agent-settings-header">
              <div>
                <strong style={{ color: ui.text }}>{t("Agent 设置", "Agent settings")}</strong>
                <small style={{ color: ui.faint }}>{t("默认自动选择，也可以为本次对话指定模型和输出参数。", "Auto is the default. You can override models and output parameters for this conversation.")}</small>
              </div>
              <button type="button" onClick={() => setAgentSettingsOpen(false)} aria-label={t("关闭 Agent 设置", "Close Agent settings")} title={t("关闭", "Close")}><X size={15} /></button>
            </div>
            <div className="global-agent-settings-grid">
              <label className="global-agent-settings-field">
                <span><ShieldCheck size={14} />{t("执行权限", "Execution permission")}</span>
                <CanvasRoundedSelect label={t("执行权限", "Execution permission")} value={mode} options={MODES.map((item) => ({ value: item.key, label: t(item.zh, item.en) }))} onChange={setMode} disabled={settingsDisabled} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={230} />
              </label>
              <label className="global-agent-settings-field">
                <span><Sparkles size={14} />{t("Agent 模型", "Agent model")}</span>
                <CanvasRoundedSelect label={t("Agent 模型", "Agent model")} value={agentPreferences.agentModel} options={[{ value: "", label: autoOptionLabel(t) }, ...modelCatalogs.agent.map((model) => ({ value: model.model_key, label: modelDisplayName(model) }))]} disabled={settingsDisabled || modelCatalogLoading} onChange={(value) => updateAgentPreferences({ agentModel: value })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={260} />
              </label>
              <label className="global-agent-settings-field">
                <span><ImageIcon size={14} />{t("图片模型", "Image model")}</span>
                <CanvasRoundedSelect label={t("图片模型", "Image model")} value={agentPreferences.imageModel} options={[{ value: "", label: autoOptionLabel(t) }, ...modelCatalogs.image.map((model) => ({ value: model.model_key, label: modelDisplayName(model, model.model_key) }))]} disabled={settingsDisabled || modelCatalogLoading} onChange={(value) => updateAgentPreferences({ imageModel: value, imageSize: "" })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={260} />
              </label>
              <label className="global-agent-settings-field">
                <span><Film size={14} />{t("视频模型", "Video model")}</span>
                <CanvasRoundedSelect label={t("视频模型", "Video model")} value={agentPreferences.videoModel} options={[{ value: "", label: autoOptionLabel(t) }, ...modelCatalogs.video.map((model) => ({ value: model.model_key, label: modelDisplayName(model, model.model_key) }))]} disabled={settingsDisabled || modelCatalogLoading} onChange={(value) => updateAgentPreferences({ videoModel: value, videoSize: "", videoSeconds: "" })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={260} />
              </label>
              <label className="global-agent-settings-field">
                <span><ImageIcon size={14} />{t("图片输出尺寸", "Image output size")}</span>
                <CanvasRoundedSelect label={t("图片输出尺寸", "Image output size")} value={agentPreferences.imageSize} options={[{ value: "", label: autoOptionLabel(t) }, ...imageSizeOptions]} disabled={settingsDisabled} onChange={(value) => updateAgentPreferences({ imageSize: value })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={220} />
              </label>
              <label className="global-agent-settings-field">
                <span><Film size={14} />{t("视频输出尺寸", "Video output size")}</span>
                <CanvasRoundedSelect label={t("视频输出尺寸", "Video output size")} value={agentPreferences.videoSize} options={[{ value: "", label: autoOptionLabel(t) }, ...videoSizeOptions]} disabled={settingsDisabled} onChange={(value) => updateAgentPreferences({ videoSize: value })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={220} />
              </label>
              <label className="global-agent-settings-field">
                <span><Film size={14} />{t("视频时长", "Video duration")}</span>
                <CanvasRoundedSelect label={t("视频时长", "Video duration")} value={agentPreferences.videoSeconds} options={[{ value: "", label: autoOptionLabel(t) }, ...videoDurationOptions.map((seconds) => ({ value: String(seconds), label: `${seconds}${t(" 秒", "s")}` }))]} disabled={settingsDisabled} onChange={(value) => updateAgentPreferences({ videoSeconds: value })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={180} />
              </label>
              <label className="global-agent-settings-field">
                <span><BrainCircuit size={14} />{t("思考强度", "Reasoning")}</span>
                <CanvasRoundedSelect label={t("思考强度", "Reasoning")} value={agentPreferences.reasoningEffort} options={[{ value: "", label: autoOptionLabel(t) }, { value: "low", label: t("低", "Low") }, { value: "medium", label: t("中", "Medium") }, { value: "high", label: t("高", "High") }]} disabled={settingsDisabled} onChange={(value) => updateAgentPreferences({ reasoningEffort: value })} ui={ui} className="w-full" triggerClassName="w-full" menuMinWidth={180} />
              </label>
            </div>
            <div className="global-agent-settings-footer" style={{ color: ui.faint }}>
              <span>{modelCatalogLoading ? t("正在读取当前会员可用模型…", "Loading models available to this account…") : accountPreferencesLoaded ? t("设置已记忆到当前账号，并会应用到新对话和其他设备。", "Settings are saved to your account and apply to new conversations and other devices.") : t("正在读取账号设置…", "Loading account settings…")}</span>
              <button type="button" onClick={() => setAgentSettingsOpen(false)} style={{ color: ui.primary }}>{t("完成", "Done")}</button>
            </div>
          </div>}
          {templatePickerOpen && <div className="global-agent-template-picker" style={{ background: ui.surface, borderColor: ui.lineStrong, boxShadow: ui.shadow }}>
            <div className="global-agent-template-picker-header">
              <div><strong>{t("选择一个模板", "Choose a template")}</strong><small>{t("选择后会把模板上下文交给 Agent 继续理解", "Agent will use the selected template as context")}</small></div>
              <button type="button" onClick={() => setTemplatePickerOpen(false)} aria-label={t("关闭模板选择", "Close template picker")} title={t("关闭", "Close")}><X size={15} /></button>
            </div>
            <label className="global-agent-template-search" style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.faint }}>
              <Search size={14} />
              <input value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder={t("搜索模板、分类或关键词", "Search templates, categories, or keywords")} />
            </label>
            <div className="global-agent-template-list">
              {templateLoading && <p className="global-agent-template-empty" style={{ color: ui.faint }}>{t("正在加载模板…", "Loading templates…")}</p>}
              {!templateLoading && !filteredTemplates.length && <p className="global-agent-template-empty" style={{ color: ui.faint }}>{t("没有匹配的模板", "No matching templates")}</p>}
              {!templateLoading && filteredTemplates.map((template) => <button
                type="button"
                key={template.id}
                className="global-agent-template-option"
                style={{ background: selectedTemplate?.id === template.id ? ui.primarySoft : ui.surfaceAlt, borderColor: selectedTemplate?.id === template.id ? ui.primary : ui.line }}
                onClick={() => chooseTemplate(template)}
              >
                <span className="global-agent-template-preview" style={{ background: ui.surfaceHigh }}>
                  {template.preview ? <img src={template.preview} alt="" /> : <LayoutTemplate size={15} style={{ color: ui.faint }} />}
                </span>
                <span className="global-agent-template-option-copy"><strong style={{ color: ui.text }}>{template.title}</strong><small style={{ color: ui.faint }}>{template.tags?.slice(0, 2).join(" · ") || template.sceneKey || t("官方模板", "Featured template")}</small></span>
              </button>)}
            </div>
          </div>}
        </> : <>
          <div className={embedded ? "mb-3 grid grid-cols-3 gap-1.5" : "mb-4 flex flex-wrap gap-2"}>{MODES.map((item) => <button key={item.key} type="button" disabled={Boolean(run?.id)} onClick={() => setMode(item.key)} className="min-w-0 rounded-xl px-2 py-2 text-[11px] font-black leading-4 disabled:opacity-50" style={{ background: mode === item.key ? ui.primarySoft : ui.surfaceAlt, color: mode === item.key ? ui.primary : ui.muted, border: `1px solid ${mode === item.key ? ui.primary : ui.line}` }}>{t(item.zh, item.en)}</button>)}</div>
          <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") planRequest(); }} rows={embedded ? 4 : 5} placeholder={t("例如：用一个商品模板生成一张 16:9 主图，放进我的工作流并准备三条分镜。", "Example: use a product template to create a 16:9 hero image, add it to my workflow, and prepare three storyboard shots.")} className="w-full resize-y rounded-xl p-4 text-sm leading-6 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <div className="mt-3 flex justify-end"><button type="button" disabled={conversationLoading || !sessionId || !instruction.trim() || planning || activeRun} onClick={planRequest} className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primary, color: ui.primaryText }}><Sparkles size={17} />{planning ? t("规划中…", "Planning…") : t("生成执行计划", "Plan task")}</button></div>
        </>}
      </section>
      {homeReply && <section className="global-agent-home-reply" style={{ background: ui.surface, borderColor: ui.line }}>
        <span className="global-agent-home-reply-mark" style={{ background: ui.primarySoft, color: ui.primary }}><Sparkles size={15} /></span>
        <div className="global-agent-home-reply-body">
          <p className="global-agent-home-reply-label" style={{ color: ui.faint }}>GPT</p>
          <p className="global-agent-home-reply-text" style={{ color: ui.text }}>{cleanAgentReply(homeReply)}</p>
          {completedMedia.length > 0 && <div className="global-agent-home-reply-media">
            {completedMedia.map((media) => <button
              type="button"
              key={media.id}
              className="global-agent-home-media-card"
              onClick={() => setPreviewMedia(media)}
              title={t("打开作品预览", "Open creation preview")}
              aria-label={t("打开作品预览", "Open creation preview")}
              style={{ background: ui.surfaceAlt, borderColor: ui.line }}
            >
              {media.type === "video"
                ? <OssVideo src={media.content} poster={media.thumbnail_url || undefined} muted playsInline preload="metadata" />
                : <OssImage src={media.content} alt={media.scene_name || t("Agent 生成的图片", "Image generated by Agent")} />}
              <span style={{ background: ui.overlay, color: ui.text }}>{media.type === "video" ? <Film size={13} /> : <ImageIcon size={13} />}{t("点击预览", "Preview")}</span>
            </button>)}
          </div>}
          {homeRunStarted && !executionActive && <button
            type="button"
            className="global-agent-home-details-toggle"
            onClick={() => setExecutionDetailsOpen((current) => !current)}
            style={{ color: ui.muted, borderColor: ui.line, background: ui.surfaceAlt }}
            aria-expanded={executionDetailsOpen}
          ><Eye size={13} />{executionDetailsOpen ? t("收起执行详情", "Hide execution details") : t("查看执行详情", "View execution details")}<ChevronDown size={13} className={executionDetailsOpen ? "is-open" : ""} /></button>}
        </div>
      </section>}
      {previewMedia && <AssetPreviewModal item={previewMedia} onClose={() => setPreviewMedia(null)} ui={ui} />}
      {showExecutionDetails && <div className={home ? "global-agent-home-execution-rail" : "global-agent-execution-contents"}>
        {home && homeRunStarted && <aside className="global-agent-home-side-tools has-run" style={{ background: ui.surface, borderColor: ui.line, boxShadow: ui.shadow }}>
          <div>
            <p style={{ color: ui.faint }}>{t("执行摘要", "Execution")}</p>
            <strong style={{ color: ui.text }}>{executionActive ? executionView.title : t("本次执行已结束", "Execution finished")}</strong>
          </div>
        </aside>}
      {showLiveOperation && <section
        ref={liveOperationRef}
        className={`agent-live-operation mt-4 overflow-hidden rounded-xl p-4 ${executionView.active ? "is-active" : ""} ${embedded ? "sticky top-2 z-10" : ""}`}
        style={{
          background: ui.surface,
          border: `1px solid ${executionView.active ? ui.primary : ui.lineStrong}`,
          boxShadow: executionView.active ? `0 10px 34px ${ui.primarySoft}` : ui.shadow,
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className={`agent-live-operation-icon flex h-10 w-10 flex-none items-center justify-center rounded-2xl ${executionView.active ? "is-active" : ""}`}
            style={{ background: ui.primarySoft, color: ui.primary }}
          >
            {executionView.phase === "observe"
              ? <Eye size={19} />
              : executionView.phase === "approval"
                ? <ShieldCheck size={19} />
                : executionView.phase === "tool"
                  ? <Wrench size={19} />
                  : <BrainCircuit size={19} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-black uppercase" style={{ color: executionView.active ? ui.primary : ui.faint }}>
                {executionView.active ? t("实时操作", "Live operation") : t("执行结果", "Execution result")}
              </span>
              {executionView.active && <span className="agent-live-dot" style={{ background: ui.primary, color: ui.primary }} aria-hidden="true" />}
              {executionView.stepNumber > 0 && <span className="text-[10px] font-bold" style={{ color: ui.faint }}>
                {t(`第 ${executionView.stepNumber} 步`, `Step ${executionView.stepNumber}`)}
              </span>}
            </div>
            <p className="mt-1 break-words text-sm font-black leading-5" style={{ color: ui.text }}>{executionView.title}</p>
            <p className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>{liveDescription}</p>
            {executionView.toolKey && <code className="mt-2 block truncate text-[10px]" style={{ color: ui.faint }}>{executionView.toolKey}</code>}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-1.5">
          {reactivePhases.map(({ key, label, ...phase }, index) => {
            const current = index === phaseIndex;
            const completed = index < phaseIndex || executionView.phase === "done";
            return <div
              key={key}
              className={`agent-live-phase flex min-w-0 items-center justify-center gap-1.5 rounded-full px-2 py-2 ${current ? "is-current" : ""}`}
              style={{
                background: current ? ui.primarySoft : ui.surfaceAlt,
                color: current || completed ? ui.primary : ui.faint,
                border: `1px solid ${current ? ui.primary : ui.line}`,
              }}
            >
              {completed && !current ? <CheckCircle2 size={13} /> : createElement(phase.Icon, { size: 13 })}
              <span className="truncate text-[10px] font-black">{label}</span>
            </div>;
          })}
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: ui.surfaceAlt }}>
          <div
            className={`agent-live-progress h-full rounded-full ${executionView.active ? "is-active" : ""}`}
            style={{
              background: ui.primary,
              width: `${executionView.progress || (executionView.active ? Math.max(8, (phaseIndex + 1) * 24) : 0)}%`,
            }}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[10px] font-bold" style={{ color: taskStream.connectionState === "live" ? ui.primary : ui.faint }}>
            {taskStream.connectionState === "live" ? t("实时同步中", "Live sync") : taskStream.connectionState === "polling" ? t("轮询同步中", "Polling") : t("正在连接", "Connecting")}
          </span>
          {executionView.phase === "approval" && executionView.call && <button
            type="button"
            disabled={actionBusy}
            onClick={() => approveStep(executionView.call)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-black disabled:opacity-50"
            style={{ background: ui.primary, color: ui.primaryText }}
          ><ShieldCheck size={14} />{t("确认并继续", "Approve and resume")}</button>}
          {executionView.phase === "client" && executionView.call && <button
            type="button"
            disabled={actionBusy}
            onClick={() => executeClientAction(executionView.call)}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-black disabled:opacity-50"
            style={{ background: ui.primary, color: ui.primaryText }}
          ><MonitorPlay size={14} />{t("在浏览器执行", "Run in browser")}</button>}
        </div>
      </section>}
      {showExecutionPlan && <section className={`${home ? "global-agent-home-plan" : "mt-5"} rounded-2xl p-4 md:p-6`} style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className={`global-agent-home-plan-header flex flex-wrap items-center justify-between gap-3 ${home ? "" : ""}`}>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: ui.faint }}>{t("执行摘要", "Plan summary")}</p>
            <p className="mt-2 text-sm leading-6" style={{ color: ui.text }}>{run?.summary || plan.summary}</p>
            {run && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-bold" style={{ color: ui.muted }}>
              <span>{localizedStatus(run.status, t)}</span>
              <span>{t(`进度 ${run.progress || 0}%`, `${run.progress || 0}% complete`)}</span>
              <span>{t(`步骤 ${run.currentStep || 0}/${run.totalSteps || calls.length}`, `Step ${run.currentStep || 0}/${run.totalSteps || calls.length}`)}</span>
              {activeRun && <span style={{ color: taskStream.connectionState === "live" ? ui.primary : ui.faint }}>{taskStream.connectionState === "live" ? t("实时同步", "Live") : taskStream.connectionState === "polling" ? t("轮询同步", "Polling") : t("正在连接", "Connecting")}</span>}
            </div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={activeRun || actionBusy} onClick={clearRun} className="inline-flex items-center gap-2 rounded-full px-3 py-2.5 text-sm font-black disabled:opacity-50" style={{ color: ui.muted, border: `1px solid ${ui.line}` }}><RotateCcw size={15} />{t("清除", "Clear")}</button>
            {run && ["queued", "running", "waiting_approval", "waiting_client"].includes(run.status) && <button type="button" disabled={actionBusy} onClick={cancelRun} className="inline-flex items-center gap-2 rounded-full px-3 py-2.5 text-sm font-black disabled:opacity-50" style={{ color: ui.danger, border: `1px solid ${ui.line}` }}><XCircle size={15} />{t("取消任务", "Cancel")}</button>}
            {!run?.id && <button type="button" disabled={actionBusy || !calls.length} onClick={runPlan} className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary }}><Play size={16} />{actionBusy ? t("启动中…", "Starting…") : t("后台执行", "Run in background")}</button>}
          </div>
        </div>
        {run?.error?.message && <div className="global-agent-home-run-error mt-4 rounded-2xl px-3 py-2 text-xs" style={{ color: ui.danger, background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
          {home ? <details><summary className="cursor-pointer">{t("查看错误详情", "View error details")}</summary><pre className="mt-2 whitespace-pre-wrap break-words">{run.error.message}</pre></details> : <GenerationErrorMessage error={run.error} t={t} />}
        </div>}
        <div className={home ? "global-agent-home-call-stack mt-5" : "mt-5 space-y-2"}>{(home ? callStack : calls.map((call, index) => ({ call, index }))).map(({ call, index: originalIndex }, index) => {
          const isCurrent = executionView.call && String(executionView.call.id || executionView.call.callId) === String(call.id || call.callId);
          const isFocused = home && focusedCallId === String(call.id || call.callId);
          const parameters = call.resolvedParameters || call.parameters || {};
          const normalizedCallStatus = getAgentCallDisplayStatus(call, run?.status).toLowerCase();
          const callLayer = isCurrent || ["running", "queued", "waiting_approval", "waiting_client", "processing"].includes(normalizedCallStatus)
            ? "is-active"
            : ["completed", "succeeded", "success", "failed", "cancelled"].includes(normalizedCallStatus)
              ? "is-complete"
              : "is-pending";
          return <div
            key={call.callId || `${call.toolKey}-${index}`}
            className={`${home ? `global-agent-home-step-card ${callLayer} ${isFocused ? "is-focused" : ""}` : "flex items-start gap-3 rounded-xl p-3"}`}
            onClick={() => { if (home) setFocusedCallId(String(call.id || call.callId)); }}
            onMouseLeave={() => { if (home) setFocusedCallId(""); }}
            onKeyDown={(event) => {
              if (home && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                setFocusedCallId(String(call.id || call.callId));
              }
            }}
            tabIndex={home ? 0 : undefined}
            style={{
              background: isCurrent ? ui.primarySoft : ui.surfaceAlt,
              border: `1px solid ${isCurrent ? ui.primary : ui.line}`,
              ...(home ? { "--stack-index": index } : {}),
            }}
          >
            <div className="mt-0.5">{statusIcon(normalizedCallStatus)}</div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-black" style={{ color: ui.text }}>
                  {originalIndex + 1}. {getAgentToolLabel(call, executionLanguage)}
                </p>
                <span className="rounded-full px-1.5 py-1 text-[9px] font-black" style={{ background: ui.surface, color: isCurrent ? ui.primary : ui.faint }}>
                  {localizedStatus(normalizedCallStatus, t)}
                </span>
              </div>
              <code className="mt-1 block truncate text-[10px]" style={{ color: ui.faint }}>{call.toolKey}</code>
              {call.reason && <p className="mt-2 text-xs leading-5" style={{ color: ui.muted }}>{call.reason}</p>}
              {call.result && <p className="mt-2 text-xs font-bold" style={{ color: ui.primary }}>{summarizeResult(call.result, t)}</p>}
              {call.error && <div className="mt-2 text-xs" style={{ color: ui.danger }}><GenerationErrorMessage error={call.error} t={t} /></div>}
              {Object.keys(parameters).length > 0 && <details className="mt-2">
                <summary className="cursor-pointer text-[10px] font-bold" style={{ color: ui.faint }}>{t("查看调用参数", "View parameters")}</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl p-2 text-[10px] leading-4" style={{ background: ui.surface, color: ui.muted }}>{JSON.stringify(parameters, null, 2)}</pre>
              </details>}
              {normalizedCallStatus === "waiting_approval" && <button type="button" disabled={actionBusy} onClick={() => approveStep(call)} className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black disabled:opacity-50" style={{ background: ui.primary, color: ui.primaryText }}><ShieldCheck size={14} />{t("确认并继续", "Approve and resume")}</button>}
              {normalizedCallStatus === "waiting_client" && <button type="button" disabled={actionBusy} onClick={() => executeClientAction(call)} className="mt-3 inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black disabled:opacity-50" style={{ background: ui.primary, color: ui.primaryText }}><Download size={14} />{t("在浏览器执行", "Run in browser")}</button>}
            </div>
          </div>;
        })}</div>
      </section>}
      </div>}
    </main>
  );
};

export default GlobalAgent;
