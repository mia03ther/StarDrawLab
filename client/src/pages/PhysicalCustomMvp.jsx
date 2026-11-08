import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImagePlus, LockKeyhole, PackageOpen, Sparkles, WandSparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";
import { setPhysicalDraft } from "../utils/physicalDraft";
import "./PhysicalCustomMvp.css";

const styles = [
  { id: "soft", name: "软萌手绘", note: "轻松、温暖、适合日常陪伴", hue: "peach" },
  { id: "anime", name: "二次元角色", note: "清晰轮廓与鲜明色彩", hue: "violet" },
  { id: "editorial", name: "高级写真", note: "保留人物气质与细节", hue: "ink" },
];
const products = [{ id: "keychain", name: "亚克力钥匙扣", note: "首批验证品类", active: true }, { id: "sticker", name: "贴纸套装", note: "即将开放", active: false }, { id: "standee", name: "亚克力立牌", note: "即将开放", active: false }];

export default function PhysicalCustomMvp() {
  const navigate = useNavigate(); const { isSignedIn, login } = useAuthing();
  const [step, setStep] = useState(1); const [file, setFile] = useState(null); const [style, setStyle] = useState(styles[0]); const [product, setProduct] = useState(products[0]);
  const preview = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const advance = () => { if (step === 1 && !file) return; if (step < 3) return setStep((v) => v + 1); const prompt = `将用户照片转为${style.name}风格的${product.name}设计预览，主体清晰完整，适合实体制作，画面无文字、无水印、留出干净背景。`; setPhysicalDraft({ file, product: product.name, style: style.name, prompt }); if (!isSignedIn) return login(); navigate(`/ai/scene-image?${new URLSearchParams({ template: "freeform_image", physical: "1", product: product.name, style: style.name, prompt })}`); };
  return <main className="custom-page"><header className="custom-header"><Link to="/" className="custom-back"><ArrowLeft size={16} />StarDraw</Link><div className="custom-progress">{[1,2,3].map((n) => <span className={n <= step ? "active" : ""} key={n}>{n < step ? <Check size={13} /> : n}</span>)}</div><span className="custom-stage">实物设计 / 内测</span></header>
    <section className="custom-shell"><aside className="custom-intro"><p>DESIGN OBJECTS<br/>FROM MOMENTS</p><h1>一张照片，<br/><em>做成一件东西。</em></h1><small>先看设计预览；满意后扫码咨询打样和报价。</small><div className="custom-mini-object"><span>✦</span><i /></div></aside>
      <section className="custom-card">
        {step === 1 && <><StepTitle icon={<ImagePlus />} label="01 / YOUR PHOTO" title="先放进一张照片" text="人物、宠物或纪念瞬间都可以。照片只用于本次设计预览。"/><label className={`custom-upload ${preview ? "has-image" : ""}`}>{preview ? <img src={preview} alt="待设计照片"/> : <><ImagePlus size={31}/><b>选择照片</b><span>JPG 或 PNG，主体清晰效果更好</span></>}<input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)}/></label>{!file && <p className="custom-hint"><LockKeyhole size={13}/>先在本地预览，进入生成时才会使用图片</p>}</>}
        {step === 2 && <><StepTitle icon={<Sparkles />} label="02 / VISUAL STYLE" title="让它有自己的样子" text="选择一个方向，我们会将它写入生成提示词。"/><div className="custom-options">{styles.map((item) => <button className={`custom-style ${item.hue} ${style.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setStyle(item)}><span className="custom-style-art">✦</span><b>{item.name}</b><small>{item.note}</small>{style.id === item.id && <i><Check size={13}/></i>}</button>)}</div></>}
        {step === 3 && <><StepTitle icon={<PackageOpen />} label="03 / OBJECT" title="这份设计，要变成什么？" text="先用钥匙扣验证设计到实物的完整体验。"/><div className="custom-products">{products.map((item) => <button disabled={!item.active} className={product.id === item.id ? "selected" : ""} key={item.id} onClick={() => setProduct(item)}><span>{item.id === "keychain" ? "⌁" : "○"}</span><b>{item.name}</b><small>{item.note}</small>{product.id === item.id && <i><Check size={13}/></i>}</button>)}</div><div className="custom-summary"><span>本次设计</span><b>{style.name} · {product.name}</b></div></>}
        <footer className="custom-footer"><button className="custom-prev" onClick={() => setStep((v) => Math.max(1,v-1))} disabled={step===1}>上一步</button><button className="custom-next" onClick={advance} disabled={step===1 && !file}>{step === 3 ? <>去生成设计预览 <WandSparkles size={17}/></> : <>继续 <ArrowRight size={17}/></>}</button></footer>
      </section></section></main>;
}
function StepTitle({ icon, label, title, text }) { return <div className="custom-title"><span>{icon}</span><p>{label}</p><h2>{title}</h2><small>{text}</small></div>; }