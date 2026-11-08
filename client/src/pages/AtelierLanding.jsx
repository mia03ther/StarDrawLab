import { ArrowRight, ChevronRight, CircleUserRound, Layers3, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import "./AtelierLanding.css";

const steps = [
  ["01", "上传照片", "人物、宠物或任何你想留下的瞬间"],
  ["02", "选择风格", "让照片有自己的视觉语言"],
  ["03", "生成与咨询", "满意后扫码确认打样与报价"],
];

export default function AtelierLanding() {
  const navigate = useNavigate();
  const { isSignedIn, login } = useAuthing();
  const start = () => (isSignedIn ? navigate("/custom") : login());
  return <main className="atelier-page">
    <div className="atelier-noise" />
    <header className="atelier-header">
      <Link to="/" className="atelier-brand" aria-label="StarDraw 首页"><span className="atelier-mark"><Sparkles size={16} /></span><span>StarDraw</span></Link>
      <nav><a href="#how">如何制作</a><Link to="/ai/history">我的作品</Link><Link to="/ai">创作工具</Link></nav>
      <button type="button" className="atelier-login" onClick={() => isSignedIn ? navigate("/ai/account") : login()}><CircleUserRound size={16} />{isSignedIn ? "我的账户" : "登录"}</button>
    </header>

    <section className="atelier-hero">
      <div className="atelier-copy">
        <p className="atelier-kicker"><span /> PHOTO TO OBJECT</p>
        <h1>把喜欢的<br /><em>变成拿得走的。</em></h1>
        <p className="atelier-lead">上传一张照片，做成有风格、有温度的实物设计。先看效果，再决定要不要制作。</p>
        <div className="atelier-actions"><button type="button" onClick={start}>开始设计 <ArrowRight size={18} /></button><a href="#how">看看怎么做 <ChevronRight size={17} /></a></div>
        <p className="atelier-note">当前开放：亚克力钥匙扣 · 人工确认打样与报价</p>
      </div>
      <div className="atelier-composition" aria-label="照片转实物设计示意">
        <div className="atelier-orbit orbit-one" /><div className="atelier-orbit orbit-two" />
        <div className="atelier-photo"><span className="atelier-photo-sun" /><span className="atelier-photo-hill hill-a" /><span className="atelier-photo-hill hill-b" /><p>YOUR<br/>MOMENT</p></div>
        <div className="atelier-arrow"><ArrowRight size={22} /></div>
        <div className="atelier-token"><div className="atelier-token-hole" /><div className="atelier-token-face">✦</div><span>made<br/>for you</span></div>
        <div className="atelier-floating-card">AI STYLE<br/><b>ready</b></div>
      </div>
    </section>

    <section id="how" className="atelier-how">
      <div><p className="atelier-kicker"><span /> SIMPLE BY DESIGN</p><h2>不用搭工作流。<br />只做三个选择。</h2></div>
      <div className="atelier-step-list">{steps.map(([num, title, body]) => <article key={num}><span>{num}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
    </section>

    <section className="atelier-bottom"><div><p>把第一张作品做出来。</p><small>没有自动扣除实体商品费用；报价确认后才进入打样。</small></div><button type="button" onClick={start}>开始实物设计 <Layers3 size={18} /></button></section>
  </main>;
}