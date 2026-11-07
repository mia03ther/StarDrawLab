import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import {
  clearGenerationRequestKey,
  generationRequestFingerprint,
  getGenerationRequestKey,
  shouldKeepGenerationRequestKey,
} from "../utils/generationRequestIdentity";
import { isAnonymousTemplateAsset, normalizeTemplates } from "../utils/templateData";

const ASPECT_RATIOS = [
  { value: "16:9", label: "16:9", zh: "横版讲解", en: "Landscape" },
  { value: "9:16", label: "9:16", zh: "竖版口播", en: "Short video" },
  { value: "auto", label: "AUTO", zh: "自动匹配", en: "Auto" },
];

const DURATION_OPTIONS = [
  { value: 15, label: "15s", zh: "短口播", en: "Short" },
  { value: 30, label: "30s", zh: "标准讲解", en: "Standard" },
  { value: 60, label: "60s", zh: "完整说明", en: "Full" },
  { value: 90, label: "90s", zh: "长讲解", en: "Long" },
];

const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 300;

const briefPresets = [
  {
    key: "product",
    icon: "inventory_2",
    zh: "产品介绍",
    en: "Product Intro",
    promptZh: "一位专业数字人主持人，用 30 秒介绍我们的产品亮点、适用人群和购买建议。语气可信、简洁、有行动号召。",
    promptEn: "A professional digital presenter introduces our product highlights, target audience, and purchase recommendation in 30 seconds. Keep it credible, concise, and action-oriented.",
  },
  {
    key: "training",
    icon: "school",
    zh: "培训说明",
    en: "Training",
    promptZh: "一位亲和的数字人讲师，用清晰步骤讲解一个培训主题。包含开场、3 个重点、结尾复盘。",
    promptEn: "A warm digital instructor explains a training topic with clear steps. Include an opening, three key points, and a recap.",
  },
  {
    key: "sales",
    icon: "campaign",
    zh: "销售话术",
    en: "Sales Pitch",
    promptZh: "一位商务数字人面向潜在客户进行销售讲解，先指出痛点，再说明方案价值，最后邀请预约咨询。",
    promptEn: "A business presenter speaks to prospects: identify the pain point, explain the solution value, then invite them to book a consultation.",
  },
];

const ProgressBar = ({ value, ui }) => (
  <div className="h-1.5 w-full rounded-full" style={{ background: ui.surfaceAlt }}>
    <div
      className="h-full rounded-full transition-all duration-700"
      style={{ width: `${Math.max(0, Math.min(100, value || 0))}%`, background: ui.buttonGradient }}
    />
  </div>
);

const isDigitalHumanTemplate = (template) =>
  String(template?.provider || template?.target_provider || "").trim().toLowerCase() === "heygen_video_agent";

const DigitalHuman = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const requestedTemplateKey = searchParams.get("template")?.trim() || "";
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const pollRef = useRef(null);
  const submissionRequestRef = useRef(false);

  const [brief, setBrief] = useState("");
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [selectedDurationSeconds, setSelectedDurationSeconds] = useState(null);
  const [customDurationInput, setCustomDurationInput] = useState("");
  const [estimatedPts, setEstimatedPts] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [creationId, setCreationId] = useState(null);
  const [pollData, setPollData] = useState(null);
  const [recent, setRecent] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [roles, setRoles] = useState([]);
  const [selectedRoleId, setSelectedRoleId] = useState("");
  const [rolePickerOpen, setRolePickerOpen] = useState(false);
  const [selectedSceneKey, setSelectedSceneKey] = useState("heygen_digital_human_video");

  const isBusy = pollData && !["completed", "failed"].includes(pollData.status);
  const isDone = pollData?.status === "completed" && pollData.content;
  const isFailed = pollData?.status === "failed";
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.scene_key === selectedSceneKey) || templates[0] || null,
    [selectedSceneKey, templates],
  );
  const selectedRole = useMemo(
    () => roles.find((item) => String(item.id) === String(selectedRoleId)) || null,
    [roles, selectedRoleId],
  );
  const durationSeconds = Number(selectedDurationSeconds || selectedTemplate?.default_seconds || 30);
  const model = selectedTemplate?.default_model || "video-agent";
  const pointsPerMinute = Number(selectedTemplate?.points_per_minute || 200);
  const billingLabel = selectedTemplate?.billing_type === "per_minute"
    ? t(`${pointsPerMinute} 积分/分钟`, `${pointsPerMinute} pts/min`)
    : t("固定扣费", "Fixed cost");
  const durationLabel = t(`${durationSeconds} 秒`, `${durationSeconds}s`);
  const isPresetDuration = DURATION_OPTIONS.some((item) => item.value === durationSeconds);
  const selectedRoleLabel = selectedRole?.role_name || t("默认数字人", "Default presenter");
  const selectedRoleStatusLabel = selectedRole
    ? (selectedRole.status === "ready" ? t("可用", "Ready") : t("形象创建中", "Preparing"))
    : t("模板形象", "Template portrait");
  const generationPosterUrl = selectedRole?.avatar_url || pollData?.thumbnail_url || selectedTemplate?.preview_image_url || "";
  const generationPosterAuthorize = Boolean(selectedRole?.avatar_url || pollData?.thumbnail_url)
    || !isAnonymousTemplateAsset(selectedTemplate);
  const rolePreviewItems = useMemo(() => [
    { id: "", role_name: t("默认形象", "Default"), avatar_url: null, status: "ready", isDefault: true },
    ...roles.slice(0, 2),
  ], [roles, t]);
  const hasPendingRole = useMemo(
    () => roles.some((role) => role.status === "collecting" || role.status === "training"),
    [roles],
  );

  const formatTemplateBilling = useCallback((template) => {
    const perMinute = Number(template?.points_per_minute || 0);
    if (template?.billing_type === "per_minute" && perMinute > 0) {
      return t(`${perMinute} 积分/分钟`, `${perMinute} pts/min`);
    }
    const points = template?.estimated_points ?? "--";
    return t(`${points} 积分`, `${points} pts`);
  }, [t]);

  const statusLabel = useMemo(() => {
    const status = pollData?.status;
    if (status === "completed") return t("已完成", "Completed");
    if (status === "failed") return t("失败", "Failed");
    if (status === "running") return t("生成中", "Generating");
    if (status === "pending") return t("排队中", "Queued");
    return t("待提交", "Ready");
  }, [pollData?.status, t]);

  const loadRecent = useCallback(() => {
    authAxios
      .get("/api/user/get-user-creations?page_size=6&type=video&status=completed")
      .then((res) => {
        const list = Array.isArray(res.data?.creations) ? res.data.creations : [];
        setRecent(list.filter((item) => item.provider === "heygen_video_agent"));
      })
      .catch(() => {});
  }, [authAxios]);

  useEffect(() => {
    authAxios.get("/api/ai/scenes?output_type=video")
      .then((res) => {
        const rows = normalizeTemplates(res.data?.data || []).filter(isDigitalHumanTemplate);
        const preferredTemplate = rows.find((item) => item.scene_key === requestedTemplateKey)
          || rows.find((item) => item.scene_key === "heygen_digital_human_video")
          || rows[0];
        const defaultSeconds = Number(preferredTemplate?.default_seconds || 30);
        setTemplates(rows);
        if (preferredTemplate) {
          setSelectedSceneKey(preferredTemplate.scene_key);
          setSelectedDurationSeconds(defaultSeconds);
          setCustomDurationInput(String(defaultSeconds));
          if (requestedTemplateKey && preferredTemplate.starter_prompt) {
            setBrief(preferredTemplate.starter_prompt);
          }
          if (["16:9", "9:16", "auto"].includes(preferredTemplate.default_size)) {
            setAspectRatio(preferredTemplate.default_size);
          }
        }
      })
      .catch(() => toast.error(t("加载数字人模板失败", "Failed to load digital human templates")));
  }, [authAxios, requestedTemplateKey, t]);

  useEffect(() => {
    if (!selectedTemplate) return;
    authAxios
      .post("/api/ai/estimate-points", {
        scene_key: selectedTemplate.scene_key,
        output_type: "video",
        model,
        seconds: durationSeconds,
        size: aspectRatio,
      })
      .then((res) => setEstimatedPts(res.data?.data?.estimated_points ?? null))
      .catch(() => setEstimatedPts(null));
  }, [authAxios, aspectRatio, durationSeconds, model, selectedTemplate]);

  useEffect(() => {
    loadRecent();
    return () => clearInterval(pollRef.current);
  }, [loadRecent]);

  const loadRoles = useCallback(() => {
    authAxios.get("/api/digital-human/roles")
      .then((res) => {
        const rows = Array.isArray(res.data?.data) ? res.data.data : [];
        setRoles(rows);
        setSelectedRoleId((current) => current && rows.some((item) => String(item.id) === String(current)) ? current : "");
      })
      .catch(() => {});
  }, [authAxios]);

  useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  useEffect(() => {
    if (!hasPendingRole) return undefined;
    const timer = setInterval(loadRoles, 6000);
    return () => clearInterval(timer);
  }, [hasPendingRole, loadRoles]);

  const startPoll = useCallback((id) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const { data } = await authAxios.get(`/api/ai/video-status/${id}`);
        setPollData(data);
        if (data.status === "completed" || data.status === "failed") {
          clearInterval(pollRef.current);
          window.dispatchEvent(new Event("stardraw:points-updated"));
          if (data.status === "completed") {
            toast.success(t("数字人视频已生成", "Digital human video ready"));
            loadRecent();
          } else {
            toast.error(data.error_message || t("数字人视频生成失败", "Digital human video failed"));
          }
        }
      } catch {
        return;
      }
    }, 4000);
  }, [authAxios, loadRecent, t]);

  const handleSubmit = async () => {
    const trimmed = brief.trim();
    if (!trimmed) {
      toast.error(t("请先填写数字人讲解内容", "Enter the presenter brief first"));
      return;
    }
    if (!selectedTemplate) {
      toast.error(t("请先选择数字人模板", "Select a digital human template first"));
      return;
    }
    if (selectedRole && selectedRole.status !== "ready") {
      toast.error(t("数字人形象还在创建中，请稍后再生成", "The presenter portrait is still being prepared. Try again shortly."));
      return;
    }
    if (submissionRequestRef.current) return;

    submissionRequestRef.current = true;
    setSubmitting(true);
    setCreationId(null);
    setPollData(null);
    const requestKey = getGenerationRequestKey({
      scope: "digital-human",
      fingerprint: generationRequestFingerprint({
        sceneKey: selectedTemplate?.scene_key || "heygen_digital_human_video",
        prompt: trimmed,
        model,
        seconds: durationSeconds,
        size: aspectRatio,
        roleId: selectedRole?.id || null,
      }),
    });

    try {
      const { data } = await authAxios.post("/api/ai/generate-digital-human", {
        scene_key: selectedTemplate?.scene_key || "heygen_digital_human_video",
        user_prompt: trimmed,
        model,
        seconds: durationSeconds,
        size: aspectRatio,
        role_id: selectedRole?.id || null,
      }, {
        headers: { "X-Idempotency-Key": requestKey },
      });
      clearGenerationRequestKey({ scope: "digital-human", requestKey });

      if (!data?.success) {
        toast.error(data?.message || t("提交失败", "Submission failed"));
        return;
      }

      setCreationId(data.creation_id);
      setPollData(data);
      window.dispatchEvent(new Event("stardraw:points-updated"));
      toast(t("数字人任务已提交", "Digital human task submitted"), { icon: "person" });
      startPoll(data.creation_id);
    } catch (err) {
      if (!shouldKeepGenerationRequestKey(err)) clearGenerationRequestKey({ scope: "digital-human", requestKey });
      const data = err.response?.data;
      if (data?.code === "INSUFFICIENT_POINTS") {
        toast.error(isZh ? `积分不足，需要 ${data.required_points}，当前 ${data.available_points}` : `Insufficient points. Need ${data.required_points}, have ${data.available_points}`);
      } else if (["EXECUTION_IN_PROGRESS", "EXECUTION_CONCURRENCY_LIMITED"].includes(data?.code)) {
        toast(t("已有数字人任务正在后台运行，请稍候查看。", "A presenter task is already running. Check back shortly."));
      } else {
        toast.error(data?.message || t("提交失败", "Submission failed"));
      }
    } finally {
      window.dispatchEvent(new Event("stardraw:points-updated"));
      submissionRequestRef.current = false;
      setSubmitting(false);
    }
  };

  const handleDownload = async (id = creationId) => {
    if (!id) return;
    try {
      const { data } = await authAxios.get(`/api/user/creations/${id}/download`);
      const url = data?.data?.download_url;
      if (!url) throw new Error("No download URL");
      const downloadUrl = await resolvePrivateUrl(url);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `digital_human_${id}.mp4`;
      link.click();
    } catch {
      toast.error(t("下载失败", "Download failed"));
    }
  };

  const applyCustomDuration = () => {
    const parsed = Math.round(Number(customDurationInput));
    if (!Number.isFinite(parsed)) {
      toast.error(t("请输入有效的视频时长", "Enter a valid duration"));
      return;
    }

    const nextDuration = Math.max(MIN_DURATION_SECONDS, Math.min(MAX_DURATION_SECONDS, parsed));
    setSelectedDurationSeconds(nextDuration);
    setCustomDurationInput(String(nextDuration));

    if (nextDuration !== parsed) {
      toast(t(`已限制在 ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} 秒范围内`, `Limited to ${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} seconds`), { icon: "timer" });
    }
  };

  const applyPreset = (preset) => {
    const nextBrief = isZh ? preset.promptZh : preset.promptEn;
    setBrief(nextBrief
      .replace(/30 秒/g, `${durationSeconds} 秒`)
      .replace(/30 seconds/g, `${durationSeconds} seconds`)
    );
  };

  const optimizeBrief = async () => {
    const base = brief.trim();
    if (!base) {
      toast.error(t("请先填写主题", "Enter a topic first"));
      return;
    }

    setOptimizing(true);
    try {
      const operationKey = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const { data } = await authAxios.post("/api/ai/optimize-digital-human-script", {
        brief: base,
        language: isZh ? "zh" : "en",
        duration_seconds: durationSeconds,
      }, {
        headers: { "X-Idempotency-Key": `script-optimizer:${operationKey}` },
      });

      const optimized = data?.data?.optimized || "";
      if (!data?.success || !optimized.trim()) {
        throw new Error(data?.message || "Empty optimized script");
      }

      setBrief(optimized.trim());
      toast.success(t("口播已优化", "Script improved"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("优化失败", "Optimization failed"));
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <div className="p-8 max-w-[1440px] mx-auto">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.22em] font-black mb-2" style={{ color: ui.gold }}>
            Digital Human Studio
          </p>
          <h2 className="text-4xl font-extrabold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {t("数字人视频", "Digital Human Video")}
          </h2>
          <p className="text-sm max-w-2xl" style={{ color: ui.muted, lineHeight: 1.8 }}>
            {t("输入讲解主题，自动生成数字人脚本、形象和声音，并渲染成可下载视频。", "Enter a presenter brief. HeyGen scripts, casts, voices, and renders a downloadable video.")}
          </p>
        </div>

        <div className="rounded-2xl px-4 py-3 flex items-center gap-3" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
          <span className="material-symbols-outlined" style={{ color: ui.gold }}>bolt</span>
          <div>
            <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
              {t(`本次预计扣费（${durationLabel}）`, `Estimated for ${durationLabel}`)}
            </p>
            <p className="text-sm font-bold" style={{ color: ui.text }}>{estimatedPts ?? "--"} {t("积分", "pts")}</p>
            <p className="text-[11px] mt-0.5" style={{ color: ui.faint }}>
              {billingLabel} · {t("角色创建免费", "Role creation free")}
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6 items-start">
        <section className="col-span-12 xl:col-span-5 space-y-5">
          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest font-black mb-4" style={{ color: ui.gold }}>
              {t("数字人模板", "Digital Human Template")}
            </p>
            <div className="space-y-2">
              {templates.length === 0 ? (
                <div className="rounded-2xl px-4 py-5 text-sm text-center" style={{ background: ui.surfaceAlt, color: ui.faint }}>
                  {t("暂无数字人模板，请先到模板中心添加。", "No digital human templates yet. Add one in Template Studio first.")}
                </div>
              ) : templates.map((template) => (
                <button
                  key={template.scene_key}
                  type="button"
                  onClick={() => {
                    setSelectedSceneKey(template.scene_key);
                    const templateSeconds = Number(template.default_seconds || 30);
                    setSelectedDurationSeconds(templateSeconds);
                    setCustomDurationInput(String(templateSeconds));
                    if (!brief.trim() && template.starter_prompt) setBrief(template.starter_prompt);
                    if (template.default_size && ["16:9", "9:16", "auto"].includes(template.default_size)) {
                      setAspectRatio(template.default_size);
                    }
                  }}
                  className="w-full rounded-2xl px-4 py-3 text-left transition-all"
                  style={{
                    background: selectedTemplate?.scene_key === template.scene_key ? ui.surfaceHigh : ui.surfaceAlt,
                    border: `1px solid ${selectedTemplate?.scene_key === template.scene_key ? ui.gold : ui.line}`,
                  }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold truncate" style={{ color: ui.text }}>
                        {template.preview_title || template.scene_name}
                      </p>
                      <p className="text-[11px] mt-1 line-clamp-2" style={{ color: ui.faint }}>
                        {template.preview_description || template.scene_key}
                      </p>
                    </div>
                    <span className="text-[10px] px-2 py-1 rounded-full flex-shrink-0" style={{ background: ui.goldSoft, color: ui.gold }}>
                      {formatTemplateBilling(template)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] uppercase tracking-widest font-black" style={{ color: ui.gold }}>
                {t("数字人形象", "Presenter Portrait")}
              </p>
              <button
                type="button"
                onClick={() => navigate("/ai/digital-human-roles")}
                className="text-xs font-bold"
                style={{ color: ui.primary }}
              >
                {t("创建角色", "Create Role")}
              </button>
            </div>

            <button
              type="button"
              onClick={() => setRolePickerOpen(true)}
              className="w-full rounded-2xl p-3 text-left transition-all active:scale-[0.99]"
              style={{ background: ui.surfaceAlt, border: `1px solid ${ui.lineStrong}`, boxShadow: ui.shadow }}
            >
              <div className="flex items-center gap-3">
                <div
                  className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-2xl flex items-center justify-center"
                  style={{ background: ui.surface, border: `1px solid ${ui.line}` }}
                >
                  {selectedRole?.avatar_url ? (
                    <OssImage src={selectedRole.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <span className="material-symbols-outlined text-3xl" style={{ color: ui.primary }}>co_present</span>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-black uppercase tracking-widest" style={{ color: ui.gold }}>
                    {t("选择数字人形象", "Choose presenter portrait")}
                  </p>
                  <p className="mt-1 truncate text-base font-black" style={{ color: ui.text }}>
                    {selectedRoleLabel}
                  </p>
                  <p className="mt-0.5 text-xs" style={{ color: ui.faint }}>
                    {selectedRoleStatusLabel}
                  </p>
                </div>
                <span className="material-symbols-outlined" style={{ color: ui.faint }}>expand_more</span>
              </div>
            </button>

            <div className="mt-3 grid grid-cols-3 gap-2">
              {rolePreviewItems.map((role) => {
                const active = role.isDefault ? !selectedRoleId : String(selectedRoleId) === String(role.id);
                return (
                  <button
                    key={role.isDefault ? "default" : role.id}
                    type="button"
                    onClick={() => {
                      if (role.isDefault) {
                        setSelectedRoleId("");
                      } else {
                        setSelectedRoleId(role.id);
                      }
                    }}
                    className="rounded-xl p-2 text-center transition-all active:scale-[0.98]"
                    style={{
                      background: active ? ui.surfaceHigh : ui.surfaceAlt,
                      border: `1px solid ${active ? ui.gold : ui.line}`,
                    }}
                  >
                    <div className="mx-auto h-16 w-full overflow-hidden rounded-lg flex items-center justify-center" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
                      {role.avatar_url ? (
                        <OssImage src={role.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined" style={{ color: role.isDefault ? ui.primary : ui.faint }}>
                          {role.isDefault ? "co_present" : "portrait"}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 truncate text-[11px] font-bold" style={{ color: ui.text }}>
                      {role.role_name}
                    </p>
                  </button>
                );
              })}
            </div>

            <p className="mt-3 text-[11px]" style={{ color: ui.faint }}>
              {t("可使用默认形象，也可以在角色库上传自己的形象图。", "Use the default portrait or upload your own in Roles.")}
            </p>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center justify-between mb-4">
              <label className="text-[10px] uppercase tracking-widest font-black" style={{ color: ui.gold }}>
                {t("讲解 Brief", "Presenter Brief")}
              </label>
              <button type="button" onClick={optimizeBrief} disabled={optimizing}
                className="px-3 py-2 rounded-xl text-xs font-bold disabled:opacity-45 disabled:cursor-not-allowed"
                style={{ background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.line}` }}>
                {optimizing ? t("优化中…", "Improving…") : t("优化口播", "Improve Script")}
              </button>
            </div>
            <textarea
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
              rows={11}
              placeholder={t(`例如：面向跨境电商卖家，用 ${durationSeconds} 秒介绍 StarDraw 如何快速生成商品图、短视频和画布资产...`, `Example: For ecommerce sellers, explain in ${durationSeconds} seconds how StarDraw quickly creates product images, short videos, and canvas assets...`)}
              className="w-full resize-none rounded-2xl p-4 outline-none text-sm"
              style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}`, lineHeight: 1.8 }}
            />
            <div className="mt-3 flex items-center justify-between text-[11px]" style={{ color: ui.faint }}>
              <span>{t("建议包含：受众、主题、语气、关键卖点、行动号召", "Include audience, topic, tone, key points, and call to action")}</span>
              <span>{brief.length} {t("字", "chars")}</span>
            </div>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest font-black mb-4" style={{ color: ui.gold }}>
              {t("常用场景", "Presets")}
            </p>
            <div className="grid sm:grid-cols-3 gap-3">
              {briefPresets.map((preset) => (
                <button key={preset.key} type="button" onClick={() => applyPreset(preset)}
                  className="rounded-2xl p-4 text-left transition-all active:scale-95"
                  style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                  <span className="material-symbols-outlined mb-3 block" style={{ color: ui.primary }}>{preset.icon}</span>
                  <span className="text-sm font-bold" style={{ color: ui.text }}>
                    {isZh ? preset.zh : preset.en}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest font-black mb-4" style={{ color: ui.gold }}>
              {t("视频时长", "Duration")}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {DURATION_OPTIONS.map((item) => (
                <button key={item.value} type="button" onClick={() => {
                  setSelectedDurationSeconds(item.value);
                  setCustomDurationInput("");
                }}
                  className="rounded-2xl px-3 py-4 text-center transition-all active:scale-95"
                  style={{
                    background: durationSeconds === item.value ? ui.surfaceHigh : ui.surfaceAlt,
                    border: `1px solid ${durationSeconds === item.value ? ui.gold : ui.line}`,
                    color: durationSeconds === item.value ? ui.gold : ui.muted,
                  }}>
                  <p className="text-sm font-black">{item.label}</p>
                  <p className="text-[10px] mt-1 opacity-70">{isZh ? item.zh : item.en}</p>
                </button>
              ))}
            </div>
            <div
              className="mt-3 rounded-2xl px-3 py-3 flex flex-col sm:flex-row sm:items-center gap-3"
              style={{
                background: !isPresetDuration ? ui.surfaceHigh : ui.surfaceAlt,
                border: `1px solid ${!isPresetDuration ? ui.gold : ui.line}`,
              }}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <span className="material-symbols-outlined text-base" style={{ color: !isPresetDuration ? ui.gold : ui.faint }}>timer</span>
                <div className="min-w-0">
                  <p className="text-xs font-bold" style={{ color: ui.text }}>{t("自定义时长", "Custom duration")}</p>
                  <p className="text-[10px]" style={{ color: ui.faint }}>
                    {t(`${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS} 秒，按分钟折算积分`, `${MIN_DURATION_SECONDS}-${MAX_DURATION_SECONDS}s, billed proportionally`)}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 sm:w-[190px]">
                <input
                  type="number"
                  min={MIN_DURATION_SECONDS}
                  max={MAX_DURATION_SECONDS}
                  step="1"
                  value={customDurationInput}
                  onChange={(event) => setCustomDurationInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyCustomDuration();
                  }}
                  placeholder={String(durationSeconds)}
                  className="w-full rounded-xl px-3 py-2 text-sm font-bold outline-none"
                  style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
                />
                <span className="text-xs" style={{ color: ui.faint }}>{t("秒", "s")}</span>
                <button
                  type="button"
                  onClick={applyCustomDuration}
                  className="px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap"
                  style={{ background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.line}` }}
                >
                  {t("应用", "Apply")}
                </button>
              </div>
            </div>
            <p className="text-[11px] mt-3" style={{ color: ui.faint }}>
              {t(`按 ${pointsPerMinute} 积分/分钟计费，当前预计 ${estimatedPts ?? "--"} 积分。`, `Billed at ${pointsPerMinute} pts/min. Current estimate: ${estimatedPts ?? "--"} pts.`)}
            </p>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest font-black mb-4" style={{ color: ui.gold }}>
              {t("视频比例", "Aspect Ratio")}
            </p>
            <div className="grid grid-cols-3 gap-3">
              {ASPECT_RATIOS.map((item) => (
                <button key={item.value} type="button" onClick={() => setAspectRatio(item.value)}
                  className="rounded-2xl px-3 py-4 text-center transition-all active:scale-95"
                  style={{
                    background: aspectRatio === item.value ? ui.surfaceHigh : ui.surfaceAlt,
                    border: `1px solid ${aspectRatio === item.value ? ui.gold : ui.line}`,
                    color: aspectRatio === item.value ? ui.gold : ui.muted,
                  }}>
                  <p className="text-sm font-black">{item.label}</p>
                  <p className="text-[10px] mt-1 opacity-70">{isZh ? item.zh : item.en}</p>
                </button>
              ))}
            </div>
          </div>

          <button type="button" onClick={handleSubmit} disabled={submitting || isBusy}
            className="w-full rounded-2xl py-4 flex items-center justify-center gap-2 font-black transition-all active:scale-[0.98] disabled:opacity-45 disabled:cursor-not-allowed"
            style={{ background: ui.buttonGradient, color: ui.primaryText, fontFamily: "Manrope, sans-serif" }}>
            {submitting
              ? <><span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />{t("提交中", "Submitting")}</>
              : <><span className="material-symbols-outlined">record_voice_over</span>{t("生成数字人视频", "Generate Presenter Video")}</>}
          </button>
        </section>

        <section className="col-span-12 xl:col-span-7 space-y-5">
          <div className="rounded-2xl overflow-hidden" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="p-5 flex items-center justify-between gap-4" style={{ borderBottom: `1px solid ${ui.line}` }}>
              <div>
                <p className="text-[10px] uppercase tracking-widest" style={{ color: ui.faint }}>
                  {creationId ? `#${creationId}` : t("生成预览", "Generation Preview")}
                </p>
                <p className="text-lg font-black mt-1" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                  {statusLabel}
                </p>
              </div>
              <span className="px-3 py-1.5 rounded-full text-[11px] font-bold" style={{ background: ui.surfaceAlt, color: isFailed ? ui.danger : ui.gold }}>
                {pollData?.provider_status || t("数字人", "Presenter")}
              </span>
            </div>

            <div className="p-5">
              {pollData && <ProgressBar value={pollData.progress ?? (isBusy ? 35 : 0)} ui={ui} />}

              <div className="mt-5 rounded-2xl overflow-hidden flex items-center justify-center"
                style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, aspectRatio: aspectRatio === "9:16" ? "9 / 16" : "16 / 9", maxHeight: 520 }}>
                {isDone ? (
                  <OssVideo
                    key={pollData.content}
                    controls
                    playsInline
                    preload="metadata"
                    poster={generationPosterUrl || undefined}
                    authorizePoster={generationPosterAuthorize}
                    src={pollData.content}
                    className="w-full h-full object-contain"
                    style={{ background: ui.surfaceAlt }}
                    onError={() => toast.error(t("视频预览加载失败，可先下载后播放", "Video preview failed. Try downloading it."))}
                  />
                ) : isFailed ? (
                  <div className="text-center px-8">
                    <span className="material-symbols-outlined text-5xl mb-3 block" style={{ color: ui.danger }}>error</span>
                    <p className="font-bold" style={{ color: ui.danger }}>{t("生成失败", "Generation failed")}</p>
                    <p className="text-sm mt-2" style={{ color: ui.faint }}>{pollData.error_message || t("积分已退回账户。", "Reserved points have been returned.")}</p>
                  </div>
                ) : isBusy ? (
                  <div className="text-center px-8">
                    <div className="w-12 h-12 rounded-full border-2 border-t-transparent animate-spin mx-auto mb-4" style={{ borderColor: ui.gold, borderTopColor: "transparent" }} />
                    <p className="font-bold" style={{ color: ui.text }}>{t("正在生成数字人视频", "Rendering the presenter video")}</p>
                    <p className="text-sm mt-2" style={{ color: ui.faint }}>{t("页面会每 4 秒自动查询一次结果。", "This page checks the result every 4 seconds.")}</p>
                  </div>
                ) : (
                  <div className="text-center px-8">
                    <span className="material-symbols-outlined text-6xl mb-4 block" style={{ color: ui.primary }}>co_present</span>
                    <p className="font-black text-lg" style={{ color: ui.text }}>{t("数字人预览区", "Presenter Preview")}</p>
                    <p className="text-sm mt-2" style={{ color: ui.faint }}>{t("填写 Brief 后点击生成，完成后可在这里预览和下载。", "Write a brief and generate. Preview and download will appear here.")}</p>
                  </div>
                )}
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" onClick={() => handleDownload()} disabled={!isDone}
                  className="px-5 py-3 rounded-xl text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: ui.surfaceRaised, color: ui.text, border: `1px solid ${ui.line}` }}>
                  <span className="material-symbols-outlined text-sm align-[-2px] mr-2">download</span>
                  {t("下载视频", "Download Video")}
                </button>
                <button type="button" onClick={() => { setCreationId(null); setPollData(null); }}
                  className="px-5 py-3 rounded-xl text-sm font-bold"
                  style={{ background: ui.surfaceAlt, color: ui.muted, border: `1px solid ${ui.line}` }}>
                  {t("新建任务", "New Task")}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-[10px] uppercase tracking-widest font-black" style={{ color: ui.gold }}>
                {t("最近数字人视频", "Recent Presenter Videos")}
              </p>
              <span className="text-[11px]" style={{ color: ui.faint }}>{t("来自历史记录", "From history")}</span>
            </div>
            {recent.length > 0 ? (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {recent.map((item) => (
                  <button key={item.id} type="button" onClick={() => handleDownload(item.id)}
                    className="text-left rounded-2xl overflow-hidden transition-all active:scale-95"
                    style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    <div className="aspect-video" style={{ background: ui.surfaceHigh }}>
                      {item.preview_video_url || item.content ? (
                        <OssVideo
                          src={item.preview_video_url || item.content}
                          poster={item.thumbnail_url || undefined}
                          muted
                          playsInline
                          preload="metadata"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="material-symbols-outlined" style={{ color: ui.faint }}>co_present</span>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-sm font-bold truncate" style={{ color: ui.text }}>{item.scene_name}</p>
                      <p className="text-[11px] mt-1" style={{ color: ui.faint }}>{new Date(item.created_at).toLocaleDateString(isZh ? "zh-CN" : "en-US")}</p>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl px-4 py-8 text-center" style={{ background: ui.surfaceAlt, color: ui.faint }}>
                {t("还没有完成的数字人视频。", "No completed presenter videos yet.")}
              </div>
            )}
          </div>
        </section>
      </div>

      {rolePickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: ui.overlay }}
          onClick={() => setRolePickerOpen(false)}
        >
          <div
            className="w-full max-w-2xl rounded-2xl p-5"
            style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-widest font-black" style={{ color: ui.gold }}>
                  {t("数字人形象", "Presenter Portrait")}
                </p>
                <h3 className="mt-1 text-xl font-black" style={{ color: ui.text }}>
                  {t("选择数字人形象", "Choose presenter portrait")}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRolePickerOpen(false)}
                className="h-10 w-10 rounded-xl flex items-center justify-center"
                style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}
                aria-label={t("关闭", "Close")}
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-h-[60vh] overflow-y-auto pr-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedRoleId("");
                  setRolePickerOpen(false);
                }}
                className="rounded-2xl p-3 text-left transition-all active:scale-[0.98]"
                style={{
                  background: !selectedRoleId ? ui.surfaceHigh : ui.surfaceAlt,
                  border: `1px solid ${!selectedRoleId ? ui.gold : ui.line}`,
                }}
              >
                <div className="aspect-square rounded-2xl flex items-center justify-center" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
                  <span className="material-symbols-outlined text-5xl" style={{ color: ui.primary }}>co_present</span>
                </div>
                <p className="mt-3 text-sm font-black truncate" style={{ color: ui.text }}>
                  {t("默认数字人", "Default presenter")}
                </p>
                <p className="mt-1 text-[11px]" style={{ color: ui.faint }}>
                  {t("模板形象", "Template portrait")}
                </p>
              </button>

              {roles.map((role) => {
                const active = String(selectedRoleId) === String(role.id);
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => {
                      setSelectedRoleId(role.id);
                      setRolePickerOpen(false);
                    }}
                    className="rounded-2xl p-3 text-left transition-all active:scale-[0.98]"
                    style={{
                      background: active ? ui.surfaceHigh : ui.surfaceAlt,
                      border: `1px solid ${active ? ui.gold : ui.line}`,
                    }}
                  >
                    <div className="aspect-square rounded-2xl overflow-hidden flex items-center justify-center" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
                      {role.avatar_url ? (
                        <OssImage src={role.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="material-symbols-outlined text-5xl" style={{ color: ui.faint }}>portrait</span>
                      )}
                    </div>
                    <p className="mt-3 text-sm font-black truncate" style={{ color: ui.text }}>{role.role_name}</p>
                    <p className="mt-1 text-[11px]" style={{ color: role.status === "ready" ? ui.success : ui.faint }}>
                      {role.status === "ready" ? t("可用", "Ready") : t("形象创建中", "Preparing")}
                    </p>
                  </button>
                );
              })}
            </div>

            {roles.length === 0 && (
              <div className="mt-4 rounded-2xl px-4 py-5 text-center text-sm" style={{ background: ui.surfaceAlt, color: ui.faint }}>
                {t("还没有自定义形象。", "No custom portraits yet.")}
              </div>
            )}

            <div className="mt-5 flex flex-wrap justify-between gap-3">
              <button
                type="button"
                onClick={() => {
                  setRolePickerOpen(false);
                  navigate("/ai/digital-human-roles");
                }}
                className="rounded-xl px-4 py-3 text-sm font-bold"
                style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}
              >
                <span className="material-symbols-outlined text-sm align-[-2px] mr-2">add_photo_alternate</span>
                {t("添加形象", "Add portrait")}
              </button>
              <button
                type="button"
                onClick={() => setRolePickerOpen(false)}
                className="rounded-xl px-4 py-3 text-sm font-bold"
                style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}
              >
                {t("完成", "Done")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DigitalHuman;
