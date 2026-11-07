import {
  AgentToolRegistryPort,
  AGENT_MODES,
  TOOL_OPERATION_CLASSES,
  USER_ROLES,
  normalizeToolOperationClass,
  requireNonEmptyIdentifier,
} from "../ports/agentToolPort.js";

const TOOL_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const VALID_ROLES = new Set(Object.values(USER_ROLES));
const VALID_MODES = new Set(Object.values(AGENT_MODES));
const identifierSchema = (maxLength = 255) => ({ type: "string", minLength: 1, maxLength });
const strictObjectSchema = (required, properties) => ({
  type: "object",
  required,
  additionalProperties: false,
  properties,
});

const fail = (message, code = "INVALID_AGENT_TOOL", status = 400) => Object.assign(new Error(message), {
  status,
  code,
});

const normalizeList = (value, fallback, validator, name) => {
  const values = value == null ? fallback : value;
  if (!Array.isArray(values) || values.length === 0) throw fail(`${name} must be a non-empty array`);
  const unique = [...new Set(values.map((item) => validator(item)))];
  if (unique.length !== values.length && name === "requiredRoles") {
    // Duplicates are harmless, but silently normalizing them makes persisted
    // definitions deterministic.
    return unique;
  }
  return unique;
};

const normalizeRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  if (!VALID_ROLES.has(role)) throw fail(`Unknown required user role: ${role}`, "INVALID_REQUIRED_ROLE");
  return role;
};

const normalizeMode = (value) => {
  const mode = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!VALID_MODES.has(mode)) throw fail(`Unknown Agent mode: ${mode}`, "INVALID_TOOL_MODE");
  return mode;
};

const normalizeScope = (value) => {
  const scope = String(value || "user_owned").trim().toLowerCase();
  if (!new Set(["user_owned", "platform"]).has(scope)) {
    throw fail("Tool resourceScope must be user_owned or platform", "INVALID_TOOL_SCOPE");
  }
  return scope;
};

export const normalizeToolDefinition = (definition = {}) => {
  const toolKey = requireNonEmptyIdentifier(definition.toolKey || definition.id || definition.name, "toolKey").toLowerCase();
  if (!TOOL_KEY_PATTERN.test(toolKey)) throw fail("toolKey contains unsupported characters", "INVALID_TOOL_KEY");
  const operationClass = normalizeToolOperationClass(
    definition.operationClass || definition.riskLevel || definition.risk || TOOL_OPERATION_CLASSES.CREATIVE,
  );
  const requiredRoles = normalizeList(
    definition.requiredRoles || definition.allowedRoles,
    Object.values(USER_ROLES),
    normalizeRole,
    "requiredRoles",
  );
  const allowedModes = normalizeList(
    definition.allowedModes,
    Object.values(AGENT_MODES),
    normalizeMode,
    "allowedModes",
  );
  const version = definition.version == null ? 1 : Number(definition.version);
  if (!Number.isSafeInteger(version) || version < 1) throw fail("Tool version must be a positive integer", "INVALID_TOOL_VERSION");

  return Object.freeze({
    toolKey,
    name: String(definition.name || toolKey).trim().slice(0, 160),
    description: String(definition.description || "").trim().slice(0, 2000),
    version,
    operationClass,
    riskLevel: operationClass,
    requiredRoles,
    allowedModes,
    resourceScope: normalizeScope(definition.resourceScope || definition.scope),
    requiresOwnership: Boolean(definition.requiresOwnership),
    enabled: definition.enabled !== false,
    approvalPolicy: definition.approvalPolicy === "always" ? "always" : "policy",
    inputSchema: definition.inputSchema && typeof definition.inputSchema === "object" ? structuredClone(definition.inputSchema) : null,
    metadata: definition.metadata && typeof definition.metadata === "object" ? structuredClone(definition.metadata) : {},
  });
};

export class InMemoryAgentToolStore {
  #tools = new Map();

  save(tool) {
    this.#tools.set(tool.toolKey, tool);
    return tool;
  }

  get(toolKey) {
    return this.#tools.get(String(toolKey || "").trim().toLowerCase()) || null;
  }

  list() {
    return [...this.#tools.values()];
  }

  remove(toolKey) {
    return this.#tools.delete(String(toolKey || "").trim().toLowerCase());
  }
}

export class AgentToolRegistry extends AgentToolRegistryPort {
  #store;

  constructor({ store = new InMemoryAgentToolStore(), tools = [] } = {}) {
    super();
    this.#store = store;
    for (const definition of tools) this.#store.save(normalizeToolDefinition(definition));
  }

  registerTool(definition, { actorRole = USER_ROLES.ROOT, replace = false } = {}) {
    if (actorRole !== USER_ROLES.ROOT) {
      throw fail("Only the root administrator can register Agent tools", "AGENT_TOOL_REGISTRATION_FORBIDDEN", 403);
    }
    const tool = normalizeToolDefinition(definition);
    const existing = this.#store.get(tool.toolKey);
    if (existing && !replace) throw fail("Agent tool is already registered", "AGENT_TOOL_ALREADY_REGISTERED", 409);
    return this.#store.save(tool);
  }

  register(definition, options) {
    return this.registerTool(definition, options);
  }

  getTool(toolKey, { includeDisabled = false } = {}) {
    const tool = this.#store.get(toolKey);
    if (!tool || (!includeDisabled && !tool.enabled)) return null;
    return tool;
  }

  resolveTool(toolKey, options) {
    const tool = this.getTool(toolKey, options);
    if (!tool) throw fail("Agent tool is not registered or enabled", "AGENT_TOOL_NOT_FOUND", 404);
    return tool;
  }

  listTools({ includeDisabled = false, globalOnly = false } = {}) {
    return this.#store.list().filter((tool) => (
      (includeDisabled || tool.enabled)
      && (!globalOnly || tool.metadata?.exposeToGlobalAgent !== false)
    ));
  }

  unregisterTool(toolKey, { actorRole = USER_ROLES.ROOT } = {}) {
    if (actorRole !== USER_ROLES.ROOT) {
      throw fail("Only the root administrator can unregister Agent tools", "AGENT_TOOL_REGISTRATION_FORBIDDEN", 403);
    }
    const normalizedKey = requireNonEmptyIdentifier(toolKey, "toolKey").toLowerCase();
    if (!this.#store.remove(normalizedKey)) throw fail("Agent tool is not registered", "AGENT_TOOL_NOT_FOUND", 404);
    return { toolKey: normalizedKey, removed: true };
  }
}

export const DEFAULT_AGENT_TOOLS = Object.freeze([
  { toolKey: "agent.capability.search", name: "搜索 Agent 能力", description: "Search the complete role-filtered Agent tool registry when the currently disclosed tools do not clearly cover the request. Returns tool contracts for the next ReAct turn.", operationClass: "read", inputSchema: strictObjectSchema(["query"], { query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 40 } }) },
  { toolKey: "canvas.list", name: "列出我的画布", description: "List the current user's canvases. Returns {canvases:[...]}. Use before canvas.read when the user did not provide a canvas id.", operationClass: "read", inputSchema: strictObjectSchema([], { limit: { type: "integer", minimum: 1, maximum: 50 } }) },
  { toolKey: "canvas.create", name: "创建画布", description: "Create a new canvas for the current user.", operationClass: "reversible", inputSchema: strictObjectSchema([], { title: { type: "string", maxLength: 120 }, state: { type: "object" } }) },
  { toolKey: "canvas.read", name: "读取画布", description: "Read one canvas owned by the current user. Use updatedAt as expectedUpdatedAt for every later mutation.", operationClass: "read", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId"], { canvasId: identifierSchema() }) },
  { toolKey: "canvas.edit", name: "替换画布", description: "Replace the complete saved state of one owned canvas. Requires the updatedAt returned by canvas.read to prevent overwriting concurrent edits.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "state"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), state: { type: "object" }, title: { type: "string", maxLength: 120 } }) },
  { toolKey: "canvas.patch", name: "局部编辑画布", description: "Safely patch selected canvas sections or elements while preserving unrelated state. Requires optimistic concurrency with expectedUpdatedAt.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), title: { type: "string", maxLength: 120 }, patch: { type: "object" }, appendElements: { type: "array", maxItems: 100, items: { type: "object" } }, updateElements: { type: "array", maxItems: 100, items: { type: "object" } }, removeElementIds: { type: "array", maxItems: 100, items: identifierSchema(80) } }) },
  { toolKey: "canvas.asset.attach_creation", name: "把作品加入画布", description: "Attach one completed image or video creation owned by the current user to an owned canvas.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "creationId"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), creationId: identifierSchema(), title: { type: "string", maxLength: 120 }, x: { type: "number" }, y: { type: "number" }, width: { type: "number", minimum: 1 }, height: { type: "number", minimum: 1 } }) },
  { toolKey: "canvas.asset.upload", name: "上传本地素材", description: "Ask the signed-in user to choose one local image, video, or audio file and upload it to their private canvas asset library.", operationClass: "reversible", requiresOwnership: true, metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["canvasId"], { canvasId: identifierSchema(), mediaType: { enum: ["image", "video", "audio"] } }) },
  { toolKey: "canvas.export.image", name: "导出画布 PNG", description: "Prepare a browser-local PNG export for one owned canvas. The durable Agent plan pauses until the signed-in browser completes it.", operationClass: "read", requiresOwnership: true, metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["canvasId"], { canvasId: identifierSchema() }) },
  { toolKey: "workflow.catalog", name: "查询工作流节点目录", description: "List every workflow node type supported by the server and the configuration fields each node accepts. Use this before building a workflow.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "workflow.read", name: "读取画布工作流", description: "Read the workflow currently saved in an owned canvas. Returns canvasId, updatedAt, workflow and an execution estimate.", operationClass: "read", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId"], { canvasId: identifierSchema() }) },
  { toolKey: "workflow.save", name: "保存画布工作流", description: "Replace the workflow saved in an owned canvas after server validation. Read the canvas or workflow first and pass its updatedAt as expectedUpdatedAt. This builds the workflow but does not run it.", operationClass: "reversible", requiresOwnership: true, inputSchema: { ...strictObjectSchema(["canvasId", "expectedUpdatedAt"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), definition: { type: "object" }, workflow: { type: "object" } }), oneOf: [{ required: ["definition"] }, { required: ["workflow"] }] } },
  { toolKey: "workflow.patch", name: "编辑画布工作流", description: "Apply ordered add_node, update_node, remove_node, connect, disconnect or clear operations to an owned canvas workflow, then validate and save it. This builds the workflow but does not run it.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "operations"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } }) },
  { toolKey: "workflow.run", name: "执行工作流", description: "Start a persistent workflow. Pass definition for an ad-hoc run, or pass canvasId without definition to run the workflow already saved in that owned canvas. Do not use this merely to build or save a workflow.", operationClass: "creative", requiresOwnership: true, inputSchema: { ...strictObjectSchema([], { canvasId: identifierSchema(), title: { type: "string", maxLength: 160 }, definition: { type: "object" }, workflow: { type: "object" } }), oneOf: [{ required: ["canvasId"] }, { required: ["definition"] }, { required: ["workflow"] }] } },
  { toolKey: "workflow.estimate", name: "预估工作流费用", description: "Normalize and validate a supplied workflow, or the workflow saved in canvasId, and estimate its points cost without starting it.", operationClass: "read", inputSchema: { ...strictObjectSchema([], { canvasId: identifierSchema(), definition: { type: "object" }, workflow: { type: "object" } }), oneOf: [{ required: ["canvasId"] }, { required: ["definition"] }, { required: ["workflow"] }] } },
  { toolKey: "workflow.get", name: "查询工作流", description: "Read a workflow run and all of its node statuses.", operationClass: "read", inputSchema: strictObjectSchema(["runId"], { runId: identifierSchema() }) },
  { toolKey: "workflow.events", name: "查询工作流事件", description: "Read progress events for an owned workflow run.", operationClass: "read", inputSchema: strictObjectSchema(["runId"], { runId: identifierSchema(), afterId: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } }) },
  { toolKey: "workflow.cancel", name: "取消工作流", description: "Cancel an owned workflow run. Completed nodes remain charged and pending nodes are skipped.", operationClass: "destructive", inputSchema: strictObjectSchema(["runId"], { runId: identifierSchema(), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "media.estimate", name: "预估生成费用", description: "Estimate the points required for an accessible image or video template with the selected model, duration and size.", operationClass: "read", inputSchema: strictObjectSchema(["sceneKey", "outputType"], { templateId: identifierSchema(), templateVersion: { type: "integer", minimum: 1 }, sceneKey: identifierSchema(120), outputType: { enum: ["image", "video"] }, model: identifierSchema(120), seconds: { type: "integer", minimum: 1, maximum: 600 }, size: { type: "string", maxLength: 80 } }) },
  { toolKey: "media.generate.image", name: "生成或编辑图片", description: "Generate an image from an allowed template. A selected owned/public community creation, public template preview, or current-user private upload may be passed as a reference.", operationClass: "creative", inputSchema: strictObjectSchema(["sceneKey", "userModification"], { templateId: identifierSchema(), templateVersion: { type: "integer", minimum: 1 }, sceneKey: identifierSchema(120), userModification: { type: "string", minLength: 1, maxLength: 12000 }, model: identifierSchema(120), size: { type: "string", maxLength: 80 }, visualParameters: { type: "object" }, referenceCreationIds: { type: "array", maxItems: 4, items: identifierSchema() }, referenceTemplateIds: { type: "array", maxItems: 4, items: identifierSchema() }, referenceUploadIds: { type: "array", maxItems: 4, items: identifierSchema() } }) },
  { toolKey: "media.remove-background", name: "移除图片背景", description: "Create a new edited image from one owned completed image, removing its background through a reference-capable model.", operationClass: "creative", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema(), sceneKey: identifierSchema(120), model: identifierSchema(120), size: { type: "string", maxLength: 80 }, replacementBackground: { type: "string", maxLength: 500 } }) },
  { toolKey: "media.remove-object", name: "移除图片物体", description: "Create a new edited image from one owned completed image, removing the described object through a reference-capable model.", operationClass: "creative", inputSchema: strictObjectSchema(["creationId", "objectDescription"], { creationId: identifierSchema(), objectDescription: { type: "string", minLength: 1, maxLength: 500 }, sceneKey: identifierSchema(120), model: identifierSchema(120), size: { type: "string", maxLength: 80 } }) },
  { toolKey: "media.generate.video", name: "生成视频", description: "Generate a standard or digital-human video from an allowed template. Selected image references may be supplied from an owned/public community creation, public template preview, or current-user private upload.", operationClass: "creative", inputSchema: strictObjectSchema(["sceneKey", "userModification"], { templateId: identifierSchema(), templateVersion: { type: "integer", minimum: 1 }, sceneKey: identifierSchema(120), userModification: { type: "string", minLength: 1, maxLength: 12000 }, model: identifierSchema(120), seconds: { type: "integer", minimum: 1, maximum: 600 }, size: { type: "string", maxLength: 80 }, visualParameters: { type: "object" }, referenceCreationIds: { type: "array", maxItems: 4, items: identifierSchema() }, referenceTemplateIds: { type: "array", maxItems: 4, items: identifierSchema() }, referenceUploadIds: { type: "array", maxItems: 4, items: identifierSchema() }, roleId: identifierSchema(), requireDigitalHuman: { type: "boolean" }, allowOfflineRender: { type: "boolean" } }) },
  { toolKey: "storyboard.edit", name: "替换分镜", description: "Replace the storyboard stored in an owned canvas with optimistic concurrency protection.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "storyboard"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), storyboard: { type: "object" } }) },
  { toolKey: "storyboard.patch", name: "局部编辑分镜", description: "Patch storyboard fields in an owned canvas while preserving unspecified fields.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "patch"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), patch: { type: "object" } }) },
  { toolKey: "timeline.edit", name: "编辑时间线", description: "Replace the browser-editing timeline stored in an owned canvas.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "timeline"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), timeline: { type: "object" } }) },
  { toolKey: "timeline.render", name: "本地渲染时间线", description: "Prepare browser-local timeline rendering and private asset upload for one owned canvas. The Agent plan pauses until the signed-in browser finishes.", operationClass: "creative", requiresOwnership: true, metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["canvasId"], { canvasId: identifierSchema() }) },
  { toolKey: "director3d.edit", name: "编辑 3D 导演台", description: "Replace 3D director settings stored in an owned canvas.", operationClass: "reversible", requiresOwnership: true, inputSchema: strictObjectSchema(["canvasId", "expectedUpdatedAt", "director3d"], { canvasId: identifierSchema(), expectedUpdatedAt: identifierSchema(64), director3d: { type: "object" } }) },
  { toolKey: "model.list", name: "列出可用模型", description: "List active models available to the current membership tier.", operationClass: "read", inputSchema: strictObjectSchema([], { outputType: { enum: ["image", "video", "agent"] } }) },
  { toolKey: "visual-parameter.list", name: "列出视觉参数", description: "List configured style, camera, lighting, background and motion choices.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "template.search", name: "搜索模板", description: "Search public templates and private templates owned by the current user.", operationClass: "read", inputSchema: { type: "object", properties: { query: { type: "string" }, outputType: { enum: ["image", "video"] } } } },
  { toolKey: "template.use", name: "读取模板", description: "Load one allowed template by id or sceneKey.", operationClass: "read", inputSchema: { type: "object", properties: { templateId: { type: "string" }, sceneKey: { type: "string" } } } },
  { toolKey: "template.create", name: "创建私有模板", description: "Create a private template owned by the current user. The server selects the provider route and pricing rule.", operationClass: "reversible", inputSchema: strictObjectSchema(["sceneName", "outputType", "defaultModel", "systemPrompt"], { sceneName: { type: "string", minLength: 1, maxLength: 160 }, outputType: { enum: ["image", "video"] }, defaultModel: identifierSchema(120), defaultSeconds: { type: "integer", minimum: 1, maximum: 600 }, defaultSize: { type: "string", maxLength: 80 }, systemPrompt: { type: "string", minLength: 1, maxLength: 12000 }, previewTitle: { type: "string", maxLength: 160 }, previewDescription: { type: "string", maxLength: 1000 }, starterPrompt: { type: "string", maxLength: 4000 }, placeholderText: { type: "string", maxLength: 500 }, requiresReference: { type: "boolean" }, tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 80 } } }) },
  { toolKey: "template.update", name: "更新私有模板", description: "Update fields of one private template owned by the current user and increment its version.", operationClass: "reversible", inputSchema: strictObjectSchema(["templateId", "patch"], { templateId: identifierSchema(), patch: { type: "object", additionalProperties: false, properties: { sceneName: { type: "string", minLength: 1, maxLength: 160 }, outputType: { enum: ["image", "video"] }, defaultModel: identifierSchema(120), defaultSeconds: { type: "integer", minimum: 1, maximum: 600 }, defaultSize: { type: "string", maxLength: 80 }, systemPrompt: { type: "string", minLength: 1, maxLength: 12000 }, previewTitle: { type: "string", maxLength: 160 }, previewDescription: { type: "string", maxLength: 1000 }, starterPrompt: { type: "string", maxLength: 4000 }, placeholderText: { type: "string", maxLength: 500 }, requiresReference: { type: "boolean" }, tags: { type: "array", maxItems: 30, items: { type: "string", maxLength: 80 } } } } }) },
  { toolKey: "template.import", name: "导入私有模板", description: "Import one versioned StarDraw template JSON document as a current-user private template.", operationClass: "reversible", inputSchema: strictObjectSchema(["document"], { document: { type: "object" } }) },
  { toolKey: "template.export", name: "导出模板", description: "Export one accessible template as a versioned StarDraw JSON document.", operationClass: "read", inputSchema: strictObjectSchema(["templateId"], { templateId: identifierSchema() }) },
  { toolKey: "template.preview.upload", name: "上传模板预览", description: "Ask the signed-in user to choose a local image or video and upload it as the preview of one owned private template.", operationClass: "reversible", metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["templateId", "previewKind"], { templateId: identifierSchema(), previewKind: { enum: ["image", "video"] } }) },
  { toolKey: "template.delete", name: "删除私有模板", description: "Delete one private template owned by the current user using the membership recycle-bin policy.", operationClass: "destructive", inputSchema: strictObjectSchema(["templateId"], { templateId: identifierSchema(), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "creation.history", name: "查询创作历史", description: "List the current user's image and video creations with the same pagination and filters as the history page.", operationClass: "read", inputSchema: strictObjectSchema([], { page: { type: "integer", minimum: 1, maximum: 10000 }, pageSize: { type: "integer", minimum: 1, maximum: 50 }, limit: { type: "integer", minimum: 1, maximum: 50 }, type: { enum: ["image", "video"] }, status: { enum: ["pending", "queued", "processing", "running", "completed", "failed", "cancelled"] }, query: { type: "string", maxLength: 100 } }) },
  { toolKey: "creation.get", name: "查询作品状态", description: "Read one image or video creation owned by the current user, including status and result URLs.", operationClass: "read", requiresOwnership: true, inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema() }) },
  { toolKey: "creation.download", name: "下载单个作品", description: "Prepare a browser download for one completed, unexpired creation owned by the current user.", operationClass: "read", requiresOwnership: true, metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema() }) },
  { toolKey: "creation.download.batch", name: "批量下载作品", description: "Prepare an authenticated ZIP download for up to 20 completed owned creations. The durable plan waits for the browser download.", operationClass: "read", metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["creationIds"], { creationIds: { type: "array", minItems: 1, maxItems: 20, items: identifierSchema() } }) },
  { toolKey: "creation.export.csv", name: "导出创作记录 CSV", description: "Prepare an authenticated CSV export of the current user's valid creation history. The durable plan waits for the browser download.", operationClass: "read", metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema([], {}) },
  { toolKey: "creation.failed.delete", name: "删除失败作品", description: "Atomically release any points still reserved by one failed creation, then delete it under the current user's recycle-bin policy.", operationClass: "destructive", requiresOwnership: true, inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema(), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "task.list", name: "查询任务中心", description: "List persistent jobs, workflows, and generation tasks for the current user.", operationClass: "read", inputSchema: strictObjectSchema([], { page: { type: "integer", minimum: 1, maximum: 10000 }, pageSize: { type: "integer", minimum: 1, maximum: 50 }, status: { enum: ["queued", "pending", "running", "processing", "paused", "waiting_approval", "waiting_client", "completed", "failed", "cancelled"] }, type: { type: "string", maxLength: 80 } }) },
  { toolKey: "task.get", name: "查询单个任务", description: "Read one task-center entry owned by the current user.", operationClass: "read", inputSchema: strictObjectSchema(["taskId"], { taskId: identifierSchema() }) },
  { toolKey: "task.cancel", name: "取消任务", description: "Cancel a cancellable persistent job or workflow owned by the current user.", operationClass: "destructive", inputSchema: strictObjectSchema(["taskId"], { taskId: identifierSchema(), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "community.list", name: "浏览社区", description: "Search or browse public community creations with type, sort and cursor filters.", operationClass: "read", inputSchema: strictObjectSchema([], { cursor: { type: "string", maxLength: 2048 }, limit: { type: "integer", minimum: 1, maximum: 40 }, type: { enum: ["image", "video"] }, sort: { enum: ["featured", "latest", "popular"] }, query: { type: "string", maxLength: 100 } }) },
  { toolKey: "community.get", name: "查看社区作品", description: "Read one public community creation by id.", operationClass: "read", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema() }) },
  { toolKey: "community.publication.get", name: "查看作品公开状态", description: "Read the community publication settings of one creation owned by the current user.", operationClass: "read", requiresOwnership: true, inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema() }) },
  { toolKey: "community.publish", name: "发布社区作品", description: "Publish one completed creation owned by the current user to the community.", operationClass: "publish", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema(), title: { type: "string", maxLength: 160 }, tags: { type: "array", maxItems: 20, items: { type: "string", maxLength: 80 } }, promptPublic: { type: "boolean" }, visualParameters: { type: "object" } }) },
  { toolKey: "community.unpublish", name: "取消公开作品", description: "Remove one owned creation from the public community feed.", operationClass: "publish", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema() }) },
  { toolKey: "community.like", name: "点赞社区作品", description: "Like or unlike a public community creation for the current user.", operationClass: "reversible", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema(), enabled: { type: "boolean" } }) },
  { toolKey: "community.favorite", name: "收藏社区作品", description: "Favorite or unfavorite a public community creation for the current user.", operationClass: "reversible", inputSchema: strictObjectSchema(["creationId"], { creationId: identifierSchema(), enabled: { type: "boolean" } }) },
  { toolKey: "community.report", name: "举报社区作品", description: "Report a public community creation. Only use after the user explicitly asks to report it.", operationClass: "publish", inputSchema: strictObjectSchema(["creationId", "reason"], { creationId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 80 }, details: { type: "string", maxLength: 1000 } }) },
  { toolKey: "account.balance", name: "查询积分和会员", description: "Read the current user's available points and membership tier.", operationClass: "read" },
  { toolKey: "account.ledger.list", name: "查询积分明细", description: "List the current user's point ledger with pagination and an optional entry-type filter.", operationClass: "read", inputSchema: strictObjectSchema([], { page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 50 }, entryType: { type: "string", maxLength: 80 } }) },
  { toolKey: "profile.read", name: "读取个人资料", description: "Read the current user's StarDraw profile.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "profile.update", name: "更新个人资料", description: "Update the current user's display name.", operationClass: "reversible", inputSchema: strictObjectSchema(["displayName"], { displayName: { type: "string", minLength: 1, maxLength: 40 } }) },
  { toolKey: "profile.avatar.upload", name: "上传头像", description: "Ask the signed-in user to choose a local image and upload it as their profile avatar.", operationClass: "reversible", metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema([], {}) },
  { toolKey: "content.recycle.list", name: "查看回收站", description: "List the current member user's own recycle-bin entries.", operationClass: "read", inputSchema: strictObjectSchema([], { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 } }) },
  { toolKey: "content.recycle.restore", name: "恢复回收站内容", description: "Restore one current-user recycle-bin entry.", operationClass: "reversible", inputSchema: strictObjectSchema(["entryId"], { entryId: identifierSchema() }) },
  { toolKey: "content.notification.list", name: "查看内容通知", description: "List current-user recycle-bin and content-moderation notifications.", operationClass: "read", inputSchema: strictObjectSchema([], { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 } }) },
  { toolKey: "content.notification.mark-read", name: "标记内容通知已读", description: "Mark one current-user content notification as read.", operationClass: "reversible", inputSchema: strictObjectSchema(["notificationId"], { notificationId: identifierSchema() }) },
  { toolKey: "content.delete", name: "删除内容", description: "Delete one resource owned by the current user using the configured soft-delete or hard-delete policy. Failed creations with reserved points must use creation.failed.delete.", operationClass: "destructive", requiresOwnership: true, inputSchema: strictObjectSchema(["resourceType", "resourceId"], { resourceType: { enum: ["creation", "canvas", "private_template", "digital_human", "upload"] }, resourceId: identifierSchema(), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "content.publish", name: "申请公开私有模板", description: "Submit an owned private template for administrator publication review.", operationClass: "publish", requiresOwnership: true, inputSchema: strictObjectSchema(["resourceId"], { resourceType: { type: "string", enum: ["template", "private_template", "prompt_template"] }, resourceId: identifierSchema() }) },
  // MCP ownership is verified by the MCP connection seam (userId + connection
  // row) rather than by a canvas/resource owner field supplied to Agent.
  { toolKey: "mcp.call.external", name: "调用外部 MCP", description: "Call a whitelisted MCP tool through the current user's own OAuth connection.", operationClass: "external_mcp", inputSchema: strictObjectSchema(["connectionId", "toolName"], { connectionId: identifierSchema(), serverKey: identifierSchema(128), toolName: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" }, arguments: { type: "object" } }) },
  { toolKey: "mcp.server.list", name: "列出 MCP 服务", description: "List enabled MCP services available for user authorization.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "mcp.connection.list", name: "列出 MCP 连接", description: "List the current user's OAuth MCP connections without exposing credentials.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "mcp.tool.list", name: "列出 MCP 工具", description: "List administrator-approved tools for one current-user MCP connection.", operationClass: "read", inputSchema: strictObjectSchema(["connectionId"], { connectionId: identifierSchema() }) },
  { toolKey: "mcp.connection.start", name: "连接 MCP 账号", description: "Start OAuth authorization for an enabled MCP service. Returns an authorization URL the user must open and approve.", operationClass: "external_mcp", inputSchema: strictObjectSchema(["serverKey"], { serverKey: identifierSchema(128), scopes: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 160 } } }) },
  { toolKey: "mcp.connection.revoke", name: "断开 MCP 账号", description: "Revoke one current-user MCP OAuth connection.", operationClass: "destructive", inputSchema: strictObjectSchema(["connectionId"], { connectionId: identifierSchema() }) },
  { toolKey: "subscription.plan.list", name: "查询会员套餐", description: "List active monthly and annual subscription plans.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "subscription.overview", name: "查询订阅状态", description: "Read the current user's subscription and points overview.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "subscription.order.get", name: "查询支付订单", description: "Read one current-user subscription order by order number.", operationClass: "read", inputSchema: strictObjectSchema(["orderNo"], { orderNo: identifierSchema(120) }) },
  { toolKey: "subscription.renewal.cancel", name: "取消自动续费", description: "Cancel automatic renewal for the current user's active subscription at the end of the paid period.", operationClass: "destructive", inputSchema: strictObjectSchema([], { reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "point-package.list", name: "查询长期积分包", description: "List active one-time point packages. Purchased points are currently retained long-term and do not change membership.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "point-package.order.get", name: "查询积分包订单", description: "Read one current-user long-term point-package order by order number.", operationClass: "read", inputSchema: strictObjectSchema(["orderNo"], { orderNo: identifierSchema(120) }) },
  { toolKey: "point-package.purchase", name: "购买积分包", description: "Create an Alipay order for a long-term point package. Always requires explicit user approval.", operationClass: "payment", inputSchema: strictObjectSchema(["packageKey"], { packageKey: identifierSchema(50) }) },
  { toolKey: "digital-human.role.list", name: "查询数字人角色", description: "List the current user's digital-human roles without exposing capture tokens or private object keys.", operationClass: "read", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "digital-human.role.create", name: "创建数字人角色", description: "Create a digital-human role and return a time-limited phone capture URL.", operationClass: "reversible", inputSchema: strictObjectSchema(["roleName"], { roleName: { type: "string", minLength: 1, maxLength: 120 }, roleDescription: { type: "string", maxLength: 1000 }, promptText: { type: "string", maxLength: 2000 } }) },
  { toolKey: "digital-human.role.capture-link.get", name: "获取数字人采集链接", description: "Return the current active capture URL for one owned digital-human role without exposing any other private storage data.", operationClass: "read", inputSchema: strictObjectSchema(["roleId"], { roleId: identifierSchema() }) },
  { toolKey: "digital-human.role.capture-link.rotate", name: "轮换数字人采集链接", description: "Revoke the old capture URL and issue a new 24-hour capture URL for one owned role.", operationClass: "reversible", inputSchema: strictObjectSchema(["roleId"], { roleId: identifierSchema() }) },
  { toolKey: "digital-human.role.capture-link.revoke", name: "撤销数字人采集链接", description: "Revoke the active capture URL for one owned role.", operationClass: "destructive", inputSchema: strictObjectSchema(["roleId"], { roleId: identifierSchema() }) },
  { toolKey: "digital-human.role.attach-creation", name: "将作品设为数字人素材", description: "Attach an owned completed image or video creation to one owned digital-human role as its portrait or demo video.", operationClass: "reversible", inputSchema: strictObjectSchema(["roleId", "creationId"], { roleId: identifierSchema(), creationId: identifierSchema(), assetKind: { enum: ["image", "video"] } }) },
  { toolKey: "digital-human.role.asset.upload", name: "上传数字人素材", description: "Ask the signed-in user to choose a local portrait image or demo video and upload it to one owned digital-human role.", operationClass: "reversible", metadata: { executionTarget: "browser" }, inputSchema: strictObjectSchema(["roleId", "assetKind"], { roleId: identifierSchema(), assetKind: { enum: ["image", "video"] } }) },
  { toolKey: "digital-human.script.optimize", name: "优化数字人口播稿", description: "Use the configured GPT Agent to optimize a digital-human script and charge the configured Agent points once.", operationClass: "creative", inputSchema: strictObjectSchema(["brief"], { brief: { type: "string", minLength: 1, maxLength: 5000 }, language: { enum: ["zh", "en"] }, durationSeconds: { type: "integer", minimum: 5, maximum: 600 } }) },
  { toolKey: "admin.user.list", name: "查询平台用户", description: "Administrator/root only. Search users and inspect role, status, membership and aggregate usage without exposing credentials.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], { page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, query: { type: "string", maxLength: 255 }, status: { enum: ["active", "suspended"] } }) },
  { toolKey: "admin.user.suspend", name: "暂停用户", description: "Administrator/root only. Suspend a mutable target account and revoke existing sessions. The fixed root can never be targeted.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["targetUserId", "reason"], { targetUserId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.user.restore", name: "恢复用户", description: "Administrator/root only. Restore a suspended mutable account. An administrator cannot restore another administrator and the fixed root is immutable.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["targetUserId", "reason"], { targetUserId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.template.list", name: "查询平台模板", description: "Administrator/root only. List platform-owned templates including inactive entries.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.template.review.list", name: "查询模板公开申请", description: "Administrator/root only. List pending user template publication requests.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.template.approve", name: "通过模板公开申请", description: "Administrator/root only. Publish a pending user template and optionally apply a membership threshold.", operationClass: "publish", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["templateId", "reason"], { templateId: identifierSchema(), requiredMembershipTier: { enum: ["free", "basic", "pro", "max", "enterprise"] }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.template.reject", name: "拒绝模板公开申请", description: "Administrator/root only. Reject a pending user template publication request without deleting the user's private template.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["templateId", "reason"], { templateId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.template.deactivate", name: "下架模板", description: "Administrator/root only. Deactivate a platform template or move a user template to the hidden administrative recycle bin.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["templateId", "reason"], { templateId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.content.delete", name: "管理删除用户内容", description: "Administrator/root only. Remove a user's creation, canvas, private template, digital-human role or upload through the administrative soft-delete policy. Administrators cannot target administrator/root content.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["ownerUserId", "resourceType", "resourceId", "reason"], { ownerUserId: identifierSchema(), resourceType: { enum: ["creation", "canvas", "private_template", "digital_human", "upload"] }, resourceId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.subscription-plan.list", name: "查询订阅套餐配置", description: "Administrator/root only. List active and inactive subscription plan configuration.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.subscription-plan.create", name: "创建订阅套餐", description: "Administrator/root only. Create a monthly or annual subscription plan. This does not initiate a payment.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.subscription-plan.update", name: "更新订阅套餐", description: "Administrator/root only. Update subscription pricing, entitlements, order and visibility. This does not charge users.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["planId", "configuration", "reason"], { planId: identifierSchema(), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.subscription-plan.deactivate", name: "停用订阅套餐", description: "Administrator/root only. Stop offering a subscription plan without deleting historical orders or subscriptions.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["planId", "reason"], { planId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.point-package.list", name: "查询长期积分包配置", description: "Administrator/root only. List active and inactive long-term point-package configuration.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.point-package.create", name: "创建长期积分包", description: "Administrator/root only. Create a one-time long-term point package. This does not initiate a payment.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.point-package.update", name: "更新长期积分包", description: "Administrator/root only. Update point-package pricing, points, order and visibility for future orders.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["packageId", "configuration", "reason"], { packageId: identifierSchema(), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.point-package.deactivate", name: "停用长期积分包", description: "Administrator/root only. Stop offering a point package without deleting historical orders or point lots.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["packageId", "reason"], { packageId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.recycle.list", name: "查询管理回收站", description: "Administrator/root only. List active administrative recycle-bin entries; administrators only see normal-user content.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], { limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 } }) },
  { toolKey: "admin.recycle.restore-request", name: "申请恢复管理回收站内容", description: "Administrator only. Request root approval to restore one administrative recycle-bin entry.", operationClass: "reversible", requiredRoles: ["admin"], resourceScope: "platform", inputSchema: strictObjectSchema(["entryId", "reason"], { entryId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.recycle.restore-approve", name: "批准管理恢复申请", description: "Root only. Approve a pending administrative restore request and restore the content.", operationClass: "reversible", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["requestId", "reason"], { requestId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.recycle.restore-reject", name: "拒绝管理恢复申请", description: "Root only. Reject a pending administrative restore request without permanently deleting content.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["requestId", "reason"], { requestId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.mcp.server.list", name: "查询 MCP 服务配置", description: "Administrator/root only. List registered MCP services without OAuth client secrets or user credentials.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.mcp.tool.list", name: "查询 MCP 工具白名单", description: "Administrator/root only. List enabled and disabled tool policy for one MCP service.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["serverKey"], { serverKey: identifierSchema(80) }) },
  { toolKey: "admin.mcp.tool.upsert", name: "配置 MCP 工具", description: "Administrator/root only. Add or update one MCP tool allowlist entry. User OAuth credentials are never accepted.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["serverKey", "toolName", "configuration", "reason"], { serverKey: identifierSchema(80), toolName: { type: "string", minLength: 1, maxLength: 160 }, configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.mcp.provider.list", name: "查询 MCP 提供商能力", description: "Root only. List supported and catalog-pending MCP provider capabilities.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "root.mcp.server.list", name: "查询 MCP 根配置", description: "Root only. List MCP server endpoints and policy metadata without credentials.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "root.mcp.server.register", name: "注册 MCP 服务", description: "Root only. Register a remote HTTPS/Streamable HTTP MCP service after SSRF and provider-capability checks. OAuth secrets are not accepted by Agent.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["serverKey", "displayName", "canonicalUrl", "providerAdapter", "reason"], { serverKey: identifierSchema(80), displayName: { type: "string", minLength: 1, maxLength: 160 }, canonicalUrl: { type: "string", minLength: 1, maxLength: 2048 }, providerAdapter: identifierSchema(80), transport: { enum: ["streamable_http", "sse"] }, allowedDomains: { type: "array", maxItems: 20, items: { type: "string", maxLength: 255 } }, oauthConfig: { type: "object" }, adminNotes: { type: "string", maxLength: 2000 }, status: { enum: ["draft", "catalog_pending", "disabled", "enabled"] }, enabled: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.mcp.server.status", name: "修改 MCP 服务状态", description: "Root only. Enable or disable a registered MCP service through the capability and transport admission checks.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["serverKey", "status", "enabled", "reason"], { serverKey: identifierSchema(80), status: { enum: ["draft", "catalog_pending", "disabled", "enabled"] }, enabled: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.mcp.audit.list", name: "查询 MCP 调用审计", description: "Root only. Query MCP call audit metadata; raw arguments and OAuth credentials are never returned.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], { userId: identifierSchema(), serverKey: identifierSchema(80), toolName: { type: "string", maxLength: 160 }, limit: { type: "integer", minimum: 1, maximum: 500 } }) },
  { toolKey: "admin.visual-parameter.list", name: "查询视觉参数配置", description: "Administrator/root only. List active and inactive visual parameter options.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.visual-parameter.create", name: "创建视觉参数", description: "Administrator/root only. Create a style, camera, light, background, shot or motion option.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.visual-parameter.update", name: "更新视觉参数", description: "Administrator/root only. Update one visual parameter option.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["optionId", "configuration", "reason"], { optionId: identifierSchema(), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.visual-parameter.deactivate", name: "停用视觉参数", description: "Administrator/root only. Deactivate one visual parameter option without deleting historical selections.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["optionId", "reason"], { optionId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.skill.list", name: "查询数据库 Skill", description: "Administrator/root only. List active and inactive administrator-managed Agent Skills.", operationClass: "read", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "admin.skill.create", name: "创建 Agent Skill", description: "Administrator/root only. Store an audited Markdown instruction Skill in PostgreSQL; it grants no runtime capability by itself.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.skill.update", name: "更新 Agent Skill", description: "Administrator/root only. Update and version one database Skill.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["skillName", "configuration", "reason"], { skillName: identifierSchema(64), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.skill.deactivate", name: "停用 Agent Skill", description: "Administrator/root only. Deactivate a database Skill so Agent no longer loads it.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["skillName", "reason"], { skillName: identifierSchema(64), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.community.hide", name: "下架社区作品", description: "Administrator/root only. Hide a public community creation with an audited reason; the underlying user content is not deleted.", operationClass: "destructive", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["creationId", "reason"], { creationId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.community.restore", name: "恢复社区作品", description: "Administrator/root only. Restore a previously hidden public community creation.", operationClass: "reversible", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["creationId", "reason"], { creationId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "admin.community.feature", name: "设置社区精选", description: "Administrator/root only. Feature or unfeature a visible public community creation.", operationClass: "publish", requiredRoles: ["admin", "root"], resourceScope: "platform", inputSchema: strictObjectSchema(["creationId", "featured", "reason"], { creationId: identifierSchema(), featured: { type: "boolean" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.user.role.set", name: "设置用户角色", description: "Root only. Grant or revoke administrator role for a mutable account. The fixed root can never be changed.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["targetUserId", "role", "reason"], { targetUserId: identifierSchema(), role: { enum: ["admin", "user"] }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model.list", name: "查询模型展示配置", description: "Root only. List active and inactive model catalog entries.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "root.model.create", name: "创建模型展示配置", description: "Root only. Create a model catalog entry. Provider secrets cannot be stored in model configuration.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model.update", name: "更新模型展示配置", description: "Root only. Update one model catalog entry while preserving route/template invariants.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["modelKey", "configuration", "reason"], { modelKey: identifierSchema(100), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model.deactivate", name: "停用模型", description: "Root only. Deactivate a model only when active templates no longer depend on it.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["modelKey", "reason"], { modelKey: identifierSchema(100), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model-route.list", name: "查询模型路由", description: "Root only. List active and inactive provider routes without provider credentials.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "root.model-route.create", name: "创建模型路由", description: "Root only. Create a provider route and synchronize dependent template routing.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["configuration", "reason"], { configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model-route.update", name: "更新模型路由", description: "Root only. Update one provider route while keeping active templates routable and priced.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["routeId", "configuration", "reason"], { routeId: identifierSchema(), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.model-route.deactivate", name: "停用模型路由", description: "Root only. Deactivate one provider route only when active templates retain a valid route.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["routeId", "reason"], { routeId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.execution-policy.list", name: "查询执行策略", description: "Root only. List rate, concurrency, queue and daily-quota policies by membership and operation.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], {}) },
  { toolKey: "root.execution-policy.update", name: "更新执行策略", description: "Root only. Update a bounded execution-governor policy with idempotency and audit context.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["membershipTier", "operationKey", "configuration", "reason"], { membershipTier: { enum: ["free", "basic", "pro", "max", "enterprise"] }, operationKey: identifierSchema(128), configuration: { type: "object" }, reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "root.audit.list", name: "查询管理员审计日志", description: "Root only. Query redacted administrator audit logs with bounded filters and pagination.", operationClass: "read", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema([], { page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 }, actorUserId: identifierSchema(), action: { type: "string", maxLength: 120 }, targetType: { type: "string", maxLength: 80 }, targetId: identifierSchema(), targetQuery: { type: "string", maxLength: 255 }, query: { type: "string", maxLength: 255 }, dateFrom: { type: "string", maxLength: 64 }, dateTo: { type: "string", maxLength: 64 } }) },
  { toolKey: "root.private-content.review", name: "紧急审查私有内容", description: "Root only. Read one specifically identified private resource for an incident, with five-minute asset grants and complete audit. This never performs bulk discovery.", operationClass: "destructive", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["ownerUserId", "resourceType", "resourceId", "reason"], { ownerUserId: identifierSchema(), resourceType: { enum: ["creation", "canvas", "private_template", "digital_human", "upload"] }, resourceId: identifierSchema(), reason: { type: "string", minLength: 1, maxLength: 2000 } }) },
  { toolKey: "billing.pay", name: "购买会员", description: "Create an Alipay membership subscription order. Always requires explicit user approval.", operationClass: "payment", inputSchema: strictObjectSchema(["planKey"], { planKey: identifierSchema(120), contactEmail: { type: "string", maxLength: 320 } }) },
  { toolKey: "billing.refund", name: "会员订单退款", description: "Root-only membership subscription refund. Always requires explicit approval.", operationClass: "refund", requiredRoles: ["root"], inputSchema: strictObjectSchema(["orderNo"], { orderNo: identifierSchema(120), reason: { type: "string", maxLength: 500 } }) },
  { toolKey: "root.point-package.refund", name: "长期积分包退款", description: "Root-only refund of the unconsumed points attributable to one long-term point-package order. Always requires explicit approval.", operationClass: "refund", requiredRoles: ["root"], resourceScope: "platform", inputSchema: strictObjectSchema(["orderNo"], { orderNo: identifierSchema(120), reason: { type: "string", maxLength: 500 } }) },
]);
