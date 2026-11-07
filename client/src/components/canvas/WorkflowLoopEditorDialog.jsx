import { Check, X } from "lucide-react";

const WorkflowLoopEditorDialog = ({ open, title, subtitle, onClose, children, t }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[230] flex items-center justify-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm" onClick={onClose} aria-label={t("关闭循环体编辑器", "Close loop editor")} />
      <section className="relative z-10 flex h-[min(880px,calc(100vh-28px))] w-full max-w-[1480px] flex-col overflow-hidden rounded-[24px] border shadow-2xl" style={{ background: "var(--wf-bg)", borderColor: "var(--wf-line)", color: "var(--wf-text)" }}>
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b px-4" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line)" }}>
          <div className="min-w-0">
            <h3 className="truncate text-xs font-semibold">{title}</h3>
            <p className="mt-0.5 truncate text-[9px]" style={{ color: "var(--wf-faint)" }}>{subtitle}</p>
          </div>
          <button type="button" onClick={onClose} className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10px] font-medium transition hover:brightness-110" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-muted)" }}><Check size={12} />{t("完成", "Done")}<span className="sr-only"><X size={12} /></span></button>
        </header>
        <div className="min-h-0 flex-1">{children}</div>
      </section>
    </div>
  );
};

export default WorkflowLoopEditorDialog;
