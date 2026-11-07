import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentStepContext, resolveAgentStepReferences } from "../domain/agent/stepReferences.js";

test("Agent step references preserve exact JSON types and interpolate embedded values", () => {
  const context = buildAgentStepContext([{
    callId: "read",
    callName: "Read canvas",
    status: "completed",
    toolKey: "canvas.read",
    parameters: { canvasId: "c1" },
    result: { state: { elements: [{ id: "e1" }] }, updatedAt: "2026-08-08T00:00:00.000Z" },
  }]);
  assert.deepEqual(
    resolveAgentStepReferences("{{steps.read.result.state}}", context),
    { elements: [{ id: "e1" }] },
  );
  assert.equal(
    resolveAgentStepReferences("version={{steps.read.result.updatedAt}}", context),
    "version=2026-08-08T00:00:00.000Z",
  );
});

test("Agent step references fail closed when an alias or path is unresolved", () => {
  assert.throws(
    () => resolveAgentStepReferences("{{steps.missing.result.id}}", { steps: {} }),
    (error) => error.code === "AGENT_STEP_REFERENCE_UNRESOLVED" && error.status === 409,
  );
});

test("canvas.list step references expose a stable canvases collection", () => {
  const context = buildAgentStepContext([{
    callId: "list_canvas",
    callName: "List canvases",
    status: "completed",
    toolKey: "canvas.list",
    result: [{ id: "canvas-1", title: "Storyboard" }],
  }]);

  assert.equal(
    resolveAgentStepReferences("{{steps.list_canvas.result.canvases[0].id}}", context),
    "canvas-1",
  );
});

test("canvas.list step references tolerate a legacy persisted JSON string result", () => {
  const context = buildAgentStepContext([{
    callId: "list_canvas",
    callName: "List canvases",
    status: "completed",
    toolKey: "canvas.list",
    result: JSON.stringify([{ id: "canvas-legacy", title: "Legacy canvas" }]),
  }]);

  assert.equal(
    resolveAgentStepReferences("{{steps.list_canvas.result.canvases[0].id}}", context),
    "canvas-legacy",
  );
});
