import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import toast from "react-hot-toast";
import {
  Bookmark, Check, Download, Image as ImageIcon, LayoutGrid,
  LoaderCircle, LogIn, Menu, MoreHorizontal, Play, Plus, Search, Send,
  Share2, Sparkles, Sun, Moon, Video, X, Zap,
} from "lucide-react";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import VisualParameterPicker from "../components/VisualParameterPicker";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import useAuthAxios from "../hooks/useAuthAxios";
import useTaskStream from "../hooks/useTaskStream";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { getModelSizeOptions, modelSupportsReferenceImages, normalizeModelCatalogResponse, SAFE_IMAGE_SIZE_OPTIONS, SAFE_VIDEO_SIZE_OPTIONS } from "../utils/modelCapabilities";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import {
  clearGenerationRequestKey,
  generationRequestFingerprint,
  getGenerationRequestKey,
  shouldKeepGenerationRequestKey,
} from "../utils/generationRequestIdentity";
import { isOversizedReferenceImage } from "../utils/mediaUploadLimits";

const PUBLIC_API = import.meta.env.VITE_BASE_URL || "";
const PENDING_HOME_PROMPT_KEY = "stardraw_pending_home_prompt";
const MEDIA_TYPES = ["all", "image", "video"];
const FEED_SORTS = ["featured", "latest", "popular"];
const fallbackModels = {
  image: [{ model_key: "nano-banana-2", display_name: "Nano Banana 2" }],
  video: [{ model_key: "veo-3-1", display_name: "Veo 3.1" }],
};

const themeTokens = {
  night: { page: "#11120f", surface: "#191a16", raised: "#23241e", text: "#f1eee5", muted: "#a9a79c", faint: "#75756d", line: "rgba(241,238,229,.12)", accent: "#ee9d47", accentSoft: "rgba(238,157,71,.16)", green: "#9dc487", overlay: "rgba(17,18,15,.86)" },
  day: { page: "#f6f3ec", surface: "#fffdf8", raised: "#ede9df", text: "#292823", muted: "#77736a", faint: "#a19c91", line: "rgba(41,40,35,.13)", accent: "#c56b23", accentSoft: "rgba(197,107,35,.12)", green: "#5e8e56", overlay: "rgba(246,243,236,.92)" },
};

const formatCount = (value) => {
  const count = Number(value || 0);
  return count > 999 ? `${(count / 1000).toFixed(count > 9999 ? 0 : 1)}k` : String(count);
};

const publicAssetUrl = (source) => {
  if (!source) return "";
  if (/^https?:\/\//i.test(source)) return source;
  return source;
};

const publicRequest = axios.create({ baseURL: PUBLIC_API });

function Logo({ compact = false, ui, isZh }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: ui.accent, color: "#241407" }}>
        <Sparkles size={18} strokeWidth={2.5} />
      </div>
      {!compact && <div><p className="text-[17px] font-black tracking-[-.03em]" style={{ color: ui.text }}>StarDraw</p><p className="text-[8px] font-bold uppercase tracking-[.24em]" style={{ color: ui.faint }}>{isZh ? "让创作动起来" : "Create in motion"}</p></div>}
    </div>
  );
}

function ThemeButton({ theme, setTheme, ui, isZh }) {
  const label = isZh ? "切换主题" : "Toggle theme";
  return <button type="button" title={label} onClick={() => setTheme(theme === "night" ? "day" : "night")} className="icon-button" style={{ color: ui.muted }} aria-label={label}>{theme === "night" ? <Sun size={17} /> : <Moon size={17} />}</button>;
}

function HomeLanguageSwitch({ isZh, setLocale, ui }) {
  return <div className="home-locale" style={{ background: ui.raised, borderColor: ui.line }}><button type="button" onClick={() => setLocale("zh-CN")} style={{ background: isZh ? ui.accent : "transparent", color: isZh ? "#261507" : ui.faint }}>中文</button><button type="button" onClick={() => setLocale("en")} style={{ background: !isZh ? ui.accent : "transparent", color: !isZh ? "#261507" : ui.faint }}>EN</button></div>;
}

function MediaCard({ item, onOpen, ui, isZh }) {
  const videoRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const media = publicAssetUrl(item.content);
  const poster = publicAssetUrl(item.thumbnail_url || item.content);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (hovered) video.play().catch(() => {});
    else { video.pause(); video.currentTime = 0; }
  }, [hovered]);
  return (
    <article className="community-card group" style={{ background: ui.surface, borderColor: ui.line }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button type="button" className="relative block w-full overflow-hidden text-left" onClick={() => onOpen(item)} aria-label={item.title}>
        <div className="media-ratio" style={{ background: ui.raised }}>
          {item.type === "video" ? <><OssVideo ref={videoRef} src={media} poster={poster} authorize={false} muted loop playsInline className="h-full w-full object-cover" /><span className="absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full" style={{ background: "rgba(0,0,0,.48)", color: "#fff" }}><Play size={13} fill="currentColor" /></span></> : <OssImage src={media} authorize={false} alt={item.title} className="h-full w-full object-cover" />}
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </button>
      <div className="px-3.5 pb-3.5 pt-3">
        <div className="flex items-start justify-between gap-2"><p className="line-clamp-1 text-[13px] font-bold" style={{ color: ui.text }}>{item.title}</p><button type="button" className="icon-button" style={{ color: ui.faint }} aria-label={isZh ? "更多操作" : "More actions"} onClick={() => onOpen(item)}><MoreHorizontal size={16} /></button></div>
        <div className="mt-2 flex items-center justify-between"><div className="flex min-w-0 items-center gap-2"><div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-black" style={{ background: ui.accentSoft, color: ui.accent }}>{item.author?.name?.[0]?.toUpperCase() || "S"}</div><span className="truncate text-[11px]" style={{ color: ui.muted }}>{item.author?.name || "StarDraw creator"}</span></div><div className="flex items-center gap-2 text-[10px]" style={{ color: ui.faint }}><span>♥ {formatCount(item.likes_count)}</span><span>☆ {formatCount(item.favorites_count)}</span></div></div>
      </div>
    </article>
  );
}

function TemplateInspirationCard({ template, ui, isZh }) {
  const videoRef = useRef(null);
  const [hovered, setHovered] = useState(false);
  const isVideo = template.output_type === "video" && Boolean(template.preview_video_url);
  const preview = publicAssetUrl(isVideo ? template.preview_video_url : template.preview_image_url);
  const poster = publicAssetUrl(template.preview_image_url || "");
  const title = template.preview_title || template.scene_name || (isZh ? "官方精选灵感" : "Featured inspiration");
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (hovered) video.play().catch(() => {});
    else { video.pause(); video.currentTime = 0; }
  }, [hovered]);
  return (
    <article className="community-card group" style={{ background: ui.surface, borderColor: ui.line }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <button type="button" className="relative block w-full overflow-hidden text-left" onClick={() => { window.location.href = `/ai/templates/${template.id}`; }} aria-label={title}>
        <div className="media-ratio" style={{ background: ui.raised }}>
          {isVideo
            ? <OssVideo ref={videoRef} src={preview} poster={poster} authorize={false} muted loop playsInline className="h-full w-full object-cover" />
            : <OssImage src={preview} authorize={false} alt={title} className="h-full w-full object-cover" />}
          <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-white backdrop-blur-sm"><Sparkles size={11} />{isZh ? "官方精选" : "Official pick"}</div>
          {isVideo && <span className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white"><Play size={13} fill="currentColor" /></span>}
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </button>
      <div className="px-3.5 pb-3.5 pt-3">
        <p className="line-clamp-1 text-[13px] font-bold" style={{ color: ui.text }}>{title}</p>
        <div className="mt-2 flex items-center justify-between gap-3 text-[10px]"><span style={{ color: ui.muted }}>{isZh ? "模板灵感，不是用户公开作品" : "Template inspiration, not user-posted work"}</span><button type="button" className="shrink-0 font-black" style={{ color: ui.accent }} onClick={() => { window.location.href = `/ai/templates/${template.id}`; }}>{isZh ? "查看并生成" : "Use template"}</button></div>
      </div>
    </article>
  );
}

function CreationDetail({ item, onClose, onRefresh, ui, isSignedIn, login, authAxios, resolvePrivateUrl, isZh }) {
  const [busy, setBusy] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("other");
  const [reportDetails, setReportDetails] = useState("");
  if (!item) return null;
  const run = async (action, body = {}) => {
    if (!isSignedIn) return login();
    setBusy(action);
    try {
      await authAxios.post(`/api/community/creations/${item.id}/${action}`, body);
      toast.success(isZh ? "已更新" : "Updated");
      onRefresh();
    } catch (error) { toast.error(error.response?.data?.message || (isZh ? "操作失败" : "Action failed")); }
    finally { setBusy(""); }
  };
  const share = async () => {
    const url = `${window.location.origin}/community/creation/${item.id}`;
    try { await navigator.clipboard.writeText(url); toast.success(isZh ? "链接已复制" : "Link copied"); } catch { window.prompt(isZh ? "复制分享链接" : "Copy share link", url); }
  };
  const download = async () => {
    try {
      const source = item.content;
      const url = source?.startsWith("/oss-proxy/") ? source : await resolvePrivateUrl(source);
      const link = document.createElement("a"); link.href = url; link.download = `${item.title || "stardraw-creation"}.${item.type === "video" ? "mp4" : "jpg"}`; link.click();
    } catch { toast.error(isZh ? "下载失败" : "Download failed"); }
  };
  const report = async () => { await run("report", { reason: reportReason, details: reportDetails }); setReportOpen(false); };
  return <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 p-0 backdrop-blur-sm md:items-center md:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="detail-sheet flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden md:flex-row" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
      <div className="relative flex min-h-[300px] flex-1 items-center justify-center bg-black md:min-h-[620px]">{item.type === "video" ? <OssVideo src={item.content} poster={item.thumbnail_url} authorize={false} controls playsInline className="max-h-[72vh] max-w-full object-contain" /> : <OssImage src={item.content} authorize={false} alt={item.title} className="max-h-[72vh] max-w-full object-contain" />}<button type="button" className="icon-button absolute right-3 top-3 rounded-full bg-black/50 p-2 text-white" onClick={onClose} aria-label={isZh ? "关闭" : "Close"}><X size={18} /></button></div>
      <div className="flex w-full flex-col overflow-y-auto p-5 md:w-[360px] md:p-7"><div className="flex items-center justify-between gap-3"><div><p className="text-[10px] font-bold uppercase tracking-[.18em]" style={{ color: ui.accent }}>{item.type === "video" ? (isZh ? "视频" : "Motion") : (isZh ? "图片" : "Image")}</p><h2 className="mt-2 text-xl font-black" style={{ color: ui.text }}>{item.title}</h2></div><button type="button" className="icon-button" onClick={share} title={isZh ? "分享" : "Share"} aria-label={isZh ? "分享" : "Share"}><Share2 size={17} /></button></div>
        <div className="mt-5 flex items-center gap-3 border-b pb-5" style={{ borderColor: ui.line }}><div className="flex h-9 w-9 items-center justify-center rounded-full font-black" style={{ background: ui.accentSoft, color: ui.accent }}>{item.author?.name?.[0]?.toUpperCase() || "S"}</div><div><p className="text-sm font-bold" style={{ color: ui.text }}>{item.author?.name}</p><p className="text-[11px]" style={{ color: ui.faint }}>{item.featured ? (isZh ? "官方精选" : "Featured") : (isZh ? "社区作品" : "Community work")}</p></div></div>
        <div className="mt-5 flex gap-2"><button type="button" className="detail-action" onClick={() => run("like", { enabled: !item.liked })} style={{ color: item.liked ? ui.accent : ui.muted }} disabled={Boolean(busy)}><span>♥</span>{formatCount(item.likes_count)}</button><button type="button" className="detail-action" onClick={() => run("favorite", { enabled: !item.favorited })} style={{ color: item.favorited ? ui.accent : ui.muted }} disabled={Boolean(busy)}><Bookmark size={15} fill={item.favorited ? "currentColor" : "none"} />{formatCount(item.favorites_count)}</button><button type="button" className="detail-action" onClick={download} style={{ color: ui.muted }}><Download size={15} />{isZh ? "下载" : "Download"}</button></div>
        <div className="mt-6 grid gap-2"><button type="button" className="w-full rounded-xl px-4 py-3 text-sm font-bold" style={{ background: ui.accent, color: "#261507" }} onClick={() => { if (!isSignedIn) return login(); window.location.href = `/ai/${item.type === "video" ? "ai-video" : "scene-image"}?remix=${item.id}`; }}><Sparkles size={16} className="mr-2 inline" />{isZh ? "做同款" : "Remix"}</button><button type="button" className="w-full rounded-xl px-4 py-3 text-sm font-bold" style={{ background: ui.raised, color: ui.text }} onClick={() => setReportOpen((open) => !open)}><MoreHorizontal size={16} className="mr-2 inline" />{isZh ? "举报作品" : "Report"}</button></div>
        {item.prompt_public && item.prompt && <div className="mt-6 rounded-2xl p-4" style={{ background: ui.raised }}><p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em]" style={{ color: ui.faint }}>{isZh ? "公开提示词" : "Public prompt"}</p><p className="whitespace-pre-wrap text-xs leading-6" style={{ color: ui.muted }}>{item.prompt}</p></div>}
        {item.public_parameters && <div className="mt-4 rounded-2xl p-4" style={{ background: ui.raised }}><p className="mb-2 text-[10px] font-bold uppercase tracking-[.16em]" style={{ color: ui.faint }}>{isZh ? "公开参数" : "Public parameters"}</p><div className="flex flex-wrap gap-2">{[item.public_parameters.model, item.public_parameters.size, item.public_parameters.aspect_ratio].filter(Boolean).map((value) => <span key={value} className="rounded-full px-2.5 py-1 text-[10px]" style={{ background: ui.accentSoft, color: ui.accent }}>{value}</span>)}</div></div>}
        {reportOpen && <div className="mt-4 rounded-2xl p-4" style={{ background: ui.raised }}><label className="text-xs font-bold" style={{ color: ui.text }}>{isZh ? "举报原因" : "Report reason"}<CanvasRoundedSelect label={isZh ? "举报原因" : "Report reason"} value={reportReason} onChange={setReportReason} options={[{ value: "unsafe", label: isZh ? "不安全内容" : "Unsafe" }, { value: "copyright", label: isZh ? "版权问题" : "Copyright" }, { value: "spam", label: isZh ? "垃圾内容" : "Spam" }, { value: "privacy", label: isZh ? "隐私问题" : "Privacy" }, { value: "other", label: isZh ? "其他" : "Other" }]} ui={{ ...ui, soft: ui.surface, panelStrong: ui.surface, gold: ui.accent, goldSoft: ui.accentSoft }} className="mt-2 w-full" triggerClassName="h-9 w-full rounded-lg px-2 text-xs" menuMinWidth={180} /></label><textarea value={reportDetails} onChange={(event) => setReportDetails(event.target.value)} maxLength={1000} className="mt-3 min-h-20 w-full rounded-lg p-2 text-xs outline-none" style={{ background: ui.surface, color: ui.text }} placeholder={isZh ? "补充说明（可选）" : "Details (optional)"} /><button type="button" className="mt-3 w-full rounded-lg px-3 py-2 text-xs font-bold" style={{ background: ui.accent, color: "#261507" }} onClick={report} disabled={Boolean(busy)}>{busy === "report" ? <LoaderCircle className="mx-auto animate-spin" size={15} /> : (isZh ? "提交举报" : "Submit report")}</button></div>}
      </div>
    </section>
  </div>;
}

function Composer({ ui, isSignedIn, login, authAxios, isZh, models, onCreated }) {
  const [mode, setMode] = useState("image");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("nano-banana-2");
  const [size, setSize] = useState("1024x1024");
  const [reference, setReference] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const [visualParameters, setVisualParameters] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef(null);
  const submissionRequestRef = useRef(false);
  const activeModels = models[mode] || fallbackModels[mode];
  const activeModel = activeModels.find((item) => item.model_key === model) || activeModels[0];
  // Capability declarations are authoritative for both generators. A model
  // that cannot accept references should never expose the upload affordance.
  const supportsReference = modelSupportsReferenceImages(activeModel);
  const sizes = getModelSizeOptions({ model: activeModel, outputType: mode, fallbackOptions: mode === "image" ? SAFE_IMAGE_SIZE_OPTIONS : SAFE_VIDEO_SIZE_OPTIONS });
  const selectUi = { ...ui, soft: ui.raised, panelStrong: ui.surface, gold: ui.accent, goldSoft: ui.accentSoft };
  useEffect(() => {
    if (!isSignedIn) return;
    const pendingPrompt = window.localStorage.getItem(PENDING_HOME_PROMPT_KEY) || "";
    if (pendingPrompt) setPrompt(pendingPrompt);
    window.localStorage.removeItem(PENDING_HOME_PROMPT_KEY);
  }, [isSignedIn]);
  useEffect(() => { const first = activeModels[0]?.model_key || fallbackModels[mode][0].model_key; if (!activeModels.some((item) => item.model_key === model)) setModel(first); }, [activeModels, mode, model]);
  useEffect(() => { if (!sizes.some((item) => item.value === size)) setSize(sizes[0]?.value || (mode === "image" ? "1024x1024" : "720x1280")); }, [mode, size, sizes]);
  useEffect(() => { if (!supportsReference) setReference(null); }, [supportsReference]);
  const handleReferenceChange = (event) => {
    const nextReference = event.target.files?.[0] || null;
    event.target.value = "";
    if (nextReference && isOversizedReferenceImage(nextReference)) {
      toast.error(isZh ? "参考图不能超过 10 MiB" : "Reference images must be 10 MiB or smaller.");
      return;
    }
    setReference(supportsReference ? nextReference : null);
  };
  const submit = async () => {
    if (!isSignedIn) {
      if (prompt.trim()) window.localStorage.setItem(PENDING_HOME_PROMPT_KEY, prompt.trim());
      return login();
    }
    if (!prompt.trim()) return toast.error(isZh ? "先写下你的创意" : "Describe your idea first");
    if (reference && isOversizedReferenceImage(reference)) {
      return toast.error(isZh ? "参考图不能超过 10 MiB" : "Reference images must be 10 MiB or smaller.");
    }
    if (submissionRequestRef.current) return;
    submissionRequestRef.current = true;
    setSubmitting(true);
    const requestKey = getGenerationRequestKey({
      scope: mode,
      fingerprint: generationRequestFingerprint({
        sceneKey: mode === "image" ? "freeform_image" : "freeform_video",
        prompt: prompt.trim(),
        model,
        size,
        visualParameters,
        reference: reference ? { name: reference.name, size: reference.size, lastModified: reference.lastModified } : null,
      }),
    });
    try {
      const form = new FormData(); form.append("scene_key", mode === "image" ? "freeform_image" : "freeform_video"); form.append("user_prompt", prompt.trim()); form.append("model", model); form.append("size", size); form.append("visual_parameters", JSON.stringify(visualParameters)); if (reference && supportsReference) form.append("images", reference);
      const { data } = await authAxios.post(mode === "image" ? "/api/ai/generate-scene-image" : "/api/ai/generate-sora-video", form, { headers: { "X-Idempotency-Key": requestKey } });
      clearGenerationRequestKey({ scope: mode, requestKey });
      onCreated({ ...data, prompt: prompt.trim(), type: mode, visualParameters }); setPrompt(""); setReference(null); toast.success(isZh ? "任务已开始" : "Generation started");
    } catch (error) {
      if (!shouldKeepGenerationRequestKey(error)) clearGenerationRequestKey({ scope: mode, requestKey });
      const code = error.response?.data?.code;
      if (["EXECUTION_IN_PROGRESS", "EXECUTION_CONCURRENCY_LIMITED"].includes(code)) {
        toast(isZh ? "已有生成任务在后台运行，请稍候查看最近作品" : "A generation is already running. Check Recent work shortly.");
      } else {
        toast.error(error.response?.data?.message || (isZh ? "生成失败，请稍后重试" : "Generation failed"));
      }
    }
    finally { submissionRequestRef.current = false; setSubmitting(false); window.dispatchEvent(new Event("stardraw:points-updated")); }
  };
  return <section className="composer-shell" style={{ background: ui.surface, borderColor: ui.line, boxShadow: `0 20px 48px ${ui.page}55` }}>
    <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: ui.line }}><div className="flex items-center gap-1 rounded-xl p-1" style={{ background: ui.raised }}><button type="button" className="mode-tab" onClick={() => { setMode("image"); setVisualParameters({}); }} style={{ background: mode === "image" ? ui.accent : "transparent", color: mode === "image" ? "#261507" : ui.muted }}><ImageIcon size={14} />{isZh ? "图片" : "Image"}</button><button type="button" className="mode-tab" onClick={() => { setMode("video"); setVisualParameters({}); }} style={{ background: mode === "video" ? ui.accent : "transparent", color: mode === "video" ? "#261507" : ui.muted }}><Video size={14} />{isZh ? "视频" : "Video"}</button></div><div className="flex items-center gap-2"><span className="hidden text-[10px] sm:inline" style={{ color: ui.faint }}>{isZh ? "生成结果默认私有" : "Outputs are private by default"}</span><button type="button" className="icon-button" style={{ color: advanced ? ui.accent : ui.faint }} onClick={() => setAdvanced((value) => !value)} title={isZh ? "高级设置" : "Advanced controls"} aria-label={isZh ? "高级设置" : "Advanced controls"} aria-expanded={advanced}><MoreHorizontal size={18} /></button></div></div>
    <div className="px-4 pt-4"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} className="min-h-[76px] w-full resize-none bg-transparent text-[15px] leading-6 outline-none" style={{ color: ui.text }} placeholder={mode === "image" ? (isZh ? "描述你想创造的画面..." : "Describe the image you want to create...") : (isZh ? "描述一个镜头、动作或场景..." : "Describe a shot, action, or scene...")} /><div className="mt-3 flex flex-wrap items-center gap-2">{[<CanvasRoundedSelect key="model" label={isZh ? "模型" : "Model"} value={model} options={activeModels} onChange={(nextValue) => { setModel(nextValue); setVisualParameters({}); }} ui={selectUi} className="max-w-[190px]" triggerClassName="composer-select w-full" menuMinWidth={220} />, <CanvasRoundedSelect key="size" label={isZh ? "尺寸" : "Size"} value={size} options={sizes} onChange={setSize} ui={selectUi} className="max-w-[190px]" triggerClassName="composer-select w-full" menuMinWidth={190} />, <button key="reference" type="button" disabled={!supportsReference} className="composer-chip disabled:cursor-not-allowed disabled:opacity-40" onClick={() => supportsReference && fileRef.current?.click()} title={!supportsReference ? (isZh ? "当前模型不支持参考图" : "This model does not support references") : (isZh ? "参考图不能超过 10 MiB" : "Reference images must be 10 MiB or smaller.")} style={{ background: reference ? ui.accentSoft : ui.raised, color: reference ? ui.accent : ui.muted, borderColor: ui.line }}><Plus size={14} />{reference ? (isZh ? "已选参考图" : "Reference added") : (isZh ? "参考图" : "Reference")}</button>, <input key="file" ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleReferenceChange} />]}</div></div>
    {advanced && <div className="mx-4 mt-4 overflow-hidden rounded-2xl" style={{ border: `1px solid ${ui.line}`, background: ui.raised }}>{isSignedIn ? <VisualParameterPicker outputType={mode} modelKey={model} value={visualParameters} onChange={setVisualParameters} accent="gold" /> : <div className="flex items-center justify-between gap-4 p-4"><p className="text-xs leading-5" style={{ color: ui.muted }}>{isZh ? "登录后可选择画风、摄影、灯光、背景、景别与运镜。" : "Sign in to choose style, camera, lighting, background, framing, and motion."}</p><button type="button" onClick={login} className="shrink-0 rounded-xl px-3 py-2 text-xs font-black" style={{ background: ui.accent, color: "#261507" }}>{isZh ? "登录" : "Sign in"}</button></div>}</div>}
    <div className="flex items-center justify-between gap-3 px-4 pb-4 pt-4"><span className="flex items-center gap-1.5 text-[10px]" style={{ color: ui.faint }}><Zap size={13} style={{ color: ui.accent }} />{isZh ? "按实际节点扣除积分" : "Points settle per completed node"}</span><button type="button" onClick={submit} disabled={submitting} className="flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-black transition-transform active:scale-95" style={{ background: submitting ? ui.raised : ui.accent, color: submitting ? ui.muted : "#261507" }}>{submitting ? <LoaderCircle size={16} className="animate-spin" /> : <Send size={16} />}{isZh ? "开始生成" : "Generate"}</button></div>
  </section>;
}

function PublishDialog({ job, onClose, onPublished, authAxios, isZh, ui }) {
  const [title, setTitle] = useState(job?.prompt?.slice(0, 80) || (job?.type === "video" ? "AI Video" : "AI Image"));
  const [tags, setTags] = useState("");
  const [promptPublic, setPromptPublic] = useState(false);
  const [parametersPublic, setParametersPublic] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!job) return null;
  const publish = async () => {
    if (!title.trim()) return toast.error(isZh ? "请填写作品标题" : "Add a title");
    setBusy(true);
    try {
      await authAxios.post(`/api/community/creations/${job.creation_id}/publish`, { title: title.trim(), tags: tags.split(",").map((item) => item.trim()).filter(Boolean), prompt_public: promptPublic, visual_parameters: parametersPublic ? (job.visualParameters || {}) : {} });
      toast.success(isZh ? "作品已发布到社区" : "Published to community"); onPublished(job.creation_id); onClose();
    } catch (error) { toast.error(error.response?.data?.message || (isZh ? "发布失败" : "Publication failed")); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="w-full max-w-md rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.18em]" style={{ color: ui.accent }}>{isZh ? "发布作品" : "Publish creation"}</p><h3 className="mt-2 text-lg font-black" style={{ color: ui.text }}>{isZh ? "分享至社区" : "Share with the community"}</h3></div><button type="button" className="icon-button" onClick={onClose} aria-label={isZh ? "关闭" : "Close"}><X size={18} /></button></div><div className="mt-5 overflow-hidden rounded-xl bg-black">{job.type === "video" ? <OssVideo src={job.content} poster={job.thumbnail_url} className="h-48 w-full object-contain" controls /> : <OssImage src={job.content} alt="" className="h-48 w-full object-contain" />}</div><label className="mt-5 block text-xs font-bold" style={{ color: ui.muted }}>{isZh ? "标题" : "Title"}<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={160} className="mt-2 w-full rounded-xl p-3 outline-none" style={{ background: ui.raised, color: ui.text }} /></label><label className="mt-4 block text-xs font-bold" style={{ color: ui.muted }}>{isZh ? "标签（逗号分隔）" : "Tags (comma separated)"}<input value={tags} onChange={(event) => setTags(event.target.value)} className="mt-2 w-full rounded-xl p-3 outline-none" style={{ background: ui.raised, color: ui.text }} placeholder={isZh ? "产品摄影, 极简, 暖光" : "product, minimal, warm light"} /></label><label className="mt-4 flex items-start gap-3 rounded-xl p-3" style={{ background: ui.raised }}><input type="checkbox" checked={promptPublic} onChange={(event) => setPromptPublic(event.target.checked)} className="mt-0.5" /><span><b className="block text-xs" style={{ color: ui.text }}>{isZh ? "公开提示词" : "Show prompt"}</b><small style={{ color: ui.faint }}>{isZh ? "关闭时，做同款不会复制你的提示词。" : "When off, remix never copies your prompt."}</small></span></label>{Object.keys(job.visualParameters || {}).length > 0 && <label className="mt-3 flex items-start gap-3 rounded-xl p-3" style={{ background: ui.raised }}><input type="checkbox" checked={parametersPublic} onChange={(event) => setParametersPublic(event.target.checked)} className="mt-0.5" /><span><b className="block text-xs" style={{ color: ui.text }}>{isZh ? "公开视觉参数" : "Show visual controls"}</b><small style={{ color: ui.faint }}>{isZh ? "允许社区查看本次使用的画风、摄影与灯光等选项。" : "Let the community see the style, camera, and lighting choices used."}</small></span></label>}<div className="mt-5 flex gap-2"><button type="button" className="flex-1 rounded-xl px-4 py-3 text-sm font-bold" style={{ background: ui.raised, color: ui.muted }} onClick={onClose}>{isZh ? "取消" : "Cancel"}</button><button type="button" className="flex-1 rounded-xl px-4 py-3 text-sm font-black" style={{ background: ui.accent, color: "#261507" }} onClick={publish} disabled={busy}>{busy ? <LoaderCircle className="mx-auto animate-spin" size={16} /> : (isZh ? "立即公开" : "Publish now")}</button></div></section></div>;
}

function MyWorks({ jobs, onPublish, isZh, ui }) {
  if (!jobs.length) return null;
  return <section className="mb-8"><div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-black" style={{ color: ui.text }}>{isZh ? "我的作品" : "My creations"}</h2><button type="button" onClick={() => window.location.href = "/ai/tasks"} className="text-[11px] font-bold" style={{ color: ui.accent }}>{isZh ? "任务中心" : "Task center"}</button></div><div className="flex gap-3 overflow-x-auto pb-2">{jobs.map((job) => { const active = ["pending", "running", "processing"].includes(job.status); const failed = ["failed", "cancelled"].includes(job.status); return <article key={job.creation_id} className="relative h-28 w-44 shrink-0 overflow-hidden rounded-xl" style={{ background: ui.raised, border: `1px solid ${ui.line}` }}>{job.status === "completed" && job.content ? (job.type === "video" ? <OssVideo src={job.content} poster={job.thumbnail_url} className="h-full w-full object-cover" muted playsInline /> : <OssImage src={job.content} alt="" className="h-full w-full object-cover" />) : <div className="flex h-full flex-col items-center justify-center gap-2" style={{ color: failed ? "#ef7777" : ui.muted }}>{active ? <LoaderCircle size={18} className="animate-spin" /> : failed ? <X size={18} /> : <Check size={18} />}<span className="text-[10px]">{failed ? (isZh ? "生成失败" : "Failed") : active ? (isZh ? `处理中 ${job.progress || 0}%` : `Processing ${job.progress || 0}%`) : (isZh ? "任务已完成" : "Completed")}</span></div>}<div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/60 px-2 py-1.5 text-white"><span className="max-w-24 truncate text-[9px]">{job.prompt}</span>{job.status === "completed" && job.content && !job.published && <button type="button" onClick={() => onPublish(job)} className="rounded-md bg-white/15 px-2 py-1 text-[9px] font-bold">{isZh ? "公开" : "Publish"}</button>}{job.published && <Check size={13} />}</div></article>; })}</div></section>;
}

export default function Home() {
  const { isSignedIn, isLoading, user, login, logout } = useAuthing();
  const { isZh, setLocale } = useLanguage();
  const authAxios = useAuthAxios();
  const taskStream = useTaskStream({ page: 1, pageSize: 50, type: "creation", enabled: isSignedIn });
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { theme } = useStarDrawTheme();
  const [localTheme, setLocalTheme] = useState(theme);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedType, setFeedType] = useState("all");
  const [feedSort, setFeedSort] = useState("featured");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [models, setModels] = useState(fallbackModels);
  const [featuredTemplates, setFeaturedTemplates] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [publishJob, setPublishJob] = useState(null);
  const [mobileMenu, setMobileMenu] = useState(false);
  const sentinelRef = useRef(null);
  const cursorRef = useRef(null);
  const feedRequestRef = useRef(null);
  const taskSnapshotRef = useRef("");
  const ui = themeTokens[localTheme] || themeTokens.night;

  useEffect(() => setLocalTheme(theme), [theme]);
  useEffect(() => { window.localStorage.setItem("stardraw_theme", localTheme); document.documentElement.dataset.stardrawTheme = localTheme; window.dispatchEvent(new CustomEvent("stardraw:theme-change", { detail: { theme: localTheme } })); }, [localTheme]);
  const loadFeed = useCallback(async ({ append = false } = {}) => {
    const requestCursor = append ? cursorRef.current : null;
    if (append && !requestCursor) return;

    const requestKey = JSON.stringify({ append, requestCursor, feedType, feedSort, submittedQuery, isSignedIn });
    const activeRequest = feedRequestRef.current;
    if (activeRequest && (append || activeRequest.key === requestKey)) return activeRequest.promise;

    const promise = (async () => {
      setFeedLoading(true);
      try {
        const request = isSignedIn ? authAxios : publicRequest;
        const path = isSignedIn ? "/api/community/feed" : "/api/public/community/feed";
        const { data } = await request.get(path, { params: { type: feedType === "all" ? undefined : feedType, sort: feedSort, query: submittedQuery || undefined, cursor: requestCursor || undefined, limit: 24 } });
        const nextItems = data?.data?.items || [];
        const nextCursor = data?.data?.next_cursor || null;
        setItems((previous) => append ? [...previous, ...nextItems] : nextItems);
        cursorRef.current = nextCursor;
        setCursor(nextCursor);
      } catch { if (!append) setItems([]); }
      finally { setFeedLoading(false); }
    })();

    feedRequestRef.current = { key: requestKey, promise };
    try {
      return await promise;
    } finally {
      if (feedRequestRef.current?.promise === promise) feedRequestRef.current = null;
    }
  }, [authAxios, feedSort, feedType, isSignedIn, submittedQuery]);
  useEffect(() => {
    cursorRef.current = null;
    setCursor(null);
    loadFeed({ append: false });
  }, [loadFeed]);
  useEffect(() => { const observer = new IntersectionObserver((entries) => { if (entries[0].isIntersecting && cursor && !feedLoading) loadFeed({ append: true }); }, { rootMargin: "500px" }); if (sentinelRef.current) observer.observe(sentinelRef.current); return () => observer.disconnect(); }, [cursor, feedLoading, loadFeed]);
  useEffect(() => { publicRequest.get("/api/public/community/bootstrap").then(({ data }) => {
    const rows = data?.data?.models || [];
    const templates = data?.data?.templates || [];
    setModels({ image: normalizeModelCatalogResponse(rows.filter((item) => item.output_type === "image"), fallbackModels.image), video: normalizeModelCatalogResponse(rows.filter((item) => item.output_type === "video"), fallbackModels.video) });
    setFeaturedTemplates(templates.filter((item) => item.preview_image_url || item.preview_video_url));
  }).catch(() => {}); }, []);
  const loadCreations = useCallback(async () => {
    if (!isSignedIn) return false;
    try {
      const { data } = await authAxios.get("/api/user/get-user-creations?page=1&page_size=12");
      const restored = (data?.creations || []).map((creation) => ({
        ...creation,
        creation_id: creation.id,
        progress: Number(creation.progress || 0),
        visualParameters: creation.visual_parameters || {},
      }));
      setJobs((current) => {
        const currentById = new Map(current.map((job) => [String(job.creation_id), job]));
        return restored.map((job) => ({ ...currentById.get(String(job.creation_id)), ...job })).slice(0, 12);
      });
      return true;
    } catch {
      return false;
    }
  }, [authAxios, isSignedIn]);
  useEffect(() => {
    if (!isSignedIn) {
      taskSnapshotRef.current = "";
      setJobs([]);
      return;
    }
    void loadCreations();
  }, [isSignedIn, loadCreations]);
  const onCreated = (job) => { setJobs((current) => [{ ...job, createdAt: Date.now() }, ...current]); };
  useEffect(() => {
    if (!isSignedIn || taskStream.loading) return;
    const creationTasks = taskStream.tasks.filter((task) => task.source === "creation");
    const snapshot = creationTasks.map((task) => `${task.sourceId}:${task.status}:${task.progress}`).join("|");
    setJobs((current) => {
      const currentById = new Map(current.map((job) => [String(job.creation_id), job]));
      const streamed = creationTasks.map((task) => {
        const existing = currentById.get(String(task.sourceId)) || {};
        currentById.delete(String(task.sourceId));
        return {
          ...existing,
          creation_id: task.sourceId,
          type: task.type,
          status: task.status,
          progress: task.progress,
          prompt: existing.prompt || task.title,
        };
      });
      return [...streamed, ...currentById.values()].slice(0, 12);
    });
    if (snapshot !== taskSnapshotRef.current) {
      taskSnapshotRef.current = snapshot;
      void loadCreations();
    }
  }, [isSignedIn, loadCreations, taskStream.loading, taskStream.tasks]);
  const refreshSelected = async () => {
    if (!selected) return;
    try {
      const request = isSignedIn ? authAxios : publicRequest;
      const path = isSignedIn
        ? `/api/community/creations/${selected.id}`
        : `/api/public/community/creations/${selected.id}`;
      const { data } = await request.get(path);
      setSelected(data?.data || null);
    } catch { setSelected(null); }
    await loadFeed();
  };
  const search = (event) => { event.preventDefault(); setSubmittedQuery(query.trim()); };
  const fallbackInspiration = useMemo(() => {
    const normalizedQuery = submittedQuery.toLowerCase();
    return featuredTemplates.filter((template) => {
      if (feedType !== "all" && template.output_type !== feedType) return false;
      if (!normalizedQuery) return true;
      return [template.scene_key, template.scene_name, template.preview_title, template.preview_description, ...(Array.isArray(template.tags) ? template.tags : [])]
        .filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
    }).slice(0, 16);
  }, [featuredTemplates, feedType, submittedQuery]);
  const activeJobCount = jobs.filter((job) => ["pending", "running", "processing"].includes(job.status)).length;
  if (isLoading) return <div className="flex min-h-screen items-center justify-center" style={{ background: ui.page, color: ui.muted }}><LoaderCircle className="animate-spin" size={24} /></div>;
  return <div className="home-page min-h-screen pb-36" style={{ background: ui.page, color: ui.text }}>
    <header className="home-topbar" style={{ background: ui.overlay, borderColor: ui.line }}><div className="flex items-center gap-5"><button type="button" className="icon-button md:hidden" onClick={() => setMobileMenu((open) => !open)} aria-label={isZh ? "菜单" : "Menu"}><Menu size={20} /></button><Logo ui={ui} isZh={isZh} /></div><nav className="hidden items-center gap-6 text-xs font-bold md:flex"><a href="#community" style={{ color: ui.text }}>{isZh ? "发现" : "Discover"}</a><a href="#create" style={{ color: ui.muted }}>{isZh ? "创作" : "Create"}</a><a href="/ai/templates" style={{ color: ui.muted }}>{isZh ? "模板" : "Templates"}</a></nav><div className="flex items-center gap-2"><form onSubmit={search} className="home-search hidden lg:flex" style={{ background: ui.raised, borderColor: ui.line }}><Search size={15} style={{ color: ui.faint }} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isZh ? "搜索作品、风格、灵感" : "Search work, style, inspiration"} style={{ color: ui.text }} /></form><ThemeButton theme={localTheme} setTheme={setLocalTheme} ui={ui} isZh={isZh} />{isSignedIn ? <button type="button" className="avatar-button" onClick={() => window.location.href = "/ai"} title={user?.name || (isZh ? "账户" : "Account")}>{user?.name?.[0]?.toUpperCase() || "U"}</button> : <button type="button" className="login-button" onClick={login}><LogIn size={15} />{isZh ? "登录" : "Sign in"}</button>}</div></header>
    {mobileMenu && <div className="mobile-nav" style={{ background: ui.surface, borderColor: ui.line }}><a href="#community" onClick={() => setMobileMenu(false)}>{isZh ? "发现作品" : "Discover"}</a><a href="#create" onClick={() => setMobileMenu(false)}>{isZh ? "开始创作" : "Create"}</a><a href="/ai/templates">{isZh ? "模板中心" : "Templates"}</a>{isSignedIn && <button type="button" onClick={logout}>{isZh ? "退出登录" : "Sign out"}</button>}</div>}
    <main className="mx-auto max-w-[1480px] px-4 pt-8 sm:px-7 lg:px-10">
      <section className="home-intro"><div><p className="eyebrow" style={{ color: ui.accent }}>{isZh ? "AI 创作社区" : "AI CREATIVE COMMUNITY"}</p><h1 style={{ color: ui.text }}>{isZh ? <>把想象，<em>变成作品。</em></> : <>Make ideas<br /><em>visible.</em></>}</h1><p className="max-w-xl text-sm leading-7" style={{ color: ui.muted }}>{isZh ? "从一句话开始，生成图片、视频和完整的视觉灵感。浏览社区作品，找到你的下一种表达。" : "Start with a sentence. Generate images, motion, and visual direction, then find your next expression in the community."}</p></div><div className="hidden items-end gap-2 sm:flex"><span className="status-dot" style={{ background: ui.green }} /><span className="text-[11px]" style={{ color: ui.muted }}>{isZh ? "创作服务在线" : "Creative services online"}</span></div></section>
      <MyWorks jobs={jobs} onPublish={setPublishJob} isZh={isZh} ui={ui} />
      <section id="community" className="mt-9"><div className="section-heading"><div className="flex items-center gap-3"><LayoutGrid size={17} style={{ color: ui.accent }} /><h2 style={{ color: ui.text }}>{isZh ? "社区灵感" : "Community inspiration"}</h2></div><div className="flex items-center gap-1 overflow-x-auto"><div className="segmented-control" style={{ background: ui.raised }}>{MEDIA_TYPES.map((type) => <button key={type} type="button" onClick={() => setFeedType(type)} style={{ background: feedType === type ? ui.surface : "transparent", color: feedType === type ? ui.text : ui.faint }}>{type === "all" ? (isZh ? "全部" : "All") : type === "image" ? (isZh ? "图片" : "Images") : (isZh ? "视频" : "Video")}</button>)}</div><CanvasRoundedSelect label={isZh ? "排序" : "Sort"} value={feedSort} onChange={setFeedSort} options={FEED_SORTS.map((sort) => ({ value: sort, label: sort === "featured" ? (isZh ? "精选优先" : "Featured") : sort === "latest" ? (isZh ? "最新" : "Latest") : (isZh ? "热门" : "Popular") }))} ui={{ ...ui, soft: ui.raised, panelStrong: ui.surface, gold: ui.accent, goldSoft: ui.accentSoft }} className="min-w-[108px]" triggerClassName="sort-select w-full" menuMinWidth={150} /></div></div>
        {feedLoading && !items.length ? <div className="feed-skeleton">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton-card" style={{ background: ui.raised }} />)}</div> : items.length ? <div className="community-grid">{items.map((item) => <MediaCard key={item.id} item={item} onOpen={setSelected} ui={ui} isZh={isZh} />)}</div> : fallbackInspiration.length ? <><div className="mb-4 flex flex-col gap-1 rounded-2xl px-4 py-3 sm:flex-row sm:items-center sm:justify-between" style={{ background: ui.accentSoft, border: `1px solid ${ui.line}` }}><p className="text-xs font-bold" style={{ color: ui.text }}>{isZh ? "社区正在等待第一批公开作品，先从官方精选灵感开始创作。" : "The community is waiting for its first public works. Start with an official inspiration."}</p><span className="text-[10px]" style={{ color: ui.muted }}>{isZh ? "用户私有作品不会被展示" : "Private user work is never shown"}</span></div><div className="community-grid">{fallbackInspiration.map((template) => <TemplateInspirationCard key={template.id} template={template} ui={ui} isZh={isZh} />)}</div></> : <div className="empty-state" style={{ borderColor: ui.line, color: ui.muted }}>{isZh ? "还没有公开作品，成为第一个分享灵感的人。" : "No public work yet. Be the first to share an idea."}</div>}
        <div ref={sentinelRef} className="flex h-16 items-center justify-center">{feedLoading && items.length ? <LoaderCircle size={18} className="animate-spin" style={{ color: ui.accent }} /> : cursor ? <button type="button" onClick={() => loadFeed({ append: true })} className="text-xs font-bold" style={{ color: ui.accent }}>{isZh ? "加载更多" : "Load more"}</button> : null}</div>
      </section>
    </main>
    <div id="create" className="home-composer-wrap"><Composer ui={ui} isSignedIn={isSignedIn} login={login} authAxios={authAxios} isZh={isZh} models={models} onCreated={onCreated} /></div>
    {activeJobCount > 0 && <div className="job-pill" style={{ background: ui.surface, borderColor: ui.line, color: ui.muted }}><LoaderCircle size={15} className="animate-spin" style={{ color: ui.accent }} />{isZh ? `正在处理 ${activeJobCount} 个任务` : `${activeJobCount} task${activeJobCount > 1 ? "s" : ""} running`}<button type="button" onClick={() => window.location.href = "/ai/tasks"} style={{ color: ui.accent }}>{isZh ? "查看" : "View"}</button></div>}
    <footer className="mobile-bottom-nav md:hidden" style={{ background: ui.overlay, borderColor: ui.line }}><a href="#community" style={{ color: ui.text }}><LayoutGrid size={18} /><span>{isZh ? "发现" : "Discover"}</span></a><a href="#create" style={{ color: ui.accent }}><Plus size={19} /><span>{isZh ? "创作" : "Create"}</span></a><a href={isSignedIn ? "/ai" : "#"} onClick={(event) => { if (!isSignedIn) { event.preventDefault(); login(); } }} style={{ color: ui.muted }}><Sparkles size={18} /><span>{isZh ? "工作台" : "Studio"}</span></a></footer>
    <div className="home-language-switch"><HomeLanguageSwitch isZh={isZh} setLocale={setLocale} ui={ui} /></div>
    <CreationDetail item={selected} onClose={() => setSelected(null)} onRefresh={refreshSelected} ui={ui} isSignedIn={isSignedIn} login={login} authAxios={authAxios} resolvePrivateUrl={resolvePrivateUrl} isZh={isZh} />
    <PublishDialog job={publishJob} onClose={() => setPublishJob(null)} onPublished={(creationId) => { setJobs((current) => current.map((job) => String(job.creation_id) === String(creationId) ? { ...job, published: true } : job)); loadFeed(); }} authAxios={authAxios} isZh={isZh} ui={ui} />
  </div>;
}
