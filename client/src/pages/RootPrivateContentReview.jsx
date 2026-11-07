import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const RESOURCE_TYPES = ["creation", "canvas", "private_template", "digital_human", "upload"];
const API_BASE_URL = String(import.meta.env.VITE_BASE_URL || "").replace(/\/$/, "");

const absoluteAssetUrl = (value) => {
  const url = String(value || "");
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE_URL}${url.startsWith("/") ? url : `/${url}`}`;
};

const mediaKind = (objectKey, snapshot) => {
  const mime = String(snapshot?.mime_type || "").toLowerCase();
  const declared = String(snapshot?.media_type || snapshot?.type || "").toLowerCase();
  if (mime.startsWith("video/") || declared === "video" || /\.(mp4|webm|mov|m4v)(?:$|\?)/i.test(objectKey)) return "video";
  if (mime.startsWith("image/") || declared === "image" || /\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(objectKey)) return "image";
  return "file";
};

const RootPrivateContentReview = () => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [form, setForm] = useState({ owner_user_id: "", resource_type: "creation", resource_id: "", reason: "" });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const grants = useMemo(() => Object.entries(result?.asset_grants || {}), [result]);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const review = async (event) => {
    event.preventDefault();
    if (!form.owner_user_id.trim() || !form.resource_id.trim() || !form.reason.trim()) {
      toast.error(t("所有字段和审查原因均为必填", "All target fields and the review reason are required"));
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const { data } = await authAxios.post("/api/root/private-content-review", {
        owner_user_id: form.owner_user_id.trim(),
        resource_type: form.resource_type,
        resource_id: form.resource_id.trim(),
        reason: form.reason.trim(),
      });
      setResult(data?.data || null);
      toast.success(t("只读审查记录已写入审计日志", "Read-only review recorded in the audit log"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("无法读取指定内容", "Unable to review the specified content"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-[1480px] p-8">
      <div className="mb-8">
        <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("ROOT 管理员", "ROOT ADMIN")}</p>
        <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("紧急私有内容审查", "Emergency Private Content Review")}</h1>
        <p className="mt-2 max-w-4xl text-sm leading-6" style={{ color: ui.faint }}>
          {t(
            "仅用于明确目标的紧急只读审查。必须填写原因，每次访问都会审计；资源授权 5 分钟后失效，本页不提供编辑或删除操作。",
            "For emergency, precisely targeted, read-only review only. A reason is mandatory and every access is audited. Asset grants expire after five minutes; this page cannot edit or delete content.",
          )}
        </p>
      </div>

      <section className="rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
        <form onSubmit={review} className="grid gap-4 lg:grid-cols-2">
          <label className="text-xs font-bold" style={{ color: ui.text }}>
            {t("内容所有者用户 ID", "Owner user ID")}
            <input value={form.owner_user_id} onChange={(event) => update("owner_user_id", event.target.value.slice(0, 255))} className="mt-2 w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          </label>
          <label className="text-xs font-bold" style={{ color: ui.text }}>
            {t("资源类型", "Resource type")}
            <CanvasRoundedSelect label={t("资源类型", "Resource type")} value={form.resource_type} onChange={(value) => update("resource_type", value)} options={RESOURCE_TYPES.map((type) => ({ value: type, label: type }))} ui={ui} className="mt-2 w-full" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={220} />
          </label>
          <label className="text-xs font-bold" style={{ color: ui.text }}>
            {t("资源 ID（上传资源也可填写 object key）", "Resource ID (uploads also accept an object key)")}
            <input value={form.resource_id} onChange={(event) => update("resource_id", event.target.value.slice(0, 255))} className="mt-2 w-full rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          </label>
          <label className="text-xs font-bold" style={{ color: ui.text }}>
            {t("紧急审查原因（写入审计）", "Emergency review reason (audited)")}
            <textarea value={form.reason} onChange={(event) => update("reason", event.target.value.slice(0, 2000))} rows={3} className="mt-2 w-full resize-y rounded-xl px-3 py-2.5 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} />
          </label>
          <div className="lg:col-span-2 flex justify-end">
            <button type="submit" disabled={loading} className="rounded-xl px-6 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.buttonGradient, color: ui.primaryText }}>
              {loading ? t("读取中…", "Reviewing…") : t("开始只读审查", "Start read-only review")}
            </button>
          </div>
        </form>
      </section>

      {result && (
        <section className="mt-6 space-y-5 rounded-3xl p-6" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-wider" style={{ color: ui.primary }}>{result.access_mode || "read_only"}</p>
              <p className="mt-1 break-all text-sm" style={{ color: ui.muted }}>{result.resource_type} / {result.resource_id} · {result.owner_user_id}</p>
            </div>
            <span className="rounded-full px-3 py-1 text-[10px] font-black" style={{ background: ui.goldSoft, color: ui.gold }}>{t("资源链接 5 分钟有效", "Asset links valid for 5 minutes")}</span>
          </div>

          {grants.length > 0 && (
            <div className="grid gap-4 md:grid-cols-2">
              {grants.map(([objectKey, url]) => {
                const kind = mediaKind(objectKey, result.snapshot);
                const assetUrl = absoluteAssetUrl(url);
                return (
                  <div key={objectKey} className="overflow-hidden rounded-2xl p-4" style={{ background: ui.surfaceAlt, border: `1px solid ${ui.line}` }}>
                    {kind === "image" && <img src={assetUrl} alt="" className="mb-3 max-h-80 w-full rounded-xl object-contain" />}
                    {kind === "video" && <video src={assetUrl} controls className="mb-3 max-h-80 w-full rounded-xl" />}
                    <p className="break-all text-xs" style={{ color: ui.faint }}>{objectKey}</p>
                    <a href={assetUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-xs font-bold" style={{ color: ui.primary }}>{t("在新窗口打开临时授权", "Open temporary grant")}</a>
                  </div>
                );
              })}
            </div>
          )}

          <div>
            <p className="mb-2 text-xs font-black uppercase tracking-wider" style={{ color: ui.faint }}>{t("只读快照", "Read-only snapshot")}</p>
            <pre className="max-h-[620px] overflow-auto whitespace-pre-wrap break-words rounded-2xl p-4 text-xs leading-5" style={{ background: ui.surfaceAlt, color: ui.muted, border: `1px solid ${ui.line}` }}>{JSON.stringify(result.snapshot, null, 2)}</pre>
          </div>
        </section>
      )}
    </main>
  );
};

export default RootPrivateContentReview;
