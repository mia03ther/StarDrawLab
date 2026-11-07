import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWorkflowVariableDefinitions,
  resolveWorkflowRunContext,
} from "../modules/canvas-workflows/variables.js";

test("workflow variables normalize declarations and coerce supported run values", () => {
  const definitions = normalizeWorkflowVariableDefinitions({
    prompt: { type: "string", label: "Prompt", required: true },
    count: { type: "number", default: 2 },
    enabled: { type: "boolean", default: true },
    metadata: { type: "object", default: { style: "film" } },
    shots: { type: "array", default: [] },
  });

  const context = resolveWorkflowRunContext({
    definitions,
    variableValues: {
      prompt: "city at night",
      count: "3",
      enabled: "false",
      metadata: "{\"style\":\"documentary\"}",
      shots: "[1,2]",
    },
    inputs: { locale: "zh-CN" },
  });

  assert.deepEqual(context.variables, {
    prompt: "city at night",
    count: 3,
    enabled: false,
    metadata: { style: "documentary" },
    shots: [1, 2],
  });
  assert.equal(context.inputs.prompt, "city at night");
  assert.equal(context.inputs.locale, "zh-CN");
});

test("workflow variables reject missing required and unknown values", () => {
  const definitions = { prompt: { type: "string", required: true } };
  assert.throws(
    () => resolveWorkflowRunContext({ definitions, variableValues: {} }),
    (error) => error.code === "WORKFLOW_VARIABLE_REQUIRED",
  );
  assert.throws(
    () => resolveWorkflowRunContext({ definitions, variableValues: { prompt: "ok", forged: true } }),
    (error) => error.code === "WORKFLOW_VARIABLE_UNKNOWN",
  );
});

test("nested workflow variables inherit parent context without weakening public validation", () => {
  const context = resolveWorkflowRunContext({
    definitions: { child: { type: "number", default: 1 } },
    inheritedVariables: { parent: "kept", child: 4 },
    inheritedInputs: { requestId: "request-1" },
    allowInheritedVariables: true,
  });

  assert.deepEqual(context.variables, { parent: "kept", child: 4 });
  assert.equal(context.inputs.parent, "kept");
  assert.equal(context.inputs.requestId, "request-1");
});
