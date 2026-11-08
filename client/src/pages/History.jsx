import { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import useAuthAxios from "../hooks/useAuthAxios";
import toast from "react-hot-toast";
import { v4 as uuidv4 } from "uuid";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import AssetPreviewModal from "../components/AssetPreviewModal";
import { createHistoryLoadState, parseHistoryResponse, historyLoadReducer, isHistoryRequestCancelled, getHistoryLoadErrorMessage } from "../utils/historyLoadState";

const PAGE_SIZE = 12;

const getStatusColors = (ui) => ({
  completed: { color: ui.primary, bg: ui.primarySoft },
  running:   { color: ui.gold, bg: ui.goldSoft },
  pending:   { color: ui.muted, bg: ui.surfaceHigh },
  failed:    { color: ui.danger, bg: ui.dangerSoft },
});

const AssetCard = ({ item, selected, onToggle, onSingleDownload, onDelete, onAddToCanvas, onOrderQuote, onPreview, deletingId, ui }) => {
  const { t, isZh } = useLanguage();
  const isExpired  = item.expires_at && new Date(item.expires_at) < new Date();
  const canAct     = item.status === "completed" && !isExpired;
  const statusColors = getStatusColors(ui);
  const sCfg       = statusColors[item.status] || statusColors.completed;
  const isDeleting = String(deletingId) === String(item.id);
  const canDelete = !["pending", "queued", "processing", "running"].includes(String(item.status || "").toLowerCase());
  const isCompletedVideo = item.type === "video" && item.status === "completed";
  const previewVideoUrl = item.preview_video_url || (isCompletedVideo ? item.content : null);
  const imagePreviewUrl = item.reference_preview_url
    || item.preview_image_url
    || item.thumbnail_url
    || (item.type === "image" ? item.content : null);
  const shouldShowVideo = Boolean(isCompletedVideo && previewVideoUrl);
  const canPreview = Boolean(canAct && (shouldShowVideo || imagePreviewUrl));
  const daysLeft   = item.expires_at
    ? Math.max(0, Math.ceil((new Date(item.expires_at) - Date.now()) / 86400000))
    : null;

  return (
    <div className="stardraw-asset-card group rounded-2xl overflow-hidden flex flex-col transition-all duration-200"
      style={{
        background: ui.surface,
        border: `1px solid ${ui.line}`,
        boxShadow: ui.shadow,
        ...(selected && { outline: `2px solid ${ui.primary}66` }),
      }}>
      {/* Thumbnail */}
      <div className="relative overflow-hidden" style={{ aspectRatio: "16/9", background: ui.surfaceAlt }}>
        <button
          type="button"
          disabled={!canPreview}
          onClick={() => canPreview && onPreview(item)}
          aria-label={canPreview ? t("放大预览", "Open preview") : undefined}
          className={`absolute inset-0 z-10 h-full w-full text-left ${canPreview ? "cursor-zoom-in" : "cursor-default"}`}
        >
          {shouldShowVideo
            ? (
              <OssVideo
                key={previewVideoUrl}
                src={previewVideoUrl}
                poster={item.preview_image_url || item.thumbnail_url || item.reference_preview_url || undefined}
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              />
            )
            : imagePreviewUrl
              ? <OssImage src={imagePreviewUrl} alt="" className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
              : <div className="w-full h-full flex items-center justify-center">
                  <span className="material-symbols-outlined text-4xl" style={{ color: ui.faint }}>
                    {item.type === "video" ? "movie_filter" : "auto_awesome"}
                  </span>
                </div>
          }
          {canPreview && (
            <span className="absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              style={{ background: ui.overlay, border: `1px solid ${ui.line}`, color: ui.text }}>
              <span className="material-symbols-outlined text-[18px]">zoom_in</span>
            </span>
          )}
        </button>

        {/* Status badge */}
        <div className="absolute top-3 right-3 z-20 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold"
          style={{ background: ui.overlay, border: `1px solid ${ui.line}`, backdropFilter: "blur(10px)", color: sCfg.color }}>
          {item.status === "running" || item.status === "pending"
            ? <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: sCfg.color }} />
            : <span className="w-1.5 h-1.5 rounded-full" style={{ background: sCfg.color }} />
          }
          {{
            completed: t("已完成", "COMPLETED"),
            running: t("处理中", "PROCESSING"),
            pending: t("排队中", "QUEUED"),
            failed: t("失败", "FAILED"),
          }[item.status] || item.status}
        </div>

        {/* Expired overlay */}
        {isExpired && (
          <div className="absolute inset-0 z-20 flex items-center justify-center"
            style={{ background: ui.overlay }}>
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: ui.faint }}>
              {t("已过期", "Expired")}
            </span>
          </div>
        )}

        {/* Select checkbox */}
        {canAct && (
          <button onClick={() => onToggle(item.id)}
            className="absolute top-3 left-3 z-30 w-6 h-6 rounded-md flex items-center justify-center transition-all"
            style={{
              background: selected ? ui.primary : ui.overlay,
              border: `1px solid ${selected ? ui.primary : ui.lineStrong}`,
              color: selected ? ui.primaryText : ui.faint,
            }}>
            {selected && <span className="material-symbols-outlined text-[14px] filled">check</span>}
          </button>
        )}
      </div>

      {/* Info */}
      <div className="p-5 flex flex-col flex-1">
        <div className="mb-3">
          <h3 className="font-bold text-sm leading-snug mb-1 truncate"
            style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {item.scene_name || t("AI 生成任务", "AI Generation")}
          </h3>
          <p className="text-[10px] uppercase tracking-widest font-semibold" style={{ color: ui.muted, opacity: 0.72 }}>
            {item.type === "video" ? t("视频", "video") : t("图片", "image")} • {new Date(item.created_at).toLocaleDateString(isZh ? "zh-CN" : "en-US")}
            {item.points_cost > 0 && ` • ${item.points_cost} ${t("积分", "pts")}`}
          </p>
        </div>

        {/* Expiry indicator */}
        {daysLeft !== null && !isExpired && (
          <div className="mb-3">
            <div className="flex justify-between text-[10px] mb-1" style={{ color: ui.faint }}>
              <span>{t("剩余有效期", "Expires in")}</span>
              <span style={{ color: daysLeft <= 5 ? ui.danger : ui.muted }}>{daysLeft}{t("天", "d")}</span>
            </div>
            <div className="w-full h-1 rounded-full" style={{ background: ui.surfaceAlt }}>
              <div className="h-full rounded-full"
                style={{
                  width: `${Math.min(100, (daysLeft / 30) * 100)}%`,
                  background: daysLeft <= 5 ? ui.danger : ui.primary,
                }} />
            </div>
          </div>
        )}

        {/* Download button */}
        <div className="mt-auto">
          <button
            onClick={() => canAct && onSingleDownload(item.id)}
            disabled={!canAct}
            className="w-full py-2.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
            style={{
              background: canAct
                ? ui.buttonGradient
                : ui.surfaceHigh,
              color: canAct ? ui.primaryText : ui.faint,
              fontFamily: "Manrope, sans-serif",
            }}>
            <span className="material-symbols-outlined text-sm">download</span>
            {isExpired
              ? t("已过期", "Expired")
              : canAct
                ? t("下载无水印原图", "Download Without Watermark")
                : item.status === "failed"
                  ? t("生成失败", "Failed")
                  : t("处理中…", "Processing…")}
          </button>
          {canAct && item.type === "image" && (
            <button
              type="button"
              onClick={() => onOrderQuote(item)}
              className="w-full mt-2 py-2.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-all active:scale-95"
              style={{
                background: ui.primarySoft,
                color: ui.primary,
                border: `1px solid ${ui.primary}66`,
                fontFamily: "Manrope, sans-serif",
              }}>
              <span className="material-symbols-outlined text-sm">chat</span>
              {t("把这张作品做成实物", "Make this into a product")}
            </button>
          )}
          {canAct && (
            <button
              onClick={() => onAddToCanvas(item)}
              className="w-full mt-2 py-2.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-all active:scale-95"
              style={{
                background: ui.goldSoft,
                color: ui.gold,
                border: `1px solid ${ui.gold}44`,
                fontFamily: "Manrope, sans-serif",
              }}>
              <span className="material-symbols-outlined text-sm">gesture</span>
              {t("加入画布", "Add to Canvas")}
            </button>
          )}
          {canDelete && (
            <button
              onClick={() => onDelete(item)}
              disabled={isDeleting}
              className="w-full mt-2 py-2.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: ui.dangerSoft,
                color: ui.danger,
                border: `1px solid ${ui.danger}44`,
                fontFamily: "Manrope, sans-serif",
              }}>
              {isDeleting
                ? <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                : <span className="material-symbols-outlined text-sm">delete</span>}
              {isDeleting ? t("删除中…", "Deleting…") : t("删除素材", "Delete asset")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

const History = () => {
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const [tab,       setTab]       = useState("all");
  const [history, dispatchHistory] = useReducer(historyLoadReducer, undefined, createHistoryLoadState);
  const { items, page, total, loading, error: loadError, hasLoaded, requestedPage } = history;
  const requestSerialRef = useRef(0);
  const requestControllerRef = useRef(null);
  const [selected,  setSelected]  = useState(new Set());
  const [batchLoading, setBatch]  = useState(false);
  const [deletingId, setDeletingId] = useState(null);
  const [previewItem, setPreviewItem] = useState(null);
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get("q") || "");

  const typeParam = tab === "all" ? undefined : tab;

  const syncPendingVideos = useCallback(async (list) => {
    const targets = list.filter((item) =>
      item.type === "video" && (item.status === "pending" || item.status === "running")
    );
    if (targets.length === 0) return;

    const results = await Promise.allSettled(
      targets.map((item) => authAxios.get(`/api/ai/video-status/${item.id}`))
    );

    const updatesById = new Map();
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const payload = result.value?.data || {};
      if (!payload?.status) return;

      const target = targets[index];
      const idKey = String(payload.creation_id ?? target.id);
      updatesById.set(idKey, {
        status: payload.status,
        provider_status: payload.provider_status ?? target.provider_status,
        content: payload.content ?? target.content,
        thumbnail_url: payload.thumbnail_url ?? target.thumbnail_url,
        error_message: payload.error_message ?? target.error_message,
        expires_at: payload.expires_at ?? target.expires_at,
        points_reserved: payload.points_reserved ?? target.points_reserved,
        points_cost: payload.points_charged ?? target.points_cost,
        preview_video_url: payload.status === "completed" && payload.content
          ? payload.content
          : target.preview_video_url,
        preview_image_url: payload.thumbnail_url ?? target.preview_image_url,
      });
      if (payload.status === "completed" || payload.status === "failed") {
        window.dispatchEvent(new Event("stardraw:points-updated"));
      }
    });

    if (updatesById.size === 0) return;

    dispatchHistory({ type: "patch", scope: tab, updates: updatesById });
  }, [authAxios, tab]);

  const load = useCallback((pg = 1) => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const requestId = ++requestSerialRef.current;
    dispatchHistory({ type: "start", scope: tab, page: pg, requestId });
    const params = new URLSearchParams({ page: pg, page_size: PAGE_SIZE });
    if (typeParam) params.set("type", typeParam);
    authAxios.get(`/api/user/get-user-creations?${params}`, { signal: controller.signal, timeout: 15_000 })
      .then((response) => {
        if (controller.signal.aborted || requestId !== requestSerialRef.current) return;
        const result = parseHistoryResponse(response.data);
        dispatchHistory({ type: "success", requestId, ...result });
        void syncPendingVideos(result.items);
      })
      .catch((error) => {
        if (controller.signal.aborted || isHistoryRequestCancelled(error)) {
          dispatchHistory({ type: "cancel", requestId });
          return;
        }
        dispatchHistory({ type: "failure", requestId, error });
      });
  }, [tab, typeParam, authAxios, syncPendingVideos]);

  useEffect(() => {
    setSelected(new Set());
    load(1);
    return () => requestControllerRef.current?.abort();
  }, [tab, load]);

  useEffect(() => {
    setQuery(new URLSearchParams(location.search).get("q") || "");
  }, [location.search]);

  const loadMore = () => { if (!loading) load(page + 1); };

  const toggleSelect = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const selectAllCompleted = () => {
    const completedIds = visibleItems
      .filter(i => i.status === "completed" && (!i.expires_at || new Date(i.expires_at) > new Date()))
      .map(i => i.id);
    setSelected(new Set(completedIds));
  };

  const clearSelection = () => setSelected(new Set());

  const handleOrderQuote = () => {
    window.dispatchEvent(new Event("stardraw:open-custom-contact"));
  };

  const handleSingleDownload = async (id) => {
    try {
      const { data } = await authAxios.get(`/api/user/creations/${id}/download`);
      if (data?.data?.download_url) {
        const downloadUrl = await resolvePrivateUrl(data.data.download_url);
        const a = document.createElement("a"); a.href = downloadUrl;
        a.download = `creation_${id}`; a.click();
      }
    } catch { toast.error(t("下载失败", "Download failed")); }
  };

  const handleBatchDownload = async () => {
    if (selected.size === 0) return;
    if (selected.size > 20) { toast.error(t("批量下载上限为 20 个", "Batch download limit: 20 items")); return; }
    setBatch(true);
    try {
      const resp = await authAxios.post(
        "/api/user/creations/download/batch",
        { creation_ids: [...selected] },
        { headers: { "X-Idempotency-Key": uuidv4() }, responseType: "blob" }
      );
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement("a"); a.href = url; a.download = "creations.zip"; a.click();
      URL.revokeObjectURL(url);
      toast.success(t("已开始批量下载", "Batch download started"));
    } catch { toast.error(t("批量下载失败", "Batch download failed")); }
    finally { setBatch(false); }
  };

  const handleCsvExport = async () => {
    try {
      const resp = await authAxios.get("/api/user/creations/export/csv", { responseType: "blob" });
      const url = URL.createObjectURL(resp.data);
      const a = document.createElement("a"); a.href = url; a.download = "creations.csv"; a.click();
      URL.revokeObjectURL(url);
      toast.success(t("已开始导出 CSV", "CSV export started"));
    } catch { toast.error(t("CSV 导出失败", "CSV export failed")); }
  };

  const handleDelete = async (item) => {
    if (!window.confirm(t(
      "确定删除这项素材？Free 用户会立即永久删除；会员内容会进入 14 天回收站。",
      "Delete this asset? Free accounts delete permanently; member content goes to the recycle bin for 14 days.",
    ))) return;
    setDeletingId(item.id);
    try {
      const headers = { "X-Idempotency-Key": uuidv4() };
      if (item.status === "failed") {
        await authAxios.delete(`/api/user/creations/${item.id}/failed`, { headers });
      } else {
        await authAxios.delete(`/api/content/creation/${item.id}`, {
          headers,
          data: { reason: "Deleted from asset history" },
        });
      }
      dispatchHistory({ type: "remove", id: item.id });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        next.delete(String(item.id));
        next.delete(Number(item.id));
        return next;
      });
      toast.success(t("素材已删除", "Asset deleted"));
    } catch (err) {
      const message = err?.response?.data?.message || t("删除失败，请重试", "Delete failed, please retry");
      toast.error(message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddToCanvas = (item) => {
    try {
      window.sessionStorage.setItem("stardraw_canvas_import_asset", JSON.stringify(item));
      navigate("/ai/canvas?importAsset=1");
    } catch {
      toast.error(t("无法暂存素材，请重试", "Unable to stage this asset, please retry"));
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? items.filter((item) => {
      const haystack = [
        item.scene_name,
        item.scene_key,
        item.type,
        item.status,
        item.prompt,
        item.error_message,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    })
    : items;

  const hasMore = items.length < total;

	  return (
	    <div className="history-shell p-10 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="history-title mb-10 flex items-start justify-between">
        <div>
	          <h2 className="text-4xl font-extrabold mb-2"
	            style={{ color: ui.text, fontFamily: "Manrope, sans-serif", letterSpacing: "-0.02em" }}>
	            {t("素材下载中心", "Asset Download Center")}
	          </h2>
	          <p className="text-lg" style={{ color: ui.muted, opacity: 0.82 }}>
            {t("统一管理你生成的高清图片和视频素材。", "Manage all your high-definition image and video assets.")}
          </p>
        </div>
        <div className="flex gap-3 mt-1">
          {selected.size > 0 && (
            <>
	              <span className="text-sm flex items-center gap-1" style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
                {selected.size} {t("已选择", "selected")}
              </span>
              <button onClick={handleBatchDownload} disabled={batchLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all active:scale-95 disabled:opacity-50"
                style={{
	                  background: ui.buttonGradient,
	                  color: ui.primaryText,
                  fontFamily: "Manrope, sans-serif",
                }}>
                {batchLoading
	                  ? <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  : <span className="material-symbols-outlined text-sm">download_for_offline</span>
                }
                {t("批量下载", "Batch Download")}
              </button>
              <button onClick={clearSelection}
                className="px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
	                style={{ background: ui.surfaceHigh, color: ui.muted }}>
                {t("清空", "Clear")}
              </button>
            </>
          )}
          <button onClick={handleCsvExport}
            className="flex items-center gap-2 px-4 py-2 rounded-xl font-bold text-sm transition-all hover:opacity-80"
	            style={{ background: ui.surfaceHigh, color: ui.muted, border: `1px solid ${ui.line}`, fontFamily: "Manrope, sans-serif" }}>
            <span className="material-symbols-outlined text-sm">table_chart</span>
            {t("导出 CSV", "Export CSV")}
          </button>
        </div>
      </div>

	      <div className="history-search mb-8 rounded-2xl px-4 py-3 flex items-center gap-3" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
	        <span className="material-symbols-outlined text-[18px]" style={{ color: ui.faint }}>search</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("搜索模板名、类型、状态或提示词", "Search template, type, status, or prompt")}
          className="flex-1 bg-transparent outline-none text-sm"
	          style={{ color: ui.text }}
	        />
	        {query && (
	          <button type="button" onClick={() => setQuery("")} className="text-xs font-bold" style={{ color: ui.primary }}>
            {t("清空", "Clear")}
          </button>
        )}
      </div>

      {/* Tab bar */}
	      <div className="history-tabs flex items-center gap-1 mb-8 p-1.5 rounded-full w-fit"
	        style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
        {[
          { key: "all",   label: t("全部素材", "All Assets") },
          { key: "image", label: t("图片素材", "Image Assets") },
          { key: "video", label: t("视频素材", "Video Assets") },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className="px-6 py-2 rounded-full text-sm font-bold transition-all"
            style={{
	              background: tab === key ? ui.primary : "transparent",
	              color:      tab === key ? ui.primaryText : ui.muted,
              fontFamily: "Manrope, sans-serif",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Select all row */}
      {visibleItems.some(i => i.status === "completed") && (
        <div className="flex items-center gap-4 mb-6">
          <button onClick={selectAllCompleted}
            className="text-sm font-semibold transition-opacity hover:opacity-80"
	            style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
            {t("选择全部已完成", "Select All Completed")}
          </button>
          {selected.size > 0 && (
	            <span className="text-sm" style={{ color: ui.faint }}>
              {selected.size} / 20 {t("最多可选", "max selected")}
            </span>
          )}
        </div>
      )}

      {loadError && <div role="alert" className="mb-6 rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
        <p className="font-bold" style={{ color: ui.danger }}>{t("历史记录加载失败", "Unable to load asset history")}</p>
        <p className="mt-2 text-sm" style={{ color: ui.muted }}>{getHistoryLoadErrorMessage(loadError, t)}</p>
        <button type="button" disabled={loading} onClick={() => load(requestedPage)} className="mt-3 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary }}>
          {t("重新加载", "Retry loading")}
        </button>
      </div>}

      {/* A failed or malformed response is never evidence of an empty account. */}
      {(loading || !hasLoaded) && !loadError && items.length === 0 ? (
        <div className="flex justify-center py-24">
	          <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: ui.primary, borderTopColor: "transparent" }} />
	        </div>
	      ) : loadError && visibleItems.length === 0 ? null : visibleItems.length === 0 ? (
	        <div className="text-center py-24 rounded-2xl" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
	          <span className="material-symbols-outlined text-5xl mb-4 block" style={{ color: ui.faint }}>image_not_supported</span>
	          <p className="font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            {t("还没有可下载素材", "No assets found")}
          </p>
	          <p className="text-sm" style={{ color: ui.faint }}>
            {t("先生成第一张图片或第一段视频，它们会显示在这里。", "Generate your first AI content to see it here")}
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {visibleItems.map(item => (
              <AssetCard
                key={item.id}
                item={item}
                selected={selected.has(item.id)}
                onToggle={toggleSelect}
                onSingleDownload={handleSingleDownload}
                onDelete={handleDelete}
                onOrderQuote={handleOrderQuote}
	                onPreview={setPreviewItem}
	                onAddToCanvas={handleAddToCanvas}
	                deletingId={deletingId}
	                ui={ui}
	              />
            ))}
          </div>
          {hasMore && (
            <div className="text-center mt-10">
              <button onClick={loadMore} disabled={loading}
                className="px-8 py-3 rounded-xl font-bold text-sm transition-all hover:opacity-80 active:scale-95"
	                style={{ background: ui.surfaceHigh, color: ui.primary, border: `1px solid ${ui.line}`, fontFamily: "Manrope, sans-serif" }}>
                {loading ? t("加载中…", "Loading…") : t(`加载更多（剩余 ${total - items.length} 条）`, `Load More (${total - items.length} remaining)`)}
              </button>
            </div>
          )}
        </>
      )}
      {previewItem && (
        <AssetPreviewModal item={previewItem} onClose={() => setPreviewItem(null)} ui={ui} />
      )}
    </div>
  );
};

export default History;
