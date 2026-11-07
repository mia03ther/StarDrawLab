import assert from "node:assert/strict";
import test from "node:test";

import { deriveWorkflowEdges } from "./workflowEdges.js";

test("workflow graph derives a visible edge from a node dependency", () => {
  const edges = deriveWorkflowEdges({
    nodes: [
      { id: "canvas-image", type: "canvas.image" },
      { id: "generate", type: "image.generate", dependsOn: ["canvas-image"] },
    ],
    edges: [],
  });

  assert.deepEqual(edges, [{
    id: "canvas-image->generate",
    from: "canvas-image",
    to: "generate",
    branch: null,
  }]);
});

test("workflow graph preserves explicit branch edges without adding duplicates", () => {
  const edges = deriveWorkflowEdges({
    nodes: [
      { id: "condition", type: "condition.rule" },
      { id: "poster", type: "image.generate", dependsOn: ["condition"], config: { when: { nodeKey: "condition", branch: "true" } } },
    ],
    edges: [{ id: "true-edge", source: "condition", target: "poster", sourceHandle: "true" }],
  });

  assert.deepEqual(edges, [{
    id: "true-edge",
    source: "condition",
    target: "poster",
    sourceHandle: "true",
    from: "condition",
    to: "poster",
    branch: "true",
  }]);
});

test("workflow graph ignores dependency references to missing nodes", () => {
  const edges = deriveWorkflowEdges({
    nodes: [{ id: "generate", type: "image.generate", dependsOn: ["missing"] }],
    edges: [],
  });

  assert.deepEqual(edges, []);
});
