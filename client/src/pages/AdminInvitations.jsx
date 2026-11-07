import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Link2, LoaderCircle, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const initialSettings = { inviter_reward_points: 0, invitee_reward_points: 0, reward_validity_days: 30, is_enabled: false };

const AdminInvitations = () => {
  const authAxios = useAuthAxios();
  const { t, locale } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [settings, setSettings] = useState(initialSettings);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const load = useCallback(async () => {
    const [settingsResponse, linksResponse] = await Promise.all([
      authAxios.get("/api/admin/invitations/settings"),
      authAxios.get("/api/admin/invitations/common-links"),
    ]);
    setSettings({ ...initialSettings, ...(settingsResponse.data?.data || {}) });
    setLinks(linksResponse.data?.data || []);
  }, [authAxios]);

  useEffect(() => {
    load().catch((error) => toast.error(error.response?.data?.message || t("邀请系统加载失败", "Unable to load invitation settings"))).finally(() => setLoading(false));
  }, [load, t]);

  const saveSettings = async () => {
    setSaving(true);
    try {
      const response = await authAxios.put("/api/admin/invitations/settings", {
        ...settings,
        inviter_reward_points: Number(settings.inviter_reward_points),
        invitee_reward_points: Number(settings.invitee_reward_points),
        reward_validity_days: Number(settings.reward_validity_days),
        reason: t("更新邀请奖励规则", "Update invitation reward rules"),
      }, { headers: { "X-Idempotency-Key": uuidv4() } });
      setSettings((current) => ({ ...current, ...(response.data?.data || {}) }));
      toast.success(t("邀请规则已保存", "Invitation rules saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const createLink = async () => {
    try {
      const response = await authAxios.post("/api/admin/invitations/common-links", { reason: t("生成通用邀请链接", "Create common invitation link") }, { headers: { "X-Idempotency-Key": uuidv4() } });
      setLinks((current) => [{ ...response.data?.data, is_active: true, created_at: new Date().toISOString(), redemption_count: 0 }, ...current]);
      toast.success(t("通用链接已生成", "Common link created"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("生成失败", "Create failed"));
    }
  };

  const revoke = async (item) => {
    if (!window.confirm(t("撤销这个通用链接？已经完成的邀请不受影响。", "Revoke this common link? Completed referrals are unaffected."))) return;
    try {
      const response = await authAxios.delete(`/api/admin/invitations/common-links/${item.id}`, { data: { reason: t("撤销通用邀请链接", "Revoke common invitation link") }, headers: { "X-Idempotency-Key": uuidv4() } });
      setLinks((current) => current.map((link) => link.id === item.id ? { ...link, ...(response.data?.data || {}), is_active: false } : link));
    } catch (error) {
      toast.error(error.response?.data?.message || t("撤销失败", "Revoke failed"));
    }
  };

  const regenerate = async (item) => {
    try {
      const response = await authAxios.post(`/api/admin/invitations/common-links/${item.id}/regenerate`, { reason: t("重新生成通用邀请链接", "Regenerate common invitation link") }, { headers: { "X-Idempotency-Key": uuidv4() } });
      const next = { ...response.data?.data, is_active: true, redemption_count: 0, created_at: new Date().toISOString() };
      setLinks((current) => [next, ...current.map((link) => link.id === item.id ? { ...link, is_active: false, revoked_at: new Date().toISOString() } : link)]);
      toast.success(t("通用链接已重新生成", "Common link regenerated"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("重新生成失败", "Regenerate failed"));
    }
  };

  const copyLink = async (item) => {
    if (!item?.link) return;
    try {
      await navigator.clipboard.writeText(item.link);
      setCopiedId(item.id);
      toast.success(t("链接已复制", "Link copied"));
      window.setTimeout(() => setCopiedId((current) => current === item.id ? null : current), 1600);
    } catch {
      toast.error(t("复制失败，请手动复制链接。", "Copy failed. Please copy the link manually."));
    }
  };

  if (loading) return <main className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="animate-spin" style={{ color: ui.primary }} /></main>;

  return (
    <main className="mx-auto max-w-7xl p-6 md:p-10">
      <div className="mb-8"><p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("管理员后台", "ADMIN CONSOLE")}</p><h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("邀请系统", "Invitation system")}</h1><p className="mt-3 text-sm" style={{ color: ui.muted }}>{t("设置奖励规则，并管理可公开分享的通用邀请链接。", "Configure reward rules and manage shareable common invitation links.")}</p></div>
      <section className="rounded-3xl p-6 md:p-8" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="flex items-center justify-between gap-3"><div><h2 className="text-xl font-black" style={{ color: ui.text }}>{t("奖励规则", "Reward rules")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("有效期填 0 表示永不过期。修改只影响之后的新邀请。", "Use 0 for rewards that never expire. Changes apply to new referrals only.")}</p></div><button type="button" onClick={saveSettings} disabled={saving} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.buttonGradient, color: ui.primaryText }}><Save size={16} />{saving ? t("保存中…", "Saving…") : t("保存规则", "Save rules")}</button></div>
        <div className="mt-6 grid gap-4 md:grid-cols-4"><label className="text-xs font-bold" style={{ color: ui.muted }}>{t("邀请人奖励积分", "Inviter reward") }<input type="number" min="0" max="2147483647" value={settings.inviter_reward_points} onChange={(event) => setSettings((current) => ({ ...current, inviter_reward_points: event.target.value }))} className="mt-2 w-full rounded-xl px-3 py-3 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label><label className="text-xs font-bold" style={{ color: ui.muted }}>{t("新用户奖励积分", "New user reward") }<input type="number" min="0" max="2147483647" value={settings.invitee_reward_points} onChange={(event) => setSettings((current) => ({ ...current, invitee_reward_points: event.target.value }))} className="mt-2 w-full rounded-xl px-3 py-3 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label><label className="text-xs font-bold" style={{ color: ui.muted }}>{t("奖励有效期（天）", "Reward validity (days)") }<input type="number" min="0" max="3650" value={settings.reward_validity_days} onChange={(event) => setSettings((current) => ({ ...current, reward_validity_days: event.target.value }))} className="mt-2 w-full rounded-xl px-3 py-3 text-sm" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label><label className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-bold" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}><input type="checkbox" checked={Boolean(settings.is_enabled)} onChange={(event) => setSettings((current) => ({ ...current, is_enabled: event.target.checked }))} />{t("启用邀请奖励", "Enable invitations")}</label></div>
      </section>
      <section className="mt-5 rounded-3xl p-6 md:p-8" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-black" style={{ color: ui.text }}>{t("通用邀请链接", "Common invitation links")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{t("通用链接不绑定具体邀请人，只向新用户发放被邀请人奖励。", "Common links are not tied to an inviter and grant only the new-user reward.")}</p></div><button type="button" onClick={createLink} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black" style={{ background: ui.primarySoft, color: ui.primary }}><Plus size={16} />{t("生成通用链接", "Create common link")}</button></div>
        <div className="mt-6 space-y-3">{links.map((item) => <div key={item.id} className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}><div className="flex flex-wrap items-center gap-3"><Link2 size={17} style={{ color: item.is_active ? ui.primary : ui.faint }} /><code className="min-w-0 flex-1 break-all text-xs" style={{ color: ui.text }}>{item.link}</code><span className="rounded-full px-2 py-1 text-[10px] font-black" style={{ background: item.is_active ? ui.primarySoft : ui.surfaceHigh, color: item.is_active ? ui.primary : ui.faint }}>{item.is_active ? t("启用", "Active") : t("已删除", "Deleted")}</span></div><div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs" style={{ color: ui.faint }}><span>{t("领取次数", "Redemptions")}: {item.redemption_count || 0} · {item.created_at ? new Date(item.created_at).toLocaleString(locale) : "—"}</span><div className="flex gap-2">{item.is_active && <button type="button" onClick={() => copyLink(item)} title={t("复制邀请链接", "Copy invitation link")} aria-label={t("复制邀请链接", "Copy invitation link")} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-bold" style={{ background: ui.surfaceHigh, color: ui.text }}>{copiedId === item.id ? <Check size={13} /> : <Copy size={13} />}{copiedId === item.id ? t("已复制", "Copied") : t("复制", "Copy")}</button>}{item.is_active && <button type="button" onClick={() => regenerate(item)} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-bold" style={{ background: ui.primarySoft, color: ui.primary }}><RefreshCw size={13} />{t("重新生成", "Regenerate")}</button>}{item.is_active && <button type="button" onClick={() => revoke(item)} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}><Trash2 size={13} />{t("删除", "Delete")}</button>}</div></div></div>)}{!links.length && <p className="rounded-2xl px-4 py-6 text-sm" style={{ background: ui.surfaceAlt, color: ui.faint }}>{t("还没有通用邀请链接。", "No common invitation links yet.")}</p>}</div>
      </section>
    </main>
  );
};

export default AdminInvitations;
