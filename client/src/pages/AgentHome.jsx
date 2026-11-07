import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowUpRight, Bell, Brush, Clapperboard, Coins, FolderOpen, Home,
  Image as ImageIcon, ImagePlus, LayoutGrid, Moon, PanelsTopLeft, Search, Sparkles, Sun, Video, X,
} from "lucide-react";
import { OssImage, OssVideo } from "../components/OssMedia";
import GlobalAgent from "./GlobalAgent";
import AnnouncementPrompt from "../components/AnnouncementPrompt";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAnnouncementInbox } from "../hooks/useAnnouncementInbox";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import {
  createReferenceAsset,
  getFullMediaUrl,
  getGridMediaUrl,
  REFERENCE_DRAG_MIME,
  serializeReferenceDragPayload,
} from "../utils/agentHomeMedia";
import "./AgentHome.css";

const PUBLIC_API = import.meta.env.VITE_BASE_URL || "";
const PENDING_AGENT_INSTRUCTION_KEY = "stardraw_pending_agent_instruction";
const publicRequest = axios.create({ baseURL: PUBLIC_API });

const getMediaUrl = getFullMediaUrl;

function RailLink({ href, label, active = false, children }) {
  return (
    <Link to={href} className={`agent-home-rail-link ${active ? "is-active" : ""}`} title={label} aria-label={label}>
      {children}
      <span>{label}</span>
    </Link>
  );
}

function CommunityTile({ item, onOpen, t }) {
  const mediaUrl = getGridMediaUrl(item);
  if (!mediaUrl) return null;
  const dragPayload = serializeReferenceDragPayload(item);
  return (
    <button
      type="button"
      draggable={Boolean(dragPayload)}
      onDragStart={(event) => {
        if (!dragPayload) return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(REFERENCE_DRAG_MIME, dragPayload);
        event.dataTransfer.setData("text/uri-list", getReferencePreviewUrlForDrag(item));
      }}
      className="agent-home-community-tile"
      title={t("拖动到 Agent 可作为参考图", "Drag to Agent to use as a reference")}
      onClick={() => onOpen?.(item)}
    >
      {item.type === "video"
        ? <OssVideo src={item.content} poster={item.thumbnail_url} authorize={false} muted playsInline preload="none" />
        : <OssImage src={mediaUrl} authorize={false} loading="lazy" decoding="async" alt={item.title || ""} />}
      <span className="agent-home-community-caption">
        <strong>{item.title || "StarDraw"}</strong>
        <small>{item.author?.name || t("StarDraw 创作者", "StarDraw creator")}</small>
      </span>
      {item.type === "video" && <span className="agent-home-media-type"><Video size={12} /></span>}
    </button>
  );
}

const getReferencePreviewUrlForDrag = (item) => createReferenceAsset(item)?.previewUrl || "";

function getTemplateHref(item) {
  if (item?.href) return item.href;
  const outputType = item?.outputType || item?.output_type || item?.type || "image";
  const sceneKey = item?.sceneKey || item?.scene_key;
  const templateId = item?.templateId || item?.template_id;
  const params = new URLSearchParams();
  if (sceneKey) params.set("template", String(sceneKey));
  if (templateId) params.set("template_id", String(templateId));
  return `/ai/${outputType === "video" ? "ai-video" : "scene-image"}${params.toString() ? `?${params.toString()}` : ""}`;
}

function InspirationPreview({ item, onClose, onUseTemplate, onUseReference, ui, t }) {
  const mediaUrl = getMediaUrl(item);
  const previewImage = item?.type === "video" ? item.thumbnail_url : mediaUrl;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  if (!mediaUrl) return null;
  return (
    <div
      className="agent-home-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("作品预览", "Work preview")}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="agent-home-preview-panel" style={{ background: ui.surface, borderColor: ui.lineStrong, boxShadow: ui.shadow }} onMouseDown={(event) => event.stopPropagation()}>
        <div className="agent-home-preview-media" style={{ background: ui.surfaceAlt }}>
          {item.type === "video"
            ? <OssVideo src={mediaUrl} poster={previewImage} authorize={false} controls autoPlay playsInline preload="metadata" />
            : <OssImage src={mediaUrl} authorize={false} loading="eager" fetchPriority="high" alt={item.title || t("作品", "Work")} />}
          <button type="button" className="agent-home-preview-close" onClick={onClose} aria-label={t("关闭预览", "Close preview")} title={t("关闭", "Close")} style={{ background: ui.surface, borderColor: ui.line, color: ui.text }}><X size={17} /></button>
        </div>
        <aside className="agent-home-preview-info" style={{ borderColor: ui.line }}>
          <div>
            <p className="agent-home-preview-eyebrow" style={{ color: ui.primary }}>{item.type === "video" ? t("视频作品", "VIDEO WORK") : t("图片作品", "IMAGE WORK")}</p>
            <h2 style={{ color: ui.text }}>{item.title || t("未命名作品", "Untitled work")}</h2>
            <p className="agent-home-preview-author" style={{ color: ui.faint }}>{item.author?.name || "StarDraw"}</p>
            {item.description && <p className="agent-home-preview-description" style={{ color: ui.muted }}>{item.description}</p>}
            {item.tags?.length > 0 && <div className="agent-home-preview-tags">{item.tags.slice(0, 8).map((tag) => <span key={tag} style={{ background: ui.surfaceAlt, borderColor: ui.line, color: ui.muted }}>{tag}</span>)}</div>}
          </div>
          <div className="agent-home-preview-actions">
            <button type="button" onClick={() => onUseTemplate(item)} style={{ background: ui.primary, color: ui.primaryText }}><ArrowUpRight size={15} />{t("用同款模板", "Use this template")}</button>
            {item.type === "image" && previewImage && <button type="button" onClick={() => onUseReference(item)} style={{ background: ui.primarySoft, borderColor: ui.line, color: ui.primary }}><ImagePlus size={15} />{t("用作参考图", "Use as reference")}</button>}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default function AgentHome() {
  const authAxios = useAuthAxios();
  const navigate = useNavigate();
  const { user } = useAuthing();
  const { t } = useLanguage();
  const { isDay, ui } = useStarDrawTheme();
  const { items: announcementItems, unreadItems, promptOpen, setPromptOpen, markSeen } = useAnnouncementInbox({
    authAxios,
    userId: user?.id,
    isSignedIn: Boolean(user),
  });
  const [balance, setBalance] = useState(null);
  const [community, setCommunity] = useState([]);
  const [featuredTemplates, setFeaturedTemplates] = useState([]);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateType, setTemplateType] = useState("all");
  const [agentDocked, setAgentDocked] = useState(false);
  const [agentDockExpanded, setAgentDockExpanded] = useState(false);
  const [agentShellPlaceholderHeight, setAgentShellPlaceholderHeight] = useState(0);
  const [previewItem, setPreviewItem] = useState(null);
  const [referenceAssets, setReferenceAssets] = useState([]);
  const [referenceAgentOpen, setReferenceAgentOpen] = useState(false);
  const agentShellRef = useRef(null);
  const [initialInstruction] = useState(() => window.localStorage.getItem(PENDING_AGENT_INSTRUCTION_KEY) || "");
  const consumeInitialInstruction = useCallback(() => {
    window.localStorage.removeItem(PENDING_AGENT_INSTRUCTION_KEY);
  }, []);

  const refreshBalance = useCallback(() => {
    authAxios.get("/api/points/balance", { params: { refresh: Date.now() } })
      .then(({ data }) => setBalance(data?.data?.available_points ?? 0))
      .catch(() => {});
  }, [authAxios]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  useEffect(() => {
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
    let active = true;
    const controller = new AbortController();
    const loadCommunity = async () => {
      let communityItems = [];
      try {
        const { data: feedData } = await publicRequest.get("/api/public/community/feed", {
          params: { sort: "featured", limit: 16 },
          signal: controller.signal,
          timeout: 8000,
        });
        communityItems = (feedData?.data?.items || []).filter((item) => getMediaUrl(item)).slice(0, 16);
      } catch (error) {
        if (error?.code === "ERR_CANCELED") return;
      }
      if (!active) return;
      setCommunity(communityItems);
      if (communityItems.length > 0) return;

      try {
        const { data: bootstrapData } = await publicRequest.get("/api/public/community/bootstrap", {
          signal: controller.signal,
          timeout: 8000,
        });
        const templates = (bootstrapData?.data?.templates || []).map((template) => ({
          id: `template-${template.id}`,
          type: template.preview_video_url ? "video" : "image",
          outputType: template.output_type || "image",
          sceneKey: template.scene_key || "",
          description: template.preview_description || "",
          tags: Array.isArray(template.tags) ? template.tags : [],
          templateId: String(template.id || ""),
          content: template.preview_video_url || template.preview_image_url,
          thumbnail_url: template.preview_image_url || "",
          title: template.preview_title || template.scene_name || t("官方精选模板", "Featured template"),
          author: { name: t("官方精选", "StarDraw picks") },
          href: (() => {
            const params = new URLSearchParams({ template: String(template.scene_key || "") });
            if (template.id) params.set("template_id", String(template.id));
            return `/ai/${template.output_type === "video" ? "ai-video" : "scene-image"}?${params.toString()}`;
          })(),
        })).filter((item) => getMediaUrl(item));
        if (active) setFeaturedTemplates(templates);
      } catch (error) {
        if (error?.code !== "ERR_CANCELED" && active) setFeaturedTemplates([]);
      }
    };
    void loadCommunity();
    return () => { active = false; controller.abort(); };
  }, [t]);

  useEffect(() => {
    const agentShell = agentShellRef.current;
    if (!agentShell || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      const docked = !entry.isIntersecting;
      if (docked) {
        const height = agentShell.getBoundingClientRect().height;
        if (height > 0) setAgentShellPlaceholderHeight(height);
      } else {
        setAgentShellPlaceholderHeight(0);
      }
      setAgentDocked(docked);
      if (!docked) setAgentDockExpanded(false);
    }, { rootMargin: "0px", threshold: [0, 0.01] });
    observer.observe(agentShell);
    return () => observer.disconnect();
  }, []);

  const inspirationItems = useMemo(() => (
    community.length > 0 ? community : featuredTemplates
  ), [community, featuredTemplates]);

  const visibleInspirations = useMemo(() => {
    const query = templateQuery.trim().toLowerCase();
    return inspirationItems.filter((item) => {
      const itemType = item.outputType || item.type;
      if (templateType !== "all" && itemType !== templateType) return false;
      if (!query) return true;
      return [item.title, item.description, item.sceneKey, ...(item.tags || [])]
        .filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [inspirationItems, templateQuery, templateType]);

  const openInspirationPreview = useCallback((item) => setPreviewItem(item), []);
  const useAsTemplate = useCallback((item) => {
    navigate(getTemplateHref(item));
  }, [navigate]);
  const attachReference = useCallback((asset) => {
    if (!asset?.previewUrl) return;
    setReferenceAssets((current) => {
      const existing = Array.isArray(current) ? current : [];
      const identity = String(asset.id || asset.uploadId || asset.creationId || asset.templateId || asset.previewUrl);
      const withoutDuplicate = existing.filter((item) => String(item?.id || item?.uploadId || item?.creationId || item?.templateId || item?.previewUrl) !== identity);
      if (withoutDuplicate.length >= 4) return withoutDuplicate;
      return [...withoutDuplicate, asset];
    });
    setReferenceAgentOpen(true);
    const height = agentShellRef.current?.getBoundingClientRect().height || 0;
    if (height > 0) setAgentShellPlaceholderHeight(height);
    setAgentDocked(true);
    setAgentDockExpanded(true);
    setPreviewItem(null);
  }, []);
  const useAsReference = useCallback((item) => {
    attachReference(createReferenceAsset(item));
  }, [attachReference]);
  const handleReferenceDrop = useCallback((value) => {
    attachReference(value);
  }, [attachReference]);
  const floatingAgent = agentDocked || referenceAgentOpen;
  const expandedAgent = agentDockExpanded || referenceAgentOpen;
  const handleDockExpandedChange = useCallback((expanded) => {
    setAgentDockExpanded(expanded);
    if (!expanded) setReferenceAgentOpen(false);
  }, []);

  const capabilities = useMemo(() => [
    { href: "/ai/scene-image", Icon: ImageIcon, title: t("生成视觉", "Create images"), detail: t("海报、商品图与风格探索", "Posters, products, and visual studies") },
    { href: "/ai/ai-video", Icon: Clapperboard, title: t("制作视频", "Create video"), detail: t("从创意到动态镜头", "From an idea to a moving shot") },
    { href: "/ai/templates", Icon: LayoutGrid, title: t("调用模板", "Use templates"), detail: t("从成熟方案快速开始", "Start from a proven creative setup") },
  ], [t]);

  const toggleTheme = () => {
    const nextTheme = isDay ? "night" : "day";
    window.localStorage.setItem("stardraw_theme", nextTheme);
    document.documentElement.dataset.stardrawTheme = nextTheme;
    window.dispatchEvent(new CustomEvent("stardraw:theme-change", { detail: { theme: nextTheme } }));
  };

  return (
    <div
      className={`agent-home-page ${isDay ? "is-day" : "is-night"}`}
      style={{
        background: ui.page,
        color: ui.text,
        "--sd-page": ui.page,
        "--sd-surface": ui.surface,
        "--sd-text": ui.text,
        "--sd-muted": ui.muted,
        "--sd-line": ui.line,
      }}
    >
      {promptOpen && <AnnouncementPrompt items={announcementItems} unreadCount={unreadItems.length} onDismiss={() => markSeen()} />}
      <aside className="agent-home-rail" style={{ background: ui.surface, borderColor: ui.line }}>
        <Link to="/" className="agent-home-rail-brand" title="StarDraw" aria-label="StarDraw"><Sparkles size={17} /></Link>
        <nav aria-label={t("创作导航", "Creative navigation")}>
          <RailLink href="/home" label={t("Agent 首页", "Agent home")} active><Home size={17} /></RailLink>
          <RailLink href="/ai/scene-image" label={t("图片生成", "Image")}><Brush size={17} /></RailLink>
          <RailLink href="/ai/ai-video" label={t("视频生成", "Video")}><Clapperboard size={17} /></RailLink>
          <RailLink href="/ai/canvas" label={t("工作流画布", "Canvas")}><PanelsTopLeft size={17} /></RailLink>
          <RailLink href="/ai/history" label={t("我的资产", "Assets")}><FolderOpen size={17} /></RailLink>
        </nav>
        <div className="agent-home-rail-bottom">
          <button type="button" onClick={toggleTheme} title={t("切换日夜主题", "Toggle theme")} aria-label={t("切换日夜主题", "Toggle theme")}>
            {isDay ? <Moon size={16} /> : <Sun size={16} />}
          </button>
          <Link to="/ai/account" title={t("账户中心", "Account")} aria-label={t("账户中心", "Account")}>
            {user?.imageUrl
              ? <OssImage src={user.imageUrl} alt="" />
              : <span>{user?.name?.[0]?.toUpperCase() || "U"}</span>}
          </Link>
        </div>
      </aside>

      <div className="agent-home-content">
        <header className="agent-home-topbar" style={{ borderColor: ui.line }}>
          <Link to="/" className="agent-home-mobile-brand"><Sparkles size={16} />StarDraw</Link>
          <div className="agent-home-topbar-spacer" />
          <button
            type="button"
            onClick={() => setPromptOpen(true)}
            title={t("查看公告", "View announcements")}
            aria-label={t("查看公告", "View announcements")}
            className="agent-home-announcement-button"
            style={{
              background: ui.surface,
              borderColor: ui.line,
              color: unreadItems.length > 0 ? ui.primary : ui.muted,
            }}
          >
            <Bell size={16} />
            {unreadItems.length > 0 && (
              <span>{unreadItems.length > 99 ? "99+" : unreadItems.length}</span>
            )}
          </button>
          <Link to="/ai/billing" className="agent-home-balance" style={{ background: ui.surface, borderColor: ui.line }}>
            <Coins size={14} />
            <span>{balance === null ? "—" : balance}</span>
            <small>{t("积分", "points")}</small>
          </Link>
          <Link to="/ai" className="agent-home-studio-link">{t("进入创作台", "Open studio")}</Link>
        </header>

        <main className="agent-home-main">
          <div
            ref={agentShellRef}
            className="agent-home-agent-shell"
            style={agentDocked && agentShellPlaceholderHeight > 0 ? { minHeight: `${agentShellPlaceholderHeight}px` } : undefined}
          >
            <GlobalAgent
              home
              floating={floatingAgent}
              dockExpanded={expandedAgent}
              onDockExpandedChange={handleDockExpandedChange}
              referenceAssets={referenceAssets}
              onReferenceAssetsChange={setReferenceAssets}
              onReferenceDrop={handleReferenceDrop}
              initialInstruction={initialInstruction}
              onInitialInstructionConsumed={consumeInitialInstruction}
            />
          </div>

          {inspirationItems.length > 0 && <section id="community" className="agent-home-discover agent-home-discover-works" aria-label={t("灵感社区", "Inspiration community")}>
            <div className="agent-home-section-heading">
              <div><p>{t("灵感社区", "DISCOVER")}</p><h2>{t("看看大家正在创造什么", "See what the community is creating")}</h2></div>
              <a href="#community">{t("浏览全部", "View all")}</a>
            </div>
            <div className="agent-home-library-toolbar">
              <label className="agent-home-library-search" style={{ background: ui.surface, borderColor: ui.line, color: ui.faint }}>
                <Search size={14} />
                <input value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder={t("搜索作品、风格或关键词", "Search works, styles, or keywords")} />
              </label>
              <div className="agent-home-library-filters" style={{ background: ui.surfaceAlt, borderColor: ui.line }}>
                {["all", "image", "video"].map((type) => <button
                  key={type}
                  type="button"
                  onClick={() => setTemplateType(type)}
                  style={{ background: templateType === type ? ui.surface : "transparent", color: templateType === type ? ui.primary : ui.muted }}
                >{type === "all" ? t("全部", "All") : type === "image" ? t("图片", "Images") : t("视频", "Video")}</button>)}
              </div>
              <span className="agent-home-library-count" style={{ color: ui.faint }}>{visibleInspirations.length} / {inspirationItems.length}</span>
            </div>
            <div className="agent-home-community-grid">
              {visibleInspirations.map((item) => <CommunityTile key={item.id} item={item} onOpen={openInspirationPreview} t={t} />)}
            </div>
            {!visibleInspirations.length && <p className="agent-home-library-empty" style={{ color: ui.muted }}>{t("没有匹配的作品", "No matching works")}</p>}
          </section>}

          <section className="agent-home-capabilities" aria-label={t("快速开始", "Quick start")}>
            {capabilities.map(({ href, Icon: capabilityIcon, title, detail }) => (
              <Link key={href} to={href} style={{ background: ui.surface, borderColor: ui.line }}>
                <span className="agent-home-capability-icon" style={{ background: ui.primarySoft, color: ui.primary }}>{createElement(capabilityIcon, { size: 17 })}</span>
                <span><strong>{title}</strong><small>{detail}</small></span>
              </Link>
            ))}
          </section>

          {previewItem && <InspirationPreview item={previewItem} onClose={() => setPreviewItem(null)} onUseTemplate={useAsTemplate} onUseReference={useAsReference} ui={ui} t={t} />}
        </main>
      </div>
    </div>
  );
}
