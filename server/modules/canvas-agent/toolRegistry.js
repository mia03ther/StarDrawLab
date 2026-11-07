import { randomUUID } from "node:crypto";

import sql from "../../configs/db.js";
import { normalizeCanvasState } from "../../domain/canvas/canvasState.js";
import { getObjectStorage } from "../../services/objectStorageComposition.js";
import { getGenerationApplication } from "../../services/generationApplicationService.js";
import { listAvailableModels } from "../../services/modelConfigurationService.js";
import { needsVideoReconciliation, syncVideoCreationStatus } from "../../services/videoStatusService.js";
import { getWorkflowRuntime } from "../../services/workflowRuntimeComposition.js";
import { workflowContainsMcpCall } from "../../services/workflowCostService.js";
import {
  createCanvasWorkflow,
  getCanvasWorkflow,
  listCanvasWorkflows,
  runCanvasWorkflowDefinition,
  updateCanvasWorkflow,
} from "../canvas-workflows/definitionService.js";
import { listCanvasWorkflowNodeCatalog } from "../canvas-workflows/workflowCatalog.js";
import { resolveWorkflowNodeConfig } from "../canvas-workflows/nodeConfig.js";
import { getCanvasModelPreferences, saveCanvasModelPreferences } from "./modelPreferencesService.js";
import { getCanvasAgentConversation, saveCanvasAgentConversation } from "./conversationService.js";
import { appendCanvasRevision } from "../../services/canvasRevisionService.js";
import {
  normalizeWorkflowPatchOperationName,
  repairAgentWorkflowEdgeReferences,
} from "../../domain/workflow/workflowAgentDefinition.js";

const OPERATION_CLASSES = new Set(["read", "reversible", "creative", "external", "destructive"]);
const MAX_TOOL_RESULT_BYTES = 320 * 1024;

const fail = (message, code = "CANVAS_AGENT_TOOL_FAILED", status = 400, extra = {}) => {
  throw Object.assign(new Error(message), { code, status, ...extra });
};

const clean = (value, max = 160) => String(value || "").trim().slice(0, max);
const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => Array.isArray(value) ? value : [];
const schema = (required = [], properties = {}) => ({ type: "object", additionalProperties: false, required, properties });
const string = (description, extra = {}) => ({ type: "string", description, ...extra });

export const tokenizeCanvasAgentTemplateSearch = (value) => [...new Set(
  clean(value, 160)
    .toLowerCase()
    .split(/[\s,，。.!！?？、;；:：/|]+/u)
    .map((term) => clean(term, 48))
    .filter(Boolean),
)].slice(0, 12);

const TOOL_DEFINITIONS = Object.freeze([
  { toolKey: "canvas.read", name: "读取当前画布", description: "读取当前画布、普通素材以及命名工作流摘要。", operationClass: "read", inputSchema: schema([], {}) },
  { toolKey: "canvas.patch", name: "修改当前画布", description: "按顺序添加便签、更新元素、移动元素或移除元素。所有修改都会进入画布历史。", operationClass: "reversible", inputSchema: schema(["operations"], { operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } }) },
  { toolKey: "model.list", name: "查询画布模型", description: "列出当前账号可用的文本、图片和视频模型，以及本对话选择。", operationClass: "read", inputSchema: schema([], {}) },
  { toolKey: "conversation.models.set", name: "设置本对话模型", description: "根据用户明确指令修改本画布对话的文本、图片或视频默认模型，并记住到账号。", operationClass: "reversible", inputSchema: schema([], { textModel: string("文本模型键"), imageModel: string("图片模型键"), videoModel: string("视频模型键") }) },
  { toolKey: "template.search", name: "搜索模板市场", description: "按关键词、标签、分类、模型和图片/视频类型模糊匹配当前用户可用模板。", operationClass: "read", inputSchema: schema([], { query: string("搜索关键词"), outputType: { enum: ["image", "video"] }, tag: string("标签"), category: string("分类"), model: string("模型键"), limit: { type: "integer", minimum: 1, maximum: 40 } }) },
  { toolKey: "template.read", name: "读取模板", description: "读取当前用户有权使用的公开或私有模板完整结构。", operationClass: "read", inputSchema: schema(["templateId"], { templateId: string("模板 ID") }) },
  { toolKey: "workflow.catalog", name: "查询工作流节点目录", description: "创建或修改工作流前必须调用。返回节点类型、字段、输出、条件、循环、变量和费用规则。", operationClass: "read", inputSchema: schema([], {}) },
  { toolKey: "workflow.list", name: "列出画布工作流", description: "列出当前画布所有命名工作流、版本和运行锁。", operationClass: "read", inputSchema: schema([], {}) },
  { toolKey: "workflow.read", name: "读取工作流", description: "读取指定工作流的当前版本和完整节点图。", operationClass: "read", inputSchema: schema(["workflowId"], { workflowId: string("工作流 ID") }) },
  { toolKey: "workflow.create", name: "创建工作流", description: "创建命名、版本化的真实工作流。节点实例必须使用 nodes[].config 保存 configSchema 对应的值；只创建，不会自动运行。", operationClass: "reversible", inputSchema: schema(["name", "definition"], { name: string("工作流名称"), definition: { type: "object", description: "DAG 定义；节点值写入 nodes[].config，不要写入 nodes[].fields" } }) },
  { toolKey: "workflow.patch", name: "增量修改工作流", description: "按顺序应用操作。每项优先使用 type 字段（兼容 op/action/operation），值为 add_node、update_node、remove_node、connect、disconnect、set_variables、rename 或 clear。运行锁定时禁止修改。", operationClass: "reversible", inputSchema: schema(["workflowId", "expectedVersion", "operations"], { workflowId: string("工作流 ID"), expectedVersion: { type: "integer", minimum: 1 }, operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } }) },
  { toolKey: "workflow.run", name: "运行工作流", description: "仅当用户明确要求运行或执行时，启动指定工作流的固定版本快照。先读取定义，并为所有必填变量提供 variables；inputs 可提供额外的运行输入。", operationClass: "creative", inputSchema: schema(["workflowId"], { workflowId: string("工作流 ID"), variables: { type: "object", description: "按工作流变量声明传入的本次运行值" }, inputs: { type: "object", description: "可通过 inputs.* 引用的额外运行输入" } }) },
  { toolKey: "workflow.get", name: "查看工作流运行", description: "查询真实工作流运行和每个节点的状态、结果及错误。", operationClass: "read", inputSchema: schema(["runId"], { runId: string("运行 ID") }) },
  { toolKey: "workflow.retry", name: "重试中断节点", description: "使用原输入幂等重试失败或余额中断节点，下游继续等待。", operationClass: "creative", inputSchema: schema(["runId", "nodeKey"], { runId: string("运行 ID"), nodeKey: string("节点键") }) },
  { toolKey: "media.generate.image", name: "生成图片", description: "提交一次图片生成并把成功结果加入当前画布。可用 referenceElementIds 引用当前画布中已验证的图片；不得在已有媒体任务未结束时重复提交。", operationClass: "creative", inputSchema: schema(["prompt"], { prompt: string("图片提示词"), sceneKey: string("模板场景键"), model: string("图片模型"), size: string("尺寸"), referenceCreationIds: { type: "array", maxItems: 4, items: { type: "string" } }, referenceElementIds: { type: "array", maxItems: 4, items: { type: "string" } } }) },
  { toolKey: "media.generate.video", name: "生成视频", description: "提交一次视频生成；可用 referenceElementIds 引用当前画布中已验证的图片。提交后必须使用 creation.get 等待原任务终态，不得重新提交。", operationClass: "creative", inputSchema: schema(["prompt"], { prompt: string("视频提示词"), sceneKey: string("模板场景键"), model: string("视频模型"), size: string("尺寸"), seconds: { type: "integer", minimum: 1, maximum: 60 }, referenceCreationIds: { type: "array", maxItems: 4, items: { type: "string" } }, referenceElementIds: { type: "array", maxItems: 4, items: { type: "string" } } }) },
  { toolKey: "creation.get", name: "查看生成任务", description: "查询当前用户自己的图片或视频任务；视频需要持续观察到 completed、failed 或 cancelled。", operationClass: "read", inputSchema: schema(["creationId"], { creationId: string("生成任务 ID") }) },
]);

const definitionMap = new Map(TOOL_DEFINITIONS.map((definition) => [definition.toolKey, definition]));

const validateParameters = (definition, parameters) => {
  const value = object(parameters);
  for (const field of definition.inputSchema.required || []) {
    if (value[field] == null || value[field] === "") fail(`Canvas Agent tool parameter is required: ${field}`, "CANVAS_AGENT_TOOL_PARAMETERS_INVALID");
  }
  return value;
};

export const bindCanvasAgentTemplateParameters = ({ toolKey, parameters, template } = {}) => {
  const normalizedTool = clean(toolKey, 128).toLowerCase();
  if (!["media.generate.image", "media.generate.video"].includes(normalizedTool) || !template) return object(parameters);
  const expectedOutputType = normalizedTool.endsWith("video") ? "video" : "image";
  if (template.output_type !== expectedOutputType) {
    fail("The attached template does not match the requested generation type", "TEMPLATE_OUTPUT_TYPE_MISMATCH", 422);
  }
  return { ...object(parameters), sceneKey: template.scene_key };
};

const assertCanvas = async ({ userId, canvasId, db = sql, forUpdate = false }) => {
  const rows = forUpdate
    ? await db`SELECT id, title, canvas_state, updated_at FROM canvases WHERE id = ${canvasId} AND user_id = ${userId} FOR UPDATE`
    : await db`SELECT id, title, canvas_state, updated_at FROM canvases WHERE id = ${canvasId} AND user_id = ${userId} LIMIT 1`;
  if (!rows[0]) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  return rows[0];
};

export const searchCanvasAgentTemplates = async ({ userId, parameters, db = sql }) => {
  const query = clean(parameters.query, 160).toLowerCase();
  const searchTerms = tokenizeCanvasAgentTemplateSearch(query);
  const searchTermArray = db.array(searchTerms, 25);
  const outputType = ["image", "video"].includes(parameters.outputType) ? parameters.outputType : null;
  const tag = clean(parameters.tag, 120);
  const category = clean(parameters.category, 120);
  const model = clean(parameters.model, 100).toLowerCase();
  const limit = Math.min(40, Math.max(1, Number(parameters.limit || 18) || 18));
  const searchDocument = db`LOWER(
    COALESCE(scene_key, '') || ' ' || COALESCE(scene_name, '') || ' ' ||
    COALESCE(preview_title, '') || ' ' || COALESCE(preview_description, '') || ' ' ||
    COALESCE(starter_prompt, '') || ' ' || COALESCE(source_key, '') || ' ' ||
    COALESCE(catalog_metadata->>'category', '')
  )`;
  return db`
    SELECT id, scene_key, scene_name, output_type, default_model, default_seconds,
           default_size, preview_title, preview_description, preview_image_url,
           preview_video_url, starter_prompt, placeholder_text, requires_reference,
           tags, required_membership_tier, version, source_key, catalog_metadata,
           CASE WHEN ${query} = '' THEN 1 ELSE GREATEST(
             similarity(${searchDocument}, ${query}),
             COALESCE((
               SELECT MAX(
                 CASE WHEN POSITION(search_term IN ${searchDocument}) > 0
                   THEN 1
                   ELSE similarity(${searchDocument}, search_term)
                 END
               )
               FROM unnest(${searchTermArray}::text[]) AS search_terms(search_term)
             ), 0)
           ) END AS relevance
    FROM prompt_templates
    WHERE is_active = TRUE
      AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
      AND (${outputType}::text IS NULL OR output_type = ${outputType})
      AND (${model} = '' OR default_model = ${model})
      AND (${tag} = '' OR tags @> jsonb_build_array(${tag}::text))
      AND (${category} = ''
        OR LOWER(COALESCE(catalog_metadata->>'category', '')) = LOWER(${category})
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) category_tag
          WHERE LOWER(category_tag) = LOWER(${category})
        )
      )
      AND (
        ${query} = ''
        OR ${searchDocument} % ${query}
        OR POSITION(${query} IN ${searchDocument}) > 0
        OR EXISTS (
          SELECT 1
          FROM unnest(${searchTermArray}::text[]) AS search_terms(search_term)
          WHERE ${searchDocument} % search_term
             OR POSITION(search_term IN ${searchDocument}) > 0
        )
      )
    ORDER BY relevance DESC, is_featured DESC, featured_order ASC, display_order ASC
    LIMIT ${limit}
  `;
};

const readTemplate = async ({ userId, templateId, db = sql }) => {
  const [row] = await db`
    SELECT * FROM prompt_templates
    WHERE id::text = ${clean(templateId, 80)} AND is_active = TRUE
      AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
    LIMIT 1
  `;
  if (!row) fail("Template not found", "TEMPLATE_NOT_FOUND", 404);
  return row;
};

export const loadCanvasAgentReferenceImages = async ({ userId, canvasId, creationIds, elementIds, db = sql, storage = getObjectStorage() }) => {
  const selectors = [...new Set(array(creationIds).map((id) => clean(id, 80)).filter(Boolean))]
    .map((id) => ({ kind: "creation", id }));
  const requestedElementIds = [...new Set(array(elementIds).map((id) => clean(id, 80)).filter(Boolean))].slice(0, 4);
  if (requestedElementIds.length) {
    const canvas = await assertCanvas({ userId, canvasId, db });
    const state = normalizeCanvasState(canvas.canvas_state || {});
    const byId = new Map(state.elements.map((element) => [element.id, element]));
    for (const elementId of requestedElementIds) {
      const element = byId.get(elementId);
      if (!element || element.type !== "image") fail("One or more canvas reference images are unavailable", "REFERENCE_IMAGE_UNAVAILABLE", 404);
      const creationId = clean(element.creationId, 80);
      const resourceId = clean(element.resourceId || element.resource_id, 80);
      const objectKey = clean(element.objectKey, 255);
      if (creationId && !resourceId && !objectKey) {
        selectors.push({ kind: "creation", id: creationId });
      } else if (creationId || resourceId || objectKey) {
        // Keep the identities together so a stale creation record can fall back
        // to the upload record belonging to this same canvas element without
        // accidentally sending multiple copies of one reference image.
        selectors.push({ kind: "canvas_element", creationId, resourceId, objectKey });
      } else fail("Canvas reference image has no trusted storage identity", "REFERENCE_IMAGE_UNTRUSTED", 422);
    }
  }
  const uniqueSelectors = uniqueReferenceSelectors(selectors).slice(0, 4);
  if (!uniqueSelectors.length) return [];
  const requestedCreationIds = [...new Set(uniqueSelectors.flatMap((item) => [
    item.kind === "creation" ? item.id : item.creationId,
  ]).filter(Boolean))];
  const requestedResourceIds = [...new Set(uniqueSelectors.map((item) => item.resourceId).filter(Boolean))];
  const requestedObjectKeys = [...new Set(uniqueSelectors.flatMap((item) => [
    item.kind === "upload" ? item.id : item.objectKey,
  ]).filter(Boolean))];
  const [creationRows, uploadRows] = await Promise.all([
    requestedCreationIds.length || requestedObjectKeys.length ? db`
      SELECT id, content_object_key
      FROM creations
      WHERE user_id = ${userId}
        AND type = 'image'
        AND status = 'completed' AND content_object_key IS NOT NULL
        AND (id::text = ANY(${requestedCreationIds}) OR content_object_key = ANY(${requestedObjectKeys}))
        AND NOT EXISTS (
          SELECT 1
          FROM content_recycle_entries recycle
          WHERE recycle.resource_type = 'creation'
            AND recycle.resource_id = creations.id::text
            AND recycle.status = 'active'
        )
    ` : [],
    requestedResourceIds.length || requestedObjectKeys.length ? db`
      SELECT id, object_key
      FROM user_content_uploads
      WHERE user_id = ${userId}
        AND media_type = 'image' AND object_key IS NOT NULL
        AND (id::text = ANY(${requestedResourceIds}) OR object_key = ANY(${requestedObjectKeys}))
        AND NOT EXISTS (
          SELECT 1
          FROM content_recycle_entries recycle
          WHERE recycle.resource_type = 'upload'
            AND recycle.resource_id = user_content_uploads.id::text
            AND recycle.status = 'active'
        )
    ` : [],
  ]);
  const creationKeys = new Map(creationRows.map((row) => [String(row.id), row.content_object_key]));
  const creationObjectKeys = new Map(creationRows.map((row) => [String(row.content_object_key), row.content_object_key]));
  const uploadKeysById = new Map(uploadRows.map((row) => [String(row.id), row.object_key]));
  const uploadKeysByObjectKey = new Map(uploadRows.map((row) => [String(row.object_key), row.object_key]));
  return Promise.all(uniqueSelectors.map(async (selector) => {
    const objectKey = selector.kind === "creation"
      ? creationKeys.get(selector.id)
      : creationKeys.get(selector.creationId)
        || uploadKeysById.get(selector.resourceId)
        || uploadKeysByObjectKey.get(selector.objectKey)
        || creationObjectKeys.get(selector.objectKey);
    if (!objectKey) fail("One or more reference images are unavailable", "REFERENCE_IMAGE_UNAVAILABLE", 404);
    const downloaded = await storage.downloadBuffer(objectKey);
    return { buffer: downloaded.buffer, mimetype: downloaded.contentType || "image/jpeg" };
  }));
};

const uniqueReferenceSelectors = (selectors) => {
  const rows = [];
  const seen = new Set();
  for (const selector of selectors) {
    const key = selector.kind === "canvas_element"
      ? `${selector.kind}:${selector.creationId}:${selector.resourceId}:${selector.objectKey}`
      : `${selector.kind}:${selector.id}`;
    if (selector.kind === "canvas_element"
      ? !(selector.creationId || selector.resourceId || selector.objectKey)
      : !selector.id || seen.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(selector);
  }
  return rows;
};

const appendCreationToCanvas = async ({ userId, canvasId, creationId, db = sql }) => db.begin(async (tx) => {
  const canvas = await assertCanvas({ userId, canvasId, db: tx, forUpdate: true });
  const [creation] = await tx`
    SELECT id, type, status, scene_name, content, thumbnail_url, content_object_key,
           prompt, request_idempotency_key
    FROM creations WHERE id = ${creationId} AND user_id = ${userId} LIMIT 1
  `;
  if (!creation || creation.status !== "completed" || !creation.content) return { inserted: false };
  const state = normalizeCanvasState(canvas.canvas_state || {});
  const existing = state.elements.find((item) => String(item.creationId || "") === String(creationId));
  if (existing) return { inserted: false, elementId: existing.id };
  const isVideo = creation.type === "video";
  const index = state.elements.length;
  const elementId = `agent_media_${String(creationId)}`.slice(0, 80);
  const [origin] = creation.request_idempotency_key ? await tx`
    SELECT step.run_id, step.parameters
    FROM canvas_agent_steps step
    JOIN canvas_agent_runs run ON run.id = step.run_id
    WHERE step.execution_idempotency_key = ${creation.request_idempotency_key}
      AND run.user_id = ${userId} AND run.canvas_id = ${canvasId}
    ORDER BY step.position ASC
    LIMIT 1
  ` : [];
  const anchorElementId = clean(array(origin?.parameters?.referenceElementIds)[0], 80);
  const anchor = anchorElementId
    ? state.elements.find((element) => String(element.id) === anchorElementId)
    : null;
  const width = isVideo ? 380 : 320;
  const height = isVideo ? 214 : 320;
  let x = 160 + (index % 4) * 360;
  let y = 160 + Math.floor(index / 4) * 360;
  if (anchor) {
    x = Number(anchor.x || 0) + (Number(anchor.width || 320) - width) / 2;
    y = Number(anchor.y || 0) + Number(anchor.height || 320) + 40;
    const anchoredResults = state.elements
      .filter((element) => String(element.canvasAnchorElementId || "") === anchorElementId)
      .sort((first, second) => Number(first.y || 0) - Number(second.y || 0));
    for (const result of anchoredResults) {
      y = Math.max(y, Number(result.y || 0) + Number(result.height || height) + 24);
    }
  }
  state.elements.push({
    id: elementId,
    type: isVideo ? "video" : "image",
    x,
    y,
    width,
    height,
    title: creation.scene_name || (isVideo ? "Agent video" : "Agent image"),
    creationId: String(creation.id),
    src: creation.content,
    poster: creation.thumbnail_url || "",
    objectKey: creation.content_object_key || "",
    source: "canvas_agent_generation",
    canvasAnchorElementId: anchorElementId,
    canvasAgentRunId: clean(origin?.run_id, 80),
    prompt: creation.prompt || "",
  });
  await tx`
    UPDATE canvases SET canvas_state = ${tx.json(normalizeCanvasState(state))}, updated_at = NOW()
    WHERE id = ${canvasId} AND user_id = ${userId}
  `;
  const revision = await appendCanvasRevision({
    db: tx,
    userId,
    canvasId,
    title: canvas.title,
    canvasState: state,
    reason: "canvas.agent.media_inserted",
  });
  return { inserted: true, elementId, revision };
});

const patchCanvas = async ({ userId, canvasId, operations, db = sql }) => db.begin(async (tx) => {
  const canvas = await assertCanvas({ userId, canvasId, db: tx, forUpdate: true });
  const state = normalizeCanvasState(canvas.canvas_state || {});
  const byId = new Map(state.elements.map((element) => [element.id, element]));
  for (const operation of array(operations).slice(0, 100)) {
    const type = clean(operation?.type, 80).toLowerCase();
    if (type === "add_note") {
      const id = clean(operation.id, 80) || `note_${randomUUID().replaceAll("-", "")}`;
      if (byId.has(id)) continue;
      const note = {
        id,
        type: "text",
        x: Number(operation.x || 160),
        y: Number(operation.y || 160),
        width: Math.max(160, Number(operation.width || 320)),
        height: Math.max(100, Number(operation.height || 220)),
        title: clean(operation.title, 120) || "Note",
        text: String(operation.text || "").slice(0, 12_000),
      };
      state.elements.push(note);
      byId.set(id, note);
      continue;
    }
    const id = clean(operation.id || operation.elementId, 80);
    const element = byId.get(id);
    if (!element) fail(`Canvas element not found: ${id}`, "CANVAS_ELEMENT_NOT_FOUND", 404);
    if (type === "remove_element") {
      state.elements = state.elements.filter((item) => item.id !== id);
      byId.delete(id);
    } else if (type === "move_element") {
      element.x = Number.isFinite(Number(operation.x)) ? Number(operation.x) : element.x;
      element.y = Number.isFinite(Number(operation.y)) ? Number(operation.y) : element.y;
    } else if (type === "update_element") {
      const allowed = ["title", "text", "prompt", "x", "y", "width", "height", "rotation"];
      for (const field of allowed) if (operation.patch?.[field] != null) element[field] = operation.patch[field];
    } else {
      fail(`Unsupported canvas patch operation: ${type}`, "CANVAS_PATCH_OPERATION_UNSUPPORTED");
    }
  }
  const normalized = normalizeCanvasState(state);
  await tx`UPDATE canvases SET canvas_state = ${tx.json(normalized)}, updated_at = NOW() WHERE id = ${canvasId} AND user_id = ${userId}`;
  const revision = await appendCanvasRevision({
    db: tx,
    userId,
    canvasId,
    title: canvas.title,
    canvasState: normalized,
    reason: "canvas.agent.patch",
  });
  return { canvasId, state: normalized, updatedAt: new Date().toISOString(), revision };
});

export const patchWorkflow = (workflow, operations) => {
  const definition = JSON.parse(JSON.stringify(workflow.definition || { nodes: [], edges: [], variables: {} }));
  let name = workflow.name;
  for (const operation of array(operations).slice(0, 100)) {
    const type = normalizeWorkflowPatchOperationName(operation);
    if (type === "clear") {
      definition.nodes = [];
      definition.edges = [];
      definition.variables = {};
    } else if (type === "add_node") {
      definition.nodes.push(object(operation.node));
    } else if (type === "update_node") {
      const index = definition.nodes.findIndex((node) => (node.id || node.nodeKey) === operation.nodeId);
      if (index < 0) fail(`Workflow node not found: ${operation.nodeId}`, "WORKFLOW_NODE_NOT_FOUND", 404);
      const patch = object(operation.patch);
      definition.nodes[index] = {
        ...definition.nodes[index],
        ...patch,
        config: {
          ...resolveWorkflowNodeConfig(definition.nodes[index]),
          ...resolveWorkflowNodeConfig(patch),
        },
      };
    } else if (type === "remove_node") {
      definition.nodes = definition.nodes.filter((node) => (node.id || node.nodeKey) !== operation.nodeId);
      definition.edges = array(definition.edges).filter((edge) => ![edge.from || edge.source, edge.to || edge.target].includes(operation.nodeId));
    } else if (type === "connect") {
      definition.edges = [...array(definition.edges), { id: operation.id, from: operation.from, to: operation.to, branch: operation.branch || null }];
    } else if (type === "disconnect") {
      definition.edges = array(definition.edges).filter((edge) => operation.id ? edge.id !== operation.id : !((edge.from || edge.source) === operation.from && (edge.to || edge.target) === operation.to));
    } else if (type === "set_variables") {
      definition.variables = object(operation.variables);
    } else if (type === "rename") {
      name = clean(operation.name) || name;
    } else {
      fail(`Unsupported workflow patch operation: ${type || "<empty>"}`, "WORKFLOW_PATCH_OPERATION_UNSUPPORTED");
    }
  }
  return { name, definition };
};

const DEFAULT_WORKFLOW_TEMPLATES = Object.freeze([
  { sceneKey: "freeform_image", outputType: "image", fallback: true },
  { sceneKey: "freeform_video", outputType: "video", fallback: true },
]);

const normalizeTrustedWorkflowTemplate = (value) => {
  const sceneKey = clean(value?.sceneKey || value?.scene_key, 120);
  const outputType = clean(value?.outputType || value?.output_type, 20).toLowerCase();
  if (!sceneKey || !["image", "video"].includes(outputType)) return null;
  return {
    id: clean(value?.id || value?.templateId || value?.template_id, 80) || null,
    sceneKey,
    outputType,
    fallback: Boolean(value?.fallback),
  };
};

export const bindCanvasAgentWorkflowTemplates = ({ definition, trustedTemplates = [] } = {}) => {
  const trusted = [...DEFAULT_WORKFLOW_TEMPLATES, ...array(trustedTemplates)]
    .map(normalizeTrustedWorkflowTemplate)
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const template of trusted) {
    const key = `${template.outputType}:${template.id || ""}:${template.sceneKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(template);
  }
  const byId = new Map(unique.filter((template) => template.id).map((template) => [template.id, template]));
  const bySceneKey = new Map(unique.map((template) => [template.sceneKey, template]));

  const bindDefinition = (source) => ({
    ...object(source),
    nodes: array(source?.nodes).map((node) => {
      const type = clean(node?.type || node?.nodeType || node?.node_type, 80).toLowerCase();
      const config = resolveWorkflowNodeConfig(node);
      if (["loop.foreach", "loop.repeat_until"].includes(type) && config.body) {
        config.body = bindDefinition(config.body);
      }
      const outputType = type === "image.generate"
        ? "image"
        : type === "video.generate" ? "video" : null;
      if (outputType) {
        const requestedId = clean(config.templateId || config.template_id, 80);
        const requestedSceneKey = clean(config.sceneKey || config.scene_key, 120);
        const requested = (requestedId && byId.get(requestedId))
          || (requestedSceneKey && bySceneKey.get(requestedSceneKey));
        const selected = requested?.outputType === outputType
          ? requested
          : unique.find((template) => template.outputType === outputType && !template.fallback)
            || unique.find((template) => template.outputType === outputType && template.fallback);
        if (selected) {
          config.sceneKey = selected.sceneKey;
          if (selected.id) config.templateId = selected.id;
        }
      }
      return { ...object(node), config };
    }),
  });

  return bindDefinition(definition);
};

const canvasAgentWorkflowCatalog = () => ({
  schemaVersion: 2,
  rules: {
    graph: "Top-level graph is acyclic. Use bounded loop nodes for iteration.",
    nodeShape: "Each node instance uses { id, type, title?, x?, y?, config }. configSchema describes allowed config properties. Never put instance values in fields.",
    templates: "Media nodes must use sceneKey/templateId returned by template.search or template.read. If no template matches, use fallbackTemplates.",
    conditions: "condition.rule and condition.ai emit true/false. Connect branch handles explicitly.",
    variables: ["${inputs.name}", "${variables.style}", "${nodes.node_id.output}", "${loop.item}"],
    mediaInputs: "Never ask users for canvas element IDs or creation IDs. Declare reference images as type=image variables, or input nodes with config.inputType=image and a friendly label; bind the media node referenceExpression to that variable/input.",
    billing: "Mandatory and parallel nodes are summed; mutually exclusive branches use the highest branch; loops use their maximum iteration count.",
    editing: "A workflow is locked while queued, running, or waiting for approval. Failed and insufficient-points runs unlock editing.",
    edges: "Every edge.from and edge.to must exactly match a nodes[].id. Template IDs and scene keys belong in media node config.templateId/config.sceneKey, never in an edge endpoint.",
    patchOperations: "Each operations item uses { type, ...payload }; op, action, and operation are accepted as compatibility aliases. Supported types: add_node, update_node, remove_node, connect, disconnect, set_variables, rename, clear.",
  },
  fallbackTemplates: {
    image: { sceneKey: "freeform_image", outputType: "image", fallback: true },
    video: { sceneKey: "freeform_video", outputType: "video", fallback: true },
  },
  nodes: listCanvasWorkflowNodeCatalog().map(({ fields, ...node }) => ({
    ...node,
    configSchema: fields,
  })),
});

const creationGet = async ({ userId, canvasId, creationId, db = sql }) => {
  const [existing] = await db`SELECT * FROM creations WHERE id = ${creationId} AND user_id = ${userId} LIMIT 1`;
  if (!existing) fail("Creation not found", "CREATION_NOT_FOUND", 404);
  let creation = existing;
  if (existing.type === "video" && needsVideoReconciliation(existing)) {
    const synchronized = await syncVideoCreationStatus(existing);
    if (synchronized?.success && synchronized.creation) creation = synchronized.creation;
  }
  const status = String(creation.status || "pending").toLowerCase();
  const terminalStatus = ["completed", "failed", "cancelled"].includes(status);
  const canvasResult = status === "completed"
    ? await appendCreationToCanvas({ userId, canvasId, creationId: creation.id, db })
    : null;
  return {
    creationId: String(creation.id),
    type: creation.type,
    status,
    terminal: terminalStatus,
    content: status === "completed" ? creation.content : null,
    thumbnailUrl: status === "completed" ? creation.thumbnail_url : null,
    error: status === "failed" ? creation.error_message : null,
    canvas: canvasResult,
  };
};

const HANDLERS = new Map([
  ["canvas.read", async ({ userId, canvasId }) => {
    const canvas = await assertCanvas({ userId, canvasId });
    return { id: canvas.id, title: canvas.title, state: normalizeCanvasState(canvas.canvas_state || {}), updatedAt: canvas.updated_at, workflows: await listCanvasWorkflows({ userId, canvasId }) };
  }],
  ["canvas.patch", ({ userId, canvasId, parameters }) => patchCanvas({ userId, canvasId, operations: parameters.operations })],
  ["model.list", async ({ userId, conversation }) => ({ ...(await getCanvasModelPreferences({ userId })), conversation: conversation.model_preferences })],
  ["conversation.models.set", async ({ userId, conversation, parameters }) => {
    const account = await saveCanvasModelPreferences({ userId, patch: parameters });
    const saved = await saveCanvasAgentConversation({
      userId,
      conversationId: conversation.id,
      title: conversation.title,
      messages: conversation.messages,
      runtimeState: conversation.runtime_state,
      modelPreferences: account.preferences,
      rememberModels: false,
    });
    return { preferences: saved.model_preferences };
  }],
  ["template.search", ({ userId, parameters }) => searchCanvasAgentTemplates({ userId, parameters })],
  ["template.read", ({ userId, parameters }) => readTemplate({ userId, templateId: parameters.templateId })],
  ["workflow.catalog", async () => canvasAgentWorkflowCatalog()],
  ["workflow.list", ({ userId, canvasId }) => listCanvasWorkflows({ userId, canvasId })],
  ["workflow.read", ({ userId, parameters }) => getCanvasWorkflow({ userId, workflowId: parameters.workflowId })],
  ["workflow.create", ({ userId, canvasId, parameters, executionContext }) => createCanvasWorkflow({
    userId,
    canvasId,
    name: parameters.name,
    definition: repairAgentWorkflowEdgeReferences(bindCanvasAgentWorkflowTemplates({
      definition: parameters.definition,
      trustedTemplates: executionContext?.trustedWorkflowTemplates,
    })),
  })],
  ["workflow.patch", async ({ userId, parameters, executionContext }) => {
    const current = await getCanvasWorkflow({ userId, workflowId: parameters.workflowId });
    const patched = patchWorkflow(current, parameters.operations);
    return updateCanvasWorkflow({
      userId,
      workflowId: current.id,
      name: patched.name,
      definition: repairAgentWorkflowEdgeReferences(bindCanvasAgentWorkflowTemplates({
        definition: patched.definition,
        trustedTemplates: executionContext?.trustedWorkflowTemplates,
      })),
      expectedVersion: parameters.expectedVersion,
    });
  }],
  ["workflow.run", ({ userId, parameters, idempotencyKey, executionContext }) => runCanvasWorkflowDefinition({
    userId,
    workflowId: parameters.workflowId,
    idempotencyKey,
    executionContext,
    variables: parameters.variables,
    inputs: parameters.inputs,
  })],
  ["workflow.get", ({ userId, parameters }) => getWorkflowRuntime().getRun({ userId, runId: parameters.runId })],
  ["workflow.retry", ({ userId, parameters }) => getWorkflowRuntime().retryNode({ userId, runId: parameters.runId, nodeKey: parameters.nodeKey })],
  ["media.generate.image", async ({ userId, canvasId, conversation, parameters, idempotencyKey }) => {
    const references = await loadCanvasAgentReferenceImages({ userId, canvasId, creationIds: parameters.referenceCreationIds, elementIds: parameters.referenceElementIds });
    const result = await getGenerationApplication().generateImage({
      userId,
      idempotencyKey,
      sceneKey: parameters.sceneKey || "freeform_image",
      userPrompt: parameters.prompt,
      model: parameters.model || conversation.model_preferences?.imageModel,
      size: parameters.size,
      referenceImages: references,
    });
    if (result?.creationId) await appendCreationToCanvas({ userId, canvasId, creationId: result.creationId });
    return result;
  }],
  ["media.generate.video", async ({ userId, canvasId, conversation, parameters, idempotencyKey }) => {
    const references = await loadCanvasAgentReferenceImages({ userId, canvasId, creationIds: parameters.referenceCreationIds, elementIds: parameters.referenceElementIds });
    return getGenerationApplication().generateVideo({
      userId,
      idempotencyKey,
      sceneKey: parameters.sceneKey || "freeform_video",
      userPrompt: parameters.prompt,
      model: parameters.model || conversation.model_preferences?.videoModel,
      seconds: parameters.seconds,
      size: parameters.size,
      referenceImages: references,
    });
  }],
  ["creation.get", ({ userId, canvasId, parameters }) => creationGet({ userId, canvasId, creationId: parameters.creationId })],
]);

export class CanvasAgentToolRegistry {
  constructor({ workflowReader = getCanvasWorkflow } = {}) {
    this.workflowReader = workflowReader;
  }

  list() {
    return TOOL_DEFINITIONS.map((definition) => ({ ...definition }));
  }

  get(toolKey) {
    return definitionMap.get(String(toolKey || "").trim().toLowerCase()) || null;
  }

  async assess({ userId, toolKey, parameters, agentMode }) {
    const definition = this.get(toolKey);
    if (!definition) fail(`Canvas Agent tool is not registered: ${toolKey}`, "CANVAS_AGENT_TOOL_NOT_FOUND", 404);
    if (!OPERATION_CLASSES.has(definition.operationClass)) fail("Canvas Agent tool operation class is invalid", "CANVAS_AGENT_TOOL_INVALID");
    let operationClass = definition.operationClass;
    if (definition.toolKey === "workflow.run") {
      const workflowId = clean(parameters?.workflowId, 80);
      if (!workflowId) fail("Canvas Agent tool parameter is required: workflowId", "CANVAS_AGENT_TOOL_PARAMETERS_INVALID");
      const workflow = await this.workflowReader({ userId, workflowId });
      if (workflowContainsMcpCall(workflow.definition)) operationClass = "external";
    }
    const mode = ["ask_for_approval", "approve_for_me", "full_access"].includes(agentMode) ? agentMode : "approve_for_me";
    const requiresApproval = mode === "ask_for_approval"
      || (mode === "approve_for_me" && ["external", "destructive"].includes(operationClass));
    return { definition: { ...definition, operationClass }, requiresApproval };
  }

  async execute({ userId, canvasId, conversationId, toolKey, parameters, idempotencyKey, executionContext = null }) {
    const definition = this.get(toolKey);
    if (!definition) fail(`Canvas Agent tool is not registered: ${toolKey}`, "CANVAS_AGENT_TOOL_NOT_FOUND", 404);
    const handler = HANDLERS.get(definition.toolKey);
    if (!handler) fail(`Canvas Agent tool has no handler: ${definition.toolKey}`, "CANVAS_AGENT_TOOL_HANDLER_MISSING", 503);
    const conversation = await getCanvasAgentConversation({ userId, conversationId });
    if (conversation.canvas_id !== canvasId) fail("Canvas Agent conversation does not belong to this canvas", "CANVAS_AGENT_CONTEXT_MISMATCH", 403);
    let trustedParameters = parameters;
    if (["media.generate.image", "media.generate.video"].includes(definition.toolKey) && executionContext?.selectedTemplateId) {
      const template = await readTemplate({ userId, templateId: executionContext.selectedTemplateId });
      trustedParameters = bindCanvasAgentTemplateParameters({ toolKey: definition.toolKey, parameters, template });
    }
    const result = await handler({
      userId,
      canvasId,
      conversation,
      parameters: validateParameters(definition, trustedParameters),
      idempotencyKey,
      executionContext,
    });
    const serialized = JSON.stringify(result ?? null);
    if (Buffer.byteLength(serialized, "utf8") > MAX_TOOL_RESULT_BYTES) fail("Canvas Agent tool result is too large", "CANVAS_AGENT_TOOL_RESULT_TOO_LARGE", 413);
    return result;
  }
}

let registry;
export const getCanvasAgentToolRegistry = () => {
  if (!registry) registry = new CanvasAgentToolRegistry();
  return registry;
};

export const resetCanvasAgentToolRegistryForTests = () => { registry = null; };
