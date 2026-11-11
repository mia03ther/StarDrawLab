import { ArrowLeft, ArrowRight, Boxes, ImagePlus, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import "./CreationEntry.css";

const paths = [
  { to: "/design", eyebrow: "01 / PHYSICAL DESIGN", title: "把照片，做成一件东西。", description: "上传照片，选择风格，生成可用于打样沟通的实体设计预览。", action: "开始实体设计", icon: Sparkles, tone: "physical", note: "钥匙扣内测中 · 扫码人工报价" },
  { to: "/ai", eyebrow: "02 / AI WORKSPACE", title: "继续自由创作。", description: "进入原有 AI 工作台，使用图片、视频、模板和画布等创作工具。", action: "进入 AI 工作台", icon: ImagePlus, tone: "workspace", note: "保留全部既有创作功能" },
];

export default function CreationEntry() {
  return <main className="creation-entry">
    <div className="creation-entry-glow creation-entry-glow-a" /><div className="creation-entry-glow creation-entry-glow-b" />
    <header className="creation-entry-header"><Link to="/" className="creation-entry-back"><ArrowLeft size={17} />StarDraw</Link><span>选择创作方式</span></header>
    <section className="creation-entry-content"><div className="creation-entry-intro"><p>MAKE SOMETHING REAL</p><h1>这次，想从哪里开始？</h1><span>两条创作路径彼此独立。选完后始终留在对应的体验里。</span></div>
      <div className="creation-entry-grid">{paths.map(({ to, eyebrow, title, description, action, icon: Icon, tone, note }) => <Link to={to} className={`creation-entry-card creation-entry-card-${tone}`} key={to}><div className="creation-entry-card-top"><span className="creation-entry-icon"><Icon size={24} /></span><small>{eyebrow}</small></div><h2>{title}</h2><p>{description}</p><div className="creation-entry-card-footer"><span>{note}</span><strong>{action}<ArrowRight size={17} /></strong></div><Boxes className="creation-entry-decoration" size={132} strokeWidth={0.7} /></Link>)}</div>
      <p className="creation-entry-footnote">实体设计的最终打样、工艺确认与报价由定制顾问人工跟进。</p>
    </section>
  </main>;
}
