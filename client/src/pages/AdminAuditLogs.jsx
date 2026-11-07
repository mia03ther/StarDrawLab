import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const PAGE_SIZE = 50;

const AdminAuditLogs = () => {
  const authAxios = useAuthAxios();
  const { locale, t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ query: "", action: "", from: "", to: "" });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await authAxios.get("/api/root/audit-logs", {
        params: { ...appliedFilters, page, page_size: PAGE_SIZE },
      });
      const payload = data?.data ?? data ?? {};
      const items = Array.isArray(payload) ? payload : (payload.items || payload.logs || payload.rows || []);
      setLogs(Array.isArray(items) ? items : []);
      setTotal(Number(payload.total ?? payload.pagination?.total ?? items.length) || 0);
    } catch (requestError) {
      setLogs([]);
      setTotal(0);
      setError(requestError.response?.data?.message || t(
        "审计日志接口尚未就绪或当前请求被拒绝。",
        "The audit log API is not available or rejected this request.",
      ));
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, authAxios, page, t]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const applyFilters = (event) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  };

  const exportLogs = async () => {
    setExporting(true);
    try {
      const response = await authAxios.get("/api/root/audit-logs/export", {
        params: appliedFilters,
        responseType: "blob",
      });
      const url = URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `stardraw-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (requestError) {
      toast.error(requestError.response?.data?.message || t("导出失败", "Export failed"));
    } finally {
      setExporting(false);
    }
  };

  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-[1480px] p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("ROOT 管理员", "ROOT ADMIN")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("审计日志", "Audit Logs")}</h1>
          <p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("仅 root 可查询和导出。日志由后端追加写入，前端不提供修改或删除入口。", "Root-only query and export. Logs are append-only on the server; this UI provides no edit or delete action.")}</p>
        </div>
        <button type="button" disabled={exporting} onClick={exportLogs} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}>
          {exporting ? t("导出中…", "Exporting…") : t("导出 CSV", "Export CSV")}
        </button>
      </div>

      <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <form onSubmit={applyFilters} className="mb-5 grid gap-3 lg:grid-cols-[1fr,0.7fr,0.7fr,0.7fr,auto]">
          <input value={filters.query} onChange={(event) => setFilters((value) => ({ ...value, query: event.target.value }))} placeholder={t("操作人、目标或请求 ID", "Actor, target, or request ID")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input value={filters.action} onChange={(event) => setFilters((value) => ({ ...value, action: event.target.value }))} placeholder={t("操作类型", "Action type")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input type="date" value={filters.from} onChange={(event) => setFilters((value) => ({ ...value, from: event.target.value }))} className="rounded-xl px-3 py-2.5 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input type="date" value={filters.to} onChange={(event) => setFilters((value) => ({ ...value, to: event.target.value }))} className="rounded-xl px-3 py-2.5 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <button type="submit" className="rounded-xl px-5 py-2.5 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{t("筛选", "Filter")}</button>
        </form>

        {loading ? (
          <div className="p-10 text-center" style={{ color: ui.faint }}>{t("正在加载审计日志…", "Loading audit logs…")}</div>
        ) : error ? (
          <div className="rounded-2xl p-8 text-center" style={{ background: ui.surfaceAlt, border: `1px dashed ${ui.lineStrong}` }}>
            <p className="text-sm" style={{ color: ui.muted }}>{error}</p>
            <button type="button" onClick={loadLogs} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold" style={{ color: ui.primary, background: ui.primarySoft }}>{t("重试", "Retry")}</button>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-10 text-center" style={{ color: ui.faint }}>{t("没有匹配的审计记录。", "No matching audit records.")}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] text-left text-sm">
              <thead><tr style={{ color: ui.faint }}><th className="p-3">{t("时间", "Time")}</th><th className="p-3">{t("操作人", "Actor")}</th><th className="p-3">{t("操作", "Action")}</th><th className="p-3">{t("目标", "Target")}</th><th className="p-3">{t("结果", "Result")}</th><th className="p-3">IP / {t("请求 ID", "Request ID")}</th></tr></thead>
              <tbody>{logs.map((log, index) => <tr key={log.id || `${log.request_id || "log"}-${index}`} style={{ borderTop: `1px solid ${ui.line}`, color: ui.text }}><td className="p-3 text-xs">{formatDate(log.created_at || log.occurred_at || log.timestamp)}</td><td className="p-3"><p className="font-bold">{log.actor_display_name || log.actor_user_id || "system"}</p><p className="text-[10px] uppercase" style={{ color: ui.faint }}>{log.actor_role || "—"}</p></td><td className="p-3 font-bold">{log.action || log.event_type || "—"}</td><td className="p-3"><p>{log.target_type || "—"}</p><p className="max-w-[220px] truncate text-xs" style={{ color: ui.faint }}>{log.target_id || "—"}</p></td><td className="p-3">{log.result || log.outcome || "success"}</td><td className="p-3 text-xs" style={{ color: ui.faint }}><p>{log.ip_address || "—"}</p><p className="max-w-[180px] truncate">{log.request_id || "—"}</p></td></tr>)}</tbody>
            </table>
          </div>
        )}

        {!loading && !error && total > 0 && <div className="mt-5 flex items-center justify-between border-t pt-4" style={{ borderColor: ui.line, color: ui.faint }}><span className="text-xs">{t(`共 ${total} 条`, `${total} records`)}</span><div className="flex items-center gap-3"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("上一页", "Previous")}</button><span className="text-xs">{page} / {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("下一页", "Next")}</button></div></div>}
      </section>
    </main>
  );
};

export default AdminAuditLogs;
