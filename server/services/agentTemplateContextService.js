import sql from "../configs/db.js";
import { isTemplateMembershipAllowed } from "../domain/templates/templateAccessPolicy.js";
import { listAvailableModels } from "./modelConfigurationService.js";

const MAX_AGENT_TEMPLATES = 48;
const AGENT_REASONING_EFFORTS = new Set(["low", "medium", "high"]);
const AGENT_ASPECT_RATIOS = new Set(["1:1", "9:16", "16:9", "21:9", "4:3", "3:4"]);

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const clean = (value, max = 240) => String(value || "").trim().slice(0, max);
const compactAttachedReferenceImages = (references) => (Array.isArray(references) ? references : [])
  .slice(0, 4)
  .map((reference) => ({
    type: "image",
    title: clean(reference?.title, 160) || "参考图",
    source: ["upload", "creation", "template", "attached"].includes(reference?.source)
      ? reference.source
      : "attached",
  }));
const tagsOf = (value) => Array.isArray(value)
  ? value.map((item) => clean(item, 80)).filter(Boolean)
  : [];

const tokenize = (value) => {
  const normalized = String(value || "").toLowerCase();
  const tokens = new Set(normalized.match(/[a-z0-9][a-z0-9._-]{1,48}|[\u3400-\u9fff]{2,16}/g) || []);
  for (const token of [...tokens]) {
    if (!/[\u3400-\u9fff]/.test(token) || token.length < 3) continue;
    for (let index = 0; index < token.length - 1; index += 1) tokens.add(token.slice(index, index + 2));
  }
  return [...tokens].slice(0, 64);
};

const templateMetadata = (row) => {
  const value = row?.catalog_metadata;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
};

const normalizeTemplate = (row) => {
  const metadata = templateMetadata(row);
  return {
    id: String(row.id),
    scene_key: row.scene_key,
    scene_name: row.scene_name,
    output_type: row.output_type,
    preview_title: row.preview_title || row.scene_name,
    preview_description: row.preview_description || "",
    starter_prompt: clean(row.starter_prompt, 1200),
    tags: tagsOf(row.tags).slice(0, 12),
    requires_reference: Boolean(row.requires_reference),
    is_featured: Boolean(row.is_featured),
    default_model: row.default_model,
    default_seconds: row.default_seconds == null ? null : Number(row.default_seconds),
    default_size: row.default_size,
    required_membership_tier: row.required_membership_tier || "free",
    version: Number(row.version || 1),
    visibility: row.visibility,
    source_key: row.source_key || null,
    source_type: clean(metadata.sourceType, 80) || null,
    category: clean(metadata.category, 120) || null,
  };
};

const scoreTemplate = (row, terms, requestedId, requestedSceneKey) => {
  if (requestedId && String(row.id) === requestedId) return 100_000;
  if (requestedSceneKey && row.scene_key === requestedSceneKey) return 100_000;
  const metadata = templateMetadata(row);
  const title = `${row.scene_name || ""} ${row.preview_title || ""}`.toLowerCase();
  const tags = tagsOf(row.tags).join(" ").toLowerCase();
  const details = `${row.preview_description || ""} ${row.starter_prompt || ""} ${metadata.category || ""} ${(metadata.styles || []).join?.(" ") || ""} ${(metadata.scenes || []).join?.(" ") || ""}`.toLowerCase();
  let score = row.is_featured ? 24 : 0;
  if (row.source_key === "awesome-gpt-image-2") score += 2;
  for (const term of terms) {
    if (title.includes(term)) score += 18;
    if (tags.includes(term)) score += 10;
    if (details.includes(term)) score += 4;
  }
  return score;
};

const requestedIdentifiers = (context = {}) => {
  const requested = [context?.template, context?.selectedTemplate]
    .find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
  return {
    templateId: clean(requested.id || requested.templateId || requested.template_id, 255),
    sceneKey: clean(requested.sceneKey || requested.scene_key, 255),
  };
};

const normalizeAutoValue = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return ["", "auto", "default"].includes(normalized) ? "" : String(value).trim();
};

const normalizeRequestedSize = (value, field) => {
  const normalized = normalizeAutoValue(value).replace(/[×*]/g, "x").replace(/\s+/g, "").toLowerCase();
  if (!normalized) return "";
  const match = normalized.match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match || Number(match[1]) < 256 || Number(match[2]) < 256 || Number(match[1]) > 8192 || Number(match[2]) > 8192) {
    throw fail(`${field} is invalid`, "INVALID_AGENT_PREFERENCE");
  }
  return `${Number(match[1])}x${Number(match[2])}`;
};

const normalizeRequestedSeconds = (value) => {
  const normalized = normalizeAutoValue(value);
  if (!normalized) return null;
  const seconds = Number(normalized);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 600) {
    throw fail("videoSeconds is invalid", "INVALID_AGENT_PREFERENCE");
  }
  return seconds;
};

const resolveAgentPreferences = async ({ userId, clientContext, db }) => {
  const raw = clientContext?.agentPreferences || clientContext?.agent_preferences;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {
    agentModel: "",
    imageModel: "",
    videoModel: "",
    imageSize: "",
    videoSize: "",
    videoSeconds: null,
    imageAspectRatio: "",
    videoAspectRatio: "",
    reasoningEffort: "",
  };

  const requested = {
    agentModel: normalizeAutoValue(raw.agentModel || raw.agent_model),
    imageModel: normalizeAutoValue(raw.imageModel || raw.image_model),
    videoModel: normalizeAutoValue(raw.videoModel || raw.video_model),
  };
  const catalogRequests = [
    ["agent", requested.agentModel],
    ["image", requested.imageModel],
    ["video", requested.videoModel],
  ];
  const catalogs = await Promise.all(catalogRequests.map(([outputType, modelKey]) => (
    modelKey ? listAvailableModels({ userId, outputType, db }) : Promise.resolve([])
  )));
  for (let index = 0; index < catalogRequests.length; index += 1) {
    const [outputType, modelKey] = catalogRequests[index];
    if (modelKey && !catalogs[index].some((model) => model.model_key === modelKey)) {
      throw fail(`Selected ${outputType} model is unavailable`, "MODEL_UNAVAILABLE", 400);
    }
  }

  const imageAspectRatio = normalizeAutoValue(raw.imageAspectRatio || raw.image_aspect_ratio);
  const videoAspectRatio = normalizeAutoValue(raw.videoAspectRatio || raw.video_aspect_ratio);
  if (imageAspectRatio && !AGENT_ASPECT_RATIOS.has(imageAspectRatio)) {
    throw fail("imageAspectRatio is invalid", "INVALID_AGENT_PREFERENCE");
  }
  if (videoAspectRatio && !AGENT_ASPECT_RATIOS.has(videoAspectRatio)) {
    throw fail("videoAspectRatio is invalid", "INVALID_AGENT_PREFERENCE");
  }
  const reasoningEffort = normalizeAutoValue(raw.reasoningEffort || raw.reasoning_effort).toLowerCase();
  if (reasoningEffort && !AGENT_REASONING_EFFORTS.has(reasoningEffort)) {
    throw fail("reasoningEffort is invalid", "INVALID_AGENT_PREFERENCE");
  }
  return {
    ...requested,
    imageSize: normalizeRequestedSize(raw.imageSize || raw.image_size, "imageSize"),
    videoSize: normalizeRequestedSize(raw.videoSize || raw.video_size, "videoSize"),
    videoSeconds: normalizeRequestedSeconds(raw.videoSeconds || raw.video_seconds),
    imageAspectRatio,
    videoAspectRatio,
    reasoningEffort,
  };
};

export const resolveTrustedGlobalAgentContext = async ({
  userId,
  membershipTier = "free",
  instruction,
  clientContext = {},
  db = sql,
} = {}) => {
  const ownerId = clean(userId, 255);
  if (!ownerId) throw fail("Authenticated user is required", "USER_REQUIRED", 401);
  const agentPreferences = await resolveAgentPreferences({ userId: ownerId, clientContext, db });
  const { templateId, sceneKey } = requestedIdentifiers(clientContext);
  const requestedCanvasId = clean(
    clientContext?.currentCanvasId || clientContext?.current_canvas_id || clientContext?.activeCanvasId,
    255,
  );
  const rows = await db`
    SELECT id, scene_key, scene_name, output_type, default_model, default_seconds,
           default_size, preview_title, preview_description, starter_prompt,
           tags, requires_reference, is_featured, required_membership_tier,
           owner_user_id, visibility, version, source_key, catalog_metadata,
           display_order, featured_order
    FROM prompt_templates
    WHERE is_active = TRUE
      AND (
        owner_user_id = ${ownerId}
        OR (visibility = 'public' AND approval_status = 'approved')
      )
    ORDER BY is_featured DESC, featured_order ASC, display_order ASC, id ASC
    LIMIT 1200
  `;
  const usable = rows.filter((row) => isTemplateMembershipAllowed({
    template: row,
    userId: ownerId,
    membershipTier,
  }));
  if ((templateId || sceneKey) && !usable.some((row) => (
    (templateId && String(row.id) === templateId) || (sceneKey && row.scene_key === sceneKey)
  ))) {
    throw fail("Requested template is unavailable to the current user", "TEMPLATE_NOT_FOUND", 404);
  }
  const terms = tokenize(instruction);
  const rankedRows = usable
    .map((row) => ({ row, score: scoreTemplate(row, terms, templateId, sceneKey) }))
    .sort((left, right) => right.score - left.score
      || Number(right.row.is_featured) - Number(left.row.is_featured)
      || Number(left.row.display_order || 0) - Number(right.row.display_order || 0))
    .map(({ row }) => row);
  const exactRow = usable.find((row) => (
    (templateId && String(row.id) === templateId) || (sceneKey && row.scene_key === sceneKey)
  )) || null;
  const freeformRows = usable.filter((row) => ["freeform_image", "freeform_video"].includes(row.scene_key));
  const requiredRows = [exactRow, ...freeformRows].filter(Boolean);
  const requiredKeys = new Set(requiredRows.map((row) => String(row.id)));
  const optionalRows = rankedRows
    .filter((row) => !requiredKeys.has(String(row.id)))
    .slice(0, Math.max(0, MAX_AGENT_TEMPLATES - requiredRows.length));
  const templates = [...requiredRows, ...optionalRows].map(normalizeTemplate);
  const exact = exactRow ? normalizeTemplate(exactRow) : null;
  let currentCanvas = null;
  if (requestedCanvasId && String(clientContext?.currentPath || "").startsWith("/ai/canvas")) {
    const [canvas] = await db`
      SELECT id, title, canvas_state, updated_at
      FROM canvases
      WHERE id = ${requestedCanvasId} AND user_id = ${ownerId}
      LIMIT 1
    `;
    if (canvas) {
      const workflowNodes = Array.isArray(canvas.canvas_state?.workflow?.nodes)
        ? canvas.canvas_state.workflow.nodes.length
        : 0;
      currentCanvas = {
        id: String(canvas.id),
        title: clean(canvas.title, 120),
        updatedAt: canvas.updated_at,
        workflowNodeCount: workflowNodes,
      };
    }
  }
  return {
    source: ["global_agent", "template_detail"].includes(clientContext?.source)
      ? clientContext.source
      : "global_agent",
    currentPath: clean(clientContext?.currentPath, 500),
    currentCanvas,
    attachedReferenceImages: compactAttachedReferenceImages(clientContext?.attachedReferenceImages),
    requestedTemplate: exact,
    agentPreferences,
    templates: {
      availableImages: templates.filter((template) => template.output_type === "image"),
      availableVideos: templates.filter((template) => template.output_type === "video"),
    },
    membershipTier,
  };
};

const findTemplate = async ({ userId, membershipTier, parameters, outputType, db }) => {
  const templateId = clean(parameters?.templateId || parameters?.template_id || parameters?.id, 255);
  const sceneKey = clean(parameters?.sceneKey || parameters?.scene_key, 255);
  if (!templateId && !sceneKey) throw fail("templateId or sceneKey is required", "TEMPLATE_IDENTIFIER_REQUIRED");
  const rows = templateId
    ? await db`
        SELECT * FROM prompt_templates
        WHERE id::text = ${templateId} AND is_active = TRUE
          AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
        LIMIT 1
      `
    : await db`
        SELECT * FROM prompt_templates
        WHERE scene_key = ${sceneKey} AND is_active = TRUE
          AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
        LIMIT 1
      `;
  const template = rows[0];
  if (!template) throw fail("Template not found", "TEMPLATE_NOT_FOUND", 404);
  if (!isTemplateMembershipAllowed({ template, userId, membershipTier })) {
    throw fail("Requested template is unavailable to the current membership tier", "TEMPLATE_MEMBERSHIP_REQUIRED", 403);
  }
  if (outputType && template.output_type !== outputType) {
    throw fail("Template output type does not match the generation tool", "TEMPLATE_OUTPUT_TYPE_MISMATCH", 409);
  }
  const expectedVersion = parameters?.templateVersion ?? parameters?.template_version;
  if (expectedVersion != null && Number(expectedVersion) !== Number(template.version || 1)) {
    throw fail("Template changed after the Agent plan was created", "TEMPLATE_VERSION_CHANGED", 409);
  }
  return template;
};

const composeTemplateUserPrompt = (template, parameters) => {
  const userText = clean(
    parameters?.userModification
    ?? parameters?.user_modification
    ?? parameters?.userPrompt
    ?? parameters?.user_prompt,
    6000,
  );
  const starter = clean(template.starter_prompt, 5200);
  if (!starter) return userText;
  if (!userText || userText === starter || userText.includes(starter.slice(0, Math.min(120, starter.length)))) {
    return userText || starter;
  }
  const suffix = userText.slice(0, 2200);
  const prefix = starter.slice(0, Math.max(1, 6000 - suffix.length - 54));
  return `${prefix}\n\nUser-requested changes and additions:\n${suffix}`;
};

export const resolveAgentGenerationInput = async ({
  userId,
  membershipTier = "free",
  parameters = {},
  outputType,
  db = sql,
} = {}) => {
  const template = await findTemplate({ userId, membershipTier, parameters, outputType, db });
  return {
    template,
    sceneKey: template.scene_key,
    userPrompt: composeTemplateUserPrompt(template, parameters),
    model: parameters?.model || template.default_model,
    seconds: parameters?.seconds ?? template.default_seconds,
    size: parameters?.size || template.default_size,
  };
};
