import { Outlet, useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const ACTIVE_ACCOUNT_STATUSES = new Set(["active"]);

const StatePanel = ({
  icon,
  title,
  message,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  busy = false,
}) => {
  const { ui } = useStarDrawTheme();

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-8">
      <section
        className="w-full max-w-xl rounded-3xl p-8 text-center"
        style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}
      >
        <div
          className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl ${busy ? "animate-pulse" : ""}`}
          style={{ background: ui.primarySoft, color: ui.primary }}
        >
          <span className="material-symbols-outlined text-3xl">{icon}</span>
        </div>
        <h1 className="mt-5 text-2xl font-black" style={{ color: ui.text }}>{title}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6" style={{ color: ui.faint }}>{message}</p>
        {(actionLabel && onAction) || (secondaryActionLabel && onSecondaryAction) ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            {actionLabel && onAction && (
              <button
                type="button"
                onClick={onAction}
                className="rounded-xl px-5 py-2.5 text-sm font-black"
                style={{ background: ui.buttonGradient, color: ui.primaryText }}
              >
                {actionLabel}
              </button>
            )}
            {secondaryActionLabel && onSecondaryAction && (
              <button
                type="button"
                onClick={onSecondaryAction}
                className="rounded-xl px-5 py-2.5 text-sm font-black"
                style={{ background: ui.surface, border: `1px solid ${ui.line}`, color: ui.text }}
              >
                {secondaryActionLabel}
              </button>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
};

/**
 * UX-only route guard. Every protected API must independently enforce the DB role
 * and account status; hiding a React route is never an authorization boundary.
 */
const RoleGuard = ({ allowedRoles = ["user", "admin", "root"], children }) => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const {
    isLoading,
    isSignedIn,
    authorizationLoading,
    authorizationError,
    authorizationIssue,
    role,
    accountStatus,
    login,
    reauthenticate,
    logout,
    refreshProfile,
  } = useAuthing();

  if (isLoading || authorizationLoading) {
    return (
      <StatePanel
        busy
        icon="shield_lock"
        title={t("正在确认访问权限", "Checking access")}
        message={t("正在从服务器读取账户角色和状态，请稍候。", "Loading your server-side role and account status.")}
      />
    );
  }

  if (!isSignedIn) {
    const sessionEnded = authorizationIssue?.status === 401
      || ["SESSION_REVOKED", "TOKEN_EXPIRED", "INVALID_TOKEN", "AUTHENTICATION_REQUIRED"]
        .includes(authorizationIssue?.code);

    return (
      <StatePanel
        icon="login"
        title={sessionEnded
          ? t("登录状态已失效", "Session expired")
          : t("请先登录", "Sign in required")}
        message={sessionEnded
          ? t(
            "为保护账户安全，本地登录状态已清除。请重新登录后继续。",
            "Your local session was cleared for account security. Sign in again to continue.",
          )
          : t("登录后才能访问此页面。", "Please sign in to access this page.")}
        actionLabel={t("重新登录", "Sign in again")}
        onAction={sessionEnded ? reauthenticate : login}
      />
    );
  }

  if (!ACTIVE_ACCOUNT_STATUSES.has(accountStatus)) {
    const suspended = accountStatus === "suspended" || authorizationIssue?.code === "ACCOUNT_SUSPENDED";
    return (
      <StatePanel
        icon="block"
        title={suspended ? t("账户已被封禁", "Account suspended") : t("账户当前不可用", "Account unavailable")}
        message={suspended
          ? t(
            "此账户目前无法使用服务。如认为这是误操作，请联系支持人员；账户恢复后可重新检查。",
            "This account cannot currently use the service. Contact support if this is unexpected, then check again after access is restored.",
          )
          : authorizationError || t(
            `账户状态为 ${accountStatus || "unknown"}，请联系支持人员。`,
            `Your account status is ${accountStatus || "unknown"}. Please contact support.`,
          )}
        actionLabel={t("重新检查", "Check again")}
        onAction={() => refreshProfile()}
        secondaryActionLabel={t("退出登录", "Sign out")}
        onSecondaryAction={logout}
      />
    );
  }

  if (!allowedRoles.includes(role)) {
    return (
      <StatePanel
        icon="lock"
        title="403"
        message={t(
          "你没有访问此页面的权限。权限由服务器数据库决定；如角色刚刚变更，请重新登录。",
          "You do not have access to this page. Roles are server-controlled; sign in again after a role change.",
        )}
        actionLabel={t("返回工作台", "Back to dashboard")}
        onAction={() => navigate("/ai", { replace: true })}
      />
    );
  }

  return children || <Outlet />;
};

export default RoleGuard;
