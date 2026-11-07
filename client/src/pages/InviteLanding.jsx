import { useEffect, useMemo, useRef, useState } from "react";
import { Gift, LoaderCircle, LogIn, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const PENDING_INVITATION_KEY = "stardraw_pending_invitation_code";
const CLAIM_TIMEOUT_MS = 15000;

const readCode = () => {
  if (typeof window === "undefined") return "";
  const queryCode = new URLSearchParams(window.location.search).get("code");
  const normalizedQueryCode = String(queryCode || "").trim().toUpperCase();
  if (normalizedQueryCode) return normalizedQueryCode;
  try {
    return String(window.localStorage.getItem(PENDING_INVITATION_KEY) || "").trim().toUpperCase();
  } catch {
    return "";
  }
};

const InviteLanding = () => {
  const navigate = useNavigate();
  const authAxios = useAuthAxios();
  const { isReady, isSignedIn, login } = useAuthing();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const queryCode = useMemo(readCode, []);
  const [code] = useState(queryCode);
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [claimAttempt, setClaimAttempt] = useState(0);
  const authAxiosRef = useRef(authAxios);
  const translateRef = useRef(t);
  const claimStartedRef = useRef(false);

  // The auth client and translator can be recreated when the auth/profile or
  // locale state changes. Keep the request effect stable while still using the
  // latest instances when a retry or delayed response needs them.
  authAxiosRef.current = authAxios;
  translateRef.current = t;

  useEffect(() => {
    if (!code) return;
    try {
      window.localStorage.setItem(PENDING_INVITATION_KEY, code);
    } catch {
      // The claim can still be completed during this visit when storage is blocked.
    }
  }, [code]);

  useEffect(() => {
    if (!isReady || !isSignedIn || !code || claimStartedRef.current) return;
    let cancelled = false;
    claimStartedRef.current = true;
    setStatus("claiming");
    authAxiosRef.current.post("/api/invitations/claim", { code }, { timeout: CLAIM_TIMEOUT_MS })
      .then(({ data }) => {
        if (cancelled) return;
        try { window.localStorage.removeItem(PENDING_INVITATION_KEY); } catch { /* best effort */ }
        const result = data?.data || {};
        const translate = translateRef.current;
        setStatus("claimed");
        setMessage(result.already_claimed
          ? translate("这个账号已经领取过邀请奖励。", "This account has already claimed an invitation reward.")
          : translate(`邀请奖励已到账：${result.invitee_reward_points || 0} 积分。`, `Invitation reward added: ${result.invitee_reward_points || 0} points.`));
        window.dispatchEvent(new CustomEvent("stardraw:points-updated"));
      })
      .catch((error) => {
        if (cancelled) return;
        const translate = translateRef.current;
        const responseCode = error.response?.data?.code;
        const terminal = [
          "INVITATION_CODE_NOT_FOUND",
          "INVITATION_LINK_INACTIVE",
          "INVITATION_SELF_CLAIM",
          "INVITATION_ALREADY_CLAIMED",
          "INVITATION_REWARDS_EMPTY",
        ].includes(responseCode);
        if (terminal) {
          try { window.localStorage.removeItem(PENDING_INVITATION_KEY); } catch { /* best effort */ }
        }
        setStatus("error");
        setMessage(error.response?.data?.message || (
          error.code === "ECONNABORTED"
            ? translate("领取邀请奖励超时，请重试。", "Claiming the invitation reward timed out. Please retry.")
            : translate("邀请奖励暂时无法领取，请稍后再试。", "The invitation reward is temporarily unavailable.")
        ));
      });
    return () => { cancelled = true; };
  }, [claimAttempt, code, isReady, isSignedIn]);

  const handleLogin = () => {
    if (code) {
      try { window.localStorage.setItem(PENDING_INVITATION_KEY, code); } catch { /* best effort */ }
    }
    login();
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-5" style={{ background: ui.page, color: ui.text }}>
      <section className="w-full max-w-md rounded-3xl p-8 text-center" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl" style={{ background: ui.primarySoft, color: ui.primary }}>
          <Gift size={27} />
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>StarDraw</p>
        <h1 className="mt-3 text-2xl font-black" style={{ color: ui.text }}>{t("邀请奖励", "Invitation reward")}</h1>
        <p className="mt-3 text-sm leading-6" style={{ color: ui.muted }}>
          {code ? t("登录或注册后即可领取邀请奖励。", "Sign in or create an account to claim the invitation reward.") : t("邀请链接无效或已过期。", "This invitation link is invalid or has expired.")}
        </p>
        {code && <div className="mt-5 rounded-2xl px-4 py-3 text-sm font-black tracking-[0.16em]" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}`, color: ui.primary }}>{code}</div>}
        {status !== "idle" && <div className="mt-5 rounded-2xl px-4 py-3 text-sm" style={{ background: status === "error" ? ui.dangerSoft : ui.primarySoft, color: status === "error" ? ui.danger : ui.primary }}>{message || t("正在处理邀请奖励…", "Processing invitation reward…")}</div>}
        <div className="mt-6 flex flex-col gap-3">
          {!isSignedIn && code && <button type="button" onClick={handleLogin} className="inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black" style={{ background: ui.buttonGradient, color: ui.primaryText }}><LogIn size={17} />{t("登录 / 注册", "Sign in / Register")}</button>}
          {isSignedIn && status === "claiming" && <div className="inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black" style={{ background: ui.primarySoft, color: ui.primary }}><LoaderCircle className="animate-spin" size={17} />{t("领取中…", "Claiming…")}</div>}
          {(isSignedIn && status !== "claiming") && <button type="button" onClick={() => navigate("/home")} className="inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-black" style={{ background: ui.primarySoft, color: ui.primary }}><Sparkles size={17} />{t("进入 StarDraw", "Open StarDraw")}</button>}
          {!isSignedIn && !isReady && <div className="inline-flex items-center justify-center gap-2 text-sm" style={{ color: ui.faint }}><LoaderCircle className="animate-spin" size={16} />{t("正在检查登录状态…", "Checking sign-in status…")}</div>}
          {!isSignedIn && !code && <button type="button" onClick={() => navigate("/")} className="rounded-2xl px-5 py-3 text-sm font-black" style={{ background: ui.primarySoft, color: ui.primary }}>{t("返回首页", "Back to home")}</button>}
        </div>
        {status === "error" && <button type="button" onClick={() => { claimStartedRef.current = false; setStatus("idle"); setMessage(""); setClaimAttempt((attempt) => attempt + 1); }} className="mt-4 text-xs font-bold" style={{ color: ui.faint }}>{t("重试", "Try again")}</button>}
      </section>
    </main>
  );
};

export default InviteLanding;
