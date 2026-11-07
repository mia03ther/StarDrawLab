import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import useAuthAxios from "../hooks/useAuthAxios";
import toast from "react-hot-toast";
import { getGenerationErrorMessage } from "../utils/generationErrors";
import GenerationErrorMessage from "../components/GenerationErrorMessage";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import { isAnonymousTemplateAsset, normalizeTemplate, normalizeTemplates } from "../utils/templateData";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import {
  getModelByKey,
  getModelDurationOptions,
  getModelSizeOptions,
  normalizeModelCatalogResponse,
  resolveSupportedModel,
  resolveSupportedValue,
  SAFE_VIDEO_SIZE_OPTIONS,
} from "../utils/modelCapabilities";
import VisualParameterPicker from "../components/VisualParameterPicker";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import {
  clearGenerationRequestKey,
  generationRequestFingerprint,
  getGenerationRequestKey,
  shouldKeepGenerationRequestKey,
} from "../utils/generationRequestIdentity";
import {
  isOversizedReferenceImage,
  MAX_REFERENCE_IMAGE_BYTES,
} from "../utils/mediaUploadLimits";

const FALLBACK_VIDEO_MODELS = [{ model_key: "veo-3-1", display_name: "Veo 3.1" }];

const isHeyGenProvider = (scene) =>
  ["heygen", "heygen_video_agent", "heygen-digital-human"].includes(
    String(scene?.provider || "").trim().toLowerCase()
  );

const ProgressBar = ({ value, ui }) => (
  <div className="w-full h-1.5 rounded-full" style={{ background: ui.surfaceAlt }}>
    <div className="h-full rounded-full transition-all duration-700"
      style={{ width: `${value}%`, background: ui.buttonGradient }} />
  </div>
);

const AIVideo = () => {
  const [searchParams] = useSearchParams();
  const requestedTemplateKey = searchParams.get("template")?.trim() || "";
  const requestedTemplateId = searchParams.get("template_id")?.trim() || "";
  const requestedRemixId = searchParams.get("remix")?.trim() || "";
  const templateLaunchKey = requestedTemplateId
    ? `template-id:${requestedTemplateId}`
    : requestedTemplateKey
      ? `template-key:${requestedTemplateKey}`
      : requestedRemixId
        ? `remix:${requestedRemixId}`
        : "";
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();

  const [scenes,        setScenes]        = useState([]);
  const [selectedScene, setSelectedScene] = useState(null);
  const [prompt,        setPrompt]        = useState("");
  const [size,          setSize]          = useState("720x1280");
  const [seconds,       setSeconds]       = useState(8);
  const [videoModel,    setVideoModel]    = useState("veo-3-1");
  const [videoModels,   setVideoModels]   = useState(FALLBACK_VIDEO_MODELS);
  const [visualParameters, setVisualParameters] = useState({});
  const [referenceFiles,setReferenceFiles]= useState([]);
  const [estimatedPts,  setEstimatedPts]  = useState(null);
  const [submitting,    setSubmitting]    = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [creationId,    setCreationId]    = useState(null);
  const [pollData,      setPollData]      = useState(null);
  const [remixSource,   setRemixSource]   = useState(null);
  const [templateListOpen, setTemplateListOpen] = useState(false);
  const pollRef  = useRef(null);
  const debRef   = useRef(null);
  const fileInputRef = useRef(null);
  const promptSectionRef = useRef(null);
  const autoFocusedTemplateRef = useRef("");
  const promptOptimizationRef = useRef(false);
  const submissionRequestRef = useRef(false);

  const activeVideoModel = useMemo(() => getModelByKey(videoModels, videoModel), [videoModel, videoModels]);
  const sizeOptions = useMemo(() => getModelSizeOptions({
    model: activeVideoModel,
    outputType: "video",
    fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
  }), [activeVideoModel]);
  const durationOptions = useMemo(() => getModelDurationOptions({
    model: activeVideoModel,
    fallbackSeconds: selectedScene?.default_seconds || 8,
  }), [activeVideoModel, selectedScene?.default_seconds]);

  const featuredScenes = useMemo(
    () => scenes.filter((scene) => scene.is_featured).sort((a, b) => (a.featured_order || 0) - (b.featured_order || 0)),
    [scenes],
  );
  const freeformScenes = useMemo(
    () => scenes.filter((scene) => scene.scene_key === "freeform_video"),
    [scenes],
  );

  const scrollToPrompt = useCallback(() => {
    window.requestAnimationFrame(() => {
      promptSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const optimizePrompt = useCallback(async () => {
    const base = prompt.trim() || selectedScene?.starter_prompt || "";
    if (!base) {
      toast.error(t("请先填写镜头描述", "Enter motion direction first"));
      return;
    }
    if (!selectedScene || promptOptimizationRef.current) return;

    const operationKey = typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    promptOptimizationRef.current = true;
    setOptimizingPrompt(true);
    try {
      const { data } = await authAxios.post("/api/ai/optimize-generation-prompt", {
        prompt: base,
        output_type: "video",
        scene_key: selectedScene.scene_key,
        model: videoModel,
        size,
        seconds,
        language: isZh ? "zh" : "en",
      }, {
        headers: { "X-Idempotency-Key": `prompt-optimizer:${operationKey}` },
      });
      const optimized = String(data?.data?.optimized || "").trim();
      if (!data?.success || !optimized) throw new Error(data?.message || "Empty optimized prompt");
      setPrompt(optimized);
      scrollToPrompt();
      window.dispatchEvent(new Event("stardraw:points-updated"));
      toast.success(t("提示词已由 AI 优化", "Prompt improved by AI"));
    } catch (error) {
      const message = error.response?.data?.code === "INSUFFICIENT_POINTS"
        ? t("积分不足，无法优化提示词", "Insufficient points to improve the prompt")
        : error.response?.data?.message || t("提示词优化失败", "Prompt optimization failed");
      toast.error(message);
    } finally {
      promptOptimizationRef.current = false;
      setOptimizingPrompt(false);
    }
  }, [authAxios, isZh, prompt, scrollToPrompt, seconds, selectedScene, size, t, videoModel]);

  const applyScene = useCallback((scene, options = {}) => {
    if (!scene) return;
    const safeScene = normalizeTemplate(scene);
    const { adoptStarterPrompt = true, scroll = false } = options;
    setSelectedScene(safeScene);
    if (adoptStarterPrompt && safeScene.starter_prompt) {
      setPrompt(safeScene.starter_prompt);
    }
    if (safeScene.default_size) {
      setSize(safeScene.default_size);
    }
    if (safeScene.default_seconds) setSeconds(Number(safeScene.default_seconds));
    if (scroll) scrollToPrompt();
  }, [scrollToPrompt]);

  useEffect(() => () => {
    referenceFiles.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, [referenceFiles]);

  // Load scenes and the root-managed model capabilities together.
  useEffect(() => {
    Promise.all([
      authAxios.get("/api/template-studio/catalog?output_type=video&featured_only=true&include_freeform=true&limit=100"),
      authAxios.get("/api/ai/models?output_type=video"),
      requestedRemixId
        ? authAxios.get(`/api/community/creations/${encodeURIComponent(requestedRemixId)}`)
          .catch(() => ({ data: { data: null } }))
        : Promise.resolve({ data: { data: null } }),
      requestedTemplateId
        ? authAxios.get(`/api/template-studio/prompt-templates/${encodeURIComponent(requestedTemplateId)}`)
          .catch(() => ({ data: { data: null } }))
        : Promise.resolve({ data: { data: null } }),
    ])
      .then(([sceneResponse, modelResponse, remixResponse, requestedTemplateResponse]) => {
        const vids = normalizeTemplates(sceneResponse.data?.data || [])
          .filter(s => s.output_type === "video" && !isHeyGenProvider(s));
        const remix = remixResponse.data?.data?.type === "video" ? remixResponse.data.data : null;
        const requestedTemplate = requestedTemplateResponse.data?.data?.output_type === "video"
          && !isHeyGenProvider(requestedTemplateResponse.data.data)
          ? normalizeTemplates([requestedTemplateResponse.data.data])[0]
          : null;
        const availableModels = normalizeModelCatalogResponse(modelResponse.data, FALLBACK_VIDEO_MODELS)
          .filter((item) => item.capabilities?.digital_human !== true && item.model_key !== "video-agent");
        const modelPool = availableModels.length ? availableModels : FALLBACK_VIDEO_MODELS;
        setScenes(requestedTemplate && !vids.some((item) => item.scene_key === requestedTemplate.scene_key)
          ? [requestedTemplate, ...vids]
          : vids);
        setVideoModels(modelPool);
        setRemixSource(remix);
        if (vids.length > 0 || requestedTemplate) {
          const preferredScene = vids.find((scene) => scene.scene_key === remix?.scene_key)
              || requestedTemplate
              || vids.find((scene) => scene.scene_key === requestedTemplateKey)
              || (!requestedTemplateKey && !requestedTemplateId && !requestedRemixId
                ? vids.find((scene) => scene.scene_key === "freeform_video")
                : null)
              || vids.find((scene) => scene.is_featured)
              || vids[0];
          applyScene(preferredScene, { adoptStarterPrompt: true });
          if (remix?.prompt_public && remix.prompt) setPrompt(remix.prompt);
          if (remix?.public_parameters?.visual_parameters) {
            setVisualParameters(remix.public_parameters.visual_parameters);
          }
          const preferredModel = remix?.public_parameters?.model || preferredScene?.default_model || FALLBACK_VIDEO_MODELS[0].model_key;
          setVideoModel(resolveSupportedModel(modelPool, preferredModel, FALLBACK_VIDEO_MODELS[0].model_key));
        }
      })
      .catch(() => toast.error(t("加载模板或模型失败", "Failed to load templates or models")));
    return () => { clearInterval(pollRef.current); };
  }, [authAxios, applyScene, requestedRemixId, requestedTemplateId, requestedTemplateKey, t]);

  useEffect(() => {
    if (!selectedScene || !videoModels.length) return;
    const nextModel = resolveSupportedModel(
      videoModels,
      remixSource?.public_parameters?.model || selectedScene.default_model,
      videoModels[0].model_key,
    );
    setVideoModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(videoModels, nextModel),
      outputType: "video",
      fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
    });
    setSize(resolveSupportedValue(
      remixSource?.public_parameters?.size || selectedScene.default_size,
      nextOptions,
      nextOptions[0]?.value,
    ));
    const nextDurations = getModelDurationOptions({
      model: getModelByKey(videoModels, nextModel),
      fallbackSeconds: selectedScene.default_seconds || 8,
    });
    const preferredSeconds = Number(remixSource?.public_parameters?.seconds || selectedScene.default_seconds);
    setSeconds(nextDurations.includes(preferredSeconds) ? preferredSeconds : nextDurations[0]);
  }, [remixSource, selectedScene, videoModels]);

  useEffect(() => {
    if (!templateLaunchKey || !selectedScene || !videoModels.length) return undefined;
    if (autoFocusedTemplateRef.current === templateLaunchKey) return undefined;

    let layoutFrame = 0;
    const renderFrame = window.requestAnimationFrame(() => {
      layoutFrame = window.requestAnimationFrame(() => {
        if (!promptSectionRef.current) return;
        promptSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
        autoFocusedTemplateRef.current = templateLaunchKey;
      });
    });

    return () => {
      window.cancelAnimationFrame(renderFrame);
      window.cancelAnimationFrame(layoutFrame);
    };
  }, [selectedScene, templateLaunchKey, videoModels.length]);

  const handleVideoModelChange = (nextModel) => {
    setVideoModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(videoModels, nextModel),
      outputType: "video",
      fallbackOptions: SAFE_VIDEO_SIZE_OPTIONS,
    });
    setSize((current) => resolveSupportedValue(current, nextOptions, nextOptions[0]?.value));
    const nextDurations = getModelDurationOptions({
      model: getModelByKey(videoModels, nextModel),
      fallbackSeconds: selectedScene?.default_seconds || 8,
    });
    setSeconds((current) => nextDurations.includes(current) ? current : nextDurations[0]);
  };

  // Estimate points (debounced)
  const estimate = useCallback(() => {
    if (!selectedScene) return;
    clearTimeout(debRef.current);
    debRef.current = setTimeout(async () => {
      try {
        const { data } = await authAxios.post("/api/ai/estimate-points", {
          scene_key: selectedScene.scene_key,
          output_type: "video",
          model: videoModel,
          size,
          seconds,
        });
        setEstimatedPts(data?.data?.estimated_points ?? null);
      } catch {
        // Estimation is best-effort; generation still performs authoritative billing.
      }
    }, 400);
  }, [selectedScene, seconds, size, videoModel, authAxios]);

  useEffect(() => { estimate(); }, [estimate]);

  // Poll video status
  const startPoll = useCallback((id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await authAxios.get(`/api/ai/video-status/${id}`);
        setPollData(data);
        if (data.status === "completed" || data.status === "failed") {
          clearInterval(pollRef.current);
          window.dispatchEvent(new Event("stardraw:points-updated"));
          if (data.status === "completed") toast.success(t("视频已生成", "Video ready!"));
          else {
            const errMsg = getGenerationErrorMessage(data.error_message, t);
            toast.error(errMsg || t("视频生成失败", "Video generation failed"));
          }
        }
      } catch {
        // The next polling cycle or background reconciliation will retry.
      }
    }, 4000);
  }, [authAxios, t]);

  const handleSubmit = async () => {
    if (!selectedScene || !prompt.trim()) {
      toast.error(t("请选择生成方式并填写提示词", "Choose a generation mode and enter a prompt"));
      return;
    }
    if (selectedScene.requires_reference && referenceFiles.length === 0) {
      toast.error(t("这个视频模板需要上传参考图", "This video template requires a reference image"));
      return;
    }
    if (referenceFiles.some((item) => isOversizedReferenceImage(item.file))) {
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
      return;
    }
    if (submissionRequestRef.current) return;
    submissionRequestRef.current = true;
    setSubmitting(true);
    setPollData(null);
    setCreationId(null);
    const requestKey = getGenerationRequestKey({
      scope: "video",
      fingerprint: generationRequestFingerprint({
        sceneKey: selectedScene.scene_key,
        prompt: prompt.trim(),
        model: videoModel,
        size,
        seconds,
        visualParameters,
        references: referenceFiles.map((item) => ({
          name: item.file.name,
          size: item.file.size,
          lastModified: item.file.lastModified,
        })),
      }),
    });
    try {
      const formData = new FormData();
      formData.append("scene_key", selectedScene.scene_key);
      formData.append("user_prompt", prompt);
      formData.append("model", videoModel || selectedScene.default_model || "");
      formData.append("size", size);
      formData.append("seconds", String(seconds));
      formData.append("visual_parameters", JSON.stringify(visualParameters));
      referenceFiles.slice(0, 1).forEach((item) => formData.append("images", item.file));

      const { data } = await authAxios.post("/api/ai/generate-sora-video", formData, {
        headers: { "X-Idempotency-Key": requestKey },
      });
      clearGenerationRequestKey({ scope: "video", requestKey });
      if (data?.success) {
        setCreationId(data.creation_id);
        setPollData(data);
        window.dispatchEvent(new Event("stardraw:points-updated"));
        toast(t("视频任务已提交，正在轮询进度…", "Video task submitted — polling for updates…"), { icon: "⏳" });
        startPoll(data.creation_id);
      } else {
        toast.error(getGenerationErrorMessage(data, t));
      }
    } catch (err) {
      if (!shouldKeepGenerationRequestKey(err)) clearGenerationRequestKey({ scope: "video", requestKey });
      const errData = err.response?.data;
      if (errData?.code === "INSUFFICIENT_POINTS") {
        toast.error(isZh ? `积分不足，需要 ${errData.required_points}，当前 ${errData.available_points}` : `Insufficient points — need ${errData.required_points}, have ${errData.available_points}`);
      } else if (["EXECUTION_IN_PROGRESS", "EXECUTION_CONCURRENCY_LIMITED"].includes(errData?.code)) {
        toast(t("已有视频任务正在后台运行，请稍候在任务中心查看。", "A video task is already running. Check Task Center shortly."));
      } else {
        toast.error(getGenerationErrorMessage(err, t));
      }
    } finally {
      window.dispatchEvent(new Event("stardraw:points-updated"));
      submissionRequestRef.current = false;
      setSubmitting(false);
    }
  };

  const handleFileChange = (event) => {
    const imageFiles = Array.from(event.target.files || [])
      .filter((file) => file.type.startsWith("image/"));
    if (imageFiles.some(isOversizedReferenceImage)) {
      event.target.value = "";
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
      return;
    }
    const nextFiles = imageFiles
      .slice(0, 1)
      .map((file) => ({
        id: `${file.name}-${file.lastModified}-${file.size}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }));

    setReferenceFiles((prev) => {
      prev.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return nextFiles;
    });

    event.target.value = "";
  };

  const clearReference = (id) => {
    setReferenceFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleDownload = async () => {
    if (!creationId) return;
    try {
      const { data } = await authAxios.get(`/api/user/creations/${creationId}/download`);
      if (data?.data?.download_url) {
        const downloadUrl = await resolvePrivateUrl(data.data.download_url);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `video_${creationId}.mp4`;
        a.click();
      }
    } catch { toast.error(t("下载失败", "Download failed")); }
  };

  const statusMap = {
    pending:   { label: t("排队中", "QUEUED"),      color: ui.muted, pulse: true },
    running:   { label: t("处理中", "PROCESSING"),  color: ui.gold, pulse: true },
    completed: { label: t("已完成", "COMPLETE"),    color: ui.primary },
    failed:    { label: t("失败", "FAILED"),        color: ui.danger },
  };
  const cfg     = pollData ? statusMap[pollData.status] : null;
  const isDone  = pollData?.status === "completed";
  const isFailed = pollData?.status === "failed";

  return (
    <div className="p-10 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-10">
        <h2 className="text-4xl font-extrabold mb-2"
          style={{ color: ui.text, fontFamily: "Manrope, sans-serif", letterSpacing: "-0.02em" }}>
          {t("AI 视频生成", "AI Video Generation")}
        </h2>
        <p className="text-lg max-w-2xl" style={{ color: ui.muted, opacity: 0.7 }}>
          {t("可以直接填写提示词自由生成，也可以选择模板快速开始。", "Write your own prompt for a freeform generation, or choose a template to start faster.")}
        </p>
      </div>

      {featuredScenes.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.gold }}>
                {t("精选模板", "Featured Templates")}
              </p>
              <p className="text-sm" style={{ color: ui.faint }}>
                {t("带预览图和默认镜头描述的现成视频模板，可直接选择后生成。", "Ready-to-use video templates with preview and starter motion prompts.")}
              </p>
            </div>
          </div>

          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
            {featuredScenes.map((scene) => (
              <button
                key={scene.scene_key}
                type="button"
                onClick={() => applyScene(scene, { adoptStarterPrompt: true, scroll: true })}
                onDoubleClick={() => applyScene(scene, { adoptStarterPrompt: true, scroll: true })}
                className="group overflow-hidden rounded-3xl text-left transition-all"
                style={{
                  background: ui.surface,
                  border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.gold : ui.line}`,
                  boxShadow: selectedScene?.scene_key === scene.scene_key ? "0 20px 48px rgba(233,195,73,0.10)" : "none",
                }}
              >
                <div
                  className="w-full overflow-hidden"
                  style={{
                    aspectRatio: "4 / 5",
                    background: scene.preview_video_url || scene.preview_image_url
                      ? undefined
                      : ui.surfaceAlt,
                  }}
                >
                  {scene.preview_video_url ? (
                    <OssVideo
                      key={scene.preview_video_url}
                      src={scene.preview_video_url}
                      authorize={!isAnonymousTemplateAsset(scene)}
                      className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500"
                      autoPlay
                      loop
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : scene.preview_image_url ? (
                    <OssImage src={scene.preview_image_url} authorize={!isAnonymousTemplateAsset(scene)} alt={scene.preview_title || scene.scene_name} className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500" />
                  ) : (
                    <div className="h-full flex items-center justify-center text-center px-8" style={{ color: ui.faint }}>
                      {t("暂未上传预览素材", "No preview yet")}
                    </div>
                  )}
                </div>
                <div className="p-5">
                  <div className="flex flex-wrap gap-2 mb-3">
                    <span className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}>
                      {scene.estimated_points ?? "--"} {t("积分", "pts")}
                    </span>
                    <span className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.surfaceAlt, color: scene.requires_reference ? ui.primary : ui.faint }}>
                      {scene.requires_reference ? t("需要图片", "Needs image") : t("仅需提示词", "Prompt only")}
                    </span>
                  </div>
                  <p className="text-lg font-extrabold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                    {scene.preview_title || scene.scene_name}
                  </p>
                  <p className="text-sm mb-4" style={{ color: ui.muted, lineHeight: 1.7 }}>
                    {scene.preview_description || t("开箱即用的视频生成模板。", "Ready-to-use video generation template.")}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: ui.faint }}>{scene.default_size || "720x1280"}</span>
                    <span className="text-sm font-bold" style={{ color: ui.gold }}>
                      {t("使用模板", "Use Template")}
                    </span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>
      )}

      {freeformScenes.length > 0 && (
        <section className="mb-8">
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.gold }}>
              {t("自由生成", "Freeform Generation")}
            </p>
            <p className="text-sm" style={{ color: ui.faint }}>
              {t("不套用业务模板，完全按照你填写的提示词生成视频。", "No business template is applied. The video follows your prompt directly.")}
            </p>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            {freeformScenes.map((scene) => (
              <button
                key={scene.scene_key}
                type="button"
                onClick={() => applyScene(scene, { adoptStarterPrompt: false, scroll: true })}
                className="flex items-center justify-between gap-5 rounded-2xl p-5 text-left transition-all"
                style={{
                  background: selectedScene?.scene_key === scene.scene_key ? ui.surfaceHigh : ui.surface,
                  border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.gold : ui.line}`,
                  boxShadow: selectedScene?.scene_key === scene.scene_key ? ui.shadow : "none",
                }}
              >
                <span>
                  <span className="block text-base font-extrabold" style={{ color: ui.text }}>{scene.preview_title || scene.scene_name}</span>
                  <span className="mt-1 block text-xs" style={{ color: ui.muted }}>{scene.preview_description || t("按自己的提示词生成视频", "Generate from your own prompt")}</span>
                </span>
                <span className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: ui.goldSoft, color: ui.gold }}>
                  {scene.estimated_points ?? "--"} {t("积分", "pts")}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-12 gap-8 items-start">
        {/* ── Left: Config ── */}
        <section className="col-span-12 lg:col-span-4 xl:col-span-3 space-y-6 sticky top-24">
          <div className="rounded-2xl p-4" style={{ background: ui.surface }}>
            <button type="button" onClick={() => setTemplateListOpen((current) => !current)} className="flex w-full items-center gap-3 text-left" aria-expanded={templateListOpen}>
              <span className="material-symbols-outlined text-sm" style={{ color: ui.gold }}>movie_filter</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.gold }}>{t("全部模板", "All Templates")}</span>
                <span className="mt-1 block truncate text-xs" style={{ color: ui.muted }}>{selectedScene?.scene_name || t("尚未选择", "Not selected")}</span>
              </span>
              <span className="material-symbols-outlined text-lg" style={{ color: ui.faint }}>{templateListOpen ? "expand_less" : "expand_more"}</span>
            </button>
            {templateListOpen && (
              <div className="mt-3 max-h-[min(42vh,28rem)] space-y-1.5 overflow-y-auto pr-1">
                {scenes.map((scene) => (
                  <button
                    key={scene.scene_key}
                    type="button"
                    onClick={() => applyScene(scene, { adoptStarterPrompt: false })}
                    onDoubleClick={() => applyScene(scene, { adoptStarterPrompt: true, scroll: true })}
                    className="flex w-full items-center justify-between rounded-xl p-2.5 text-left transition-all"
                    style={{
                      background: selectedScene?.scene_key === scene.scene_key ? ui.surfaceHigh : ui.surfaceAlt,
                      border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.gold : ui.line}`,
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: ui.text }}>{scene.scene_name}</span>
                    {selectedScene?.scene_key === scene.scene_key && <span className="material-symbols-outlined filled ml-2 text-base" style={{ color: ui.gold }}>check_circle</span>}
                  </button>
                ))}
                {scenes.length === 0 && <p className="py-4 text-center text-xs" style={{ color: ui.faint }}>{t("正在加载模板…", "Loading templates...")}</p>}
              </div>
            )}
          </div>

          <div>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-3"
              style={{ color: ui.gold }}>
              <span className="material-symbols-outlined text-sm">model_training</span>
              {t("视频模型", "Video Model")}
            </label>
            <CanvasRoundedSelect
              label={t("视频模型", "Video Model")}
              value={videoModel}
              options={videoModels}
              onChange={handleVideoModelChange}
              ui={ui}
              className="w-full"
              triggerClassName="w-full"
              menuMinWidth={280}
            />
          </div>

          <div>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-3" style={{ color: ui.gold }}>
              <span className="material-symbols-outlined text-sm">timer</span>
              {t("视频时长", "Video Duration")}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {durationOptions.map((item) => (
                <button key={item} type="button" onClick={() => setSeconds(item)} className="rounded-xl px-3 py-2.5 text-xs font-bold transition-all" style={{ background: seconds === item ? ui.surfaceHigh : ui.surface, border: `1px solid ${seconds === item ? ui.gold : ui.line}`, color: seconds === item ? ui.gold : ui.muted }}>
                  {item}{t(" 秒", "s")}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px]" style={{ color: ui.faint }}>{t("可用时长由当前模型能力决定。", "Available durations are limited by the selected model.")}</p>
          </div>

          <div>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-3"
              style={{ color: ui.gold }}>
              <span className="material-symbols-outlined text-sm">aspect_ratio</span>
              {t("视频尺寸", "Video Format")}
            </label>
            <div className="space-y-2">
              {sizeOptions.map(s => (
                <button key={s.value} onClick={() => setSize(s.value)}
                  className="w-full flex items-center gap-3 p-3 rounded-xl transition-all"
                  style={{
                    background: size === s.value ? ui.surfaceHigh : ui.surface,
                    border: `1px solid ${size === s.value ? ui.gold : ui.line}`,
                    color: size === s.value ? ui.gold : ui.faint,
                  }}>
                  <span className="text-xs font-bold">{s.label}</span>
                  <span className="text-[10px] opacity-60">{isZh ? s.subZh : s.subEn}</span>
                  <span className="ml-auto text-[10px] opacity-50">{s.value}</span>
                </button>
              ))}
            </div>
          </div>

          <VisualParameterPicker outputType="video" modelKey={videoModel} value={visualParameters} onChange={setVisualParameters} accent="gold" />

          {/* Estimate */}
          {estimatedPts !== null && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl"
              style={{ background: ui.surfaceAlt }}>
              <span className="material-symbols-outlined text-sm" style={{ color: ui.gold }}>bolt</span>
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("预计消耗", "Estimated Cost")}</p>
                <p className="text-base font-bold" style={{ color: ui.gold, fontFamily: "Manrope, sans-serif" }}>
                  ~{estimatedPts} {t("积分", "pts")}
                </p>
              </div>
            </div>
          )}

          {/* Submit button */}
          <button onClick={handleSubmit} disabled={submitting || !selectedScene || !!creationId && !isDone && !isFailed}
            className="w-full py-4 rounded-xl font-extrabold tracking-tight flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: ui.surfaceRaised,
              color: ui.gold,
              border: "1px solid rgba(233,195,73,0.35)",
              fontFamily: "Manrope, sans-serif",
            }}>
            {submitting
              ? <><span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />{t("提交中…", "Submitting…")}</>
              : <><span className="material-symbols-outlined">videocam</span>{t("生成视频", "GENERATE VIDEO")}</>
            }
          </button>
        </section>

        {/* ── Right: Prompt + Result ── */}
        <section className="col-span-12 lg:col-span-8 xl:col-span-9 space-y-6">
          {/* Prompt */}
          <div ref={promptSectionRef} className="rounded-2xl p-6 scroll-mt-24" style={{ background: ui.surface }}>
            {templateLaunchKey && selectedScene && (
              <div className="mb-4 flex min-w-0 items-center gap-2 rounded-xl px-3 py-2" style={{ background: ui.goldSoft, color: ui.gold }}>
                <span className="material-symbols-outlined text-lg">check_circle</span>
                <span className="shrink-0 text-xs font-bold">{t("已应用模板", "Template applied")}</span>
                <span className="truncate text-xs" style={{ color: ui.text }}>{selectedScene.preview_title || selectedScene.scene_name}</span>
              </div>
            )}
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-4"
              style={{ color: ui.gold }}>
              <span className="material-symbols-outlined text-sm">edit_note</span>
              {t("镜头与动作描述", "Motion Direction")}
            </label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={t("描述镜头运动、主体动作和场景氛围…\n例如：镜头缓缓环绕马克杯，展示材质与蒸汽感，背景是黑色大理石桌面", "Describe the cinematic motion and scene…\ne.g. slow orbit around the mug, showing material and steam on a black marble table")}
              rows={5}
              className="w-full resize-none text-sm outline-none transition-all rounded-xl p-4"
              style={{
                background: ui.surfaceAlt,
                color: ui.text,
                border: "1px solid rgba(69,71,75,0.25)",
                fontFamily: "Inter, sans-serif",
                lineHeight: 1.7,
              }}
              onFocus={e => e.target.style.border = "1px solid rgba(233,195,73,0.45)"}
              onBlur={e => e.target.style.border = "1px solid rgba(69,71,75,0.25)"}
            />
            <div className="flex justify-between mt-2">
              <p className="text-[10px]" style={{ color: ui.faint }}>
                {t("视频生成是异步任务，提交后系统会自动轮询结果。", "Video generation is async — poll results after submitting.")}
              </p>
              <span className="text-[10px]" style={{ color: ui.faint }}>{prompt.length} {t("字", "chars")}</span>
            </div>
            <button
              type="button"
              onClick={optimizePrompt}
              disabled={optimizingPrompt}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:cursor-wait disabled:opacity-60"
              style={{ background: ui.goldSoft, color: ui.gold, border: "1px solid rgba(233,195,73,0.22)" }}
            >
              {optimizingPrompt && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              {optimizingPrompt ? t("AI 优化中…", "Improving…") : t("优化提示词", "Optimize Prompt")}
            </button>
          </div>

          <div className="rounded-2xl p-6" style={{ background: ui.surface }}>
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-1"
                  style={{ color: ui.gold }}>
                  <span className="material-symbols-outlined text-sm">imagesmode</span>
                  {t("参考图片", "Reference Image")}
                </label>
                <p className="text-xs" style={{ color: ui.faint }}>
                  {t(`默认可选，参考图不能超过 ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB。上传 1 张图片后，在供应商支持时会走图生视频。`, `Optional by default; reference images must be ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB or smaller. Upload 1 image to run image-to-video when the provider supports it.`)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 rounded-xl text-sm font-bold transition-all active:scale-95"
                style={{
                  background: ui.goldSoft,
                  color: ui.gold,
                  border: "1px solid rgba(233,195,73,0.2)",
                }}>
                {t("上传图片", "Upload Image")}
              </button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />

            {referenceFiles.length === 0 ? (
              <div className="rounded-xl px-4 py-6 text-center"
                style={{ background: ui.surfaceAlt, border: `1px dashed ${selectedScene?.requires_reference ? ui.gold : ui.lineStrong}` }}>
                <p className="text-sm" style={{ color: ui.muted }}>
                  {selectedScene?.requires_reference ? t("这个模板需要参考图。", "This template needs a reference image.") : t("尚未选择参考图。", "No reference image selected.")}
                </p>
                <p className="text-[11px] mt-1" style={{ color: ui.faint }}>
                  {selectedScene?.requires_reference ? t("上传 1 张图片后才能开始生成。", "Upload one image to unlock generation.") : t("留空则走文生视频。", "Leave empty for text-to-video.")}
                </p>
              </div>
            ) : (
              <div className="max-w-xs rounded-xl overflow-hidden"
                style={{ background: ui.surfaceAlt, border: "1px solid rgba(69,71,75,0.25)" }}>
                {referenceFiles.map((item) => (
                  <div key={item.id}>
                    <div className="relative" style={{ aspectRatio: "1 / 1" }}>
                      <img src={item.previewUrl} alt={item.file.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => clearReference(item.id)}
                        className="absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center"
                        style={{ background: ui.overlay, color: ui.text }}>
                        <span className="material-symbols-outlined text-sm">close</span>
                      </button>
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-[11px] truncate" style={{ color: ui.muted }}>{item.file.name}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Task status panel */}
          {pollData ? (
            <div className="rounded-2xl overflow-hidden" style={{ background: ui.surface }}>
              {/* Status header */}
              <div className="p-6" style={{ borderBottom: "1px solid rgba(69,71,75,0.15)" }}>
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <p className="text-xs uppercase tracking-widest mb-1" style={{ color: ui.faint }}>
                      {t("任务", "Creation")} #{creationId}
                    </p>
                    <p className="font-bold text-lg" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                      {selectedScene?.scene_name}
                    </p>
                  </div>
                  {cfg && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold"
                      style={{ background: ui.overlay, backdropFilter: "blur(12px)", color: cfg.color }}>
                      <span className={`w-1.5 h-1.5 rounded-full ${cfg.pulse ? "animate-pulse" : ""}`}
                        style={{ background: cfg.color }} />
                      {cfg.label}
                    </div>
                  )}
                </div>

                {/* Progress bar */}
                <ProgressBar value={pollData.progress ?? 0} ui={ui} />
                <div className="flex justify-between mt-2">
                  <span className="text-[10px]" style={{ color: ui.faint }}>
                    {pollData.provider_status || t("初始化中", "Initializing")}
                  </span>
                  <span className="text-[10px]" style={{ color: ui.faint }}>
                    {pollData.progress ?? 0}%
                  </span>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-3 divide-x p-0"
                style={{ borderBottom: "1px solid rgba(69,71,75,0.15)" }}>
                {[
                  { label: t("预留积分", "Reserved"),  value: `${pollData.points_reserved ?? 0} ${t("积分", "pts")}` },
                  { label: t("实扣积分", "Charged"),   value: `${pollData.points_charged  ?? 0} ${t("积分", "pts")}` },
                  { label: t("时长 / 尺寸", "Duration"),  value: `${seconds}s / ${size}` },
                ].map(({ label, value }) => (
                  <div key={label} className="p-4 text-center"
                    style={{ borderColor: ui.line }}>
                    <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: ui.faint }}>{label}</p>
                    <p className="text-sm font-bold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Video preview / actions */}
              {isDone && pollData.content ? (
                <div className="p-6 space-y-4">
                  <OssVideo src={pollData.content} controls className="w-full rounded-xl"
                    style={{ maxHeight: 400, background: ui.surfaceAlt }}>
                    {t("你的浏览器不支持视频播放。", "Your browser does not support video playback.")}
                  </OssVideo>
                  <div className="flex gap-3">
                    <button onClick={handleDownload}
                      className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm transition-all hover:opacity-90 active:scale-95"
                      style={{
                        background: ui.buttonGradient,
                        color: ui.primaryText,
                        fontFamily: "Manrope, sans-serif",
                      }}>
                      <span className="material-symbols-outlined text-sm">download</span>
                      {t("下载无水印视频", "Download Without Watermark")}
                    </button>
                    <button onClick={() => { setCreationId(null); setPollData(null); setPrompt(""); }}
                      className="px-5 py-3 rounded-xl font-bold text-sm transition-all hover:opacity-80"
                      style={{ background: ui.surfaceRaised, color: ui.muted, fontFamily: "Manrope, sans-serif" }}>
                      {t("新建视频", "New Video")}
                    </button>
                  </div>
                </div>
              ) : isFailed ? (
                <div className="p-8 text-center">
                  <span className="material-symbols-outlined text-4xl mb-3 block" style={{ color: ui.danger }}>error_outline</span>
                  <p className="font-bold mb-1" style={{ color: ui.danger, fontFamily: "Manrope, sans-serif" }}>{t("生成失败", "Generation Failed")}</p>
                  <div className="text-sm mb-4" style={{ color: ui.faint }}>
                    <GenerationErrorMessage error={pollData.error_message} t={t} />
                  </div>
                  <button onClick={() => { setCreationId(null); setPollData(null); }}
                    className="px-5 py-2.5 rounded-xl font-bold text-sm"
                    style={{ background: ui.surfaceRaised, color: ui.muted, fontFamily: "Manrope, sans-serif" }}>
                    {t("再试一次", "Try Again")}
                  </button>
                </div>
              ) : (
                <div className="p-8 text-center">
                  <div className="w-12 h-12 rounded-full border-2 animate-gold-pulse mx-auto mb-4"
                    style={{ borderColor: ui.gold }} />
                  <p className="font-bold mb-1" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                    {t("视频生成中", "Video Being Generated")}
                  </p>
                  <p className="text-sm" style={{ color: ui.faint }}>
                    {t("每 4 秒自动查询一次，整个过程可能需要几分钟。", "Polling every 4 seconds. This may take a few minutes.")}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-2xl p-16 flex flex-col items-center justify-center"
              style={{ background: ui.surface, border: "2px dashed rgba(69,71,75,0.25)" }}>
              <span className="material-symbols-outlined text-5xl mb-4" style={{ color: ui.faint }}>movie_filter</span>
              <p className="font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("视频画布已就绪", "Your cinematic canvas awaits")}
              </p>
              <p className="text-sm" style={{ color: ui.faint }}>
                {t("选择模板，填写镜头描述，确认参数后即可提交。", "Select a scene, enter motion direction, configure timing, then submit")}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default AIVideo;
