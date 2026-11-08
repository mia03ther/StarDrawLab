import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { OssImage, OssVideo } from "../components/OssMedia";
import "./AccountCenter.css";

const getStatusConfig = (isZh, ui) => ({
  completed: { label: isZh ? "已完成" : "Completed", color: ui.primary },
  running: { label: isZh ? "处理中" : "Processing", color: ui.gold },
  pending: { label: isZh ? "排队中" : "Queued", color: ui.muted },
  failed: { label: isZh ? "失败" : "Failed", color: ui.danger },
});

const formatDate = (value, isZh) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(isZh ? "zh-CN" : "en-US");
};

const profileValue = (value, t) => value || t("未设置", "Not set");

const AccountCenter = () => {
  const navigate = useNavigate();
  const authAxios = useAuthAxios();
  const { user, applyProfile, refreshProfile, reauthenticate } = useAuthing();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const identityProfile = user?.profile || {};

  const [account, setAccount] = useState(null);
  const [creations, setCreations] = useState([]);
  const [identityAccount, setIdentityAccount] = useState(null);
  const [identityAccountError, setIdentityAccountError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [displayName, setDisplayName] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [identityDraft, setIdentityDraft] = useState({ name: "", username: "", gender: "", birthdate: "" });
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [passwordDraft, setPasswordDraft] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    setDisplayName(user?.name || "");
  }, [user?.name]);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      authAxios.get("/api/points/balance"),
      authAxios.get("/api/user/get-user-creations?page_size=6"),
      authAxios.get("/api/user/identity/account").then((response) => ({ response })).catch((error) => ({ error })),
    ]).then(([balanceRes, creationsRes, identityRes]) => {
      if (!mounted) return;
      setAccount(balanceRes.data?.data || null);
      setCreations(creationsRes.data?.creations || []);
      const identityData = identityRes.response?.data?.data || null;
      setIdentityAccount(identityData);
      setIdentityAccountError(identityRes.error ? {
        code: identityRes.error.response?.data?.code || "IDENTITY_ACCOUNT_FAILED",
        status: identityRes.error.response?.status || 0,
      } : null);
      const identity = identityData?.profile || {};
      if (identityData?.available && identity) {
        applyProfile({
          username: identity.username || identity.preferred_username,
          email: identity.email,
          phone: identity.phone_number || identity.phone,
          full_name: identity.full_name || identity.name,
          gender: identity.gender,
          birthdate: identity.birthdate,
        });
      }
    }).catch(() => {
      if (!mounted) return;
      setAccount(null);
      setCreations([]);
    }).finally(() => {
      if (mounted) setLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, [applyProfile, authAxios]);

  useEffect(() => {
    const profile = identityAccount?.profile || {};
    setIdentityDraft({
      name: profile.name || user?.fullName || "",
      username: profile.username || user?.username || "",
      gender: profile.gender || user?.gender || "",
      birthdate: profile.birthdate || user?.birthdate || "",
    });
  }, [identityAccount, user?.birthdate, user?.fullName, user?.gender, user?.username]);

  const createdSummary = useMemo(() => ({
    total: creations.length,
    image: creations.filter((item) => item.type === "image").length,
    video: creations.filter((item) => item.type === "video").length,
  }), [creations]);

  const statusConfig = getStatusConfig(isZh, ui);

  const handleDisplayNameSave = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      toast.error(t("显示名字不能为空", "Display name is required"));
      return;
    }
    if (trimmed.length > 40) {
      toast.error(t("显示名字最多 40 个字符", "Display name must be 40 characters or fewer"));
      return;
    }

    setSavingName(true);
    try {
      const { data } = await authAxios.patch("/api/user/profile", {
        display_name: trimmed,
      });
      applyProfile(data?.data || { display_name: trimmed });
      toast.success(t("显示名字已更新", "Display name updated"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("更新显示名字失败", "Failed to update display name"));
    } finally {
      setSavingName(false);
    }
  };

  const handleAvatarChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;
    if (!file.type?.startsWith("image/")) {
      toast.error(t("请选择图片文件", "Please select an image file"));
      return;
    }

    const formData = new FormData();
    formData.append("avatar", file);

    setUploadingAvatar(true);
    try {
      const { data } = await authAxios.post("/api/user/profile/avatar", formData);
      applyProfile(data?.data || {});
      toast.success(t("头像已更新", "Avatar updated"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("上传头像失败", "Failed to upload avatar"));
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleIdentitySave = async () => {
    const payload = {};
    for (const field of ["name", "username", "gender"]) {
      const value = identityDraft[field].trim();
      if (value) payload[field] = value;
    }
    if (identityDraft.birthdate) payload.birthdate = identityDraft.birthdate;
    if (!payload.name && !payload.username && !payload.gender && !payload.birthdate) {
      toast.error(t("至少填写一项身份资料", "Enter at least one account profile field"));
      return;
    }
    setSavingIdentity(true);
    try {
      const { data } = await authAxios.patch("/api/user/identity/account", payload);
      const nextAccount = data?.data || null;
      setIdentityAccount(nextAccount);
      const profile = nextAccount?.profile || {};
      applyProfile({
        username: profile.username || payload.username,
        full_name: profile.name || payload.name,
        gender: profile.gender || payload.gender,
        birthdate: profile.birthdate || payload.birthdate,
      });
      toast.success(t("身份资料已更新", "Account profile updated"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("身份资料更新失败", "Failed to update account profile"));
    } finally {
      setSavingIdentity(false);
    }
  };

  const handlePasswordSave = async () => {
    if (!passwordDraft.current_password || !passwordDraft.new_password) {
      toast.error(t("请输入当前密码和新密码", "Enter your current and new password"));
      return;
    }
    if (passwordDraft.new_password !== passwordDraft.confirm_password) {
      toast.error(t("两次输入的新密码不一致", "The new passwords do not match"));
      return;
    }
    setSavingPassword(true);
    try {
      await authAxios.post("/api/user/identity/password", {
        current_password: passwordDraft.current_password,
        new_password: passwordDraft.new_password,
      });
      setPasswordDraft({ current_password: "", new_password: "", confirm_password: "" });
      toast.success(t("密码已更新，请重新登录", "Password updated. Please sign in again"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("密码更新失败", "Failed to update password"));
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="account-studio p-10 max-w-[1400px] mx-auto">
      <section className="account-studio-hero grid grid-cols-12 gap-6 mb-8">
        <div className="account-profile-card col-span-12 xl:col-span-7 rounded-3xl p-8"
          style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="flex items-start gap-5">
            {user?.imageUrl ? (
              <OssImage
                src={user.imageUrl}
                alt=""
                className="w-20 h-20 rounded-3xl object-cover flex-shrink-0"
                style={{ border: `1px solid ${ui.lineStrong}` }}
              />
            ) : (
              <div
                className="w-20 h-20 rounded-3xl flex items-center justify-center text-2xl font-black flex-shrink-0"
                style={{ background: ui.surfaceAlt, color: ui.primary, border: `1px solid ${ui.lineStrong}` }}
              >
                {user?.name?.[0]?.toUpperCase() || "U"}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.24em] font-bold mb-2" style={{ color: ui.faint }}>
                {t("个人中心", "Account Center")}
              </p>
              <h2 className="text-4xl font-extrabold leading-tight mb-2"
                style={{ color: ui.text, fontFamily: "Manrope, sans-serif", letterSpacing: "-0.02em" }}>
                {user?.name || t("用户", "User")}
              </h2>
              <p className="text-sm" style={{ color: ui.muted, opacity: 0.8 }}>
                {user?.email || user?.phone || t("当前账号暂无邮箱或手机号信息。", "No email or phone is currently available for this account.")}
              </p>
              <div className="flex flex-wrap gap-3 mt-5">
                <label
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold cursor-pointer"
                  style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}
                >
                  <span className="material-symbols-outlined text-[18px]">photo_camera</span>
                  {uploadingAvatar ? t("上传中…", "Uploading…") : t("上传头像", "Upload Avatar")}
                  <input type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
                </label>
                <button
                  type="button"
                  onClick={() => navigate("/ai/history")}
                  className="px-4 py-2 rounded-xl text-sm font-bold"
                  style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}
                >
                  {t("查看历史", "View History")}
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 mt-6">
                {[
                  { label: t("用户 ID", "User ID"), value: user?.id || "—" },
                  { label: t("用户名", "Username"), value: profileValue(user?.username || identityProfile.username, t) },
                  { label: t("邮箱", "Email"), value: profileValue(user?.email, t) },
                  { label: t("手机号", "Phone"), value: profileValue(user?.phone, t) },
                  { label: t("姓名", "Full name"), value: profileValue(user?.fullName || identityProfile.full_name, t) },
                  { label: t("性别", "Gender"), value: profileValue(user?.gender || identityProfile.gender, t) },
                  { label: t("出生日期", "Birth date"), value: profileValue(user?.birthdate || identityProfile.birthdate, t) },
                  {
                    label: t("会员等级", "Membership"),
                    value: account
                      ? (isZh
                        ? ((account.membership_tier || "free") === "free" ? "免费" : String(account.membership_tier || "").toUpperCase())
                        : String(account.membership_tier || "free").toUpperCase())
                      : "—",
                  },
                  {
                    label: t("最近作品", "Recent Outputs"),
                    value: loading ? "—" : `${createdSummary.total} ${t("个", "items")}`,
                  },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-2xl px-4 py-3"
                    style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: ui.faint }}>{label}</p>
                    <p className="text-sm font-bold truncate" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{value}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="account-snapshot-card col-span-12 xl:col-span-5 rounded-3xl p-6"
          style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <p className="text-[10px] uppercase tracking-[0.24em] font-bold mb-5" style={{ color: ui.faint }}>
            {t("账户概览", "Account Snapshot")}
          </p>
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: t("可用积分", "Available"), value: account?.available_points ?? 0, icon: "bolt", color: ui.primary },
              { label: t("冻结积分", "Held"), value: account?.held_points ?? 0, icon: "lock_clock", color: ui.gold },
              { label: t("图片作品", "Image Outputs"), value: createdSummary.image, icon: "auto_awesome", color: ui.muted },
              { label: t("视频作品", "Video Outputs"), value: createdSummary.video, icon: "movie_filter", color: ui.gold },
            ].map(({ label, value, icon, color }) => (
              <div key={label} className="rounded-2xl p-4"
                style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                <span className="material-symbols-outlined text-xl mb-4" style={{ color }}>{icon}</span>
                <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: ui.faint }}>{label}</p>
                <p className="text-2xl font-extrabold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="account-studio-panels grid grid-cols-12 gap-6">
        <div className="col-span-12 lg:col-span-4 rounded-3xl p-6"
          style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-6 rounded-2xl p-4"
            style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-[0.24em] font-bold mb-4" style={{ color: ui.faint }}>
              {t("编辑资料", "Edit Profile")}
            </p>
            <label className="block">
              <p className="text-[11px] font-bold mb-2" style={{ color: ui.muted }}>
                {t("显示名字", "Display Name")}
              </p>
              <input
                type="text"
                maxLength={40}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("输入你希望展示给客户的名字", "Enter the name you want customers to see")}
                className="w-full rounded-2xl px-4 py-3 text-sm outline-none"
                style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }}
              />
            </label>
            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-[11px]" style={{ color: ui.faint }}>
                {displayName.trim().length}/40
              </p>
              <button
                type="button"
                onClick={handleDisplayNameSave}
                disabled={savingName}
                className="px-4 py-2 rounded-xl text-sm font-bold disabled:opacity-60"
                style={{ background: ui.primary, color: ui.primaryText }}
              >
                {savingName ? t("保存中…", "Saving…") : t("保存显示名字", "Save Display Name")}
              </button>
            </div>
          </div>

          <div className="mb-6 rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.24em] font-bold" style={{ color: ui.faint }}>{t("账户与安全", "Account & Security")}</p>
                <p className="mt-1 text-xs leading-5" style={{ color: ui.muted }}>
                  {identityAccount?.available
                    ? t("身份资料和安全状态由身份服务管理，StarDraw 会同步展示。", "Your identity service manages profile and security; StarDraw keeps a synchronized view.")
                    : identityAccountError?.code === "IDENTITY_ACCOUNT_UNAUTHORIZED"
                      ? t("账户服务已开启，但当前登录凭证没有访问权限。请重新登录后再试。", "The account service is enabled, but this session is not authorized. Sign in again and retry.")
                      : identityAccountError
                        ? t("暂时无法连接账户服务，请稍后重试。", "The account service is temporarily unavailable. Please try again later.")
                  : t("账户服务尚未配置。", "The account service is not configured yet.")}
                </p>
                {identityAccountError && ["IDENTITY_ACCOUNT_UNAUTHORIZED", "IDENTITY_ACCOUNT_TOKEN_MISSING", "OIDC_ACCOUNT_REAUTH_REQUIRED"].includes(identityAccountError.code) && (
                  <button
                    type="button"
                    onClick={reauthenticate}
                    className="mt-3 rounded-xl px-3 py-2 text-xs font-bold"
                    style={{ background: ui.primary, color: ui.primaryText }}
                  >
                    {t("重新登录并启用账户权限", "Sign in again to enable account access")}
                  </button>
                )}
              </div>
              <span className="rounded-full px-2 py-1 text-[9px] font-black uppercase" style={{ background: identityAccount?.available ? ui.primarySoft : ui.surfaceHigh, color: identityAccount?.available ? ui.primary : ui.faint }}>{identityAccount?.available ? t("已连接", "CONNECTED") : t("不可用", "UNAVAILABLE")}</span>
            </div>
            {identityAccount?.available && <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("身份名称", "Account Name")}</span><input value={identityDraft.name} onChange={(event) => setIdentityDraft((current) => ({ ...current, name: event.target.value }))} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("用户名", "Username")}</span><input value={identityDraft.username} onChange={(event) => setIdentityDraft((current) => ({ ...current, username: event.target.value }))} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("性别", "Gender")}</span><input value={identityDraft.gender} onChange={(event) => setIdentityDraft((current) => ({ ...current, gender: event.target.value }))} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("出生日期", "Birth date")}</span><input type="date" value={identityDraft.birthdate || ""} onChange={(event) => setIdentityDraft((current) => ({ ...current, birthdate: event.target.value }))} className="w-full rounded-xl px-3 py-2.5 text-sm" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("邮箱", "Email")}</span><input value={identityAccount.profile?.email || ""} readOnly className="w-full rounded-xl px-3 py-2.5 text-sm opacity-70" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
                <label className="block"><span className="mb-1 block text-[11px] font-bold" style={{ color: ui.muted }}>{t("手机号", "Phone")}</span><input value={identityAccount.profile?.phone_number || identityAccount.profile?.phone || ""} readOnly className="w-full rounded-xl px-3 py-2.5 text-sm opacity-70" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
              </div>
              <button type="button" onClick={handleIdentitySave} disabled={savingIdentity} className="mt-4 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-60" style={{ background: ui.primary, color: ui.primaryText }}>{savingIdentity ? t("保存中…", "Saving…") : t("保存身份资料", "Save account profile")}</button>
              <div className="mt-5 border-t pt-4" style={{ borderColor: ui.line }}>
                <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: ui.faint }}>{t("安全设置", "Security")}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <input type="password" value={passwordDraft.current_password} onChange={(event) => setPasswordDraft((current) => ({ ...current, current_password: event.target.value }))} placeholder={t("当前密码", "Current password")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
                  <input type="password" value={passwordDraft.new_password} onChange={(event) => setPasswordDraft((current) => ({ ...current, new_password: event.target.value }))} placeholder={t("新密码", "New password")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
                  <input type="password" value={passwordDraft.confirm_password} onChange={(event) => setPasswordDraft((current) => ({ ...current, confirm_password: event.target.value }))} placeholder={t("确认新密码", "Confirm new password")} className="rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surface, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-[11px]" style={{ color: ui.faint }}>{identityAccount.security?.mfa_available ? t(`MFA 验证方式 ${identityAccount.security.mfa_count} 个`, `${identityAccount.security.mfa_count} MFA method(s)`) : t("MFA 状态由身份服务管理", "MFA status is managed by your identity service")}{identityAccount.security?.sessions_available ? ` · ${identityAccount.security.active_session_count} ${t("个活动会话", "active session(s)")}` : ""}</p><button type="button" onClick={handlePasswordSave} disabled={savingPassword} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-60" style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.lineStrong}` }}>{savingPassword ? t("更新中…", "Updating…") : t("修改密码", "Change password")}</button></div>
              </div>
            </>}
          </div>

          <p className="text-[10px] uppercase tracking-[0.24em] font-bold mb-5" style={{ color: ui.faint }}>
            {t("快捷入口", "Quick Links")}
          </p>
          <div className="space-y-3">
            {[
              {
                label: t("查看历史记录", "View History"),
                desc: t("查看图片与视频生成记录。", "Browse your generated images and videos."),
                icon: "history",
                to: "/ai/history",
              },
              {
                label: t("查看积分账单", "View Billing"),
                desc: t("查看充值、扣费与返还明细。", "Review recharge, charge, and refund details."),
                icon: "payments",
                to: "/ai/billing",
              },
              {
                label: t("刷新资料", "Refresh Profile"),
                desc: t("重新同步你当前的头像与显示名字。", "Refresh your latest avatar and display name."),
                icon: "sync",
                to: null,
                action: async () => {
                  await refreshProfile();
                  toast.success(t("资料已刷新", "Profile refreshed"));
                },
              },
              {
                label: t("返回总览", "Back to Dashboard"),
                desc: t("回到工作台继续创作。", "Return to the workspace and keep creating."),
                icon: "dashboard",
                to: "/ai",
              },
            ].map(({ label, desc, icon, to, action }) => (
              <button
                key={to || label}
                type="button"
                onClick={() => {
                  if (action) {
                    action();
                    return;
                  }
                  navigate(to);
                }}
                className="w-full text-left rounded-2xl p-4 transition-all"
                style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}
              >
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-xl mt-0.5" style={{ color: ui.primary }}>{icon}</span>
                  <div className="min-w-0">
                    <p className="font-bold text-sm" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{label}</p>
                    <p className="text-xs mt-1" style={{ color: ui.faint, lineHeight: 1.6 }}>{desc}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-12 lg:col-span-8 rounded-3xl p-6"
          style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="flex items-center justify-between gap-4 mb-5">
            <div>
              <p className="text-[10px] uppercase tracking-[0.24em] font-bold mb-1" style={{ color: ui.faint }}>
                {t("最近作品", "Recent Outputs")}
              </p>
              <p className="text-sm" style={{ color: ui.faint }}>
                {t("这里展示你最近生成的内容。", "A quick view of your most recent generations.")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate("/ai/history")}
              className="px-4 py-2 rounded-xl text-sm font-bold"
              style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.line}` }}
            >
              {t("查看全部", "View All")}
            </button>
          </div>

          {loading ? (
            <div className="py-16 flex flex-col items-center justify-center">
              <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin mb-4"
                style={{ borderColor: ui.primary, borderTopColor: "transparent" }} />
              <p className="text-sm" style={{ color: ui.faint }}>{t("正在加载个人中心…", "Loading account center…")}</p>
            </div>
          ) : creations.length === 0 ? (
            <div className="py-16 text-center">
              <span className="material-symbols-outlined text-5xl mb-4" style={{ color: ui.faint }}>dashboard_customize</span>
              <p className="font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("还没有生成记录", "No outputs yet")}
              </p>
              <p className="text-sm" style={{ color: ui.faint }}>
                {t("去生成第一张图片或第一段视频后，这里会出现最近作品。", "Generate your first image or video and it will appear here.")}
              </p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {creations.map((item) => {
                const cfg = statusConfig[item.status] || statusConfig.completed;
                const previewImage = item.reference_preview_url || item.preview_image_url || item.thumbnail_url || (item.type === "image" ? item.content : null);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate("/ai/history")}
                    className="text-left rounded-2xl overflow-hidden transition-all"
                    style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}
                  >
                    <div className="relative" style={{ aspectRatio: "16 / 10", background: ui.surfaceHigh }}>
                      {item.type === "video" && item.content ? (
                        <OssVideo
                          src={item.content}
                          poster={item.preview_image_url || item.thumbnail_url || item.reference_preview_url || undefined}
                          muted
                          playsInline
                          preload="metadata"
                          className="w-full h-full object-cover"
                        />
                      ) : previewImage ? (
                        <OssImage src={previewImage} alt={item.scene_name} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="material-symbols-outlined text-4xl" style={{ color: ui.faint }}>
                            {item.type === "video" ? "movie_filter" : "auto_awesome"}
                          </span>
                        </div>
                      )}
                      <div className="absolute top-3 right-3 px-2.5 py-1 rounded-full text-[10px] font-bold"
                        style={{ background: ui.overlay, color: cfg.color, border: `1px solid ${ui.line}` }}>
                        {cfg.label}
                      </div>
                    </div>
                    <div className="p-4">
                      <p className="font-bold text-sm truncate" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                        {item.scene_name || t("生成任务", "Generation")}
                      </p>
                      <p className="text-[11px] mt-1" style={{ color: ui.faint }}>
                        {item.type === "video" ? t("视频", "Video") : t("图片", "Image")} • {formatDate(item.created_at, isZh)}
                        {item.points_cost > 0 && ` • ${item.points_cost} ${t("积分", "pts")}`}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};

export default AccountCenter;
