import { Check, CircleAlert, Clock3, Eye, LoaderCircle, Play, Square, Wrench } from "lucide-react";

import GenerationErrorMessage from "../GenerationErrorMessage";
import { getAgentToolLabel, getAgentCallDisplayStatus } from "../../utils/agentExecutionView";

const ACTIVE = new Set(["queued", "running", "waiting_external", "waiting_approval"]);

const statusLabel = (status, t) => ({
  stopped: t("已停止", "Stopped"),
  ready: t("准备", "Ready"),
  queued: t("排队", "Queued"),
  running: t("执行中", "Running"),
  waiting_external: t("等待结果", "Waiting"),
  waiting_approval: t("等待确认", "Approval"),
  completed: t("完成", "Done"),
  failed: t("失败", "Failed"),
  cancelled: t("已取消", "Cancelled"),
}[status] || status);

const StepIcon = ({ status, color }) => {
  if (["running", "queued", "waiting_external"].includes(status)) return <LoaderCircle size={12} className="animate-spin" style={{ color }} />;
  if (status === "completed") return <Check size={12} style={{ color: "#35c981" }} />;
  if (status === "failed") return <CircleAlert size={12} style={{ color }} />;
  if (status === "waiting_approval") return <Clock3 size={12} style={{ color }} />;
  return <Wrench size={12} style={{ color }} />;
};

const resultPreview = (result, t) => {
  if (!result || typeof result !== "object") return "";
  if (result.status) return `${t("状态", "Status")}: ${statusLabel(result.status, t)}`;
  if (result.creationId || result.creation_id) return `${t("任务", "Task")}: ${result.creationId || result.creation_id}`;
  if (result.workflowId || result.id) return `${t("结果", "Result")}: ${result.workflowId || result.id}`;
  if (result.preferences) return t("模型设置已更新", "Model preferences updated");
  return t("工具已返回结果", "Tool returned an observation");
};

const CanvasAgentRunTimeline = ({ run, onApprove, onCancel, ui, t }) => {
  if (!run) return null;
  const approval = ACTIVE.has(run.status) ? run.steps?.find((step) => step.status === "waiting_approval") : null;
  const isActive = ACTIVE.has(run.status);

  return (
    <section className="overflow-hidden rounded-[18px] border shadow-lg" style={{ background: ui.soft, borderColor: approval ? ui.goldLine : ui.line }} aria-label={t("Agent 实时运行", "Live Agent run")}>
      <header className="flex items-center justify-between gap-3 border-b px-3 py-2.5" style={{ borderColor: ui.line }}>
        <span className="flex min-w-0 items-center gap-2">
          <LoaderCircle size={13} className={isActive ? "animate-spin" : ""} style={{ color: ui.gold }} />
          <span className="truncate text-[11px] font-semibold">{statusLabel(run.status, t)}</span>
        </span>
        <span className="text-[10px] tabular-nums" style={{ color: ui.faint }}>{run.progress || 0}%</span>
      </header>
      <div className="h-0.5" style={{ background: ui.line }}><div className="h-full transition-[width] duration-500" style={{ width: `${run.progress || 0}%`, background: ui.gold }} /></div>
      <div className="max-h-64 space-y-1 overflow-y-auto p-2">
        {(run.steps || []).map((step) => (
          <div key={step.id} className="rounded-[14px] px-2.5 py-2" style={{ background: ui.panelTranslucent || ui.panel }}>
            <div className="flex items-center gap-2">
              <StepIcon status={getAgentCallDisplayStatus(step, run.status)} color={step.status === "failed" ? ui.danger : ui.gold} />
              <span className="min-w-0 flex-1 truncate text-[10px] font-semibold">{getAgentToolLabel(step, t("zh", "en"))}</span>
              <span className="text-[9px]" style={{ color: step.status === "failed" ? ui.danger : ui.faint }}>{statusLabel(getAgentCallDisplayStatus(step, run.status), t)}</span>
            </div>
            {step.thought && <p className="mt-1 pl-5 text-[10px] leading-4" style={{ color: ui.muted }}>{step.thought}</p>}
            {step.result && <p className="mt-1 flex items-center gap-1.5 pl-5 text-[9px]" style={{ color: ui.faint }}><Eye size={10} />{resultPreview(step.result, t)}</p>}
            {step.errorMessage && <div className="mt-1 pl-5 text-[10px] leading-4" style={{ color: ui.danger }}><GenerationErrorMessage error={step.errorMessage} t={t} /></div>}
          </div>
        ))}
      </div>
      {approval && <div className="border-t p-2" style={{ borderColor: ui.line }}><button type="button" onClick={() => void onApprove(approval.id)} className="flex h-8 w-full items-center justify-center gap-1.5 rounded-full text-[11px] font-semibold shadow-sm" style={{ background: ui.gold, color: ui.accentText }}><Play size={11} fill="currentColor" />{t("确认此工具调用并继续", "Approve this tool call")}</button></div>}
      {isActive && <button type="button" onClick={onCancel} className="flex h-7 w-full items-center justify-center gap-1 border-t text-[9px]" style={{ borderColor: ui.line, color: ui.faint }}><Square size={9} fill="currentColor" />{t("停止运行", "Stop run")}</button>}
    </section>
  );
};

export default CanvasAgentRunTimeline;
