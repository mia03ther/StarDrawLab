import { createElement, useCallback, useEffect, useState } from "react";
import { Check, Copy, Gift, Link2, LoaderCircle, RefreshCw, Users } from "lucide-react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const Invitations = () => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const response = await authAxios.get("/api/invitations/me");
    setData(response.data?.data || null);
  }, [authAxios]);

  useEffect(() => {
    load().catch((error) => toast.error(error.response?.data?.message || t("邀请系统加载失败，请稍后再试。", "Unable to load invitations."))).finally(() => setLoading(false));
  }, [load, t]);

  const regenerate = async () => {
    if (data?.personal && !window.confirm(t("重新生成后，旧的个人邀请链接会失效，继续吗？", "Regenerating will invalidate your current personal link. Continue?"))) return;
    setWorking(true);
    try {
      const response = await authAxios.post("/api/invitations/regenerate", {});
      const result = response.data?.data?.code;
      setData((current) => ({ ...(current || {}), personal: result }));
      setCopied(false);
      toast.success(t("个人邀请链接已生成", "Personal invitation link created"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("生成邀请链接失败", "Unable to create invitation link"));
    } finally {
      setWorking(false);
    }
  };

  const copyLink = async () => {
    if (!data?.personal?.link) return;
    try {
      await navigator.clipboard.writeText(data.personal.link);
      setCopied(true);
      toast.success(t("链接已复制", "Link copied"));
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error(t("复制失败，请手动复制链接。", "Copy failed. Please copy the link manually."));
    }
  };

  if (loading) return <main className="flex min-h-[70vh] items-center justify-center"><LoaderCircle className="animate-spin" style={{ color: ui.primary }} /></main>;
  const settings = data?.settings;
  const stats = data?.stats || {};

  return (
    <main className="mx-auto max-w-6xl p-6 md:p-10">
      <div className="mb-8"><p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("邀请计划", "INVITATION PROGRAM")}</p><h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("邀请奖励", "Invitation rewards")}</h1><p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: ui.muted }}>{t("分享你的专属链接。新用户完成注册后，你们都能获得奖励积分。", "Share your personal link. When a new user registers, both of you receive reward points.")}</p></div>
      <div className="grid gap-5 md:grid-cols-3">
        {[{ label: t("已邀请用户", "Invited users"), value: stats.invited_count || 0, icon: Users }, { label: t("获得的邀请积分", "Points earned"), value: stats.inviter_reward_points || 0, icon: Gift }, { label: t("当前规则", "Current rule"), value: settings?.is_enabled ? `${settings.inviter_reward_points || 0} + ${settings.invitee_reward_points || 0}` : t("未开启", "Off"), icon: Link2 }].map(({ label, value, icon }) => <div key={label} className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>{createElement(icon, { size: 19, style: { color: ui.primary } })}<p className="mt-5 text-[10px] font-black uppercase tracking-widest" style={{ color: ui.faint }}>{label}</p><p className="mt-2 text-2xl font-black" style={{ color: ui.text }}>{value}</p></div>)}
      </div>
      <section className="mt-5 rounded-3xl p-6 md:p-8" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-black" style={{ color: ui.text }}>{t("你的个人邀请链接", "Your personal invitation link")}</h2><p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("重新生成会立即撤销旧链接，但不会影响已经完成的邀请。", "Regenerating immediately revokes the old link without affecting completed referrals.")}</p></div><button type="button" onClick={regenerate} disabled={working} className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primarySoft, color: ui.primary }}><RefreshCw size={16} className={working ? "animate-spin" : ""} />{data?.personal ? t("重新生成", "Regenerate") : t("生成链接", "Create link")}</button></div>
        {data?.personal ? <div className="mt-6 flex flex-col gap-3 md:flex-row"><div className="min-w-0 flex-1 rounded-2xl px-4 py-3 text-sm break-all" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, color: ui.muted }}>{data.personal.link}</div><button type="button" onClick={copyLink} className="inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? t("已复制", "Copied") : t("复制链接", "Copy link")}</button></div> : <div className="mt-6 rounded-2xl px-4 py-5 text-sm" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, color: ui.muted }}>{t("你还没有个人邀请链接，点击右上角生成。", "You do not have a personal invitation link yet. Create one above.")}</div>}
        {settings && <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs" style={{ color: ui.faint }}><span>{t("邀请人奖励", "Inviter reward")}: <b style={{ color: ui.text }}>{settings.inviter_reward_points}</b> {t("积分", "points")}</span><span>{t("新用户奖励", "New user reward")}: <b style={{ color: ui.text }}>{settings.invitee_reward_points}</b> {t("积分", "points")}</span><span>{settings.reward_validity_days === 0 ? t("奖励永不过期", "Rewards never expire") : `${t("奖励有效期", "Reward validity")}: ${settings.reward_validity_days} ${t("天", "days")}`}</span></div>}
      </section>
    </main>
  );
};

export default Invitations;
