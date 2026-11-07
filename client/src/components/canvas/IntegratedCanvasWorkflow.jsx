import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity,
  Archive,
  GitBranch,
  LockKeyhole,
  Maximize2,
  GripVertical,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import toast from "react-hot-toast";

import WorkflowEditorPanel from "../WorkflowEditorPanel";
import useCanvasWorkflows, { EMPTY_DEFINITION } from "../../hooks/useCanvasWorkflows";
import useWorkflowRun from "../../hooks/useWorkflowRun";
import { collectWorkflowRunInputDefinitions } from "../../utils/workflowInputNodes";
import { isWorkflowRunBusy, shouldUnlockWorkflowRun } from "../../utils/workflowRunState";
import { collectWorkflowCanvasMediaResults } from "../../utils/workflowCanvasResults";
import { deriveWorkflowEdges } from "../../utils/workflowEdges";
import { getWaitingWorkflowApproval } from "../../utils/workflowApproval";
import WorkflowApprovalDialog from "./WorkflowApprovalDialog";
import WorkflowRunDialog from "./WorkflowRunDialog";
import CanvasRoundedSelect from "./CanvasRoundedSelect";

const NODE_WIDTH = 228;
const NODE_HEIGHT = 112;
const CONDITION_TYPES = new Set(["condition.rule", "condition.ai"]);
const RETRYABLE_STATUSES = new Set(["failed", "insufficient_points"]);

const containsMcpCall = (definition) => Array.isArray(definition?.nodes) && definition.nodes.some((node) => (
  ["mcp.call", "mcp.call.external"].includes(String(node?.type || node?.nodeType || node?.node_type || "").trim().toLowerCase())
));

const nodeKey = (node) => String(node?.id || node?.nodeKey || node?.node_key || "");
const nodeType = (node) => String(node?.type || node?.nodeType || node?.node_type || "").trim().toLowerCase();
const edgeFrom = (edge) => String(edge?.from || edge?.source || "");
const edgeTo = (edge) => String(edge?.to || edge?.target || "");
const clampScale = (value) => Math.max(0.05, Number(value) || 1);

const statusTone = (status, ui) => {
  if (["completed", "skipped"].includes(status)) return { color: "#22a56f", background: "rgba(34,165,111,.12)", border: "rgba(34,165,111,.24)" };
  if (["failed", "insufficient_points"].includes(status)) return { color: ui.danger, background: ui.dangerSoft, border: ui.dangerLine };
  if (["running", "queued", "pending"].includes(status)) return { color: ui.gold, background: ui.goldSoft, border: ui.goldLine };
  if (status === "waiting_approval") return { color: "#d97706", background: "rgba(217,119,6,.12)", border: "rgba(217,119,6,.26)" };
  return { color: ui.faint, background: ui.soft, border: ui.line };
};

const workflowStatusLabel = (status, t) => ({ completed: t("已完成", "completed"), failed: t("失败", "failed"), paused: t("已暂停", "paused"), waiting_approval: t("等待确认", "waiting_approval"), running: t("执行中", "running"), queued: t("排队中", "queued"), pending: t("等待中", "pending"), skipped: t("已跳过", "skipped") }[status] || status || "—");

const nodeIcon = (type) => {
  if (type.startsWith("image.")) return "image";
  if (type.startsWith("video.")) return "movie";
  if (type.startsWith("condition.")) return "alt_route";
  if (type.startsWith("loop.")) return "repeat";
  if (type === "merge") return "merge";
  if (type === "approval.wait") return "approval";
  if (type.startsWith("mcp.")) return "hub";
  if (type.startsWith("canvas.")) return "gesture";
  if (type.startsWith("storyboard.")) return "view_carousel";
  if (type.startsWith("template.")) return "dashboard_customize";
  if (type.startsWith("agent.")) return "auto_awesome";
  return "data_object";
};

const summarizeConfig = (node, t) => {
  const config = node?.config || {};
  const type = nodeType(node);
  if (type === "image.generate" || type === "video.generate") return config.prompt || config.sceneKey || t("等待填写提示词", "Prompt not set");
  if (type.startsWith("condition.")) return config.prompt || `${config.left || "?"} ${config.operator || "equals"} ${String(config.right ?? "?")}`;
  if (type === "loop.foreach") return `${config.itemsExpression || "items"} · max ${config.maxIterations || 20}`;
  if (type === "loop.repeat_until") return `${t("直到条件成立", "Until matched")} · max ${config.maxIterations || 20}`;
  if (type === "approval.wait") return config.message || t("等待人工确认", "Wait for approval");
  if (type === "mcp.call") return config.tool || t("外部 MCP 工具", "External MCP tool");
  if (type === "agent.call") return config.prompt || t("文本模型调用", "Text model call");
  return node?.title || type;
};

const definitionWithNode = (definition, node) => ({
  ...definition,
  nodes: [...(definition.nodes || []), node],
});

const definitionWithoutNode = (definition, id) => ({
  ...definition,
  nodes: (definition.nodes || []).filter((node) => nodeKey(node) !== id),
  edges: (definition.edges || []).filter((edge) => edgeFrom(edge) !== id && edgeTo(edge) !== id),
});

const defaultConfig = (catalogNode) => Object.fromEntries(Object.entries(catalogNode?.fields || {}).flatMap(([key, field]) => (
  field?.default == null ? [] : [[key, field.default]]
)));

const IntegratedCanvasWorkflow = ({
  canvasId,
  authAxios,
  legacyWorkflow,
  canvasTitle,
  viewport,
  boardSize,
  visible,
  revisionEpoch = 0,
  ui,
  t,
  onVisibilityChange,
  onCanvasResult,
  canvasElements = [],
}) => {
  const manager = useCanvasWorkflows({
    authAxios,
    canvasId,
    legacyWorkflow,
    defaultName: t("画布工作流", "Canvas workflow"),
  });
  const runtime = useWorkflowRun(canvasId);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTargetNodeId, setEditorTargetNodeId] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [connecting, setConnecting] = useState(null);
  const [estimatedPoints, setEstimatedPoints] = useState(null);
  const [pendingRun, setPendingRun] = useState(null);
  const [approvalMinimized, setApprovalMinimized] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  const lastRevisionRef = useRef(revisionEpoch);
  const resumedRunRef = useRef("");
  const notifiedCanvasResultsRef = useRef(new Set());

  const busy = isWorkflowRunBusy(runtime.status, runtime.progress.nodes);
  const locked = Boolean(manager.activeWorkflow?.lock?.locked) || busy;
  const scale = clampScale(viewport?.scale);
  const nodes = useMemo(() => manager.draft?.nodes || [], [manager.draft?.nodes]);
  const edges = useMemo(() => deriveWorkflowEdges({
    nodes,
    edges: manager.draft?.edges,
  }), [manager.draft?.edges, nodes]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [nodeKey(node), node])), [nodes]);
  const catalogMap = useMemo(() => new Map((manager.catalog || []).map((item) => [item.type, item])), [manager.catalog]);
  const canvasMedia = useMemo(() => canvasElements
    .filter((element) => ["image", "video"].includes(element?.type) && element?.id)
    .map((element) => ({
      id: element.id,
      type: element.type,
      title: element.title || "",
      src: element.src || "",
      poster: element.poster || "",
    })), [canvasElements]);
  const statusMap = useMemo(() => new Map((runtime.progress.nodes || []).map((item) => [item.nodeKey, item])), [runtime.progress.nodes]);
  const waitingApproval = useMemo(() => getWaitingWorkflowApproval({
    runtimeNodes: runtime.progress.nodes,
    definition: manager.draft,
  }), [manager.draft, runtime.progress.nodes]);
  const activeWorkflowId = manager.activeWorkflow?.id || "";
  const activeRunId = String(manager.activeWorkflow?.lock?.runId || "");
  const loadWorkflows = manager.load;
  const markWorkflowLock = manager.markLock;
  const resumeRuntime = runtime.resume;

  useEffect(() => {
    if (lastRevisionRef.current === revisionEpoch) return;
    lastRevisionRef.current = revisionEpoch;
    if (!manager.dirty) void loadWorkflows({ preferredId: activeWorkflowId }).catch(() => {});
  }, [activeWorkflowId, loadWorkflows, manager.dirty, revisionEpoch]);

  useEffect(() => {
    if (!activeRunId || resumedRunRef.current === activeRunId || runtime.status !== "idle") return;
    resumedRunRef.current = activeRunId;
    void resumeRuntime(activeRunId).catch(() => {});
  }, [activeRunId, resumeRuntime, runtime.status]);

  useEffect(() => {
    if (!shouldUnlockWorkflowRun(runtime.status, runtime.progress.nodes)) return;
    markWorkflowLock({ locked: false });
  }, [markWorkflowLock, runtime.progress.nodes, runtime.status]);

  useEffect(() => {
    setConnecting(null);
    setSelectedNodeId("");
  }, [manager.activeWorkflow?.id]);

  useEffect(() => {
    notifiedCanvasResultsRef.current.clear();
  }, [canvasId]);

  useEffect(() => {
    if (!waitingApproval) setApprovalMinimized(false);
  }, [waitingApproval]);

  useEffect(() => {
    if (typeof onCanvasResult !== "function") return;
    collectWorkflowCanvasMediaResults(runtime.progress.nodes).forEach((mediaResult, index) => {
      if (notifiedCanvasResultsRef.current.has(mediaResult.key)) return;
      notifiedCanvasResultsRef.current.add(mediaResult.key);
      const sourceNode = nodeMap.get(mediaResult.nodeKey);
      onCanvasResult({
        ...mediaResult,
        ordinal: index,
        anchor: sourceNode ? {
          x: Number(sourceNode.x) || 0,
          y: Number(sourceNode.y) || 0,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        } : null,
      });
    });
  }, [nodeMap, onCanvasResult, runtime.progress.nodes]);

  const chooseWorkflow = async (workflowId) => {
    if (manager.dirty && !window.confirm(t("当前工作流有未保存修改，确定切换吗？", "This workflow has unsaved changes. Switch anyway?"))) return;
    await manager.select(workflowId);
    setEstimatedPoints(null);
  };

  const createWorkflow = () => {
    if (manager.dirty && !window.confirm(t("当前工作流有未保存修改，确定新建吗？", "This workflow has unsaved changes. Create another?"))) return;
    manager.newDraft(EMPTY_DEFINITION, t("未命名工作流", "Untitled workflow"));
    runtime.reset();
    setPaletteOpen(true);
  };

  const saveWorkflow = async (definition) => {
    try {
      const saved = await manager.save(definition ? { definition } : undefined);
      setEstimatedPoints(Number(saved?.estimate?.totalPoints ?? 0));
      toast.success(t("工作流已保存", "Workflow saved"));
      return saved;
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("工作流保存失败", "Unable to save workflow"));
      throw error;
    }
  };

  const startSavedWorkflow = async (saved, hasMcp, runContext = {}) => {
    if (hasMcp && !window.confirm(t(
      "该工作流会调用你已授权的外部 MCP 工具，确认运行吗？",
      "This workflow uses your connected MCP account. Run it now?",
    ))) return null;
    const data = await runtime.startNamed(saved.id, {
      mcpApprovalConfirmed: hasMcp,
      variables: runContext.variables,
      inputs: runContext.inputs,
    });
    manager.markLock({ locked: true, runId: data?.run?.id, status: data?.run?.status || "queued" });
    return data;
  };

  const runWorkflow = async (definition = manager.draft) => {
    if (locked) return;
    try {
      const saved = manager.dirty || !manager.activeWorkflow ? await saveWorkflow(definition) : manager.activeWorkflow;
      const estimate = await runtime.estimate(saved.definition);
      const points = Number(estimate?.estimated_points ?? estimate?.estimate?.totalPoints ?? 0);
      setEstimatedPoints(points);
      const hasMcp = containsMcpCall(saved.definition);
      const inputDefinitions = collectWorkflowRunInputDefinitions(saved.definition);
      if (Object.keys(saved.definition?.variables || {}).length > 0 || Object.keys(inputDefinitions).length > 0) {
        setPendingRun({ saved, hasMcp, estimatedPoints: points, inputDefinitions });
        return;
      }
      await startSavedWorkflow(saved, hasMcp);
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || t("工作流启动失败", "Unable to start workflow"));
    }
  };

  const addNode = (catalogNode) => {
    if (locked) return;
    const id = `${String(catalogNode.type || "node").replace(/[^a-z0-9]+/gi, "_")}_${Date.now().toString(36)}`;
    const centerX = ((Number(boardSize?.width) || window.innerWidth) / 2 - Number(viewport?.x || 0)) / scale;
    const centerY = ((Number(boardSize?.height) || window.innerHeight) / 2 - Number(viewport?.y || 0)) / scale;
    manager.updateDraft(definitionWithNode(manager.draft, {
      id,
      type: catalogNode.type,
      title: catalogNode.label || catalogNode.type,
      x: Math.round(centerX - NODE_WIDTH / 2 + nodes.length * 22),
      y: Math.round(centerY - NODE_HEIGHT / 2 + nodes.length * 18),
      config: defaultConfig(catalogNode),
      pointsEstimate: 0,
    }));
    setSelectedNodeId(id);
    setPaletteOpen(false);
  };

  const removeNode = (id) => {
    if (locked) return;
    manager.updateDraft(definitionWithoutNode(manager.draft, id));
    if (selectedNodeId === id) setSelectedNodeId("");
    if (connecting?.from === id) setConnecting(null);
  };

  const patchNodeConfig = (id, patch) => {
    if (locked) return;
    manager.updateDraft({
      ...manager.draft,
      nodes: (manager.draft?.nodes || []).map((node) => nodeKey(node) === id
        ? { ...node, config: { ...(node.config || {}), ...patch } }
        : node),
    });
  };

  const openNodeEditor = (id) => {
    setSelectedNodeId(id);
    setEditorTargetNodeId(id);
    setEditorOpen(true);
  };

  const startNodeDrag = (event, node) => {
    if (locked || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const id = nodeKey(node);
    setSelectedNodeId(id);
    const origin = { x: event.clientX, y: event.clientY, nodeX: Number(node.x || 0), nodeY: Number(node.y || 0) };
    const base = manager.draft;
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - origin.x) / scale;
      const dy = (moveEvent.clientY - origin.y) / scale;
      manager.updateDraft({
        ...base,
        nodes: (base.nodes || []).map((item) => nodeKey(item) === id ? { ...item, x: Math.round(origin.nodeX + dx), y: Math.round(origin.nodeY + dy) } : item),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const beginConnection = (event, from, branch = null) => {
    event.preventDefault();
    event.stopPropagation();
    if (locked) return;
    setConnecting((current) => current?.from === from && current?.branch === branch ? null : { from, branch });
  };

  const finishConnection = (event, to) => {
    event.preventDefault();
    event.stopPropagation();
    if (!connecting || connecting.from === to || locked) return;
    const exists = edges.some((edge) => edgeFrom(edge) === connecting.from && edgeTo(edge) === to && (edge.branch || null) === connecting.branch);
    if (!exists) {
      manager.updateDraft({
        ...manager.draft,
        edges: [...edges, {
          id: `edge_${Date.now().toString(36)}`,
          from: connecting.from,
          to,
          branch: connecting.branch,
        }],
      });
    }
    setConnecting(null);
  };

  const approveWaitingNode = async () => {
    if (!waitingApproval || approvalSubmitting) return;
    setApprovalSubmitting(true);
    try {
      await runtime.approve(waitingApproval.nodeKey);
      setApprovalMinimized(false);
      toast.success(t("工作流已继续运行", "Workflow resumed"));
    } catch (error) {
      toast.error(error?.message || t("确认失败，请重试", "Unable to approve; try again"));
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const approvalDialog = (
    <WorkflowApprovalDialog
      approval={waitingApproval}
      minimized={approvalMinimized}
      submitting={approvalSubmitting}
      workflowName={manager.activeWorkflow?.name || manager.draftName}
      onMinimize={() => setApprovalMinimized(true)}
      onExpand={() => setApprovalMinimized(false)}
      onApprove={() => void approveWaitingNode()}
      t={t}
      ui={ui}
    />
  );

  const nodeScreen = (node) => ({
    x: Number(viewport?.x || 0) + Number(node.x || 0) * scale,
    y: Number(viewport?.y || 0) + Number(node.y || 0) * scale,
  });

  if (!visible) return (
    <>
      <button
        type="button"
        data-touch-ignore="true"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => onVisibilityChange?.(true)}
        className="absolute left-1/2 top-[74px] z-20 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3.5 text-[10px] font-semibold shadow-[0_12px_32px_rgba(0,0,0,.18)] backdrop-blur-2xl"
        style={{ background: ui.panelStrong, borderColor: ui.line, color: ui.muted }}
      >
        <GitBranch size={12} />{t("显示工作流", "Show workflow")}
      </button>
      {approvalDialog}
    </>
  );

  return (
    <>
      <svg className="pointer-events-none absolute inset-0 z-[14] h-full w-full overflow-visible" aria-hidden="true">
        <defs>
          <marker id="stardraw-workflow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M 0 0 L 8 4 L 0 8 Z" fill={ui.gold || "#e9c349"} />
          </marker>
          <marker id="stardraw-workflow-arrow-true" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M 0 0 L 8 4 L 0 8 Z" fill="#22a56f" />
          </marker>
          <marker id="stardraw-workflow-arrow-false" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M 0 0 L 8 4 L 0 8 Z" fill="#d97706" />
          </marker>
        </defs>
        {edges.map((edge) => {
          const source = nodeMap.get(edgeFrom(edge));
          const target = nodeMap.get(edgeTo(edge));
          if (!source || !target) return null;
          const sourcePoint = nodeScreen(source);
          const targetPoint = nodeScreen(target);
          const condition = CONDITION_TYPES.has(nodeType(source));
          const branchOffset = condition ? (edge.branch === "false" ? 28 : -28) : 0;
          const x1 = sourcePoint.x + NODE_WIDTH * scale;
          const y1 = sourcePoint.y + (NODE_HEIGHT / 2 + branchOffset) * scale;
          const x2 = targetPoint.x;
          const y2 = targetPoint.y + NODE_HEIGHT * scale / 2;
          const bend = Math.max(50, Math.abs(x2 - x1) * 0.42);
          const stroke = edge.branch === "false" ? "#d97706" : edge.branch === "true" ? "#22a56f" : (ui.gold || "#e9c349");
          const marker = edge.branch === "false"
            ? "url(#stardraw-workflow-arrow-false)"
            : edge.branch === "true"
              ? "url(#stardraw-workflow-arrow-true)"
              : "url(#stardraw-workflow-arrow)";
          const path = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
          return <g key={edge.id || `${edgeFrom(edge)}-${edgeTo(edge)}-${edge.branch || ""}`}>
            <path d={path} fill="none" stroke={stroke} strokeWidth="6" opacity="0.1" />
            <path d={path} fill="none" stroke={stroke} strokeWidth="2" opacity="0.9" markerEnd={marker} />
          </g>;
        })}
      </svg>

      <div className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
        {nodes.map((node) => {
          const id = nodeKey(node);
          const type = nodeType(node);
          const screen = nodeScreen(node);
          const status = statusMap.get(id);
          const tone = statusTone(status?.status, ui);
          const selected = selectedNodeId === id;
          const catalogNode = catalogMap.get(type);
          return (
            <article
              key={id}
              data-touch-ignore="true"
              className="group pointer-events-auto absolute overflow-visible rounded-[18px] border shadow-[0_16px_40px_rgba(0,0,0,.2)] transition-[box-shadow,transform] duration-200"
              style={{
                left: screen.x,
                top: screen.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                background: ui.panelStrong,
                borderColor: selected ? ui.gold : status?.status ? tone.border : ui.line,
                boxShadow: selected ? `0 0 0 2px ${ui.goldSoft}, ${ui.shadow}` : ui.softShadow,
              }}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => setSelectedNodeId(id)}
              onDoubleClick={(event) => {
                if (event.target.closest("button, input, textarea, select")) return;
                event.preventDefault();
                event.stopPropagation();
                openNodeEditor(id);
              }}
            >
              <button type="button" aria-label={t("连接到此节点", "Connect to this node")} onClick={(event) => finishConnection(event, id)} className="absolute -left-2 top-1/2 z-20 h-4 w-4 -translate-y-1/2 rounded-full border-2" style={{ background: connecting ? ui.gold : ui.panelStrong, borderColor: connecting ? ui.gold : ui.line }} />
              <header
                data-workflow-node-drag-handle="true"
                onPointerDown={(event) => startNodeDrag(event, node)}
                className={`flex h-9 items-center gap-1.5 rounded-t-[18px] border-b px-2 ${locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing"}`}
                style={{ borderColor: ui.line }}
                title={locked ? t("工作流运行中，节点暂时锁定", "Nodes are locked while the workflow runs") : t("拖动移动节点", "Drag to move node")}
              >
                <GripVertical size={10} style={{ color: ui.faint }} aria-hidden="true" />
                <span className="flex h-5 w-5 items-center justify-center rounded-xl" style={{ background: tone.background, color: tone.color }}><span className="material-symbols-outlined text-[12px]">{nodeIcon(type)}</span></span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">{node.title || catalogNode?.label || type}</span>
                {status?.status && <span className="rounded-full px-1.5 py-0.5 text-[9px]" style={{ background: tone.background, color: tone.color }}>{workflowStatusLabel(status.status, t)}</span>}
                <button
                  type="button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    openNodeEditor(id);
                  }}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition hover:bg-black/5"
                  title={t("编辑节点", "Edit node")}
                  aria-label={t(`编辑${node.title || "节点"}`, `Edit ${node.title || "node"}`)}
                >
                  <Pencil size={10} />
                </button>
                {!locked && <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); removeNode(id); }} className="flex h-5 w-5 items-center justify-center rounded-full opacity-0 transition hover:bg-black/5 group-hover:opacity-100" title={t("删除节点", "Delete node")}><Trash2 size={10} /></button>}
              </header>
              <div className="px-2.5 py-2">
                {type === "input" ? (
                  <textarea
                    data-workflow-node-input="true"
                    data-touch-ignore="true"
                    value={typeof node.config?.value === "string" ? node.config.value : JSON.stringify(node.config?.value ?? "")}
                    onChange={(event) => patchNodeConfig(id, { value: event.target.value })}
                    onPointerDown={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                    disabled={locked}
                    rows={2}
                    className="h-[48px] w-full resize-none rounded-xl border px-2 py-1 text-[10px] leading-4 outline-none disabled:cursor-not-allowed disabled:opacity-55"
                    style={{ background: ui.soft, borderColor: ui.line, color: ui.text }}
                    placeholder={t("输入固定文字，或写 ${inputs.key} 在运行时填写", "Enter fixed text, or use ${inputs.key} to fill it at run time")}
                    aria-label={t(`${node.title || "输入节点"}的输入内容`, `Input value for ${node.title || "input node"}`)}
                  />
                ) : (
                  <>
                    <p className="line-clamp-2 text-[10px] leading-4" style={{ color: ui.faint }}>{summarizeConfig(node, t)}</p>
                    <div className="mt-2 flex items-center justify-between gap-2 text-[9px]" style={{ color: ui.muted }}><span className="truncate">{type}</span><span>{Number(node.pointsEstimate || 0)} pt</span></div>
                  </>
                )}
              </div>
              {CONDITION_TYPES.has(type) ? (
                <>
                  <button type="button" onClick={(event) => beginConnection(event, id, "true")} aria-label={t("连接真分支", "Connect true branch")} className="absolute -right-2 top-[28px] z-20 flex h-4 w-4 items-center justify-center rounded-full border-2 text-[7px] font-bold" style={{ background: connecting?.from === id && connecting.branch === "true" ? "#22a56f" : ui.panelStrong, borderColor: "#22a56f", color: connecting?.from === id && connecting.branch === "true" ? "white" : "#22a56f" }}>{t("真", "T")}</button>
                  <button type="button" onClick={(event) => beginConnection(event, id, "false")} aria-label={t("连接假分支", "Connect false branch")} className="absolute -right-2 bottom-[22px] z-20 flex h-4 w-4 items-center justify-center rounded-full border-2 text-[7px] font-bold" style={{ background: connecting?.from === id && connecting.branch === "false" ? "#d97706" : ui.panelStrong, borderColor: "#d97706", color: connecting?.from === id && connecting.branch === "false" ? "white" : "#d97706" }}>{t("假", "F")}</button>
                </>
              ) : <button type="button" onClick={(event) => beginConnection(event, id)} aria-label={t("从此节点连接", "Connect from this node")} className="absolute -right-2 top-1/2 z-20 h-4 w-4 -translate-y-1/2 rounded-full border-2" style={{ background: connecting?.from === id ? ui.gold : ui.panelStrong, borderColor: ui.gold }} />}
              {status && RETRYABLE_STATUSES.has(status.status) && <button type="button" onClick={(event) => { event.stopPropagation(); void runtime.retryNode(id); }} className="absolute bottom-1.5 right-2 flex items-center gap-1 rounded-full px-2 py-1 text-[9px] shadow-sm" style={{ background: ui.dangerSoft, color: ui.danger }}><RotateCcw size={8} />{t("重试", "Retry")}</button>}
            </article>
          );
        })}
      </div>

      <div data-touch-ignore="true" onMouseDown={(event) => event.stopPropagation()} className="absolute left-1/2 top-[74px] z-30 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-1 rounded-[22px] border p-1.5 shadow-[0_16px_44px_rgba(0,0,0,.22)] backdrop-blur-2xl" style={{ background: ui.panelStrong, borderColor: ui.line }}>
        <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: ui.goldSoft, color: ui.gold }}><GitBranch size={12} /></span>
        <CanvasRoundedSelect
          label={t("选择工作流", "Select workflow")}
          value={manager.activeWorkflow?.id || ""}
          onChange={(value) => void chooseWorkflow(value)}
          disabled={manager.loading || locked}
          options={[...(!manager.activeWorkflow ? [{ value: "", label: manager.draftName || t("未保存工作流", "Unsaved workflow") }] : []), ...manager.workflows.map((workflow) => ({ value: workflow.id, label: workflow.name }))]}
          ui={ui}
          className="max-w-44"
          triggerClassName="h-7 w-full border-0 bg-transparent px-2 text-[10px] font-semibold"
          menuMinWidth={240}
        />
        <span className="hidden h-7 items-center rounded-full px-2.5 text-[9px] sm:flex" style={{ background: ui.soft, color: manager.dirty ? ui.gold : ui.faint }}>{manager.activeWorkflow ? `v${manager.activeWorkflow.version}${manager.dirty ? " *" : ""}` : t("草稿", "Draft")}</span>
        <button type="button" onClick={createWorkflow} disabled={locked} className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5 disabled:opacity-40" title={t("新建工作流", "New workflow")}><Plus size={12} /></button>
        <button type="button" onClick={() => setPaletteOpen((value) => !value)} disabled={locked} className="flex h-7 w-7 items-center justify-center rounded-full transition disabled:opacity-40" style={{ background: paletteOpen ? ui.goldSoft : "transparent", color: paletteOpen ? ui.gold : ui.muted }} title={t("添加节点", "Add node")}><Zap size={12} /></button>
        <button type="button" onClick={() => void saveWorkflow()} disabled={locked || manager.saving || (!manager.dirty && Boolean(manager.activeWorkflow))} className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5 disabled:opacity-35" title={t("保存工作流", "Save workflow")}><Save size={12} /></button>
        <button type="button" onClick={() => { setEditorTargetNodeId(selectedNodeId); setEditorOpen(true); }} className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5" title={t("完整编辑器", "Full editor")}><Maximize2 size={12} /></button>
        {busy ? <button type="button" onClick={() => void runtime.cancel().then(() => manager.markLock({ locked: false }))} className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: ui.dangerSoft, color: ui.danger }} title={t("停止运行", "Stop run")}><Square size={10} fill="currentColor" /></button> : <button type="button" onClick={() => void runWorkflow()} disabled={nodes.length === 0 || manager.saving} className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[10px] font-semibold shadow-sm disabled:opacity-35" style={{ background: ui.accent, color: ui.accentText }} title={t("运行工作流", "Run workflow")}><Play size={10} fill="currentColor" />{t("运行", "Run")}</button>}
        <button type="button" onClick={() => onVisibilityChange?.(false)} className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5" title={t("隐藏工作流", "Hide workflow")}><X size={12} /></button>
      </div>

      {paletteOpen && (
        <div data-touch-ignore="true" onMouseDown={(event) => event.stopPropagation()} className="absolute left-1/2 top-[116px] z-40 grid max-h-[360px] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 grid-cols-2 gap-2 overflow-y-auto rounded-[22px] border p-2.5 shadow-[0_20px_50px_rgba(0,0,0,.26)] backdrop-blur-2xl sm:grid-cols-3" style={{ background: ui.panelStrong, borderColor: ui.line }}>
          {(manager.catalog || []).map((item) => <button key={item.type} type="button" onClick={() => addNode(item)} className="flex min-w-0 items-center gap-2 rounded-[14px] border px-2.5 py-2 text-left transition hover:-translate-y-px hover:shadow-md" style={{ background: ui.soft, borderColor: ui.line }}><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl" style={{ background: ui.goldSoft, color: ui.gold }}><span className="material-symbols-outlined text-[14px]">{nodeIcon(item.type)}</span></span><span className="min-w-0"><span className="block truncate text-[11px] font-semibold">{item.label}</span><span className="mt-0.5 block truncate text-[9px]" style={{ color: ui.faint }}>{item.description}</span></span></button>)}
          {(manager.catalog || []).length === 0 && <p className="col-span-full px-3 py-8 text-center text-[10px]" style={{ color: ui.faint }}>{manager.loading ? t("正在加载节点目录…", "Loading node catalog...") : t("节点目录暂不可用", "Node catalog unavailable")}</p>}
        </div>
      )}

      {(busy || runtime.status === "paused" || runtime.status === "failed" || runtime.status === "completed") && (
        <div data-touch-ignore="true" onMouseDown={(event) => event.stopPropagation()} className="absolute bottom-20 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full border px-2 py-1 text-[8px] shadow-[0_14px_36px_rgba(0,0,0,.22)] backdrop-blur-2xl" style={{ background: ui.panelStrong, borderColor: ui.line, color: ui.muted }}>
          {busy ? <Activity size={10} className="animate-pulse" style={{ color: ui.gold }} /> : runtime.status === "completed" ? <span className="material-symbols-outlined text-[11px] text-emerald-500">check_circle</span> : <span className="material-symbols-outlined text-[11px]" style={{ color: ui.danger }}>error</span>}
          <span>{workflowStatusLabel(runtime.status, t)} · {runtime.progress.completed}/{runtime.progress.total} · {runtime.progress.percent}%</span>
          {waitingApproval && <button type="button" onClick={() => void approveWaitingNode()} disabled={approvalSubmitting} className="rounded-full px-1.5 py-0.5 text-[8px] font-semibold shadow-sm disabled:opacity-50" style={{ background: ui.goldSoft, color: ui.gold }}>{approvalSubmitting ? t("确认中", "Approving") : t("确认继续", "Approve")}</button>}
        </div>
      )}

      {approvalDialog}

      {editorOpen && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[280] isolate flex items-center justify-center overflow-hidden bg-black/60 p-2 backdrop-blur-md sm:p-4 lg:p-6"
          role="dialog"
          aria-modal="true"
          aria-label={t("工作流编辑器", "Workflow editor")}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <section className="flex h-[calc(100dvh-16px)] w-full max-w-[1500px] flex-col overflow-hidden rounded-[28px] border shadow-[0_24px_80px_rgba(0,0,0,.34)] sm:h-[calc(100dvh-32px)] lg:h-[min(920px,calc(100dvh-48px))]" style={{ background: ui.panelSolid, borderColor: ui.line, color: ui.text }}>
            <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3" style={{ borderColor: ui.line }}>
              <GitBranch size={14} style={{ color: ui.gold }} />
              <input value={manager.draftName} onChange={(event) => manager.updateName(event.target.value)} disabled={locked} className="h-7 min-w-0 flex-1 bg-transparent text-xs font-semibold outline-none disabled:opacity-60" />
              {locked && <span className="flex items-center gap-1 text-[9px]" style={{ color: ui.gold }}><LockKeyhole size={10} />{t("运行中已锁定", "Locked while running")}</span>}
              <button type="button" onClick={() => void saveWorkflow()} disabled={locked || manager.saving} className="flex h-7 items-center gap-1 rounded-full border px-2.5 text-[9px] transition hover:bg-white/5 disabled:opacity-40" style={{ borderColor: ui.line }}><Save size={10} />{t("保存", "Save")}</button>
              <button type="button" onClick={() => void runWorkflow()} disabled={busy || nodes.length === 0} className="flex h-7 items-center gap-1 rounded-full px-2.5 text-[9px] font-semibold shadow-sm disabled:opacity-40" style={{ background: ui.accent, color: ui.accentText }}><Play size={10} fill="currentColor" />{t("运行", "Run")}</button>
              <button type="button" onClick={() => { setEditorOpen(false); setEditorTargetNodeId(""); }} className="flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5" title={t("关闭", "Close")}><X size={13} /></button>
            </header>
            <div className="min-h-0 flex-1">
              <WorkflowEditorPanel workflow={manager.draft} onChange={manager.updateDraft} onRun={(definition) => void runWorkflow(definition)} running={busy || manager.saving} readOnly={locked} nodeStatuses={runtime.progress.nodes} onRetryNode={(id) => void runtime.retryNode(id)} estimatedPoints={estimatedPoints ?? undefined} catalog={manager.catalog} canvasMedia={canvasMedia} initialSelectedNodeId={editorTargetNodeId} className="h-full rounded-none border-0" title={manager.draftName || canvasTitle} footerMessage={t("节点仍显示在同一张无限画布上；这里用于精细配置。", "Nodes remain on the same infinite canvas; use this view for detailed configuration.")} ui={ui} />
            </div>
            <footer className="flex h-10 shrink-0 items-center justify-between border-t px-3 text-[9px]" style={{ borderColor: ui.line, color: ui.faint }}><span>{manager.error?.message || t("保存创建不可变版本，运行使用固定快照。", "Save creates an immutable version and runs use a fixed snapshot.")}</span>{manager.activeWorkflow && <button type="button" onClick={() => { if (window.confirm(t("确定归档这个工作流吗？", "Archive this workflow?"))) void manager.archive(); }} disabled={locked} className="flex items-center gap-1 disabled:opacity-40"><Archive size={10} />{t("归档", "Archive")}</button>}</footer>
          </section>
        </div>,
        document.body,
      )}

      <WorkflowRunDialog open={Boolean(pendingRun)} workflowName={pendingRun?.saved?.name || manager.draftName} definition={pendingRun?.saved?.definition || {}} variables={pendingRun?.saved?.definition?.variables || {}} inputs={pendingRun?.inputDefinitions || {}} canvasId={canvasId} authAxios={authAxios} estimatedPoints={pendingRun?.estimatedPoints} onCancel={() => setPendingRun(null)} onConfirm={async (runContext) => { const result = await startSavedWorkflow(pendingRun.saved, pendingRun.hasMcp, runContext); if (result) setPendingRun(null); }} t={t} ui={ui} />
    </>
  );
};

export default IntegratedCanvasWorkflow;
