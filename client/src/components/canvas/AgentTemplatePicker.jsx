import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Film, Image as ImageIcon, LoaderCircle, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";

import { OssImage, OssVideo } from "../OssMedia";
import CanvasIconButton from "./CanvasIconButton";
import CanvasRoundedSelect from "./CanvasRoundedSelect";

const dedupeModels = (models) => [...new Map((models || []).filter((item) => item?.model_key).map((item) => [item.model_key, item])).values()];
const templateCategory = (template) => String(template?.catalog_metadata?.category || template?.source_key || template?.tags?.[0] || "").trim();

const TemplatePreview = ({ template, t, ui }) => {
  const privateAsset = template.visibility !== "public";
  if (template.preview_video_url) {
    return <OssVideo src={template.preview_video_url} poster={template.preview_image_url || ""} authorize={privateAsset} authorizePoster={privateAsset} muted playsInline preload="metadata" className="h-full w-full object-cover" />;
  }
  if (template.preview_image_url) {
    return <OssImage src={template.preview_image_url} authorize={privateAsset} loading="lazy" decoding="async" alt={template.preview_title || template.scene_name || ""} className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.025]" />;
  }
  return <div className="flex h-full items-center justify-center" style={{ color: template.output_type === "video" ? ui.gold : ui.blue }}>{template.output_type === "video" ? <Film size={24} /> : <ImageIcon size={24} />}<span className="sr-only">{t("暂无预览", "No preview")}</span></div>;
};

const AgentTemplatePicker = ({ open, onClose, authAxios, onSelect, modelOptions = [], ui, t }) => {
  const [query, setQuery] = useState("");
  const [outputType, setOutputType] = useState("");
  const [tag, setTag] = useState("");
  const [category, setCategory] = useState("");
  const [model, setModel] = useState("");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [facets, setFacets] = useState({ categories: [], tags: [] });
  const [error, setError] = useState(null);
  const requestRef = useRef(null);
  const facetsLoadedRef = useRef(false);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(async () => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setLoading(true);
      try {
        const response = await authAxios.get("/api/template-studio/prompt-templates", {
          signal: controller.signal,
          params: {
            catalog: "marketplace",
            search: query.trim() || undefined,
            output_type: outputType || undefined,
            tag: tag || undefined,
            category: category || undefined,
            model: model || undefined,
            page: 1,
            page_size: 24,
            include_facets: facetsLoadedRef.current ? undefined : "true",
          },
        });
        if (controller.signal.aborted) return;
        setRows(response.data?.data || []);
        setPage(1);
        setHasMore(Boolean(response.data?.meta?.has_more));
        if (response.data?.meta?.facets) {
          setFacets({
            categories: Array.isArray(response.data.meta.facets.categories) ? response.data.meta.facets.categories : [],
            tags: Array.isArray(response.data.meta.facets.tags) ? response.data.meta.facets.tags : [],
          });
          facetsLoadedRef.current = true;
        }
        setError(null);
      } catch (requestError) {
        if (!controller.signal.aborted && requestError?.code !== "ERR_CANCELED") setError(requestError);
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = null;
          setLoading(false);
        }
      }
    }, query ? 320 : 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [authAxios, category, model, open, outputType, query, tag]);

  const loadMore = async () => {
    if (loading || loadingMore || !hasMore) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const response = await authAxios.get("/api/template-studio/prompt-templates", {
        params: { catalog: "marketplace", search: query.trim() || undefined, output_type: outputType || undefined, tag: tag || undefined, category: category || undefined, model: model || undefined, page: nextPage, page_size: 24 },
      });
      const additions = response.data?.data || [];
      setRows((current) => [...new Map([...current, ...additions].map((item) => [String(item.id || item.scene_key), item])).values()]);
      setPage(nextPage);
      setHasMore(Boolean(response.data?.meta?.has_more));
      setError(null);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setLoadingMore(false);
    }
  };

  const tags = useMemo(() => facets.tags.length > 0
    ? facets.tags
    : [...new Set(rows.flatMap((item) => item.tags || []).filter(Boolean))], [facets.tags, rows]);
  const categories = useMemo(() => facets.categories.length > 0
    ? facets.categories
    : [...new Set(rows.map(templateCategory).filter(Boolean))], [facets.categories, rows]);
  const models = useMemo(() => dedupeModels(modelOptions), [modelOptions]);

  if (!open || typeof document === "undefined") return null;
  return createPortal((
    <div className="fixed inset-0 z-[205] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={t("模板市场", "Template marketplace")}>
      <button type="button" className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label={t("关闭模板市场", "Close template marketplace")} />
      <section className="relative z-10 flex h-[min(780px,calc(100vh-32px))] w-full max-w-[1120px] flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_80px_rgba(0,0,0,.3)]" style={{ background: ui.panelStrong, borderColor: ui.line, color: ui.text }}>
        <header className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3.5 sm:px-5" style={{ borderColor: ui.line }}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.gold }}><Sparkles size={17} /></span>
            <div className="min-w-0"><h2 className="text-sm font-semibold">{t("选择创作模板", "Choose a creation template")}</h2><p className="mt-0.5 truncate text-[10px]" style={{ color: ui.faint }}>{t("模板会作为结构化附件加入当前画布对话", "The template is attached as structured context to this canvas conversation")}</p></div>
          </div>
          <CanvasIconButton label={t("关闭", "Close")} tooltipSide="bottom" onClick={onClose} style={{ background: ui.soft, color: ui.muted }}><X size={13} /></CanvasIconButton>
        </header>

        <div className="shrink-0 space-y-2.5 border-b px-4 py-3 sm:px-5" style={{ borderColor: ui.line }}>
          <div className="flex flex-col gap-2 md:flex-row">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border px-3" style={{ background: ui.inspectorInput, borderColor: ui.line2 || ui.line }}><Search size={13} style={{ color: ui.faint }} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索关键词、风格、场景或用途", "Search keywords, styles, scenes, or use cases")} className="min-w-0 flex-1 bg-transparent text-xs outline-none" /></label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:flex">
              <CanvasRoundedSelect label={t("输出类型", "Output type")} value={outputType} onChange={setOutputType} options={[{ value: "", label: t("图片和视频", "Image & video") }, { value: "image", label: t("图片", "Image") }, { value: "video", label: t("视频", "Video") }]} ui={ui} className="min-w-0" triggerClassName="h-9 w-full px-2.5 text-[10px]" menuMinWidth={160} />
              <CanvasRoundedSelect label={t("分类", "Category")} value={category} onChange={setCategory} options={[{ value: "", label: t("全部分类", "All categories") }, ...categories.map((item) => ({ value: item, label: item }))]} ui={ui} className="min-w-0" triggerClassName="h-9 w-full px-2.5 text-[10px]" menuMinWidth={180} />
              <CanvasRoundedSelect label={t("模型", "Model")} value={model} onChange={setModel} options={[{ value: "", label: t("全部模型", "All models") }, ...models.map((item) => ({ value: item.model_key, label: item.display_name || item.model_key }))]} ui={ui} className="min-w-0 max-w-48" triggerClassName="h-9 w-full px-2.5 text-[10px]" menuMinWidth={220} />
              <button type="button" onClick={() => { setQuery(""); setOutputType(""); setTag(""); setCategory(""); setModel(""); }} className="inline-flex h-9 items-center justify-center gap-1 rounded-full border px-3 text-[10px] shadow-sm" style={{ background: ui.soft, borderColor: ui.line, color: ui.muted }}><SlidersHorizontal size={11} />{t("重置", "Reset")}</button>
            </div>
          </div>
          {tags.length > 0 && <div className="flex gap-1.5 overflow-x-auto pb-0.5"><button type="button" onClick={() => setTag("")} className="shrink-0 rounded-full border px-2 py-1 text-[9px]" style={{ background: !tag ? ui.goldSoft : "transparent", borderColor: !tag ? ui.goldLine : ui.line, color: !tag ? ui.gold : ui.faint }}>{t("全部标签", "All tags")}</button>{tags.slice(0, 80).map((item) => <button key={item} type="button" onClick={() => setTag(item === tag ? "" : item)} className="shrink-0 rounded-full border px-2 py-1 text-[9px]" style={{ background: tag === item ? ui.goldSoft : "transparent", borderColor: tag === item ? ui.goldLine : ui.line, color: tag === item ? ui.gold : ui.faint }}>{item}</button>)}</div>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {error && <p className="mb-3 rounded-xl px-3 py-2 text-[11px]" style={{ background: ui.dangerSoft, color: ui.danger }}>{error.response?.data?.message || t("模板加载失败", "Failed to load templates")}</p>}
          {loading && rows.length === 0 && <div className="flex h-64 items-center justify-center gap-2 text-xs" style={{ color: ui.faint }}><LoaderCircle size={15} className="animate-spin" />{t("正在搜索模板…", "Searching templates...")}</div>}
          {!loading && rows.length === 0 && <div className="flex h-64 flex-col items-center justify-center rounded-[18px] border border-dashed text-center" style={{ borderColor: ui.line, color: ui.faint }}><Search size={22} /><p className="mt-3 text-xs font-medium">{t("没有匹配的模板", "No matching templates")}</p></div>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map((template) => {
              const isVideo = template.output_type === "video";
              return (
                <button key={template.id || template.scene_key} type="button" onClick={() => onSelect(template)} className="group overflow-hidden rounded-[16px] border text-left transition duration-200 hover:-translate-y-0.5 hover:shadow-lg" style={{ background: ui.soft, borderColor: ui.line }}>
                  <div className="relative aspect-video overflow-hidden" style={{ background: ui.soft2 }}>
                    <TemplatePreview template={template} t={t} ui={ui} />
                    <span className="absolute left-2 top-2 flex items-center gap-1 rounded-full bg-black/65 px-1.5 py-1 text-[9px] font-semibold text-white">{isVideo ? <Film size={9} /> : <ImageIcon size={9} />}{isVideo ? t("视频", "Video") : t("图片", "Image")}</span>
                    <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white opacity-0 transition group-hover:opacity-100"><Check size={12} /></span>
                  </div>
                  <div className="p-3">
                    <p className="truncate text-xs font-semibold">{template.preview_title || template.scene_name || template.scene_key}</p>
                    <p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4" style={{ color: ui.faint }}>{template.preview_description || template.starter_prompt || template.scene_key}</p>
                    <div className="mt-2.5 flex items-center justify-between gap-2 text-[9px]" style={{ color: ui.muted }}><span className="truncate">{template.default_model || t("默认模型", "Default model")}</span><span className="shrink-0">{template.points_cost ?? "-"} pt</span></div>
                  </div>
                </button>
              );
            })}
          </div>
          {hasMore && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-full border text-xs font-medium shadow-sm disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }}>{loadingMore && <LoaderCircle size={12} className="animate-spin" />}{loadingMore ? t("加载中…", "Loading...") : t("加载更多", "Load more")}</button>}
        </div>
      </section>
    </div>
  ), document.body);
};

export default AgentTemplatePicker;
