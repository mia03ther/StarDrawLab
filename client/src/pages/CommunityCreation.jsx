import { useEffect, useState } from "react";
import { ArrowLeft, Bookmark, Download, Heart, LoaderCircle, LogIn, Share2, Sparkles } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useOssResourceAccess } from "../contexts/OssResourceAccessContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import useAuthAxios from "../hooks/useAuthAxios";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const CommunityCreation = () => {
  const { creationId } = useParams();
  const navigate = useNavigate();
  const { isSignedIn, login } = useAuthing();
  const { isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const authAxios = useAuthAxios();
  const { resolvePrivateUrl } = useOssResourceAccess();
  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { axios.get(`${import.meta.env.VITE_BASE_URL || ""}/api/public/community/creations/${creationId}`).then(({ data }) => setItem(data?.data || null)).catch(() => setItem(null)).finally(() => setLoading(false)); }, [creationId]);
  const toggle = async (kind, enabled) => {
    if (!isSignedIn) return login();
    try { await authAxios.post(`/api/community/creations/${creationId}/${kind}`, { enabled }); setItem((current) => ({ ...current, [kind === "like" ? "liked" : "favorited"]: enabled, [`${kind}s_count`]: Number(current?.[`${kind}s_count`] || 0) + (enabled ? 1 : -1) })); } catch (error) { toast.error(error.response?.data?.message || (isZh ? "操作失败" : "Action failed")); }
  };
  const download = async () => { try { const url = item.content?.startsWith("/oss-proxy/") ? item.content : await resolvePrivateUrl(item.content); const a = document.createElement("a"); a.href = url; a.download = `${item.title || "creation"}.${item.type === "video" ? "mp4" : "jpg"}`; a.click(); } catch { toast.error(isZh ? "下载失败" : "Download failed"); } };
  const share = async () => { const url = window.location.href; try { await navigator.clipboard.writeText(url); toast.success(isZh ? "链接已复制" : "Link copied"); } catch { window.prompt(isZh ? "分享链接" : "Share URL", url); } };
  if (loading) return <div className="flex min-h-screen items-center justify-center" style={{ background: ui.page, color: ui.accent }}><LoaderCircle className="animate-spin" /></div>;
  if (!item) return <div className="flex min-h-screen flex-col items-center justify-center gap-4" style={{ background: ui.page, color: ui.muted }}><p>{isZh ? "作品不存在或已下架" : "Creation not found or unavailable"}</p><button type="button" onClick={() => navigate("/")} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: ui.accent, color: "#261507" }}>{isZh ? "返回首页" : "Back home"}</button></div>;
  return <div className="min-h-screen" style={{ background: ui.page, color: ui.text }}><header className="home-topbar" style={{ background: ui.overlay, borderColor: ui.line }}><button type="button" className="icon-button" onClick={() => navigate(-1)} aria-label={isZh ? "返回" : "Back"}><ArrowLeft size={18} /></button><span className="text-sm font-black">StarDraw {isZh ? "社区" : "Community"}</span><button type="button" className="login-button" onClick={() => isSignedIn ? navigate("/ai") : login()}>{isSignedIn ? <Sparkles size={15} /> : <LogIn size={15} />}{isSignedIn ? (isZh ? "工作台" : "Studio") : (isZh ? "登录" : "Sign in")}</button></header><main className="mx-auto grid min-h-[calc(100vh-68px)] max-w-6xl items-center gap-8 px-5 py-8 md:grid-cols-[minmax(0,1fr)_340px]"><div className="flex min-h-[50vh] items-center justify-center overflow-hidden rounded-2xl bg-black p-2 md:min-h-[680px]">{item.type === "video" ? <OssVideo src={item.content} poster={item.thumbnail_url} authorize={false} controls playsInline className="max-h-[78vh] max-w-full object-contain" /> : <OssImage src={item.content} authorize={false} alt={item.title} className="max-h-[78vh] max-w-full object-contain" />}</div><aside><p className="text-[10px] font-black uppercase tracking-[.2em]" style={{ color: ui.accent }}>{item.type === "video" ? (isZh ? "视频" : "Video") : (isZh ? "图片" : "Image")}</p><h1 className="mt-3 text-3xl font-black" style={{ color: ui.text }}>{item.title}</h1><p className="mt-3 text-sm" style={{ color: ui.muted }}>{item.author?.name}</p><div className="mt-7 flex gap-2"><button type="button" className="detail-action" onClick={() => toggle("like", !item.liked)} style={{ color: item.liked ? ui.accent : ui.muted }}><Heart size={15} fill={item.liked ? "currentColor" : "none"} />{item.likes_count}</button><button type="button" className="detail-action" onClick={() => toggle("favorite", !item.favorited)} style={{ color: item.favorited ? ui.accent : ui.muted }}><Bookmark size={15} fill={item.favorited ? "currentColor" : "none"} />{item.favorites_count}</button><button type="button" className="icon-button" onClick={share} aria-label={isZh ? "分享" : "Share"}><Share2 size={17} /></button><button type="button" className="icon-button" onClick={download} aria-label={isZh ? "下载" : "Download"}><Download size={17} /></button></div>{item.prompt_public && item.prompt && <div className="mt-7 rounded-2xl p-4" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}><p className="text-[10px] font-black uppercase tracking-widest" style={{ color: ui.faint }}>{isZh ? "公开提示词" : "Public prompt"}</p><p className="mt-3 whitespace-pre-wrap text-sm leading-6" style={{ color: ui.muted }}>{item.prompt}</p></div>}</aside></main></div>;
};

export default CommunityCreation;
