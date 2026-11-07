import { normalizeWorkflowVariableDefinitions } from "../modules/canvas-workflows/variables.js";
import { resolveWorkflowNodeConfig } from "../modules/canvas-workflows/nodeConfig.js";

const MAX_NODES = 200;
const NODE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WORKFLOW_INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/;
const MCP_NODE_TYPES = new Set(["mcp.call", "mcp.call.external"]);

const fail = (message, code = "INVALID_WORKFLOW_DEFINITION") => Object.assign(new Error(message), {
  status: 400,
  code,
});

const assertJson = (value, path = "$") => {
  if (value == null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw fail(`${path} contains unsupported data`);
  if (Array.isArray(value)) return value.forEach((item, index) => assertJson(item, `${path}[${index}]`));
  Object.entries(value).forEach(([key, item]) => assertJson(item, `${path}.${key}`));
};

const positiveOrZero = (value, label) => {
  if (value == null || value === "") return 0;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw fail(`${label} must be a non-negative integer`);
  return normalized;
};

export const workflowContainsMcpCall = (definition = {}) => (
  Array.isArray(definition?.nodes)
  && definition.nodes.some((node) => MCP_NODE_TYPES.has(String(
    node?.type || node?.nodeType || node?.node_type || "",
  ).trim().toLowerCase()))
);

/** Normalize and validate a workflow before it crosses the persistence seam. */
export const normalizeWorkflowDefinition = (definition = {}, { resolveNodeCost } = {}) => {
  const rawNodes = Array.isArray(definition.nodes) ? definition.nodes : [];
  if (rawNodes.length === 0) throw fail("Workflow must contain at least one node");
  if (rawNodes.length > MAX_NODES) throw fail(`Workflow cannot contain more than ${MAX_NODES} nodes`);

  const keys = new Set();
  const nodes = rawNodes.map((raw, index) => {
    const key = String(raw?.id || raw?.nodeKey || raw?.node_key || `node_${index + 1}`).trim();
    if (!NODE_KEY_PATTERN.test(key) || keys.has(key)) throw fail(`Invalid or duplicate workflow node key: ${key}`);
    keys.add(key);
    const type = String(raw?.type || raw?.nodeType || raw?.node_type || "").trim().toLowerCase();
    if (!NODE_KEY_PATTERN.test(type)) throw fail(`Invalid workflow node type for ${key}`);
    const dependsOn = Array.isArray(raw?.dependsOn || raw?.depends_on)
      ? [...new Set((raw.dependsOn || raw.depends_on).map((item) => String(item || "").trim()).filter(Boolean))]
      : [];
    const explicitCost = raw?.pointsEstimate ?? raw?.points_estimate ?? raw?.pointsCost ?? raw?.points_cost;
    const resolvedCost = typeof resolveNodeCost === "function"
      ? resolveNodeCost({ ...raw, nodeKey: key, nodeType: type })
      : explicitCost;
    const pointsEstimate = positiveOrZero(resolvedCost, `pointsEstimate for ${key}`);
    let config = resolveWorkflowNodeConfig(raw);
    if (type === "input"
      && !Object.prototype.hasOwnProperty.call(config, "value")
      && !Object.prototype.hasOwnProperty.call(config, "prompt")) {
      const configuredInputKey = String(config.inputKey || config.input_key || key).trim();
      if (WORKFLOW_INPUT_KEY_PATTERN.test(configuredInputKey)) {
        config = {
          ...config,
          inputKey: configuredInputKey,
          inputMode: "runtime",
          value: `\${inputs.${configuredInputKey}}`,
        };
      }
    }
    assertJson(config, `nodes.${key}.config`);
    const rawX = raw?.x ?? raw?.position?.x;
    const rawY = raw?.y ?? raw?.position?.y;
    return {
      nodeKey: key,
      nodeType: type,
      dependsOn,
      config,
      pointsEstimate,
      ...(Number.isFinite(Number(rawX)) ? { x: Number(rawX) } : {}),
      ...(Number.isFinite(Number(rawY)) ? { y: Number(rawY) } : {}),
    };
  });

  const edges = (Array.isArray(definition.edges) ? definition.edges : []).map((raw, index) => {
    const from = String(raw?.from || raw?.source || "").trim();
    const to = String(raw?.to || raw?.target || "").trim();
    if (!keys.has(from) || !keys.has(to) || from === to) throw fail(`Invalid workflow edge at index ${index}`);
    const branchValue = String(raw?.branch || raw?.sourceHandle || raw?.source_handle || "").trim().toLowerCase();
    return {
      id: String(raw?.id || `${from}->${to}`).slice(0, 160),
      from,
      to,
      branch: ["true", "false"].includes(branchValue) ? branchValue : null,
    };
  });
  const edgesByTarget = new Map();
  for (const edge of edges) {
    const targetEdges = edgesByTarget.get(edge.to) || [];
    targetEdges.push(edge);
    edgesByTarget.set(edge.to, targetEdges);
  }
  const normalizedNodes = nodes.map((node) => {
    const incoming = edgesByTarget.get(node.nodeKey) || [];
    const branchEdge = incoming.find((edge) => edge.branch);
    return {
      ...node,
      dependsOn: [...new Set([...node.dependsOn, ...incoming.map((edge) => edge.from)])],
      config: branchEdge && !node.config?.when
        ? { ...node.config, when: { nodeKey: branchEdge.from, branch: branchEdge.branch } }
        : node.config,
    };
  });

  for (const node of normalizedNodes) {
    for (const dependency of node.dependsOn) {
      if (!keys.has(dependency)) throw fail(`Node ${node.nodeKey} depends on missing node ${dependency}`);
      if (dependency === node.nodeKey) throw fail(`Node ${node.nodeKey} cannot depend on itself`);
    }
  }
  assertAcyclic(normalizedNodes);
  const variables = normalizeWorkflowVariableDefinitions(definition.variables);
  assertJson(variables, "variables");
  return {
    schemaVersion: Number(definition.schemaVersion || definition.schema_version || 1),
    version: Number(definition.version || 1),
    variables,
    nodes: normalizedNodes,
    edges,
  };
};

export const assertAcyclic = (nodes = []) => {
  const byKey = new Map(nodes.map((node) => [node.nodeKey || node.id, node]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw fail(`Workflow contains a dependency cycle at ${key}`);
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn || byKey.get(key)?.depends_on || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
  return true;
};

const EXACT_CONDITION_LIMIT = 12;
const MERGE_NODE_TYPES = new Set(["merge", "join"]);

const topologicalNodes = (nodes) => {
  const byKey = new Map(nodes.map((node) => [node.nodeKey || node.id, node]));
  const indegree = new Map(nodes.map((node) => [node.nodeKey || node.id, 0]));
  const children = new Map(nodes.map((node) => [node.nodeKey || node.id, []]));
  for (const node of nodes) {
    const key = node.nodeKey || node.id;
    const dependencies = node.dependsOn || node.depends_on || [];
    indegree.set(key, dependencies.length);
    for (const dependency of dependencies) children.get(dependency)?.push(key);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([key]) => key);
  const ordered = [];
  while (ready.length) {
    const key = ready.shift();
    ordered.push(byKey.get(key));
    for (const child of children.get(key) || []) {
      const next = indegree.get(child) - 1;
      indegree.set(child, next);
      if (next === 0) ready.push(child);
    }
  }
  return ordered;
};

const branchGateFor = (node) => {
  const when = node?.config?.when;
  const conditionKey = String(when?.nodeKey || when?.node_key || "").trim();
  const branch = String(when?.branch || "").trim().toLowerCase();
  return conditionKey && ["true", "false"].includes(branch) ? { conditionKey, branch } : null;
};

/**
 * Estimate all nodes that can execute in one run. Independent roots and
 * parallel branches are summed. Explicit true/false branches are mutually
 * exclusive, so the most expensive valid branch assignment is selected.
 */
export const estimateWorkflowCost = (nodes = []) => {
  assertAcyclic(nodes);
  const roots = nodes.filter((node) => (node.dependsOn || node.depends_on || []).length === 0).map((node) => node.nodeKey || node.id);
  const ordered = topologicalNodes(nodes);
  const knownNodePoints = nodes.reduce((sum, node) => sum + positiveOrZero(node.pointsEstimate ?? node.points_estimate, "pointsEstimate"), 0);
  const conditionKeys = [...new Set(nodes.map(branchGateFor).filter(Boolean).map((gate) => gate.conditionKey))];

  if (conditionKeys.length > EXACT_CONDITION_LIMIT) {
    return {
      totalPoints: knownNodePoints,
      knownNodePoints,
      paths: [{
        cost: knownNodePoints,
        nodeKeys: ordered.map((node) => node.nodeKey || node.id),
        kind: "conservative_upper_bound",
        conditionCount: conditionKeys.length,
      }],
      roots,
      strategy: "conservative_upper_bound",
    };
  }

  const scenarioCount = 2 ** conditionKeys.length;
  const scenarios = [];
  for (let mask = 0; mask < scenarioCount; mask += 1) {
    const branches = Object.fromEntries(conditionKeys.map((key, index) => [key, (mask & (2 ** index)) !== 0 ? "true" : "false"]));
    const active = new Map();
    const nodeKeys = [];
    let cost = 0;
    for (const node of ordered) {
      const key = node.nodeKey || node.id;
      const dependencies = node.dependsOn || node.depends_on || [];
      const gate = branchGateFor(node);
      const gateOpen = !gate || (active.get(gate.conditionKey) === true && branches[gate.conditionKey] === gate.branch);
      const nodeType = String(node.nodeType || node.node_type || node.type || "").trim().toLowerCase();
      const dependenciesOpen = dependencies.length === 0
        || (MERGE_NODE_TYPES.has(nodeType)
          ? true
          : dependencies.every((dependency) => active.get(dependency) === true));
      const executes = gateOpen && dependenciesOpen;
      active.set(key, executes);
      if (!executes) continue;
      nodeKeys.push(key);
      cost += positiveOrZero(node.pointsEstimate ?? node.points_estimate, `pointsEstimate for ${key}`);
    }
    scenarios.push({ cost, nodeKeys, branches, kind: conditionKeys.length ? "branch_scenario" : "execution_set" });
  }
  scenarios.sort((left, right) => right.cost - left.cost || right.nodeKeys.length - left.nodeKeys.length);
  const total = scenarios[0]?.cost || 0;
  return {
    totalPoints: total,
    knownNodePoints,
    paths: scenarios.slice(0, 32),
    roots,
    strategy: conditionKeys.length ? "maximum_branch_scenario" : "all_parallel_nodes",
  };
};
