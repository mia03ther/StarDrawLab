export const TEMPLATE_DOCUMENT_KIND = "stardraw.prompt-template";
export const TEMPLATE_DOCUMENT_SCHEMA_VERSION = 1;
export const TEMPLATE_DOCUMENT_SCHEMA_ID = "https://stardraw.ai/schemas/prompt-template/v1.json";

const MAX_DOCUMENT_BYTES = 64 * 1024;
const OUTPUT_TYPES = new Set(["image", "video"]);
const MEMBERSHIP_TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);
const TOP_LEVEL_KEYS = new Set(["$schema", "schemaVersion", "kind", "templateVersion", "template"]);
const TEMPLATE_KEYS = new Set([
  "sceneKey", "sceneName", "outputType", "defaultModel", "defaultSeconds", "defaultSize",
  "systemPrompt", "previewTitle", "previewDescription", "starterPrompt", "placeholderText",
  "requiresReference", "tags", "requiredMembershipTier",
]);

const fail = (message, path = "$") => {
  throw Object.assign(new Error(`${message} at ${path}`), {
    status: 400,
    code: "INVALID_TEMPLATE_DOCUMENT",
  });
};

const stringValue = (value, path, max, { required = false } = {}) => {
  if (value == null) {
    if (required) fail("value is required", path);
    return "";
  }
  if (typeof value !== "string") fail("value must be a string", path);
  const normalized = value.trim();
  if (required && !normalized) fail("value is required", path);
  if (normalized.length > max) fail(`value exceeds ${max} characters`, path);
  return normalized;
};

const optionalSeconds = (value) => {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 180) {
    fail("value must be an integer between 1 and 180", "$.template.defaultSeconds");
  }
  return seconds;
};

const normalizeTags = (value) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) fail("tags must contain at most 20 strings", "$.template.tags");
  const tags = [...new Set(value.map((tag, index) => stringValue(tag, `$.template.tags[${index}]`, 40, { required: true })) )];
  return tags;
};

const assertKnownKeys = (object, allowed, path) => {
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) fail(`unknown property ${unknown}`, path);
};

const normalizeDocumentObject = (value) => {
  let document = value;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_DOCUMENT_BYTES) fail("document is too large");
    try { document = JSON.parse(value); } catch { fail("document must contain valid JSON"); }
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) fail("document must be an object");
  let serialized;
  try { serialized = JSON.stringify(document); } catch { fail("document must be JSON serializable"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_BYTES) fail("document is too large");
  return document;
};

export const normalizeTemplateDocument = (value) => {
  const document = normalizeDocumentObject(value);
  assertKnownKeys(document, TOP_LEVEL_KEYS, "$");
  if (document.$schema !== TEMPLATE_DOCUMENT_SCHEMA_ID) fail("unsupported $schema", "$.$schema");
  if (document.schemaVersion !== TEMPLATE_DOCUMENT_SCHEMA_VERSION) fail("unsupported schemaVersion", "$.schemaVersion");
  if (document.kind !== TEMPLATE_DOCUMENT_KIND) fail("unsupported document kind", "$.kind");
  if (!Number.isSafeInteger(document.templateVersion) || document.templateVersion < 1) {
    fail("templateVersion must be a positive integer", "$.templateVersion");
  }
  if (!document.template || typeof document.template !== "object" || Array.isArray(document.template)) {
    fail("template must be an object", "$.template");
  }
  assertKnownKeys(document.template, TEMPLATE_KEYS, "$.template");

  const outputType = stringValue(document.template.outputType, "$.template.outputType", 20, { required: true }).toLowerCase();
  if (!OUTPUT_TYPES.has(outputType)) fail("outputType must be image or video", "$.template.outputType");
  const sceneKey = stringValue(document.template.sceneKey, "$.template.sceneKey", 120, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(sceneKey)) fail("sceneKey contains unsupported characters", "$.template.sceneKey");
  const defaultSize = stringValue(document.template.defaultSize, "$.template.defaultSize", 40);
  if (defaultSize && !/^\d{2,5}x\d{2,5}$/.test(defaultSize)) fail("defaultSize must use WIDTHxHEIGHT", "$.template.defaultSize");
  const requiredMembershipTier = stringValue(
    document.template.requiredMembershipTier || "free",
    "$.template.requiredMembershipTier",
    20,
    { required: true },
  ).toLowerCase();
  if (!MEMBERSHIP_TIERS.has(requiredMembershipTier)) fail("requiredMembershipTier is invalid", "$.template.requiredMembershipTier");

  return {
    $schema: TEMPLATE_DOCUMENT_SCHEMA_ID,
    schemaVersion: TEMPLATE_DOCUMENT_SCHEMA_VERSION,
    kind: TEMPLATE_DOCUMENT_KIND,
    templateVersion: document.templateVersion,
    template: {
      sceneKey,
      sceneName: stringValue(document.template.sceneName, "$.template.sceneName", 120, { required: true }),
      outputType,
      defaultModel: stringValue(document.template.defaultModel, "$.template.defaultModel", 100, { required: true }).toLowerCase(),
      defaultSeconds: optionalSeconds(document.template.defaultSeconds),
      defaultSize,
      systemPrompt: stringValue(document.template.systemPrompt, "$.template.systemPrompt", 20_000, { required: true }),
      previewTitle: stringValue(document.template.previewTitle, "$.template.previewTitle", 160),
      previewDescription: stringValue(document.template.previewDescription, "$.template.previewDescription", 2_000),
      starterPrompt: stringValue(document.template.starterPrompt, "$.template.starterPrompt", 4_000),
      placeholderText: stringValue(document.template.placeholderText, "$.template.placeholderText", 500),
      requiresReference: Boolean(document.template.requiresReference),
      tags: normalizeTags(document.template.tags),
      requiredMembershipTier,
    },
  };
};

export const exportTemplateDocument = (row) => normalizeTemplateDocument({
  $schema: TEMPLATE_DOCUMENT_SCHEMA_ID,
  schemaVersion: TEMPLATE_DOCUMENT_SCHEMA_VERSION,
  kind: TEMPLATE_DOCUMENT_KIND,
  templateVersion: Math.max(1, Number(row?.version) || 1),
  template: {
    sceneKey: row?.scene_key,
    sceneName: row?.scene_name,
    outputType: row?.output_type,
    defaultModel: row?.default_model,
    defaultSeconds: row?.default_seconds,
    defaultSize: row?.default_size,
    systemPrompt: row?.system_prompt,
    previewTitle: row?.preview_title,
    previewDescription: row?.preview_description,
    starterPrompt: row?.starter_prompt,
    placeholderText: row?.placeholder_text,
    requiresReference: Boolean(row?.requires_reference),
    tags: Array.isArray(row?.tags) ? row.tags : [],
    requiredMembershipTier: row?.required_membership_tier || "free",
  },
});

export const TEMPLATE_DOCUMENT_JSON_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: TEMPLATE_DOCUMENT_SCHEMA_ID,
  title: "StarDraw prompt template document",
  type: "object",
  additionalProperties: false,
  required: ["$schema", "schemaVersion", "kind", "templateVersion", "template"],
  properties: {
    $schema: { const: TEMPLATE_DOCUMENT_SCHEMA_ID },
    schemaVersion: { const: TEMPLATE_DOCUMENT_SCHEMA_VERSION },
    kind: { const: TEMPLATE_DOCUMENT_KIND },
    templateVersion: { type: "integer", minimum: 1 },
    template: {
      type: "object",
      additionalProperties: false,
      required: ["sceneKey", "sceneName", "outputType", "defaultModel", "systemPrompt"],
      properties: {
        sceneKey: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$" },
        sceneName: { type: "string", minLength: 1, maxLength: 120 },
        outputType: { enum: ["image", "video"] },
        defaultModel: { type: "string", minLength: 1, maxLength: 100 },
        defaultSeconds: { type: ["integer", "null"], minimum: 1, maximum: 180 },
        defaultSize: { type: "string", pattern: "^(?:|\\d{2,5}x\\d{2,5})$" },
        systemPrompt: { type: "string", minLength: 1, maxLength: 20000 },
        previewTitle: { type: "string", maxLength: 160 },
        previewDescription: { type: "string", maxLength: 2000 },
        starterPrompt: { type: "string", maxLength: 4000 },
        placeholderText: { type: "string", maxLength: 500 },
        requiresReference: { type: "boolean" },
        tags: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } },
        requiredMembershipTier: { enum: ["free", "basic", "pro", "max", "enterprise"] },
      },
    },
  },
});

