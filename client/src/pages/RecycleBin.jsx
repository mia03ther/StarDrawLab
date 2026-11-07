import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const asRows = (payload) => {
  const data = payload?.data ?? payload ?? [];
  return Array.isArray(data) ? data : data.items || data.rows || [];
};

const formatDate = (value, locale) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
};

const RecycleBin = () => {
  const authAxios = useAuthAxios();
  const { locale, t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [entries, setEntries] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [binResponse, noticeResponse] = await Promise.all([
        authAxios.get("/api/content/recycle-bin"),
        authAxios.get("/api/content/notifications"),
      ]);
      setEntries(asRows(binResponse.data));
      setNotifications(asRows(noticeResponse.data));
    } catch (error) {
      toast.error(error.response?.data?.message || t("加载回收站失败", "Failed to load recycle bin"));
    } finally {
      setLoading(false);
    }
  }, [authAxios, t]);

  useEffect(() => { load(); }, [load]);

  const restore = async (entry) => {
    setWorkingId(entry.id);
    try {
      await authAxios.post(`/api/content/recycle-bin/${entry.id}/restore`);
      toast.success(t("内容已恢复", "Content restored"));
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || t("恢复失败", "Restore failed"));
    } finally {
      setWorkingId(null);
    }
  };

  const markRead = async (notice) => {
    if (notice.read_at) return;
    try {
      await authAxios.post(`/api/content/notifications/${notice.id}/read`);
      setNotifications((items) => items.map((item) => item.id === notice.id ? { ...item, read_at: new Date().toISOString() } : item));
    } catch {
      // Reading a notice is non-critical; keep it visible for retry.
    }
  };

  return (
    <main className="mx-auto max-w-[1320px] p-8">
      <div className="mb-8">
        <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("内容管理", "CONTENT MANAGEMENT")}</p>
        <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("回收站", "Recycle Bin")}</h1>
        <p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("会员自行删除的内容保留 14 天；Free 用户删除的内容不会出现在这里。管理员处理的内容也不会显示在此回收站。", "Member-deleted content is retained for 14 days. Free-user deletions and administrator-removed content do not appear here.")}</p>
      </div>

      <section className="rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-black" style={{ color: ui.text }}>{t("可恢复内容", "Restorable Content")}</h2>
          <button type="button" onClick={load} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ color: ui.primary, background: ui.primarySoft }}>{t("刷新", "Refresh")}</button>
        </div>
        {loading ? <p className="py-10 text-center" style={{ color: ui.faint }}>{t("加载中…", "Loading…")}</p> : entries.length === 0 ? <p className="py-10 text-center" style={{ color: ui.faint }}>{t("回收站为空", "Recycle bin is empty")}</p> : (
          <div className="grid gap-3 md:grid-cols-2">
            {entries.map((entry) => (
              <article key={entry.id} className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-bold truncate" style={{ color: ui.text }}>{entry.resource_label || `${entry.resource_type} #${entry.resource_id}`}</p>
                    <p className="mt-1 text-xs uppercase" style={{ color: ui.faint }}>{entry.resource_type}</p>
                    <p className="mt-3 text-xs" style={{ color: ui.muted }}>{t("永久清理时间", "Purge time")}: {formatDate(entry.purge_after, locale)}</p>
                  </div>
                  <button type="button" disabled={workingId === entry.id} onClick={() => restore(entry)} className="rounded-xl px-3 py-2 text-xs font-black disabled:opacity-50" style={{ color: ui.primary, background: ui.primarySoft }}>{t("恢复", "Restore")}</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <h2 className="text-xl font-black" style={{ color: ui.text }}>{t("内容处理通知", "Content Notices")}</h2>
        <div className="mt-4 space-y-3">
          {notifications.length === 0 ? <p className="py-6 text-center text-sm" style={{ color: ui.faint }}>{t("暂无通知", "No notices")}</p> : notifications.map((notice) => (
            <button key={notice.id} type="button" onClick={() => markRead(notice)} className="w-full rounded-2xl p-4 text-left" style={{ background: ui.surfaceAlt, border: `1px solid ${notice.read_at ? ui.line : ui.primary}` }}>
              <div className="flex justify-between gap-4"><p className="font-bold" style={{ color: ui.text }}>{notice.title}</p><span className="text-xs" style={{ color: ui.faint }}>{formatDate(notice.created_at, locale)}</span></div>
              <p className="mt-2 text-sm" style={{ color: ui.muted }}>{notice.message}</p>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
};

export default RecycleBin;
