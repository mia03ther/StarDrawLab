const RESERVED_ROOTS = new Set(["nodes", "inputs", "variables", "loop"]);

export const valueAtWorkflowPath = (value, pathValue) => {
  const path = String(pathValue || "").split(".").filter(Boolean);
  let current = value;
  for (const segment of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

export const resolveWorkflowExpression = (expression, context = {}) => {
  const raw = String(expression || "")
    .trim()
    .replace(/^\$\{\s*|\s*\}$/g, "")
    .replace(/^\{\{\s*|\s*\}\}$/g, "");
  if (!raw) return undefined;
  const [root, ...path] = raw.split(".").filter(Boolean);
  if (!RESERVED_ROOTS.has(root)) return undefined;
  return path.length ? valueAtWorkflowPath(context[root], path.join(".")) : context[root];
};

export const interpolateWorkflowValue = (value, context = {}) => {
  if (typeof value === "string") {
    const exact = value.match(/^(?:\{\{|\$\{)\s*(.*?)\s*(?:\}\}|\})$/);
    if (exact) {
      const resolved = resolveWorkflowExpression(exact[1], context);
      return resolved === undefined ? value : resolved;
    }
    return value.replace(/(?:\{\{|\$\{)\s*(.*?)\s*(?:\}\}|\})/g, (match, expression) => {
      const resolved = resolveWorkflowExpression(expression, context);
      if (resolved == null) return "";
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateWorkflowValue(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateWorkflowValue(item, context)]));
  }
  return value;
};

const isEmpty = (value) => value == null || value === "" || (Array.isArray(value) && value.length === 0);

export const evaluateWorkflowCondition = ({ left, operator = "equals", right } = {}) => {
  let matched = false;
  switch (String(operator || "equals").toLowerCase()) {
    case "not_equals": matched = left !== right; break;
    case "contains": matched = Array.isArray(left) ? left.includes(right) : String(left ?? "").includes(String(right ?? "")); break;
    case "greater_than": matched = Number(left) > Number(right); break;
    case "greater_or_equal": matched = Number(left) >= Number(right); break;
    case "less_than": matched = Number(left) < Number(right); break;
    case "less_or_equal": matched = Number(left) <= Number(right); break;
    case "exists": matched = left !== undefined && left !== null; break;
    case "is_empty": matched = isEmpty(left); break;
    default: matched = left === right;
  }
  return { matched, branch: matched ? "true" : "false", left, right };
};
