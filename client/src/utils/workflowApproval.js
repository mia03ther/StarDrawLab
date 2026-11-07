const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const nodeKey = (node) => String(node?.id || node?.nodeKey || node?.node_key || "").trim();

const valueAtPath = (value, path) => {
  let current = value;
  for (const segment of String(path || "").split(".").filter(Boolean)) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

const workflowApprovalContext = (runtimeNodes) => ({
  nodes: Object.fromEntries((Array.isArray(runtimeNodes) ? runtimeNodes : []).map((node) => [
    nodeKey(node),
    node?.result,
  ]).filter(([key]) => key)),
});

export const interpolateWorkflowApprovalText = (value, runtimeNodes) => {
  const source = String(value || "");
  const context = workflowApprovalContext(runtimeNodes);
  return source.replace(/(?:\{\{|\$\{)\s*(nodes\.[^}\s]+)\s*(?:\}\}|\})/g, (match, expression) => {
    const resolved = valueAtPath(context, expression);
    if (resolved == null) return match;
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
};

export const getWaitingWorkflowApproval = ({ runtimeNodes, definition } = {}) => {
  const nodes = Array.isArray(runtimeNodes) ? runtimeNodes : [];
  const waitingNode = nodes.find((node) => node?.status === "waiting_approval");
  if (!waitingNode) return null;

  const key = nodeKey(waitingNode);
  const definitionNode = (Array.isArray(definition?.nodes) ? definition.nodes : [])
    .find((node) => nodeKey(node) === key);
  const persistedRequest = waitingNode?.result?.kind === "workflow_approval_request"
    ? waitingNode.result
    : {};
  const config = object(definitionNode?.config);
  const rawMessage = persistedRequest.message
    || config.message
    || config.prompt
    || "工作流已暂停，请确认是否继续执行后续节点。";

  return {
    nodeKey: key,
    title: String(persistedRequest.title || config.title || definitionNode?.title || "需要你的确认").slice(0, 160),
    message: interpolateWorkflowApprovalText(rawMessage, nodes).slice(0, 12_000),
  };
};
