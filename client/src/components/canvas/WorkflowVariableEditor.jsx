import { useEffect, useMemo, useState } from "react";
import { Braces, Plus, Trash2, X } from "lucide-react";

import {
  normalizeWorkflowVariableDefinitions,
  parseWorkflowVariableDraft,
  WORKFLOW_VARIABLE_TYPES,
  workflowVariableDraft,
} from "../../utils/workflowVariables";
import CanvasRoundedSelect from "./CanvasRoundedSelect";

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;

const DefaultField = ({ variableKey, descriptor, disabled, onChange, t, inputStyle }) => {
  const [draft, setDraft] = useState(() => workflowVariableDraft(descriptor));
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(workflowVariableDraft(descriptor));
    setError("");
  }, [descriptor]);

  const commit = (nextDraft) => {
    setDraft(nextDraft);
    const parsed = parseWorkflowVariableDraft(nextDraft, { ...descriptor, required: false }, variableKey);
    if (parsed.error) {
      setError(t("默认值格式不正确", "Invalid default value"));
      return;
    }
    setError("");
    onChange(parsed.value);
  };

  if (descriptor.type === "boolean") {
    return (
      <CanvasRoundedSelect label={t("默认值", "Default")} value={draft} disabled={disabled} onChange={commit} options={[{ value: "", label: t("无默认值", "No default") }, { value: "true", label: "true" }, { value: "false", label: "false" }]} ui={{ ...inputStyle, soft: inputStyle?.background, panelStrong: inputStyle?.background }} className="w-full" triggerClassName="h-8 w-full rounded-xl px-2 text-[10px]" style={inputStyle} menuMinWidth={150} />
    );
  }

  if (["object", "array"].includes(descriptor.type)) {
    return (
      <div>
        <textarea value={draft} disabled={disabled} onChange={(event) => commit(event.target.value)} className="min-h-20 w-full resize-y rounded-xl border px-2 py-1.5 font-mono text-[10px] outline-none disabled:opacity-55" style={inputStyle} placeholder={descriptor.type === "array" ? "[]" : "{}"} />
        {error && <p className="mt-1 text-[9px] text-rose-400">{error}</p>}
      </div>
    );
  }

  return <input type={descriptor.type === "number" ? "number" : "text"} value={draft} disabled={disabled} onChange={(event) => commit(event.target.value)} className="h-8 w-full rounded-xl border px-2 text-[10px] outline-none disabled:opacity-55" style={inputStyle} placeholder={["image", "video"].includes(descriptor.type) ? t("作品 ID 或媒体 URL", "Creation ID or media URL") : t("无默认值", "No default")} />;
};

const WorkflowVariableEditor = ({ open, variables, onChange, onClose, readOnly = false, t, ui }) => {
  const variableTypeLabels = { string: t("文字", "string"), number: t("数字", "number"), integer: t("整数", "integer"), boolean: t("布尔值", "boolean"), object: t("对象", "object"), array: t("数组", "array") };
  const normalized = useMemo(() => normalizeWorkflowVariableDefinitions(variables), [variables]);
  const [keyError, setKeyError] = useState("");
  const inputStyle = { color: ui.text, background: ui.soft, borderColor: ui.line };

  if (!open) return null;

  const update = (key, patch) => onChange({
    ...normalized,
    [key]: { ...normalized[key], ...patch },
  });

  const addVariable = () => {
    let index = Object.keys(normalized).length + 1;
    while (normalized[`variable_${index}`]) index += 1;
    onChange({
      ...normalized,
      [`variable_${index}`]: {
        type: "string",
        label: t(`变量 ${index}`, `Variable ${index}`),
        description: "",
        default: null,
        required: false,
      },
    });
  };

  const rename = (oldKey, nextValue) => {
    const nextKey = String(nextValue || "").trim();
    if (!KEY_PATTERN.test(nextKey)) {
      setKeyError(t("变量键必须以英文字母开头，只能包含字母、数字、点、横线、下划线或冒号", "Keys must start with a letter and contain only letters, numbers, dot, dash, underscore, or colon"));
      return;
    }
    if (nextKey !== oldKey && normalized[nextKey]) {
      setKeyError(t("变量键不能重复", "Variable keys must be unique"));
      return;
    }
    setKeyError("");
    if (nextKey === oldKey) return;
    onChange(Object.fromEntries(Object.entries(normalized).map(([key, descriptor]) => [key === oldKey ? nextKey : key, descriptor])));
  };

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t("工作流变量", "Workflow variables")}>
      <div className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-[24px] border shadow-2xl" style={{ background: ui.panelSolid, borderColor: ui.line, color: ui.text }}>
        <header className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: ui.line }}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.gold }}><Braces size={14} /></span>
            <div><h3 className="text-xs font-semibold">{t("工作流变量", "Workflow variables")}</h3><p className="mt-0.5 text-[9px]" style={{ color: ui.faint }}>{t("在节点中使用 ${variables.key} 或 ${inputs.key}", "Use ${variables.key} or ${inputs.key} in nodes")}</p></div>
          </div>
          <button type="button" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full hover:brightness-110" style={{ color: ui.muted }} title={t("关闭", "Close")}><X size={14} /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {keyError && <p className="mb-3 rounded-2xl border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-400">{keyError}</p>}
          {Object.keys(normalized).length === 0 ? (
            <div className="flex min-h-36 flex-col items-center justify-center border-y text-center" style={{ borderColor: ui.line, color: ui.faint }}><Braces size={20} /><p className="mt-2 text-[10px]">{t("这个工作流还没有运行变量", "This workflow has no run variables")}</p></div>
          ) : (
            <div className="divide-y" style={{ borderColor: ui.line }}>
              {Object.entries(normalized).map(([key, descriptor]) => (
                <fieldset key={key} disabled={readOnly} className="grid gap-2 py-3 disabled:opacity-65 md:grid-cols-[150px_120px_1fr_28px]">
                  <label className="text-[9px]" style={{ color: ui.faint }}>{t("变量键", "Key")}<input defaultValue={key} onBlur={(event) => rename(key, event.target.value)} className="mt-1 h-8 w-full rounded-xl border px-2 font-mono text-[10px] outline-none" style={inputStyle} /></label>
                  <label className="text-[9px]" style={{ color: ui.faint }}>{t("类型", "Type")}<CanvasRoundedSelect label={t("类型", "Type")} value={descriptor.type} onChange={(value) => update(key, { type: value, default: null })} options={WORKFLOW_VARIABLE_TYPES.map((type) => ({ value: type, label: variableTypeLabels[type] || type }))} ui={{ ...ui, soft: inputStyle.background, panelStrong: inputStyle.background }} className="mt-1 w-full" triggerClassName="h-8 w-full rounded-xl px-2 text-[10px]" style={inputStyle} menuMinWidth={140} /></label>
                  <label className="text-[9px]" style={{ color: ui.faint }}>{t("显示名称", "Label")}<input value={descriptor.label} onChange={(event) => update(key, { label: event.target.value.slice(0, 160) })} className="mt-1 h-8 w-full rounded-xl border px-2 text-[10px] outline-none" style={inputStyle} /></label>
                  <button type="button" onClick={() => onChange(Object.fromEntries(Object.entries(normalized).filter(([itemKey]) => itemKey !== key)))} className="mt-4 flex h-8 w-7 items-center justify-center rounded-full text-rose-400 hover:bg-rose-400/10" title={t("删除变量", "Delete variable")}><Trash2 size={13} /></button>
                  <label className="text-[9px] md:col-span-2" style={{ color: ui.faint }}>{t("默认值", "Default")}<div className="mt-1"><DefaultField variableKey={key} descriptor={descriptor} disabled={readOnly} onChange={(value) => update(key, { default: value })} t={t} inputStyle={inputStyle} /></div></label>
                  <label className="text-[9px]" style={{ color: ui.faint }}>{t("说明", "Description")}<textarea value={descriptor.description} onChange={(event) => update(key, { description: event.target.value.slice(0, 500) })} className="mt-1 min-h-20 w-full resize-y rounded-xl border px-2 py-1.5 text-[10px] outline-none" style={inputStyle} /></label>
                  <label className="mt-5 flex h-8 items-center justify-center gap-1.5 text-[9px]" style={{ color: ui.muted }}><input type="checkbox" checked={descriptor.required} onChange={(event) => update(key, { required: event.target.checked })} />{t("必填", "Required")}</label>
                </fieldset>
              ))}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t px-4 py-3" style={{ borderColor: ui.line }}>
          <span className="text-[9px]" style={{ color: ui.faint }}>{Object.keys(normalized).length}/100</span>
          <div className="flex gap-2">
            <button type="button" onClick={addVariable} disabled={readOnly || Object.keys(normalized).length >= 100} className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[10px] font-medium disabled:opacity-45" style={{ borderColor: ui.line, color: ui.muted }}><Plus size={13} />{t("添加变量", "Add variable")}</button>
            <button type="button" onClick={onClose} className="h-8 rounded-full bg-amber-300 px-4 text-[10px] font-semibold text-[#18130b] hover:bg-amber-200">{t("完成", "Done")}</button>
          </div>
        </footer>
      </div>
    </div>
  );
};

export default WorkflowVariableEditor;
