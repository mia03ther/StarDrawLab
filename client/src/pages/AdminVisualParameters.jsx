import { useCallback, useEffect, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";

const GROUPS = ["style", "camera", "lighting", "background", "shot", "motion"];
const emptyOption = () => ({
  id: null,
  parameter_key: "style",
  option_key: "",
  display_name: "",
  display_name_en: "",
  description: "",
  prompt_fragment: "",
  negative_prompt_fragment: "",
  supported_output_types: ["image", "video"],
  model_keys: [],
  display_order: 0,
  is_active: false,
});

const AdminVisualParameters = () => {
  const authAxios = useAuthAxios();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const [catalog, setCatalog] = useState({ groups: [] });
  const [draft, setDraft] = useState(emptyOption);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => (catalog.groups || []).flatMap((group) => group.options || []), [catalog]);
  const load = useCallback(async () => {
    const { data } = await authAxios.get("/api/admin/visual-parameters");
    setCatalog(data?.data || { groups: [] });
  }, [authAxios]);

  useEffect(() => {
    load().catch((error) => toast.error(error.response?.data?.message || t("视觉参数加载失败，请先执行迁移 030", "Unable to load visual parameters; migration 030 may be required"))).finally(() => setLoading(false));
  }, [load, t]);

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!draft.option_key.trim() || !draft.display_name.trim() || !draft.prompt_fragment.trim() || !reason.trim()) {
      toast.error(t("选项键、名称、提示词和变更原因不能为空", "Option key, name, prompt fragment, and reason are required"));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...draft,
        display_order: Number(draft.display_order),
        supported_output_types: draft.supported_output_types,
        model_keys: draft.model_keys,
        reason,
      };
      const headers = { "X-Idempotency-Key": uuidv4() };
      if (draft.id) await authAxios.patch(`/api/admin/visual-parameters/${draft.id}`, payload, { headers });
      else await authAxios.post("/api/admin/visual-parameters", payload, { headers });
      await load();
      setDraft(emptyOption());
      setReason("");
      toast.success(t("视觉参数已保存", "Visual parameter saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("视觉参数保存失败", "Unable to save visual parameter"));
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (option) => {
    if (!window.confirm(t(`停用“${option.display_name}”？历史任务不会受影响。`, `Deactivate “${option.display_name}”? Existing tasks are unchanged.`))) return;
    try {
      await authAxios.delete(`/api/admin/visual-parameters/${option.id}`, {
        headers: { "X-Idempotency-Key": uuidv4() },
        data: { reason: reason.trim() || t("管理员停用视觉参数", "Administrator deactivated visual parameter") },
      });
      await load();
      toast.success(t("视觉参数已停用", "Visual parameter deactivated"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("停用失败", "Unable to deactivate"));
    }
  };

  const toggleOutputType = (type) => update("supported_output_types", draft.supported_output_types.includes(type)
    ? draft.supported_output_types.filter((item) => item !== type)
    : [...draft.supported_output_types, type]);

  return (
    <main className="mx-auto max-w-[1480px] p-6 md:p-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em]" style={{ color: ui.primary }}>{t("管理员后台", "Admin Console")}</p>
          <h1 className="mt-2 text-4xl font-black" style={{ color: ui.text }}>{t("视觉参数", "Visual Parameters")}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6" style={{ color: ui.faint }}>{t("把画风、摄影、灯光、背景、景别和运镜集中配置，并由服务端统一编译进图片、视频和画布 Agent 的提示词。", "Configure style, camera, lighting, background, shot, and motion in one place. The server composes them for image, video, and canvas-agent prompts.")}</p>
        </div>
        <button type="button" onClick={() => setDraft(emptyOption())} className="rounded-xl px-4 py-2.5 text-sm font-black" style={{ background: ui.surface, color: ui.primary, border: `1px solid ${ui.line}` }}>{t("新建选项", "New option")}</button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.05fr,0.95fr]">
        <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          {loading ? <p style={{ color: ui.faint }}>{t("加载中…", "Loading…")}</p> : (
            <div className="space-y-6">
              {(catalog.groups || []).map((group) => (
                <div key={group.parameter_key}>
                  <div className="mb-2 flex items-center justify-between"><h2 className="font-black" style={{ color: ui.text }}>{group.display_name}</h2><span className="text-xs" style={{ color: ui.faint }}>{group.display_name_en}</span></div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {(group.options || []).map((option) => (
                      <button type="button" key={option.id || `${option.parameter_key}:${option.option_key}`} onClick={() => setDraft({ ...emptyOption(), ...option })} className="rounded-2xl p-3 text-left transition-all" style={{ background: draft.id === option.id ? ui.primarySoft : ui.surfaceAlt, border: `1px solid ${draft.id === option.id ? ui.primary : ui.line}` }}>
                        <div className="flex items-center justify-between gap-2"><span className="text-sm font-bold" style={{ color: ui.text }}>{option.display_name}</span><span className="rounded-full px-2 py-1 text-[9px] font-black" style={{ background: option.is_active ? "rgba(34,197,94,.14)" : "rgba(148,163,184,.16)", color: option.is_active ? "#16a34a" : ui.faint }}>{option.is_active ? t("启用", "ON") : t("停用", "OFF")}</span></div>
                        <p className="mt-1 text-[10px] truncate" style={{ color: ui.faint }}>{option.option_key} · {option.prompt_fragment}</p>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!options.length && <p className="text-sm" style={{ color: ui.faint }}>{t("尚未有数据库配置。请执行迁移 030 后刷新。", "No database options yet. Apply migration 030, then refresh.")}</p>}
            </div>
          )}
        </section>

        <section className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-xl font-black" style={{ color: ui.text }}>{draft.id ? t("编辑选项", "Edit option") : t("新建选项", "New option")}</h2><span className="text-xs" style={{ color: ui.faint }}>{t("提示词适配", "Prompt adapter")}</span></div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("分组", "Group")}</span><CanvasRoundedSelect label={t("分组", "Group")} value={draft.parameter_key} onChange={(value) => update("parameter_key", value)} options={GROUPS.map((group) => ({ value: group, label: t({ style: "画风", camera: "摄影", lighting: "灯光", background: "背景", shot: "景别", motion: "运镜" }[group], group) }))} ui={ui} className="w-full" triggerClassName="h-10 w-full rounded-xl px-3 text-sm" menuMinWidth={180} /></label>
              <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("选项键", "Option key")}</span><input value={draft.option_key} onChange={(event) => update("option_key", event.target.value)} className="w-full rounded-xl px-3 py-2.5" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {[{ key: "display_name", label: t("中文名称", "Chinese name") }, { key: "display_name_en", label: t("英文名称", "English name") }].map(({ key, label }) => <label className="block" key={key}><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{label}</span><input value={draft[key] || ""} onChange={(event) => update(key, event.target.value)} className="w-full rounded-xl px-3 py-2.5" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>)}
            </div>
            <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("描述", "Description")}</span><input value={draft.description || ""} onChange={(event) => update("description", event.target.value)} className="w-full rounded-xl px-3 py-2.5" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
            {[{ key: "prompt_fragment", label: t("正向提示词片段", "Positive prompt fragment") }, { key: "negative_prompt_fragment", label: t("负向提示词片段", "Negative prompt fragment") }].map(({ key, label }) => <label className="block" key={key}><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{label}</span><textarea rows={3} value={draft[key] || ""} onChange={(event) => update(key, event.target.value)} className="w-full resize-y rounded-xl px-3 py-2.5 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>)}
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("显示顺序", "Display order")}</span><input type="number" min="0" value={draft.display_order ?? 0} onChange={(event) => update("display_order", event.target.value)} className="w-full rounded-xl px-3 py-2.5" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
              <label className="flex items-end gap-2 rounded-xl px-3 py-2.5 text-sm font-bold" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.line}` }}><input type="checkbox" checked={Boolean(draft.is_active)} onChange={(event) => update("is_active", event.target.checked)} />{t("启用", "Active")}</label>
            </div>
            <div><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("适用输出", "Output types")}</span><div className="flex gap-2">{["image", "video"].map((type) => <button type="button" key={type} onClick={() => toggleOutputType(type)} className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: draft.supported_output_types.includes(type) ? ui.primarySoft : ui.surfaceAlt, color: draft.supported_output_types.includes(type) ? ui.primary : ui.faint, border: `1px solid ${ui.line}` }}>{type === "image" ? t("图片", "image") : t("视频", "video")}</button>)}</div></div>
            <label className="block"><span className="mb-2 block text-[10px] font-bold uppercase tracking-widest" style={{ color: ui.faint }}>{t("变更原因（写入审计）", "Change reason (audited)")}</span><input value={reason} onChange={(event) => setReason(event.target.value)} className="w-full rounded-xl px-3 py-2.5" style={{ background: ui.surfaceAlt, color: ui.text, border: `1px solid ${ui.lineStrong}` }} /></label>
            <div className="flex gap-3"><button type="button" disabled={saving} onClick={save} className="flex-1 rounded-xl py-3 text-sm font-black disabled:opacity-60" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{saving ? t("保存中…", "Saving…") : t("保存选项", "Save option")}</button>{draft.id && draft.is_active && <button type="button" onClick={() => deactivate(draft)} className="rounded-xl px-4 py-3 text-sm font-black" style={{ background: `${ui.danger}18`, color: ui.danger }}>{t("停用", "Off")}</button>}</div>
          </div>
        </section>
      </div>
    </main>
  );
};

export default AdminVisualParameters;
