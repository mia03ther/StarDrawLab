import assert from "node:assert/strict";
import test from "node:test";

import { patchWorkflow } from "../modules/canvas-agent/toolRegistry.js";
import { applyAgentWorkflowOperations } from "../domain/workflow/workflowAgentDefinition.js";

const baseWorkflow = () => ({
  name: "Poster workflow",
  definition: {
    version: 1,
    nodes: [{ id: "prompt", type: "input", config: { value: "old" } }],
    edges: [],
    variables: {},
  },
});

test("canvas workflow patch accepts operation aliases emitted by Agent models", () => {
  for (const field of ["type", "op", "action", "operation"]) {
    const patched = patchWorkflow(baseWorkflow(), [{
      [field]: "update_node",
      nodeId: "prompt",
      patch: { config: { value: field } },
    }]);

    assert.equal(patched.definition.nodes[0].config.value, field);
  }
});

test("canvas workflow patch reports a useful error when the operation name is missing", () => {
  assert.throws(
    () => patchWorkflow(baseWorkflow(), [{ nodeId: "prompt" }]),
    (error) => error.code === "WORKFLOW_PATCH_OPERATION_UNSUPPORTED"
      && error.message === "Unsupported workflow patch operation: <empty>",
  );
});

test("canvas workflow patch supports clear, variables, and rename operations", () => {
  const patched = patchWorkflow(baseWorkflow(), [
    { action: "set_variables", variables: { headline: { type: "string" } } },
    { operation: "rename_workflow", name: "Updated workflow" },
    { op: "clear_all" },
  ]);

  assert.equal(patched.name, "Updated workflow");
  assert.deepEqual(patched.definition.nodes, []);
  assert.deepEqual(patched.definition.edges, []);
  assert.deepEqual(patched.definition.variables, {});
});

test("shared workflow patch normalization supports variables and rename aliases", () => {
  const patched = applyAgentWorkflowOperations(baseWorkflow().definition, [
    { action: "set_variable", variables: { subject: { type: "string" } } },
    { op: "set_name", value: "Shared workflow" },
  ]);

  assert.equal(patched.name, "Shared workflow");
  assert.deepEqual(patched.variables, { subject: { type: "string" } });
});
