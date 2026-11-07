import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import toast from "react-hot-toast";

import { OssImage, OssVideo } from "../components/OssMedia";
import { useLanguage } from "../contexts/LanguageContext";
import useAuthAxios from "../hooks/useAuthAxios";
import { normalizeTemplates } from "../utils/templateData";
import { mergeTemplatePages, shouldShowInitialTemplateLoading } from "../utils/templateMarketplacePagination";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { v4 as uuidv4 } from "uuid";

const FILTERS = [
  { key: "all", icon: "apps", zh: "全部", en: "All" },
  { key: "image", icon: "image", zh: "图片", en: "Image" },
  { key: "video", icon: "movie", zh: "视频", en: "Video" },
  { key: "awesome-gpt-image-2", icon: "auto_awesome", zh: "GPT-Image2 灵感库", en: "GPT-Image2 Library" },
  { key: "digital-human", icon: "co_present", zh: "数字人", en: "Digital Human" },
  { key: "private", icon: "lock", zh: "我的私有模板", en: "My Private" },
];

const TIER_LABELS = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  max: "Max",
  enterprise: "Enterprise",
};

const isDigitalHuman = (template) => String(
  template?.target_provider || template?.provider || "",
).trim().toLowerCase() === "heygen_video_agent";

const matchesFilter = (template, filter) => {
  if (filter === "all") return true;
  if (filter === "private") return template.visibility === "private";
  if (filter === "awesome-gpt-image-2") return template.source_key === "awesome-gpt-image-2";
  if (filter === "digital-human") return isDigitalHuman(template);
  if (filter === "image") return template.output_type === "image";
  if (filter === "video") return template.output_type === "video" && !isDigitalHuman(template);
  return true;
};

const navigateWithTemplate = (navigate, template) => {
  const params = new URLSearchParams({ template: String(template.scene_key || "") });
  if (template.id) params.set("template_id", String(template.id));
  const query = `?${params.toString()}`;
  if (isDigitalHuman(template)) navigate(`/ai/digital-human${query}`);
  else if (template.output_type === "video") navigate(`/ai/ai-video${query}`);
  else navigate(`/ai/scene-image${query}`);
};

const Preview = ({ template, className = "", hoverPreview = false, controls = false }) => {
  const videoRef = useRef(null);
  const authorizePreview = template.visibility !== "public";
  if (template.preview_video_url) {
    return <OssVideo ref={videoRef} src={template.preview_video_url} poster={template.preview_image_url || ""} authorize={authorizePreview} authorizePoster={authorizePreview} controls={controls} muted playsInline preload={hoverPreview ? "none" : "metadata"} onMouseEnter={() => { if (hoverPreview) void videoRef.current?.play().catch(() => {}); }} onMouseLeave={() => { if (!hoverPreview || !videoRef.current) return; videoRef.current.pause(); videoRef.current.currentTime = 0; }} className={className} />;
  }
  if (template.preview_image_url) {
    return <OssImage src={template.preview_image_url} authorize={authorizePreview} loading="lazy" decoding="async" alt={template.preview_title || template.scene_name || ""} className={className} />;
  }
  return (
    <div className={`${className} flex items-center justify-center bg-black/20`}>
      <span className="material-symbols-outlined text-4xl text-white/30">{template.output_type === "video" ? "movie" : "image"}</span>
    </div>
  );
};

const TemplateMarketplace = () => {
  const authAxios = useAuthAxios();
  const navigate = useNavigate();
  const { templateId } = useParams();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentResult, setAgentResult] = useState(null);
  const [detailTemplate, setDetailTemplate] = useState(null);
  const [detailLoading, setDetailLoading] = useState(Boolean(templateId));
  const [detailError, setDetailError] = useState(false);
  const activeRequestRef = useRef(null);

  const load = useCallback(async (requestedPage, { append = false } = {}) => {
    activeRequestRef.current?.abort();
    const controller = new AbortController();
    activeRequestRef.current = controller;
    if (append) setLoadingMore(true);
    else {
      setLoading(true);
      setLoadingMore(false);
    }
    try {
      const { data } = await authAxios.get("/api/template-studio/prompt-templates", {
        signal: controller.signal,
        params: { catalog: "marketplace", page: requestedPage, page_size: 48, search: query || undefined, output_type: filter === "image" || filter === "video" ? filter : undefined, source_key: filter === "awesome-gpt-image-2" ? filter : undefined, tag: tag || undefined, visibility: filter === "private" ? "private" : undefined },
      });
      if (controller.signal.aborted) return;
      const rows = normalizeTemplates(data?.data || []);
      setTemplates((current) => append ? mergeTemplatePages(current, rows) : rows);
      setPage(requestedPage);
      setHasMore(Boolean(data?.meta?.has_more));
    } catch (error) {
      if (controller.signal.aborted || error?.code === "ERR_CANCELED") return;
      toast.error(error.response?.data?.message || t("加载模板市场失败", "Failed to load templates"));
    } finally {
      if (activeRequestRef.current === controller) {
        activeRequestRef.current = null;
        if (append) setLoadingMore(false);
        else setLoading(false);
      }
    }
  }, [authAxios, filter, query, t, tag]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(1); }, query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      activeRequestRef.current?.abort();
    };
  }, [load, query]);

  const tags = useMemo(() => [...new Set(templates.flatMap((template) => template.tags || []))].slice(0, 24), [templates]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return templates.filter((template) => {
      if (!matchesFilter(template, filter)) return false;
      if (tag && !(template.tags || []).includes(tag)) return false;
      if (!needle) return true;
      return [
        template.scene_name,
        template.preview_title,
        template.preview_description,
        template.scene_key,
        ...(template.tags || []),
      ].filter(Boolean).join(" ").toLowerCase().includes(needle);
    });
  }, [filter, query, tag, templates]);

  const selected = templateId
    ? detailTemplate || templates.find((template) => String(template.id) === String(templateId) || template.scene_key === templateId)
    : null;
  const initialLoading = shouldShowInitialTemplateLoading({ loading, itemCount: templates.length });

  useEffect(() => {
    if (!templateId) {
      setDetailTemplate(null);
      setDetailLoading(false);
      setDetailError(false);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setDetailError(false);
    authAxios.get(`/api/template-studio/prompt-templates/${encodeURIComponent(templateId)}`)
      .then(({ data }) => {
        if (!active) return;
        const row = normalizeTemplates([data?.data])[0] || null;
        setDetailTemplate(row);
        setDetailError(!row);
      })
      .catch(() => { if (active) setDetailError(true); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [authAxios, templateId]);

  const runWithAgent = async () => {
    if (!selected || !agentPrompt.trim() || agentRunning) return;
    setAgentRunning(true);
    try {
      const sessionId = window.localStorage.getItem("stardraw_global_agent_session") || crypto.randomUUID();
      window.localStorage.setItem("stardraw_global_agent_session", sessionId);
      const savedMode = window.localStorage.getItem("stardraw_agent_access_mode");
      const agentMode = ["ask_for_approval", "approve_for_me", "full_access"].includes(savedMode) ? savedMode : "approve_for_me";
      const { data } = await authAxios.post("/api/agent/plan", {
        instruction: agentPrompt.trim(), sessionId, language: document.documentElement.lang === "en" ? "en" : "zh",
        context: { source: "template_detail", currentPath: window.location.pathname, template: { id: selected.id, sceneKey: selected.scene_key } },
      }, { headers: { "X-Idempotency-Key": `template-agent:${uuidv4()}` } });
      const calls = data?.data?.calls || [];
      const generation = calls.find((call) => call.toolKey === (selected.output_type === "video" ? "media.generate.video" : "media.generate.image"));
      if (!generation) throw new Error(t("Agent 没有返回可执行的生成步骤", "Agent returned no generation step"));
      const params = {
        ...generation.parameters,
        templateId: selected.id,
        templateVersion: selected.version,
        sceneKey: selected.scene_key,
        userModification: agentPrompt.trim(),
        model: generation.parameters?.model || selected.default_model,
        size: generation.parameters?.size || selected.default_size,
      };
      const assessment = await authAxios.post("/api/agent/tools/assess", { agentMode, sessionId, toolKey: generation.toolKey, parameters: params });
      let approvalToken = null;
      if (assessment.data?.data?.requiresApproval) {
        if (!window.confirm(t("Agent 将按此模板提交生成任务，是否继续？", "The Agent will submit this template generation. Continue?"))) return;
        const approval = await authAxios.post("/api/agent/approvals", { confirmed: true, agentMode, sessionId, toolKey: generation.toolKey, parameters: params, reason: "Template detail generation" });
        approvalToken = approval.data?.data?.approval_token || null;
      }
      const execution = await authAxios.post("/api/agent/tools/execute", { agentMode, sessionId, toolKey: generation.toolKey, parameters: params, approvalToken }, { headers: { "X-Idempotency-Key": `template-generation:${uuidv4()}` } });
      setAgentResult(execution.data?.data?.result || null);
      toast.success(t("已按模板提交生成任务", "Generation submitted with template"));
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("生成失败", "Generation failed"));
    } finally { setAgentRunning(false); }
  };

  if (templateId) {
    if (detailLoading) return <div className="flex min-h-[60vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: ui.primary, borderTopColor: "transparent" }} /></div>;
    if (!selected || detailError) {
      return (
        <div className="mx-auto flex min-h-[60vh] max-w-3xl items-center justify-center p-6">
          <div className="text-center">
            <span className="material-symbols-outlined text-4xl" style={{ color: ui.faint }}>search_off</span>
            <p className="mt-3 text-sm" style={{ color: ui.muted }}>{t("模板不存在或当前账号无权查看", "Template not found or unavailable")}</p>
            <button type="button" onClick={() => navigate("/ai/templates")} className="mt-4 rounded-lg px-4 py-2 text-sm font-bold" style={{ background: ui.primary, color: ui.primaryText }}>{t("返回模板市场", "Back to templates")}</button>
          </div>
        </div>
      );
    }

    return (
      <div className="mx-auto max-w-7xl p-4 md:p-8">
        <button type="button" onClick={() => navigate("/ai/templates")} className="mb-5 inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-bold" style={{ color: ui.muted, border: `1px solid ${ui.line}` }}>
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>{t("模板市场", "Templates")}
        </button>
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]">
          <div className="overflow-hidden rounded-lg" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
            <Preview template={selected} controls className="aspect-video h-full max-h-[680px] w-full object-contain" />
          </div>
          <section className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: ui.faint }}>
              <span>{selected.output_type}</span>
              <span>v{selected.version || 1}</span>
              <span>{selected.visibility === "private" ? t("私有", "Private") : t("公开", "Public")}</span>
              {selected.source_key === "awesome-gpt-image-2" && <span style={{ color: ui.primary }}>GPT-Image2 Library</span>}
            </div>
            <h1 className="mt-3 text-2xl font-black md:text-3xl" style={{ color: ui.text }}>{selected.preview_title || selected.scene_name}</h1>
            <p className="mt-4 text-sm leading-7" style={{ color: ui.muted }}>{selected.preview_description || t("可直接用于生成流程的模板。", "A ready-to-use generation template.")}</p>
            <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg" style={{ background: ui.line, border: `1px solid ${ui.line}` }}>
              {[
                [t("模型", "Model"), selected.default_model || "-"],
                [t("尺寸", "Size"), selected.default_size || "Auto"],
                [t("预计积分", "Estimated"), selected.points_cost ?? "-"],
                [t("会员门槛", "Membership"), TIER_LABELS[selected.required_membership_tier || "free"]],
              ].map(([label, value]) => <div key={label} className="p-3" style={{ background: ui.surface }}><dt className="text-[10px] uppercase" style={{ color: ui.faint }}>{label}</dt><dd className="mt-1 truncate text-sm font-bold" style={{ color: ui.text }}>{value}</dd></div>)}
            </dl>
            {selected.starter_prompt && <div className="mt-5 rounded-lg p-4 text-sm leading-6" style={{ background: ui.surfaceAlt, color: ui.muted, border: `1px solid ${ui.line}` }}>{selected.starter_prompt}</div>}
            <div className="mt-5 flex flex-wrap gap-2">{(selected.tags || []).map((item) => <span key={item} className="rounded-full px-2.5 py-1 text-[11px]" style={{ background: ui.primarySoft, color: ui.primary }}>{item}</span>)}</div>
            <div className="mt-6 rounded-lg p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
              <div className="flex items-center gap-2 text-xs font-black" style={{ color: ui.primary }}><span className="material-symbols-outlined text-[17px]">auto_awesome</span>{t("让 Agent 融合你的要求", "Ask Agent to blend your request")}</div>
              <textarea value={agentPrompt} onChange={(event) => setAgentPrompt(event.target.value)} rows={3} placeholder={t("例如：更明亮、改成 16:9、增加蓝色玻璃材质", "Example: brighter, 16:9, add blue glass material")} className="mt-3 w-full resize-y rounded-md p-3 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
              <button type="button" disabled={!agentPrompt.trim() || agentRunning} onClick={runWithAgent} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary }}><span className="material-symbols-outlined text-[17px]">{agentRunning ? "progress_activity" : "play_arrow"}</span>{agentRunning ? t("提交中…", "Submitting…") : t("融合并生成", "Blend and generate")}</button>
              {agentResult && <p className="mt-2 text-xs font-bold" style={{ color: ui.primary }}>{t(`已创建作品 #${agentResult.creationId || agentResult.creation_id || "-"}`, `Created #${agentResult.creationId || agentResult.creation_id || "-"}`)}</p>}
            </div>
            <button type="button" onClick={() => navigateWithTemplate(navigate, selected)} className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-lg px-5 py-3 text-sm font-black" style={{ background: ui.primary, color: ui.primaryText }}>
              <span className="material-symbols-outlined text-[19px]">arrow_forward</span>{t("使用此模板", "Use template")}
            </button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] p-4 md:p-8">
      <div className="flex flex-col justify-between gap-4 border-b pb-6 lg:flex-row lg:items-end" style={{ borderColor: ui.line }}>
        <div><h1 className="text-2xl font-black md:text-3xl" style={{ color: ui.text }}>{t("模板市场", "Template Marketplace")}</h1><p className="mt-2 text-sm" style={{ color: ui.muted }}>{t("浏览公开模板和你的私有模板，并直接进入生成流程。", "Browse public and private templates and start creating.")}</p></div>
        <button type="button" onClick={() => navigate("/ai/template-studio")} className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-bold" style={{ border: `1px solid ${ui.line}`, color: ui.text }}><span className="material-symbols-outlined text-[18px]">add</span>{t("管理我的模板", "Manage my templates")}</button>
      </div>

      <div className="sticky top-0 z-10 -mx-2 mt-5 space-y-3 px-2 py-3" style={{ background: ui.page }}>
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2.5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}><span className="material-symbols-outlined text-[19px]" style={{ color: ui.faint }}>search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索模板、标签或场景", "Search templates, tags, or scenes")} className="min-w-0 flex-1 bg-transparent text-sm outline-none" style={{ color: ui.text }} /></label>
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg p-1" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>{FILTERS.map((item) => <button key={item.key} type="button" onClick={() => setFilter(item.key)} className="flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-xs font-bold" style={{ background: filter === item.key ? ui.surfaceHigh : "transparent", color: filter === item.key ? ui.primary : ui.muted }}><span className="material-symbols-outlined text-[16px]">{item.icon}</span>{t(item.zh, item.en)}</button>)}</div>
        </div>
        {tags.length > 0 && <div className="flex gap-2 overflow-x-auto pb-1"><button type="button" onClick={() => setTag("")} className="shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold" style={{ background: !tag ? ui.primarySoft : ui.surface, color: !tag ? ui.primary : ui.muted, border: `1px solid ${ui.line}` }}>{t("全部标签", "All tags")}</button>{tags.map((item) => <button key={item} type="button" onClick={() => setTag(item === tag ? "" : item)} className="shrink-0 rounded-full px-3 py-1.5 text-[11px]" style={{ background: tag === item ? ui.primarySoft : ui.surface, color: tag === item ? ui.primary : ui.muted, border: `1px solid ${ui.line}` }}>{item}</button>)}</div>}
      </div>

      {initialLoading ? <div className="flex min-h-[40vh] items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent" style={{ borderColor: ui.primary, borderTopColor: "transparent" }} /></div> : filtered.length === 0 ? <div className="py-20 text-center text-sm" style={{ color: ui.muted }}>{t("没有匹配的模板", "No matching templates")}</div> : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filtered.map((template) => (
            <article key={template.id || template.scene_key} className="group overflow-hidden rounded-lg" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
              <button type="button" onClick={() => navigateWithTemplate(navigate, template)} className="block w-full text-left"><div className="relative aspect-video overflow-hidden"><Preview template={template} hoverPreview className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]" /><div className="absolute left-2 top-2 flex flex-wrap gap-1">{template.is_featured && <span className="rounded-md px-2 py-1 text-[10px] font-black" style={{ background: ui.gold, color: "#171717" }}>{t("优选", "Featured")}</span>}{template.source_key === "awesome-gpt-image-2" && <span className="rounded-md bg-black/70 px-2 py-1 text-[10px] font-black text-white">GPT-Image2</span>}</div><span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-2 py-1 text-[10px] font-bold text-white">{TIER_LABELS[template.required_membership_tier || "free"]}</span></div><div className="p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h2 className="truncate text-sm font-black" style={{ color: ui.text }}>{template.preview_title || template.scene_name}</h2><p className="mt-1 line-clamp-2 min-h-9 text-xs leading-[18px]" style={{ color: ui.muted }}>{template.preview_description || template.scene_key}</p></div><span className="material-symbols-outlined text-[18px]" style={{ color: ui.faint }}>arrow_outward</span></div><div className="mt-3 flex items-center justify-between text-[10px]" style={{ color: ui.faint }}><span>{template.output_type === "video" ? t("视频", "Video") : t("图片", "Image")} · v{template.version || 1}</span><span>{template.points_cost ?? "-"} pt</span></div></div></button>
              <div className="border-t p-2" style={{ borderColor: ui.line }}><button type="button" onClick={() => navigateWithTemplate(navigate, template)} className="flex w-full items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}><span className="material-symbols-outlined text-[16px]">play_arrow</span>{t("一键使用", "Use")}</button></div>
            </article>
          ))}
        </div>
      )}
      {!initialLoading && hasMore && <div className="mt-7 flex justify-center"><button type="button" disabled={loading || loadingMore} onClick={() => void load(page + 1, { append: true })} className="rounded-lg px-5 py-2.5 text-sm font-black disabled:cursor-wait disabled:opacity-60" style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.line}` }}>{loadingMore ? t("正在加载更多…", "Loading more…") : t("加载更多", "Load more")}</button></div>}
    </div>
  );
};

export default TemplateMarketplace;
