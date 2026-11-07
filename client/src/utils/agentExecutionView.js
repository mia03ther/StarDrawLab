const TOOL_LABELS = Object.freeze({
  "agent.capability.search": ["查找可用能力", "Find available capability"],
  "canvas.list": ["查找画布", "Find canvases"],
  "canvas.read": ["读取画布", "Read canvas"],
  "canvas.create": ["创建画布", "Create canvas"],
  "canvas.edit": ["更新画布", "Update canvas"],
  "canvas.patch": ["编辑画布", "Edit canvas"],
  "canvas.asset.attach_creation": ["把作品加入画布", "Add creation to canvas"],
  "canvas.asset.upload": ["上传画布素材", "Upload canvas asset"],
  "workflow.catalog": ["读取工作流节点", "Read workflow nodes"],
  "workflow.read": ["读取工作流", "Read workflow"],
  "workflow.save": ["保存工作流", "Save workflow"],
  "workflow.patch": ["修改工作流", "Edit workflow"],
  "workflow.estimate": ["估算工作流费用", "Estimate workflow cost"],
  "workflow.run": ["运行工作流", "Run workflow"],
  "media.estimate": ["估算生成费用", "Estimate generation cost"],
  "media.generate.image": ["生成图片", "Generate image"],
  "media.generate.video": ["生成视频", "Generate video"],
  "template.search": ["搜索模板", "Search templates"],
  "template.use": ["读取模板", "Read template"],
  "model.list": ["读取可用模型", "Read available models"],
  "creation.history": ["读取创作记录", "Read creation history"],
  "creation.get": ["查询作品状态", "Check creation status"],
  "task.list": ["读取任务", "Read tasks"],
  "task.get": ["查询任务进度", "Check task progress"],
  "storyboard.edit": ["编辑分镜", "Edit storyboard"],
  "storyboard.patch": ["修改分镜", "Update storyboard"],
  "timeline.edit": ["编辑时间线", "Edit timeline"],
  "timeline.render": ["渲染时间线", "Render timeline"],
  "director3d.edit": ["调整 3D 导演台", "Edit 3D director"],
  "community.publish": ["发布作品", "Publish creation"],
  "community.unpublish": ["取消公开作品", "Unpublish creation"],
  "billing.pay": ["创建支付订单", "Create payment order"],
});

const text = (value) => String(value || "").trim();
const translated = (labels, language) => labels?.[language === "en" ? 1 : 0] || "";

export const getAgentToolLabel = (call, language = "zh") => {
  const key = text(call?.toolKey);
  const explicit = text(call?.callName || call?.name || call?.label);
  if (explicit && !/^react_\d+/i.test(explicit) && !/^step_\d+/i.test(explicit)) return explicit;
  if (TOOL_LABELS[key]) return translated(TOOL_LABELS[key], language);
  const family = key.split(".")[0];
  const fallback = {
    admin: ["执行管理员操作", "Run administrator action"],
    root: ["执行 Root 操作", "Run root action"],
    mcp: ["调用外部工具", "Call external tool"],
    content: ["处理内容", "Process content"],
    subscription: ["处理订阅", "Process subscription"],
    profile: ["处理个人资料", "Process profile"],
  }[family];
  return translated(fallback, language) || key || translated(["准备下一项操作", "Prepare next action"], language);
};

export const getAgentCallDisplayStatus = (call, runStatus) => {
  const status = text(call?.status);
  return ["failed", "cancelled", "completed"].includes(runStatus)
    && ["ready", "queued", "pending", "running", "processing", "waiting_approval", "waiting_client", "waiting_external"].includes(status)
    ? "stopped" : status;
};

const firstCallWithStatus = (calls, statuses) => calls.find((call) => statuses.includes(call?.status)) || null;

export const getAgentExecutionView = ({ planning = false, actionBusy = false, run = null, calls = [], language = "zh" } = {}) => {
  const safeCalls = Array.isArray(calls) ? calls : [];
  const isEn = language === "en";
  const pick = (zh, en) => isEn ? en : zh;
  const waitingApproval = firstCallWithStatus(safeCalls, ["waiting_approval"]);
  const waitingClient = firstCallWithStatus(safeCalls, ["waiting_client"]);
  const runningCall = firstCallWithStatus(safeCalls, ["running"]);
  const readyCall = firstCallWithStatus(safeCalls, ["ready", "queued", "pending"]);
  const currentCall = waitingApproval || waitingClient || runningCall || readyCall;
  const callIndex = currentCall ? safeCalls.indexOf(currentCall) : -1;
  const label = getAgentToolLabel(currentCall, language);
  const status = text(run?.status) || (planning ? "planning" : actionBusy ? "starting" : "idle");
  const base = {
    active: planning || actionBusy || ["queued", "running", "waiting_approval", "waiting_client"].includes(status),
    status,
    call: currentCall,
    toolKey: text(currentCall?.toolKey),
    description: text(currentCall?.reason),
    stepNumber: callIndex >= 0 ? callIndex + 1 : Math.max(0, Number(run?.currentStep || 0)),
    totalSteps: Math.max(safeCalls.length, Number(run?.totalSteps || 0)),
    progress: Math.max(0, Math.min(100, Number(run?.progress || 0))),
  };

  // Terminal run state wins over stale step snapshots and in-flight UI flags.
  if (["completed", "failed", "cancelled"].includes(status)) {
    const terminal = { ...base, active: false, call: null, toolKey: "", description: "" };
    if (status === "completed") return { ...terminal, phase: "done", title: pick("任务已完成", "Task completed"), progress: 100 };
    return { ...terminal, phase: "failed", title: status === "cancelled" ? pick("任务已取消", "Task cancelled") : pick("任务执行失败", "Task failed") };
  }
  if (planning) return { ...base, active: true, phase: "think", title: pick("正在理解需求并选择下一步", "Understanding the request and choosing the next step") };
  if (waitingApproval) return { ...base, phase: "approval", title: pick(`等待你确认：${label}`, `Waiting for approval: ${label}`) };
  if (waitingClient) return { ...base, phase: "client", title: pick(`等待浏览器操作：${label}`, `Waiting for browser action: ${label}`) };
  if (runningCall) return { ...base, phase: "tool", title: pick(`正在执行：${label}`, `Running: ${label}`) };
  if (status === "queued" || readyCall) return { ...base, phase: "queue", title: pick(`正在准备：${label}`, `Preparing: ${label}`) };
  if (status === "running" && safeCalls.some((call) => call?.status === "completed")) {
    return { ...base, active: true, phase: "observe", title: pick("正在分析工具结果", "Analyzing the tool result") };
  }
  if (actionBusy) return { ...base, active: true, phase: "queue", title: pick("正在启动后台任务", "Starting background task") };
  return { ...base, phase: "idle", title: pick("等待指令", "Waiting for instruction") };
};
