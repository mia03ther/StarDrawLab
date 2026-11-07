import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ImagePlus, Package, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuthing } from "../contexts/AuthingContext";

const PRODUCTS = [
  { id: "keychain", name: "亚克力钥匙扣", subtitle: "首批验证品类", emoji: "🔑", active: true },
  { id: "sticker", name: "贴纸套装", subtitle: "即将开放", emoji: "✨", active: false },
  { id: "standee", name: "亚克力立牌", subtitle: "即将开放", emoji: "🪧", active: false },
];

const STYLES = [
  { id: "cute", name: "Q版卡通", description: "适合钥匙扣与贴纸", swatch: "linear-gradient(135deg, #ffe59a, #f59e8b)" },
  { id: "anime", name: "二次元插画", description: "线条清晰、色彩鲜明", swatch: "linear-gradient(135deg, #b4d9ff, #c8b4ff)" },
  { id: "portrait", name: "温柔写真", description: "保留人物辨识度", swatch: "linear-gradient(135deg, #ffd7c4, #e4b7ab)" },
];

export default function PhysicalCustomMvp() {
  const navigate = useNavigate();
  const { isSignedIn, login } = useAuthing();
  const [step, setStep] = useState(1);
  const [product, setProduct] = useState(PRODUCTS[0]);
  const [style, setStyle] = useState(STYLES[0]);
  const [file, setFile] = useState(null);
  const imageUrl = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);

  const proceed = () => {
    if (step < 3) return setStep((current) => current + 1);
    const instruction = `将用户照片转为${style.name}风格的${product.name}设计预览，主体清晰完整，适合实体制作，画面无文字、无水印、留出干净背景。`;
    const query = new URLSearchParams({ template: "freeform_image", physical: "1", product: product.name, style: style.name, prompt: instruction });
    if (!isSignedIn) return login();
    navigate(`/ai/scene-image?${query.toString()}`);
  };

  return (
    <main className="min-h-screen bg-[#101216] px-4 py-6 text-[#f5f3ee] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between gap-4">
          <Link to="/" className="inline-flex items-center gap-2 text-sm font-bold text-[#c9c3b8] hover:text-white"><ArrowLeft size={17} />返回 StarDraw</Link>
          <span className="rounded-full border border-[#f6aa45]/30 bg-[#f6aa45]/10 px-3 py-1 text-xs font-black text-[#f6aa45]">内测 · 实物定制</span>
        </header>

        <section className="mt-10 grid gap-8 lg:grid-cols-[.78fr_1.22fr]">
          <aside className="rounded-[28px] border border-white/10 bg-[#181b20] p-6 sm:p-8">
            <p className="text-xs font-black uppercase tracking-[.24em] text-[#f6aa45]">StarDraw Custom</p>
            <h1 className="mt-3 text-3xl font-black leading-tight sm:text-4xl">把一张照片，<br />变成想带走的设计。</h1>
            <p className="mt-4 max-w-md text-sm leading-7 text-[#b5b2aa]">先探索风格与实物效果；生成满意的设计后，提交定制意向，我们会人工确认打样、工艺和报价。</p>
            <div className="mt-8 space-y-4">
              {["上传照片", "选择风格", "选择物品", "生成设计与实物预览", "保存 / 分享 / 提交定制意向"].map((label, index) => (
                <div key={label} className="flex items-center gap-3 text-sm">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${index + 1 < step ? "bg-[#f6aa45] text-[#251507]" : index + 1 === step ? "border border-[#f6aa45] text-[#f6aa45]" : "bg-white/5 text-[#757575]"}`}>{index + 1 < step ? <Check size={14} /> : index + 1}</span>
                  <span className={index + 1 === step ? "font-bold text-white" : "text-[#aaa69e]"}>{label}</span>
                </div>
              ))}
            </div>
            <div className="mt-10 rounded-2xl border border-white/8 bg-black/15 p-4 text-xs leading-5 text-[#99958c]">当前是市场验证版：下单前会由人工确认，不会直接扣除实体商品费用。</div>
          </aside>

          <section className="rounded-[28px] border border-white/10 bg-[#181b20] p-5 sm:p-8">
            {step === 1 && <div>
              <StepTitle icon={<ImagePlus />} index="01" title="上传一张想做成实物的照片" body="先在浏览器里预览照片；真正生成时会在登录后的图片创作页上传，避免未登录上传丢失。" />
              <label className="mt-7 flex min-h-[280px] cursor-pointer flex-col items-center justify-center overflow-hidden rounded-3xl border border-dashed border-[#f6aa45]/50 bg-[#121419] transition hover:border-[#f6aa45]">
                {imageUrl ? <img src={imageUrl} alt="待创作照片预览" className="h-[320px] w-full object-contain" /> : <><ImagePlus size={38} className="text-[#f6aa45]" /><p className="mt-4 font-bold">点击选择照片</p><p className="mt-2 text-xs text-[#8f8c84]">JPG、PNG，建议人物或宠物主体清楚</p></>}
                <input className="hidden" type="file" accept="image/*" onChange={(event) => setFile(event.target.files?.[0] || null)} />
              </label>
            </div>}
            {step === 2 && <div>
              <StepTitle icon={<Sparkles />} index="02" title="选择你想看到的设计风格" body="先看照片的设计方向；下一个步骤再决定它将承载在哪个物品上。" />
              <div className="mt-7 grid gap-4 sm:grid-cols-3">{STYLES.map((item) => <button key={item.id} onClick={() => setStyle(item)} className={`overflow-hidden rounded-3xl border text-left transition ${style.id === item.id ? "border-[#f6aa45] ring-1 ring-[#f6aa45]" : "border-white/10 hover:border-white/30"}`}><div className="h-28" style={{ background: item.swatch }} /><div className="p-4"><p className="font-black">{item.name}</p><p className="mt-1 text-xs text-[#9a968e]">{item.description}</p></div></button>)}</div>
            </div>}
            {step === 3 && <div>
              <StepTitle icon={<Package />} index="03" title="选择要做成的物品" body="首批先验证钥匙扣。其他品类会在工艺、价格和打样稳定后开放。" />
              <div className="mt-7 grid gap-4 sm:grid-cols-3">{PRODUCTS.map((item) => <button key={item.id} disabled={!item.active} onClick={() => setProduct(item)} className={`rounded-3xl border p-5 text-left transition ${product.id === item.id ? "border-[#f6aa45] bg-[#f6aa45]/10" : "border-white/10"} ${!item.active ? "cursor-not-allowed opacity-45" : "hover:border-white/30"}`}><span className="text-3xl">{item.emoji}</span><p className="mt-5 font-black">{item.name}</p><p className="mt-1 text-xs text-[#9a968e]">{item.subtitle}</p></button>)}</div>
              <div className="mt-7 rounded-2xl bg-black/20 p-4 text-sm text-[#c4c0b8]">你将生成：<b className="text-white">{style.name} · {product.name}</b> 设计预览</div>
            </div>}
            <div className="mt-9 flex items-center justify-between gap-3 border-t border-white/10 pt-6">
              <button onClick={() => setStep((current) => Math.max(1, current - 1))} disabled={step === 1} className="rounded-xl px-4 py-3 text-sm font-bold text-[#bcb8af] disabled:opacity-0">上一步</button>
              <button onClick={proceed} className="inline-flex items-center gap-2 rounded-xl bg-[#f6aa45] px-5 py-3 text-sm font-black text-[#251507] transition hover:brightness-110">{step === 3 ? "进入生成设计预览" : "下一步"}<ArrowRight size={17} /></button>
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function StepTitle({ icon, index, title, body }) {
  return <><div className="flex items-center gap-3 text-[#f6aa45]"><span className="rounded-xl bg-[#f6aa45]/10 p-2">{icon}</span><span className="text-xs font-black tracking-[.2em]">STEP {index}</span></div><h2 className="mt-5 text-2xl font-black sm:text-3xl">{title}</h2><p className="mt-3 max-w-xl text-sm leading-6 text-[#a9a59d]">{body}</p></>;
}