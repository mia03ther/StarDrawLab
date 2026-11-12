import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImagePlus, LockKeyhole, PackageOpen, Sparkles, WandSparkles } from "lucide-react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuthing } from "../contexts/AuthingContext";
import useAuthAxios from "../hooks/useAuthAxios";
import { OssImage } from "../components/OssMedia";
import "./PhysicalCustomMvp.css";

const styles = [
  { id: "soft", name: "软萌手绘", note: "轻松、温暖、适合日常陪伴", hue: "peach" },
  { id: "anime", name: "二次元角色", note: "清晰轮廓与鲜明色彩", hue: "violet" },
  { id: "editorial", name: "高级写真", note: "保留人物气质与细节", hue: "ink" },
];
const products = [{ id: "keychain", name: "亚克力钥匙扣", note: "首批验证品类", active: true }, { id: "sticker", name: "贴纸套装", note: "即将开放", active: false }, { id: "standee", name: "亚克力立牌", note: "即将开放", active: false }];
const inspirations = [
  { style: "soft", eyebrow: "SOFT ILLUSTRATION", title: "把日常，画得更有温度", note: "人物 / 宠物 / 纪念瞬间", tone: "peach" },
  { style: "anime", eyebrow: "CHARACTER STUDY", title: "让照片变成你的角色设定", note: "二次元 / 清晰轮廓 / 鲜明配色", tone: "violet" },
  { style: "editorial", eyebrow: "OBJECT PORTRAIT", title: "留住人物本来的质感", note: "写真 / 礼物 / 收藏设计", tone: "ink" },
];

export default function PhysicalCustomMvp() {
  const { isReady, isSignedIn, isAdmin, login } = useAuthing(); const authAxios = useAuthAxios();
  const [step, setStep] = useState(1); const [file, setFile] = useState(null); const [style, setStyle] = useState(styles[0]); const [product, setProduct] = useState(products[0]);
  const [result, setResult] = useState(null); const [generating, setGenerating] = useState(false); const [generationError, setGenerationError] = useState("");
  const [generationStartedAt, setGenerationStartedAt] = useState(null); const [generationElapsed, setGenerationElapsed] = useState(0);
  const [caseTemplates, setCaseTemplates] = useState([]);
  const preview = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    let active = true;
    authAxios.get("/api/template-studio/prompt-templates", { params: { catalog: "marketplace", tag: "实体案例", output_type: "image", page_size: 12 } })
      .then(({ data }) => { if (active) setCaseTemplates(Array.isArray(data?.data) ? data.data.filter((item) => item?.preview_image_url) : []); })
      .catch(() => { if (active) setCaseTemplates([]); });
    return () => { active = false; };
  }, [authAxios]);
  const pending = ["pending", "running", "processing", "in_progress"].includes(result?.status);
  useEffect(() => {
    if (!generationStartedAt || !(generating || pending)) return undefined;
    const tick = () => setGenerationElapsed(Math.max(0, Math.floor((Date.now() - generationStartedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [generationStartedAt, generating, pending]);
  useEffect(() => {
    if (!result?.creation_id || !pending) return undefined;
    let stopped = false; let timer;
    const poll = async () => {
      try {
        const { data } = await authAxios.get(`/api/ai/image-status/${encodeURIComponent(result.creation_id)}`, { params: { _: Date.now() }, headers: { "Cache-Control": "no-cache" } });
        if (stopped) return;
        setResult((current) => ({ ...current, ...data }));
        if (data.status === "completed") { toast.success("设计预览已生成"); return; }
        if (data.status === "failed") { setGenerationError(data.error_message || "设计预览未能生成，请稍后重试。"); return; }
      } catch { /* Keep an accepted task on this page and retry shortly. */ }
      if (!stopped) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; if (timer) window.clearTimeout(timer); };
  }, [authAxios, pending, result?.creation_id]);
  const advance = async () => {
    if (step === 1 && !file) return;
    if (step < 3) return setStep((v) => v + 1);
    // Avoid treating the first render of Authing hydration as a logged-out user.
    // That race used to send an already logged-in visitor into the legacy home.
    if (!isReady) {
      toast("正在确认登录状态，请再点一次生成。", { icon: "⌛" });
      return;
    }
    if (!isSignedIn) {
      // Authing always returns through /callback. Preserve this dedicated flow
      // instead of letting the generic callback send the user into the old AI home.
      window.sessionStorage.setItem("stardraw_post_login_path", "/design");
      return login();
    }
    const prompt = `将用户照片转为${style.name}风格的${product.name}设计预览，主体清晰完整，适合实体制作，画面无文字、无水印、留出干净背景。`;
    // The production provider accepts reference photos only with its enabled
    // image-edit model. Keep this flow aligned with the regular image page
    // rather than pinning an unavailable legacy model.
    const formData = new FormData(); formData.append("scene_key", "freeform_image"); formData.append("user_prompt", prompt); formData.append("model", "gpt-image-2"); formData.append("size", "1024x1024"); formData.append("visual_parameters", "{}"); formData.append("images", file);
    setGenerating(true); setGenerationError(""); setResult(null); setGenerationStartedAt(Date.now()); setGenerationElapsed(0);
    try {
      const { data } = await authAxios.post("/api/ai/generate-scene-image", formData);
      setResult(data);
      if (data.status === "completed") toast.success("设计预览已生成");
      else if (["pending", "running", "processing", "in_progress"].includes(data.status)) toast.success("设计预览正在生成，会直接显示在这里");
    } catch (error) {
      const message = error.response?.data?.message || "设计预览未能提交，请稍后重试。";
      setGenerationError(message); toast.error(message);
    } finally { setGenerating(false); window.dispatchEvent(new Event("stardraw:points-updated")); }
  };
  const restart = () => { setResult(null); setGenerationError(""); setGenerationStartedAt(null); setGenerationElapsed(0); setStep(1); setFile(null); };
  const progressValue = generating ? Math.min(24, 8 + generationElapsed * 4) : pending ? Math.min(92, generationElapsed < 18 ? 34 + generationElapsed * 2 : generationElapsed < 60 ? 70 + Math.floor((generationElapsed - 18) / 4) : 84 + Math.min(8, Math.floor((generationElapsed - 60) / 15))) : 0;
  const progressLabel = generating ? "正在提交生成任务" : generationElapsed < 18 ? "已提交，正在排队" : generationElapsed < 60 ? "正在生成实物设计预览" : "生成仍在进行，完成后会自动显示";
  const useInspiration = (inspiration) => { setStyle(styles.find((item) => item.id === inspiration.style) || styles[0]); setStep(2); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return <main className="custom-page"><header className="custom-header"><Link to="/" className="custom-back"><ArrowLeft size={16} />StarDraw</Link><div className="custom-progress">{[1,2,3].map((n) => <span className={n <= step ? "active" : ""} key={n}>{n < step ? <Check size={13} /> : n}</span>)}</div><span className="custom-stage">实物设计 / 内测</span></header>
    <section className="custom-shell"><aside className="custom-intro"><p>DESIGN OBJECTS<br/>FROM MOMENTS</p><h1>一张照片，<br/><em>做成一件东西。</em></h1><small>先看设计预览；满意后扫码咨询打样和报价。</small><div className="custom-mini-object"><span>✦</span><i /></div></aside>
      <section className="custom-card">
        {(generating || result || generationError) ? <section className="custom-result">
          {generating || pending ? <><span className="custom-result-loader" /><p>正在生成设计预览</p><small>{progressLabel} · 已等待 {generationElapsed} 秒</small><div role="progressbar" aria-label="生成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progressValue} style={{ width: "min(420px, 100%)", height: 8, margin: "20px 0 9px", overflow: "hidden", borderRadius: 999, background: "rgba(255,255,255,.1)", boxShadow: "inset 0 1px 2px rgba(0,0,0,.35)" }}><i style={{ display: "block", width: `${progressValue}%`, height: "100%", borderRadius: "inherit", background: "linear-gradient(90deg,#f1d089,#df7650)", boxShadow: "0 0 16px rgba(241,208,137,.55)", transition: "width .7s ease" }} /></div><strong style={{ fontSize: 11, color: "#f1d089", letterSpacing: ".12em" }}>{progressValue}%</strong><small style={{ display: "block", marginTop: 11, fontSize: 10, opacity: .78 }}>这是任务阶段提示，不代表供应商精确渲染百分比。请留在当前页面，完成后会自动显示。</small></> : result?.status === "completed" && result?.content ? <><p className="custom-result-kicker">DESIGN PREVIEW / READY</p><h2>你的实物设计预览</h2><OssImage src={result.content} alt="实物设计预览" className="custom-result-image" /><small>{style.name} · {product.name} · {result.points_charged || 0} 积分</small><div className="custom-result-actions"><button type="button" className="custom-prev" onClick={restart}>重新设计</button><button type="button" className="custom-next" onClick={() => window.dispatchEvent(new Event("stardraw:open-custom-contact"))}>扫码咨询报价 <ArrowRight size={17} /></button></div></> : <><p className="custom-result-kicker">PREVIEW NOT CREATED</p><h2>这次没有生成成功</h2><small>{generationError || "请稍后重试；未产生成功结果时不应把它当作设计预览。"}</small><div className="custom-result-actions"><button type="button" className="custom-prev" onClick={restart}>返回修改</button><button type="button" className="custom-next" onClick={advance}>重新生成 <WandSparkles size={17} /></button></div></>}
        </section> : <>
        {step === 1 && <><StepTitle icon={<ImagePlus />} label="01 / YOUR PHOTO" title="先放进一张照片" text="人物、宠物或纪念瞬间都可以。照片只用于本次设计预览。"/><label className={`custom-upload ${preview ? "has-image" : ""}`}>{preview ? <img src={preview} alt="待设计照片"/> : <><ImagePlus size={31}/><b>选择照片</b><span>JPG 或 PNG，主体清晰效果更好</span></>}<input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)}/></label>{!file && <p className="custom-hint"><LockKeyhole size={13}/>先在本地预览，进入生成时才会使用图片</p>}</>}
        {step === 2 && <><StepTitle icon={<Sparkles />} label="02 / VISUAL STYLE" title="让它有自己的样子" text="选择一个方向，我们会将它写入生成提示词。"/><div className="custom-options">{styles.map((item) => <button className={`custom-style ${item.hue} ${style.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setStyle(item)}><span className="custom-style-art">✦</span><b>{item.name}</b><small>{item.note}</small>{style.id === item.id && <i><Check size={13}/></i>}</button>)}</div></>}
        {step === 3 && <><StepTitle icon={<PackageOpen />} label="03 / OBJECT" title="这份设计，要变成什么？" text="先用钥匙扣验证设计到实物的完整体验。"/><div className="custom-products">{products.map((item) => <button disabled={!item.active} className={product.id === item.id ? "selected" : ""} key={item.id} onClick={() => setProduct(item)}><span>{item.id === "keychain" ? "⌁" : "○"}</span><b>{item.name}</b><small>{item.note}</small>{product.id === item.id && <i><Check size={13}/></i>}</button>)}</div><div className="custom-summary"><span>本次设计</span><b>{style.name} · {product.name}</b></div></>}
        <footer className="custom-footer"><button className="custom-prev" onClick={() => setStep((v) => Math.max(1,v-1))} disabled={step===1}>上一步</button><button className="custom-next" onClick={advance} disabled={step===1 && !file}>{step === 3 ? <>去生成设计预览 <WandSparkles size={17}/></> : <>继续 <ArrowRight size={17}/></>}</button></footer>
        </>}
      </section></section>
    <section className="custom-inspiration" aria-label="实物设计灵感案例">
      <div className="custom-inspiration-head"><div><p>STYLE LIBRARY / FIRST EDITION</p><h2>先从你喜欢的感觉开始。</h2></div><span>选择一个案例，会直接带入对应风格</span></div>
      {isAdmin && <Link to="/ai/admin/template-review?catalog=physical" className="custom-case-admin" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 16, border: "1px solid rgba(241,208,137,.45)", borderRadius: 999, padding: "9px 13px", color: "#f1d089", background: "rgba(241,208,137,.08)", fontSize: 12, fontWeight: 800, textDecoration: "none" }}>管理实体案例 <ArrowRight size={14} /></Link>}
      {caseTemplates.length > 0 ? <div className="custom-inspiration-grid">{caseTemplates.map((item, index) => <button type="button" key={item.id} onClick={() => { const match = styles.find((entry) => (item.tags || []).some((tag) => tag.includes(entry.name) || tag.toLowerCase().includes(entry.id))); useInspiration({ style: match?.id || styles[index % styles.length].id }); }} className="custom-example custom-example-template"><div className="custom-example-art"><OssImage src={item.preview_image_url} alt="" className="h-full w-full object-cover" /><em>CASE/{String(index + 1).padStart(2, "0")}</em></div><div className="custom-example-copy"><small>实体案例</small><h3>{item.scene_name}</h3><p>{item.preview_description || "选择这个案例的风格方向"}</p><span>使用这个方向 <ArrowRight size={14} /></span></div></button>)}</div> : <div className="custom-inspiration-grid">{inspirations.map((item, index) => <button type="button" key={item.style} onClick={() => useInspiration(item)} className={`custom-example custom-example-${item.tone}`}><div className="custom-example-art"><i /><b>{index === 0 ? "✦" : index === 1 ? "✶" : "◌"}</b><em>01/{String(index + 1).padStart(2, "0")}</em></div><div className="custom-example-copy"><small>{item.eyebrow}</small><h3>{item.title}</h3><p>{item.note}</p><span>使用这个方向 <ArrowRight size={14} /></span></div></button>)}</div>}
      <p className="custom-inspiration-note">管理员在“管理实体案例”中给模板添加“实体案例”标签并上传预览图，即可在这里展示；可批量排序、精选、上架和下架。</p>
    </section>
    </main>;
}
function StepTitle({ icon, label, title, text }) { return <div className="custom-title"><span>{icon}</span><p>{label}</p><h2>{title}</h2><small>{text}</small></div>; }
