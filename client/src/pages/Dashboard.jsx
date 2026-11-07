import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import AssetPreviewModal from "../components/AssetPreviewModal";

const readTheme = () => {
  if (typeof window === "undefined") return "night";
  return window.localStorage.getItem("stardraw_theme") === "day" ? "day" : "night";
};

const dashboardThemes = {
  night: {
    text: "#dfe2eb",
    muted: "#c2c7d0",
    faint: "#8f9095",
    primary: "#ee9d47",
    primaryText: "#2b1708",
    primarySoft: "rgba(238,157,71,0.14)",
    primaryLine: "rgba(238,157,71,0.28)",
    gold: "#e9c349",
    goldSoft: "rgba(233,195,73,0.12)",
    danger: "#ffb4ab",
    card: "#181c22",
    cardAlt: "#262a31",
    inset: "#0a0e14",
    buttonAlt: "#31353c",
    line: "rgba(69,71,75,0.14)",
    lineSoft: "rgba(69,71,75,0.1)",
    shadow: "none",
    heroMutedOpacity: 0.7,
    heroAccent: "#ee9d47",
    imageGlow: "linear-gradient(135deg, rgba(238,157,71,0.10) 0%, transparent 70%)",
    videoGlow: "linear-gradient(135deg, rgba(233,195,73,0.06) 0%, transparent 70%)",
    digitalHumanGlow: "linear-gradient(135deg, rgba(238,157,71,0.09) 0%, rgba(233,195,73,0.05) 72%, transparent 100%)",
    canvasGlow: "linear-gradient(135deg, rgba(238,157,71,0.09) 0%, rgba(233,195,73,0.05) 55%, transparent 100%)",
    badgeBg: "rgba(16,20,26,0.82)",
    expiredBg: "rgba(10,14,20,0.72)",
  },
  day: {
    text: "#171717",
    muted: "#5a6270",
    faint: "#818997",
    primary: "#c56b23",
    primaryText: "#fffaf2",
    primarySoft: "rgba(197,107,35,0.12)",
    primaryLine: "rgba(197,107,35,0.22)",
    gold: "#9a6a00",
    goldSoft: "rgba(154,106,0,0.1)",
    danger: "#b42318",
    card: "#ffffff",
    cardAlt: "#f7f2e9",
    inset: "#f1eee7",
    buttonAlt: "#ede8df",
    line: "rgba(30,34,42,0.12)",
    lineSoft: "rgba(30,34,42,0.08)",
    shadow: "0 18px 48px rgba(30,34,42,0.08)",
    heroMutedOpacity: 0.86,
    heroAccent: "#c56b23",
    imageGlow: "linear-gradient(135deg, rgba(197,107,35,0.13) 0%, rgba(197,107,35,0) 68%)",
    videoGlow: "linear-gradient(135deg, rgba(154,106,0,0.12) 0%, rgba(154,106,0,0) 70%)",
    digitalHumanGlow: "linear-gradient(135deg, rgba(197,107,35,0.11) 0%, rgba(154,106,0,0.08) 72%, transparent 100%)",
    canvasGlow: "linear-gradient(135deg, rgba(197,107,35,0.11) 0%, rgba(154,106,0,0.08) 55%, transparent 100%)",
    badgeBg: "rgba(255,255,255,0.86)",
    expiredBg: "rgba(247,245,240,0.78)",
  },
};

const getStatusConfig = (isZh, ui) => ({
  completed: { label: isZh ? "完成" : "COMPLETE", color: ui.primary, dot: ui.primary },
  running: { label: isZh ? "处理中" : "PROCESSING", color: ui.gold, dot: ui.gold, pulse: true },
  pending: { label: isZh ? "排队中" : "QUEUED", color: ui.faint, dot: ui.faint, pulse: true },
  failed: { label: isZh ? "失败" : "FAILED", color: ui.danger, dot: ui.danger },
});

const CreationCard = ({ item, onDownload, onPreview, isZh, t, ui }) => {
  const statusConfig = getStatusConfig(isZh, ui);
  const cfg = statusConfig[item.status] || statusConfig.completed;
  const isExpired = item.expires_at && new Date(item.expires_at) < new Date();
  const canDownload = item.status === "completed" && !isExpired;
  const isCompletedVideo = item.type === "video" && item.status === "completed";
  const previewVideoUrl = item.preview_video_url || (isCompletedVideo ? item.content : null);
  const imagePreviewUrl =
    item.reference_preview_url ||
    item.preview_image_url ||
    item.thumbnail_url ||
    (item.type === "image" ? item.content : null);
  const canPreview = Boolean(canDownload && (previewVideoUrl || imagePreviewUrl));

  return (
    <div className="group">
      <div className="aspect-[4/3] rounded-2xl overflow-hidden mb-4 relative"
        style={{ background: ui.inset, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <button
          type="button"
          disabled={!canPreview}
          onClick={() => canPreview && onPreview(item)}
          aria-label={canPreview ? t("放大预览", "Open preview") : undefined}
          className={`absolute inset-0 h-full w-full text-left ${canPreview ? "cursor-zoom-in" : "cursor-default"}`}
        >
          {isCompletedVideo && previewVideoUrl
            ? <OssVideo
                key={previewVideoUrl}
                src={previewVideoUrl}
                poster={item.preview_image_url || item.thumbnail_url || item.reference_preview_url || undefined}
                autoPlay
                loop
                muted
                playsInline
                preload="metadata"
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
              />
            : imagePreviewUrl
              ? <OssImage
                  src={imagePreviewUrl}
                  alt={item.scene_name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-700"
                />
              : <div className="w-full h-full flex items-center justify-center">
                  <span className="material-symbols-outlined text-4xl" style={{ color: ui.faint }}>
                    {item.type === "video" ? "movie_filter" : "auto_awesome"}
                  </span>
                </div>
          }
          {canPreview && (
            <span
              className="absolute bottom-3 left-1/2 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100"
              style={{ background: ui.badgeBg, border: `1px solid ${ui.line}`, color: ui.text }}
            >
              <span className="material-symbols-outlined text-[18px]">zoom_in</span>
            </span>
          )}
        </button>
        {/* Status badge */}
        <div className="pointer-events-none absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold"
          style={{ background: ui.badgeBg, backdropFilter: "blur(12px)", color: cfg.color, border: `1px solid ${ui.line}` }}>
          <span className={`w-1.5 h-1.5 rounded-full ${cfg.pulse ? "animate-pulse" : ""}`}
            style={{ background: cfg.dot }} />
          {cfg.label}
        </div>
        {/* Expired overlay */}
        {isExpired && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl"
            style={{ background: ui.expiredBg }}>
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("已过期", "Expired")}</span>
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate font-bold text-sm"
          style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
          {item.scene_name || t("生成任务", "Generation")}
        </h4>
        {canDownload && (
          <button
            type="button"
            onClick={() => onDownload(item.id)}
            aria-label={t("下载作品", "Download creation")}
            title={t("下载", "Download")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-opacity hover:opacity-75"
            style={{ background: ui.inset, border: `1px solid ${ui.line}`, color: ui.muted }}
          >
            <span className="material-symbols-outlined text-[17px]">download</span>
          </button>
        )}
      </div>
      <p className="text-[11px] mt-1 flex items-center gap-1" style={{ color: ui.muted, opacity: 0.78 }}>
        <span className="capitalize">{item.type === "video" ? t("视频", "video") : t("图片", "image")}</span>
        <span>•</span>
        <span>{new Date(item.created_at).toLocaleDateString("zh-CN")}</span>
        {item.points_cost > 0 && <><span>•</span><span>{item.points_cost} pts</span></>}
      </p>
    </div>
  );
};

const Dashboard = () => {
  const navigate   = useNavigate();
  const { user }   = useAuthing();
  const { t, isZh } = useLanguage();
  const authAxios  = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();

  const [account,   setAccount]   = useState(null);
  const [creations, setCreations] = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [previewItem, setPreviewItem] = useState(null);
  const [theme, setTheme] = useState(readTheme);
  const ui = dashboardThemes[theme] || dashboardThemes.night;

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncTheme = (event) => {
      setTheme(event?.detail?.theme === "day" || readTheme() === "day" ? "day" : "night");
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

  const syncPendingVideos = useCallback(async (list) => {
    const targets = list.filter((item) =>
      item.type === "video" && (item.status === "pending" || item.status === "running")
    );
    if (targets.length === 0) return;

    const results = await Promise.allSettled(
      targets.map((item) => authAxios.get(`/api/ai/video-status/${item.id}`))
    );

    const updatesById = new Map();
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const payload = result.value?.data || {};
      if (!payload?.status) return;

      const target = targets[index];
      const idKey = String(payload.creation_id ?? target.id);
      updatesById.set(idKey, {
        status: payload.status,
        provider_status: payload.provider_status ?? target.provider_status,
        content: payload.content ?? target.content,
        thumbnail_url: payload.thumbnail_url ?? target.thumbnail_url,
        error_message: payload.error_message ?? target.error_message,
        expires_at: payload.expires_at ?? target.expires_at,
        points_reserved: payload.points_reserved ?? target.points_reserved,
        points_cost: payload.points_charged ?? target.points_cost,
        preview_video_url: payload.status === "completed" && payload.content
          ? payload.content
          : target.preview_video_url,
        preview_image_url: payload.thumbnail_url ?? target.preview_image_url,
      });
    });

    if (updatesById.size === 0) return;

    setCreations((prev) => prev.map((item) => {
      const patch = updatesById.get(String(item.id));
      return patch ? { ...item, ...patch } : item;
    }));
  }, [authAxios]);

  useEffect(() => {
    Promise.all([
      authAxios.get("/api/points/balance"),
      authAxios.get("/api/user/get-user-creations?page_size=8"),
    ]).then(([balRes, crRes]) => {
      const recentCreations = crRes.data?.creations || [];
      setAccount(balRes.data?.data);
      setCreations(recentCreations);
      void syncPendingVideos(recentCreations);
    }).catch(console.error).finally(() => setLoading(false));
  }, [authAxios, syncPendingVideos]);

  useEffect(() => {
    const hasPendingVideos = creations.some((item) =>
      item.type === "video" && (item.status === "pending" || item.status === "running")
    );
    if (!hasPendingVideos) return;

    const timer = setInterval(() => {
      void syncPendingVideos(creations);
    }, 8000);

    return () => clearInterval(timer);
  }, [creations, syncPendingVideos]);

  const handleDownload = async (id) => {
    try {
      const { data } = await authAxios.get(`/api/user/creations/${id}/download`);
      if (data?.data?.download_url) {
        const downloadUrl = await resolvePrivateUrl(data.data.download_url);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = `creation_${id}`;
        a.click();
      }
    } catch (e) { console.error(e); }
  };

  return (
    <div className="p-10 max-w-[1400px] mx-auto">
      {/* Hero greeting */}
      <section className="mb-14">
        <h2 className="text-[2.6rem] font-extrabold leading-tight mb-3"
          style={{ color: ui.text, fontFamily: "Manrope, sans-serif", letterSpacing: "-0.02em" }}>
          {isZh ? `欢迎回来${user?.name ? `，${user.name.split(" ")[0]}` : ""}。` : `Welcome back${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.`}<br />
          <span style={{ color: ui.heroAccent }}>{t("准备开始创作爆款内容了吗？", "Ready to create trending content?")}</span>
        </h2>
        <p className="text-lg max-w-xl" style={{ color: ui.muted, opacity: ui.heroMutedOpacity }}>
          {t("为你的数字创意搭建生产工作流。选择一个方向，开始下一次生成。", "Architecture for your digital imagination. Choose a foundation to begin your next generation.")}
        </p>
      </section>

      {/* Account stats */}
      {account && (
        <div className="grid grid-cols-3 gap-4 mb-14">
          {[
            { label: t("可用积分", "Available Points"), value: account.available_points ?? 0,  icon: "bolt", color: ui.primary },
            { label: t("冻结积分", "Held Points"), value: account.held_points ?? 0, icon: "lock_clock", color: ui.gold },
            { label: t("会员等级", "Membership"), value: isZh ? ((account.membership_tier || "free") === "free" ? "免费" : (account.membership_tier || "").toUpperCase()) : (account.membership_tier || "free").toUpperCase(), icon: "workspace_premium", color: ui.muted },
          ].map(({ label, value, icon, color }) => (
            <div key={label} className="rounded-2xl p-5 flex items-center gap-4"
              style={{ background: ui.card, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: ui.inset, border: `1px solid ${ui.line}` }}>
                <span className="material-symbols-outlined text-xl" style={{ color }}>{icon}</span>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-widest font-semibold mb-0.5" style={{ color: ui.faint }}>{label}</p>
                <p className="text-lg font-bold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quick access bento */}
      <section className="grid grid-cols-12 gap-5 mb-14">
        {/* AI Image card */}
        <div className="col-span-12 lg:col-span-7 group relative overflow-hidden rounded-3xl cursor-pointer transition-all duration-500"
          style={{ background: ui.card, border: `1px solid ${ui.lineSoft}`, boxShadow: ui.shadow }}
          onClick={() => navigate("/ai/scene-image")}>
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ background: ui.imageGlow }} />
          <div className="flex items-center p-8 gap-8">
            <div className="w-20 h-20 flex-shrink-0 rounded-full flex items-center justify-center"
              style={{ background: ui.inset, border: `1px solid ${ui.line}` }}>
              <span className="material-symbols-outlined text-5xl" style={{ color: ui.primary }}>auto_awesome</span>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("AI 图片生成", "AI Image Generation")}
              </h3>
              <p className="text-sm mb-6 leading-relaxed" style={{ color: ui.muted, opacity: 0.82 }}>
                {t("用高质量模型快速生成电商视觉素材与场景图。", "Synthesize ultra-high resolution e-commerce visuals with neural architecture models.")}
              </p>
              <button className="liquid-metal px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-transform hover:scale-105 active:scale-95"
                style={{ color: "#002388", fontFamily: "Manrope, sans-serif" }}>
                {t("开始生成", "Start Drafting")}
                <span className="material-symbols-outlined text-sm">arrow_forward</span>
              </button>
            </div>
          </div>
        </div>

        {/* AI Video card */}
        <div className="col-span-12 lg:col-span-5 group relative overflow-hidden rounded-3xl cursor-pointer transition-all duration-500"
          style={{ background: ui.cardAlt, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}
          onClick={() => navigate("/ai/ai-video")}>
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ background: ui.videoGlow }} />
          <div className="flex items-center p-8 gap-6">
            <div className="w-20 h-20 flex-shrink-0 rounded-full flex items-center justify-center"
              style={{ background: ui.inset, border: `1px solid ${ui.line}` }}>
              <span className="material-symbols-outlined text-5xl" style={{ color: ui.gold }}>movie_filter</span>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("AI 视频", "AI Video")}
              </h3>
              <p className="text-sm mb-6" style={{ color: ui.muted, opacity: 0.82 }}>
                {t("电影感 AI 动态视频生成。", "Cinematic AI motion synthesis.")}
              </p>
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-all hover:border-opacity-60 active:scale-95"
                style={{ background: ui.buttonAlt, color: ui.text, border: `1px solid ${ui.line}`, fontFamily: "Manrope, sans-serif" }}>
                {t("创建视频", "New Motion")}
                <span className="material-symbols-outlined text-sm">add</span>
              </button>
            </div>
          </div>
        </div>

        {/* Digital Human card */}
        <div className="col-span-12 lg:col-span-5 group relative overflow-hidden rounded-3xl cursor-pointer transition-all duration-500"
          style={{ background: ui.cardAlt, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}
          onClick={() => navigate("/ai/digital-human")}>
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ background: ui.digitalHumanGlow }} />
          <div className="flex items-center p-8 gap-6">
            <div className="w-20 h-20 flex-shrink-0 rounded-full flex items-center justify-center"
              style={{ background: ui.inset, border: `1px solid ${ui.line}` }}>
              <span className="material-symbols-outlined text-5xl" style={{ color: ui.primary }}>co_present</span>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("数字人视频", "Digital Human")}
              </h3>
              <p className="text-sm mb-6" style={{ color: ui.muted, opacity: 0.82 }}>
                {t("输入主题，生成可下载的数字人讲解视频。", "Create downloadable presenter videos from a topic.")}
              </p>
              <button className="px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-all hover:border-opacity-60 active:scale-95"
                style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.primaryLine}`, fontFamily: "Manrope, sans-serif" }}>
                {t("生成数字人", "Create Presenter")}
                <span className="material-symbols-outlined text-sm">record_voice_over</span>
              </button>
            </div>
          </div>
        </div>

        <div
          className="col-span-12 lg:col-span-7 group relative overflow-hidden rounded-3xl cursor-pointer transition-all duration-500"
          style={{ background: ui.card, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}
          onClick={() => navigate("/ai/canvas")}
        >
          <div
            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
            style={{ background: ui.canvasGlow }}
          />
          <div className="flex flex-col lg:flex-row lg:items-center gap-6 p-8">
            <div className="w-20 h-20 flex-shrink-0 rounded-full flex items-center justify-center"
              style={{ background: ui.inset, border: `1px solid ${ui.line}` }}>
              <span className="material-symbols-outlined text-5xl" style={{ color: ui.primary }}>gesture</span>
            </div>
            <div className="flex-1">
              <h3 className="text-2xl font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
                {t("工作流画布", "Workflow Canvas")}
              </h3>
              <p className="text-sm mb-6 max-w-3xl" style={{ color: ui.muted, opacity: 0.82 }}>
                {t("把历史里的图片、视频和创意便签拖进一个无限空间，自由排版镜头、构图、卖点和提示词。", "Pull images, videos, and idea notes into one endless space to compose shots, layouts, selling points, and prompts.")}
              </p>
              <button
                className="px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 transition-all hover:border-opacity-60 active:scale-95"
                style={{ background: ui.primarySoft, color: ui.primary, border: `1px solid ${ui.primaryLine}`, fontFamily: "Manrope, sans-serif" }}
              >
                {t("打开画布", "Open Canvas")}
                <span className="material-symbols-outlined text-sm">open_in_new</span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Recent creations */}
      <section>
        <div className="flex items-end justify-between mb-8 px-1">
          <div>
            <h3 className="text-2xl font-bold" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>
              {t("最近作品", "Recent Creations")}
            </h3>
            <p className="text-[10px] uppercase tracking-widest mt-1" style={{ color: ui.faint, opacity: 0.72 }}>
              {t("归档 · 最新提交", "Archive — Latest Submissions")}
            </p>
          </div>
          <button onClick={() => navigate("/ai/history")}
            className="text-sm font-semibold flex items-center gap-1 transition-opacity hover:opacity-80"
            style={{ color: ui.primary, fontFamily: "Manrope, sans-serif" }}>
            {t("查看全部历史", "View All History")}
            <span className="material-symbols-outlined text-sm">open_in_new</span>
          </button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <div
              className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
              style={{ borderColor: ui.primary, borderTopColor: "transparent" }}
            />
          </div>
        ) : creations.length === 0 ? (
          <div className="text-center py-20 rounded-2xl" style={{ background: ui.card, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
            <span className="material-symbols-outlined text-5xl mb-4 block" style={{ color: ui.faint }}>image_not_supported</span>
            <p className="font-bold mb-2" style={{ color: ui.text, fontFamily: "Manrope, sans-serif" }}>{t("还没有作品", "No creations yet")}</p>
            <p className="text-sm mb-6" style={{ color: ui.faint }}>{t("先生成你的第一张 AI 图片或视频", "Generate your first AI image or video")}</p>
            <button onClick={() => navigate("/ai/scene-image")}
              className="liquid-metal px-6 py-2.5 rounded-xl font-bold text-sm"
              style={{ color: "#002388", fontFamily: "Manrope, sans-serif" }}>
              {t("立即开始", "Start Creating")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {creations.map(item => (
              <CreationCard
                key={item.id}
                item={item}
                onDownload={handleDownload}
                onPreview={setPreviewItem}
                isZh={isZh}
                t={t}
                ui={ui}
              />
            ))}
          </div>
        )}
      </section>

      {previewItem && (
        <AssetPreviewModal item={previewItem} onClose={() => setPreviewItem(null)} ui={ui} />
      )}

      {/* Footer */}
      <footer className="mt-20 pt-8 flex justify-between items-center"
        style={{ borderTop: `1px solid ${ui.lineSoft}`, opacity: 0.72 }}>
        <p className="text-[10px]" style={{ color: ui.muted }}>© 2026 StarDraw. {t("由 StarDraw 团队构建。", "Built by the StarDraw team.")}</p>
        <div className="flex gap-6">
          <a href="https://t.me/quickai_support" target="_blank" rel="noreferrer"
            className="text-[10px] hover:underline transition-colors"
            style={{ color: ui.muted }}>{t("联系", "Contact")}</a>
          <a href="mailto:support@quickai.com"
            className="text-[10px] hover:underline transition-colors"
            style={{ color: ui.muted }}>{t("邮件支持", "Email Support")}</a>
        </div>
      </footer>
    </div>
  );
};

export default Dashboard;
