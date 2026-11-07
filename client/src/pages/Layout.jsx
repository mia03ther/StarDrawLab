import { Outlet, useLocation, useNavigate, NavLink } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import { Bell } from "lucide-react";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import useAuthAxios from "../hooks/useAuthAxios";
import LanguageSwitch from "../components/LanguageSwitch";
import { OssImage } from "../components/OssMedia";
import { shouldStartAutomaticLogin } from "../utils/authSessionFlow";
import AnnouncementPrompt from "../components/AnnouncementPrompt";
import { useAnnouncementInbox } from "../hooks/useAnnouncementInbox";

const getNavItems = (isZh) => [
  { to: "/ai", label: isZh ? "总览" : "Dashboard", icon: "dashboard" },
  { to: "/home", label: isZh ? "主 Agent" : "Main Agent", icon: "smart_toy" },
  { to: "/ai/scene-image", label: isZh ? "AI 图片" : "AI Image", icon: "auto_awesome" },
  { to: "/ai/ai-video", label: isZh ? "AI 视频" : "AI Video", icon: "movie_filter" },
  { to: "/ai/digital-human", label: isZh ? "数字人" : "Digital Human", icon: "co_present" },
  { to: "/ai/digital-human-roles", label: isZh ? "角色库" : "Roles", icon: "recent_actors" },
  { to: "/ai/canvas", label: isZh ? "工作流画布" : "Workflow Canvas", icon: "account_tree" },
  { to: "/ai/templates", label: isZh ? "模板市场" : "Template Market", icon: "grid_view" },
  { to: "/ai/history", label: isZh ? "历史记录" : "History", icon: "history" },
  ...(import.meta.env.VITE_FEATURE_TASK_CENTER === "true"
    ? [{ to: "/ai/tasks", label: isZh ? "任务中心" : "Task Center", icon: "pending_actions" }]
    : []),
  { to: "/ai/billing", label: isZh ? "积分与会员" : "Points & Membership", icon: "payments" },
  { to: "/ai/recycle-bin", label: isZh ? "回收站" : "Recycle Bin", icon: "restore_from_trash" },
  { to: "/ai/mcp", label: isZh ? "MCP 连接" : "MCP Connections", icon: "hub" },
  { to: "/ai/invitations", label: isZh ? "邀请奖励" : "Invitations", icon: "card_giftcard" },
];

const getAdminNavItems = (isZh, isRoot) => {
  const commonItems = [
    { to: "/ai/admin/users", label: isZh ? "用户运营" : "User Operations", icon: "manage_accounts" },
    { to: "/ai/admin/template-review", label: isZh ? "模板管理" : "Template Management", icon: "fact_check" },
    { to: "/ai/admin/subscriptions", label: isZh ? "积分与会员" : "Points & Membership", icon: "workspace_premium" },
    { to: "/ai/admin/pricing", label: isZh ? "生成定价" : "Generation Pricing", icon: "price_change" },
    { to: "/ai/admin/recycle-bin", label: isZh ? "管理回收站" : "Admin Recycle Bin", icon: "delete_sweep" },
    { to: "/ai/admin/mcp", label: isZh ? "MCP 工具" : "MCP Tools", icon: "hub" },
    { to: "/ai/admin/visual-parameters", label: isZh ? "视觉参数" : "Visual Parameters", icon: "tune" },
    { to: "/ai/admin/agent-skills", label: isZh ? "Agent Skills" : "Agent Skills", icon: "menu_book" },
    { to: "/ai/admin/invitations", label: isZh ? "邀请系统" : "Invitations", icon: "card_giftcard" },
    { to: "/ai/admin/announcements", label: isZh ? "公告管理" : "Announcements", icon: "campaign" },
  ];

  if (!isRoot) return commonItems;

  return [
    ...commonItems,
    { to: "/ai/admin/roles", label: isZh ? "角色管理" : "Role Management", icon: "admin_panel_settings", rootOnly: true },
    { to: "/ai/admin/models", label: isZh ? "模型展示" : "Model Catalog", icon: "view_list", rootOnly: true },
    { to: "/ai/admin/model-routing", label: isZh ? "模型路由" : "Model Routing", icon: "route", rootOnly: true },
    { to: "/ai/admin/audit-logs", label: isZh ? "审计日志" : "Audit Logs", icon: "policy", rootOnly: true },
    { to: "/ai/admin/usage-analytics", label: isZh ? "使用分析" : "Usage Analytics", icon: "analytics", rootOnly: true },
    { to: "/ai/admin/private-content-review", label: isZh ? "紧急内容审查" : "Private Review", icon: "visibility_lock", rootOnly: true },
  ];
};

const getMenuItems = (t) => [
  { key: "account", label: t("个人中心", "Account Center"), desc: t("编辑资料、头像与查看最近作品", "Edit profile, avatar, and recent outputs"), icon: "person", to: "/ai/account" },
  { key: "history", label: t("历史记录", "History"), desc: t("查看图片与视频生成记录", "View image and video generations"), icon: "history", to: "/ai/history" },
  { key: "billing", label: t("积分与会员", "Points & Membership"), desc: t("购买积分包、管理会员并查看明细", "Buy point packages, manage membership, and view activity"), icon: "payments", to: "/ai/billing" },
];

const getStoredTheme = () => {
  if (typeof window === "undefined") return "night";
  return window.localStorage.getItem("stardraw_theme") === "day" ? "day" : "night";
};

const layoutThemes = {
  night: {
    page: "#10141a",
    canvasPage: "#0a0e14",
    sidebar: "#181c22",
    sidebarAlt: "#0a0e14",
    surface: "#181c22",
    surfaceAlt: "#0a0e14",
    surfaceHigh: "#262a31",
    header: "rgba(16,20,26,0.82)",
    headerBorder: "rgba(69,71,75,0.18)",
    text: "#dfe2eb",
    muted: "#c2c7d0",
    faint: "#8f9095",
    line: "rgba(69,71,75,0.18)",
    lineStrong: "rgba(69,71,75,0.32)",
    primary: "#ee9d47",
    primarySoft: "rgba(238,157,71,0.14)",
    primaryText: "#2b1708",
    gold: "#e9c349",
    danger: "#ffb4ab",
    navActiveBg: "#1c2026",
    navHoverBg: "#1c2026",
    menuBg: "rgba(24,28,34,0.98)",
    shadow: "0 20px 48px rgba(0,0,0,0.34)",
  },
  day: {
    page: "#f7f5f0",
    canvasPage: "#fbfaf8",
    sidebar: "#ffffff",
    sidebarAlt: "#f2efe8",
    surface: "#ffffff",
    surfaceAlt: "#f4f1ea",
    surfaceHigh: "#e9e4da",
    header: "rgba(247,245,240,0.84)",
    headerBorder: "rgba(30,34,42,0.1)",
    text: "#171717",
    muted: "#525866",
    faint: "#818792",
    line: "rgba(30,34,42,0.12)",
    lineStrong: "rgba(30,34,42,0.22)",
    primary: "#c56b23",
    primarySoft: "rgba(197,107,35,0.12)",
    primaryText: "#fffaf2",
    gold: "#9a6a00",
    danger: "#b42318",
    navActiveBg: "#ece8df",
    navHoverBg: "#f2efe8",
    menuBg: "rgba(255,255,255,0.98)",
    shadow: "0 22px 54px rgba(30,34,42,0.14)",
  },
};

const normalizeTheme = (value) => (value === "day" ? "day" : "night");

const UserMenu = ({ user, balance, role, isZh, t, onNavigate, onLogout, pathname, ui }) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const initials = user?.name?.[0]?.toUpperCase() || "U";
  const menuItems = getMenuItems(t);

  return (
    <div ref={menuRef} className="relative">
      {open && (
        <div className="absolute left-0 right-0 bottom-full mb-3 rounded-3xl p-3"
          style={{
            background: ui.menuBg,
            border: `1px solid ${ui.lineStrong}`,
            boxShadow: ui.shadow,
            backdropFilter: "blur(18px)",
          }}>
          <div className="rounded-2xl px-4 py-3 mb-3"
            style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: ui.faint }}>
              {t("当前账户", "Current Account")}
            </p>
            <p className="font-bold text-sm truncate" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
              {user?.name || (isZh ? "用户" : "User")}
            </p>
            <p className="text-[11px] truncate mt-1" style={{ color: ui.faint }}>
              {user?.email || t("暂无邮箱信息", "No email available")}
            </p>
            <span
              className="mt-2 inline-flex rounded-full px-2 py-1 text-[9px] font-black uppercase tracking-widest"
              style={{ background: ui.primarySoft, color: ui.primary }}
            >
              {role || "user"}
            </span>
          </div>

          <div className="space-y-2">
            {menuItems.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onNavigate(item.to);
                }}
                className="w-full text-left rounded-2xl px-4 py-3 transition-all"
                style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}
              >
                <div className="flex items-start gap-3">
                  <span className="material-symbols-outlined text-[20px] mt-0.5" style={{ color: ui.primary }}>{item.icon}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{item.label}</p>
                    <p className="text-[11px] mt-1" style={{ color: ui.faint, lineHeight: 1.5 }}>{item.desc}</p>
                  </div>
                </div>
              </button>
            ))}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
              className="w-full text-left rounded-2xl px-4 py-3 transition-all"
              style={{ background: "rgba(255,180,171,0.1)", border: "1px solid rgba(255,180,171,0.2)" }}
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-[20px]" style={{ color: ui.danger }}>logout</span>
                <div>
                  <p className="text-sm font-bold" style={{ color: ui.danger, fontFamily: "Manrope, sans-serif" }}>
                    {t("退出登录", "Sign Out")}
                  </p>
                  <p className="text-[11px] mt-1" style={{ color: ui.faint }}>
                    {t("安全退出当前账号", "Securely leave the current session")}
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="w-full rounded-3xl px-3 py-3 text-left transition-all"
        style={{ background: ui.surfaceAlt, border: `1px solid ${open ? ui.primary : ui.line}` }}
      >
        <div className="flex items-center gap-3">
          {user?.imageUrl ? (
            <OssImage
              src={user.imageUrl}
              alt=""
              className="w-11 h-11 rounded-2xl object-cover flex-shrink-0"
              style={{ border: `1px solid ${ui.lineStrong}` }}
            />
          ) : (
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center text-sm font-black flex-shrink-0"
              style={{ background: ui.surfaceHigh, color: ui.primary, border: `1px solid ${ui.lineStrong}` }}
            >
              {initials}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-widest mb-1" style={{ color: ui.faint }}>
              {t("个人中心", "Account Center")}
            </p>
            <p className="text-sm font-bold truncate" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
              {user?.name || (isZh ? "用户" : "User")}
            </p>
            <p className="text-[11px] truncate mt-1" style={{ color: ui.faint }}>
              {balance ?? "—"} {t("积分", "pts")}
            </p>
          </div>
          <span className="material-symbols-outlined text-[18px]" style={{ color: open ? ui.primary : ui.faint }}>
            {open ? "keyboard_arrow_down" : "keyboard_arrow_up"}
          </span>
        </div>
      </button>
    </div>
  );
};

const Sidebar = ({ user, balance, logout, role, isAdmin, isRoot, authorizationLoading, isZh, t, pathname, onNavigate, ui }) => (
  <aside className="h-screen w-64 fixed left-0 top-0 flex flex-col z-50"
    style={{ background: ui.sidebar, borderRight: `1px solid ${ui.line}` }}>
    <div className="flex flex-col h-full py-6 px-4">
      <div className="mb-10 px-2 flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center"
          style={{ background: ui.primary }}>
          <span className="material-symbols-outlined filled text-sm"
            style={{ color: ui.primaryText }}>architecture</span>
        </div>
        <div>
          <h1 className="text-base font-bold tracking-tighter font-headline"
            style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
            StarDraw
          </h1>
          <p className="text-[9px] uppercase tracking-[0.18em] font-medium"
            style={{ color: ui.muted, opacity: 0.65 }}>
            {isZh ? "数字内容架构台" : "The Digital Architect"}
          </p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto pr-1">
        {getNavItems(isZh).map(({ to, label, icon }) => (
          <NavLink key={to} to={to} end={to === "/ai"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-4 py-3 rounded-xl mx-1 transition-all duration-200 text-sm font-bold cursor-pointer select-none
               ${isActive ? "scale-[0.97]" : ""}`
            }
            style={({ isActive }) => ({
              fontFamily: "Manrope, sans-serif",
              color: isActive ? ui.primary : ui.muted,
              background: isActive ? ui.navActiveBg : "transparent",
            })}
          >
            {({ isActive }) => (<>
              <span className={`material-symbols-outlined ${isActive ? "filled" : ""}`}>{icon}</span>
              {label}
            </>)}
          </NavLink>
        ))}

        <button type="button"
          className="flex items-center gap-3 px-4 py-3 rounded-xl mx-1 text-sm font-bold cursor-default"
          style={{ color: ui.gold, fontFamily: "Manrope, sans-serif" }}
          aria-disabled="true">
          <span className="material-symbols-outlined">settings_suggest</span>
          {isZh ? "企业版" : "Enterprise"}
        </button>

        {!authorizationLoading && isAdmin && (
          <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${ui.line}` }}>
            <div className="mb-2 flex items-center justify-between px-4">
              <p className="text-[9px] font-black uppercase tracking-[0.2em]" style={{ color: ui.faint }}>
                {isRoot ? (isZh ? "ROOT 管理台" : "ROOT CONSOLE") : (isZh ? "管理员后台" : "ADMIN CONSOLE")}
              </p>
              <span className="material-symbols-outlined text-[15px]" style={{ color: ui.primary }}>verified_user</span>
            </div>
            <div className="space-y-1">
              {getAdminNavItems(isZh, isRoot).map(({ to, label, icon, rootOnly }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `flex items-center gap-3 rounded-xl px-4 py-2.5 text-xs font-bold transition-all ${isActive ? "scale-[0.97]" : ""}`}
                  style={({ isActive }) => ({
                    color: isActive ? ui.primary : ui.muted,
                    background: isActive ? ui.navActiveBg : "transparent",
                    fontFamily: "Manrope, sans-serif",
                  })}
                >
                  <span className="material-symbols-outlined text-[18px]">{icon}</span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {rootOnly && (
                    <span className="rounded px-1 py-0.5 text-[8px] font-black" style={{ background: ui.primarySoft, color: ui.primary }}>
                      ROOT
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className="mt-auto pt-5 space-y-3"
        style={{ borderTop: `1px solid ${ui.line}` }}>
        <div className="mx-2 flex items-center gap-2 px-3 py-2 rounded-xl"
          style={{ background: ui.surfaceAlt }}>
          <span className="material-symbols-outlined text-[18px]" style={{ color: ui.primary }}>bolt</span>
          <span className="text-xs font-bold uppercase tracking-widest"
            style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
            {balance ?? "—"} {t("积分", "pts")}
          </span>
        </div>

        <UserMenu
          user={user}
          balance={balance}
          role={role}
          isZh={isZh}
          t={t}
          pathname={pathname}
          onNavigate={onNavigate}
          onLogout={logout}
          ui={ui}
        />
      </div>
    </div>
  </aside>
);

const Layout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    isSignedIn,
    isLoading,
    user,
    login,
    logout,
    role,
    isAdmin,
    isRoot,
    authorizationLoading,
    isLoggingOut,
  } = useAuthing();
  const { isZh, t } = useLanguage();
  const authAxios = useAuthAxios();
  const [balance, setBalance] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState(getStoredTheme);
  const ui = layoutThemes[theme] || layoutThemes.night;
  const {
    items: announcementItems,
    unreadItems: unreadAnnouncementItems,
    promptOpen: announcementPromptOpen,
    setPromptOpen: setAnnouncementPromptOpen,
    markSeen: markAnnouncementsSeen,
  } = useAnnouncementInbox({ authAxios, userId: user?.id, isSignedIn });

  useEffect(() => {
    if (shouldStartAutomaticLogin({ isLoading, isSignedIn, isLoggingOut })) login();
  }, [isLoading, isSignedIn, isLoggingOut, login]);

  const refreshBalance = useCallback(() => {
    if (!isSignedIn) return;
    authAxios.get("/api/points/balance")
      .then((r) => setBalance(r.data?.data?.available_points ?? 0))
      .catch(() => {});
  }, [isSignedIn, authAxios]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handlePointsUpdated = () => refreshBalance();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refreshBalance();
    };

    window.addEventListener("stardraw:points-updated", handlePointsUpdated);
    window.addEventListener("focus", handlePointsUpdated);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("stardraw:points-updated", handlePointsUpdated);
      window.removeEventListener("focus", handlePointsUpdated);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshBalance]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const nextTheme = normalizeTheme(theme);
    window.localStorage.setItem("stardraw_theme", nextTheme);
    document.documentElement.dataset.stardrawTheme = nextTheme;
    window.dispatchEvent(new CustomEvent("stardraw:theme-change", { detail: { theme: nextTheme } }));
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncTheme = (event) => {
      const nextTheme = normalizeTheme(event?.detail?.theme || getStoredTheme());
      setTheme(nextTheme);
    };

    const handleStorage = (event) => {
      if (event.key === "stardraw_theme") syncTheme(event);
    };

    window.addEventListener("stardraw:theme-change", syncTheme);
    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("stardraw:theme-change", syncTheme);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  const handleSearchSubmit = (event) => {
    event.preventDefault();
    const query = searchQuery.trim();
    if (!query) return;
    navigate(`/ai/history?q=${encodeURIComponent(query)}`);
  };

  if (isLoading || !isSignedIn) {
    return (
      <div className="flex h-screen items-center justify-center" style={{ background: ui.page }}>
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin" style={{ borderColor: ui.primary, borderTopColor: "transparent" }} />
          <p className="text-sm" style={{ color: ui.muted }}>{t("正在加载 StarDraw…", "Loading StarDraw…")}</p>
        </div>
      </div>
    );
  }

  if (location.pathname === "/ai/canvas") {
    return (
      <div className="min-h-screen" style={{ background: ui.canvasPage }}>
        <Outlet />
        {announcementPromptOpen && <AnnouncementPrompt items={announcementItems} unreadCount={unreadAnnouncementItems.length} onDismiss={() => markAnnouncementsSeen()} />}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen" style={{ background: ui.page, color: ui.text }}>
      <Sidebar
        user={user}
        balance={balance}
        logout={logout}
        role={role}
        isAdmin={isAdmin}
        isRoot={isRoot}
        authorizationLoading={authorizationLoading}
        isZh={isZh}
        t={t}
        pathname={location.pathname}
        onNavigate={navigate}
        ui={ui}
      />

      <div className="ml-64 flex-1 flex flex-col min-h-screen">
        <header className="fixed top-0 right-0 h-16 z-40 flex items-center justify-between px-8 glass-nav"
          style={{
            width: "calc(100% - 16rem)",
            background: ui.header,
            borderBottom: `1px solid ${ui.headerBorder}`,
          }}>
          <form onSubmit={handleSearchSubmit} className="flex items-center gap-3 min-w-[240px]">
            <span className="material-symbols-outlined text-sm" style={{ color: ui.faint }}>search</span>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("搜索历史记录", "Search history")}
              className="w-64 bg-transparent outline-none text-sm"
              style={{ color: ui.muted, fontFamily: "Inter, sans-serif" }}
            />
          </form>
          <div className="flex items-center gap-6">
            <LanguageSwitch />
            <button
              type="button"
              onClick={() => setAnnouncementPromptOpen(true)}
              title={t("查看公告", "View announcements")}
              aria-label={t("查看公告", "View announcements")}
              className="relative rounded-xl p-2.5 transition-transform hover:scale-105"
              style={{ color: unreadAnnouncementItems.length > 0 ? ui.primary : ui.muted, background: ui.surface, border: `1px solid ${ui.lineStrong}` }}
            >
              <Bell size={17} />
              {unreadAnnouncementItems.length > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full px-1 text-center text-[10px] font-black" style={{ background: ui.primary, color: ui.primaryText }}>{unreadAnnouncementItems.length > 99 ? "99+" : unreadAnnouncementItems.length}</span>}
            </button>
            <button
              type="button"
              onClick={() => setTheme((prev) => (prev === "night" ? "day" : "night"))}
              className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-bold"
              style={{ background: ui.surface, color: ui.muted, border: `1px solid ${ui.lineStrong}` }}
              title={t("切换日夜主题", "Toggle day/night theme")}
            >
              <span className="material-symbols-outlined text-[16px]">{theme === "night" ? "dark_mode" : "light_mode"}</span>
              {theme === "night" ? t("夜间", "Night") : t("日间", "Day")}
            </button>
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]" style={{ color: ui.primary }}>bolt</span>
              <span className="text-sm font-bold uppercase tracking-widest"
                style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
                {balance ?? "—"} {t("剩余积分", "Remaining")}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {user?.imageUrl
                ? <OssImage src={user.imageUrl} alt="" className="w-8 h-8 rounded-full object-cover cursor-pointer"
                    style={{ border: `1px solid ${ui.lineStrong}` }}
                    onClick={() => navigate("/ai/account")} />
                : <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold cursor-pointer"
                    style={{ background: ui.surfaceHigh, color: ui.primary, border: `1px solid ${ui.lineStrong}` }}
                    onClick={() => navigate("/ai/account")}>
                    {user?.name?.[0]?.toUpperCase() || "U"}
                  </div>
              }
            </div>
          </div>
        </header>

        <main className="mt-16 flex-1">
          <Outlet />
        </main>
        {announcementPromptOpen && <AnnouncementPrompt items={announcementItems} unreadCount={unreadAnnouncementItems.length} onDismiss={() => markAnnouncementsSeen()} />}
      </div>
    </div>
  );
};

export default Layout;
