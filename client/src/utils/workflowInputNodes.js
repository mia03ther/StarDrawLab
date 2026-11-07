const INPUT_TYPES = new Set(["string", "number", "boolean", "object", "array", "image", "video"]);
const INPUT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_:-]{0,127}$/;
const MEDIA_NODE_TYPES = new Set(["image.generate", "video.generate"]);
const REFERENCE_CONFIG_FIELDS = [
  "referenceExpression",
  "reference_expression",
  "referenceCreationId",
  "reference_creation_id",
];
const IMAGE_REFERENCE_HINT = /参考(?:图|图片|图像|素材)|(?:^|[_\s-])reference(?:[_\s-]*(?:image|photo|picture|element(?:[_\s-]*id)?))?(?:$|[_\s-])/i;

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const runtimeInputKeyFromValue = (value) => {
  const source = typeof value === "string" ? value.trim() : "";
  const dollar = source.match(/^\$\{\s*inputs\.([A-Za-z][A-Za-z0-9_:-]{0,127})\s*\}$/);
  if (dollar) return dollar[1];
  const braces = source.match(/^\{\{\s*inputs\.([A-Za-z][A-Za-z0-9_:-]{0,127})\s*\}\}$/);
  return braces?.[1] || "";
};

const runtimeFieldReferenceFromValue = (value) => {
  const source = typeof value === "string" ? value.trim() : "";
  const dollar = source.match(/^\$\{\s*(variables|inputs)\.([A-Za-z][A-Za-z0-9_:-]{0,127})\s*\}$/);
  if (dollar) return { root: dollar[1], key: dollar[2] };
  const braces = source.match(/^\{\{\s*(variables|inputs)\.([A-Za-z][A-Za-z0-9_:-]{0,127})\s*\}\}$/);
  return braces ? { root: braces[1], key: braces[2] } : null;
};

const collectImageReferenceBindings = (definition, bindings = new Set()) => {
  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const type = String(node?.type || node?.nodeType || node?.node_type || "").trim().toLowerCase();
    const config = object(node?.config);
    if (MEDIA_NODE_TYPES.has(type)) {
      for (const field of REFERENCE_CONFIG_FIELDS) {
        const reference = runtimeFieldReferenceFromValue(config[field]);
        if (reference) bindings.add(`${reference.root}:${reference.key}`);
      }
    }
    if (["loop.foreach", "loop.repeat_until"].includes(type)) {
      collectImageReferenceBindings(config.body, bindings);
    }
  }
  return bindings;
};

const friendlyImageLabel = (value) => {
  const source = String(value || "").trim();
  const cleaned = source
    .replace(/(?:画布)?(?:图片|图像|素材)?\s*(?:元素|作品|创作)?\s*(?:ID|标识|编号)/giu, "")
    .replace(/(?:canvas\s*)?(?:image\s*)?(?:element|creation|media)?\s*id/giu, "")
    .replace(/[()（）:_-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!cleaned || (cleaned === source && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(cleaned))) return "参考图";
  return cleaned;
};

export const prepareWorkflowRunFieldDefinitions = (definitions, definition, root = "variables") => {
  const bindings = collectImageReferenceBindings(definition);
  return Object.fromEntries(Object.entries(object(definitions)).map(([key, rawDescriptor]) => {
    const descriptor = object(rawDescriptor);
    const type = String(descriptor.type || "string").trim().toLowerCase();
    const searchable = `${key} ${descriptor.label || ""} ${descriptor.description || ""}`;
    const isImage = type === "image"
      || (type !== "video" && (bindings.has(`${root}:${key}`) || IMAGE_REFERENCE_HINT.test(searchable)));
    if (!isImage) return [key, descriptor];
    return [key, {
      ...descriptor,
      type: "image",
      label: friendlyImageLabel(descriptor.label || key),
      description: String(descriptor.description || "").trim(),
    }];
  }));
};

export const collectWorkflowRunInputDefinitions = (definition) => {
  const fields = {};
  for (const node of Array.isArray(definition?.nodes) ? definition.nodes : []) {
    const type = String(node?.type || node?.nodeType || node?.node_type || "").trim().toLowerCase();
    if (type !== "input") continue;
    const config = object(node?.config);
    const expressionKey = runtimeInputKeyFromValue(config.value);
    const explicitKey = String(config.inputKey || config.input_key || "").trim();
    const nodeKey = String(node?.id || node?.nodeKey || node?.node_key || "").trim();
    const inferredKey = !Object.prototype.hasOwnProperty.call(config, "value")
      && !Object.prototype.hasOwnProperty.call(config, "prompt")
      && INPUT_KEY_PATTERN.test(nodeKey)
      ? nodeKey
      : "";
    const key = expressionKey
      || (INPUT_KEY_PATTERN.test(explicitKey) ? explicitKey : "")
      || inferredKey;
    if (!key || fields[key]) continue;
    const inputType = String(config.inputType || config.input_type || "string").trim().toLowerCase();
    fields[key] = {
      type: INPUT_TYPES.has(inputType) ? inputType : "string",
      label: String(config.label || node?.title || node?.label || key).trim().slice(0, 160) || key,
      description: String(config.description || "").trim().slice(0, 500),
      default: config.default ?? null,
      required: config.required !== false,
    };
  }
  return prepareWorkflowRunFieldDefinitions(fields, definition, "inputs");
};

export const hasWorkflowRunInputs = (definition) => (
  Object.keys(collectWorkflowRunInputDefinitions(definition)).length > 0
);
