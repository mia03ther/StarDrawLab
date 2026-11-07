import { Film, Image as ImageIcon, LoaderCircle, Paperclip, Send, Settings2, Sparkles, Square, X } from "lucide-react";

import { OssImage } from "../OssMedia";
import CanvasIconButton from "./CanvasIconButton";

const CanvasAgentComposer = ({ brief, onBriefChange, onSubmit, onCancel, onOpenTemplates, onOpenModels, selectedTemplate, onRemoveTemplate, selectedReferences = [], selectedCanvasReferenceCount = 0, onAttachSelectedReferences, onRemoveReference, models, activeRun, sending, error, ui, t }) => (
  <div className="shrink-0 border-t px-3 pb-3 pt-2.5" style={{ borderColor: ui.line }}>
    {selectedTemplate && (
      <div className="mb-2 flex items-center gap-2 rounded-[14px] border px-2.5 py-2" style={{ background: ui.soft, borderColor: ui.line }}>
        <Paperclip size={11} style={{ color: ui.gold }} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[10px] font-semibold">{selectedTemplate.preview_title || selectedTemplate.scene_name || selectedTemplate.scene_key}</span>
          <span className="mt-0.5 block truncate text-[9px]" style={{ color: ui.faint }}>{selectedTemplate.output_type === "video" ? t("视频模板", "Video template") : t("图片模板", "Image template")} · {selectedTemplate.default_model || t("默认模型", "Default model")}</span>
        </span>
        <CanvasIconButton label={t("移除模板", "Remove template")} onClick={onRemoveTemplate} style={{ color: ui.faint }}><X size={11} /></CanvasIconButton>
      </div>
    )}
    {selectedReferences.length > 0 && (
      <div className="mb-2 flex gap-1.5 overflow-x-auto pb-0.5" aria-label={t("已附加参考图", "Attached reference images")}>
        {selectedReferences.map((reference) => (
          <div key={reference.elementId} className="group relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border shadow-sm" style={{ background: ui.soft, borderColor: ui.line }} title={reference.title}>
            <OssImage src={reference.previewUrl} authorize alt={reference.title} className="h-full w-full object-cover" />
            <button type="button" onClick={() => onRemoveReference(reference.elementId)} aria-label={t(`移除参考图 ${reference.title}`, `Remove reference ${reference.title}`)} className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"><X size={9} /></button>
          </div>
        ))}
      </div>
    )}
    {error && <p className="mb-2 rounded-[14px] px-2.5 py-2 text-[10px] leading-4" style={{ background: ui.dangerSoft, color: ui.danger }}>{error}</p>}
    <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }} className="rounded-[20px] border p-2.5 shadow-lg transition-colors" style={{ background: ui.inspectorInput, borderColor: activeRun ? ui.goldLine : ui.line2 || ui.line, boxShadow: ui.inputInset }}>
      <textarea value={brief} onChange={(event) => onBriefChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }} rows={3} className="max-h-40 min-h-[58px] w-full resize-none bg-transparent px-1 py-1 text-xs leading-5 outline-none" placeholder={t("告诉画布 Agent 要创建、调整或执行什么…", "Tell the Canvas Agent what to create, change, or run...")} style={{ color: ui.text }} />
      <div className="flex items-end justify-between gap-2 pt-1">
        <div className="flex min-w-0 items-center gap-1">
          <CanvasIconButton label={t("从模板市场选择", "Choose from templates")} onClick={onOpenTemplates} style={{ background: ui.soft, color: ui.muted }}><Sparkles size={12} /></CanvasIconButton>
          <CanvasIconButton label={selectedCanvasReferenceCount > 0 ? t(`附加选中的 ${selectedCanvasReferenceCount} 张图片`, `Attach ${selectedCanvasReferenceCount} selected image(s)`) : t("先在画布中选择参考图", "Select reference images on the canvas first")} onClick={onAttachSelectedReferences} disabled={selectedCanvasReferenceCount === 0 || selectedReferences.length >= 4 || activeRun} style={{ background: ui.soft, color: selectedCanvasReferenceCount > 0 ? ui.gold : ui.faint }}><Paperclip size={12} /></CanvasIconButton>
          <CanvasIconButton label={t("设置默认模型", "Set default models")} onClick={onOpenModels} style={{ background: ui.soft, color: ui.muted }}><Settings2 size={12} /></CanvasIconButton>
          <span className="ml-1 hidden min-w-0 items-center gap-1 text-[9px] lg:flex" style={{ color: ui.faint }}><ImageIcon size={9} /><span className="max-w-20 truncate">{models?.imageModel || "-"}</span><Film size={9} className="ml-1" /><span className="max-w-20 truncate">{models?.videoModel || "-"}</span></span>
        </div>
      <div className="flex items-center gap-1">
          {activeRun && <CanvasIconButton label={t("停止运行", "Stop run")} onClick={onCancel} style={{ background: ui.soft, color: ui.danger }}><Square size={10} fill="currentColor" /></CanvasIconButton>}
          <CanvasIconButton label={t("发送", "Send")} type="submit" disabled={!brief.trim() || activeRun || sending} style={{ background: ui.accent, color: ui.accentText }}>{sending ? <LoaderCircle size={12} className="animate-spin" /> : <Send size={12} />}</CanvasIconButton>
        </div>
      </div>
    </form>
    <div className="mt-1.5 flex items-center justify-between gap-2 px-1 text-[9px]" style={{ color: ui.faint }}><span>{activeRun ? t("正在观察工具结果并决定下一步", "Observing results before the next action") : t("Enter 发送 · Shift+Enter 换行", "Enter send · Shift+Enter newline")}</span><span className="truncate">{models?.textModel || "GPT"}</span></div>
  </div>
);

export default CanvasAgentComposer;
