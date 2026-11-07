import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, ImagePlus, LoaderCircle, Play, Trash2, X } from "lucide-react";

import { OssImage } from "../OssMedia";
import { getCanvasAssetType, uploadCanvasAsset } from "../../utils/canvasAssetUpload";
import { prepareWorkflowRunFieldDefinitions } from "../../utils/workflowInputNodes";
import CanvasRoundedSelect from "./CanvasRoundedSelect";
import {
  collectWorkflowVariableValues,
  normalizeWorkflowVariableDefinitions,
  workflowVariableDraft,
} from "../../utils/workflowVariables";

const stopPropagation = (event) => event.stopPropagation();

const WorkflowRunDialog = ({ open, workflowName, definition, variables, inputs, canvasId, authAxios, estimatedPoints, onCancel, onConfirm, t, ui }) => {
  const variableDefinitions = useMemo(() => prepareWorkflowRunFieldDefinitions(
    normalizeWorkflowVariableDefinitions(variables),
    definition,
    "variables",
  ), [definition, variables]);
  const inputDefinitions = useMemo(() => prepareWorkflowRunFieldDefinitions(
    normalizeWorkflowVariableDefinitions(inputs),
    definition,
    "inputs",
  ), [definition, inputs]);
  const [drafts, setDrafts] = useState({ variables: {}, inputs: {} });
  const [errors, setErrors] = useState({ variables: {}, inputs: {} });
  const [mediaPreviews, setMediaPreviews] = useState({});
  const [uploadErrors, setUploadErrors] = useState({});
  const [uploadingFields, setUploadingFields] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDrafts({
      variables: Object.fromEntries(Object.entries(variableDefinitions).map(([key, descriptor]) => [key, workflowVariableDraft(descriptor)])),
      inputs: Object.fromEntries(Object.entries(inputDefinitions).map(([key, descriptor]) => [key, workflowVariableDraft(descriptor)])),
    });
    setErrors({ variables: {}, inputs: {} });
    setMediaPreviews({});
    setUploadErrors({});
    setUploadingFields({});
    setSubmitting(false);
  }, [inputDefinitions, open, variableDefinitions]);

  if (!open || typeof document === "undefined") return null;

  const inputStyle = { color: ui.text, background: ui.soft, borderColor: ui.line };
  const updateDraft = (group, key, value) => setDrafts((current) => ({
    ...current,
    [group]: { ...current[group], [key]: value },
  }));
  const uploadReferenceImage = async (event, group, key) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const fieldId = `${group}:${key}`;
    if (getCanvasAssetType(file) !== "image") {
      setUploadErrors((current) => ({ ...current, [fieldId]: t("请选择图片文件", "Choose an image file") }));
      return;
    }
    setUploadingFields((current) => ({ ...current, [fieldId]: true }));
    setUploadErrors((current) => ({ ...current, [fieldId]: "" }));
    try {
      const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const asset = await uploadCanvasAsset({
        client: authAxios,
        file,
        idempotencyKey: `workflow-reference:${canvasId || "canvas"}:${nonce}`,
      });
      if (asset.type !== "image" || !asset.resourceId) throw new Error(t("参考图上传结果无效", "Invalid reference upload result"));
      updateDraft(group, key, `upload:${asset.resourceId}`);
      setMediaPreviews((current) => ({
        ...current,
        [fieldId]: { src: asset.src, title: asset.title || file.name },
      }));
      setErrors((current) => ({ ...current, [group]: { ...current[group], [key]: "" } }));
    } catch (error) {
      setUploadErrors((current) => ({
        ...current,
        [fieldId]: error.response?.data?.message || error.message || t("参考图上传失败", "Reference upload failed"),
      }));
    } finally {
      setUploadingFields((current) => ({ ...current, [fieldId]: false }));
    }
  };
  const submit = async (event) => {
    event.preventDefault();
    const collectedVariables = collectWorkflowVariableValues(variableDefinitions, drafts.variables);
    const collectedInputs = collectWorkflowVariableValues(inputDefinitions, drafts.inputs);
    if (!collectedVariables.valid || !collectedInputs.valid) {
      setErrors({ variables: collectedVariables.errors, inputs: collectedInputs.errors });
      return;
    }
    setErrors({ variables: {}, inputs: {} });
    setSubmitting(true);
    try {
      await onConfirm({ variables: collectedVariables.values, inputs: collectedInputs.values });
    } finally {
      setSubmitting(false);
    }
  };

  const renderFields = (group, definitions, expressionRoot) => Object.entries(definitions).map(([key, descriptor]) => {
    const fieldId = `${group}:${key}`;
    const isImage = descriptor.type === "image";
    const hasMediaValue = Boolean(String(drafts[group]?.[key] || "").trim());
    const mediaPreview = mediaPreviews[fieldId];
    const common = {
      value: drafts[group]?.[key] ?? "",
      onChange: (event) => updateDraft(group, key, event.target.value),
      className: "mt-1 w-full rounded-xl border px-2.5 text-[11px] outline-none",
      style: inputStyle,
      disabled: submitting,
    };
    return (
      <div key={fieldId} className="block text-[10px]" style={{ color: ui.faint }}>
        <span className="flex items-center justify-between"><span>{descriptor.label || key}{descriptor.required && <span className="ml-1 text-rose-400">*</span>}</span>{!isImage && <code className="text-[9px]" style={{ color: ui.gold }}>{expressionRoot}.{key} · {descriptor.type}</code>}</span>
        {descriptor.description && <span className="mt-0.5 block leading-4" style={{ color: ui.muted }}>{descriptor.description}</span>}
        {isImage ? (
          <div className="mt-1.5 rounded-[16px] border p-2.5 shadow-sm" style={{ background: ui.soft, borderColor: errors[group]?.[key] ? "rgba(251,113,133,.55)" : ui.line }}>
            {hasMediaValue ? (
              <div className="flex items-center gap-2.5">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border" style={{ background: ui.panelSolid, borderColor: ui.line }}>
                  {mediaPreview?.src ? <OssImage src={mediaPreview.src} alt="" className="h-full w-full object-cover" /> : <ImagePlus size={18} style={{ color: ui.gold }} />}
                </div>
                <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold" style={{ color: ui.text }}>{mediaPreview?.title || t("已选择参考图", "Reference image selected")}</p><p className="mt-1 leading-4" style={{ color: ui.muted }}>{t("仅用于本次工作流运行", "Used only for this workflow run")}</p></div>
                <button type="button" onClick={() => { updateDraft(group, key, ""); setMediaPreviews((current) => ({ ...current, [fieldId]: null })); }} disabled={submitting || uploadingFields[fieldId]} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border disabled:opacity-45" style={{ borderColor: ui.line, color: ui.muted }} title={t("移除参考图", "Remove reference image")}><Trash2 size={12} /></button>
              </div>
            ) : (
              <label className={`flex min-h-16 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-3 text-[11px] font-semibold transition ${submitting || uploadingFields[fieldId] || !authAxios ? "pointer-events-none opacity-50" : "hover:brightness-110"}`} style={{ borderColor: ui.gold, color: ui.gold, background: ui.panelSolid }}>
                {uploadingFields[fieldId] ? <LoaderCircle size={14} className="animate-spin" /> : <ImagePlus size={14} />}
                {uploadingFields[fieldId] ? t("正在上传参考图", "Uploading reference image") : t("上传参考图", "Upload reference image")}
                <input type="file" accept="image/*" className="sr-only" disabled={submitting || uploadingFields[fieldId] || !authAxios} onChange={(event) => void uploadReferenceImage(event, group, key)} />
              </label>
            )}
            <p className="mt-2 leading-4" style={{ color: ui.muted }}>{t("图片会作为私有素材安全保存，不需要填写元素 ID。", "The image is stored privately; no element ID is needed.")}</p>
          </div>
        ) : descriptor.type === "boolean" ? (
          <CanvasRoundedSelect
            label={descriptor.label || key}
            value={common.value}
            options={[{ value: "", label: t("请选择", "Select") }, { value: "true", label: "true" }, { value: "false", label: "false" }]}
            onChange={(value) => updateDraft(group, key, value)}
            disabled={submitting}
            ui={ui}
            className="w-full"
            triggerClassName={`${common.className} h-8 w-full`}
            menuMinWidth={150}
          />
        ) : ["object", "array"].includes(descriptor.type) ? (
          <textarea {...common} className={`${common.className} min-h-24 resize-y py-2 font-mono`} placeholder={descriptor.type === "array" ? "[]" : "{}"} />
        ) : (
          <input {...common} type={descriptor.type === "number" ? "number" : "text"} className={`${common.className} h-8`} placeholder={descriptor.type === "video" ? t("视频作品 ID 或媒体 URL", "Video creation ID or media URL") : ""} />
        )}
        {errors[group]?.[key] && <span className="mt-1 block text-[10px] text-rose-400">{t("请检查这个输入的值和类型", "Check this input value and type")}</span>}
        {uploadErrors[fieldId] && <span className="mt-1 block text-[10px] text-rose-400">{uploadErrors[fieldId]}</span>}
      </div>
    );
  });

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t("运行工作流", "Run workflow")}
      onPointerDown={stopPropagation}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
    >
      <form onSubmit={submit} className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_80px_rgba(0,0,0,.3)]" style={{ background: ui.panelSolid, borderColor: ui.line, color: ui.text }}>
        <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: ui.line }}>
            <div className="flex min-w-0 items-center gap-2.5"><span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.gold }}><Braces size={14} /></span><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{workflowName}</h3><p className="mt-0.5 text-[10px]" style={{ color: ui.faint }}>{t("填写本次运行所需内容", "Set values for this run")}</p></div></div>
          <button type="button" onClick={onCancel} disabled={submitting} className="flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50" style={{ color: ui.muted }} title={t("取消", "Cancel")}><X size={14} /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {Object.keys(variableDefinitions).length > 0 && <section className="space-y-3"><p className="text-[10px] font-semibold uppercase" style={{ color: ui.muted }}>{t("工作流变量", "Workflow variables")}</p>{renderFields("variables", variableDefinitions, "variables")}</section>}
          {Object.keys(inputDefinitions).length > 0 && <section className="space-y-3"><p className="text-[10px] font-semibold uppercase" style={{ color: ui.muted }}>{t("输入节点", "Input nodes")}</p>{renderFields("inputs", inputDefinitions, "inputs")}</section>}
        </div>

        <footer className="flex items-center justify-between border-t px-4 py-3" style={{ borderColor: ui.line }}>
          <span className="text-[10px]" style={{ color: ui.faint }}>{estimatedPoints == null ? t("启动前会再次检查余额", "Balance is checked before start") : `${t("预计", "Estimated")} ${estimatedPoints} pt`}</span>
          <div className="flex gap-2"><button type="button" onClick={onCancel} disabled={submitting} className="h-8 rounded-full border px-3 text-[11px] transition hover:bg-white/5 disabled:opacity-50" style={{ borderColor: ui.line, color: ui.muted }}>{t("取消", "Cancel")}</button><button type="submit" disabled={submitting} className="inline-flex h-8 items-center gap-1.5 rounded-full bg-amber-300 px-4 text-[11px] font-semibold text-[#18130b] shadow-sm hover:bg-amber-200 disabled:opacity-50"><Play size={12} fill="currentColor" />{submitting ? t("启动中", "Starting") : t("开始运行", "Run")}</button></div>
        </footer>
      </form>
    </div>,
    document.body,
  );
};

export default WorkflowRunDialog;
