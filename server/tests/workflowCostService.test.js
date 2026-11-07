import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateWorkflowCost,
  normalizeWorkflowDefinition,
  workflowContainsMcpCall,
} from "../services/workflowCostService.js";

test("workflow MCP detection handles canonical and Agent tool aliases", () => {
  assert.equal(workflowContainsMcpCall({ nodes: [{ id: "read", type: "canvas.read" }] }), false);
  assert.equal(workflowContainsMcpCall({ nodes: [{ id: "mcp", type: "mcp.call" }] }), true);
  assert.equal(workflowContainsMcpCall({ nodes: [{ id: "mcp", nodeType: "mcp.call.external" }] }), true);
});

test("workflow normalization rejects missing dependencies and cycles", () => {
  assert.throws(
    () => normalizeWorkflowDefinition({ nodes: [{ id: "a", type: "image", dependsOn: ["missing"] }] }),
    (error) => error.code === "INVALID_WORKFLOW_DEFINITION",
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ nodes: [
      { id: "a", type: "image", dependsOn: ["b"] },
      { id: "b", type: "image", dependsOn: ["a"] },
    ] }),
    (error) => /cycle/i.test(error.message),
  );
});

test("workflow normalization preserves canvas node positions for result placement", () => {
  const definition = normalizeWorkflowDefinition({
    nodes: [{ id: "image", type: "image.generate", x: 420, y: 180 }],
  });
  assert.equal(definition.nodes[0].x, 420);
  assert.equal(definition.nodes[0].y, 180);
});

test("legacy image input nodes without a value are normalized to runtime inputs", () => {
  const definition = normalizeWorkflowDefinition({
    nodes: [{
      id: "reference_image",
      type: "input",
      config: { inputType: "image", label: "首饰参考图", required: true },
    }],
  });

  assert.equal(definition.nodes[0].config.inputKey, "reference_image");
  assert.equal(definition.nodes[0].config.inputMode, "runtime");
  assert.equal(definition.nodes[0].config.value, "${inputs.reference_image}");
});

test("workflow estimate sums independent and parallel branches", () => {
  const definition = normalizeWorkflowDefinition({ nodes: [
    { id: "input", type: "input", pointsEstimate: 0 },
    { id: "cheap", type: "image", dependsOn: ["input"], pointsEstimate: 2 },
    { id: "expensive", type: "video", dependsOn: ["input"], pointsEstimate: 8 },
    { id: "publish", type: "publish", dependsOn: ["cheap"], pointsEstimate: 1 },
  ] });
  const estimate = estimateWorkflowCost(definition.nodes);
  assert.equal(estimate.totalPoints, 11);
  assert.deepEqual(estimate.paths[0].nodeKeys, ["input", "cheap", "expensive", "publish"]);
  assert.equal(estimate.knownNodePoints, 11);
  assert.equal(estimate.strategy, "all_parallel_nodes");
});

test("workflow estimate selects the most expensive exclusive condition branch and counts the merge tail", () => {
  const definition = normalizeWorkflowDefinition({
    nodes: [
      { id: "condition", type: "condition.rule", pointsEstimate: 0 },
      { id: "image", type: "image.generate", pointsEstimate: 4 },
      { id: "video", type: "video.generate", pointsEstimate: 8 },
      { id: "merge", type: "merge", dependsOn: ["image", "video"], pointsEstimate: 0 },
      { id: "publish", type: "agent.call", dependsOn: ["merge"], pointsEstimate: 2 },
    ],
    edges: [
      { from: "condition", to: "image", branch: "true" },
      { from: "condition", to: "video", branch: "false" },
    ],
  });

  const estimate = estimateWorkflowCost(definition.nodes);
  assert.equal(estimate.totalPoints, 10);
  assert.equal(estimate.knownNodePoints, 14);
  assert.equal(estimate.strategy, "maximum_branch_scenario");
  assert.deepEqual(estimate.paths[0].branches, { condition: "false" });
  assert.deepEqual(estimate.paths[0].nodeKeys, ["condition", "video", "merge", "publish"]);
});
