export const WORKFLOW_VARIABLE_TYPES = Object.freeze([
  "string", "number", "boolean", "object", "array", "image", "video",
]);

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export const normalizeWorkflowVariableDefinitions = (value) => Object.fromEntries(
  Object.entries(object(value)).map(([key, raw]) => {
    const descriptor = object(raw);
    const type = WORKFLOW_VARIABLE_TYPES.includes(descriptor.type) ? descriptor.type : "string";
    return [key, {
      type,
      label: String(descriptor.label || key),
      description: String(descriptor.description || ""),
      default: descriptor.default ?? null,
      required: descriptor.required === true,
    }];
  }),
);

export const workflowVariableDraft = (descriptor) => {
  const value = descriptor?.default;
  if (value == null) return "";
  if (["object", "array"].includes(descriptor?.type)) return JSON.stringify(value, null, 2);
  if (descriptor?.type === "boolean") return value ? "true" : "false";
  return String(value);
};

export const parseWorkflowVariableDraft = (rawValue, descriptor, key = "variable") => {
  const raw = typeof rawValue === "string" ? rawValue : rawValue == null ? "" : String(rawValue);
  const type = descriptor?.type || "string";
  if (raw === "" && type !== "string") {
    if (descriptor?.required) return { error: `${descriptor.label || key} is required` };
    return { value: null };
  }
  if (type === "string") {
    if (descriptor?.required && !raw.trim()) return { error: `${descriptor.label || key} is required` };
    return { value: raw };
  }
  if (type === "number") {
    const value = Number(raw);
    return Number.isFinite(value) ? { value } : { error: `${descriptor.label || key} must be a number` };
  }
  if (type === "boolean") {
    if (raw === "true") return { value: true };
    if (raw === "false") return { value: false };
    return { error: `${descriptor.label || key} must be true or false` };
  }
  if (["object", "array"].includes(type)) {
    try {
      const value = JSON.parse(raw);
      if (type === "array" && !Array.isArray(value)) return { error: `${descriptor.label || key} must be an array` };
      if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return { error: `${descriptor.label || key} must be an object` };
      return { value };
    } catch {
      return { error: `${descriptor.label || key} contains invalid JSON` };
    }
  }
  if (!raw.trim()) {
    if (descriptor?.required) return { error: `${descriptor.label || key} is required` };
    return { value: null };
  }
  return { value: raw.trim() };
};

export const collectWorkflowVariableValues = (definitions, drafts) => {
  const normalized = normalizeWorkflowVariableDefinitions(definitions);
  const values = {};
  const errors = {};
  for (const [key, descriptor] of Object.entries(normalized)) {
    const parsed = parseWorkflowVariableDraft(drafts?.[key] ?? workflowVariableDraft(descriptor), descriptor, key);
    if (parsed.error) errors[key] = parsed.error;
    else values[key] = parsed.value;
  }
  return { values, errors, valid: Object.keys(errors).length === 0 };
};
