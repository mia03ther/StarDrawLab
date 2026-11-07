import { createPortal } from "react-dom";
import { Check, ChevronUp, LoaderCircle, PauseCircle, ShieldCheck } from "lucide-react";

const stopPropagation = (event) => event.stopPropagation();

const WorkflowApprovalDialog = ({
  approval,
  minimized,
  submitting,
  workflowName,
  onMinimize,
  onExpand,
  onApprove,
  t,
  ui,
}) => {
  if (!approval || typeof document === "undefined") return null;

  if (minimized) {
    return createPortal(
      <div
        data-workflow-approval-notice="true"
        className="fixed left-1/2 top-[84px] z-[310] flex w-[min(560px,calc(100vw-24px))] -translate-x-1/2 items-center gap-2 rounded-full border px-3.5 py-2.5 shadow-[0_16px_48px_rgba(0,0,0,.26)] backdrop-blur-2xl"
        style={{ background: ui.panelSolid, borderColor: ui.goldLine, color: ui.text }}
        role="status"
        aria-live="polite"
        onPointerDown={stopPropagation}
        onMouseDown={stopPropagation}
      >
        <PauseCircle size={15} className="shrink-0" style={{ color: ui.gold }} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold">{t("工作流等待确认", "Workflow needs approval")}</p>
          <p className="truncate text-[10px]" style={{ color: ui.faint }}>{approval.title}</p>
        </div>
        <button type="button" onClick={onExpand} className="flex h-8 items-center gap-1 rounded-full border px-2.5 text-[10px] font-semibold" style={{ borderColor: ui.line, color: ui.muted }}>
          <ChevronUp size={11} />{t("查看", "Review")}
        </button>
        <button type="button" onClick={onApprove} disabled={submitting} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[10px] font-semibold shadow-sm disabled:opacity-50" style={{ background: ui.accent, color: ui.accentText }}>
          {submitting ? <LoaderCircle size={12} className="animate-spin" /> : <Check size={12} />}
          {submitting ? t("确认中", "Approving") : t("确认继续", "Approve")}
        </button>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      data-workflow-approval-dialog="true"
      className="fixed inset-0 z-[310] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-approval-title"
      onPointerDown={stopPropagation}
      onMouseDown={stopPropagation}
      onTouchStart={stopPropagation}
    >
      <section className="flex max-h-[82dvh] w-full max-w-xl flex-col overflow-hidden rounded-[24px] border shadow-[0_24px_80px_rgba(0,0,0,.3)]" style={{ background: ui.panelSolid, borderColor: ui.goldLine, color: ui.text }}>
        <header className="flex items-start gap-3 border-b px-4 py-4" style={{ borderColor: ui.line }}>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}><ShieldCheck size={17} /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold" style={{ color: ui.gold }}>{t("工作流已暂停", "Workflow paused")}</p>
            <h2 id="workflow-approval-title" className="mt-1 text-[15px] font-semibold leading-5">{approval.title}</h2>
            {workflowName && <p className="mt-1 truncate text-[10px]" style={{ color: ui.faint }}>{workflowName}</p>}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <p className="whitespace-pre-wrap break-words text-[12px] leading-6" style={{ color: ui.muted }}>{approval.message}</p>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3" style={{ borderColor: ui.line }}>
          <p className="text-[10px]" style={{ color: ui.faint }}>{t("只有确认后，后续节点才会继续运行。", "Later nodes run only after your approval.")}</p>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onMinimize} disabled={submitting} className="h-9 rounded-full border px-3 text-[11px] font-semibold transition hover:bg-white/5 disabled:opacity-50" style={{ borderColor: ui.line, color: ui.muted }}>
              {t("返回画布检查", "Review canvas")}
            </button>
            <button type="button" onClick={onApprove} disabled={submitting} className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[11px] font-semibold shadow-sm disabled:opacity-50" style={{ background: ui.accent, color: ui.accentText }}>
              {submitting ? <LoaderCircle size={13} className="animate-spin" /> : <Check size={13} />}
              {submitting ? t("正在继续", "Continuing") : t("确认并继续", "Approve and continue")}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
};

export default WorkflowApprovalDialog;
