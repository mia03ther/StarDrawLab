const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

// The node catalog calls its field definitions `fields`. Agent-created node
// instances historically copied values into that property, while the runtime
// consumes `config`. Accept both at the persistence boundary and keep config
// authoritative when both are present.
export const resolveWorkflowNodeConfig = (node) => ({
  ...object(node?.fields),
  ...object(node?.config),
});

