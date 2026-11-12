import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import useAuthAxios from "../hooks/useAuthAxios";
import { useAuthing } from "../contexts/AuthingContext";
import { useLanguage } from "../contexts/LanguageContext";
import { OssImage, OssVideo } from "../components/OssMedia";
import { isAnonymousTemplateAsset, normalizeTemplates } from "../utils/templateData";
import { useStarDrawTheme } from "../utils/stardrawTheme";
import CanvasRoundedSelect from "../components/canvas/CanvasRoundedSelect";
import {
  TEMPLATE_POINTS, DEFAULT_TEMPLATE_TAGS, buildTemplatePayload, changeTemplateOutputType,
  createTemplateDraft, mergeStudioTagChoices, normalizeStudioTags, suggestTemplateTags, toTemplateDraft,
} from "../utils/templateStudioDraft";

const TAG_CHOICES_KEY = "stardraw_template_tag_choices_v1";
const readSavedTags = () => {
  try { return mergeStudioTagChoices(JSON.parse(window.localStorage.getItem(TAG_CHOICES_KEY) || "[]")); }
  catch { return []; }
};
const isDigitalHuman = (template) => String(template?.target_provider || "").toLowerCase() === "heygen_video_agent";
const detectPreviewKind = (file) => {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("video/") || /\.(mp4|webm|mov|m4v|avi|mpeg|mpg|mkv)$/i.test(file?.name || "")) return "video";
  if (type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file?.name || "")) return "image";
  return null;
};

const TemplateStudio = () => {
  const authAxios = useAuthAxios();
  const { isAdmin, user } = useAuthing();
  const { t } = useLanguage();
  const { ui } = useStarDrawTheme();
  const fileInputRef = useRef(null);
  const importInputRef = useRef(null);
  const listVersionRef = useRef(0);
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(createTemplateDraft);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [scope, setScope] = useState("mine");
  const [templateQuery, setTemplateQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [catalogFilter, setCatalogFilter] = useState("all");
  const [selectedTemplateIds, setSelectedTemplateIds] = useState([]);
  const [batchOrder, setBatchOrder] = useState(1);
  const [savedTags, setSavedTags] = useState(readSavedTags);
  const [tagInput, setTagInput] = useState("");
  const isManagement = isAdmin && scope === "all";
  const writeBase = isManagement ? "/api/admin/prompt-templates" : "/api/template-studio/prompt-templates";
  const currentUserId = user?.user_id || user?.sub || user?.id;
  const canEdit = !draft.id || draft.can_edit === true || (draft.can_edit == null && (isManagement || (currentUserId && draft.owner_user_id === currentUserId)));
  const busy = saving || uploading;
  const hiddenByAdministrator = !isManagement && draft.approval_status === "rejected";
  const canPublishPrivate = !isManagement && draft.id && canEdit && draft.visibility !== "public" && draft.approval_status !== "rejected";

  useEffect(() => { if (isAdmin) setScope("all"); }, [isAdmin]);

  const loadTemplates = useCallback(async (nextId = null) => {
    const version = ++listVersionRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const { data } = await authAxios.get(`/api/template-studio/prompt-templates?manage=${isAdmin && scope === "all" ? "all" : "mine"}`);
      if (version !== listVersionRef.current) return;
      if (data?.success === false || !Array.isArray(data?.data)) throw new Error("Invalid template list response");
      const rows = normalizeTemplates(data.data);
      setTemplates(rows);
      setDraft((current) => {
        const selected = nextId ? rows.find((item) => String(item.id) === String(nextId))
          : rows.find((item) => String(item.id) === String(current.id)) || rows[0];
        return selected ? toTemplateDraft(selected) : nextId ? current : createTemplateDraft();
      });
    } catch (error) {
      if (version !== listVersionRef.current) return;
      const message = error.response?.data?.message || t("模板列表读取失败，请重试。", "The template list could not be loaded. Retry shortly.");
      setLoadError(message);
      toast.error(message);
    } finally {
      if (version === listVersionRef.current) setLoading(false);
    }
  }, [authAxios, isAdmin, scope, t]);

  useEffect(() => {
    void loadTemplates();
    return () => { listVersionRef.current += 1; };
  }, [loadTemplates]);

  const updateDraft = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }));
  const filteredTemplates = templates.filter((template) => {
    if (statusFilter === "active" && template.is_active === false) return false;
    if (statusFilter === "disabled" && template.is_active !== false) return false;
    if (statusFilter === "pending" && template.approval_status !== "pending") return false;
    if (catalogFilter === "featured" && !template.is_featured) return false;
    if (catalogFilter === "image" && template.output_type !== "image") return false;
    if (catalogFilter === "video" && template.output_type !== "video") return false;
    if (catalogFilter === "physical" && !normalizeStudioTags(template.tags).some((tag) => /实体|定制|钥匙扣|贴纸|立牌|physical|keychain|sticker|standee|案例/i.test(tag))) return false;
    const query = templateQuery.trim().toLowerCase();
    return !query || [template.scene_name, template.preview_description, template.scene_key, ...normalizeStudioTags(template.tags)].join(" ").toLowerCase().includes(query);
  });
  const selectedTemplates = templates.filter((template) => selectedTemplateIds.includes(String(template.id)));
  const tagChoices = useMemo(() => mergeStudioTagChoices(DEFAULT_TEMPLATE_TAGS, savedTags, ...templates.map((template) => template.tags)), [savedTags, templates]);

  const addTags = (values) => {
    const next = normalizeStudioTags([...(draft.tags || []), ...normalizeStudioTags(values)]);
    updateDraft("tags", next);
    const remembered = mergeStudioTagChoices(savedTags, values);
    setSavedTags(remembered);
    try { window.localStorage.setItem(TAG_CHOICES_KEY, JSON.stringify(remembered)); } catch { /* Browser storage is optional. */ }
    setTagInput("");
  };

  const handleSave = async () => {
    if (!canEdit || busy) return;
    let payload;
    try { payload = buildTemplatePayload(draft); }
    catch (error) {
      toast.error(error.field === "scene_name" ? t("请填写模板名称", "Enter a template name")
        : error.field === "system_prompt" ? t("请填写模板提示词", "Enter a template prompt")
          : t("请检查高级设置中的视频时长", "Check the video duration in advanced settings"));
      return;
    }
    setSaving(true);
    try {
      const { data } = draft.id ? await authAxios.put(`${writeBase}/${draft.id}`, payload) : await authAxios.post(writeBase, payload);
      if (data?.data?.id) setDraft(toTemplateDraft(data.data));
      await loadTemplates(data?.data?.id || draft.id);
      toast.success(t("模板已保存", "Template saved"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("模板保存失败，请重试。", "The template could not be saved. Retry shortly."));
    } finally { setSaving(false); }
  };

  const handleActiveChange = async () => {
    if (!draft.id || !canEdit || hiddenByAdministrator || busy) return;
    setSaving(true);
    try {
      if (isManagement && draft.is_active) await authAxios.delete(`${writeBase}/${draft.id}`);
      else await authAxios.put(`${writeBase}/${draft.id}`, { is_active: !draft.is_active });
      await loadTemplates(draft.id);
      toast.success(draft.is_active ? t("模板已下架", "Template taken down") : t("模板已重新启用", "Template re-enabled"));
    } catch (error) {
      toast.error(error.response?.data?.message || t("模板状态更新失败", "Unable to update template status"));
    } finally { setSaving(false); }
  };

  const handlePublish = async () => {
    if (!draft.id || !canEdit || busy || (!isManagement && !canPublishPrivate)) return;
    setSaving(true);
    try {
      if (isManagement) {
        await authAxios.post(`/api/admin/prompt-templates/${draft.id}/approve-public`, { required_membership_tier: "free", note: "Published from template management" });
      } else {
        // Save current edits before explicitly publishing a legacy private template.
        await authAxios.put(`${writeBase}/${draft.id}`, buildTemplatePayload(draft));
        await authAxios.post(`${writeBase}/${draft.id}/request-public`);
      }
      await loadTemplates(draft.id);
      toast.success(t("模板已公开", "Template published"));
    } catch (error) { toast.error(error.response?.data?.message || t("公开失败", "Unable to publish template")); }
    finally { setSaving(false); }
  };

  const toggleTemplateSelection = (id) => {
    const value = String(id);
    setSelectedTemplateIds((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  };

  const applyBatchUpdate = async (kind) => {
    if (!isManagement || busy || selectedTemplates.length === 0) return;
    const actionLabels = {
      publish: t("上架", "publish"), hide: t("下架", "take down"), feature: t("设为精选", "feature"),
      unfeature: t("取消精选", "unfeature"), order: t("设置排序", "set order"),
    };
    setSaving(true);
    try {
      for (const [index, template] of selectedTemplates.entries()) {
        const draftForUpdate = toTemplateDraft(template);
        const next = {
          ...draftForUpdate,
          ...(kind === "publish" ? { is_active: true } : {}),
          ...(kind === "hide" ? { is_active: false } : {}),
          ...(kind === "feature" ? { is_featured: true, featured_order: Number(batchOrder) + index } : {}),
          ...(kind === "unfeature" ? { is_featured: false } : {}),
          ...(kind === "order" ? { display_order: Number(batchOrder) + index } : {}),
        };
        await authAxios.put(`${writeBase}/${template.id}`, buildTemplatePayload(next));
      }
      await loadTemplates(draft.id);
      setSelectedTemplateIds([]);
      toast.success(t(`已${actionLabels[kind]} ${selectedTemplates.length} 个模板`, `${selectedTemplates.length} templates updated`));
    } catch (error) {
      toast.error(error.response?.data?.message || t("批量更新失败，已停止后续操作。", "Batch update failed and remaining templates were not changed."));
    } finally { setSaving(false); }
  };

  const handlePreviewUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !draft.id || !canEdit) return;
    const kind = detectPreviewKind(file);
    if (!kind || (draft.output_type === "image" && kind !== "image")) {
      toast.error(t("请选择适合当前模板的图片或视频文件。", "Choose an image or video supported by this template."));
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("preview", file);
      const { data } = await authAxios.post(`${writeBase}/${draft.id}/preview`, formData, { headers: { "X-Preview-Asset-Kind": kind } });
      if (data?.data?.id) setDraft(toTemplateDraft(data.data));
      await loadTemplates(data?.data?.id || draft.id);
      toast.success(t("预览素材已更新", "Preview media updated"));
    } catch (error) {
      toast.error(error.response?.status === 413 ? t("文件过大，请压缩后上传。", "The file is too large. Compress it and retry.") : error.response?.data?.message || t("预览上传失败", "Unable to upload preview"));
    } finally { setUploading(false); }
  };

  const handleExport = async () => {
    if (!draft.id) return;
    try {
      const response = await authAxios.get(`/api/template-studio/prompt-templates/${draft.id}/export`, { responseType: "blob" });
      const url = window.URL.createObjectURL(response.data);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `${draft.scene_key || "stardraw-template"}.json`; anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (error) { toast.error(error.response?.data?.message || t("模板导出失败", "Unable to export template")); }
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    setSaving(true);
    try {
      const { data } = await authAxios.post("/api/template-studio/prompt-templates/import", JSON.parse(await file.text()));
      await loadTemplates(data?.data?.id);
      toast.success(t("模板已导入并公开", "Template imported and published"));
    } catch (error) { toast.error(error instanceof SyntaxError ? t("请选择有效的模板JSON文件", "Choose a valid template JSON file") : error.response?.data?.message || t("模板导入失败", "Unable to import template")); }
    finally { setSaving(false); }
  };

  const statusLabel = (template) => template.is_active === false ? t("已下架", "Disabled")
    : template.approval_status === "pending" ? t("待公开", "Awaiting publication")
      : template.visibility === "public" && template.approval_status === "approved" ? t("已公开", "Public") : t("未公开", "Not public");

  return <main className="mx-auto max-w-[1500px] p-4 md:p-8">
    <header className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-extrabold" style={{ color: ui.text }}>{isManagement ? t("模板管理", "Template management") : t("我的模板", "My templates")}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: ui.muted }}>{isManagement
          ? t("管理市场现有模板、调整精选与排序，必要时下架。模板生成统一18积分。", "Manage marketplace templates, featured placement and ordering, or take a template down. Template generation costs 18 points.")
          : t("新建模板保存后直接公开，管理员可下架。旧的私有模板需点击“公开模板”才会公开。", "New templates are public immediately and administrators can take them down. Existing private templates stay private until you choose Publish template.")}</p>
      </div>
      {isAdmin && <div className="flex gap-2" aria-label={t("模板管理范围", "Template management scope")}>{[
        ["mine", t("我的模板", "My templates")], ["all", t("市场模板管理", "Manage marketplace")],
      ].map(([value, label]) => <button key={value} type="button" disabled={busy} onClick={() => { setScope(value); setStatusFilter("all"); }} className="rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50" style={{ borderColor: scope === value ? ui.primary : ui.line, color: scope === value ? ui.primary : ui.muted, background: ui.surface }}>{label}</button>)}</div>}
    </header>

    <div className="grid items-start gap-6 xl:grid-cols-[320px,minmax(0,1fr)]">
      <section className="space-y-4" aria-label={t("已有模板", "Existing templates")}>
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-bold" style={{ color: ui.text }}>{t("已有模板", "Existing templates")} <span className="text-xs" style={{ color: ui.faint }}>{filteredTemplates.length}</span></h2>
          <button type="button" disabled={busy} onClick={() => { setDraft(createTemplateDraft()); setTagInput(""); }} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("新建模板", "New template")}</button>
        </div>
        <input aria-label={t("搜索已有模板", "Search existing templates")} value={templateQuery} onChange={(event) => setTemplateQuery(event.target.value)} placeholder={t("搜索名称或标签", "Search name or tags")} className="w-full rounded-xl border px-4 py-3 text-sm outline-none" style={{ background: ui.surface, borderColor: ui.line, color: ui.text }} />
        {isManagement && <div className="rounded-2xl border p-3" style={{ background: ui.surfaceAlt, borderColor: ui.line }}>
          <p className="mb-2 text-xs font-bold" style={{ color: ui.faint }}>{t("可视化分类", "Visual categories")}</p>
          <div className="flex flex-wrap gap-2">{[
            ["all", t("全部", "All")], ["featured", t("精选", "Featured")], ["physical", t("实体案例", "Physical")],
            ["image", t("图片", "Image")], ["video", t("视频", "Video")],
          ].map(([value, label]) => <button key={value} type="button" onClick={() => setCatalogFilter(value)} className="rounded-full border px-3 py-1.5 text-xs font-bold" style={{ borderColor: catalogFilter === value ? ui.primary : ui.line, background: catalogFilter === value ? ui.primarySoft : ui.surface, color: catalogFilter === value ? ui.primary : ui.muted }}>{label}</button>)}</div>
          <p className="mt-2 text-xs" style={{ color: ui.faint }}>{t("“实体案例”按实体、定制、钥匙扣、贴纸、立牌等标签筛选；编辑标签即可归类。", "Physical cases are filtered by tags. Edit a template's tags to place it here.")}</p>
        </div>}
        <SelectField label={t("模板状态", "Template status")} value={statusFilter} onChange={setStatusFilter} ui={ui} options={[
          { value: "all", label: t("全部状态", "All statuses") }, { value: "active", label: t("使用中", "Active") }, { value: "disabled", label: t("已下架", "Disabled") },
          ...(isManagement ? [{ value: "pending", label: t("旧公开申请", "Older publication requests") }] : []),
        ]} />
        {isManagement && selectedTemplates.length > 0 && <div className="sticky top-3 z-10 rounded-2xl border p-3 shadow-lg" style={{ background: ui.surfaceHigh, borderColor: ui.primary }}>
          <div className="mb-3 flex items-center justify-between gap-2"><strong className="text-sm" style={{ color: ui.text }}>{t(`已选 ${selectedTemplates.length} 个模板`, `${selectedTemplates.length} selected`)}</strong><button type="button" onClick={() => setSelectedTemplateIds([])} className="text-xs underline" style={{ color: ui.muted }}>{t("取消选择", "Clear")}</button></div>
          <div className="grid grid-cols-2 gap-2"><button type="button" disabled={busy} onClick={() => void applyBatchUpdate("publish")} className="rounded-xl px-2 py-2 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("批量上架", "Publish")}</button><button type="button" disabled={busy} onClick={() => void applyBatchUpdate("hide")} className="rounded-xl px-2 py-2 text-xs font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}>{t("批量下架", "Take down")}</button><button type="button" disabled={busy} onClick={() => void applyBatchUpdate("feature")} className="rounded-xl px-2 py-2 text-xs font-bold" style={{ background: ui.goldSoft, color: ui.gold }}>{t("设为精选", "Feature")}</button><button type="button" disabled={busy} onClick={() => void applyBatchUpdate("unfeature")} className="rounded-xl px-2 py-2 text-xs font-bold" style={{ background: ui.surfaceAlt, color: ui.muted }}>{t("取消精选", "Unfeature")}</button></div>
          <div className="mt-2 flex gap-2"><input aria-label={t("批量排序起始值", "Batch order starting value")} type="number" min="0" value={batchOrder} onChange={(event) => setBatchOrder(event.target.value)} className="min-w-0 flex-1 rounded-xl border px-3 py-2 text-xs" style={{ background: ui.surface, color: ui.text, borderColor: ui.line }} /><button type="button" disabled={busy} onClick={() => void applyBatchUpdate("order")} className="rounded-xl px-3 py-2 text-xs font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("批量排序", "Order")}</button></div>
        </div>}
        {loadError && <div role="alert" className="rounded-xl border p-4 text-sm" style={{ borderColor: ui.danger, color: ui.danger }}><p>{loadError}</p><button type="button" onClick={() => void loadTemplates()} className="mt-2 underline">{t("重新加载", "Retry")}</button></div>}
        <div className="max-h-[75vh] space-y-2 overflow-y-auto pr-1">
          {loading && <p className="py-4 text-sm" style={{ color: ui.faint }}>{t("正在读取模板…", "Loading templates…")}</p>}
          {!loading && !loadError && filteredTemplates.length === 0 && <p className="rounded-2xl p-5 text-sm" style={{ background: ui.surface, color: ui.faint }}>{t("没有符合条件的模板，可以新建一个。", "No templates match. Create a new template to begin.")}</p>}
          {filteredTemplates.map((template) => <div key={template.id} className="flex w-full rounded-2xl border p-1 text-left disabled:opacity-50" style={{ background: String(template.id) === String(draft.id) ? ui.surfaceHigh : ui.surface, borderColor: String(template.id) === String(draft.id) ? ui.primary : ui.line }}>
            {isManagement && <label className="flex shrink-0 cursor-pointer items-center px-2"><input type="checkbox" checked={selectedTemplateIds.includes(String(template.id))} onChange={() => toggleTemplateSelection(template.id)} aria-label={t(`选择 ${template.scene_name}`, `Select ${template.scene_name}`)} /></label>}
            <button type="button" disabled={busy} onClick={() => { setDraft(toTemplateDraft(template)); setTagInput(""); }} className="min-w-0 flex-1 rounded-xl p-3 text-left disabled:opacity-50">
            <div className="mb-3 flex gap-3"><div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl" style={{ background: ui.surfaceAlt }}>{template.preview_image_url ? <OssImage src={template.preview_image_url} authorize={!isAnonymousTemplateAsset(template)} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs" style={{ color: ui.faint }}>{template.output_type === "video" ? "VIDEO" : "IMAGE"}</div>}</div>
            <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2"><strong className="text-sm" style={{ color: ui.text }}>{template.scene_name}</strong><span className="flex shrink-0 gap-1">{template.is_featured && <span className="text-xs" style={{ color: ui.gold }}>{t("精选", "Featured")}</span>}<span className="text-xs" style={{ color: template.is_active === false ? ui.danger : ui.faint }}>{statusLabel(template)}</span></span></div>
            <p className="mt-2 text-xs" style={{ color: ui.faint }}>{template.output_type === "video" ? t("视频", "Video") : t("图片", "Image")} · {statusLabel(template)} · 18 {t("积分", "points")}</p>
            <p className="mt-2 text-xs" style={{ color: ui.faint }}>{t("列表", "List")} #{Number(template.display_order || 0)}{template.is_featured ? ` · ${t("精选", "Featured")} #${Number(template.featured_order || 0)}` : ""}</p>
            {template.tags?.length > 0 && <p className="mt-1 truncate text-xs" style={{ color: ui.muted }}>{template.tags.join(" · ")}</p>}
            </div></div>
            </button></div>)}
        </div>
      </section>

      <section className="rounded-3xl p-5 md:p-7" style={{ background: ui.surface }}>
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div><h2 className="text-xl font-bold" style={{ color: ui.text }}>{draft.id ? t("编辑模板", "Edit template") : t("创建模板", "Create template")}</h2><p className="mt-1 text-xs" style={{ color: ui.faint }}>{draft.id ? statusLabel(draft) : t("名称和提示词为必填项", "A name and a prompt are required")}</p></div>
          <div className="flex flex-wrap gap-2">
            {((isManagement && draft.id && draft.approval_status === "pending") || canPublishPrivate) && <button type="button" disabled={busy} onClick={() => void handlePublish()} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: ui.primarySoft, color: ui.primary }}>{t("公开模板", "Publish template")}</button>}
            {draft.id && canEdit && !hiddenByAdministrator && <button type="button" disabled={busy} onClick={() => void handleActiveChange()} className="rounded-xl px-3 py-2 text-sm font-bold" style={{ background: draft.is_active ? ui.dangerSoft : ui.primarySoft, color: draft.is_active ? ui.danger : ui.primary }}>{draft.is_active ? t("下架模板", "Take down") : t("重新启用", "Re-enable")}</button>}
            <button type="button" disabled={busy || !canEdit} onClick={() => void handleSave()} className="rounded-xl px-5 py-2.5 text-sm font-bold disabled:opacity-40" style={{ background: ui.buttonGradient, color: ui.primaryText }}>{saving ? t("保存中…", "Saving…") : draft.id ? t("保存修改", "Save changes") : t("保存并公开", "Save and publish")}</button>
          </div>
        </div>
        {hiddenByAdministrator && <p role="status" className="mb-5 rounded-xl p-3 text-sm" style={{ background: ui.goldSoft, color: ui.gold }}>{t("此模板已被管理员下架。你可以保存修改，但需由管理员重新上架。", "An administrator has taken this template down. You can save edits, but only an administrator can restore it.")}</p>}
        {!canEdit && <p role="status" className="mb-5 rounded-xl p-3 text-sm" style={{ background: ui.goldSoft, color: ui.gold }}>{t("当前模板不可编辑；如果由管理员下架，请联系管理员处理。", "This template cannot be edited. Contact an administrator if it was taken down.")}</p>}
        <fieldset disabled={!canEdit || busy} className="min-w-0 space-y-5 disabled:opacity-70">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t("模板名称", "Template name")} value={draft.scene_name} onChange={(value) => updateDraft("scene_name", value)} placeholder={t("例如：像素风生日贺卡", "Example: Pixel birthday card")} ui={ui} />
            <SelectField label={t("输出类型", "Output type")} value={isDigitalHuman(draft) ? "digital-human" : draft.output_type} onChange={(value) => { if (value !== "digital-human") setDraft((current) => changeTemplateOutputType(current, value)); }} ui={ui} options={[
              { value: "image", label: t("图片", "Image") }, { value: "video", label: t("视频", "Video") },
              ...(isDigitalHuman(draft) ? [{ value: "digital-human", label: t("数字人（已有模板）", "Digital human (existing)") }] : []),
            ]} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-3" style={{ background: ui.surfaceAlt }}><span className="text-sm font-semibold" style={{ color: ui.text }}>{t("生成价格", "Generation price")}</span><span className="font-bold" style={{ color: ui.primary }}>{TEMPLATE_POINTS} {t("积分 / 次 · 统一定价", "points / generation · Fixed price")}</span></div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-bold" style={{ color: ui.text }}>{t("标签", "Tags")}</span><button type="button" onClick={() => {
              const suggested = suggestTemplateTags(draft);
              if (!suggested.length) { toast(t("暂未找到合适标签，可以自己添加。", "No matching tags yet. Add your own tags.")); return; }
              addTags(suggested); toast.success(t("已根据关键词建议标签，可继续修改。", "Tags suggested from keywords. You can edit them."));
            }} className="text-xs font-bold underline" style={{ color: ui.primary }}>{t("从提示词建议标签", "Suggest tags from prompt")}</button></div>
            <div className="mb-3 flex min-h-9 flex-wrap gap-2">{(draft.tags || []).map((tag) => <button key={tag} type="button" aria-label={t(`移除标签 ${tag}`, `Remove tag ${tag}`)} onClick={() => updateDraft("tags", draft.tags.filter((item) => item !== tag))} className="rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: ui.line, color: ui.text, background: ui.surfaceAlt }}>{tag} <span aria-hidden="true">×</span></button>)}</div>
            <div className="grid gap-3 sm:grid-cols-[1fr,1fr,auto]">
              <SelectField label={t("选择已有标签", "Choose a saved tag")} value="" onChange={(value) => value && addTags([value])} ui={ui} options={[{ value: "", label: t("选择标签", "Choose a tag") }, ...tagChoices.map((tag) => ({ value: tag, label: tag }))]} />
              <label className="block"><span className="mb-2 block text-xs font-semibold" style={{ color: ui.faint }}>{t("自定义标签", "Custom tags")}</span><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTags(tagInput); } }} maxLength={200} placeholder={t("输入后添加，下次可直接选", "Add a tag to reuse it later")} className="h-11 w-full rounded-xl border px-3 text-sm outline-none" style={{ background: ui.surfaceAlt, color: ui.text, borderColor: ui.lineStrong }} /></label>
              <button type="button" disabled={!tagInput.trim()} onClick={() => addTags(tagInput)} className="mt-auto h-11 rounded-xl px-4 text-sm font-bold disabled:opacity-40" style={{ background: ui.primarySoft, color: ui.primary }}>{t("添加", "Add")}</button>
            </div>
            <p className="mt-2 text-xs" style={{ color: ui.faint }}>{t("新增标签会保存在当前浏览器；关键词建议不消耗积分。", "New tag choices are saved in this browser. Keyword suggestions do not spend points.")}</p>
          </div>
          <TextAreaField label={t("模板简介（选填）", "Description (optional)")} value={draft.preview_description || ""} onChange={(value) => updateDraft("preview_description", value)} placeholder={t("一句话说明这个模板能生成什么效果，也可以留空。", "Explain the result in one sentence, or leave this blank.")} rows={3} ui={ui} />
          <TextAreaField label={t("模板提示词", "Template prompt")} value={draft.system_prompt || ""} onChange={(value) => updateDraft("system_prompt", value)} placeholder={t("描述主体、风格、背景，以及每次生成都应保留的要求。", "Describe the subject, style, background and requirements to keep for each generation.")} rows={9} ui={ui} />
          <ToggleCard label={t("使用时需要用户上传参考图", "Ask the user for a reference image")} checked={Boolean(draft.requires_reference)} onChange={(value) => updateDraft("requires_reference", value)} ui={ui} t={t} />
          {isManagement && <div className="grid gap-3 md:grid-cols-2"><ToggleCard label={t("市场精选", "Featured in marketplace")} checked={Boolean(draft.is_featured)} onChange={(value) => updateDraft("is_featured", value)} ui={ui} t={t} /><Field label={t("精选排序（数字越小越靠前）", "Featured order (lower first)")} value={draft.featured_order || 0} onChange={(value) => updateDraft("featured_order", value)} type="number" ui={ui} /></div>}
          {isAdmin && <details className="rounded-2xl border p-4" style={{ borderColor: ui.line }}>
            <summary className="cursor-pointer text-sm font-semibold" style={{ color: ui.muted }}>{t("高级配置（管理员）", "Advanced configuration (administrator)")}</summary>
            <p className="mt-2 text-xs leading-5" style={{ color: ui.faint }}>{t("留空时由平台选择可用模型和参数；编辑旧模板会保留原配置。", "Leave routing fields blank for platform defaults. Existing configurations are preserved when editing.")}</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field label={t("模板标识", "Template key")} value={draft.scene_key} onChange={(value) => updateDraft("scene_key", value)} disabled={Boolean(draft.id)} ui={ui} />
              <Field label={t("模型（留空自动选择）", "Model (automatic when blank)")} value={draft.default_model || ""} onChange={(value) => updateDraft("default_model", value)} ui={ui} />
              <Field label={t("供应商（由模型路由决定）", "Provider (from model route)")} value={draft.target_provider || t("自动", "Automatic")} disabled ui={ui} />
              <Field label={t("默认尺寸（留空自动）", "Size (automatic when blank)")} value={draft.default_size || ""} onChange={(value) => updateDraft("default_size", value)} ui={ui} />
              {draft.output_type === "video" && <Field label={t("默认秒数（留空自动）", "Seconds (automatic when blank)")} value={draft.default_seconds} onChange={(value) => updateDraft("default_seconds", value)} type="number" ui={ui} />}
              <Field label={t("列表排序", "List order")} value={draft.display_order || 0} onChange={(value) => updateDraft("display_order", value)} type="number" ui={ui} />
            </div>
            <div className="mt-4 grid gap-4 md:grid-cols-2"><TextAreaField label={t("用户初始输入（选填）", "Starter prompt (optional)")} value={draft.starter_prompt || ""} onChange={(value) => updateDraft("starter_prompt", value)} rows={3} ui={ui} /><TextAreaField label={t("输入框说明（选填）", "Prompt placeholder (optional)")} value={draft.placeholder_text || ""} onChange={(value) => updateDraft("placeholder_text", value)} rows={3} ui={ui} /></div>
          </details>}
        </fieldset>

        <section className="mt-6 border-t pt-6" style={{ borderColor: ui.line }} aria-label={t("模板预览", "Template preview")}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold" style={{ color: ui.text }}>{t("效果预览", "Result preview")}</h3><p className="mt-1 text-xs" style={{ color: ui.faint }}>{draft.id ? t("上传图片或视频展示模板效果。", "Upload an image or video to demonstrate the result.") : t("先保存模板，再上传效果图或预览视频。", "Save the template first, then upload preview media.")}</p></div><button type="button" disabled={!draft.id || !canEdit || busy} onClick={() => fileInputRef.current?.click()} className="rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-40" style={{ background: ui.primarySoft, color: ui.primary }}>{uploading ? t("上传中…", "Uploading…") : draft.output_type === "video" ? t("上传预览素材", "Upload preview media") : t("上传效果图", "Upload preview image")}</button></div>
          <input ref={fileInputRef} type="file" accept={draft.output_type === "video" ? "image/*,video/*,.mp4,.webm,.mov,.m4v,.mkv" : "image/*,.jpg,.jpeg,.png,.webp,.heic,.heif"} className="hidden" onChange={handlePreviewUpload} />
          {(draft.preview_video_url || draft.preview_image_url) && <div className="max-w-lg overflow-hidden rounded-2xl" style={{ background: ui.surfaceAlt }}>{draft.output_type === "video" && draft.preview_video_url ? <OssVideo src={draft.preview_video_url} poster={draft.preview_image_url || undefined} authorize={!isAnonymousTemplateAsset(draft)} controls muted playsInline className="max-h-80 w-full object-contain" /> : <OssImage src={draft.preview_image_url} authorize={!isAnonymousTemplateAsset(draft)} alt={draft.scene_name || t("模板效果图", "Template preview")} className="max-h-80 w-full object-contain" />}</div>}
        </section>
        <details className="mt-6 text-xs" style={{ color: ui.faint }}><summary className="cursor-pointer">{t("导入或导出模板文件", "Import or export a template file")}</summary><div className="mt-3 flex gap-3"><input ref={importInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handleImport} /><button type="button" disabled={busy} onClick={() => importInputRef.current?.click()} className="rounded-lg border px-3 py-2" style={{ borderColor: ui.line }}>{t("导入模板", "Import template")}</button><button type="button" disabled={!draft.id || busy} onClick={() => void handleExport()} className="rounded-lg border px-3 py-2 disabled:opacity-40" style={{ borderColor: ui.line }}>{t("导出当前模板", "Export current template")}</button></div></details>
      </section>
    </div>
  </main>;
};

const Field = ({ label, value, onChange, placeholder, disabled = false, type = "text", ui }) => <label className="block"><span className="mb-2 block text-xs font-semibold" style={{ color: ui.faint }}>{label}</span><input aria-label={label} type={type} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} placeholder={placeholder} disabled={disabled} className="h-11 w-full rounded-xl border px-3 text-sm outline-none disabled:opacity-60" style={{ background: ui.surfaceAlt, borderColor: ui.lineStrong, color: ui.text }} /></label>;
const SelectField = ({ label, value, onChange, options, ui }) => <label className="block"><span className="mb-2 block text-xs font-semibold" style={{ color: ui.faint }}>{label}</span><CanvasRoundedSelect label={label} value={value} onChange={onChange} options={options} ui={ui} className="w-full" triggerClassName="h-11 w-full rounded-xl px-3 text-sm" menuMinWidth={180} /></label>;
const TextAreaField = ({ label, value, onChange, placeholder, rows, ui }) => <label className="block"><span className="mb-2 block text-sm font-semibold" style={{ color: ui.text }}>{label}</span><textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={rows} className="w-full resize-y rounded-xl border px-4 py-3 text-sm leading-6 outline-none" style={{ background: ui.surfaceAlt, color: ui.text, borderColor: ui.lineStrong }} /></label>;
const ToggleCard = ({ label, checked, onChange, ui, t }) => <button type="button" aria-pressed={checked} onClick={() => onChange(!checked)} className="flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left" style={{ borderColor: checked ? ui.primary : ui.line, background: ui.surfaceAlt }}><span className="text-sm" style={{ color: ui.text }}>{label}</span><span className="shrink-0 rounded-full px-2 py-1 text-xs" style={{ background: checked ? ui.primarySoft : ui.surface, color: checked ? ui.primary : ui.faint }}>{checked ? t("开启", "On") : t("关闭", "Off")}</span></button>;

export default TemplateStudio;
