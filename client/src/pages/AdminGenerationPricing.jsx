import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Trash2 } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const QUALITY_ROWS = [
  { key: "1k", label: "1K", hint: "≤ 1499 px" },
  { key: "2k", label: "2K", hint: "1500–2999 px" },
  { key: "4k", label: "4K", hint: "≥ 3000 px" },
];

const DEFAULT_IMAGE_PRICES = {
  "template:1k": 18,
  "template:2k": 18,
  "template:4k": 18,
  "freeform:1k": 16,
  "freeform:2k": 20,
  "freeform:4k": 32,
};

const DEFAULT_VIDEO_PRICES = {
  template: 18,
  freeform: 150,
};

const emptyRule = () => ({
  id: null,
  output_type: "image",
  provider: "image_provider",
  scene_key: "",
  model: "",
  seconds: "",
  size: "",
  points_cost: 1,
  priority: 100,
  generation_mode: "all",
  is_active: true,
  meta_rule: { billing_type: "fixed" },
});

const outputLabel = (value, isZh) => ({
  image: isZh ? "图片" : "Image",
  video: isZh ? "视频" : "Video",
  agent: "Agent",
}[value] || value);

const modeLabel = (value, isZh) => ({
  all: isZh ? "通用" : "All",
  freeform: isZh ? "自由生成" : "Freeform",
  template: isZh ? "模板生成" : "Template",
}[value] || value);

const parseMeta = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const ruleQuality = (rule) => String(parseMeta(rule?.meta_rule).image_quality || "").trim().toLowerCase();

const isGenericRule = (rule) => rule
  && rule.scene_key == null
  && rule.model == null
  && rule.seconds == null
  && rule.size == null;

const imageRuleFor = (rules, mode, quality) => rules
  .filter((rule) => rule.output_type === "image"
    && rule.provider === "image_provider"
    && rule.generation_mode === mode
    && isGenericRule(rule)
    && ruleQuality(rule) === quality
    && rule.is_active)
  .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100) || Number(left.id) - Number(right.id))[0];

const videoRuleFor = (rules, mode) => rules
  .filter((rule) => rule.output_type === "video"
    && rule.provider !== "heygen_video_agent"
    && rule.generation_mode === mode
    && isGenericRule(rule)
    && rule.is_active)
  .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100) || Number(left.id) - Number(right.id))[0];

const fieldStyle = (ui) => ({
  background: ui.surfaceAlt,
  color: ui.text,
  border: `1px solid ${ui.lineStrong}`,
});

const AdminGenerationPricing = () => {
  const authAxios = useAuthAxios();
  const { isAdmin } = useAuthing();
  const { t, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [rules, setRules] = useState([]);
  const [imagePrices, setImagePrices] = useState(DEFAULT_IMAGE_PRICES);
  const [imageRuleIds, setImageRuleIds] = useState({});
  const [videoPrices, setVideoPrices] = useState(DEFAULT_VIDEO_PRICES);
  const [videoRuleIds, setVideoRuleIds] = useState({});
  const [videoProvider, setVideoProvider] = useState("sora");
  const [loading, setLoading] = useState(true);
  const [savingMatrix, setSavingMatrix] = useState("");
  const [draft, setDraft] = useState(emptyRule);
  const [advancedFilter, setAdvancedFilter] = useState("all");
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const load = useCallback(async () => {
    const { data } = await authAxios.get("/api/admin/generation-charge-rules");
    const nextRules = data?.data || [];
    const nextImagePrices = { ...DEFAULT_IMAGE_PRICES };
    const nextImageIds = {};
    ["template", "freeform"].forEach((mode) => {
      QUALITY_ROWS.forEach(({ key }) => {
        const rule = imageRuleFor(nextRules, mode, key);
        if (rule) {
          nextImagePrices[`${mode}:${key}`] = mode === "template" ? 18 : Number(rule.points_cost) || DEFAULT_IMAGE_PRICES[`${mode}:${key}`];
          nextImageIds[`${mode}:${key}`] = rule.id;
        }
      });
    });
    const nextVideoPrices = { ...DEFAULT_VIDEO_PRICES };
    const nextVideoIds = {};
    ["template", "freeform"].forEach((mode) => {
      const rule = videoRuleFor(nextRules, mode);
      if (rule) {
        nextVideoPrices[mode] = mode === "template" ? 18 : Number(rule.points_cost) || DEFAULT_VIDEO_PRICES[mode];
        nextVideoIds[mode] = rule.id;
        if (mode === "template") setVideoProvider(rule.provider);
        if (mode === "freeform" && !nextVideoIds.template) setVideoProvider(rule.provider);
      }
    });
    setRules(nextRules);
    setImagePrices(nextImagePrices);
    setImageRuleIds(nextImageIds);
    setVideoPrices(nextVideoPrices);
    setVideoRuleIds(nextVideoIds);
  }, [authAxios]);

  useEffect(() => {
    load()
      .catch((error) => toast.error(error.response?.data?.message || t("定价规则加载失败", "Failed to load pricing rules")))
      .finally(() => setLoading(false));
  }, [load, t]);

  const updateImagePrice = (mode, quality, value) => {
    const normalized = String(value).replace(/[^0-9]/g, "");
    setImagePrices((current) => ({ ...current, [`${mode}:${quality}`]: normalized }));
  };

  const updateVideoPrice = (mode, value) => {
    const normalized = String(value).replace(/[^0-9]/g, "");
    setVideoPrices((current) => ({ ...current, [mode]: normalized }));
  };

  const saveRule = async ({ id, payload }) => {
    const type = String(payload.output_type || "");
    const scene = String(payload.scene_key || "").trim();
    if (["image", "video"].includes(type) && scene !== `freeform_${type}`
        && (payload.generation_mode === "template" || scene)) {
      toast.error(t("模板价格统一锁定为18积分，请在模板管理中调整展示。", "Template prices are locked at18 points. Use Template Management for display settings."));
      throw new Error(t("模板价格已锁定", "Template price is locked"));
    }
    await authAxios.request({
      method: id ? "put" : "post",
      url: id ? `/api/admin/generation-charge-rules/${id}` : "/api/admin/generation-charge-rules",
      data: payload,
      headers: { "X-Idempotency-Key": uuidv4() },
    });
  };

  const saveImageMatrix = async () => {
    const entries = Object.entries(imagePrices).filter(([key]) => key.startsWith("freeform:"));
    if (entries.some(([, value]) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      toast.error(t("图片价格必须是大于 0 的整数", "Image prices must be positive integers"));
      return;
    }
    setSavingMatrix("image");
    try {
      await Promise.all(entries.map(([key, value]) => {
        const [generationMode, imageQuality] = key.split(":");
        return saveRule({
          id: imageRuleIds[key],
          payload: {
            output_type: "image",
            provider: "image_provider",
            scene_key: null,
            model: null,
            seconds: null,
            size: null,
            points_cost: Number(value),
            priority: 1,
            generation_mode: generationMode,
            is_active: true,
            meta_rule: { billing_type: "fixed", image_quality: imageQuality },
          },
        });
      }));
      await load();
      toast.success(t("图片价格已保存", "Image pricing saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("图片价格保存失败", "Failed to save image pricing"));
    } finally {
      setSavingMatrix("");
    }
  };

  const saveVideoMatrix = async () => {
    if (!String(videoProvider).trim() || Object.values(videoPrices).some((value) => !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
      toast.error(t("视频 Provider 和价格必须有效", "Video provider and prices are required"));
      return;
    }
    setSavingMatrix("video");
    try {
      await Promise.all(["freeform"].map((generationMode) => saveRule({
        id: videoRuleIds[generationMode],
        payload: {
          output_type: "video",
          provider: String(videoProvider).trim().toLowerCase(),
          scene_key: generationMode === "freeform" ? "freeform_video" : null,
          model: null,
          seconds: null,
          size: null,
          points_cost: Number(videoPrices[generationMode]),
          priority: 10,
          generation_mode: generationMode,
          is_active: true,
          meta_rule: { billing_type: "fixed" },
        },
      })));
      await load();
      toast.success(t("视频价格已保存", "Video pricing saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("视频价格保存失败", "Failed to save video pricing"));
    } finally {
      setSavingMatrix("");
    }
  };

  const visibleRules = useMemo(
    () => advancedFilter === "all" ? rules : rules.filter((rule) => rule.output_type === advancedFilter),
    [advancedFilter, rules],
  );

  const updateDraft = (key, value) => setDraft((current) => {
    if (key === "output_type" && value === "agent") return { ...current, output_type: value, provider: "canvas_agent", generation_mode: "all" };
    if (key === "generation_mode" && current.output_type === "agent") return { ...current, generation_mode: "all" };
    return { ...current, [key]: value };
  });

  const updateMeta = (key, value) => setDraft((current) => ({
    ...current,
    meta_rule: { ...parseMeta(current.meta_rule), [key]: value },
  }));

  const updateBillingType = (value) => setDraft((current) => {
    const existing = parseMeta(current.meta_rule);
    if (value === "token_usage") {
      return {
        ...current,
        provider: current.output_type === "agent" ? "canvas_agent" : current.provider,
        meta_rule: {
          billing_type: value,
          currency: existing.currency || "CNY",
          unit_tokens: Number(existing.unit_tokens) || 1000000,
          points_per_currency_unit: Number(existing.points_per_currency_unit) || 100,
          input_price: existing.input_price ?? 1.5,
          output_price: existing.output_price ?? 9,
          cache_read_price: existing.cache_read_price ?? 0.15,
          cache_write_price: existing.cache_write_price ?? 1.875,
          minimum_points: Number(existing.minimum_points) || 1,
        },
      };
    }
    return { ...current, meta_rule: { billing_type: value } };
  });

  const resetDraft = () => setDraft(emptyRule());

  const saveAdvancedRule = async () => {
    const meta = parseMeta(draft.meta_rule);
    const billingType = meta.billing_type || "fixed";
    const payload = {
      ...draft,
      scene_key: String(draft.scene_key || "").trim() || null,
      model: String(draft.model || "").trim() || null,
      seconds: draft.seconds === "" ? null : Number(draft.seconds),
      size: String(draft.size || "").trim() || null,
      points_cost: Number(draft.points_cost),
      priority: Number(draft.priority),
      generation_mode: draft.output_type === "agent" ? "all" : draft.generation_mode,
      meta_rule: {
        billing_type: billingType,
        ...(billingType === "per_minute" ? {
          points_per_minute: Number(meta.points_per_minute),
          minimum_points: Number(meta.minimum_points || 0),
        } : {}),
        ...(billingType === "token_usage" ? {
          currency: "CNY",
          unit_tokens: Number(meta.unit_tokens || 1000000),
          points_per_currency_unit: Number(meta.points_per_currency_unit || 100),
          input_price: Number(meta.input_price),
          output_price: Number(meta.output_price),
          cache_read_price: Number(meta.cache_read_price || 0),
          cache_write_price: Number(meta.cache_write_price || 0),
          minimum_points: Number(meta.minimum_points || 1),
        } : {}),
        ...(draft.output_type === "image" && meta.image_quality ? { image_quality: meta.image_quality } : {}),
      },
    };
    if (!String(payload.provider || "").trim()) {
      toast.error(t("Provider 不能为空", "Provider is required"));
      return;
    }
    try {
      await saveRule({ id: draft.id, payload });
      resetDraft();
      await load();
      toast.success(t("高级规则已保存", "Advanced rule saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("规则保存失败", "Failed to save rule"));
    }
  };

  const deactivate = async (rule) => {
    if (!window.confirm(t("删除这条高级规则？历史扣费不受影响。删除后规则将停止匹配。", "Delete this advanced rule? Historical charges are unaffected. The rule will stop matching."))) return;
    try {
      await authAxios.delete(`/api/admin/generation-charge-rules/${rule.id}`, {
        data: { reason: "管理员停用定价规则" },
        headers: { "X-Idempotency-Key": uuidv4() },
      });
      await load();
      toast.success(t("高级规则已删除", "Advanced rule deleted"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("规则停用失败", "Failed to deactivate rule"));
    }
  };

  const input = (label, value, onChange, type = "number", placeholder = "") => (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold" style={{ color: ui.faint }}>{label}</span>
      <input type={type} value={value ?? ""} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={fieldStyle(ui)} />
    </label>
  );

  const select = (label, value, onChange, options) => (
    <label className="block">
      <span className="mb-2 block text-xs font-semibold" style={{ color: ui.faint }}>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={fieldStyle(ui)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );

  const meta = parseMeta(draft.meta_rule);
  const buttonStyle = { background: ui.buttonGradient, color: ui.primaryText };
  const subtleButtonStyle = { background: ui.surfaceAlt, color: ui.primary, border: `1px solid ${ui.line}` };

  return (
    <main className="mx-auto max-w-[1320px] p-5 md:p-8">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("管理员后台", "Admin Console")}</p>
          <h1 className="mt-2 text-3xl font-black md:text-4xl" style={{ color: ui.text }}>{t("生成定价", "Generation pricing")}</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: ui.faint }}>
            {t("所有图片和视频模板统一18积分，模板价格已锁定。此处可调整自由生成价格；新价格只影响后续任务。", "Image and video templates are locked at18 points. Adjust freeform prices here; new prices affect future jobs only.")}
          </p>
        </div>
        {isAdmin && <button type="button" onClick={() => { resetDraft(); setAdvancedOpen(true); }} className="rounded-xl px-4 py-2.5 text-sm font-bold" style={subtleButtonStyle}>
          {t("高级规则", "Advanced rules")}
        </button>}
      </header>

      <section className="mb-6 rounded-3xl p-5 md:p-7" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: ui.primary }}>{t("图片生成", "Image generation")}</p>
            <h2 className="mt-2 text-xl font-black" style={{ color: ui.text }}>{t("清晰度价格", "Quality pricing")}</h2>
          </div>
          <span className="text-xs" style={{ color: ui.faint }}>{t("单位：积分 / 张", "Unit: points / image")}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] border-separate border-spacing-0 overflow-hidden text-left">
            <thead>
              <tr style={{ color: ui.faint }}>
                <th className="border-b p-3 text-xs font-semibold" style={{ borderColor: ui.line }}>{t("输出清晰度", "Output quality")}</th>
                <th className="border-b p-3 text-xs font-semibold" style={{ borderColor: ui.line }}>{t("模板生成", "Template")}</th>
                <th className="border-b p-3 text-xs font-semibold" style={{ borderColor: ui.line }}>{t("自由生成", "Freeform")}</th>
              </tr>
            </thead>
            <tbody>
              {QUALITY_ROWS.map(({ key, label, hint }) => (
                <tr key={key}>
                  <td className="border-b p-3" style={{ borderColor: ui.line }}><span className="font-black" style={{ color: ui.text }}>{label}</span><span className="ml-2 text-xs" style={{ color: ui.faint }}>{hint}</span></td>
                  {["template", "freeform"].map((mode) => (
                    <td className="border-b p-3" style={{ borderColor: ui.line }} key={mode}>
                      <div className="flex max-w-[220px] items-center gap-2">
                        <input aria-label={`${mode}-${key}`} type="number" min="1" step="1" readOnly={mode === "template"} value={mode === "template" ? 18 : imagePrices[`${mode}:${key}`] ?? ""} onChange={(event) => updateImagePrice(mode, key, event.target.value)} className="w-full rounded-xl px-3 py-2.5 text-sm font-black outline-none" style={fieldStyle(ui)} />
                        <span className="text-xs" style={{ color: ui.faint }}>{t("积分", "pts")}</span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs" style={{ color: ui.faint }}>{t("清晰度根据模型或输出尺寸自动匹配。", "Quality is matched from the model or output size automatically.")}</p>
          <button type="button" disabled={savingMatrix !== "" || loading} onClick={saveImageMatrix} className="rounded-xl px-5 py-2.5 text-sm font-black disabled:opacity-50" style={buttonStyle}>
            {savingMatrix === "image" ? t("保存中…", "Saving…") : t("保存图片价格", "Save image pricing")}
          </button>
        </div>
      </section>

      <section className="mb-8 rounded-3xl p-5 md:p-7" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em]" style={{ color: ui.primary }}>{t("视频生成", "Video generation")}</p>
            <h2 className="mt-2 text-xl font-black" style={{ color: ui.text }}>{t("基础价格", "Base pricing")}</h2>
          </div>
          <span className="text-xs" style={{ color: ui.faint }}>{t("按当前视频模型统一计费", "One price for the active video route")}</span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {["template", "freeform"].map((mode) => (
            <label key={mode} className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
              <span className="block text-sm font-black" style={{ color: ui.text }}>{modeLabel(mode, isZh)}</span>
              <span className="mt-1 block text-xs" style={{ color: ui.faint }}>{mode === "template" ? t("模板固定18积分。", "Templates cost18 points.") : t("默认时长规则，可在高级规则中细分秒数。", "Default duration rule; refine by seconds in advanced rules.")}</span>
              <div className="mt-4 flex items-center gap-2"><input type="number" min="1" readOnly={mode === "template"} value={mode === "template" ? 18 : videoPrices[mode] ?? ""} onChange={(event) => updateVideoPrice(mode, event.target.value)} className="w-full rounded-xl px-3 py-2.5 text-sm font-black outline-none" style={fieldStyle(ui)} /><span className="text-xs" style={{ color: ui.faint }}>{t("积分", "pts")}</span></div>
            </label>
          ))}
        </div>
        <div className="mt-5 flex justify-end"><button type="button" disabled={savingMatrix !== "" || loading} onClick={saveVideoMatrix} className="rounded-xl px-5 py-2.5 text-sm font-black disabled:opacity-50" style={buttonStyle}>{savingMatrix === "video" ? t("保存中…", "Saving…") : t("保存视频价格", "Save video pricing")}</button></div>
      </section>

      {isAdmin && <section className="overflow-hidden rounded-3xl" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <button type="button" onClick={() => setAdvancedOpen((value) => !value)} className="flex w-full items-center justify-between gap-4 p-5 text-left md:p-6" style={{ color: ui.text }}>
          <span><span className="block text-lg font-black">{t("高级规则", "Advanced rules")}</span><span className="mt-1 block text-xs" style={{ color: ui.faint }}>{t("自由生成与Agent规则；旧模板规则不覆盖统一18积分。", "Freeform and Agent rules; legacy template rules cannot override the18-point price.")}</span></span>
          <span className="text-xl" style={{ color: ui.primary }}>{advancedOpen ? "−" : "+"}</span>
        </button>
        {isAdmin && advancedOpen && <div className="border-t p-5 md:p-6" style={{ borderColor: ui.line }}>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-2">
              {["all", "image", "video", "agent"].map((value) => <button type="button" key={value} onClick={() => setAdvancedFilter(value)} className="rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: advancedFilter === value ? ui.primary : ui.surfaceAlt, color: advancedFilter === value ? ui.primaryText : ui.muted, border: `1px solid ${advancedFilter === value ? ui.primary : ui.line}` }}>{value === "all" ? t("全部", "All") : outputLabel(value, isZh)}</button>)}
            </div>
            <button type="button" onClick={resetDraft} className="rounded-xl px-3 py-2 text-xs font-bold" style={subtleButtonStyle}>{t("新建规则", "New rule")}</button>
          </div>
          <div className="grid gap-6 xl:grid-cols-[1.4fr,0.8fr]">
            <div className="overflow-x-auto rounded-2xl" style={{ border: `1px solid ${ui.line}` }}>
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead><tr style={{ color: ui.faint, borderBottom: `1px solid ${ui.line}` }}><th className="p-3">{t("类型 / 模式", "Type / mode")}</th><th className="p-3">{t("Provider / 模型", "Provider / model")}</th><th className="p-3">{t("匹配条件", "Match")}</th><th className="p-3">{t("消耗", "Cost")}</th><th className="p-3" /></tr></thead>
                <tbody>
                  {loading && <tr><td colSpan="5" className="p-7 text-center" style={{ color: ui.faint }}>{t("加载中…", "Loading…")}</td></tr>}
                  {!loading && visibleRules.length === 0 && <tr><td colSpan="5" className="p-7 text-center" style={{ color: ui.faint }}>{t("暂无规则", "No rules")}</td></tr>}
                  {!loading && visibleRules.map((rule) => {
                    const ruleMeta = parseMeta(rule.meta_rule);
                    const cost = ruleMeta.billing_type === "per_minute"
                      ? `${ruleMeta.points_per_minute || rule.points_cost} ${t("积分/分钟", "pts/min")}`
                      : ruleMeta.billing_type === "token_usage"
                        ? t("按 Token 用量", "Token usage")
                        : `${rule.points_cost} ${t("积分", "pts")}`;
                    const quality = ruleMeta.image_quality ? ` · ${String(ruleMeta.image_quality).toUpperCase()}` : "";
                    return <tr key={rule.id} style={{ borderTop: `1px solid ${ui.line}`, color: ui.text }}><td className="p-3"><span className="font-bold">{outputLabel(rule.output_type, isZh)}</span><span className="ml-2 rounded-full px-2 py-1 text-[10px]" style={{ background: ui.primarySoft, color: ui.primary }}>{modeLabel(rule.generation_mode || "all", isZh)}{quality}</span></td><td className="p-3"><p className="font-semibold">{rule.provider}</p><p className="mt-1 text-xs" style={{ color: ui.faint }}>{rule.model || t("全部模型", "All models")}</p></td><td className="max-w-[230px] p-3 text-xs" style={{ color: ui.muted }}><p className="truncate">{rule.scene_key || t("全部场景", "All scenes")}</p><p className="mt-1">{[rule.size, rule.seconds ? `${rule.seconds}s` : ""].filter(Boolean).join(" · ") || t("默认匹配", "Default match")}</p></td><td className="p-3 font-bold" style={{ color: ui.gold }}>{cost}</td><td className="p-3 text-right whitespace-nowrap"><button type="button" onClick={() => setDraft({ ...rule, meta_rule: ruleMeta })} className="mr-2 rounded-lg px-2 py-1 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("编辑", "Edit")}</button>{rule.is_active && <button type="button" onClick={() => deactivate(rule)} title={t("删除高级规则", "Delete advanced rule")} aria-label={t("删除高级规则", "Delete advanced rule")} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}><Trash2 size={13} />{t("删除", "Delete")}</button>}</td></tr>;
                  })}
                </tbody>
              </table>
            </div>
            <div className="rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
              <div className="mb-4 flex items-center justify-between"><h3 className="text-base font-black" style={{ color: ui.text }}>{draft.id ? t("编辑规则", "Edit rule") : t("新建规则", "New rule")}</h3><span className="text-xs" style={{ color: ui.faint }}>{t("服务端最终计费", "Server authoritative")}</span></div>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">{select(t("输出类型", "Output type"), draft.output_type, (value) => updateDraft("output_type", value), ["image", "video", "agent"].map((value) => ({ value, label: outputLabel(value, isZh) })))}{select(t("生成方式", "Generation mode"), draft.output_type === "agent" ? "all" : draft.generation_mode, (value) => updateDraft("generation_mode", value), (draft.output_type === "agent" ? ["all"] : ["all", "freeform", "template"]).map((value) => ({ value, label: modeLabel(value, isZh) })))}</div>
                {input("Provider", draft.provider, (value) => updateDraft("provider", value), "text", "image_provider")}
                <div className="grid grid-cols-2 gap-3">{input(t("场景键", "Scene key"), draft.scene_key, (value) => updateDraft("scene_key", value), "text")}{input(t("模型", "Model"), draft.model, (value) => updateDraft("model", value), "text")}</div>
                <div className="grid grid-cols-2 gap-3">{input(t("固定积分", "Fixed points"), draft.points_cost, (value) => updateDraft("points_cost", value))}{input(t("优先级", "Priority"), draft.priority, (value) => updateDraft("priority", value))}</div>
                <div className="grid grid-cols-2 gap-3">{input(t("视频秒数", "Seconds"), draft.seconds, (value) => updateDraft("seconds", value))}{input(t("尺寸", "Size"), draft.size, (value) => updateDraft("size", value), "text", "1024x1024")}</div>
                {draft.output_type === "image" && select(t("图片清晰度（可选）", "Image quality (optional)"), meta.image_quality || "", (value) => updateMeta("image_quality", value), [{ value: "", label: t("按尺寸自动匹配", "Infer from size") }, ...QUALITY_ROWS.map(({ key, label }) => ({ value: key, label }))])}
                {select(t("计费方式", "Billing type"), meta.billing_type || "fixed", updateBillingType, [
                  { value: "fixed", label: t("固定积分", "Fixed points") },
                  { value: "per_minute", label: t("按分钟", "Per minute") },
                  ...(draft.output_type === "agent" ? [{ value: "token_usage", label: t("按 Token 用量", "Token usage") }] : []),
                ])}
                {meta.billing_type === "per_minute" && <div className="grid grid-cols-2 gap-3">{input(t("每分钟积分", "Points per minute"), meta.points_per_minute, (value) => updateMeta("points_per_minute", value))}{input(t("最低积分", "Minimum points"), meta.minimum_points ?? 0, (value) => updateMeta("minimum_points", value))}</div>}
                {meta.billing_type === "token_usage" && <>
                  <p className="rounded-xl px-3 py-2 text-xs leading-5" style={{ background: ui.primarySoft, color: ui.primary }}>{t("按人民币 / 百万 Token 配置，1 元 = 100 积分。最终扣费以供应商返回的实际用量为准。", "Configure CNY per million tokens. 1 CNY = 100 points. Final billing uses provider-reported usage.")}</p>
                  <div className="grid grid-cols-2 gap-3">{input(t("输入 / 百万 Token", "Input / 1M tokens"), meta.input_price, (value) => updateMeta("input_price", value), "number", "1.5")}{input(t("输出 / 百万 Token", "Output / 1M tokens"), meta.output_price, (value) => updateMeta("output_price", value), "number", "9")}</div>
                  <div className="grid grid-cols-2 gap-3">{input(t("缓存读取 / 百万 Token", "Cache read / 1M tokens"), meta.cache_read_price, (value) => updateMeta("cache_read_price", value), "number", "0.15")}{input(t("缓存写入 / 百万 Token", "Cache write / 1M tokens"), meta.cache_write_price, (value) => updateMeta("cache_write_price", value), "number", "1.875")}</div>
                  <div className="grid grid-cols-2 gap-3">{input(t("最低积分", "Minimum points"), meta.minimum_points ?? 1, (value) => updateMeta("minimum_points", value))}{input(t("每单位 Token", "Tokens per unit"), meta.unit_tokens ?? 1000000, (value) => updateMeta("unit_tokens", value))}</div>
                </>}
                <label className="flex items-center justify-between rounded-xl px-3 py-3 text-sm font-bold" style={{ background: ui.surface, color: ui.text }}><span>{t("规则启用", "Rule active")}</span><input type="checkbox" checked={Boolean(draft.is_active)} onChange={(event) => updateDraft("is_active", event.target.checked)} /></label>
                <button type="button" onClick={saveAdvancedRule} className="w-full rounded-xl py-3 text-sm font-black" style={buttonStyle}>{t("保存规则", "Save rule")}</button>
              </div>
            </div>
          </div>
        </div>}
      </section>}
    </main>
  );
};

export default AdminGenerationPricing;
