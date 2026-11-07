import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";

const Callback = () => {
  const navigate               = useNavigate();
  const { isReady, isSignedIn } = useAuthing();
  const { t } = useLanguage();

  useEffect(() => {
    if (isReady) {
      const hasPendingAgentInstruction = Boolean(window.localStorage.getItem("stardraw_pending_agent_instruction"));
      const hasPendingHomePrompt = Boolean(window.localStorage.getItem("stardraw_pending_home_prompt"));
      const hasPendingInvitation = Boolean(window.localStorage.getItem("stardraw_pending_invitation_code"));
      const destination = !isSignedIn
        ? "/"
        : hasPendingInvitation
          ? "/invite"
        : hasPendingAgentInstruction
          ? "/home"
          : hasPendingHomePrompt
            ? "/home"
            : "/home";
      navigate(destination, { replace: true });
    }
  }, [isReady, isSignedIn, navigate]);

  return (
    <div className="flex h-screen items-center justify-center" style={{ background: "#10141a" }}>
      <div className="flex flex-col items-center gap-6">
        {/* StarDraw brand mark */}
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center"
          style={{ background: "#ee9d47" }}>
          <span className="material-symbols-outlined filled text-xl" style={{ color: "#002388" }}>
            architecture
          </span>
        </div>
        <div className="text-center">
          <h1 className="text-xl font-bold mb-1"
            style={{ color: "#dfe2eb", fontFamily: "Manrope, sans-serif" }}>
            StarDraw
          </h1>
          <p className="text-sm" style={{ color: "#8f9095" }}>{t("正在完成登录认证…", "Completing authentication…")}</p>
        </div>
        {/* Spinner */}
        <div className="w-7 h-7 rounded-full border-2 border-t-transparent animate-spin"
          style={{ borderColor: "#ee9d47", borderTopColor: "transparent" }} />
      </div>
    </div>
  );
};

export default Callback;
