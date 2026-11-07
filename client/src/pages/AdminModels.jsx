import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const emptyModel = {
  model_key: "",
  display_name: "",
  output_type: "image",
  description: "",
  minimum_membership_tier: "free",
  resolutions: "1K, 2K, 4K",
  aspect_ratios: "9:16, 16:9, 21:9, 4:3, 3:4, 1:1",
  display_order: 0,
  is_active: false,
  capabilities: {},
};

const emptyRoute = {
  id: null,
  model_key: "",
  provider_key: "image_provider",
  upstream_model_id: "",
  priority: 100,
  is_active: false,
};

const providersForModel = (model) => {
  if (model?.output_type === "image") return ["image_provider"];
  if (model?.output_type === "agent") return ["canvas_agent"];
  if (model?.output_type === "video") {
    return model?.capabilities?.digital_human === true ? ["heygen_video_agent"] : ["sora"];
  }
  return [];
};

const listValue = (value) => Array.isArray(value) ? value.join(", ") : String(value || "");
const parseList = (value) => [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
const mutationHeaders = () => ({ "X-Idempotency-Key": crypto.randomUUID() });

const Field = ({ label, value, onChange, type = "text", disabled = false }) => (
  <label className="block text-xs font-bold">
    <span className="mb-1 block opacity-70">{label}</span>
    <input
      type={type}
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onChange(type === "number" ? Number(event.target.value) : event.target.value)}
      className="w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm outline-none disabled:opacity-60 dark:border-white/10 dark:bg-black/20"
    />
  </label>
);

const Select = ({ label, value, onChange, options, ui }) => (
  <label className="block text-xs font-bold">
    <span className="mb-1 block opacity-70">{label}</span>
    <CanvasRoundedSelect label={label} value={value} onChange={onChange} options={options.map((option) => ({ value: option, label: option }))} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={220} />
  </label>
);

const AdminModels = ({ mode = "catalog" }) => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const routing = mode === "routing";
  const [rows, setRows] = useState([]);
  const [models, setModels] = useState([]);
  const [draft, setDraft] = useState(routing ? emptyRoute : emptyModel);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const endpoint = routing ? "/api/root/model-routes" : "/api/root/models";
  const title = routing ? t("模型路由", "Model routing") : t("模型展示", "Model catalog");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const requests = [authAxios.get(endpoint)];
      if (routing) requests.push(authAxios.get("/api/root/models"));
      const responses = await Promise.all(requests);
      setRows(responses[0].data?.data || []);
      if (routing) setModels(responses[1].data?.data || []);
    } catch (error) {
      toast.error(error.response?.data?.message || t("加载配置失败", "Failed to load configuration"));
    } finally {
      setLoading(false);
    }
  }, [authAxios, endpoint, routing, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!routing || models.length === 0) return;
    setDraft((current) => {
      if (current.model_key) return current;
      const firstModel = models[0];
      return {
        ...emptyRoute,
        model_key: firstModel.model_key,
        provider_key: providersForModel(firstModel)[0] || "",
      };
    });
  }, [models, routing]);

  const selectedTitle = useMemo(() => routing
    ? (draft.id ? `#${draft.id}` : t("新建路由", "New route"))
    : (draft.model_key || t("新建模型", "New model")), [draft, routing, t]);
  const routeProviderOptions = useMemo(() => {
    const selectedModel = models.find((item) => item.model_key === draft.model_key);
    return providersForModel(selectedModel);
  }, [draft.model_key, models]);

  const selectRow = (row) => {
    setDraft(routing ? {
      id: row.id,
      model_key: row.model_key,
      provider_key: row.provider_key,
      upstream_model_id: row.upstream_model_id,
      priority: row.priority,
      is_active: Boolean(row.is_active),
    } : {
      ...row,
      resolutions: listValue(row.resolutions),
      aspect_ratios: listValue(row.aspect_ratios),
      is_active: Boolean(row.is_active),
    });
  };

  const reset = () => {
    if (!routing) return setDraft(emptyModel);
    const firstModel = models[0];
    return setDraft({
      ...emptyRoute,
      model_key: firstModel?.model_key || "",
      provider_key: providersForModel(firstModel)[0] || "",
    });
  };

  const save = async () => {
    if (!reason.trim()) return toast.error(t("请填写变更原因", "A change reason is required"));
    setSaving(true);
    try {
      const payload = routing ? {
        ...draft,
        reason: reason.trim(),
        priority: Number(draft.priority || 100),
        route_config: {},
      } : {
        ...draft,
        reason: reason.trim(),
        display_order: Number(draft.display_order || 0),
        resolutions: parseList(draft.resolutions),
        aspect_ratios: parseList(draft.aspect_ratios),
        capabilities: draft.capabilities || {},
        metadata: draft.metadata || {},
      };
      if ((routing && draft.id) || (!routing && rows.some((row) => row.model_key === draft.model_key))) {
        const id = routing ? draft.id : encodeURIComponent(draft.model_key);
        await authAxios.patch(`${endpoint}/${id}`, payload, { headers: mutationHeaders() });
      } else {
        await authAxios.post(endpoint, payload, { headers: mutationHeaders() });
      }
      toast.success(t("配置已保存", "Configuration saved"));
      setReason("");
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || t("保存失败", "Save failed"));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async () => {
    const id = routing ? draft.id : draft.model_key;
    if (!id || !reason.trim()) return toast.error(t("请选择配置并填写变更原因", "Select a configuration and provide a reason"));
    if (!window.confirm(t("确认停用这项配置？不会删除历史记录。", "Deactivate this configuration? Historical records are retained."))) return;
    try {
      await authAxios.delete(`${endpoint}/${encodeURIComponent(id)}`, {
        headers: mutationHeaders(),
        data: { reason: reason.trim() },
      });
      toast.success(t("已停用", "Deactivated"));
      setReason("");
      reset();
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || t("停用失败", "Deactivation failed"));
    }
  };

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));

  return (
    <main className="mx-auto max-w-7xl p-5 md:p-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("ROOT 管理员", "ROOT ADMIN")}</p>
          <h1 className="mt-2 text-3xl font-black" style={{ color: ui.text }}>{title}</h1>
          <p className="mt-2 text-sm" style={{ color: ui.faint }}>{t("Provider 密钥仍只存在服务端安全配置中，此页面不会读取或展示密钥。", "Provider secrets remain in secure server configuration and are never read or displayed here.")}</p>
        </div>
        <button onClick={reset} className="rounded-xl px-4 py-2 text-sm font-bold" style={{ background: ui.primary, color: ui.onPrimary }}>{t("新建", "New")}</button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.9fr,1.1fr]">
        <section className="overflow-hidden rounded-2xl" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
          <div className="border-b px-4 py-3 text-sm font-black" style={{ borderColor: ui.line }}>{loading ? t("加载中…", "Loading…") : `${rows.length} ${t("项", "items")}`}</div>
          <div className="max-h-[680px] overflow-auto p-2">
            {rows.map((row) => {
              const key = routing ? row.id : row.model_key;
              return (
                <button key={key} onClick={() => selectRow(row)} className="mb-2 flex w-full items-center justify-between rounded-xl px-3 py-3 text-left" style={{ background: (routing ? draft.id === row.id : draft.model_key === row.model_key) ? ui.surfaceAlt : "transparent" }}>
                  <span>
                    <span className="block text-sm font-bold" style={{ color: ui.text }}>{routing ? `${row.model_key} → ${row.upstream_model_id}` : row.display_name}</span>
                    <span className="mt-1 block text-[11px]" style={{ color: ui.faint }}>{routing ? `${row.provider_key} · P${row.priority}` : `${row.model_key} · ${row.output_type === "image" ? t("图片", "image") : row.output_type === "video" ? t("视频", "video") : row.output_type === "agent" ? t("Agent", "agent") : row.output_type}`}</span>
                  </span>
                  <span className="rounded-full px-2 py-1 text-[10px] font-black" style={{ background: row.is_active ? "rgba(34,197,94,.14)" : "rgba(148,163,184,.16)", color: row.is_active ? "#16a34a" : ui.faint }}>{row.is_active ? t("启用", "ACTIVE") : t("停用", "OFF")}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-2xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}` }}>
          <h2 className="text-lg font-black" style={{ color: ui.text }}>{selectedTitle}</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {routing ? <>
              <Select ui={ui} label={t("公开模型", "Public model")} value={draft.model_key} onChange={(value) => {
                const selectedModel = models.find((item) => item.model_key === value);
                const providers = providersForModel(selectedModel);
                setDraft((current) => ({
                  ...current,
                  model_key: value,
                  provider_key: providers.includes(current.provider_key) ? current.provider_key : providers[0] || "",
                }));
              }} options={models.map((item) => item.model_key)} />
              <Select ui={ui} label={t("Provider 标识", "Provider key")} value={draft.provider_key} onChange={(value) => update("provider_key", value)} options={routeProviderOptions} />
              <Field label={t("上游模型 ID", "Upstream model ID")} value={draft.upstream_model_id} onChange={(value) => update("upstream_model_id", value)} />
              <Field label={t("优先级", "Priority")} type="number" value={draft.priority} onChange={(value) => update("priority", value)} />
            </> : <>
              <Field label={t("模型 ID", "Model ID")} value={draft.model_key} disabled={rows.some((row) => row.model_key === draft.model_key)} onChange={(value) => update("model_key", value)} />
              <Field label={t("展示名称", "Display name")} value={draft.display_name} onChange={(value) => update("display_name", value)} />
              <Select ui={ui} label={t("输出类型", "Output type")} value={draft.output_type} onChange={(value) => update("output_type", value)} options={["image", "video", "agent"]} />
              <Select ui={ui} label={t("最低会员等级", "Minimum membership")} value={draft.minimum_membership_tier} onChange={(value) => update("minimum_membership_tier", value)} options={["free", "basic", "pro", "max", "enterprise"]} />
              <Field label={t("分辨率", "Resolutions")} value={draft.resolutions} onChange={(value) => update("resolutions", value)} />
              <Field label={t("比例", "Aspect ratios")} value={draft.aspect_ratios} onChange={(value) => update("aspect_ratios", value)} />
              <Field label={t("展示排序", "Display order")} type="number" value={draft.display_order} onChange={(value) => update("display_order", value)} />
              <Field label={t("说明", "Description")} value={draft.description} onChange={(value) => update("description", value)} />
              {draft.output_type === "image" && (
                <label className="flex items-center gap-2 text-sm font-bold">
                  <input
                    type="checkbox"
                    checked={draft.capabilities?.reference_images === true}
                    onChange={(event) => update("capabilities", {
                      ...(draft.capabilities || {}),
                      reference_images: event.target.checked,
                    })}
                  />
                  {t("支持参考图编辑", "Supports reference-image editing")}
                </label>
              )}
            </>}
          </div>

          <label className="mt-4 flex items-center gap-2 text-sm font-bold" style={{ color: ui.text }}>
            <input type="checkbox" checked={Boolean(draft.is_active)} onChange={(event) => update("is_active", event.target.checked)} />
            {t("启用", "Active")}
          </label>
          <div className="mt-5">
            <Field label={t("变更原因（写入审计）", "Change reason (audited)")} value={reason} onChange={setReason} />
          </div>
          <div className="mt-5 flex gap-3">
            <button disabled={saving} onClick={() => void save()} className="rounded-xl px-5 py-2.5 text-sm font-black disabled:opacity-50" style={{ background: ui.primary, color: ui.onPrimary }}>{saving ? t("保存中…", "Saving…") : t("保存", "Save")}</button>
            {((routing && draft.id) || (!routing && rows.some((row) => row.model_key === draft.model_key))) && (
              <button onClick={() => void deactivate()} className="rounded-xl px-5 py-2.5 text-sm font-black" style={{ background: "rgba(220,38,38,.12)", color: "#dc2626" }}>{t("停用", "Deactivate")}</button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
};

export default AdminModels;
