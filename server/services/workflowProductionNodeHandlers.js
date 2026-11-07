import { createHash } from "node:crypto";

const CANONICAL_NODE_TYPES = Object.freeze([
  "image.generate",
  "video.generate",
  "agent.call",
  "script.optimize",
  "mcp.call",
]);

const NODE_TYPE_ALIASES = new Map([
  ["media.generate.image", "image.generate"],
  ["media.generate.video", "video.generate"],
]);

const fail = (message, { status = 400, code = "WORKFLOW_NODE_EXECUTION_FAILED", ...extra } = {}) => Object.assign(new Error(message), {
  status,
  code,
  ...extra,
});

const normalizeNodeType = (value) => {
  const nodeType = String(value || "").trim().toLowerCase();
  return NODE_TYPE_ALIASES.get(nodeType) || nodeType;
};

const unsupported = (nodeType) => fail(`Workflow node type ${nodeType || "<empty>"} is not supported`, {
  status: 422,
  code: "WORKFLOW_NODE_TYPE_UNSUPPORTED",
  nodeType: nodeType || null,
});

const required = (value, label, code) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw fail(`${label} is required`, { code });
  return normalized;
};

const objectOrEmpty = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const arrayOrEmpty = (value) => Array.isArray(value) ? value : [];

const valueAtPath = (value, pathValue) => {
  const path = String(pathValue || "").split(".").filter(Boolean);
  let current = value;
  for (const segment of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

const resolveInputExpression = (expression, inputs) => {
  const raw = String(expression || "")
    .trim()
    .replace(/^\$\{\s*|\s*\}$/g, "")
    .replace(/^\{\{\s*|\s*\}\}$/g, "");
  if (raw.startsWith("variables.")) return valueAtPath(inputs?.__variables, raw.slice("variables.".length));
  if (raw.startsWith("loop.")) return valueAtPath(inputs?.__loop, raw.slice("loop.".length));
  if (raw.startsWith("inputs.")) {
    const workflowInput = valueAtPath(inputs?.__inputs, raw.slice("inputs.".length));
    if (workflowInput !== undefined) return workflowInput;
  }
  const orderedKeys = Object.keys(inputs || {});
  if (raw.startsWith("previous.")) {
    const previousKey = orderedKeys.at(-1);
    return previousKey ? valueAtPath(inputs[previousKey], raw.slice("previous.".length)) : undefined;
  }
  const keys = [...orderedKeys].sort((left, right) => right.length - left.length);
  const prefix = raw.startsWith("nodes.") ? "nodes." : raw.startsWith("inputs.") ? "inputs." : "";
  if (!prefix) return undefined;
  const remainder = raw.slice(prefix.length);
  const nodeKey = keys.find((key) => remainder === key || remainder.startsWith(`${key}.`));
  if (!nodeKey) return undefined;
  return remainder === nodeKey ? inputs[nodeKey] : valueAtPath(inputs[nodeKey], remainder.slice(nodeKey.length + 1));
};

const interpolateValue = (value, inputs) => {
  if (typeof value === "string") {
    const exact = value.match(/^(?:\{\{|\$\{)\s*(.*?)\s*(?:\}\}|\})$/);
    if (exact) {
      const resolved = resolveInputExpression(exact[1], inputs);
      return resolved === undefined ? value : resolved;
    }
    return value.replace(/(?:\{\{|\$\{)\s*(.*?)\s*(?:\}\}|\})/g, (match, expression) => {
      const resolved = resolveInputExpression(expression, inputs);
      if (resolved == null) return "";
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, inputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateValue(item, inputs)]));
  }
  return value;
};

const firstInputText = (inputs) => {
  const candidates = Object.entries(inputs || {})
    .filter(([key]) => !key.startsWith("__"))
    .map(([, value]) => value)
    .reverse();
  const paths = [
    "result.finalPrompt", "result.prompt", "result.summary", "result.script",
    "finalPrompt", "prompt", "summary", "script", "starterPrompt", "starter_prompt",
  ];
  for (const candidate of candidates) {
    for (const path of paths) {
      const value = valueAtPath(candidate, path);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
};

const expressionInputsFor = (context) => ({
  ...objectOrEmpty(context.inputs),
  __variables: objectOrEmpty(context.executionContext?.variables),
  __inputs: objectOrEmpty(context.executionContext?.inputs),
  __loop: objectOrEmpty(context.executionContext?.loop),
});

const mediaCreationId = (value) => {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String(value.referenceId || value.reference_id || value.creationId || value.creation_id || value.id || "").trim();
};

const uniqueReferenceIds = (values) => [...new Set(values.map(mediaCreationId).filter(Boolean))].slice(0, 4);

const referenceIdsFor = (config, context, expectedType) => {
  const requestedNodes = [
    config.referenceFrom,
    config.reference_from,
    ...(Array.isArray(config.referenceFromNodes) ? config.referenceFromNodes : []),
    ...(Array.isArray(config.reference_from_nodes) ? config.reference_from_nodes : []),
  ].map((value) => String(value || "").trim()).filter(Boolean);
  const explicit = [
    config.referenceCreationId,
    config.reference_creation_id,
    ...(Array.isArray(config.referenceCreationIds) ? config.referenceCreationIds : []),
    ...(Array.isArray(config.reference_creation_ids) ? config.reference_creation_ids : []),
    ...(Array.isArray(config.referenceExpressions) ? config.referenceExpressions : []),
    ...(Array.isArray(config.reference_expressions) ? config.reference_expressions : []),
  ];
  const inputEntries = Object.entries(context.inputs || {}).reverse();
  const selectedEntries = requestedNodes.length > 0
    ? inputEntries.filter(([nodeKey]) => requestedNodes.includes(nodeKey))
    : inputEntries.filter(([nodeKey]) => {
      const type = String(context.inputTypes?.[nodeKey] || "").toLowerCase();
      return type.includes(expectedType) || type === `canvas.${expectedType}`;
    });
  return uniqueReferenceIds([...explicit, ...selectedEntries.map(([, result]) => result)]);
};

const resolveConfig = (rawConfig, inputs) => {
  const config = objectOrEmpty(interpolateValue(objectOrEmpty(rawConfig), inputs));
  const bindings = objectOrEmpty(config.inputBindings ?? config.input_bindings);
  for (const [field, expression] of Object.entries(bindings)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(field)) continue;
    const resolved = resolveInputExpression(expression, inputs);
    if (resolved !== undefined) config[field] = resolved;
  }
  if (!String(config.prompt || config.userPrompt || config.user_prompt || "").trim()) {
    const inherited = firstInputText(inputs);
    if (inherited) config.prompt = inherited;
  }
  return config;
};

const assertNoReferenceUploads = (config) => {
  const references = config.referenceImages ?? config.reference_images ?? [];
  if (!Array.isArray(references)) {
    throw fail("referenceImages must be an array", { code: "INVALID_WORKFLOW_REFERENCE_IMAGES" });
  }
  if (references.length > 0) {
    throw fail("Workflow JSON cannot safely carry binary reference images", {
      status: 422,
      code: "WORKFLOW_REFERENCE_IMAGES_UNSUPPORTED",
    });
  }
  return [];
};

const workflowIdempotencyKey = ({ userId, runId, nodeKey, nodeType }) => {
  const digest = createHash("sha256")
    .update(JSON.stringify({ userId, runId, nodeKey, nodeType }))
    .digest("hex");
  return `workflow-node:${digest}`;
};

const reconciliationPending = (result) => {
  if (result?.kind !== "reconciliation_pending") return result;
  throw fail("Generation result is awaiting reconciliation", {
    status: 503,
    code: "WORKFLOW_NODE_RECONCILIATION_PENDING",
    pendingReconciliation: true,
    creationId: result.creationId,
  });
};

const agentResult = (operation) => ({
  kind: "agent_result",
  operationId: String(operation.operationId),
  pointsCharged: Number(operation.pointsCost || 0),
  idempotentReplay: Boolean(operation.replayed),
  result: operation.result,
});

/**
 * Production workflow node module. The workflow executor owns orchestration;
 * generation and metered Agent modules remain the sole billing owners.
 */
export class WorkflowProductionNodeHandlerModule {
  #generationApplicationFactory;
  #creativeAgentFactory;
  #executeMeteredAgentOperation;
  #mcpRuntimeFactory;
  #videoResultResolver;
  #referenceImageResolver;
  #canvasResultWriter;

  constructor({
    generationApplicationFactory,
    creativeAgentFactory,
    executeMeteredAgentOperation,
    mcpRuntimeFactory,
    videoResultResolver = async ({ result }) => result,
    referenceImageResolver = async () => [],
    canvasResultWriter = async ({ result }) => result,
  } = {}) {
    for (const [name, dependency] of Object.entries({
      generationApplicationFactory,
      creativeAgentFactory,
      executeMeteredAgentOperation,
      mcpRuntimeFactory,
    })) {
      if (typeof dependency !== "function") throw new TypeError(`Workflow production handlers require ${name}`);
    }
    this.#generationApplicationFactory = generationApplicationFactory;
    this.#creativeAgentFactory = creativeAgentFactory;
    this.#executeMeteredAgentOperation = executeMeteredAgentOperation;
    this.#mcpRuntimeFactory = mcpRuntimeFactory;
    if (typeof videoResultResolver !== "function" || typeof referenceImageResolver !== "function" || typeof canvasResultWriter !== "function") {
      throw new TypeError("Workflow production handlers require valid workflow composition callbacks");
    }
    this.#videoResultResolver = videoResultResolver;
    this.#referenceImageResolver = referenceImageResolver;
    this.#canvasResultWriter = canvasResultWriter;
  }

  async execute(context = {}) {
    const nodeType = normalizeNodeType(context.nodeType);
    if (!CANONICAL_NODE_TYPES.includes(nodeType)) throw unsupported(nodeType);
    const userId = required(context.userId, "Workflow run userId", "WORKFLOW_RUN_USER_REQUIRED");
    const runId = required(context.runId, "runId", "WORKFLOW_RUN_ID_REQUIRED");
    const nodeKey = required(context.nodeKey, "nodeKey", "WORKFLOW_NODE_KEY_REQUIRED");
    const config = resolveConfig(context.config, expressionInputsFor(context));
    const idempotencyKey = workflowIdempotencyKey({ userId, runId, nodeKey, nodeType });

    if (nodeType === "image.generate") {
      let referenceImages = assertNoReferenceUploads(config);
      const referenceIds = referenceIdsFor({
        ...config,
        referenceExpressions: [config.referenceExpression, config.reference_expression].filter(Boolean),
      }, { ...context, config }, "image");
      if (referenceImages.length === 0 && referenceIds.length > 0) {
        referenceImages = (await Promise.all(referenceIds.map((creationId) => this.#referenceImageResolver({ userId, creationId })))).flat();
      }
      const result = reconciliationPending(await this.#generationApplicationFactory().generateImage({
        userId,
        idempotencyKey,
        sceneKey: config.sceneKey || config.scene_key,
        userPrompt: config.userPrompt ?? config.user_prompt ?? config.prompt,
        model: config.model,
        size: config.size,
        visualParameters: config.visualParameters ?? config.visual_parameters,
        referenceImages,
      }));
      return this.#canvasResultWriter({ userId, runId, canvasId: context.canvasId, nodeKey, nodeType, config, result });
    }

    if (nodeType === "video.generate") {
      let referenceImages = assertNoReferenceUploads(config);
      const referenceIds = referenceIdsFor({
        ...config,
        referenceExpressions: [config.referenceExpression, config.reference_expression].filter(Boolean),
      }, { ...context, config }, "image");
      if (referenceImages.length === 0 && referenceIds.length > 0) {
        referenceImages = (await Promise.all(referenceIds.map((creationId) => this.#referenceImageResolver({ userId, creationId })))).flat();
      }
      const checkpointCreationId = mediaCreationId(context.checkpoint);
      const submitted = checkpointCreationId
        ? { kind: "replay", creationId: checkpointCreationId, status: "pending" }
        : reconciliationPending(await this.#generationApplicationFactory().generateVideo({
            userId,
            idempotencyKey,
            sceneKey: config.sceneKey || config.scene_key,
            userPrompt: config.userPrompt ?? config.user_prompt ?? config.prompt,
            model: config.model,
            seconds: config.seconds,
            size: config.size,
            visualParameters: config.visualParameters ?? config.visual_parameters,
            referenceImages,
            roleId: config.roleId || config.role_id,
            requireDigitalHuman: config.requireDigitalHuman === true || config.require_digital_human === true,
            allowOfflineRender: config.allowOfflineRender === true || config.allow_offline_render === true,
          }));
      const result = await this.#videoResultResolver({ userId, result: submitted, attemptCount: context.attemptCount });
      return this.#canvasResultWriter({ userId, runId, canvasId: context.canvasId, nodeKey, nodeType, config, result });
    }

    if (nodeType === "agent.call") {
      const configuredCanvas = objectOrEmpty(config.canvas);
      const request = {
        userId,
        instruction: config.instruction ?? config.prompt,
        canvas: {
          id: String(context.canvasId || ""),
          title: String(configuredCanvas.title ?? config.canvasTitle ?? config.canvas_title ?? "").slice(0, 120),
          state: objectOrEmpty(configuredCanvas.state ?? config.canvasState ?? config.canvas_state ?? config.state),
        },
        selectedIds: arrayOrEmpty(config.selectedIds ?? config.selected_ids),
        templates: objectOrEmpty(config.templates),
        mentions: arrayOrEmpty(config.mentions),
        visualParameters: config.visualParameters ?? config.visual_parameters ?? {},
        language: config.language === "en" ? "en" : "zh",
      };
      const operation = await this.#executeMeteredAgentOperation({
        userId,
        operationType: "canvas_agent_plan",
        idempotencyKey,
        requestPayload: request,
        invoke: ({ route }) => this.#creativeAgentFactory().planCanvas({ ...request, modelRoute: route }),
      });
      return agentResult(operation);
    }

    if (nodeType === "script.optimize") {
      const request = {
        userId,
        brief: config.brief ?? config.prompt,
        language: config.language === "en" ? "en" : "zh",
        durationSeconds: config.durationSeconds ?? config.duration_seconds ?? config.seconds ?? 30,
      };
      const operation = await this.#executeMeteredAgentOperation({
        userId,
        operationType: "digital_human_script_optimizer",
        idempotencyKey,
        requestPayload: request,
        invoke: ({ route }) => this.#creativeAgentFactory().optimizeDigitalHumanScript({ ...request, modelRoute: route }),
      });
      return agentResult(operation);
    }

    const trustedExecution = objectOrEmpty(config.__stardrawExecutionContext);
    const connectionId = required(
      config.connectionId || config.connection_id,
      "connectionId",
      "MCP_CONNECTION_ID_REQUIRED",
    );
    return this.#mcpRuntimeFactory().callTool({
      userId,
      userRole: trustedExecution.userRole || "user",
      agentMode: trustedExecution.agentMode || "ask_for_approval",
      connectionId,
      serverKey: config.serverKey || config.server_key || null,
      toolName: config.toolName || config.tool_name || config.tool || config.toolKey || config.tool_key,
      arguments: config.arguments ?? {},
      approvalId: trustedExecution.approvalId || null,
    });
  }
}

export const isWorkflowProductionNodeType = (value) => CANONICAL_NODE_TYPES.includes(normalizeNodeType(value));

export const resolveWorkflowProductionNodeCost = (value) => {
  const nodeType = normalizeNodeType(value);
  if (!CANONICAL_NODE_TYPES.includes(nodeType)) throw unsupported(nodeType);
  return 0;
};

export const createWorkflowProductionNodeHandlers = (dependencies) => {
  const module = new WorkflowProductionNodeHandlerModule(dependencies);
  return new Map([
    ...CANONICAL_NODE_TYPES.map((nodeType) => [nodeType, (context) => module.execute(context)]),
    ...[...NODE_TYPE_ALIASES.keys()].map((nodeType) => [nodeType, (context) => module.execute(context)]),
  ]);
};

export const WORKFLOW_PRODUCTION_NODE_TYPES = CANONICAL_NODE_TYPES;
