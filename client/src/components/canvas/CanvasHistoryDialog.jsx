import { useCallback, useEffect, useState } from "react";
import { Clock3, History, RefreshCw, RotateCcw, X } from "lucide-react";
import toast from "react-hot-toast";

import CanvasIconButton from "./CanvasIconButton";

const reasonLabel = (reason, t) => {
  const value = String(reason || "");
  if (value === "canvas.updated") return t("画布保存", "Canvas saved");
  if (value === "workflow.created") return t("创建工作流", "Workflow created");
  if (value === "workflow.updated") return t("更新工作流", "Workflow updated");
  if (value.startsWith("canvas.restored:")) return t("恢复历史版本", "History restored");
  return value || t("画布变更", "Canvas change");
};

const CanvasHistoryDialog = ({ open, onClose, canvasId, authAxios, onRestored, ui, t, locale = "zh-CN" }) => {
  const [revisions, setRevisions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!canvasId) return;
    setLoading(true);
    setError("");
    try {
      const response = await authAxios.get(`/api/canvases/${encodeURIComponent(canvasId)}/revisions`, { params: { limit: 60 } });
      setRevisions(Array.isArray(response.data?.data) ? response.data.data : []);
    } catch (requestError) {
      const message = requestError.response?.data?.message || requestError.message || t("画布历史加载失败", "Unable to load canvas history");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [authAxios, canvasId, t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event) => { if (event.key === "Escape" && !restoringId) onClose?.(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open, restoringId]);

  const restore = async (revision) => {
    if (!revision?.id || restoringId) return;
    if (!window.confirm(t(
      `恢复到画布版本 v${revision.version}？当前画布会先保留为新的历史版本。`,
      `Restore canvas version v${revision.version}? The current canvas will remain available in history.`,
    ))) return;
    setRestoringId(String(revision.id));
    setError("");
    try {
      const response = await authAxios.post(`/api/canvases/${encodeURIComponent(canvasId)}/revisions/${encodeURIComponent(revision.id)}/restore`, {});
      const result = response.data?.data;
      await onRestored?.(result);
      toast.success(t("画布和工作流已恢复", "Canvas and workflows restored"));
      await load();
    } catch (requestError) {
      const message = requestError.response?.data?.message || requestError.message || t("恢复失败", "Unable to restore revision");
      setError(message);
      toast.error(message);
    } finally {
      setRestoringId("");
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("画布历史", "Canvas history")} onMouseDown={(event) => { if (event.target === event.currentTarget && !restoringId) onClose?.(); }}>
      <section className="flex max-h-[min(760px,88vh)] w-full max-w-2xl flex-col overflow-hidden rounded-[24px] border shadow-2xl" style={{ background: ui.panelSolid, borderColor: ui.line, color: ui.text }}>
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-3" style={{ background: ui.panel, borderColor: ui.line }}>
          <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}><History size={13} /></span><div><h2 className="text-[11px] font-semibold">{t("画布历史", "Canvas history")}</h2><p className="text-[9px]" style={{ color: ui.faint }}>{t("恢复画布、分镜、时间线及命名工作流", "Restore the canvas, storyboard, timeline, and named workflows")}</p></div></div>
          <div className="flex items-center gap-1"><CanvasIconButton label={t("刷新历史", "Refresh history")} tooltipSide="bottom" onClick={() => void load()} disabled={loading || Boolean(restoringId)} style={{ color: ui.muted }}><RefreshCw size={12} className={loading ? "animate-spin" : ""} /></CanvasIconButton><CanvasIconButton label={t("关闭", "Close")} tooltipSide="bottom" onClick={onClose} disabled={Boolean(restoringId)} style={{ color: ui.muted }}><X size={12} /></CanvasIconButton></div>
        </header>

        {error && <div className="shrink-0 border-b border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-500">{error}</div>}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && revisions.length === 0 && <div className="flex min-h-48 items-center justify-center text-[10px]" style={{ color: ui.faint }}>{t("正在读取历史…", "Loading history...")}</div>}
          {!loading && revisions.length === 0 && <div className="flex min-h-48 flex-col items-center justify-center gap-2 text-center"><History size={20} style={{ color: ui.faint }} /><p className="text-[11px]" style={{ color: ui.muted }}>{t("尚无可恢复的历史版本", "No restorable revisions yet")}</p></div>}
          <div className="space-y-1.5">
            {revisions.map((revision, index) => {
              const state = revision.canvasState || {};
              const elementCount = Array.isArray(state.elements) ? state.elements.length : 0;
              const workflowCount = Array.isArray(revision.workflows) ? revision.workflows.length : 0;
              const restoring = restoringId === String(revision.id);
              return (
                <div key={revision.id} className="flex items-center gap-3 rounded-2xl border px-3 py-2.5" style={{ background: index === 0 ? ui.soft : "transparent", borderColor: ui.line }}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: ui.goldSoft, color: ui.gold }}>v{revision.version}</span>
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-[11px] font-semibold">{reasonLabel(revision.reason, t)}</p>{index === 0 && <span className="rounded-full px-1.5 py-0.5 text-[8px]" style={{ background: ui.blueSoft, color: ui.blue }}>{t("最新", "Latest")}</span>}</div><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px]" style={{ color: ui.faint }}><span className="inline-flex items-center gap-1"><Clock3 size={9} />{new Date(revision.createdAt).toLocaleString(locale)}</span><span>{elementCount} {t("个元素", "elements")}</span><span>{workflowCount} {t("个工作流", "workflows")}</span></div></div>
                  <button type="button" onClick={() => void restore(revision)} disabled={Boolean(restoringId)} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-[9px] font-semibold transition hover:brightness-110 disabled:opacity-40" style={{ background: ui.soft, borderColor: ui.line, color: ui.text }} title={t(`恢复版本 v${revision.version}`, `Restore version v${revision.version}`)}>{restoring ? <RefreshCw size={11} className="animate-spin" /> : <RotateCcw size={11} />}{restoring ? t("恢复中", "Restoring") : t("恢复", "Restore")}</button>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
};

export default CanvasHistoryDialog;
