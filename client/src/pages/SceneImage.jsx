import { getPhysicalDraft } from "../utils/physicalDraft";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { getGenerationErrorMessage } from "../utils/generationErrors";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage } from "../components/OssMedia";
import { isAnonymousTemplateAsset, normalizeTemplate, normalizeTemplates } from "../utils/templateData";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import {
  getModelByKey,
  getModelSizeOptions,
  modelSupportsReferenceImages,
  normalizeModelCatalogResponse,
  resolveSupportedModel,
  resolveSupportedValue,
  SAFE_IMAGE_SIZE_OPTIONS,
} from "../utils/modelCapabilities";
import VisualParameterPicker from "../components/VisualParameterPicker";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import {
  clearGenerationRequestKey,
  generationRequestFingerprint,
  getGenerationRequestKey,
  shouldKeepGenerationRequestKey,
} from "../utils/generationRequestIdentity";
import "./SceneImage.css";
import {
  isOversizedReferenceImage,
  MAX_REFERENCE_IMAGE_BYTES,
} from "../utils/mediaUploadLimits";

const FALLBACK_IMAGE_MODELS = ["nano-banana-2"];
const normalizeImageModelId = (value) => String(value || "").trim() === "image2" ? "gpt-image-2" : String(value || "").trim();

const StatusBadge = ({ status }) => {
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const map = {
    completed: { color: ui.primary, label: t("已完成", "COMPLETE") },
    running: { color: ui.gold, label: t("处理中", "PROCESSING"), pulse: true },
    pending: { color: ui.muted, label: t("排队中", "QUEUED"), pulse: true },
    failed: { color: ui.danger, label: t("失败", "FAILED") },
  };
  const cfg = map[status] || map.completed;

  return (
    <div
      className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold"
      style={{ background: ui.overlay, backdropFilter: "blur(12px)", color: cfg.color }}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${cfg.pulse ? "animate-pulse" : ""}`} style={{ background: cfg.color }} />
      {cfg.label}
    </div>
  );
};

const SceneImage = () => {
  const [searchParams] = useSearchParams();
  const requestedTemplateKey = searchParams.get("template")?.trim() || "";
  const requestedTemplateId = searchParams.get("template_id")?.trim() || "";
  const requestedRemixId = searchParams.get("remix")?.trim() || "";
  const requestedPrompt = searchParams.get("prompt")?.trim() || "";
  const physicalProduct = searchParams.get("product")?.trim() || "";
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
  const debounceRef = useRef(null);
  const fileInputRef = useRef(null);
  const promptSectionRef = useRef(null);
  const autoFocusedTemplateRef = useRef("");
  const promptOptimizationRef = useRef(false);
  const generationRequestRef = useRef(false);
  const activeRequestKeyRef = useRef(null);
  const physicalDraftAppliedRef = useRef(false);

  const [scenes, setScenes] = useState([]);
  const [selectedScene, setSelectedScene] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [model, setModel] = useState("nano-banana-2");
  const [imageModels, setImageModels] = useState(FALLBACK_IMAGE_MODELS.map((model_key) => ({ model_key, display_name: model_key })));
  const [visualParameters, setVisualParameters] = useState({});
  const [referenceFiles, setReferenceFiles] = useState([]);
  const [estimatedPts, setEstimatedPts] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [optimizingPrompt, setOptimizingPrompt] = useState(false);
  const [result, setResult] = useState(null);
  const [generationError, setGenerationError] = useState("");
  const [resultPreviewOpen, setResultPreviewOpen] = useState(false);
  const [remixSource, setRemixSource] = useState(null);
  const [templateListOpen, setTemplateListOpen] = useState(false);

  const activeImageModel = useMemo(() => getModelByKey(imageModels, model), [imageModels, model]);
  const supportsReferenceImages = modelSupportsReferenceImages(activeImageModel);
  const sizeOptions = useMemo(() => getModelSizeOptions({
    model: activeImageModel,
    outputType: "image",
    fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
  }), [activeImageModel]);

  const featuredScenes = useMemo(
    () => scenes.filter((scene) => scene.is_featured).sort((a, b) => (a.featured_order || 0) - (b.featured_order || 0)),
    [scenes],
  );
  const freeformScenes = useMemo(
    () => scenes.filter((scene) => scene.scene_key === "freeform_image"),
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
      toast.error(t("请先填写提示词", "Enter a prompt first"));
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
        output_type: "image",
        scene_key: selectedScene.scene_key,
        model,
        size,
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
  }, [authAxios, isZh, model, prompt, scrollToPrompt, selectedScene, size, t]);

  const applyScene = useCallback((scene, options = {}) => {
    if (!scene) return;
    const safeScene = normalizeTemplate(scene);
    const { adoptStarterPrompt = true, scroll = false } = options;
    setSelectedScene(safeScene);
    setResult(null);
    setGenerationError("");
    setResultPreviewOpen(false);
    if (adoptStarterPrompt) {
      setPrompt(safeScene.starter_prompt || "");
    }
    if (safeScene.default_size) {
      setSize(safeScene.default_size);
    }
    if (safeScene.default_model) setModel(normalizeImageModelId(safeScene.default_model));
    if (scroll) scrollToPrompt();
  }, [scrollToPrompt]);

  useEffect(() => () => {
    referenceFiles.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, [referenceFiles]);

  useEffect(() => {
    if (!resultPreviewOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setResultPreviewOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [resultPreviewOpen]);

  useEffect(() => {
    if (!physicalProduct || physicalDraftAppliedRef.current) return;
    const draft = getPhysicalDraft();
    if (!draft?.file) return;
    physicalDraftAppliedRef.current = true;
    const previewUrl = URL.createObjectURL(draft.file);
    setReferenceFiles([{ id: `physical-${draft.file.name}-${draft.file.lastModified}-${draft.file.size}`, file: draft.file, previewUrl }]);
    if (draft.prompt) setPrompt(draft.prompt);
  }, [physicalProduct]);

  useEffect(() => {
    Promise.all([
      authAxios.get("/api/template-studio/catalog?output_type=image&featured_only=true&include_freeform=true&limit=100"),
      authAxios.get("/api/ai/models?output_type=image"),
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
        const rows = normalizeTemplates(sceneResponse.data?.data || []);
        const remix = remixResponse.data?.data?.type === "image" ? remixResponse.data.data : null;
        const requestedTemplate = requestedTemplateResponse.data?.data?.output_type === "image"
          ? normalizeTemplates([requestedTemplateResponse.data.data])[0]
          : null;
        const availableModels = normalizeModelCatalogResponse(
          modelResponse.data,
          FALLBACK_IMAGE_MODELS.map((model_key) => ({ model_key, display_name: model_key })),
        );
        const preferredScene = rows.find((item) => item.scene_key === remix?.scene_key)
          || requestedTemplate
          || rows.find((item) => item.scene_key === requestedTemplateKey)
          || (!requestedTemplateKey && !requestedTemplateId && !requestedRemixId
            ? rows.find((item) => item.scene_key === "freeform_image")
            : null)
          || rows.find((item) => item.is_featured)
          || rows[0];
        setScenes(requestedTemplate && !rows.some((item) => item.scene_key === requestedTemplate.scene_key)
          ? [requestedTemplate, ...rows]
          : rows);
        setImageModels(availableModels);
        setRemixSource(remix);
        applyScene(preferredScene, { adoptStarterPrompt: !requestedPrompt });
        if (requestedPrompt) setPrompt(requestedPrompt);
        else if (remix?.prompt_public && remix.prompt) setPrompt(remix.prompt);
        if (remix?.public_parameters?.visual_parameters) {
          setVisualParameters(remix.public_parameters.visual_parameters);
        }
        if (availableModels.length) {
          const preferredModel = normalizeImageModelId(remix?.public_parameters?.model || preferredScene?.default_model);
          setModel(resolveSupportedModel(availableModels, preferredModel, FALLBACK_IMAGE_MODELS[0]));
        }
      })
      .catch(() => toast.error(t("加载模板或模型失败", "Failed to load templates or models")));
  }, [authAxios, applyScene, requestedRemixId, requestedTemplateId, requestedTemplateKey, requestedPrompt, t]);

  useEffect(() => {
    if (!selectedScene || !imageModels.length) return;
    const preferredModel = normalizeImageModelId(remixSource?.public_parameters?.model || selectedScene.default_model);
    const nextModel = resolveSupportedModel(imageModels, preferredModel, imageModels[0].model_key);
    setModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(imageModels, nextModel),
      outputType: "image",
      fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
    });
    setSize(resolveSupportedValue(
      remixSource?.public_parameters?.size || selectedScene.default_size,
      nextOptions,
      nextOptions[0]?.value,
    ));
  }, [imageModels, remixSource, selectedScene]);

  useEffect(() => {
    if (!templateLaunchKey || !selectedScene || !imageModels.length) return undefined;
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
  }, [imageModels.length, selectedScene, templateLaunchKey]);

  const handleModelChange = (nextModel) => {
    setModel(nextModel);
    const nextOptions = getModelSizeOptions({
      model: getModelByKey(imageModels, nextModel),
      outputType: "image",
      fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
    });
    setSize((current) => resolveSupportedValue(current, nextOptions, nextOptions[0]?.value));
  };

  const estimate = useCallback(() => {
    if (!selectedScene) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const { data } = await authAxios.post("/api/ai/estimate-points", {
          scene_key: selectedScene.scene_key,
          output_type: "image",
          model,
          size,
        });
        setEstimatedPts(data?.data?.estimated_points ?? null);
      } catch {
        // Estimation is best-effort; generation performs authoritative billing.
      }
    }, 350);
  }, [selectedScene, model, size, authAxios]);

  useEffect(() => {
    estimate();
  }, [estimate]);

  useEffect(() => {
    const creationId = result?.creation_id;
    if (!creationId || !["pending", "running", "processing", "in_progress"].includes(result?.status)) {
      return undefined;
    }

    let stopped = false;
    let timer = null;
    const poll = async () => {
      try {
        const { data } = await authAxios.get(`/api/ai/image-status/${encodeURIComponent(creationId)}`);
        if (stopped) return;
        setResult((current) => ({ ...current, ...data }));
        if (data.status === "completed") {
          setGenerationError("");
          if (activeRequestKeyRef.current) {
            clearGenerationRequestKey({ scope: "image", requestKey: activeRequestKeyRef.current });
            activeRequestKeyRef.current = null;
          }
          toast.success(t("图片生成成功", "Image generated"));
          return;
        }
        if (data.status === "failed") {
          const message = getGenerationErrorMessage(data.error_message, t);
          setGenerationError(message);
          if (activeRequestKeyRef.current) {
            clearGenerationRequestKey({ scope: "image", requestKey: activeRequestKeyRef.current });
            activeRequestKeyRef.current = null;
          }
          toast.error(message);
          return;
        }
      } catch {
        // A transient status read failure must not turn an accepted task into a failed generation.
      }
      if (!stopped) timer = window.setTimeout(poll, 3_000);
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [authAxios, result?.creation_id, result?.status, t]);

  const handleFileChange = (event) => {
    if (!supportsReferenceImages) {
      event.target.value = "";
      toast.error(t("当前模型不支持参考图，请选择支持图片编辑的模型", "This model does not support reference images. Choose an image-edit model."));
      return;
    }
    const imageFiles = Array.from(event.target.files || [])
      .filter((file) => file.type.startsWith("image/"));
    if (imageFiles.some(isOversizedReferenceImage)) {
      event.target.value = "";
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
      return;
    }
    const nextFiles = imageFiles
      .slice(0, 4)
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

  const removeReference = (id) => {
    setReferenceFiles((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleGenerate = async () => {
    if (!selectedScene || !prompt.trim()) {
      toast.error(t("请选择生成方式并填写提示词", "Choose a generation mode and enter a prompt"));
      return;
    }
    if (selectedScene.requires_reference && !supportsReferenceImages) {
      toast.error(t("这个模板需要参考图，请改选支持图片编辑的模型", "This template needs a reference image. Choose an image-edit model."));
      return;
    }
    if ((selectedScene.requires_reference || physicalProduct) && referenceFiles.length === 0) {
      toast.error(physicalProduct
        ? t("请先上传要做成实物的照片", "Upload the photo you want to turn into a product first")
        : t("这个模板至少需要上传一张参考图", "This template requires at least one reference image"));
      return;
    }
    if (referenceFiles.length > 0 && !supportsReferenceImages) {
      toast.error(t("当前模型不支持参考图，请移除参考图或更换模型", "This model does not support reference images. Remove the references or choose another model."));
      return;
    }
    if (referenceFiles.some((item) => isOversizedReferenceImage(item.file))) {
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
      return;
    }
    if (generationRequestRef.current) return;

    generationRequestRef.current = true;
    setGenerating(true);
    setResult(null);
    setGenerationError("");
    setResultPreviewOpen(false);
    const requestKey = getGenerationRequestKey({
      scope: "image",
      fingerprint: generationRequestFingerprint({
        sceneKey: selectedScene.scene_key,
        prompt: prompt.trim(),
        model,
        size,
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
      formData.append("model", model);
      formData.append("size", size);
      formData.append("visual_parameters", JSON.stringify(visualParameters));
      referenceFiles.forEach((item) => formData.append("images", item.file));

      const { data } = await authAxios.post("/api/ai/generate-scene-image", formData, {
        headers: { "X-Idempotency-Key": requestKey },
      });
      activeRequestKeyRef.current = requestKey;
      setResult(data);
      if (data.status === "completed") {
        clearGenerationRequestKey({ scope: "image", requestKey });
        activeRequestKeyRef.current = null;
        toast.success(t("图片生成成功", "Image generated"));
      } else if (["pending", "running", "processing", "in_progress"].includes(data.status)) {
        setGenerationError("");
        toast.success(t("图片任务已提交，完成后会自动显示", "Image task submitted; the result will appear automatically"));
      } else {
        const message = getGenerationErrorMessage(data, t);
        clearGenerationRequestKey({ scope: "image", requestKey });
        activeRequestKeyRef.current = null;
        setGenerationError(message);
        toast.error(message);
      }
    } catch (err) {
      if (!shouldKeepGenerationRequestKey(err)) clearGenerationRequestKey({ scope: "image", requestKey });
      const errData = err.response?.data;
      if (errData?.code === "INSUFFICIENT_POINTS") {
        const message = t(`积分不足，需要 ${errData.required_points}，当前 ${errData.available_points}`, `Insufficient points — need ${errData.required_points}, have ${errData.available_points}`);
        setGenerationError(message);
        toast.error(message);
      } else if (errData?.code === "IMAGE_PROVIDER_TEMPORARILY_OVERLOADED") {
        const message = t("图片供应商临时过载，本次未生成图片，积分已退回，请稍后重试。", "The image provider is temporarily overloaded. No image was created and your points were released. Please retry shortly.");
        setGenerationError(message);
        toast.error(message);
      } else if (["EXECUTION_IN_PROGRESS", "EXECUTION_CONCURRENCY_LIMITED"].includes(errData?.code)) {
        const message = t("已有图片任务正在后台生成，请稍候在历史记录中查看结果。", "An image task is already running. Check History for the result shortly.");
        setGenerationError(message);
        toast(message);
      } else {
        const message = getGenerationErrorMessage(err, t);
        setGenerationError(message);
        toast.error(message);
      }
    } finally {
      window.dispatchEvent(new Event("stardraw:points-updated"));
      generationRequestRef.current = false;
      setGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!result?.creation_id) return;
    try {
      const { data } = await authAxios.get(`/api/user/creations/${result.creation_id}/download`);
      if (data?.data?.download_url) {
        const downloadUrl = await resolvePrivateUrl(data.data.download_url);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = `image_${result.creation_id}.jpg`;
        link.click();
      }
    } catch {
      toast.error(t("下载失败", "Download failed"));
    }
  };

  const renderPreview = () => {
    if (generating) {
      return (
        <div className="rounded-3xl p-16 flex flex-col items-center justify-center" style={{ background: ui.surface, border: "1px solid rgba(69,71,75,0.12)" }}>
          <div className="w-16 h-16 rounded-full animate-gold-pulse mb-6" style={{ border: "2px solid #e9c349" }} />
          <p className="font-bold mb-1" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {t("正在生成图片", "Neural Synthesis in Progress")}
          </p>
          <p className="text-sm" style={{ color: ui.faint }}>
            {t("正在按所选模板构建结果…", "Building the selected template output...")}
          </p>
        </div>
      );
    }

    if (result && ["pending", "running", "processing", "in_progress"].includes(result.status)) {
      return (
        <div className="rounded-3xl p-16 flex flex-col items-center justify-center" style={{ background: ui.surface, border: "1px solid rgba(69,71,75,0.12)" }}>
          <div className="w-16 h-16 rounded-full animate-gold-pulse mb-6" style={{ border: "2px solid #e9c349" }} />
          <StatusBadge status={result.status === "pending" ? "pending" : "running"} />
          <p className="mt-5 font-bold mb-1" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {t("图片正在生成", "Your image is being generated")}
          </p>
          <p className="text-sm text-center" style={{ color: ui.faint }}>
            {t("任务已进入后台，完成后会自动显示在这里，也可以在任务中心查看。", "The task is running in the background. It will appear here when ready, and is also available in Task Center.")}
          </p>
        </div>
      );
    }

    if (result?.status === "completed" && result?.content) {
      return (
        <div className="rounded-3xl overflow-hidden" style={{ background: ui.surface }}>
          <div className="relative">
            <button
              type="button"
              onClick={() => setResultPreviewOpen(true)}
              className="group relative block w-full cursor-zoom-in overflow-hidden text-left"
              aria-label={t("放大预览生成图片", "Open generated image preview")}
              title={t("放大预览", "Open preview")}
            >
              <OssImage src={result.content} alt={t("生成结果", "Generated result")} className="w-full object-cover" style={{ maxHeight: 580 }} />
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-200 group-hover:bg-black/20">
                <span className="material-symbols-outlined flex h-11 w-11 scale-90 items-center justify-center rounded-full bg-black/55 text-2xl text-white opacity-0 shadow-lg backdrop-blur-sm transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
                  zoom_in
                </span>
              </span>
            </button>
            <div className="absolute top-4 right-4">
              <StatusBadge status="completed" />
            </div>
          </div>
          <div className="p-6 flex items-center justify-between gap-6">
            <div>
              <p className="font-bold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {selectedScene?.scene_name}
              </p>
              <p className="text-xs mt-1" style={{ color: ui.faint }}>
                {result.points_charged} {t("积分", "pts")} • {t("有效期至", "Expires")} {new Date(result.expires_at).toLocaleDateString(isZh ? "zh-CN" : "en-US")}
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => window.dispatchEvent(new Event("stardraw:open-custom-contact"))}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all hover:opacity-90 active:scale-95"
                style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.primary}` }}
              >
                <span className="material-symbols-outlined text-sm">chat</span>
                {physicalProduct ? t("扫码咨询报价", "Scan for a quote") : t("把这张作品做成实物", "Make this into a product")}
              </button>
              <button
                onClick={handleDownload}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all hover:opacity-90 active:scale-95"
                style={{ background: ui.buttonGradient, color: ui.primaryText, fontFamily: "Manrope, sans-serif" }}
              >
                <span className="material-symbols-outlined text-sm">download</span>
                {t("下载无水印原图", "Download Without Watermark")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (generationError) {
      return (
        <div className="rounded-3xl p-8 text-center" style={{ background: ui.surface, border: `1px solid ${ui.danger}` }}>
          <span className="material-symbols-outlined text-4xl" style={{ color: ui.danger }}>error</span>
          <p className="mt-3 font-extrabold" style={{ color: ui.text }}>
            {t("生成失败，未产生新图片", "Generation failed; no new image was created")}
          </p>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-6" style={{ color: ui.muted }}>
            {generationError}
          </p>
          <p className="mt-4 text-xs font-bold" style={{ color: ui.faint }}>
            {t("模板预览不会被当作本次生成结果展示。", "The template preview is not shown as this generation's result.")}
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-3xl overflow-hidden" style={{ background: ui.surface, border: "1px solid rgba(69,71,75,0.18)" }}>
        <div
          className="relative w-full"
          style={{
            aspectRatio: "16 / 9",
            background: selectedScene?.preview_image_url
              ? undefined
              : ui.surfaceAlt,
          }}
        >
          {selectedScene?.preview_image_url ? (
            <>
              <OssImage src={selectedScene.preview_image_url} authorize={!isAnonymousTemplateAsset(selectedScene)} alt={selectedScene.preview_title || selectedScene.scene_name} className="w-full h-full object-cover" />
              <span className="absolute left-4 top-4 rounded-lg px-3 py-1.5 text-[11px] font-black" style={{ background: ui.overlay, color: ui.text, backdropFilter: "blur(12px)" }}>
                {t("模板预览 · 非生成结果", "Template preview · Not a generated result")}
              </span>
            </>
          ) : (
            <div className="h-full flex items-center justify-center px-10 text-center" style={{ color: ui.faint }}>
              {t("在模板中心上传预览图后，这里会展示模板效果。", "Upload a preview image in Template Studio to showcase this template here.")}
            </div>
          )}
        </div>
        <div className="p-6 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.primarySoft, color: ui.primary }}>
              {selectedScene?.requires_reference ? t("需要参考图", "Reference Required") : t("可直接生成", "Prompt Ready")}
            </span>
            {(Array.isArray(selectedScene?.tags) ? selectedScene.tags : []).map((tag) => (
              <span key={tag} className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.surfaceAlt, color: ui.faint }}>
                {tag}
              </span>
            ))}
          </div>
          <div>
            <p className="text-xl font-extrabold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
              {selectedScene?.preview_title || selectedScene?.scene_name || t("选择一个模板", "Select a template")}
            </p>
            <p className="text-sm mt-2 max-w-3xl" style={{ color: ui.muted, lineHeight: 1.7 }}>
              {selectedScene?.preview_description || t("先选择一个精选模板，再补充描述后直接生成。", "Select a featured template, then adjust the prompt and generate.")}
            </p>
          </div>
          {selectedScene?.starter_prompt && (
            <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt }}>
              <div className="flex items-center justify-between gap-4 mb-2">
                <p className="text-[10px] uppercase tracking-widest font-bold" style={{ color: ui.faint }}>
                  {t("起始提示词", "Starter Prompt")}
                </p>
                <button
                  type="button"
                  onClick={() => setPrompt(selectedScene.starter_prompt || "")}
                  className="text-xs font-bold"
                  style={{ color: ui.primary }}
                >
                  {t("使用这段提示词", "Use This Prompt")}
                </button>
              </div>
              <p className="text-sm" style={{ color: ui.text, lineHeight: 1.7 }}>
                {selectedScene.starter_prompt}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="scene-studio p-10 max-w-[1480px] mx-auto">
      <div className="scene-studio-heading mb-8">
        <h2 className="text-4xl font-extrabold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif", letterSpacing: "-0.02em" }}>
          {physicalProduct ? t("生成你的实物设计预览", "Generate your product design preview") : t("AI 图片生成", "AI Image Generation")}
        </h2>
        <p className="text-lg max-w-3xl" style={{ color: ui.muted, opacity: 0.76 }}>
          {physicalProduct ? t(`已选择：${physicalProduct}。上传照片、确认提示词后生成；满意后点击“扫码咨询报价”。`, `Selected: ${physicalProduct}. Upload your photo, generate, then request a quote.`) : t("可以直接填写提示词自由生成，也可以选择模板快速开始。", "Write your own prompt for a freeform generation, or choose a template to start faster.")}
        </p>
      </div>

      <section className="scene-template-gallery mb-8">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.primary }}>
              {t("精选模板", "Featured Templates")}
            </p>
            <p className="text-sm" style={{ color: ui.faint }}>
              {t("这些模板带预置提示词和预览效果，客户可以直接套用。", "These templates include starter prompts and preview results, ready to use directly.")}
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
              className="scene-template-card group overflow-hidden rounded-3xl text-left transition-all"
              style={{
                background: ui.surface,
                border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.primary : ui.line}`,
                boxShadow: selectedScene?.scene_key === scene.scene_key ? "0 20px 48px rgba(77,112,255,0.12)" : "none",
              }}
            >
              <div
                className="w-full overflow-hidden"
                style={{
                  aspectRatio: "4 / 5",
                  background: scene.preview_image_url
                    ? undefined
                    : ui.surfaceAlt,
                }}
              >
                {scene.preview_image_url ? (
                  <OssImage src={scene.preview_image_url} authorize={!isAnonymousTemplateAsset(scene)} alt={scene.preview_title || scene.scene_name} className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-500" />
                ) : (
                  <div className="h-full flex items-center justify-center text-center px-8" style={{ color: ui.faint }}>
                    {t("暂未上传预览图", "No preview yet")}
                  </div>
                )}
              </div>
              <div className="p-5">
                <div className="flex flex-wrap gap-2 mb-3">
                  <span className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.primarySoft, color: ui.primary }}>
                    {scene.estimated_points ?? "--"} {t("积分", "pts")}
                  </span>
                  <span className="text-[10px] px-2.5 py-1 rounded-full" style={{ background: ui.surfaceAlt, color: scene.requires_reference ? ui.gold : ui.faint }}>
                    {scene.requires_reference ? t("需要图片", "Needs image") : t("仅需提示词", "Prompt only")}
                  </span>
                </div>
                <p className="text-lg font-extrabold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                  {scene.preview_title || scene.scene_name}
                </p>
                <p className="text-sm mb-4" style={{ color: ui.muted, lineHeight: 1.7 }}>
                  {scene.preview_description || t("开箱即用的图片生成模板。", "Ready-to-use image generation template.")}
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs" style={{ color: ui.faint }}>{scene.default_size || "1024x1024"}</span>
                  <span className="text-sm font-bold" style={{ color: ui.primary }}>
                    {t("使用模板", "Use Template")}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      {freeformScenes.length > 0 && (
        <section className="mb-8">
          <div className="mb-4">
            <p className="text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.gold }}>
              {t("自由生成", "Freeform Generation")}
            </p>
            <p className="text-sm" style={{ color: ui.faint }}>
              {t("不套用业务模板，完全按照你填写的提示词生成图片。", "No business template is applied. The image follows your prompt directly.")}
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
                  border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.primary : ui.line}`,
                  boxShadow: selectedScene?.scene_key === scene.scene_key ? ui.shadow : "none",
                }}
              >
                <span>
                  <span className="block text-base font-extrabold" style={{ color: ui.text }}>{scene.preview_title || scene.scene_name}</span>
                  <span className="mt-1 block text-xs" style={{ color: ui.muted }}>{scene.preview_description || t("按自己的提示词生成图片", "Generate from your own prompt")}</span>
                </span>
                <span className="shrink-0 rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>
                  {scene.estimated_points ?? "--"} {t("积分", "pts")}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="scene-studio-grid grid grid-cols-12 gap-8 items-start">
        <section className="col-span-12 xl:col-span-4 space-y-6 xl:sticky xl:top-24">
          <div className="rounded-3xl p-4" style={{ background: ui.surface }}>
            <button
              type="button"
              onClick={() => setTemplateListOpen((current) => !current)}
              className="flex w-full items-center gap-3 text-left"
              aria-expanded={templateListOpen}
            >
              <span className="material-symbols-outlined text-sm" style={{ color: ui.primary }}>layers</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.primary }}>{t("全部模板", "All Templates")}</span>
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
                      border: `1px solid ${selectedScene?.scene_key === scene.scene_key ? ui.primary : ui.line}`,
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate text-xs font-semibold" style={{ color: ui.text }}>{scene.scene_name}</span>
                    {selectedScene?.scene_key === scene.scene_key && <span className="material-symbols-outlined filled ml-2 text-base" style={{ color: ui.primary }}>check_circle</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-3xl p-5" style={{ background: ui.surface }}>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-3" style={{ color: ui.primary }}>
              <span className="material-symbols-outlined text-sm">model_training</span>
              {t("图片模型", "Image Model")}
            </label>
            <CanvasRoundedSelect
              label={t("图片模型", "Image Model")}
              value={model}
              options={imageModels}
              onChange={handleModelChange}
              ui={ui}
              className="w-full"
              triggerClassName="h-12 w-full rounded-2xl px-3 text-sm"
              menuMinWidth={280}
            />
            <p className="mt-2 text-[10px]" style={{ color: supportsReferenceImages ? ui.faint : ui.danger }}>
              {supportsReferenceImages
                ? t("该模型支持参考图编辑。", "This model supports reference-image editing.")
                : t("该模型仅支持文字生成，不支持上传参考图。", "This model is prompt-only and does not accept reference images.")}
            </p>
          </div>

          <div className="rounded-3xl p-5" style={{ background: ui.surface }}>
            <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-3" style={{ color: ui.primary }}>
              <span className="material-symbols-outlined text-sm">aspect_ratio</span>
              {t("输出尺寸", "Output Size")}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {sizeOptions.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => setSize(item.value)}
                  className="p-3 rounded-2xl flex flex-col items-center gap-1 transition-all"
                  style={{
                    background: size === item.value ? ui.surfaceHigh : ui.surfaceAlt,
                    border: `1px solid ${size === item.value ? ui.primary : ui.line}`,
                    color: size === item.value ? ui.primary : ui.faint,
                  }}
                >
                  <span className="text-xs font-bold">{item.label}</span>
                  <span className="text-[9px] opacity-60">{isZh ? item.subZh : item.subEn}</span>
                </button>
              ))}
            </div>
          </div>

          <VisualParameterPicker outputType="image" modelKey={model} value={visualParameters} onChange={setVisualParameters} />

          {estimatedPts !== null && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-2xl" style={{ background: ui.surface }}>
              <span className="material-symbols-outlined text-sm" style={{ color: ui.primary }}>bolt</span>
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>{t("预计消耗", "Estimated Cost")}</p>
                <p className="text-base font-bold" style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>~{estimatedPts} {t("积分", "pts")}</p>
              </div>
            </div>
          )}

          <button
            onClick={handleGenerate}
            disabled={generating || !selectedScene}
            className="w-full py-4 rounded-2xl font-extrabold tracking-tight flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: ui.buttonGradient, color: ui.primaryText, fontFamily: "Manrope, sans-serif", boxShadow: "0 8px 32px rgba(238,157,71,0.14)" }}
          >
            {generating ? (
              <>
                <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                {t("处理中…", "Processing...")}
              </>
            ) : (
              <>
                <span className="material-symbols-outlined">bolt</span>
                {physicalProduct ? t(`生成${physicalProduct}设计预览`, `Generate ${physicalProduct} preview`) : t("生成图片", "GENERATE IMAGE")}
              </>
            )}
          </button>
        </section>

        <section className="col-span-12 xl:col-span-8 space-y-6">
          {renderPreview()}

          <div ref={promptSectionRef} className="rounded-3xl p-6 scroll-mt-24" style={{ background: ui.surface }}>
            {templateLaunchKey && selectedScene && (
              <div className="mb-4 flex min-w-0 items-center gap-2 rounded-xl px-3 py-2" style={{ background: ui.primarySoft, color: ui.primary }}>
                <span className="material-symbols-outlined text-lg">check_circle</span>
                <span className="shrink-0 text-xs font-bold">{t("已应用模板", "Template applied")}</span>
                <span className="truncate text-xs" style={{ color: ui.text }}>{selectedScene.preview_title || selectedScene.scene_name}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.primary }}>
                  <span className="material-symbols-outlined text-sm">edit_note</span>
                  {t("提示词补充", "Prompt Details")}
                </label>
                <p className="text-xs" style={{ color: ui.faint }}>
                  {t("系统会自动在前面拼接模板系统提示词。这里填写客户可见的补充描述。", "The template system prompt is prepended automatically. Add the customer-facing details here.")}
                </p>
              </div>
              {selectedScene?.starter_prompt && (
                <button
                  type="button"
                  onClick={() => setPrompt(selectedScene.starter_prompt || "")}
                  className="px-4 py-2 rounded-xl text-sm font-bold"
                  style={{ background: ui.surfaceAlt, color: ui.primary, border: "1px solid rgba(238,157,71,0.20)" }}
                >
                  {t("恢复起始提示词", "Reset to Starter Prompt")}
                </button>
              )}
              <button
                type="button"
                onClick={optimizePrompt}
                disabled={optimizingPrompt}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold disabled:cursor-wait disabled:opacity-60"
                style={{ background: ui.goldSoft, color: ui.gold, border: "1px solid rgba(233,195,73,0.22)" }}
              >
                {optimizingPrompt && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                {optimizingPrompt ? t("AI 优化中…", "Improving…") : t("优化提示词", "Optimize Prompt")}
              </button>
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={selectedScene?.placeholder_text || t("描述你想生成的内容…", "Describe what you want to generate...")}
              rows={6}
              className="w-full resize-none text-sm outline-none rounded-2xl p-4"
              style={{ background: ui.surfaceAlt, color: ui.text, border: "1px solid rgba(69,71,75,0.25)", fontFamily: "Inter, sans-serif", lineHeight: 1.7 }}
            />
            <div className="flex justify-between items-center mt-2">
              <p className="text-[10px]" style={{ color: ui.faint }}>
                {selectedScene?.requires_reference ? t("该模板需要先上传参考图才能生成。", "This template needs reference images before generation.") : t("支持仅通过提示词直接生成。", "Prompt-only generation is supported.")}
              </p>
              <span className="text-[10px]" style={{ color: ui.faint }}>{prompt.length} {t("字", "chars")}</span>
            </div>
          </div>

          <div className="rounded-3xl p-6" style={{ background: ui.surface }}>
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <label className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: ui.primary }}>
                  <span className="material-symbols-outlined text-sm">imagesmode</span>
                  {t("参考图片", "Reference Images")}
                </label>
                <p className="text-xs" style={{ color: ui.faint }}>
                  {t(`最多上传 4 张图片，单张不能超过 ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB。需要参考图的模板在上传前不会开始生成。`, `Upload up to 4 images, ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB per image. Required templates will not generate until you provide references.`)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!supportsReferenceImages}
                className="px-4 py-2 rounded-xl text-sm font-bold"
                style={{ background: ui.surfaceAlt, color: supportsReferenceImages ? ui.primary : ui.faint, border: `1px solid ${ui.line}`, opacity: supportsReferenceImages ? 1 : 0.55 }}
              >
                {t("上传图片", "Upload Images")}
              </button>
            </div>

            <input ref={fileInputRef} type="file" accept="image/*" multiple disabled={!supportsReferenceImages} onChange={handleFileChange} className="hidden" />

            {referenceFiles.length === 0 ? (
              <div className="rounded-2xl px-4 py-8 text-center" style={{ background: ui.surfaceAlt, border: `1px dashed ${selectedScene?.requires_reference ? ui.gold : ui.primarySoft}` }}>
                <p className="text-sm" style={{ color: ui.muted }}>
                  {selectedScene?.requires_reference ? t("这个模板正在等待参考图。", "This template is waiting for reference images.") : t("尚未选择参考图。", "No reference images selected.")}
                </p>
                <p className="text-[11px] mt-1" style={{ color: ui.faint }}>
                  {selectedScene?.requires_reference ? t("至少上传一张图片后才能生成。", "Upload at least one image to unlock generation.") : t("留空则使用纯提示词生成。", "Leave empty to use prompt-only generation.")}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {referenceFiles.map((item) => (
                  <div key={item.id} className="rounded-2xl overflow-hidden" style={{ background: ui.surfaceAlt, border: "1px solid rgba(69,71,75,0.25)" }}>
                    <div className="relative" style={{ aspectRatio: "1 / 1" }}>
                      <img src={item.previewUrl} alt={item.file.name} className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeReference(item.id)}
                        className="absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center"
                        style={{ background: ui.overlay, color: ui.text }}
                      >
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
        </section>
      </div>

      {resultPreviewOpen && result?.status === "completed" && result?.content && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4 backdrop-blur-md md:p-8"
          role="dialog"
          aria-modal="true"
          aria-label={t("生成图片放大预览", "Generated image preview")}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setResultPreviewOpen(false);
          }}
        >
          <OssImage
            src={result.content}
            alt={t("生成结果放大预览", "Generated result enlarged preview")}
            className="max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] select-none object-contain shadow-2xl md:max-h-[calc(100vh-4rem)] md:max-w-[calc(100vw-4rem)]"
          />
          <button
            type="button"
            onClick={() => setResultPreviewOpen(false)}
            className="absolute right-4 top-4 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white shadow-lg backdrop-blur-md transition-colors hover:bg-black/80 md:right-6 md:top-6"
            aria-label={t("关闭预览", "Close preview")}
            title={t("关闭预览", "Close preview")}
          >
            <span className="material-symbols-outlined text-2xl">close</span>
          </button>
        </div>
      )}
    </div>
  );
};

export default SceneImage;
