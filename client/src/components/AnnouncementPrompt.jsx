import { useEffect, useMemo, useState } from "react";
import { Bell, X } from "lucide-react";
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

const AnnouncementPrompt = ({ items = [], unreadCount = 0, onDismiss }) => {
  const { t, locale } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    setSelectedId((current) => (items.some((item) => item.id === current) ? current : items[0]?.id || null));
  }, [items]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) || items[0],
    [items, selectedId],
  );

  if (!items.length) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/55 p-4 backdrop-blur-md" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="stardraw-announcement-title" className="relative w-full max-w-xl overflow-hidden rounded-[28px]" style={{ background: ui.surface, border: `1px solid ${ui.primary}`, boxShadow: `0 28px 100px rgba(0,0,0,.45), 0 0 0 1px ${ui.primarySoft}` }}>
        <div className="relative overflow-hidden px-6 pb-6 pt-7 md:px-8 md:pt-8" style={{ background: `linear-gradient(135deg, ${ui.primarySoft}, transparent 58%)` }}>
          <div className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full opacity-20" style={{ background: ui.primary, filter: "blur(34px)" }} />
          <button type="button" onClick={onDismiss} title={t("关闭公告", "Close announcement")} aria-label={t("关闭公告", "Close announcement")} className="absolute right-4 top-4 rounded-full p-2 transition-transform hover:scale-105" style={{ color: ui.muted, background: ui.surfaceAlt }}><X size={17} /></button>
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: ui.primary, color: ui.primaryText, boxShadow: `0 0 28px ${ui.primarySoft}` }}><Bell size={23} /></span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{unreadCount > 0 ? t("重要通知", "IMPORTANT UPDATE") : t("公告中心", "ANNOUNCEMENTS")}</p>
              <p className="mt-1 text-xs" style={{ color: ui.faint }}>{unreadCount > 0 ? t(`${unreadCount} 条新公告`, `${unreadCount} new announcement${unreadCount === 1 ? "" : "s"}`) : t(`${items.length} 条公告`, `${items.length} announcements`)}</p>
            </div>
          </div>
          <h2 id="stardraw-announcement-title" className="mt-7 pr-8 text-2xl font-black leading-tight" style={{ color: ui.text }}>{selected.title}</h2>
          <p className="mt-2 text-xs" style={{ color: ui.faint }}>{formatDate(selected.published_at || selected.created_at, locale)}</p>
          <div className="mt-5 max-h-44 overflow-y-auto whitespace-pre-wrap text-sm leading-7" style={{ color: ui.muted }}>{selected.content}</div>
          {items.length > 1 && (
            <div className="mt-5 max-h-36 overflow-y-auto rounded-2xl p-2" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
              <p className="px-2 pb-2 text-[10px] font-black uppercase tracking-widest" style={{ color: ui.faint }}>{t("全部公告", "ALL ANNOUNCEMENTS")}</p>
              <div className="space-y-1">
                {items.map((item) => {
                  const active = item.id === selected.id;
                  return (
                    <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left transition-colors" style={{ background: active ? ui.primarySoft : "transparent", color: active ? ui.primary : ui.muted }}>
                      <span className="min-w-0 truncate text-xs font-bold">{item.title}</span>
                      <span className="shrink-0 text-[10px]" style={{ color: ui.faint }}>{formatDate(item.published_at || item.created_at, locale)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end border-t px-6 py-5 md:px-8" style={{ borderColor: ui.line }}>
          <button type="button" onClick={onDismiss} className="rounded-xl px-5 py-2.5 text-sm font-black" style={{ color: ui.primaryText, background: ui.buttonGradient }}>{t("我知道了", "Got it")}</button>
        </div>
      </section>
    </div>
  );
};

export default AnnouncementPrompt;
