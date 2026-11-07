import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  Braces,
  Clapperboard,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  CircleX,
  Code2,
  FileInput,
  GitMerge,
  GitBranch,
  Image as ImageIcon,
  LayoutTemplate,
  Link2,
  PanelTop,
  PauseCircle,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  LoaderCircle,
  Repeat2,
  RotateCcw,
  Video,
  X,
  Zap,
} from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";
import WorkflowVariableEditor from "./canvas/WorkflowVariableEditor";
import WorkflowLoopEditorDialog from "./canvas/WorkflowLoopEditorDialog";
import CanvasRoundedSelect from "./canvas/CanvasRoundedSelect";
import { deriveWorkflowEdges } from "../utils/workflowEdges";

const NODE_TYPES = [
  { type: "input", kind: "input", label: "输入", en: "Input", icon: FileInput, color: "#b6beca", points: 0, bindingField: "value" },
  { type: "template.use", kind: "template", label: "模板", en: "Template", icon: LayoutTemplate, color: "#f0b86e", points: 0 },
  { type: "canvas.image", kind: "canvas-image", label: "画布图片", en: "Canvas image", icon: ImageIcon, color: "#d6a34f", points: 0 },
  { type: "canvas.video", kind: "canvas-video", label: "画布视频", en: "Canvas video", icon: Video, color: "#6e9de8", points: 0 },
  { type: "image.generate", kind: "image", label: "图片", en: "Image", icon: ImageIcon, color: "#e8b35a", points: 16, sceneKey: "freeform_image", bindingField: "prompt", serverBilled: true },
  { type: "video.generate", kind: "video", label: "视频", en: "Video", icon: Video, color: "#77a9ff", points: 150, sceneKey: "freeform_video", bindingField: "prompt", serverBilled: true },
  { type: "agent.call", kind: "agent", label: "Agent", en: "Agent", icon: Bot, color: "#c495ff", points: 1, sceneKey: "canvas_agent_plan", bindingField: "prompt", serverBilled: true },
  { type: "mcp.call", kind: "mcp", label: "MCP", en: "MCP", icon: Link2, color: "#66d2b1", points: 0, sceneKey: "" },
  { type: "script.optimize", kind: "script", label: "脚本", en: "Script", icon: Code2, color: "#ef8c9e", points: 1, sceneKey: "digital_human_script_optimizer", bindingField: "prompt", serverBilled: true },
  { type: "canvas.read", kind: "canvas-read", label: "读取画布", en: "Read canvas", icon: PanelTop, color: "#8cb4df", points: 0 },
  { type: "canvas.set_state", kind: "canvas-write", label: "写入画布", en: "Write canvas", icon: PanelTop, color: "#5ba3c8", points: 0, bindingField: "state" },
  { type: "storyboard.edit", kind: "storyboard", label: "更新分镜", en: "Update storyboard", icon: Clapperboard, color: "#f09f80", points: 0, bindingField: "storyboard" },
  { type: "approval.wait", kind: "approval", label: "人工确认", en: "Approval", icon: CheckCircle2, color: "#e7a94c", points: 0 },
  { type: "merge", kind: "merge", label: "合并", en: "Merge", icon: GitMerge, color: "#9aa6b6", points: 0 },
  { type: "condition.rule", kind: "condition", label: "条件判断", en: "Condition", icon: GitBranch, color: "#67d6b2", points: 0, fields: {} },
  { type: "condition.ai", kind: "condition-ai", label: "AI 条件", en: "AI condition", icon: Bot, color: "#a98cff", points: 1, serverBilled: true, fields: {} },
  { type: "loop.foreach", kind: "loop", label: "遍历循环", en: "For each", icon: Repeat2, color: "#62c7e8", points: 0, fields: {} },
  { type: "loop.repeat_until", kind: "loop", label: "条件循环", en: "Repeat until", icon: Repeat2, color: "#4bb4d2", points: 0, fields: {} },
];

const NODE_TYPE_MAP = new Map(NODE_TYPES.map((definition) => [definition.type, definition]));
const LEGACY_NODE_TYPES = new Map([
  ["image", "image.generate"],
  ["media.generate.image", "image.generate"],
  ["video", "video.generate"],
  ["media.generate.video", "video.generate"],
  ["agent", "agent.call"],
  ["mcp", "mcp.call"],
  ["script", "script.optimize"],
]);
const MAX_LABEL_LENGTH = 160;
const MAX_PROMPT_LENGTH = 4000;
const MAX_EXPRESSION_LENGTH = 500;

const RUNTIME_STATUSES = new Set([
  "queued",
  "running",
  "waiting_approval",
  "paused",
  "completed",
  "failed",
  "skipped",
]);

const statusDefinition = (status, t) => ({
  queued: { label: t("排队中", "Queued"), className: "border-slate-300/25 bg-slate-400/10 text-slate-300", icon: CircleDot },
  running: { label: t("运行中", "Running"), className: "border-blue-300/30 bg-blue-400/10 text-blue-200", icon: LoaderCircle },
  waiting_approval: { label: t("等待确认", "Waiting approval"), className: "border-amber-300/35 bg-amber-400/10 text-amber-200", icon: CircleAlert },
  paused: { label: t("已暂停", "Paused"), className: "border-orange-300/30 bg-orange-400/10 text-orange-200", icon: PauseCircle },
  completed: { label: t("已完成", "Completed"), className: "border-emerald-300/30 bg-emerald-400/10 text-emerald-200", icon: CheckCircle2 },
  failed: { label: t("失败", "Failed"), className: "border-rose-300/35 bg-rose-400/10 text-rose-200", icon: CircleX },
  skipped: { label: t("已跳过", "Skipped"), className: "border-violet-300/25 bg-violet-400/10 text-violet-200", icon: CircleDot },
})[status] || null;

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const numberOr = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const clampPoints = (value) => Math.max(0, Math.floor(numberOr(value, 0)));
const safeText = (value, fallback = "") => String(value ?? fallback).trim().slice(0, MAX_LABEL_LENGTH);
const safePrompt = (value) => String(value ?? "").slice(0, MAX_PROMPT_LENGTH);

const iconForCatalogNode = (type, category) => {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "condition.rule") return GitBranch;
  if (normalized === "condition.ai") return Bot;
  if (normalized.startsWith("loop.")) return Repeat2;
  if (normalized.includes("image")) return ImageIcon;
  if (normalized.includes("video")) return Video;
  if (normalized.includes("template")) return LayoutTemplate;
  if (normalized.includes("approval")) return CheckCircle2;
  if (normalized.includes("canvas")) return PanelTop;
  if (normalized.includes("mcp")) return Link2;
  if (normalized.includes("agent") || category === "ai") return Bot;
  if (normalized.includes("script")) return Code2;
  if (normalized === "merge" || category === "control") return GitMerge;
  return Zap;
};

const catalogLabel = (entry, english = false) => {
  if (entry?.label && typeof entry.label === "object") {
    return String(entry.label[english ? "en" : "zh"] || entry.label.default || entry.type || "Node");
  }
  return String(english ? (entry?.en || entry?.label_en) : (entry?.label || entry?.name || entry?.type) || "Node");
};

const normalizeCatalogDefinitions = (entries) => {
  const definitions = new Map(NODE_TYPE_MAP);
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const type = String(entry?.type || entry?.nodeType || "").trim().toLowerCase();
    if (!type) return;
    const existing = definitions.get(type) || {};
    const category = String(entry?.category || "").toLowerCase();
    const kind = type === "condition.rule" ? "condition"
      : type === "condition.ai" ? "condition-ai"
        : type.startsWith("loop.") ? "loop"
          : existing.kind || (category === "generation" ? (type.includes("video") ? "video" : "image") : category || "other");
    definitions.set(type, {
      ...existing,
      ...entry,
      type,
      kind,
      label: catalogLabel(entry),
      en: catalogLabel(entry, true),
      icon: entry.icon ? existing.icon || iconForCatalogNode(type, category) : existing.icon || iconForCatalogNode(type, category),
      color: entry.color || existing.color || (kind === "condition" || kind === "condition-ai" ? "#67d6b2" : "#8e9aaa"),
      points: clampPoints(entry.points ?? entry.pointsEstimate ?? entry.points_cost ?? existing.points),
      serverBilled: Boolean(entry.serverBilled ?? entry.server_billed ?? existing.serverBilled ?? ["creative", "generation", "ai"].includes(String(entry.operationClass || category).toLowerCase())),
      sceneKey: entry.sceneKey || entry.scene_key || existing.sceneKey || "",
      fields: entry.fields && typeof entry.fields === "object" ? entry.fields : (existing.fields || {}),
    });
  });
  return definitions;
};

const normalizeNodeType = (type) => {
  const normalized = String(type || "script.optimize").trim().toLowerCase();
  return LEGACY_NODE_TYPES.get(normalized) || normalized;
};

const definitionFor = (type, definitions = NODE_TYPE_MAP) => definitions.get(normalizeNodeType(type)) || {
  type,
  kind: "other",
  label: type || "节点",
  en: type || "Node",
  icon: Zap,
  color: "#8e9aaa",
  points: 0,
};

const normalizeDependencyList = (value) => Array.isArray(value)
  ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
  : [];

const normalizeWorkflow = (workflow, t, definitions = NODE_TYPE_MAP) => {
  const source = workflow && typeof workflow === "object" ? workflow : {};
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes = rawNodes.map((raw, index) => {
    const type = normalizeNodeType(raw?.type || raw?.nodeType);
    const definition = definitionFor(type, definitions);
    const id = String(raw?.id || raw?.nodeKey || `node_${index + 1}`).trim() || `node_${index + 1}`;
    const config = raw?.config && typeof raw.config === "object" && !Array.isArray(raw.config)
      ? { ...raw.config }
      : {};
    const title = safeText(raw?.title || raw?.label || config.title, `${t(definition.label, definition.en)} ${index + 1}`);
    const pointsEstimate = clampPoints(raw?.pointsEstimate ?? raw?.points_estimate ?? raw?.pointsCost ?? config.pointsEstimate ?? definition.points);
    return {
      ...raw,
      id,
      type,
      x: numberOr(raw?.x, numberOr(raw?.position?.x, index * 260)),
      y: numberOr(raw?.y, numberOr(raw?.position?.y, (index % 2) * 180)),
      label: safeText(raw?.label || title, title),
      title,
      prompt: safePrompt(raw?.prompt || config.prompt),
      sceneKey: safeText(raw?.sceneKey || raw?.scene_key || config.sceneKey || config.scene_key || definition.sceneKey),
      model: safeText(raw?.model || config.model),
      tool: safeText(raw?.tool || raw?.toolKey || config.tool || config.toolKey),
      connectionId: safeText(raw?.connectionId || raw?.connection_id || config.connectionId || config.connection_id),
      size: safeText(raw?.size || config.size),
      seconds: raw?.seconds ?? config.seconds ?? "",
      templateId: safeText(raw?.templateId || raw?.template_id || config.templateId || config.template_id),
      inputExpression: String(
        raw?.inputExpression
        || raw?.input_expression
        || config.inputBindings?.[definition.bindingField]
        || config.input_bindings?.[definition.bindingField]
        || "",
      ).slice(0, MAX_EXPRESSION_LENGTH),
      pointsEstimate,
      status: RUNTIME_STATUSES.has(String(raw?.status || raw?.runtimeStatus || "").toLowerCase())
        ? String(raw?.status || raw?.runtimeStatus).toLowerCase()
        : "",
      error: safeText(raw?.error || raw?.errorMessage || config.error),
      dependsOn: normalizeDependencyList(raw?.dependsOn || raw?.depends_on || config.dependsOn),
      condition: config.condition || config.rule || raw?.condition || null,
      maxIterations: numberOr(config.maxIterations ?? config.max_iterations ?? raw?.maxIterations, 20),
      concurrency: numberOr(config.concurrency ?? raw?.concurrency, 1),
      body: config.body && typeof config.body === "object" ? config.body : (raw?.body && typeof raw.body === "object" ? raw.body : null),
      config: { ...config, title, pointsEstimate },
    };
  });
  const ids = new Set(nodes.map((node) => node.id));
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  const edges = deriveWorkflowEdges({ nodes, edges: rawEdges }).map((raw) => ({
    ...raw,
    id: String(raw?.id || `${raw?.from || raw?.source || ""}->${raw?.to || raw?.target || ""}`),
    from: String(raw?.from || raw?.source || "").trim(),
    to: String(raw?.to || raw?.target || "").trim(),
    branch: ["true", "false"].includes(String(raw?.branch || raw?.sourceHandle || "").toLowerCase())
      ? String(raw.branch || raw.sourceHandle).toLowerCase()
      : null,
    sourceHandle: ["true", "false"].includes(String(raw?.sourceHandle || raw?.branch || "").toLowerCase())
      ? String(raw.sourceHandle || raw.branch).toLowerCase()
      : undefined,
    targetHandle: raw?.targetHandle || raw?.target_handle || undefined,
  })).filter((edge) => edge.from && edge.to && ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to);
  const edgeDependencies = new Map();
  edges.forEach((edge) => {
    const dependencies = edgeDependencies.get(edge.to) || [];
    dependencies.push(edge.from);
    edgeDependencies.set(edge.to, dependencies);
  });
  const compatibleNodes = nodes.map((node) => {
    const dependsOn = [...new Set([
      ...normalizeDependencyList(node.dependsOn),
      ...(edgeDependencies.get(node.id) || []),
    ])];
    return { ...node, dependsOn, config: { ...(node.config || {}), dependsOn } };
  });
  return { ...source, version: Number(source.version || 1), nodes: compatibleNodes, edges };
};

const nodeToFlow = (node) => ({
  id: node.id,
  type: "workflow",
  position: { x: node.x, y: node.y },
  data: { node },
  draggable: true,
  selectable: true,
});

const edgeToFlow = (edge) => ({
  id: edge.id || `${edge.from}->${edge.to}`,
  source: edge.from,
  target: edge.to,
  sourceHandle: edge.sourceHandle || edge.branch || undefined,
  targetHandle: edge.targetHandle || undefined,
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
  animated: false,
});

const flowNodeToCanvas = (flowNode, original) => ({
  ...original,
  x: numberOr(flowNode.position?.x, original.x),
  y: numberOr(flowNode.position?.y, original.y),
});

const flowEdgeToCanvas = (edge) => ({
  id: edge.id || `${edge.source}->${edge.target}`,
  from: edge.source,
  to: edge.target,
  ...(edge.sourceHandle || edge.branch ? {
    sourceHandle: edge.sourceHandle || edge.branch,
    branch: edge.branch || edge.sourceHandle,
  } : {}),
  ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
});

const statusClass = (tone) => tone === "error"
  ? "border-rose-300/40 bg-rose-500/10 text-rose-200"
  : tone === "success"
    ? "border-emerald-300/40 bg-emerald-500/10 text-emerald-200"
    : "border-amber-300/40 bg-amber-500/10 text-amber-100";

const WorkflowNode = ({ data, selected }) => {
  const { t } = useLanguage();
  const node = data.node;
  const definition = data.definitions?.get(normalizeNodeType(node.type)) || definitionFor(node.type);
  const Icon = definition.icon;
  const runtime = statusDefinition(node.status, t);
  const isCondition = ["condition", "condition-ai"].includes(definition.kind);
  const isLoop = definition.kind === "loop";
  const retryable = ["failed", "paused"].includes(node.status) && typeof data.onRetryNode === "function";
  const renderStatus = runtime && (() => {
    const StatusIcon = runtime.icon;
    return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] ${runtime.className}`} title={node.error || runtime.label}>
      <StatusIcon size={10} className={node.status === "running" ? "animate-spin" : ""} />{runtime.label}
    </span>;
  })();
  return (
    <div
      className="relative w-[220px] overflow-hidden rounded-[18px] border shadow-[0_16px_36px_rgba(0,0,0,.2)] transition"
      style={{
        background: "var(--wf-node)",
        borderColor: selected ? "var(--wf-text)" : "var(--wf-line)",
        borderTopColor: definition.color,
        boxShadow: selected ? `0 0 0 2px ${definition.color}33, var(--wf-shadow)` : "var(--wf-shadow)",
      }}
    >
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !border-2" style={{ background: definition.color, borderColor: "var(--wf-node)" }} />
      <div className="flex items-center gap-2 rounded-t-[18px] border-b px-3 py-2" style={{ background: `${definition.color}18`, borderColor: "var(--wf-line)" }}>
        <span className="flex h-6 w-6 items-center justify-center rounded-lg" style={{ color: definition.color, background: `${definition.color}22` }}><Icon size={14} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold" style={{ color: "var(--wf-text)" }}>{node.title || t(definition.label, definition.en)}</p>
          <p className="text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--wf-faint)" }}>{t(definition.label, definition.en)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {renderStatus}
          {retryable && <button type="button" onClick={(event) => { event.stopPropagation(); data.onRetryNode(node.id, node); }} className="rounded-full p-1 text-amber-300 transition hover:bg-amber-300/15" title={t("重试节点", "Retry node")}><RotateCcw size={11} /></button>}
          {!runtime && <span className="text-[10px] font-semibold" style={{ color: definition.color }}>{definition.serverBilled ? t("动态", "Dynamic") : `${node.pointsEstimate} pt`}</span>}
        </div>
      </div>
      <div className="space-y-1 px-3 py-2 text-[11px]" style={{ color: "var(--wf-muted)" }}>
        {node.model && <p className="truncate"><span style={{ color: "var(--wf-faint)" }}>{t("模型", "Model")}</span> {node.model}</p>}
        {node.tool && <p className="truncate"><span style={{ color: "var(--wf-faint)" }}>{t("工具", "Tool")}</span> {node.tool}</p>}
        {node.inputExpression && <p className="truncate font-mono" style={{ color: "var(--wf-faint)" }}>{node.inputExpression}</p>}
        {node.prompt && <p className="line-clamp-2" style={{ color: "var(--wf-faint)" }}>{node.prompt}</p>}
        {isCondition && <p className="flex items-center gap-1" style={{ color: "var(--wf-faint)" }}><GitBranch size={11} />{t("输出真 / 假分支", "Outputs true / false branches")}</p>}
        {isLoop && <p className="flex items-center gap-1" style={{ color: "var(--wf-faint)" }}><Repeat2 size={11} />{t(`最多 ${node.maxIterations} 次 · 并发 ${node.concurrency}`, `Max ${node.maxIterations} · concurrency ${node.concurrency}`)}</p>}
        {node.error && <p className="line-clamp-2 text-rose-300" title={node.error}>{node.error}</p>}
        {!node.model && !node.tool && !node.prompt && !node.inputExpression && <p style={{ color: "var(--wf-faint)" }}>{t("未配置节点参数", "Node is not configured")}</p>}
      </div>
      {isCondition ? <>
        <Handle id="true" type="source" position={Position.Right} style={{ top: "38%", background: "#49c98c", borderColor: "var(--wf-node)" }} className="!h-2.5 !w-2.5 !border-2" />
        <span className="pointer-events-none absolute right-[-31px] top-[30%] text-[9px] font-semibold text-emerald-300">{t("真", "true")}</span>
        <Handle id="false" type="source" position={Position.Right} style={{ top: "68%", background: "#e79a67", borderColor: "var(--wf-node)" }} className="!h-2.5 !w-2.5 !border-2" />
        <span className="pointer-events-none absolute right-[-35px] top-[61%] text-[9px] font-semibold text-orange-300">{t("假", "false")}</span>
      </> : <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !border-2" style={{ background: definition.color, borderColor: "var(--wf-node)" }} />}
    </div>
  );
};

const fieldClass = "mt-1 w-full rounded-xl border px-2 py-1.5 text-[11px] outline-none transition";

const catalogEntriesFrom = (value) => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.data?.nodes)) return value.data.nodes;
  return null;
};

const runtimeNodesFrom = (value) => {
  const candidates = [
    value?.nodeStatuses,
    value?.runtime?.nodes,
    value?.run?.progress?.nodes,
    value?.progress?.nodes,
    value?.run?.nodes,
    value?.nodes,
  ];
  return candidates.find((candidate) => Array.isArray(candidate) || (candidate && typeof candidate === "object")) || [];
};

const runtimeStatusFor = (runtimeNodes, nodeId) => {
  if (Array.isArray(runtimeNodes)) {
    const item = runtimeNodes.find((candidate) => String(candidate?.id || candidate?.nodeKey || candidate?.node_key || "") === String(nodeId));
    const status = String(item?.status || item?.state || "").toLowerCase();
    return RUNTIME_STATUSES.has(status) ? status : "";
  }
  const item = runtimeNodes?.[nodeId];
  const status = String(item?.status || item?.state || item || "").toLowerCase();
  return RUNTIME_STATUSES.has(status) ? status : "";
};

const WorkflowEditorPanel = ({
  workflow,
  onChange,
  onRun,
  running = false,
  estimatedPoints,
  className = "",
  title,
  emptyMessage,
  ui,
  catalog: injectedCatalog,
  nodeCatalog,
  workflowCatalog,
  catalogUrl = "/api/workflows/catalog",
  nodeStatuses,
  runtime,
  run,
  progress,
  onRetryNode,
  readOnly = false,
  footerMessage,
  canvasMedia = [],
  showRunAction = true,
  nestingLevel = 0,
  initialSelectedNodeId = "",
}) => {
  const { t } = useLanguage();
  const suppliedCatalog = injectedCatalog ?? nodeCatalog ?? workflowCatalog;
  const [remoteCatalog, setRemoteCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const suppliedEntries = catalogEntriesFrom(suppliedCatalog);
    if (suppliedEntries) {
      setRemoteCatalog(suppliedEntries);
      setCatalogError("");
      setCatalogLoading(false);
      return undefined;
    }
    if (!catalogUrl || typeof window === "undefined" || typeof window.fetch !== "function") return undefined;
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError("");
    window.fetch(catalogUrl, { credentials: "include", headers: { Accept: "application/json" }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.message || `Catalog request failed (${response.status})`);
        const entries = catalogEntriesFrom(payload);
        if (!entries) throw new Error("Workflow catalog has no node definitions");
        setRemoteCatalog(entries);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setCatalogError(error?.message || "Unable to load workflow catalog");
      })
      .finally(() => setCatalogLoading(false));
    return () => controller.abort();
  }, [catalogUrl, suppliedCatalog]);

  const definitions = useMemo(() => normalizeCatalogDefinitions(remoteCatalog || catalogEntriesFrom(suppliedCatalog) || []), [remoteCatalog, suppliedCatalog]);
  const catalogDefinitionEntries = remoteCatalog || catalogEntriesFrom(suppliedCatalog);
  const catalogDefinitions = useMemo(() => {
    if (!Array.isArray(catalogDefinitionEntries)) return [...definitions.values()];
    return [...new Set(catalogDefinitionEntries.map((entry) => normalizeNodeType(entry?.type || entry?.nodeType)))]
      .map((type) => definitions.get(type))
      .filter(Boolean);
  }, [catalogDefinitionEntries, definitions]);
  const runtimeNodes = nodeStatuses ?? runtimeNodesFrom({ ...workflow, runtime, run, progress });
  const normalized = useMemo(() => {
    const base = normalizeWorkflow(workflow, t, definitions);
    return {
      ...base,
      nodes: base.nodes.map((node) => ({
        ...node,
        status: runtimeStatusFor(runtimeNodes, node.id) || node.status || "",
      })),
    };
  }, [definitions, runtimeNodes, t, workflow]);
  const [selectedId, setSelectedId] = useState(null);
  const [showInspector, setShowInspector] = useState(true);
  const [showVariables, setShowVariables] = useState(false);
  const themeStyle = useMemo(() => ({
    "--wf-bg": ui?.panelSolid || "#0d1015",
    "--wf-panel": ui?.panel || "#12161d",
    "--wf-node": ui?.elementBg || ui?.panelSolid || "#161a21",
    "--wf-soft": ui?.soft || "rgba(255,255,255,0.04)",
    "--wf-line": ui?.line || "rgba(255,255,255,0.1)",
    "--wf-line-strong": ui?.line2 || "rgba(255,255,255,0.2)",
    "--wf-text": ui?.text || "#ffffff",
    "--wf-muted": ui?.muted || "rgba(255,255,255,0.62)",
    "--wf-faint": ui?.faint || "rgba(255,255,255,0.4)",
    "--wf-shadow": ui?.softShadow || "0 14px 34px rgba(0,0,0,0.28)",
  }), [ui]);
  const inputStyle = useMemo(() => ({
    color: "var(--wf-text)",
    background: "var(--wf-soft)",
    borderColor: "var(--wf-line)",
  }), []);
  const resolvedTitle = title || t("工作流", "Workflow");
  const resolvedEmptyMessage = emptyMessage || t("从左侧添加节点，拖动节点并连线。", "Add nodes from the left, then drag and connect them.");

  const selectedNode = normalized.nodes.find((node) => node.id === selectedId) || null;
  const [loopEditorOpen, setLoopEditorOpen] = useState(false);
  const selectedLoopBody = useMemo(() => (selectedNode?.config?.body && typeof selectedNode.config.body === "object"
    ? selectedNode.config.body
    : (selectedNode?.body && typeof selectedNode.body === "object" ? selectedNode.body : { nodes: [], edges: [] })), [selectedNode?.config?.body, selectedNode?.body]);
  useEffect(() => {
    setLoopEditorOpen(false);
  }, [selectedId]);
  const validation = useMemo(() => validateWorkflow(normalized, t, definitions), [definitions, normalized, t]);
  const flowNodes = useMemo(() => normalized.nodes.map(nodeToFlow), [normalized.nodes]);
  const flowEdges = useMemo(() => normalized.edges.map(edgeToFlow), [normalized.edges]);

  const flowNodeData = useMemo(() => flowNodes.map((flowNode) => ({
    ...flowNode,
    data: { ...flowNode.data, definitions, onRetryNode },
  })), [definitions, flowNodes, onRetryNode]);

  useEffect(() => {
    if (selectedId && normalized.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(normalized.nodes[0]?.id || null);
  }, [normalized.nodes, selectedId]);

  useEffect(() => {
    const requested = String(initialSelectedNodeId || "").trim();
    if (!requested || !normalized.nodes.some((node) => node.id === requested)) return;
    setSelectedId(requested);
    setShowInspector(true);
  }, [initialSelectedNodeId, normalized.nodes]);

  const commit = useCallback((nextWorkflow) => {
    if (readOnly || typeof onChange !== "function") return;
    const persisted = {
      ...nextWorkflow,
      nodes: (nextWorkflow?.nodes || []).map((node) => {
        const persisted = { ...node };
        delete persisted.status;
        delete persisted.error;
        return persisted;
      }),
    };
    onChange(persisted);
  }, [onChange, readOnly]);

  const updateNodes = useCallback((nextFlowNodes) => {
    const originals = new Map(normalized.nodes.map((node) => [node.id, node]));
    commit({
      ...normalized,
      nodes: nextFlowNodes.map((flowNode) => flowNodeToCanvas(flowNode, originals.get(flowNode.id) || flowNode.data?.node || {})),
    });
  }, [commit, normalized]);

  const onNodesChange = useCallback((changes) => {
    updateNodes(applyNodeChanges(changes, flowNodes));
  }, [flowNodes, updateNodes]);

  const onEdgesChange = useCallback((changes) => {
    const nextEdges = applyEdgeChanges(changes, flowEdges).map(flowEdgeToCanvas);
    const dependenciesByTarget = new Map();
    nextEdges.forEach((edge) => {
      const dependencies = dependenciesByTarget.get(edge.to) || [];
      dependencies.push(edge.from);
      dependenciesByTarget.set(edge.to, dependencies);
    });
    const nextNodes = normalized.nodes.map((node) => {
      const dependsOn = dependenciesByTarget.get(node.id) || [];
      return { ...node, dependsOn, config: { ...(node.config || {}), dependsOn } };
    });
    commit({ ...normalized, nodes: nextNodes, edges: nextEdges });
  }, [commit, flowEdges, normalized]);

  const onConnect = useCallback((connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const nextFlowEdges = addEdge({ ...connection, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }, flowEdges);
    const nextEdges = nextFlowEdges.map(flowEdgeToCanvas);
    const nextNodes = normalized.nodes.map((node) => node.id === connection.target
      ? { ...node, dependsOn: [...new Set([...(node.dependsOn || []), connection.source])], config: { ...(node.config || {}), dependsOn: [...new Set([...(node.dependsOn || []), connection.source])] } }
      : node);
    commit({ ...normalized, nodes: nextNodes, edges: nextEdges });
  }, [commit, flowEdges, normalized]);

  const addNode = useCallback((type) => {
    const definition = definitionFor(type, definitions);
    const index = normalized.nodes.length;
    const localizedLabel = t(definition.label, definition.en);
    const node = {
      id: uid(type),
      type,
      x: 80 + (index % 3) * 280,
      y: 80 + Math.floor(index / 3) * 190,
      label: `${localizedLabel} ${index + 1}`,
      title: `${localizedLabel} ${index + 1}`,
      prompt: "",
      sceneKey: definition.sceneKey || "",
      model: "",
      tool: "",
      size: "",
      seconds: "",
      templateId: "",
      inputExpression: "",
      pointsEstimate: definition.points,
      dependsOn: [],
      config: {
        title: `${localizedLabel} ${index + 1}`,
        pointsEstimate: definition.points,
        ...(definition.sceneKey ? { sceneKey: definition.sceneKey } : {}),
      },
    };
    commit({ ...normalized, nodes: [...normalized.nodes, node] });
    setSelectedId(node.id);
    setShowInspector(true);
  }, [commit, definitions, normalized, t]);

  const patchSelected = useCallback((patch) => {
    if (!selectedNode) return;
    const nextNodes = normalized.nodes.map((node) => node.id === selectedNode.id
      ? {
        ...node,
        ...patch,
        label: patch.title ?? patch.label ?? node.label,
        config: {
          ...(node.config || {}),
          ...(patch.config || {}),
          ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "config")),
          title: patch.title ?? node.title,
        },
      }
      : node);
    commit({ ...normalized, nodes: nextNodes });
  }, [commit, normalized, selectedNode]);

  const patchSelectedConfig = useCallback((patch) => {
    if (!selectedNode) return;
    patchSelected({ config: { ...(selectedNode.config || {}), ...patch } });
  }, [patchSelected, selectedNode]);

  const toggleDependency = (dependencyId) => {
    if (!selectedNode || dependencyId === selectedNode.id) return;
    const current = new Set(selectedNode.dependsOn || []);
    if (current.has(dependencyId)) current.delete(dependencyId); else current.add(dependencyId);
    const dependsOn = [...current];
    const edgeKey = `${dependencyId}->${selectedNode.id}`;
    const hasEdge = normalized.edges.some((edge) => edge.from === dependencyId && edge.to === selectedNode.id);
    const edges = hasEdge
      ? normalized.edges.filter((edge) => !(edge.from === dependencyId && edge.to === selectedNode.id))
      : [...normalized.edges, { id: edgeKey, from: dependencyId, to: selectedNode.id }];
    commit({ ...normalized, nodes: normalized.nodes.map((node) => node.id === selectedNode.id ? { ...node, dependsOn, config: { ...(node.config || {}), dependsOn } } : node), edges });
  };

  const removeSelected = () => {
    if (!selectedNode) return;
    const nodes = normalized.nodes.filter((node) => node.id !== selectedNode.id).map((node) => ({
      ...node,
      dependsOn: (node.dependsOn || []).filter((id) => id !== selectedNode.id),
      config: { ...(node.config || {}), dependsOn: (node.dependsOn || []).filter((id) => id !== selectedNode.id) },
    }));
    const edges = normalized.edges.filter((edge) => edge.from !== selectedNode.id && edge.to !== selectedNode.id);
    commit({ ...normalized, nodes, edges });
    setSelectedId(nodes[0]?.id || null);
  };

  const handleRun = () => {
    if (!validation.valid || running || typeof onRun !== "function") return;
    onRun({ ...normalized, nodes: normalized.nodes.map((node) => toRunNode(node, definitions)) });
  };

  const selectedDefinition = selectedNode ? definitionFor(selectedNode.type, definitions) : null;
  const selectedCanvasMediaType = selectedDefinition?.type === "canvas.image" ? "image"
    : selectedDefinition?.type === "canvas.video" ? "video" : "";
  const canvasMediaOptions = canvasMedia
    .filter((item) => !selectedCanvasMediaType || item.type === selectedCanvasMediaType)
    .map((item) => ({
      value: String(item.id),
      label: `${item.title || (item.type === "image" ? t("画布图片", "Canvas image") : t("画布视频", "Canvas video"))} · ${String(item.id).slice(0, 18)}`,
    }));
  const selectedUntil = selectedNode?.config?.until && typeof selectedNode.config.until === "object" && !Array.isArray(selectedNode.config.until)
    ? selectedNode.config.until
    : { left: "{{loop.result}}", operator: "exists", right: "" };
  const explicitFieldNames = new Set([
    "title", "sceneKey", "scene_key", "prompt", "model", "size", "seconds", "templateId", "template_id",
    "connectionId", "connection_id", "tool", "inputExpression", "input_expression", "left", "operator", "right",
    "valueExpression", "value_expression", "itemsExpression", "items_expression", "until", "maxIterations", "max_iterations",
    "concurrency", "body", "value", "message", "elementId", "element_id",
  ]);
  const catalogFields = selectedDefinition && selectedDefinition.fields && typeof selectedDefinition.fields === "object"
    ? Object.entries(selectedDefinition.fields).filter(([name]) => !explicitFieldNames.has(name))
    : [];

  return (
    <section
      className={`flex min-h-[620px] min-w-0 flex-col overflow-hidden rounded-[24px] border shadow-[0_18px_50px_rgba(0,0,0,.14)] ${className}`}
      style={{ ...themeStyle, color: "var(--wf-text)", background: "var(--wf-bg)", borderColor: "var(--wf-line)" }}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line)" }}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-amber-400/15 text-amber-300"><Zap size={16} /></div>
          <div className="min-w-0"><h2 className="truncate text-sm font-semibold">{resolvedTitle}</h2><p className="text-[10px]" style={{ color: "var(--wf-faint)" }}>{normalized.nodes.length} {t("个节点", "nodes")} · {normalized.edges.length} {t("条连接", "connections")} · {Object.keys(normalized.variables || {}).length} {t("个变量", "variables")}</p></div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowVariables(true)} className="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[10px] transition hover:brightness-110" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-muted)" }} title={t("设置运行变量", "Configure run variables")}><Braces size={12} />{Object.keys(normalized.variables || {}).length}</button>
          <div className={`rounded-full border px-2.5 py-1.5 text-[11px] font-medium ${validation.valid ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-200" : "border-rose-300/25 bg-rose-400/10 text-rose-200"}`}>
            {validation.valid ? <CheckCircle2 className="mr-1 inline" size={13} /> : <CircleAlert className="mr-1 inline" size={13} />}
            {validation.valid ? t("可运行", "Ready") : t(`${validation.errors.length} 个问题`, `${validation.errors.length} issues`)}
          </div>
          {estimatedPoints != null && <span className="rounded-full px-2.5 py-1.5 text-[11px]" style={{ background: "var(--wf-soft)", color: "var(--wf-muted)" }}>{t("服务端预计", "Server estimate")} {numberOr(estimatedPoints)} pt</span>}
          {showRunAction && <button type="button" onClick={handleRun} disabled={!validation.valid || running || !normalized.nodes.length || typeof onRun !== "function"} className="inline-flex items-center gap-1.5 rounded-full bg-amber-300 px-3.5 py-1.5 text-xs font-semibold text-[#18130b] shadow-sm transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40" title={t("运行工作流", "Run workflow")}><Play size={14} fill="currentColor" />{running ? t("运行中", "Running") : t("运行", "Run")}</button>}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="w-full shrink-0 border-b p-2 md:w-[144px] md:border-b-0 md:border-r" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line)" }}>
          <div className="mb-1 flex items-center justify-between"><span className="text-[8px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--wf-faint)" }}>{t("节点", "Nodes")}</span><Plus size={11} style={{ color: "var(--wf-faint)" }} /></div>
          <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
            {catalogDefinitions.map((definition) => { const Icon = definition.icon; return <button key={definition.type} type="button" onClick={() => addNode(definition.type)} disabled={readOnly} className="flex items-center gap-1 rounded-[10px] border px-1 py-1 text-left text-[9px] transition hover:-translate-y-px hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-40" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-muted)" }} title={definition.description || t(definition.label, definition.en)}><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px]" style={{ background: `${definition.color}18`, color: definition.color }}><Icon size={11} /></span><span className="min-w-0 truncate">{t(definition.label, definition.en)}</span></button>; })}
          </div>
          {catalogLoading && <p className="mt-1.5 text-[8px]" style={{ color: "var(--wf-faint)" }}>{t("正在加载真实节点目录…", "Loading node catalog…")}</p>}
          {catalogError && <p className="mt-1.5 rounded-lg border border-amber-300/20 bg-amber-300/5 px-1.5 py-1 text-[8px] text-amber-200" title={catalogError}>{t("目录加载失败，暂时使用内置定义", "Catalog unavailable; using built-in definitions")}</p>}
          <div className="mt-2.5 border-t pt-2" style={{ borderColor: "var(--wf-line)" }}><p className="text-[8px] leading-3" style={{ color: "var(--wf-faint)" }}>{t("拖动节点并连接端点。下游节点可读取上游结果。", "Drag nodes and connect handles. Downstream nodes can consume upstream results.")}</p></div>
        </aside>

        <div className="relative min-h-[420px] min-w-0 flex-1">
          {normalized.nodes.length === 0 && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"><div className="rounded-[18px] border border-dashed px-5 py-4 text-center text-xs shadow-sm" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line-strong)", color: "var(--wf-faint)" }}>{resolvedEmptyMessage}</div></div>}
          <ReactFlow
            nodes={flowNodeData}
            edges={flowEdges}
            nodeTypes={{ workflow: WorkflowNode }}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            edgesReconnectable={!readOnly}
            onNodeClick={(_, node) => { setSelectedId(node.id); setShowInspector(true); }}
            onPaneClick={() => setSelectedId(null)}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.1 }}
            proOptions={{ hideAttribution: true }}
            className="workflow-editor-flow"
          >
            <Background color={ui?.canvasGrid || "#27303a"} gap={18} size={1} />
            <Controls showInteractive={false} />
            <MiniMap nodeColor={(node) => definitions.get(normalizeNodeType(node.data?.node?.type))?.color || definitionFor(node.data?.node?.type).color} maskColor={ui?.panelTranslucent || "rgba(7, 10, 14, 0.72)"} />
          </ReactFlow>
        </div>

        {showInspector && <aside className="w-full shrink-0 overflow-y-auto border-t md:w-[248px] md:border-l md:border-t-0" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line)" }}>
          <div className="flex items-center justify-between border-b px-2 py-2" style={{ borderColor: "var(--wf-line)" }}><div className="flex items-center gap-1 text-[10px] font-semibold"><Settings2 size={12} className="text-amber-400" />{t("节点配置", "Node settings")}</div><button type="button" onClick={() => setShowInspector(false)} className="rounded-full p-0.5 transition hover:bg-white/5" style={{ color: "var(--wf-faint)" }} title={t("关闭配置", "Close settings")}><X size={13} /></button></div>
          {selectedNode ? <fieldset disabled={readOnly} className="space-y-2 p-2 disabled:opacity-70">
            <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("标题", "Title")}<input className={fieldClass} style={inputStyle} value={selectedNode.title} onChange={(event) => patchSelected({ title: event.target.value })} /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("类型", "Type")}<input className={`${fieldClass} cursor-not-allowed opacity-70`} style={inputStyle} readOnly value={t(selectedDefinition.label, selectedDefinition.en)} /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("计费", "Billing")}<input className={`${fieldClass} cursor-not-allowed opacity-70`} style={inputStyle} readOnly value={selectedDefinition.serverBilled ? t("服务端动态估算", "Server estimate") : "0 pt"} /></label>
            </div>
            {selectedNode.status && (() => {
              const runtime = statusDefinition(selectedNode.status, t);
              const StatusIcon = runtime?.icon || CircleDot;
              return <div className={`flex items-center justify-between rounded-xl border px-2.5 py-2 text-[10px] ${runtime?.className || ""}`}>
                <span className="inline-flex items-center gap-1.5"><StatusIcon size={12} className={selectedNode.status === "running" ? "animate-spin" : ""} />{runtime?.label || selectedNode.status}</span>
                {['failed', 'paused'].includes(selectedNode.status) && typeof onRetryNode === "function" && <button type="button" onClick={() => onRetryNode(selectedNode.id, selectedNode)} className="inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-amber-200 hover:bg-amber-300/15" title={t("重试节点", "Retry node")}><RotateCcw size={11} />{t("重试", "Retry")}</button>}
              </div>;
            })()}
            {selectedNode.error && <p className="rounded-xl border border-rose-300/25 bg-rose-400/10 px-2.5 py-2 text-[10px] leading-4 text-rose-200">{selectedNode.error}</p>}
            {selectedCanvasMediaType && <div className="space-y-2 rounded-[16px] border p-2.5 shadow-sm" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)" }}>
              <p className="text-[10px] font-semibold" style={{ color: "var(--wf-muted)" }}>{t("选择画布素材", "Select canvas media")}</p>
              <CanvasRoundedSelect
                label={selectedCanvasMediaType === "image" ? t("画布图片", "Canvas image") : t("画布视频", "Canvas video")}
                value={String(selectedNode.config?.elementId || "")}
                onChange={(value) => patchSelectedConfig({ elementId: value })}
                options={[{ value: "", label: canvasMediaOptions.length ? t("请选择画布素材", "Select canvas media") : t("当前画布没有可用素材", "No matching canvas media") }, ...canvasMediaOptions]}
                ui={{ ...inputStyle, soft: inputStyle.background, panelStrong: inputStyle.background, text: inputStyle.color, line: inputStyle.borderColor, line2: inputStyle.borderColor }}
                className="mt-1 w-full"
                triggerClassName={fieldClass}
                menuMinWidth={240}
              />
              <p className="leading-4" style={{ color: "var(--wf-faint)" }}>{t("运行时会按当前用户重新读取该素材；删除或失效后节点会明确失败。", "The asset is re-read for the current user at run time and fails clearly if unavailable.")}</p>
            </div>}
            {catalogFields.length > 0 && <div className="space-y-2 rounded-[16px] border p-2.5 shadow-sm" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)" }}>
              <p className="text-[10px] font-semibold" style={{ color: "var(--wf-muted)" }}>{t("目录参数", "Catalog parameters")}</p>
              {catalogFields.map(([fieldName, rawField]) => {
                const field = rawField && typeof rawField === "object" ? rawField : { type: "string" };
                const value = selectedNode.config?.[fieldName] ?? selectedNode[fieldName] ?? field.default ?? "";
                const label = field.label || fieldName;
                if (field.type === "enum") return <label key={fieldName} className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{label}{field.required ? " *" : ""}<CanvasRoundedSelect label={label} value={String(value)} onChange={(nextValue) => patchSelectedConfig({ [fieldName]: nextValue })} options={[{ value: "", label: t("请选择", "Select") }, ...(field.values || field.options || []).map((option) => ({ value: String(option), label: String(option) }))]} ui={{ ...inputStyle, soft: inputStyle.background, panelStrong: inputStyle.background, text: inputStyle.color, line: inputStyle.borderColor, line2: inputStyle.borderColor }} className="mt-1 w-full" triggerClassName={fieldClass} menuMinWidth={220} /></label>;
                if (field.type === "boolean") return <label key={fieldName} className="flex items-center gap-2 text-[10px]" style={{ color: "var(--wf-faint)" }}><input type="checkbox" checked={Boolean(value)} onChange={(event) => patchSelectedConfig({ [fieldName]: event.target.checked })} />{label}</label>;
                if (field.type === "object" || field.multiline) return <label key={fieldName} className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{label}{field.required ? " *" : ""}<textarea className={`${fieldClass} min-h-[64px] resize-y font-mono`} style={inputStyle} value={typeof value === "string" ? value : JSON.stringify(value || "")} onChange={(event) => { let next = event.target.value; if (field.type === "object") { try { next = JSON.parse(next); } catch { /* keep text while editing */ } } patchSelectedConfig({ [fieldName]: next }); }} /></label>;
                return <label key={fieldName} className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{label}{field.required ? " *" : ""}<input type={field.type === "integer" || field.type === "number" ? "number" : "text"} min={field.minimum} max={field.maximum} className={fieldClass} style={inputStyle} value={String(value)} onChange={(event) => patchSelectedConfig({ [fieldName]: field.type === "integer" || field.type === "number" ? numberOr(event.target.value, field.default ?? 0) : event.target.value })} /></label>;
              })}
            </div>}
            {selectedDefinition.kind === "condition" && <>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("左值表达式", "Left expression")}<input className={`${fieldClass} font-mono`} style={inputStyle} value={selectedNode.config?.left || ""} placeholder="{{nodes.input.result}}" onChange={(event) => patchSelectedConfig({ left: event.target.value })} /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("运算符", "Operator")}<CanvasRoundedSelect label={t("运算符", "Operator")} value={selectedNode.config?.operator || "equals"} onChange={(value) => patchSelectedConfig({ operator: value })} options={["equals", "not_equals", "contains", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "exists", "is_empty"].map((value) => ({ value, label: value }))} ui={{ ...inputStyle, soft: inputStyle.background, panelStrong: inputStyle.background, text: inputStyle.color, line: inputStyle.borderColor, line2: inputStyle.borderColor }} className="mt-1 w-full" triggerClassName={fieldClass} menuMinWidth={180} /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("右值", "Right value")}<input className={fieldClass} style={inputStyle} value={typeof selectedNode.config?.right === "string" ? selectedNode.config.right : JSON.stringify(selectedNode.config?.right ?? "")} onChange={(event) => { let value = event.target.value; try { value = JSON.parse(value); } catch { /* use a plain string while editing */ } patchSelectedConfig({ right: value }); }} /></label>
              <p className="rounded-xl border px-2.5 py-2 text-[10px] leading-4" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-faint)" }}>{t("从右侧 true / false 端点分别连接分支。", "Connect each branch from the true / false handles on the right.")}</p>
            </>}
            {selectedDefinition.kind === "condition-ai" && <>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("判断标准", "Criterion")}<textarea className={`${fieldClass} min-h-[72px] resize-y`} style={inputStyle} value={selectedNode.config?.prompt || ""} onChange={(event) => patchSelectedConfig({ prompt: safePrompt(event.target.value) })} placeholder={t("描述什么情况下应走 true 分支", "Describe when the true branch should be selected")} /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("待判断内容表达式", "Value expression")}<input className={`${fieldClass} font-mono`} style={inputStyle} value={selectedNode.config?.valueExpression || ""} onChange={(event) => patchSelectedConfig({ valueExpression: event.target.value.slice(0, MAX_EXPRESSION_LENGTH) })} placeholder="{{nodes.previous.result}}" /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("文本模型（可选）", "Text model (optional)")}<input className={fieldClass} style={inputStyle} value={selectedNode.config?.model || ""} onChange={(event) => patchSelectedConfig({ model: event.target.value })} /></label>
            </>}
            {selectedDefinition.kind === "loop" && <>
              {selectedDefinition.type === "loop.foreach" ? (
                <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("列表表达式", "Items expression")}<input className={`${fieldClass} font-mono`} style={inputStyle} value={selectedNode.config?.itemsExpression || ""} onChange={(event) => patchSelectedConfig({ itemsExpression: event.target.value.slice(0, MAX_EXPRESSION_LENGTH) })} placeholder="{{inputs.items}}" /></label>
              ) : (
                <div className="space-y-2 rounded-[16px] border p-2.5 shadow-sm" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)" }}>
                  <p className="text-[10px] font-semibold" style={{ color: "var(--wf-muted)" }}>{t("终止条件", "Until condition")}</p>
                  <label className="block text-[9px]" style={{ color: "var(--wf-faint)" }}>{t("左值表达式", "Left expression")}<input className={`${fieldClass} font-mono`} style={inputStyle} value={selectedUntil.left || ""} onChange={(event) => patchSelectedConfig({ until: { ...selectedUntil, left: event.target.value.slice(0, MAX_EXPRESSION_LENGTH) } })} placeholder="{{loop.result.nodes.review.result.approved}}" /></label>
                  <label className="block text-[9px]" style={{ color: "var(--wf-faint)" }}>{t("运算符", "Operator")}<CanvasRoundedSelect label={t("运算符", "Operator")} value={selectedUntil.operator || "equals"} onChange={(value) => patchSelectedConfig({ until: { ...selectedUntil, operator: value } })} options={["equals", "not_equals", "contains", "greater_than", "greater_or_equal", "less_than", "less_or_equal", "exists", "is_empty"].map((value) => ({ value, label: value }))} ui={{ ...inputStyle, soft: inputStyle.background, panelStrong: inputStyle.background, text: inputStyle.color, line: inputStyle.borderColor, line2: inputStyle.borderColor }} className="mt-1 w-full" triggerClassName={fieldClass} menuMinWidth={180} /></label>
                  <label className="block text-[9px]" style={{ color: "var(--wf-faint)" }}>{t("右值", "Right value")}<input className={fieldClass} style={inputStyle} value={typeof selectedUntil.right === "string" ? selectedUntil.right : JSON.stringify(selectedUntil.right ?? "")} onChange={(event) => { let right = event.target.value; try { right = JSON.parse(right); } catch { /* preserve plain text */ } patchSelectedConfig({ until: { ...selectedUntil, right } }); }} disabled={["exists", "is_empty"].includes(selectedUntil.operator)} /></label>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("最大迭代", "Max iterations")}<input type="number" min="1" max="100" className={fieldClass} style={inputStyle} value={selectedNode.config?.maxIterations ?? 20} onChange={(event) => patchSelectedConfig({ maxIterations: Math.min(100, Math.max(1, numberOr(event.target.value, 20))) })} /></label>
                {selectedDefinition.type === "loop.foreach" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("并发", "Concurrency")}<input type="number" min="1" max="100" className={fieldClass} style={inputStyle} value={selectedNode.config?.concurrency ?? 1} onChange={(event) => patchSelectedConfig({ concurrency: Math.min(100, Math.max(1, numberOr(event.target.value, 1))) })} /></label>}
              </div>
              <button type="button" onClick={() => setLoopEditorOpen(true)} className="flex w-full items-center justify-between rounded-[12px] border px-2.5 py-2 text-left transition hover:brightness-110" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-muted)" }}>
                <span><span className="block text-[10px] font-semibold">{t("编辑循环体", "Edit loop body")}</span><span className="mt-0.5 block text-[9px]" style={{ color: "var(--wf-faint)" }}>{t("打开独立的可视化 DAG 编辑器", "Open the nested visual DAG editor")}</span></span>
                <span className="rounded-full border px-2 py-1 text-[9px]" style={{ borderColor: "var(--wf-line)" }}>{Array.isArray(selectedLoopBody.nodes) ? selectedLoopBody.nodes.length : 0} {t("节点", "nodes")}</span>
              </button>
            </>}
            {selectedDefinition.kind === "video" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("视频时长（秒）", "Video duration (seconds)")}<input type="number" min="1" max="60" className={fieldClass} style={inputStyle} value={selectedNode.seconds || ""} onChange={(event) => patchSelected({ seconds: Math.min(60, Math.max(1, numberOr(event.target.value, 8))) })} placeholder="8" /></label>}
            {selectedDefinition.kind === "mcp" && <>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("用户 MCP 连接 ID", "User MCP connection ID")}<input className={fieldClass} style={inputStyle} value={selectedNode.connectionId} placeholder="connection UUID" onChange={(event) => patchSelected({ connectionId: event.target.value })} /></label>
              <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("MCP 工具", "MCP tool")}<input className={fieldClass} style={inputStyle} value={selectedNode.tool} placeholder="figma.list_files" onChange={(event) => patchSelected({ tool: event.target.value })} /></label>
            </>}
            {selectedDefinition.kind === "template" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("模板 ID（与场景键二选一）", "Template ID (or use a scene key)")}<input className={fieldClass} style={inputStyle} value={selectedNode.templateId} onChange={(event) => patchSelected({ templateId: event.target.value })} /></label>}
            {["image", "video"].includes(selectedDefinition.kind) && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("模型（留空使用模板默认值）", "Model (blank uses template default)")}<input className={fieldClass} style={inputStyle} value={selectedNode.model} placeholder={selectedDefinition.kind === "image" ? "nano-banana-2" : "veo-3-1"} onChange={(event) => patchSelected({ model: event.target.value })} /></label>}
            {["agent", "script"].includes(selectedDefinition.kind) && <div className="rounded-xl border px-2.5 py-2 text-[10px]" style={{ background: "var(--wf-soft)", borderColor: "var(--wf-line)", color: "var(--wf-muted)" }}>GPT · {t("模型由服务端固定", "Model is fixed by the server")}</div>}
            {["image", "video", "template"].includes(selectedDefinition.kind) && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("场景键", "Scene key")}<input className={fieldClass} style={inputStyle} value={selectedNode.sceneKey} placeholder={selectedDefinition.sceneKey || "scene_key"} onChange={(event) => patchSelected({ sceneKey: event.target.value })} /></label>}
            {["image", "video"].includes(selectedDefinition.kind) && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("尺寸 / 比例", "Size / aspect ratio")}<input className={fieldClass} style={inputStyle} value={selectedNode.size} placeholder="1024x1024 / 16:9" onChange={(event) => patchSelected({ size: event.target.value })} /></label>}
            {selectedDefinition.kind === "input" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("输入内容", "Input value")}<textarea className={`${fieldClass} min-h-[92px] resize-y`} style={inputStyle} value={typeof selectedNode.config?.value === "string" ? selectedNode.config.value : JSON.stringify(selectedNode.config?.value ?? "", null, 2)} onChange={(event) => patchSelectedConfig({ value: event.target.value })} placeholder={t("输入固定文字，或写 ${inputs.key} 在每次运行前填写", "Enter fixed text, or use ${inputs.key} to fill it before each run")} /><span className="mt-1 block leading-4">{t("使用 ${inputs.key} 时，运行按钮会自动弹出对应输入框。", "Using ${inputs.key} adds a field to the run dialog automatically.")}</span></label>}
            {selectedDefinition.kind === "approval" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("确认说明", "Approval message")}<textarea className={`${fieldClass} min-h-[92px] resize-y`} style={inputStyle} value={selectedNode.config?.message || ""} onChange={(event) => patchSelectedConfig({ message: safePrompt(event.target.value) })} placeholder={t("说明继续执行前需要用户确认的内容", "Explain what the user should confirm before execution continues")} /></label>}
            {["image", "video", "agent", "script"].includes(selectedDefinition.kind) && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("提示词 / 脚本", "Prompt / script")}<textarea className={`${fieldClass} min-h-[92px] resize-y`} style={inputStyle} value={selectedNode.prompt} onChange={(event) => patchSelected({ prompt: safePrompt(event.target.value) })} placeholder={t("节点执行所需的内容", "Content required by this node")} /></label>}
            {selectedDefinition.bindingField && selectedDefinition.kind !== "input" && <label className="block text-[10px]" style={{ color: "var(--wf-faint)" }}>{t("上游输入表达式", "Upstream input expression")}<input className={`${fieldClass} font-mono`} style={inputStyle} value={selectedNode.inputExpression} placeholder={`{{inputs.${selectedNode.dependsOn?.[0] || "node_id"}.result.prompt}}`} onChange={(event) => patchSelected({ inputExpression: event.target.value.slice(0, MAX_EXPRESSION_LENGTH) })} /><span className="mt-1 block leading-4">{t(`绑定到 ${selectedDefinition.bindingField}；留空时生成节点会自动继承上游文本。`, `Binds to ${selectedDefinition.bindingField}; generation nodes inherit upstream text when blank.`)}</span></label>}
            <div><div className="mb-1.5 flex items-center justify-between text-[10px]" style={{ color: "var(--wf-faint)" }}><span>{t("依赖关系", "Dependencies")}</span><span>{(selectedNode.dependsOn || []).length}</span></div><div className="space-y-1">{normalized.nodes.filter((node) => node.id !== selectedNode.id).map((node) => <label key={node.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[10px]" style={{ color: "var(--wf-muted)" }}><input type="checkbox" checked={(selectedNode.dependsOn || []).includes(node.id)} onChange={() => toggleDependency(node.id)} /> <span className="truncate">{node.title || node.id}</span></label>)}</div></div>
            <button type="button" onClick={removeSelected} className="flex w-full items-center justify-center gap-1.5 rounded-full border border-rose-300/20 bg-rose-400/10 px-2.5 py-1.5 text-[11px] font-medium text-rose-500 hover:bg-rose-400/15"><Trash2 size={13} />{t("删除节点", "Delete node")}</button>
          </fieldset> : <div className="p-4 text-xs leading-5" style={{ color: "var(--wf-faint)" }}>{t("选择一个节点查看配置。", "Select a node to edit its settings.")}</div>}
        </aside>}
      </div>

      <footer className="border-t px-2.5 py-1.5" style={{ background: "var(--wf-panel)", borderColor: "var(--wf-line)" }}>
        <div className="flex flex-wrap items-center justify-between gap-1 text-[8px]" style={{ color: "var(--wf-faint)" }}><div className="flex items-center gap-1"><Save size={11} />{footerMessage || t("保存后会创建新的工作流版本", "Saving creates a new workflow version")}</div><div className="flex items-center gap-2"><span>{t("本地规划估算", "Local planning estimate")}: {validation.estimatedPoints} pt</span>{!showInspector && <button type="button" onClick={() => setShowInspector(true)} className="text-amber-500 hover:text-amber-400">{t("打开配置", "Open settings")}</button>}</div></div>
        {validation.errors.length > 0 && <div className="mt-2 space-y-1">{validation.errors.map((error) => <p key={error} className={`rounded-xl border px-2 py-1.5 ${statusClass("error")}`}><CircleAlert className="mr-1 inline" size={12} />{error}</p>)}</div>}
      </footer>
      <WorkflowVariableEditor
        open={showVariables}
        variables={normalized.variables}
        onChange={(variables) => commit({ ...normalized, variables })}
        onClose={() => setShowVariables(false)}
        readOnly={readOnly}
        t={t}
        ui={{
          panelSolid: ui?.panelSolid || "#0d1015",
          soft: ui?.soft || "rgba(255,255,255,0.04)",
          line: ui?.line || "rgba(255,255,255,0.1)",
          text: ui?.text || "#fff",
          muted: ui?.muted || "rgba(255,255,255,0.62)",
          faint: ui?.faint || "rgba(255,255,255,0.4)",
          gold: ui?.gold || "#f2c46d",
        }}
      />
      <WorkflowLoopEditorDialog
        open={loopEditorOpen && selectedDefinition?.kind === "loop"}
        title={t(`编辑“${selectedNode?.title || selectedNode?.id || ""}”循环体`, `Edit loop body: ${selectedNode?.title || selectedNode?.id || ""}`)}
        subtitle={t("循环体是独立、版本化执行的嵌套 DAG，可继续使用条件、并行、合并和变量。", "The loop body is a nested DAG with conditions, parallel branches, joins, and variables.")}
        onClose={() => setLoopEditorOpen(false)}
        t={t}
      >
        <WorkflowEditorPanel
          workflow={selectedLoopBody}
          onChange={(body) => patchSelectedConfig({ body })}
          readOnly={readOnly}
          running={false}
          catalog={suppliedCatalog || remoteCatalog}
          canvasMedia={canvasMedia}
          catalogUrl={catalogUrl}
          showRunAction={false}
          nestingLevel={nestingLevel + 1}
          title={t("循环体工作流", "Loop body workflow")}
          footerMessage={t("修改会随父工作流的下一个版本一起保存。", "Changes are saved with the next parent workflow version.")}
          ui={ui}
          className="h-full min-h-0 rounded-none border-0"
        />
      </WorkflowLoopEditorDialog>
    </section>
  );
};

const toRunNode = (node, definitions = NODE_TYPE_MAP) => {
  const definition = definitionFor(node.type, definitions);
  const inputBindings = {
    ...(node.config?.inputBindings || node.config?.input_bindings || {}),
  };
  if (definition.bindingField) {
    if (node.inputExpression) inputBindings[definition.bindingField] = node.inputExpression;
    else delete inputBindings[definition.bindingField];
  }
  return {
    id: node.id,
    type: node.type,
    dependsOn: normalizeDependencyList(node.dependsOn),
    pointsEstimate: clampPoints(node.pointsEstimate),
    config: {
      ...(node.config || {}),
      title: node.title || node.label,
      prompt: node.prompt || "",
      sceneKey: node.sceneKey || "",
      model: node.model || "",
      tool: node.tool || "",
      connectionId: node.connectionId || "",
      templateId: node.templateId || "",
      size: node.size || "",
      seconds: node.seconds ?? node.config?.seconds ?? null,
      maxIterations: node.maxIterations ?? node.config?.maxIterations ?? null,
      concurrency: node.concurrency ?? node.config?.concurrency ?? null,
      body: node.body || node.config?.body || null,
      inputBindings,
    },
  };
};

const validateWorkflow = (workflow, t = (zh) => zh, definitions = NODE_TYPE_MAP) => {
  const errors = [];
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const ids = new Set(nodes.map((node) => node.id));
  if (nodes.length === 0) errors.push(t("至少添加一个节点", "Add at least one node"));
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length) errors.push(t("存在重复节点 ID", "Duplicate node IDs found"));
  nodes.forEach((node) => {
    const definition = definitionFor(node.type, definitions);
    for (const dependency of normalizeDependencyList(node.dependsOn)) {
      if (!ids.has(dependency)) errors.push(t(`${node.title || node.id} 依赖了不存在的节点`, `${node.title || node.id} depends on a missing node`));
      if (dependency === node.id) errors.push(t(`${node.title || node.id} 不能依赖自身`, `${node.title || node.id} cannot depend on itself`));
    }
    if (["image", "video"].includes(definition.kind) && !node.sceneKey) errors.push(t(`${node.title || node.id} 缺少场景键`, `${node.title || node.id} needs a scene key`));
    if (definition.kind === "template" && !node.templateId && !node.sceneKey) errors.push(t(`${node.title || node.id} 需要模板 ID 或场景键`, `${node.title || node.id} needs a template ID or scene key`));
    const config = node.config && typeof node.config === "object" ? node.config : {};
    if (definition.kind === "condition" && !String(config.left || "").trim()) errors.push(t(`${node.title || node.id} 缺少左值表达式`, `${node.title || node.id} needs a left expression`));
    if (definition.kind === "condition-ai" && (!String(config.prompt || "").trim() || !String(config.valueExpression || config.value_expression || "").trim())) errors.push(t(`${node.title || node.id} 缺少 AI 条件参数`, `${node.title || node.id} needs AI condition parameters`));
    if (definition.kind === "loop" && (!config.body || typeof config.body !== "object" || !Array.isArray(config.body.nodes) || config.body.nodes.length === 0)) errors.push(t(`${node.title || node.id} 缺少循环体工作流`, `${node.title || node.id} needs a loop body workflow`));
    if (definition.type === "loop.foreach" && !String(config.itemsExpression || config.items_expression || "").trim()) errors.push(t(`${node.title || node.id} 缺少列表表达式`, `${node.title || node.id} needs an items expression`));
    if (definition.type === "loop.repeat_until" && (!config.until || typeof config.until !== "object" || !String(config.until.left || "").trim() || !String(config.until.operator || "").trim())) errors.push(t(`${node.title || node.id} 缺少结构化终止条件`, `${node.title || node.id} needs a structured until condition`));
    Object.entries(definition.fields || {}).forEach(([fieldName, field]) => {
      if (!field?.required || ["condition.rule", "condition.ai", "loop.foreach", "loop.repeat_until"].includes(normalizeNodeType(node.type))) return;
      const value = config[fieldName] ?? node[fieldName];
      if (value == null || (typeof value === "string" && !value.trim())) errors.push(t(`${node.title || node.id} 缺少 ${field.label || fieldName}`, `${node.title || node.id} is missing ${field.label || fieldName}`));
    });
    if (definition.kind === "mcp" && (!node.connectionId || !node.tool)) errors.push(t(`${node.title || node.id} 缺少 MCP 连接或工具`, `${node.title || node.id} needs an MCP connection and tool`));
    if (["canvas-write", "storyboard"].includes(definition.kind) && !node.inputExpression) errors.push(t(`${node.title || node.id} 需要上游输入表达式`, `${node.title || node.id} needs an upstream input expression`));
  });
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id) => {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    const found = normalizeDependencyList(byId.get(id)?.dependsOn).some((dependency) => byId.has(dependency) && visit(dependency));
    visiting.delete(id);
    visited.add(id);
    return found;
  };
  const hasCycle = nodes.some((node) => visit(node.id));
  if (hasCycle) errors.push(t("工作流存在循环依赖", "Workflow contains a dependency cycle"));
  const costMemo = new Map();
  const costFor = (id) => {
    if (costMemo.has(id)) return costMemo.get(id);
    const node = byId.get(id);
    const dependencyCost = normalizeDependencyList(node?.dependsOn).reduce((max, dependency) => Math.max(max, costFor(dependency)), 0);
    const cost = clampPoints(node?.pointsEstimate) + dependencyCost;
    costMemo.set(id, cost);
    return cost;
  };
  const estimatedPoints = nodes.length && !hasCycle
    ? Math.max(...nodes.map((node) => costFor(node.id)))
    : nodes.reduce((sum, node) => sum + clampPoints(node.pointsEstimate), 0);
  return { valid: errors.length === 0, errors: [...new Set(errors)], estimatedPoints };
};

export default WorkflowEditorPanel;
