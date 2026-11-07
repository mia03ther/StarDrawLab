import { useEffect, useMemo, useState } from "react";
import { Eraser, ImagePlus, LoaderCircle, Scissors, Sparkles } from "lucide-react";
import toast from "react-hot-toast";

import { useLanguage } from "../contexts/LanguageContext";
import useAuthAxios from "../hooks/useAuthAxios";
import { getModelSizeOptions, normalizeModelCatalogResponse, SAFE_IMAGE_SIZE_OPTIONS } from "../utils/modelCapabilities";
import { isOversizedReferenceImage, MAX_REFERENCE_IMAGE_BYTES } from "../utils/mediaUploadLimits";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import { OssImage } from "./OssMedia";
import CanvasRoundedSelect from "./canvas/CanvasRoundedSelect";

const ImageRemovalTool = ({ kind }) => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [description, setDescription] = useState("");
  const [models, setModels] = useState([]);
  const [model, setModel] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const isBackground = kind === "background";
  const Icon = isBackground ? Eraser : Scissors;

  useEffect(() => {
    let cancelled = false;
    authAxios.get("/api/ai/models?output_type=image").then(({ data }) => {
      if (cancelled) return;
      const catalog = normalizeModelCatalogResponse(data?.data).filter(
        (item) => item.capabilities?.reference_images === true,
      );
      setModels(catalog);
      setModel((current) => catalog.some((item) => item.model_key === current) ? current : catalog[0]?.model_key || "");
    }).catch(() => {
      if (!cancelled) toast.error(t("无法读取图片编辑模型", "Unable to load image-edit models"));
    });
    return () => { cancelled = true; };
  }, [authAxios, t]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const activeModel = models.find((item) => item.model_key === model) || models[0];
  const sizes = useMemo(() => getModelSizeOptions({
    model: activeModel,
    outputType: "image",
    fallbackOptions: SAFE_IMAGE_SIZE_OPTIONS,
  }), [activeModel]);

  useEffect(() => {
    if (!sizes.some((item) => item.value === size)) setSize(sizes[0]?.value || "1024x1024");
  }, [size, sizes]);

  const selectFile = (nextFile) => {
    if (nextFile && isOversizedReferenceImage(nextFile)) {
      toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
      return;
    }
    if (preview) URL.revokeObjectURL(preview);
    setFile(nextFile || null);
    setPreview(nextFile ? URL.createObjectURL(nextFile) : "");
    setResult(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file) return toast.error(t("请先选择图片", "Choose an image first"));
    if (isOversizedReferenceImage(file)) return toast.error(t("参考图不能超过 10 MiB", "Reference images must be 10 MiB or smaller."));
    if (!model) return toast.error(t("当前没有可用的参考图编辑模型", "No reference-capable image model is available"));
    if (!isBackground && !description.trim()) return toast.error(t("请描述要移除的物体", "Describe the object to remove"));
    setLoading(true);
    setResult(null);
    try {
      const prompt = isBackground
        ? description.trim()
          ? `移除原背景，并替换为：${description.trim()}。严格保留主体、边缘、颜色和细节。`
          : "完整移除背景，输出透明背景图片。严格保留主体、边缘、颜色、姿态和细节。"
        : `仅移除这个物体：${description.trim()}。自然重建被遮挡的背景，其他内容保持不变。`;
      const form = new FormData();
      form.append("scene_key", "freeform_image");
      form.append("user_prompt", prompt);
      form.append("model", model);
      form.append("size", size);
      form.append("images", file);
      const { data } = await authAxios.post("/api/ai/generate-scene-image", form);
      setResult(data);
      toast.success(t("图片处理完成", "Image processed"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("图片处理失败", "Image processing failed"));
    } finally {
      setLoading(false);
      window.dispatchEvent(new Event("stardraw:points-updated"));
    }
  };

  return (
    <main className="mx-auto max-w-6xl p-5 md:p-8">
      <div className="mb-7">
        <p className="text-[10px] font-black uppercase tracking-[.22em]" style={{ color: ui.primary }}>{t("AI 图片编辑", "AI Image Edit")}</p>
        <h1 className="mt-2 flex items-center gap-3 text-3xl font-black" style={{ color: ui.text }}><Icon size={28} />{isBackground ? t("移除背景", "Remove background") : t("移除物体", "Remove object")}</h1>
        <p className="mt-2 text-sm" style={{ color: ui.muted }}>{t("仅展示支持参考图的模型；每次处理按实际图片生成规则扣除积分。", "Only reference-capable models are shown. Each edit is billed as one image generation.")}</p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <form onSubmit={submit} className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <label className="block text-xs font-black" style={{ color: ui.text }}>{t("原始图片", "Source image")}
            <span className="mt-3 flex min-h-52 cursor-pointer items-center justify-center overflow-hidden rounded-xl" style={{ background: ui.surfaceAlt, border: `1px dashed ${ui.lineStrong}` }}>
              {preview ? <img src={preview} alt="" className="max-h-80 w-full object-contain" /> : <span className="flex flex-col items-center gap-2 text-xs" style={{ color: ui.faint }}><ImagePlus size={28} />{t("点击选择 JPG、PNG 或 WebP", "Choose a JPG, PNG, or WebP")}</span>}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(event) => { const nextFile = event.target.files?.[0] || null; event.target.value = ""; selectFile(nextFile); }} />
            </span>
            <small className="mt-2 block font-normal" style={{ color: ui.faint }}>{t(`参考图不能超过 ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB`, `Reference images must be ${MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024)} MiB or smaller.`)}</small>
          </label>
          <label className="mt-5 block text-xs font-black" style={{ color: ui.text }}>{isBackground ? t("替换背景（可选）", "Replacement background (optional)") : t("要移除的物体", "Object to remove")}
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} maxLength={500} className="mt-2 w-full rounded-xl p-3 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }} placeholder={isBackground ? t("留空则输出透明背景；也可填写“纯白影棚背景”", "Leave blank for transparency, or describe a new background") : t("例如：画面右侧的红色水杯", "Example: the red cup on the right")} />
          </label>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <CanvasRoundedSelect label={t("模型", "Model")} value={model} options={[{ value: "", label: t("选择图片编辑模型", "Select image-edit model") }, ...models]} onChange={setModel} ui={ui} className="w-full" triggerClassName="h-11 w-full rounded-xl px-3 text-sm" menuMinWidth={240} />
            <CanvasRoundedSelect label={t("尺寸", "Size")} value={size} options={sizes} onChange={setSize} ui={ui} className="w-full" triggerClassName="h-11 w-full rounded-xl px-3 text-sm" menuMinWidth={200} />
          </div>
          <button type="submit" disabled={loading || !file || !model} className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-black disabled:opacity-50" style={{ background: ui.primary, color: ui.primaryText }}>{loading ? <LoaderCircle size={17} className="animate-spin" /> : <Sparkles size={17} />}{loading ? t("处理中…", "Processing…") : isBackground ? t("移除背景", "Remove background") : t("移除物体", "Remove object")}</button>
        </form>
        <section className="flex min-h-[480px] flex-col rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <h2 className="text-sm font-black" style={{ color: ui.text }}>{t("处理结果", "Result")}</h2>
          <div className="mt-4 flex flex-1 items-center justify-center overflow-hidden rounded-xl" style={{ background: ui.surfaceAlt }}>
            {result?.content ? <OssImage src={result.content} alt={t("处理结果", "Processed result")} className="max-h-[620px] w-full object-contain" /> : <div className="flex flex-col items-center gap-3 text-center text-xs" style={{ color: ui.faint }}><Icon size={34} /><p>{t("处理完成后，新图片会保存在你的作品与任务中心。", "The edited image will be saved to My Creations and Task Center.")}</p></div>}
          </div>
        </section>
      </div>
    </main>
  );
};

export default ImageRemovalTool;
