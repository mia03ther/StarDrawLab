import { useCallback, useEffect, useState } from "react";
import { Bell, Edit3, LoaderCircle, Plus, Save, Send, Trash2, X } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const emptyDraft = () => ({ id: null, title: "", content: "", status: "draft", priority: 0 });

const formatDate = (value, locale) => {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString(locale);
  } catch {
    return "—";
  }
};

const AdminAnnouncements = () => {
  const authAxios = useAuthAxios();
  const { t, locale } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [items, setItems] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const response = await authAxios.get("/api/admin/announcements");
    setItems(response.data?.data || []);
  }, [authAxios]);

  useEffect(() => {
    load().catch((error) => toast.error(error.response?.data?.message || t("公告加载失败", "Unable to load announcements"))).finally(() => setLoading(false));
  }, [load, t]);

  const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async (event) => {
    event.preventDefault();
    if (!draft.title.trim() || !draft.content.trim()) {
      toast.error(t("标题和正文不能为空。", "Title and content are required."));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: draft.title,
        content: draft.content,
        status: draft.status,
        priority: Number(draft.priority) || 0,
        reason: draft.id ? t("修改公告", "Update announcement") : t("创建公告", "Create announcement"),
      };
      const response = await authAxios.request({
        method: draft.id ? "put" : "post",
        url: draft.id ? `/api/admin/announcements/${draft.id}` : "/api/admin/announcements",
        data: payload,
        headers: { "X-Idempotency-Key": uuidv4() },
      });
      const saved = response.data?.data;
      setItems((current) => draft.id ? current.map((item) => item.id === saved.id ? saved : item) : [saved, ...current]);
      setDraft(emptyDraft());
      toast.success(draft.status === "published" ? t("公告已发布。", "Announcement published.") : t("公告草稿已保存。", "Announcement draft saved."));
    } catch (error) {
      toast.error(error.response?.data?.message || t("保存公告失败。", "Unable to save announcement."));
    } finally {
      setSaving(false);
    }
  };

  const edit = (item) => setDraft({ id: item.id, title: item.title, content: item.content, status: item.status, priority: item.priority || 0 });

  const remove = async (item) => {
    if (!window.confirm(t(`确定删除公告“${item.title}”吗？`, `Delete “${item.title}”?`))) return;
    try {
      await authAxios.delete(`/api/admin/announcements/${item.id}`, {
        data: { reason: t("删除公告", "Delete announcement") },
        headers: { "X-Idempotency-Key": uuidv4() },
      });
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      if (draft.id === item.id) setDraft(emptyDraft());
      toast.success(t("公告已删除。", "Announcement deleted."));
    } catch (error) {
      toast.error(error.response?.data?.message || t("删除公告失败。", "Unable to delete announcement."));
    }
  };

  if (loading) return <main className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="animate-spin" style={{ color: ui.primary }} /></main>;

  return (
    <main className="mx-auto max-w-7xl p-6 md:p-10">
      <header className="mb-8">
        <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("管理员后台", "ADMIN CONSOLE")}</p>
        <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("公告管理", "Announcement management")}</h1>
        <p className="mt-3 text-sm" style={{ color: ui.muted }}>{t("发布产品更新和服务通知。删除采用软删除，历史操作会保留在审计日志中。", "Publish product updates and service notices. Deletions are soft and remain in the audit log.")}</p>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="rounded-3xl p-5 md:p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-5 flex items-center justify-between gap-3"><div><h2 className="text-xl font-black" style={{ color: ui.text }}>{t("公告列表", "Announcements")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{items.length} {t("条记录", "records")}</p></div><button type="button" onClick={() => setDraft(emptyDraft())} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary }}><Plus size={15} />{t("新建", "New")}</button></div>
          {items.length === 0 ? (
            <div className="rounded-2xl px-4 py-8 text-center text-sm" style={{ background: ui.surfaceAlt, color: ui.faint }}>{t("还没有公告。", "No announcements yet.")}</div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => (
                <article key={item.id} className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${draft.id === item.id ? ui.primary : ui.line}` }}>
                  <div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: ui.primarySoft, color: ui.primary }}><Bell size={16} /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-black" style={{ color: ui.text }}>{item.title}</h3><span className="rounded-full px-2 py-1 text-[10px] font-black" style={{ background: item.status === "published" ? `${ui.success}20` : ui.surfaceHigh, color: item.status === "published" ? ui.success : ui.faint }}>{item.status === "published" ? t("已发布", "Published") : t("草稿", "Draft")}</span></div><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("更新时间", "Updated")}: {formatDate(item.updated_at, locale)} · {t("优先级", "Priority")}: {item.priority}</p><p className="mt-3 line-clamp-2 whitespace-pre-wrap text-sm" style={{ color: ui.muted }}>{item.content}</p></div></div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2"><button type="button" onClick={() => edit(item)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold" style={{ background: ui.surfaceHigh, color: ui.text }}><Edit3 size={13} />{t("编辑", "Edit")}</button><button type="button" onClick={() => remove(item)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}><Trash2 size={13} />{t("删除", "Delete")}</button></div>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="h-fit rounded-3xl p-5 md:p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-xl font-black" style={{ color: ui.text }}>{draft.id ? t("编辑公告", "Edit announcement") : t("新建公告", "New announcement")}</h2>{draft.id && <button type="button" onClick={() => setDraft(emptyDraft())} title={t("取消编辑", "Cancel editing")} aria-label={t("取消编辑", "Cancel editing")} className="rounded-lg p-2" style={{ color: ui.faint, background: ui.surfaceAlt }}><X size={16} /></button>}</div>
          <form onSubmit={save} className="space-y-4">
            <label className="block text-xs font-bold" style={{ color: ui.muted }}>{t("标题", "Title")}<input maxLength={200} value={draft.title} onChange={(event) => updateDraft("title", event.target.value)} className="mt-2 w-full rounded-xl px-3 py-3 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} placeholder={t("例如：版本更新通知", "For example: Product update") } /></label>
            <label className="block text-xs font-bold" style={{ color: ui.muted }}>{t("正文", "Content")}<textarea maxLength={100000} rows={10} value={draft.content} onChange={(event) => updateDraft("content", event.target.value)} className="mt-2 w-full resize-y rounded-xl px-3 py-3 text-sm leading-6 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} placeholder={t("输入公告内容…", "Write the announcement…")} /></label>
            <div className="grid grid-cols-2 gap-3"><label className="block text-xs font-bold" style={{ color: ui.muted }}>{t("状态", "Status")}<select value={draft.status} onChange={(event) => updateDraft("status", event.target.value)} className="mt-2 h-11 w-full rounded-xl px-3 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }}><option value="draft">{t("草稿", "Draft")}</option><option value="published">{t("发布", "Published")}</option></select></label><label className="block text-xs font-bold" style={{ color: ui.muted }}>{t("优先级", "Priority")}<input type="number" min={-1000000} max={1000000} value={draft.priority} onChange={(event) => updateDraft("priority", event.target.value)} className="mt-2 h-11 w-full rounded-xl px-3 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label></div>
            <button type="submit" disabled={saving} className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-black disabled:opacity-50" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{draft.status === "published" ? <Send size={16} /> : <Save size={16} />}{saving ? t("保存中…", "Saving…") : draft.status === "published" ? t("保存并发布", "Save and publish") : t("保存草稿", "Save draft")}</button>
          </form>
        </section>
      </div>
    </main>
  );
};

export default AdminAnnouncements;
