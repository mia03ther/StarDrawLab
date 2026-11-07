import { useCallback, useEffect, useMemo, useState } from "react";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const PAGE_SIZE = 50;

const formatNumber = (value, locale) => Number(value || 0).toLocaleString(locale);

const formatDateTime = (value, locale) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
};

const statusLabel = (value, t) => ({
  completed: t("已完成", "completed"),
  success: t("成功", "success"),
  failed: t("失败", "failed"),
  cancelled: t("已取消", "cancelled"),
  reserved: t("已预占", "reserved"),
  settlement_pending: t("待结算", "settlement pending"),
  pending: t("等待中", "pending"),
  running: t("处理中", "running"),
}[value] || value || "—");

const recordTypeLabel = (value, t) => ({
  points: t("积分流水", "Points"),
  generation: t("生成任务", "Generation"),
  agent: t("Agent 调用", "Agent call"),
}[value] || value || "—");

const emptyFilters = {
  query: "",
  user_id: "",
  record_type: "",
  output_type: "",
  model: "",
  status: "",
  entry_type: "",
  date_from: "",
  date_to: "",
};

const SummaryCard = ({ label, value, detail, ui }) => (
  <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
    <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: ui.faint }}>{label}</p>
    <p className="mt-2 text-2xl font-black" style={{ color: ui.text }}>{value}</p>
    {detail && <p className="mt-1 text-[11px]" style={{ color: ui.muted }}>{detail}</p>}
  </div>
);

const AdminUsageAnalytics = () => {
  const authAxios = useAuthAxios();
  const { locale, t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [filters, setFilters] = useState(emptyFilters);
  const [appliedFilters, setAppliedFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState([]);
  const [trend, setTrend] = useState([]);
  const [summary, setSummary] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await authAxios.get("/api/root/usage-analytics", {
        params: { ...appliedFilters, page, page_size: PAGE_SIZE },
      });
      const payload = data?.data || {};
      setRecords(Array.isArray(payload.records) ? payload.records : []);
      setTrend(Array.isArray(payload.trend) ? payload.trend : []);
      setSummary(payload.summary || {});
      setTotal(Number(payload.total || 0));
    } catch (requestError) {
      setRecords([]);
      setTrend([]);
      setSummary({});
      setTotal(0);
      setError(requestError.response?.data?.message || t("使用统计加载失败。", "Unable to load usage analytics."));
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, authAxios, page, t]);

  useEffect(() => { loadAnalytics(); }, [loadAnalytics]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const maxTrendEvents = useMemo(() => Math.max(1, ...trend.map((item) => Number(item.events || 0))), [trend]);

  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value }));
  const applyFilters = (event) => {
    event.preventDefault();
    setPage(1);
    setExpandedId(null);
    setAppliedFilters({ ...filters });
  };

  return (
    <main className="mx-auto max-w-[1540px] p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("ROOT 管理员", "ROOT ADMIN")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("使用分析", "Usage Analytics")}</h1>
          <p className="mt-2 max-w-4xl text-sm leading-6" style={{ color: ui.faint }}>
            {t("查看所有用户的生成任务、Agent 调用和积分流水。筛选结果只在服务端由 root 权限查询，积分流水是不可变记录。", "Review every user's generations, Agent calls, and point ledger. Filters are evaluated server-side under root authorization; the point ledger is immutable.")}
          </p>
        </div>
        <button type="button" onClick={loadAnalytics} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}>
          {t("刷新数据", "Refresh data")}
        </button>
      </div>

      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label={t("活跃用户", "Active users")} value={formatNumber(summary.active_users, locale)} detail={t("当前筛选范围内", "In the current filter") } ui={ui} />
        <SummaryCard label={t("生成任务", "Generation events")} value={formatNumber(summary.generation_events, locale)} detail={`${formatNumber(summary.completed_events, locale)} ${t("个完成", "completed")}`} ui={ui} />
        <SummaryCard label={t("Agent 调用", "Agent calls")} value={formatNumber(summary.agent_calls, locale)} detail={`${formatNumber(summary.input_tokens, locale)} ${t("输入 Token", "input tokens")}`} ui={ui} />
        <SummaryCard label={t("已消耗积分", "Points charged")} value={formatNumber(summary.points_charged, locale)} detail={`${formatNumber(summary.points_released, locale)} ${t("个返还", "released")} · ${formatNumber(summary.points_recharged, locale)} ${t("个充值/赠送", "recharged or granted")}`} ui={ui} />
      </section>

      <section className="mb-6 rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <form onSubmit={applyFilters} className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <input value={filters.query} onChange={(event) => updateFilter("query", event.target.value)} placeholder={t("搜索用户、模型或操作", "Search user, model, or action")} className="rounded-xl px-3 py-2.5 text-sm outline-none xl:col-span-2" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input value={filters.user_id} onChange={(event) => updateFilter("user_id", event.target.value)} placeholder={t("精确用户 ID", "Exact user ID")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <CanvasRoundedSelect label={t("记录类型", "Record type")} value={filters.record_type} onChange={(value) => updateFilter("record_type", value)} options={[{ value: "", label: t("全部记录", "All records") }, { value: "points", label: t("积分流水", "Points") }, { value: "generation", label: t("生成任务", "Generation") }, { value: "agent", label: t("Agent 调用", "Agent calls") }]} ui={ui} triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={170} />
          <CanvasRoundedSelect label={t("输出类型", "Output type")} value={filters.output_type} onChange={(value) => updateFilter("output_type", value)} options={[{ value: "", label: t("全部类型", "All types") }, { value: "image", label: t("图片", "Image") }, { value: "video", label: t("视频", "Video") }, { value: "agent", label: t("Agent", "Agent") }]} ui={ui} triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={150} />
          <input value={filters.model} onChange={(event) => updateFilter("model", event.target.value)} placeholder={t("模型 ID", "Model ID")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input value={filters.status} onChange={(event) => updateFilter("status", event.target.value)} placeholder={t("状态，如 completed", "Status, e.g. completed")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input value={filters.entry_type} onChange={(event) => updateFilter("entry_type", event.target.value)} placeholder={t("流水类型，如 charge", "Ledger type, e.g. charge")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input type="date" value={filters.date_from} onChange={(event) => updateFilter("date_from", event.target.value)} className="rounded-xl px-3 py-2.5 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <input type="date" value={filters.date_to} onChange={(event) => updateFilter("date_to", event.target.value)} className="rounded-xl px-3 py-2.5 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          <div className="flex gap-2">
            <button type="submit" className="flex-1 rounded-xl px-4 py-2.5 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{t("应用筛选", "Apply filters")}</button>
            <button type="button" onClick={() => { setFilters(emptyFilters); setAppliedFilters(emptyFilters); setPage(1); }} className="rounded-xl px-4 py-2.5 text-sm font-bold" style={{ background: ui.surfaceAlt, color: ui.muted, border: `1px solid ${ui.line}` }}>{t("清空", "Clear")}</button>
          </div>
        </form>
      </section>

      {trend.length > 0 && (
        <section className="mb-6 rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-4 flex items-center justify-between"><div><p className="text-sm font-black" style={{ color: ui.text }}>{t("使用趋势", "Usage trend")}</p><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("按天汇总当前筛选结果", "Daily totals for the current filter")}</p></div><span className="text-xs" style={{ color: ui.faint }}>{formatNumber(summary.total_events, locale)} {t("条记录", "events")}</span></div>
          <div className="flex min-h-[150px] items-end gap-2 overflow-x-auto pb-1">
            {trend.map((item) => <div key={String(item.day)} className="flex min-w-[52px] flex-1 flex-col items-center gap-2"><div className="flex h-28 w-full items-end"><div className="w-full rounded-t-lg transition-all" style={{ height: `${Math.max(8, (Number(item.events || 0) / maxTrendEvents) * 100)}%`, background: ui.primary }} title={`${item.day}: ${item.events}`} /></div><span className="text-[9px]" style={{ color: ui.faint }}>{String(item.day).slice(5)}</span></div>)}
          </div>
        </section>
      )}

      <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        {loading ? <div className="p-10 text-center text-sm" style={{ color: ui.faint }}>{t("正在加载使用记录…", "Loading usage records…")}</div> : error ? <div className="p-10 text-center"><p className="text-sm" style={{ color: ui.danger }}>{error}</p><button type="button" onClick={loadAnalytics} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("重试", "Retry")}</button></div> : records.length === 0 ? <div className="p-10 text-center text-sm" style={{ color: ui.faint }}>{t("没有匹配的使用记录。", "No matching usage records.")}</div> : (
          <div className="overflow-x-auto"><table className="w-full min-w-[1250px] text-left text-xs"><thead><tr style={{ color: ui.faint }}><th className="p-3">{t("时间", "Time")}</th><th className="p-3">{t("用户", "User")}</th><th className="p-3">{t("记录", "Record")}</th><th className="p-3">{t("模型", "Model")}</th><th className="p-3">{t("状态", "Status")}</th><th className="p-3">{t("积分", "Points")}</th><th className="p-3">Token</th><th className="p-3 text-right">{t("详情", "Details")}</th></tr></thead><tbody>{records.map((record) => { const id = `${record.record_type}:${record.record_id}`; const expanded = expandedId === id; const tokens = Number(record.input_tokens || 0) + Number(record.output_tokens || 0) + Number(record.cache_read_tokens || 0) + Number(record.cache_write_tokens || 0); const pointDisplay = Number(record.charged_points || 0) > 0 ? `-${formatNumber(record.charged_points, locale)}` : Number(record.change_points || 0) > 0 ? `+${formatNumber(record.change_points, locale)}` : Number(record.released_points || 0) > 0 ? `${t("返还", "released")} ${formatNumber(record.released_points, locale)}` : "—"; return <tr key={id} style={{ borderTop: `1px solid ${ui.line}`, color: ui.text }}><td className="p-3 whitespace-nowrap">{formatDateTime(record.occurred_at, locale)}</td><td className="p-3"><p className="max-w-[190px] truncate font-bold">{record.display_name || record.full_name || record.username || record.user_id}</p><p className="max-w-[190px] truncate" style={{ color: ui.faint }}>{record.user_id}</p></td><td className="p-3"><span className="font-bold">{recordTypeLabel(record.record_type, t)}</span><p style={{ color: ui.faint }}>{record.action || "—"}</p></td><td className="p-3 max-w-[180px] truncate">{record.model || "—"}</td><td className="p-3">{statusLabel(record.status || record.action, t)}</td><td className="p-3 font-black" style={{ color: Number(record.charged_points || 0) > 0 ? ui.gold : Number(record.released_points || 0) > 0 ? ui.primary : ui.muted }}>{pointDisplay}</td><td className="p-3">{tokens ? formatNumber(tokens, locale) : "—"}</td><td className="p-3 text-right"><button type="button" onClick={() => setExpandedId(expanded ? null : id)} className="rounded-lg px-2.5 py-1.5 font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{expanded ? t("收起", "Hide") : t("查看", "View")}</button>{expanded && <pre className="absolute right-8 z-10 mt-2 max-w-[520px] overflow-auto rounded-xl p-3 text-left text-[10px]" style={{ background: ui.menuBg, color: ui.muted, border: `1px solid ${ui.lineStrong}`, boxShadow: ui.shadow }}>{JSON.stringify(record.details || {}, null, 2)}</pre>}</td></tr>; })}</tbody></table></div>
        )}
        {!loading && !error && total > 0 && <div className="mt-5 flex items-center justify-between border-t pt-4" style={{ borderColor: ui.line, color: ui.faint }}><span className="text-xs">{t(`共 ${total} 条`, `${total} records`)}</span><div className="flex items-center gap-3"><button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("上一页", "Previous")}</button><span className="text-xs">{page} / {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} className="rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("下一页", "Next")}</button></div></div>}
      </section>
    </main>
  );
};

export default AdminUsageAnalytics;
