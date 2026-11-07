const NODE_TYPE_ALIASES = new Map([
  ["image", "image.generate"],
  ["media.generate.image", "image.generate"],
  ["video", "video.generate"],
  ["media.generate.video", "video.generate"],
  ["agent", "agent.call"],
  ["mcp", "mcp.call"],
  ["script", "script.optimize"],
  ["approval", "approval.wait"],
  ["join", "merge"],
]);

const NODE_CATALOG = Object.freeze([
  { type: "input", purpose: "Provide a literal value or prompt to downstream nodes.", configFields: ["value", "prompt"] },
  { type: "template.use", purpose: "Load an accessible template for downstream nodes.", configFields: ["templateId", "sceneKey"] },
  { type: "canvas.image", purpose: "Read one image already placed on the current canvas for downstream nodes.", configFields: ["elementId"] },
  { type: "canvas.video", purpose: "Read one video already placed on the current canvas for downstream nodes.", configFields: ["elementId"] },
  { type: "image.generate", purpose: "Generate an image and optionally insert it into the canvas.", configFields: ["sceneKey", "prompt", "model", "size", "visualParameters", "inputBindings", "insertIntoCanvas"] },
  { type: "video.generate", purpose: "Generate a video and optionally insert it into the canvas.", configFields: ["sceneKey", "prompt", "model", "seconds", "size", "referenceCreationId", "inputBindings", "insertIntoCanvas"] },
  { type: "agent.call", purpose: "Ask the canvas Agent to plan a creative or layout operation.", configFields: ["instruction", "prompt", "selectedIds", "language", "inputBindings"] },
  { type: "script.optimize", purpose: "Optimize a script for a target duration.", configFields: ["brief", "prompt", "durationSeconds", "language", "inputBindings"] },
  { type: "mcp.call", purpose: "Call one administrator-approved external MCP tool using the current user's OAuth connection.", configFields: ["connectionId", "serverKey", "toolName", "arguments", "inputBindings"] },
  { type: "canvas.read", purpose: "Read the workflow's owned canvas.", configFields: [] },
  { type: "canvas.set_state", purpose: "Replace canvas state with a value or upstream binding.", configFields: ["state", "title", "inputBindings"] },
  { type: "storyboard.edit", purpose: "Write storyboard data from config or an upstream result.", configFields: ["storyboard", "inputBindings"] },
  { type: "approval.wait", purpose: "Pause the workflow until the signed-in user approves this node.", configFields: ["title", "message"] },
  { type: "merge", purpose: "Merge completed dependency results into one result object.", configFields: [] },
  { type: "noop", purpose: "Complete without side effects.", configFields: [] },
]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(values.map(text).filter(Boolean))];
const nodeType = (value) => {
  const normalized = text(value).toLowerCase();
  return NODE_TYPE_ALIASES.get(normalized) || normalized;
};

// Agent output is free-form text, while visual parameter values are option
// identifiers. Keep only canonical option keys here; descriptors stay in the
// prompt. This prevents an Agent phrase such as "photorealistic cinematic"
// from turning a valid image workflow into a paid, failed provider request.
const sanitizeAgentVisualParameters = (value) => {
  const source = object(value);
  const result = {};
  for (const key of ["style", "camera", "lighting", "background", "shot", "motion"]) {
    const option = text(source[key]).toLowerCase();
    if (/^[a-z0-9][a-z0-9_-]{0,79}$/.test(option)) result[key] = option;
  }
  return result;
};

const canonicalNode = (raw, index, incoming = []) => {
  const source = object(raw);
  const id = text(source.id || source.nodeKey || source.node_key || `node_${index + 1}`);
  const type = nodeType(source.type || source.nodeType || source.node_type);
  const config = {
    ...object(source.config),
  };
  const assignIfPresent = (targetKey, ...candidates) => {
    const value = candidates.find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
    if (value !== undefined) config[targetKey] = value;
  };
  assignIfPresent("title", source.title, source.label, config.title);
  assignIfPresent("prompt", source.prompt, config.prompt);
  assignIfPresent("sceneKey", source.sceneKey, source.scene_key, config.sceneKey, config.scene_key);
  assignIfPresent("model", source.model, config.model);
  assignIfPresent("seconds", source.seconds, config.seconds);
  assignIfPresent("size", source.size, config.size);
  assignIfPresent("templateId", source.templateId, source.template_id, config.templateId, config.template_id);
  assignIfPresent("connectionId", source.connectionId, source.connection_id, config.connectionId, config.connection_id);
  assignIfPresent("serverKey", source.serverKey, source.server_key, config.serverKey, config.server_key);
  assignIfPresent("toolName", source.toolName, source.tool_name, source.tool, source.toolKey, config.toolName, config.tool_name, config.tool, config.toolKey);
  if (["image.generate", "video.generate"].includes(type)) {
    const visualParameters = sanitizeAgentVisualParameters(config.visualParameters ?? config.visual_parameters);
    delete config.visual_parameters;
    if (Object.keys(visualParameters).length) config.visualParameters = visualParameters;
    else delete config.visualParameters;
  }
  const inputBindings = object(source.inputBindings || source.input_bindings);
  if (Object.keys(inputBindings).length > 0) config.inputBindings = { ...object(config.inputBindings), ...inputBindings };
  const dependsOn = unique([
    ...list(source.dependsOn || source.depends_on),
    ...incoming,
  ]).filter((dependency) => dependency !== id);
  return {
    ...source,
    id,
    type,
    dependsOn,
    pointsEstimate: source.pointsEstimate ?? source.points_estimate ?? source.pointsCost ?? source.points_cost ?? 0,
    config,
  };
};

export const listWorkflowAgentNodeTypes = () => structuredClone(NODE_CATALOG);

export const canonicalizeAgentWorkflowDefinition = (value = {}) => {
  const source = object(value);
  const rawNodes = list(source.nodes);
  const knownIds = new Set(rawNodes.map((node, index) => text(node?.id || node?.nodeKey || node?.node_key || `node_${index + 1}`)));
  const edges = list(source.edges).map((edge) => ({
    id: text(edge?.id || `${edge?.from || edge?.source || ""}->${edge?.to || edge?.target || ""}`),
    from: text(edge?.from || edge?.source),
    to: text(edge?.to || edge?.target),
  })).filter((edge) => edge.from && edge.to && edge.from !== edge.to && knownIds.has(edge.from) && knownIds.has(edge.to));
  const incoming = new Map();
  for (const edge of edges) incoming.set(edge.to, [...(incoming.get(edge.to) || []), edge.from]);
  const nodes = rawNodes.map((node, index) => canonicalNode(node, index, incoming.get(text(node?.id || node?.nodeKey || node?.node_key || `node_${index + 1}`)) || []));
  return {
    ...source,
    version: Number(source.version || 1),
    nodes,
    edges,
  };
};

const EDGE_NODE_PREFIXES = Object.freeze(["input", "template", "image", "video", "generate", "node"]);

const endpointVariants = (value) => {
  const raw = text(value);
  const variants = new Set([raw]);
  let current = raw;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of EDGE_NODE_PREFIXES) {
      const pattern = new RegExp(`^${prefix}[-_]`, "i");
      if (!pattern.test(current)) continue;
      current = current.replace(pattern, "");
      if (current && !variants.has(current)) {
        variants.add(current);
        changed = true;
      }
    }
  }
  return [...variants].map((candidate) => candidate.toLowerCase());
};

const workflowNodeReferenceValues = (node) => {
  const config = { ...object(node?.fields), ...object(node?.config) };
  return [
    node?.id,
    node?.nodeKey,
    node?.node_key,
    node?.title,
    node?.label,
    config.templateId,
    config.template_id,
    config.sceneKey,
    config.scene_key,
  ].flatMap(endpointVariants);
};

/**
 * Repair only unambiguous Agent edge aliases before strict persistence
 * validation. Template identifiers remain node config; edges still resolve
 * to actual node IDs and unresolved references are left for validation to reject.
 */
export const repairAgentWorkflowEdgeReferences = (value = {}) => {
  const source = object(value);
  const nodes = list(source.nodes);
  const exactIds = new Set(nodes.map((node) => text(node?.id || node?.nodeKey || node?.node_key)).filter(Boolean));
  const resolveEndpoint = (endpoint) => {
    const requested = text(endpoint);
    if (!requested || exactIds.has(requested)) return requested;
    const variants = new Set(endpointVariants(requested));
    const matches = nodes.filter((node) => workflowNodeReferenceValues(node).some((candidate) => variants.has(candidate)));
    const ids = [...new Set(matches.map((node) => text(node?.id || node?.nodeKey || node?.node_key)).filter(Boolean))];
    return ids.length === 1 ? ids[0] : requested;
  };
  return {
    ...source,
    edges: list(source.edges).map((edge) => ({
      ...object(edge),
      from: resolveEndpoint(edge?.from || edge?.source),
      to: resolveEndpoint(edge?.to || edge?.target),
    })),
  };
};

const WORKFLOW_PATCH_OPERATION_ALIASES = new Map([
  ["add", "add_node"],
  ["addnode", "add_node"],
  ["node_add", "add_node"],
  ["update", "update_node"],
  ["updatenode", "update_node"],
  ["node_update", "update_node"],
  ["remove", "remove_node"],
  ["delete", "remove_node"],
  ["deletenode", "remove_node"],
  ["delete_node", "remove_node"],
  ["node_remove", "remove_node"],
  ["add_edge", "connect"],
  ["edge_add", "connect"],
  ["link", "connect"],
  ["remove_edge", "disconnect"],
  ["edge_remove", "disconnect"],
  ["unlink", "disconnect"],
  ["set_variable", "set_variables"],
  ["variables_set", "set_variables"],
  ["set_name", "rename"],
  ["rename_workflow", "rename"],
  ["clear_all", "clear"],
  ["reset", "clear"],
]);

export const normalizeWorkflowPatchOperationName = (operation) => {
  const raw = text(operation?.type || operation?.op || operation?.action || operation?.operation)
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(".", "_")
    .replaceAll(" ", "_");
  return WORKFLOW_PATCH_OPERATION_ALIASES.get(raw) || raw;
};

export const applyAgentWorkflowOperations = (definition, operations = []) => {
  let current = canonicalizeAgentWorkflowDefinition(definition);
  for (const rawOperation of list(operations)) {
    const operation = object(rawOperation);
    const action = normalizeWorkflowPatchOperationName(operation);
    if (action === "clear") {
      current = { ...current, nodes: [], edges: [] };
      continue;
    }
    if (["add_node", "node_add"].includes(action)) {
      const candidate = object(operation.node || operation.value);
      current = { ...current, nodes: [...current.nodes, candidate] };
      current = canonicalizeAgentWorkflowDefinition(current);
      continue;
    }
    if (["update_node", "node_update"].includes(action)) {
      const targetId = text(operation.nodeId || operation.node_id || operation.id);
      const patch = object(operation.patch || operation.node || operation.value);
      current = {
        ...current,
        nodes: current.nodes.map((node) => node.id === targetId
          ? { ...node, ...patch, id: node.id, config: { ...object(node.config), ...object(patch.config) } }
          : node),
      };
      current = canonicalizeAgentWorkflowDefinition(current);
      continue;
    }
    if (["remove_node", "node_remove", "delete_node"].includes(action)) {
      const targetId = text(operation.nodeId || operation.node_id || operation.id);
      current = {
        ...current,
        nodes: current.nodes
          .filter((node) => node.id !== targetId)
          .map((node) => ({ ...node, dependsOn: list(node.dependsOn).filter((dependency) => dependency !== targetId) })),
        edges: current.edges.filter((edge) => edge.from !== targetId && edge.to !== targetId),
      };
      continue;
    }
    if (["connect", "edge_add"].includes(action)) {
      const from = text(operation.from || operation.source);
      const to = text(operation.to || operation.target);
      current = canonicalizeAgentWorkflowDefinition({
        ...current,
        edges: [...current.edges, { id: text(operation.id || `${from}->${to}`), from, to }],
      });
      continue;
    }
    if (["disconnect", "edge_remove"].includes(action)) {
      const from = text(operation.from || operation.source);
      const to = text(operation.to || operation.target);
      current = canonicalizeAgentWorkflowDefinition({
        ...current,
        edges: current.edges.filter((edge) => !(edge.from === from && edge.to === to)),
        nodes: current.nodes.map((node) => node.id === to
          ? { ...node, dependsOn: list(node.dependsOn).filter((dependency) => dependency !== from) }
          : node),
      });
      continue;
    }
    if (action === "set_variables") {
      current = {
        ...current,
        variables: object(operation.variables || operation.value),
      };
      continue;
    }
    if (action === "rename") {
      current = {
        ...current,
        name: text(operation.name || operation.value) || current.name,
      };
      continue;
    }
    const error = new Error(`Unsupported workflow patch operation: ${action || "<empty>"}`);
    error.status = 400;
    error.code = "WORKFLOW_PATCH_OPERATION_UNSUPPORTED";
    throw error;
  }
  return canonicalizeAgentWorkflowDefinition(current);
};
