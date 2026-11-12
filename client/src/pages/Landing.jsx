import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  ArrowRight, Bot, ChevronDown, Film, Image as ImageIcon,
  LayoutTemplate, PanelsTopLeft, Send, Sparkles, X,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import fallbackOne from "../assets/ai_gen_img_1.png";
import fallbackTwo from "../assets/ai_gen_img_2.png";
import fallbackThree from "../assets/ai_gen_img_3.png";
import "./Landing.css";

const PUBLIC_API = import.meta.env.VITE_BASE_URL || "";
const PENDING_AGENT_INSTRUCTION_KEY = "stardraw_pending_agent_instruction";
const publicRequest = axios.create({ baseURL: PUBLIC_API });

const FALLBACK_WORKS = [
  { id: "fallback-1", type: "image", content: fallbackOne, title: "光影中的未来城市" },
  { id: "fallback-2", type: "image", content: fallbackTwo, title: "电影感人物肖像" },
  { id: "fallback-3", type: "image", content: fallbackThree, title: "超现实视觉叙事" },
];

const STORY_STEPS = [
  { id: "imagine", icon: "image", eyebrow: ["01 / 灵感", "01 / IMAGINE"], title: ["一句话，先看见画面。", "See the frame before it exists."], body: ["把模糊的想法交给 StarDraw，先从一张有方向的画面开始。", "Give StarDraw a rough idea and start with one frame that has a point of view."], href: "/ai/scene-image" },
  { id: "motion", icon: "video", eyebrow: ["02 / 动态", "02 / MOTION"], title: ["让画面开始运动。", "Give the image a pulse."], body: ["从镜头、节奏到运动方式，把静态灵感延展成一段完整视频。", "Extend a still idea into a moving sequence with camera, rhythm, and motion."], href: "/ai/ai-video" },
  { id: "compose", icon: "canvas", eyebrow: ["03 / 编排", "03 / COMPOSE"], title: ["在无限画布里，把想法排成作品。", "Arrange the idea into a work."], body: ["素材、分镜、提示词和工作流放在同一个空间，创作过程始终可见。", "Keep assets, storyboards, prompts, and workflows in one visible creative space."], href: "/ai/canvas" },
  { id: "direct", icon: "agent", eyebrow: ["04 / 协作", "04 / DIRECT"], title: ["把重复的步骤交给 Agent。", "Let Agent carry the repeatable steps."], body: ["描述目标，Agent 会理解上下文、选择合适的模板，并逐步完成任务。", "Describe the outcome. Agent understands context, chooses a useful template, and moves step by step."], href: "/home" },
  { id: "template", icon: "template", eyebrow: ["05 / 加速", "05 / ACCELERATE"], title: ["从一个好模板，快速开始。", "Start with a strong template."], body: ["浏览社区和精选模板，把成熟的创作结构带回你的下一次创作。", "Browse community and featured templates, then bring a proven structure into your next idea."], href: "/ai/templates" },
];

const usableWork = (item) => Boolean(item?.content) && ["image", "video"].includes(item?.type);

function Brand({ compact = false }) {
  return (
    <Link className="landing-brand" to="/" aria-label="StarDraw">
      <span className="landing-brand-mark"><Sparkles size={17} strokeWidth={2.4} /></span>
      {!compact && <span>StarDraw</span>}
    </Link>
  );
}

function HeroMedia({ work, active }) {
  const videoRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (active) video.play().catch(() => {});
    else video.pause();
  }, [active]);

  return work.type === "video"
    ? <OssVideo ref={videoRef} src={work.content} poster={work.thumbnail_url} authorize={false} autoPlay={active} muted loop playsInline preload="metadata" />
    : <OssImage src={work.thumbnail_url || work.content} authorize={false} alt="" />;
}

export default function Landing() {
  const navigate = useNavigate();
  const { isSignedIn, isLoading, login } = useAuthing();
  const { isZh, setLocale, t } = useLanguage();
  const [prompt, setPrompt] = useState("");
  const [works, setWorks] = useState(FALLBACK_WORKS);
  const [showcaseWorks, setShowcaseWorks] = useState(FALLBACK_WORKS);
  const [activeIndex, setActiveIndex] = useState(0);
  const [storyIndex, setStoryIndex] = useState(0);
  const [promptDocked, setPromptDocked] = useState(false);
  const [floatPromptOpen, setFloatPromptOpen] = useState(false);
  const promptRef = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.allSettled([
      publicRequest.get("/api/public/community/feed", { params: { sort: "featured", limit: 10 } }),
      publicRequest.get("/api/public/community/bootstrap"),
    ]).then(([feedResult, bootstrapResult]) => {
      if (!active) return;
      const communityItems = feedResult.status === "fulfilled"
        ? (feedResult.value.data?.data?.items || []).filter(usableWork).slice(0, 6)
        : [];
      const templateItems = bootstrapResult.status === "fulfilled"
        ? (bootstrapResult.value.data?.data?.templates || []).map((template) => ({
          id: `template-${template.id}`,
          type: template.preview_video_url ? "video" : "image",
          content: template.preview_video_url || template.preview_image_url,
          thumbnail_url: template.preview_image_url || "",
          title: template.preview_title || template.scene_name || t("官方精选模板", "Featured template"),
          tags: Array.isArray(template.tags) ? template.tags : [],
        })).filter(usableWork)
        : [];
      const showcaseItems = [...communityItems, ...templateItems].filter((item, index, items) => (
        items.findIndex((candidate) => String(candidate.id) === String(item.id)) === index
      ));
      if (showcaseItems.length) setShowcaseWorks(showcaseItems);
      const nextWorks = communityItems.length ? communityItems : templateItems;
      if (nextWorks.length) {
        setWorks(nextWorks.slice(0, 8));
        setActiveIndex(0);
      }
    }).catch(() => {});
    return () => { active = false; };
  }, [t]);

  useEffect(() => {
    if (works.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % works.length);
    }, 7600);
    return () => window.clearInterval(timer);
  }, [works.length]);

  useEffect(() => {
    const sections = Array.from(document.querySelectorAll("[data-landing-story-step]"));
    if (!sections.length || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible) setStoryIndex(Number(visible.target.dataset.landingStoryStep));
    }, { rootMargin: "-34% 0px -44%", threshold: [0.1, 0.35, 0.6] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const promptElement = promptRef.current;
    if (!promptElement || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setPromptDocked(false);
        setFloatPromptOpen(false);
      } else if (entry.boundingClientRect.top < 0) {
        setPromptDocked(true);
      }
    }, { threshold: 0 });
    observer.observe(promptElement);
    return () => observer.disconnect();
  }, []);

  const activeWork = works[activeIndex] || works[0] || FALLBACK_WORKS[0];
  const title = activeWork?.title || t("社区精选作品", "Featured community creation");
  const thumbnails = useMemo(() => works.slice(0, 5), [works]);
  const activeStory = STORY_STEPS[storyIndex] || STORY_STEPS[0];
  const activeStoryWork = showcaseWorks[storyIndex % Math.max(showcaseWorks.length, 1)] || activeWork;
  const storyLabel = (copy) => (isZh ? copy[0] : copy[1]);

  const enterAgent = (instruction = "") => {
    const cleanInstruction = instruction.trim();
    if (cleanInstruction) window.localStorage.setItem(PENDING_AGENT_INSTRUCTION_KEY, cleanInstruction);
    if (isSignedIn) navigate("/home");
    else login();
  };

  const submit = (event) => {
    event.preventDefault();
    // A blank hero prompt means the visitor is choosing a creation direction.
    // Keep a typed request on the existing Agent path so no creative intent is lost.
    if (!prompt.trim()) {
      navigate("/design");
      return;
    }
    enterAgent(prompt);
  };

  return (
    <div className="landing-page">
      <section className="landing-stage">
        <div className="landing-media-stack" aria-hidden="true">
          {works.map((work, index) => (
            <div key={work.id || `${work.content}-${index}`} className={`landing-media ${index === activeIndex ? "is-active" : ""}`}>
              <HeroMedia work={work} active={index === activeIndex} />
            </div>
          ))}
          <div className="landing-media-shade" />
        </div>

        <header className="landing-header">
          <Brand />
          <nav className="landing-nav" aria-label={t("主导航", "Primary navigation")}>
            <Link to="/custom"><Sparkles size={14} />{t("照片定制", "Custom")}</Link>
            <Link to="/ai/scene-image"><ImageIcon size={14} />{t("图片生成", "Image")}</Link>
            <Link to="/ai/ai-video"><Film size={14} />{t("视频生成", "Video")}</Link>
            <Link to="/ai/canvas"><PanelsTopLeft size={14} />{t("智能画布", "Canvas")}</Link>
            <Link to="/ai/templates"><LayoutTemplate size={14} />{t("模板市场", "Templates")}</Link>
            <Link to="/home"><Bot size={14} />Agent</Link>
          </nav>
          <div className="landing-header-actions">
            <button
              type="button"
              className="landing-language"
              onClick={() => setLocale(isZh ? "en" : "zh-CN")}
              title={t("切换为英文", "Switch to Chinese")}
            >
              {isZh ? "EN" : "中"}
            </button>
            <button type="button" className="landing-enter" onClick={() => navigate("/design")}>
              {t("开始实体设计", "Start physical design")}
              <ArrowRight size={15} />
            </button>
          </div>
        </header>

        <div className="landing-hero-copy">
          <p>{t("你的 AI 视觉创作工作室", "YOUR AI VISUAL STUDIO")}</p>
          <h1>StarDraw</h1>
          <h2>{t("让灵感，即刻成片", "Turn imagination into motion")}</h2>
        </div>

        <form ref={promptRef} className="landing-prompt" onSubmit={submit}>
          <div className="landing-prompt-field">
            <Sparkles size={17} />
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={t("描述你想创造的画面、视频或完整项目", "Describe an image, video, or complete creative project")}
              maxLength={2400}
            />
          </div>
          <button type="submit" aria-label={t("交给 Agent 创作", "Create with Agent")} title={t("交给 Agent 创作", "Create with Agent")}>
            <Send size={16} />
            <span>{t("开始创作", "Create")}</span>
          </button>
        </form>

        <div className="landing-work-caption">
          <span>{activeWork?.type === "video" ? t("社区视频", "Community video") : t("社区图片", "Community image")}</span>
          <strong>{title}</strong>
        </div>

        <div className="landing-thumbnails" aria-label={t("切换背景作品", "Choose background creation")}>
          {thumbnails.map((work, index) => (
            <button
              key={work.id || `${work.content}-${index}`}
              type="button"
              className={index === activeIndex ? "is-active" : ""}
              onClick={() => setActiveIndex(index)}
              title={work.title || t(`作品 ${index + 1}`, `Creation ${index + 1}`)}
            >
              {work.type === "video" && !work.thumbnail_url
                ? <span className="landing-thumbnail-video"><Film size={14} /></span>
                : <OssImage src={work.thumbnail_url || work.content} authorize={false} alt="" />}
              {work.type === "video" && work.thumbnail_url && <Film size={11} />}
            </button>
          ))}
        </div>

        <a className="landing-scroll-hint" href="#product">
          <span>{t("探索 StarDraw", "Explore StarDraw")}</span>
          <ChevronDown size={15} />
        </a>
      </section>

      <section id="product" className="landing-product-band">
        <p>{t("从一句话到完整作品", "FROM ONE LINE TO A COMPLETE CREATION")}</p>
        <h2>{t("图片、视频、画布与 Agent，在同一个创作空间自然协作。", "Images, video, canvas, and Agent work together in one creative space.")}</h2>
        <Link to="/home#community">{t("浏览社区作品", "Explore community")}<ArrowRight size={16} /></Link>
      </section>

      <section className="landing-story" data-story={storyIndex} aria-label={t("StarDraw 创作流程", "The StarDraw creative flow")}>
        <div className="landing-story-stage-wrap">
          <div className="landing-story-stage">
            <div className="landing-story-stage-topline">
              <span>{t("创作轨迹", "THE CREATIVE TRACE")}</span>
              <span>{String(storyIndex + 1).padStart(2, "0")} / {String(STORY_STEPS.length).padStart(2, "0")}</span>
            </div>
            <div className="landing-story-media" key={`${activeStory.id}-${activeStoryWork?.content}`}>
              {activeStoryWork && <HeroMedia work={activeStoryWork} active />}
              <div className="landing-story-media-index">{String(storyIndex + 1).padStart(2, "0")}</div>
              <span className="landing-story-media-label">{activeStoryWork?.title || t("精选创作", "Featured creation")}</span>
            </div>
            <div className="landing-story-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${(storyIndex + 1) / STORY_STEPS.length})` }} />
            </div>
          </div>
        </div>

        <div className="landing-story-copy">
          {STORY_STEPS.map((step, index) => (
            <article
              key={step.id}
              data-landing-story-step={index}
              className={`landing-story-step ${index === storyIndex ? "is-active" : ""}`}
            >
              <div className="landing-story-step-count">{String(index + 1).padStart(2, "0")}</div>
              <div className="landing-story-step-main">
                <div className="landing-story-step-icon">
                  {step.icon === "image" && <ImageIcon size={16} />}
                  {step.icon === "video" && <Film size={16} />}
                  {step.icon === "canvas" && <PanelsTopLeft size={16} />}
                  {step.icon === "agent" && <Bot size={16} />}
                  {step.icon === "template" && <LayoutTemplate size={16} />}
                </div>
                <p>{storyLabel(step.eyebrow)}</p>
                <h3>{storyLabel(step.title)}</h3>
                <span>{storyLabel(step.body)}</span>
                <Link to={step.href}>{t("进入功能", "Open feature")}<ArrowRight size={14} /></Link>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-showcase" id="features">
        <div className="landing-showcase-heading">
          <div>
            <p>{t("探索创作方式", "EXPLORE THE STUDIO")}</p>
          <h2>{t("从灵感到作品，每一步都有合适的工具。", "Every step from idea to creation has a place here.")}</h2>
          </div>
          <Link to="/home#community">{t("查看全部作品", "View all creations")}<ArrowRight size={15} /></Link>
        </div>

        <nav className="landing-feature-links" aria-label={t("StarDraw 功能", "StarDraw features")}>
          <Link to="/ai/scene-image"><span><ImageIcon size={17} /></span><strong>{t("图片生成", "Image")}</strong><small>{t("风格与画面", "Style & frame")}</small></Link>
          <Link to="/ai/ai-video"><span><Film size={17} /></span><strong>{t("视频生成", "Video")}</strong><small>{t("镜头与运动", "Motion & shots")}</small></Link>
          <Link to="/ai/canvas"><span><PanelsTopLeft size={17} /></span><strong>{t("无限画布", "Canvas")}</strong><small>{t("工作流与分镜", "Workflow & storyboard")}</small></Link>
          <Link to="/home"><span><Bot size={17} /></span><strong>Agent</strong><small>{t("理解与执行", "Understand & act")}</small></Link>
          <Link to="/ai/templates"><span><LayoutTemplate size={17} /></span><strong>{t("模板市场", "Templates")}</strong><small>{t("一键开始", "Start faster")}</small></Link>
        </nav>

        <div className="landing-showcase-grid">
          {showcaseWorks.map((work, index) => (
            <Link key={work.id || `${work.content}-${index}`} to={work.id?.startsWith("template-") ? `/ai/templates/${work.id.replace("template-", "")}` : "/home#community"} className={`landing-showcase-card card-${index + 1}`}>
              {work.type === "video"
                ? <OssVideo src={work.content} poster={work.thumbnail_url} authorize={false} muted loop playsInline preload="none" />
                : <OssImage src={work.thumbnail_url || work.content} authorize={false} loading="lazy" decoding="async" alt={work.title || ""} />}
              <span className="landing-showcase-card-overlay" />
              <span className="landing-showcase-card-copy">
                <small>{work.type === "video" ? t("视频模板", "Video template") : t("图片模板", "Image template")}</small>
                <strong>{work.title || t("精选创作", "Featured creation")}</strong>
                <em>{(work.tags || []).slice(0, 2).join(" · ") || t("立即探索", "Explore now")}</em>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {promptDocked && (
        <div className={`landing-float-agent ${floatPromptOpen ? "is-open" : ""}`}>
          {!floatPromptOpen ? (
            <button
              type="button"
              className="landing-float-agent-pill"
              onClick={() => setFloatPromptOpen(true)}
              aria-label={t("打开 Agent 创作框", "Open Agent creator")}
            >
              <Sparkles size={15} />
              <span>{t("继续创作", "Continue creating")}</span>
              <ArrowRight size={14} />
            </button>
          ) : (
            <form className="landing-float-agent-form" onSubmit={submit}>
              <div className="landing-float-agent-head">
                <span><Sparkles size={14} />{t("StarDraw Agent", "StarDraw Agent")}</span>
                <button type="button" onClick={() => setFloatPromptOpen(false)} aria-label={t("收起 Agent 创作框", "Collapse Agent creator")} title={t("收起", "Collapse")}><X size={15} /></button>
              </div>
              <div className="landing-float-agent-field">
                <Sparkles size={16} />
                <input
                  autoFocus
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder={t("描述你想创作的图片、视频或项目", "Describe an image, video, or project")}
                  maxLength={2400}
                />
                <button type="submit" aria-label={t("发送给 Agent", "Send to Agent")} title={t("发送给 Agent", "Send to Agent")}><Send size={15} /></button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
