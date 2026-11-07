import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Copy, LockKeyhole, Plus, RefreshCw, Save } from "lucide-react";
import toast from "react-hot-toast";

import WorkflowEditorPanel from "../WorkflowEditorPanel";
import WorkflowRunDialog from "./WorkflowRunDialog";
import useCanvasWorkflows, { EMPTY_DEFINITION } from "../../hooks/useCanvasWorkflows";
import useWorkflowRun from "../../hooks/useWorkflowRun";
import { collectWorkflowRunInputDefinitions } from "../../utils/workflowInputNodes";
import { isWorkflowRunBusy, shouldUnlockWorkflowRun } from "../../utils/workflowRunState";
import CanvasRoundedSelect from "./CanvasRoundedSelect";

const containsMcpCall = (definition) => Array.isArray(definition?.nodes) && definition.nodes.some((node) => (
  ["mcp.call", "mcp.call.external"].includes(String(node?.type || node?.nodeType || node?.node_type || "").trim().toLowerCase())
));

const CanvasWorkflowWorkspace = ({ canvasId, authAxios, legacyWorkflow, canvasTitle, ui, t }) => {
  const manager = useCanvasWorkflows({
    authAxios,
    canvasId,
    legacyWorkflow,
    defaultName: t("画布工作流", "Canvas workflow"),
  });
  const runtime = useWorkflowRun(canvasId);
  const [estimatedPoints, setEstimatedPoints] = useState(null);
  const [pendingRun, setPendingRun] = useState(null);
  const resumedRunRef = useRef("");
  const resumeRuntime = runtime.resume;
  const markWorkflowLock = manager.markLock;
  const waitingApprovalNodes = runtime.progress.nodes.filter((node) => node.status === "waiting_approval");
  const busy = isWorkflowRunBusy(runtime.status, runtime.progress.nodes);
  const locked = Boolean(manager.activeWorkflow?.lock?.locked) || busy;
  const statusLabel = ({
    estimating: t("估算中", "Estimating"),
    creating: t("创建中", "Creating"),
    starting: t("启动中", "Starting"),
    queued: t("排队中", "Queued"),
    pending: t("等待中", "Pending"),
    running: t("运行中", "Running"),
    paused: t("已暂停", "Paused"),
    completed: t("已完成", "Completed"),
    failed: t("失败", "Failed"),
    cancelled: t("已取消", "Cancelled"),
    loading: t("恢复中", "Restoring"),
  })[runtime.status] || runtime.status;

  const selectedValue = manager.activeWorkflow?.id || "__draft__";
  const versionLabel = manager.activeWorkflow
    ? `v${manager.activeWorkflow.version}${manager.dirty ? " *" : ""}`
    : t("未保存", "Unsaved");

  const editDisabledReason = manager.activeWorkflow?.lock?.locked
    ? t("工作流运行或等待审批期间不可修改", "This workflow cannot be edited while running or awaiting approval")
    : "";

  const operationError = manager.error?.message || runtime.error?.message || "";

  useEffect(() => {
    resumedRunRef.current = "";
  }, [canvasId]);

  useEffect(() => {
    const runId = String(manager.activeWorkflow?.lock?.runId || "");
    if (!runId || resumedRunRef.current === runId || runtime.status !== "idle") return;
    resumedRunRef.current = runId;
    void resumeRuntime(runId).catch(() => {});
  }, [manager.activeWorkflow?.lock?.runId, resumeRuntime, runtime.status]);

  useEffect(() => {
    if (!shouldUnlockWorkflowRun(runtime.status, runtime.progress.nodes)) return;
    markWorkflowLock({ locked: false });
  }, [markWorkflowLock, runtime.progress.nodes, runtime.status]);

  const chooseWorkflow = async (workflowId) => {
    if (workflowId === "__draft__") return;
    if (manager.dirty && !window.confirm(t("当前修改尚未保存，确定切换工作流吗？", "Current changes are unsaved. Switch workflows?"))) return;
    await manager.select(workflowId);
    setEstimatedPoints(null);
  };

  const createWorkflow = () => {
    if (manager.dirty && !window.confirm(t("当前修改尚未保存，确定新建工作流吗？", "Current changes are unsaved. Create a new workflow?"))) return;
    manager.newDraft(EMPTY_DEFINITION, t("未命名工作流", "Untitled workflow"));
    runtime.reset();
    setEstimatedPoints(null);
  };

  const saveWorkflow = async (definition) => {
    try {
      const saved = await manager.save(definition ? { definition } : undefined);
      setEstimatedPoints(Number(saved?.estimate?.totalPoints ?? 0));
      toast.success(t("工作流版本已保存", "Workflow version saved"));
      return saved;
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("工作流保存失败", "Unable to save workflow"));
      throw error;
    }
  };

  const startSavedWorkflow = async (saved, hasMcp, runContext = {}) => {
    if (hasMcp && !window.confirm(t(
      "这个工作流包含外部 MCP 工具调用，将使用你自己的已授权账号执行。是否确认启动？",
      "This workflow calls external MCP tools using your connected account. Start it now?",
    ))) return null;
    const data = await runtime.startNamed(saved.id, {
      mcpApprovalConfirmed: hasMcp,
      variables: runContext.variables,
      inputs: runContext.inputs,
    });
    manager.markLock({ locked: true, runId: data?.run?.id, status: data?.run?.status || "queued" });
    toast.success(t("工作流已进入后台队列", "Workflow queued in the background"));
    return data;
  };

  const runWorkflow = async (definition) => {
    if (locked) {
      const runId = manager.activeWorkflow?.lock?.runId;
      if (runId) await runtime.resume(runId);
      return;
    }
    try {
      const saved = manager.dirty || !manager.activeWorkflow
        ? await saveWorkflow(definition)
        : manager.activeWorkflow;
      const estimateResult = await runtime.estimate(saved.definition);
      const nextEstimate = Number(estimateResult?.estimated_points ?? estimateResult?.estimate?.totalPoints ?? 0);
      setEstimatedPoints(nextEstimate);
      const hasMcp = containsMcpCall(saved.definition);
      const inputDefinitions = collectWorkflowRunInputDefinitions(saved.definition);
      if (Object.keys(saved.definition?.variables || {}).length > 0 || Object.keys(inputDefinitions).length > 0) {
        setPendingRun({ saved, hasMcp, estimatedPoints: nextEstimate, inputDefinitions });
        return;
      }
      await startSavedWorkflow(saved, hasMcp);
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("工作流启动失败", "Failed to start workflow"));
    }
  };

  const archiveWorkflow = async () => {
    if (!manager.activeWorkflow || locked) return;
    if (!window.confirm(t(`确定归档“${manager.activeWorkflow.name}”吗？`, `Archive “${manager.activeWorkflow.name}”?`))) return;
    try {
      await manager.archive();
      runtime.reset();
      toast.success(t("工作流已归档", "Workflow archived"));
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("归档失败", "Unable to archive workflow"));
    }
  };

  const saveCopy = async () => {
    try {
      await manager.saveCopy({ name: `${manager.draftName} ${t("副本", "copy")}` });
      runtime.reset();
      toast.success(t("已保存为新工作流", "Saved as a new workflow"));
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("保存副本失败", "Unable to save a copy"));
    }
  };

  const approveNode = async (node) => {
    if (!window.confirm(t(`确认通过“${node?.nodeKey}”并继续执行吗？`, `Approve “${node?.nodeKey}” and continue?`))) return;
    try {
      await runtime.approve(node?.nodeKey);
      toast.success(t("已确认，工作流继续执行", "Approved. The workflow is continuing."));
    } catch (error) {
      toast.error(error.message || t("工作流确认失败", "Failed to approve workflow"));
    }
  };

  const toolbarStyle = useMemo(() => ({ background: ui.panel, borderColor: ui.line, color: ui.text }), [ui]);

  return (
    <div className="relative flex h-full min-h-[620px] flex-col" style={{ background: ui.panelSolid }}>
      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2" style={toolbarStyle}>
        <CanvasRoundedSelect
          label={t("选择工作流", "Select workflow")}
          value={selectedValue}
          onChange={(value) => void chooseWorkflow(value)}
          disabled={manager.loading || busy}
          options={[...(!manager.activeWorkflow ? [{ value: "__draft__", label: t("新工作流草稿", "New workflow draft") }] : []), ...manager.workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))]}
          ui={ui}
          className="max-w-[220px]"
          triggerClassName="h-7 w-full px-2 text-[10px] font-semibold"
          menuMinWidth={240}
        />
        <input
          aria-label={t("工作流名称", "Workflow name")}
          value={manager.draftName}
          onChange={(event) => manager.updateName(event.target.value)}
          disabled={locked || manager.loading}
          className="h-7 min-w-[150px] flex-1 rounded-full border px-2 text-[10px] outline-none disabled:opacity-60"
          style={{ background: ui.soft, borderColor: ui.line, color: ui.text }}
          maxLength={160}
        />
        <span className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[9px]" style={{ background: ui.soft, color: manager.dirty ? ui.gold : ui.faint }} title={t("当前工作流版本", "Current workflow version")}>
          {locked && <LockKeyhole size={10} />}{versionLabel}
        </span>
        <button type="button" onClick={createWorkflow} disabled={busy || manager.saving} className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }} title={t("新建工作流", "New workflow")}><Plus size={13} /></button>
        <button type="button" onClick={() => void saveWorkflow()} disabled={locked || manager.saving || (!manager.dirty && Boolean(manager.activeWorkflow))} className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }} title={t("保存新版本", "Save new version")}><Save size={13} /></button>
        <button type="button" onClick={() => void saveCopy()} disabled={locked || manager.saving} className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }} title={t("另存为新工作流", "Save as a new workflow")}><Copy size={13} /></button>
        <button type="button" onClick={() => void manager.load({ preferredId: manager.activeWorkflow?.id })} disabled={manager.loading || manager.saving || manager.dirty} className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }} title={t("刷新工作流", "Refresh workflows")}><RefreshCw size={13} className={manager.loading ? "animate-spin" : ""} /></button>
        <button type="button" onClick={() => void archiveWorkflow()} disabled={!manager.activeWorkflow || locked || manager.saving} className="inline-flex h-7 w-7 items-center justify-center rounded-full border transition hover:brightness-110 disabled:opacity-40" style={{ borderColor: ui.line, color: ui.muted }} title={t("归档工作流", "Archive workflow")}><Archive size={13} /></button>
      </div>

      {manager.conflict && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-amber-300/20 bg-amber-300/10 px-3 py-2 text-[10px] text-amber-700 dark:text-amber-200">
          <span>{t("服务器上已有更新版本。你的草稿仍然保留。", "A newer server version exists. Your draft is preserved.")}</span>
          <div className="flex gap-2"><button type="button" className="font-semibold underline" onClick={() => void manager.reloadCurrent()}>{t("载入服务器版本", "Load server version")}</button><button type="button" className="font-semibold underline" onClick={() => void saveCopy()}>{t("保存为副本", "Save as copy")}</button></div>
        </div>
      )}
      {operationError && !manager.conflict && <div className="shrink-0 border-b border-rose-300/20 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-500">{operationError}</div>}
      {editDisabledReason && <div className="shrink-0 border-b px-3 py-1.5 text-[9px]" style={{ borderColor: ui.line, color: ui.faint }}>{editDisabledReason}</div>}

      <div className="relative min-h-0 flex-1">
        <WorkflowEditorPanel
          workflow={manager.draft}
          onChange={manager.updateDraft}
          onRun={(definition) => void runWorkflow(definition)}
          running={busy || manager.saving}
          readOnly={locked}
          nodeStatuses={runtime.progress.nodes}
          onRetryNode={(nodeKey) => void runtime.retryNode(nodeKey)}
          estimatedPoints={estimatedPoints ?? undefined}
          catalog={manager.catalog}
          className="h-full rounded-none border-0"
          title={manager.draftName || canvasTitle || t("画布工作流", "Canvas workflow")}
          footerMessage={t("保存会创建不可变版本；运行始终使用已保存版本。", "Saving creates an immutable version; runs always use a saved version.")}
          ui={ui}
        />
        {manager.loading && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/20 text-xs backdrop-blur-[1px]" style={{ color: ui.text }}>{t("正在加载工作流…", "Loading workflows...")}</div>}
        {runtime.status !== "idle" && (
          <div className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-32px)] -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/10 bg-[#11151b]/95 px-3 py-2 text-xs text-white shadow-xl">
            <span className={`material-symbols-outlined text-[16px] ${busy ? "animate-spin text-amber-300" : runtime.status === "completed" ? "text-emerald-300" : "text-rose-300"}`}>{busy ? "progress_activity" : runtime.status === "completed" ? "check_circle" : "error"}</span>
            <span className="whitespace-nowrap">{t("任务状态", "Run status")}: {statusLabel}</span>
            <span className="whitespace-nowrap">{runtime.progress.completed}/{runtime.progress.total} · {runtime.progress.percent}%</span>
            {waitingApprovalNodes.slice(0, 1).map((node) => <button key={node.nodeKey} type="button" onClick={() => void approveNode(node)} className="rounded-full border border-amber-300/35 bg-amber-300/10 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-300/20">{t("确认继续", "Approve")}</button>)}
            {busy && <button type="button" onClick={() => void runtime.cancel().then(() => manager.markLock({ locked: false }))} className="rounded-full border border-white/15 px-2 py-1 text-white/75 hover:bg-white/10">{t("取消", "Cancel")}</button>}
          </div>
        )}
      </div>
      <WorkflowRunDialog
        open={Boolean(pendingRun)}
        workflowName={pendingRun?.saved?.name || manager.draftName}
        variables={pendingRun?.saved?.definition?.variables || {}}
        inputs={pendingRun?.inputDefinitions || {}}
        estimatedPoints={pendingRun?.estimatedPoints}
        onCancel={() => setPendingRun(null)}
        onConfirm={async (runContext) => {
          try {
            const result = await startSavedWorkflow(pendingRun.saved, pendingRun.hasMcp, runContext);
            if (result) setPendingRun(null);
          } catch (error) {
            toast.error(error.response?.data?.message || error.message || t("工作流启动失败", "Failed to start workflow"));
            throw error;
          }
        }}
        t={t}
        ui={ui}
      />
    </div>
  );
};

export default CanvasWorkflowWorkspace;
