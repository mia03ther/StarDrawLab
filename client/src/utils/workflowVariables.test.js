import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWorkflowVariableValues,
  parseWorkflowVariableDraft,
  workflowVariableDraft,
} from "./workflowVariables.js";

test("workflow run variable drafts preserve structured defaults", () => {
  assert.equal(workflowVariableDraft({ type: "object", default: { style: "film" } }), '{\n  "style": "film"\n}');
  assert.deepEqual(parseWorkflowVariableDraft("[1,2]", { type: "array" }), { value: [1, 2] });
});

test("workflow run variable collection validates required values and types", () => {
  const definitions = {
    prompt: { type: "string", label: "Prompt", required: true },
    count: { type: "number", label: "Count", default: 1 },
  };
  const invalid = collectWorkflowVariableValues(definitions, { prompt: "", count: "abc" });
  assert.equal(invalid.valid, false);
  assert.deepEqual(Object.keys(invalid.errors).sort(), ["count", "prompt"]);

  const valid = collectWorkflowVariableValues(definitions, { prompt: "hello", count: "3" });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.values, { prompt: "hello", count: 3 });
});
