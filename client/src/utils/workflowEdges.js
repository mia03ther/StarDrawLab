const array = (value) => (Array.isArray(value) ? value : []);
const text = (value) => String(value ?? "").trim();

const edgeFrom = (edge) => text(edge?.from || edge?.source);
const edgeTo = (edge) => text(edge?.to || edge?.target);
const edgeBranch = (edge) => {
  const branch = text(edge?.branch || edge?.sourceHandle).toLowerCase();
  return ["true", "false"].includes(branch) ? branch : null;
};

const nodeId = (node) => text(node?.id || node?.nodeKey || node?.node_key);

const dependencyBranch = (node, dependency) => {
  const when = node?.config?.when || node?.when;
  if (!when || text(when.nodeKey || when.node_key) !== dependency) return null;
  const branch = text(when.branch).toLowerCase();
  return ["true", "false"].includes(branch) ? branch : null;
};

/**
 * Workflow agents may provide dependencies on nodes without serializing the
 * equivalent edge list. Keep the graph drawable and executable by deriving
 * the missing edges while retaining explicit branch edges.
 */
export const deriveWorkflowEdges = ({ nodes = [], edges = [] } = {}) => {
  const normalizedNodes = array(nodes);
  const knownIds = new Set(normalizedNodes.map(nodeId).filter(Boolean));
  const result = [];

  array(edges).forEach((edge, index) => {
    const from = edgeFrom(edge);
    const to = edgeTo(edge);
    if (!from || !to || from === to || !knownIds.has(from) || !knownIds.has(to)) return;
    result.push({
      ...edge,
      id: text(edge?.id) || `${from}->${to}${edgeBranch(edge) ? `:${edgeBranch(edge)}` : `:${index}`}`,
      from,
      to,
      branch: edgeBranch(edge),
    });
  });

  normalizedNodes.forEach((node) => {
    const to = nodeId(node);
    if (!to) return;
    const dependencies = [
      ...array(node?.dependsOn || node?.depends_on),
      ...array(node?.config?.dependsOn || node?.config?.depends_on),
    ];
    [...new Set(dependencies.map(text).filter(Boolean))].forEach((from) => {
      if (!knownIds.has(from) || from === to) return;
      const branch = dependencyBranch(node, from);
      const alreadyConnected = result.some((edge) => (
        edge.from === from && edge.to === to && (!branch || edge.branch === branch)
      ));
      if (alreadyConnected) return;
      result.push({
        id: `${from}->${to}${branch ? `:${branch}` : ""}`,
        from,
        to,
        branch,
      });
    });
  });

  return result;
};

export { edgeBranch, edgeFrom, edgeTo };
