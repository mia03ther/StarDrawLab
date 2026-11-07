import { useCallback, useEffect, useState } from "react";
import { Bell, ChevronDown, LoaderCircle, RefreshCw } from "lucide-react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const formatDate = (value, locale) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString(locale);
  } catch {
    return "";
  }
};

const Announcements = () => {
  const authAxios = useAuthAxios();
  const { t, locale } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [items, setItems] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    try {
      const response = await authAxios.get("/api/announcements", { params: { limit: 100 } });
      setItems(response.data?.data || []);
    } catch (error) {
      toast.error(error.response?.data?.message || t("公告加载失败，请稍后再试。", "Unable to load announcements."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authAxios, t]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <main className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="animate-spin" style={{ color: ui.primary }} /></main>;
  }

  const latest = items[0];

  return (
    <main className="mx-auto max-w-5xl p-6 md:p-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("StarDraw 通知", "STARDRAW UPDATES")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("公告", "Announcements")}</h1>
          <p className="mt-3 text-sm" style={{ color: ui.muted }}>{t("查看产品更新、活动和重要服务通知。", "Product updates, events, and important service notices.")}</p>
        </div>
        <button
          type="button"
          onClick={() => void load({ silent: true })}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold disabled:opacity-50"
          style={{ background: ui.surface, color: ui.muted, border: `1px solid ${ui.lineStrong}` }}
        >
          <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
          {t("刷新", "Refresh")}
        </button>
      </header>

      {latest && (
        <section className="relative mb-6 overflow-hidden rounded-[28px] p-6 md:p-8" style={{ background: `linear-gradient(135deg, ${ui.primarySoft}, ${ui.surface})`, border: `1px solid ${ui.primary}`, boxShadow: ui.shadow }}>
          <div className="pointer-events-none absolute -right-14 -top-20 h-48 w-48 rounded-full opacity-15" style={{ background: ui.primary, filter: "blur(34px)" }} />
          <div className="relative flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><Bell size={16} style={{ color: ui.primary }} /><span className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("最新公告", "LATEST UPDATE")}</span></div>
              <h2 className="mt-4 text-2xl font-black leading-tight md:text-3xl" style={{ color: ui.text }}>{latest.title}</h2>
              <p className="mt-2 text-xs" style={{ color: ui.faint }}>{formatDate(latest.published_at || latest.created_at, locale)}</p>
              <p className="mt-4 line-clamp-2 whitespace-pre-wrap text-sm leading-7" style={{ color: ui.muted }}>{latest.content}</p>
            </div>
            <button type="button" onClick={() => setExpandedId(latest.id)} className="inline-flex shrink-0 items-center justify-center rounded-xl px-4 py-2.5 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{t("阅读公告", "Read update")}</button>
          </div>
        </section>
      )}

      {items.length === 0 ? (
        <section className="rounded-3xl p-10 text-center" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <Bell size={28} className="mx-auto" style={{ color: ui.faint }} />
          <p className="mt-4 text-sm" style={{ color: ui.muted }}>{t("暂时没有公告。", "There are no announcements yet.")}</p>
        </section>
      ) : (
        <div className="space-y-4">
          {items.map((item) => {
            const expanded = expandedId === item.id;
            return (
              <article key={item.id} className="rounded-3xl p-5 md:p-6" style={{ background: ui.surface, border: `1px solid ${expanded ? ui.primary : ui.line}`, boxShadow: ui.shadow }}>
                <button type="button" className="flex w-full items-start gap-4 text-left" onClick={() => setExpandedId(expanded ? null : item.id)} aria-expanded={expanded}>
                  <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: ui.primarySoft, color: ui.primary }}><Bell size={18} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-black" style={{ color: ui.text }}>{item.title}</span>
                    <span className="mt-1 block text-xs" style={{ color: ui.faint }}>{formatDate(item.published_at || item.created_at, locale)}</span>
                  </span>
                  <ChevronDown size={18} className={`mt-2 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} style={{ color: ui.faint }} />
                </button>
                <div className={`${expanded ? "mt-5 max-h-[1000px] opacity-100" : "max-h-0 opacity-0"} overflow-hidden transition-all duration-300`}>
                  <div className="whitespace-pre-wrap border-t pt-5 text-sm leading-7" style={{ color: ui.muted, borderColor: ui.line }}>{item.content}</div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
};

export default Announcements;
