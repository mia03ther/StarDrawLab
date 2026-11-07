const VARIABLE_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const VARIABLE_TYPES = new Set(["string", "number", "boolean", "object", "array", "image", "video"]);
const MAX_VARIABLES = 100;
const MAX_CONTEXT_BYTES = 256 * 1024;

const fail = (message, code = "INVALID_WORKFLOW_VARIABLES") => Object.assign(new Error(message), {
  status: 400,
  code,
});

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const clone = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
const clean = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);

const inferredType = (value) => {
  if (Array.isArray(value)) return "array";
  if (value && typeof value === "object") return "object";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
};

const parseStructuredValue = (value, expectedType, key) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw fail(`Workflow variable ${key} must be a valid ${expectedType}`);
  }
};

const normalizeValue = (value, type, key) => {
  if (value == null) return null;
  if (type === "string") {
    if (typeof value !== "string") throw fail(`Workflow variable ${key} must be a string`);
    return value.slice(0, 100_000);
  }
  if (type === "number") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) throw fail(`Workflow variable ${key} must be a finite number`);
    return number;
  }
  if (type === "boolean") {
    if (value === true || value === false) return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw fail(`Workflow variable ${key} must be a boolean`);
  }
  if (type === "array") {
    const parsed = parseStructuredValue(value, "array", key);
    if (!Array.isArray(parsed)) throw fail(`Workflow variable ${key} must be an array`);
    return clone(parsed);
  }
  if (type === "object") {
    const parsed = parseStructuredValue(value, "object", key);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail(`Workflow variable ${key} must be an object`);
    return clone(parsed);
  }
  if (["image", "video"].includes(type)) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 4096);
    if (value && typeof value === "object" && !Array.isArray(value)) return clone(value);
    throw fail(`Workflow variable ${key} must be a media URL, creation ID, or media object`);
  }
  throw fail(`Workflow variable ${key} has an unsupported type`);
};

const assertContextSize = (value, label) => {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTEXT_BYTES) {
    throw fail(`${label} exceeds ${MAX_CONTEXT_BYTES} bytes`, "WORKFLOW_CONTEXT_TOO_LARGE");
  }
};

export const normalizeWorkflowVariableDefinitions = (value) => {
  const entries = Object.entries(object(value));
  if (entries.length > MAX_VARIABLES) throw fail(`Workflow cannot declare more than ${MAX_VARIABLES} variables`);
  const normalized = {};
  for (const [key, raw] of entries) {
    if (!VARIABLE_KEY.test(key)) throw fail(`Invalid workflow variable key: ${key}`);
    const descriptor = raw && typeof raw === "object" && !Array.isArray(raw)
      ? raw
      : { type: inferredType(raw), default: raw };
    const type = String(descriptor.type || inferredType(descriptor.default)).trim().toLowerCase();
    if (!VARIABLE_TYPES.has(type)) throw fail(`Unsupported type for workflow variable ${key}: ${type}`);
    const hasDefault = Object.prototype.hasOwnProperty.call(descriptor, "default");
    const defaultValue = hasDefault ? normalizeValue(descriptor.default, type, key) : null;
    normalized[key] = {
      type,
      label: clean(descriptor.label || key),
      description: clean(descriptor.description, 500),
      default: defaultValue,
      required: descriptor.required === true,
    };
  }
  assertContextSize(normalized, "Workflow variable definitions");
  return normalized;
};

const missingRequiredValue = (value, type) => value == null || (type === "string" && value.trim() === "");

export const resolveWorkflowRunContext = ({
  definitions,
  variableValues,
  inputs,
  inheritedVariables,
  inheritedInputs,
  allowInheritedVariables = false,
} = {}) => {
  const declared = normalizeWorkflowVariableDefinitions(definitions);
  const provided = object(variableValues);
  const inherited = object(inheritedVariables);
  const unknown = Object.keys(provided).filter((key) => !Object.prototype.hasOwnProperty.call(declared, key));
  if (unknown.length) throw fail(`Unknown workflow variables: ${unknown.join(", ")}`, "WORKFLOW_VARIABLE_UNKNOWN");

  const variables = allowInheritedVariables ? clone(inherited) : {};
  for (const [key, descriptor] of Object.entries(declared)) {
    const supplied = Object.prototype.hasOwnProperty.call(provided, key)
      ? provided[key]
      : Object.prototype.hasOwnProperty.call(inherited, key)
        ? inherited[key]
        : descriptor.default;
    const value = normalizeValue(supplied, descriptor.type, key);
    if (descriptor.required && missingRequiredValue(value, descriptor.type)) {
      throw fail(`Workflow variable ${key} is required`, "WORKFLOW_VARIABLE_REQUIRED");
    }
    variables[key] = value;
  }

  const explicitInputs = object(inputs);
  const resolvedInputs = {
    ...clone(object(inheritedInputs)),
    ...clone(variables),
    ...clone(explicitInputs),
  };
  assertContextSize(variables, "Workflow variables");
  assertContextSize(resolvedInputs, "Workflow inputs");
  return { variables, inputs: resolvedInputs };
};

export const WORKFLOW_VARIABLE_TYPES = Object.freeze([...VARIABLE_TYPES]);
