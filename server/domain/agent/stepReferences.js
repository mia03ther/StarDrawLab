const STEP_REFERENCE_PATTERN = /\{\{\s*steps\.([^{}]+?)\s*\}\}/g;
const UNSAFE_REFERENCE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const parseJsonContainer = (value) => {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
};

const normalizeStepResult = (step) => {
  const result = parseJsonContainer(step?.result);
  return step?.toolKey === "canvas.list" && Array.isArray(result)
    ? { canvases: result }
    : result;
};

export const normalizeAgentStepAlias = (value) => String(value || "")
  .trim()
  .replace(/[^\p{L}\p{N}_-]+/gu, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 80);

export const buildAgentStepContext = (steps = []) => {
  const records = {};
  steps.forEach((step, index) => {
    if (step?.status !== "completed") return;
    const record = {
      result: normalizeStepResult(step),
      status: step.status,
      toolKey: step.toolKey,
      parameters: step.resolvedParameters || step.parameters,
    };
    [
      step.callId,
      step.planCallId,
      step.name,
      step.callName,
      `step_${index + 1}`,
      `step${index + 1}`,
    ].forEach((alias) => {
      const normalized = normalizeAgentStepAlias(alias);
      if (normalized && !records[normalized]) records[normalized] = record;
    });
  });
  return { steps: records };
};

const parseReferencePath = (expression) => {
  const source = String(expression || "").trim();
  const aliasEnd = source.search(/[.[]/);
  const rawAlias = aliasEnd < 0 ? source : source.slice(0, aliasEnd);
  const path = [];
  let cursor = aliasEnd < 0 ? source.length : aliasEnd;

  while (cursor < source.length) {
    if (source[cursor] === ".") {
      cursor += 1;
      const match = source.slice(cursor).match(/^[^.[\]]+/);
      if (!match) return null;
      path.push(match[0]);
      cursor += match[0].length;
      continue;
    }
    if (source[cursor] === "[") {
      const match = source.slice(cursor).match(/^\[(0|[1-9]\d{0,4})\]/);
      if (!match) return null;
      path.push(match[1]);
      cursor += match[0].length;
      continue;
    }
    return null;
  }

  if (!rawAlias || path.some((segment) => UNSAFE_REFERENCE_KEYS.has(segment))) return null;
  return { rawAlias, path };
};

const readReference = (context, expression) => {
  const parsed = parseReferencePath(expression);
  if (!parsed) return { found: false, value: undefined };
  const { rawAlias, path } = parsed;
  let current = context.steps[normalizeAgentStepAlias(rawAlias)];
  if (current === undefined) return { found: false, value: undefined };
  for (const segment of path) {
    if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  return { found: true, value: current };
};

export const resolveAgentStepReferences = (value, context, depth = 0) => {
  if (depth > 20) {
    throw Object.assign(new Error("Agent parameter nesting is too deep"), {
      status: 400,
      code: "AGENT_PLAN_PARAMETERS_TOO_DEEP",
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveAgentStepReferences(item, context, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveAgentStepReferences(item, context, depth + 1)]));
  }
  if (typeof value !== "string") return value;
  const exact = value.match(/^\s*\{\{\s*steps\.([^{}]+?)\s*\}\}\s*$/);
  if (exact) {
    const resolved = readReference(context, exact[1]);
    if (!resolved.found) {
      throw Object.assign(new Error(`Unresolved Agent step reference: steps.${exact[1].trim()}`), {
        status: 409,
        code: "AGENT_STEP_REFERENCE_UNRESOLVED",
      });
    }
    return resolved.value;
  }
  return value.replace(STEP_REFERENCE_PATTERN, (_match, expression) => {
    const resolved = readReference(context, expression);
    if (!resolved.found) {
      throw Object.assign(new Error(`Unresolved Agent step reference: steps.${String(expression).trim()}`), {
        status: 409,
        code: "AGENT_STEP_REFERENCE_UNRESOLVED",
      });
    }
    if (resolved.value == null) return "";
    return typeof resolved.value === "string" ? resolved.value : JSON.stringify(resolved.value);
  });
};
