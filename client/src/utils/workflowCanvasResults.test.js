import assert from "node:assert/strict";
import test from "node:test";

import {
  collectWorkflowCanvasMediaResults,
  mergeGeneratedCanvasMediaFromServer,
  mergeWorkflowCanvasMediaElement,
} from "./workflowCanvasResults.js";

const workflowImage = {
  id: "workflow_generate_poster_284",
  type: "image",
  x: 120,
  y: 1560,
  width: 320,
  height: 320,
  creationId: "284",
  src: "/oss-proxy/workflow-result.png",
  source: "workflow_generation",
};

test("completed workflow media is extracted from its revision snapshot", () => {
  const results = collectWorkflowCanvasMediaResults([
    { nodeKey: "copy", nodeType: "agent.call", status: "completed", result: { text: "headline" } },
    {
      nodeKey: "generate_poster",
      nodeType: "image.generate",
      status: "completed",
      result: {
        creationId: 284,
        canvasElementId: workflowImage.id,
        revision: { canvasState: { elements: [workflowImage] } },
      },
    },
  ]);

  assert.deepEqual(results, [{
    key: workflowImage.id,
    nodeKey: "generate_poster",
    creationId: "284",
    element: workflowImage,
  }]);
});

test("workflow media merges without replacing local edits and lands below its generating node", () => {
  const localEdit = { id: "local_note", type: "text", x: 42, y: 58, width: 220, height: 120 };
  const merged = mergeWorkflowCanvasMediaElement({
    elements: [localEdit],
    element: workflowImage,
    anchor: { x: 500, y: 200, width: 228, height: 112 },
    viewport: { x: -400, y: -240, scale: 2 },
    boardSize: { width: 1200, height: 800 },
  });

  assert.equal(merged.inserted, true);
  assert.equal(merged.elements.length, 2);
  assert.deepEqual(merged.elements[0], localEdit);
  assert.equal(merged.element.x, 454);
  assert.equal(merged.element.y, 352);
});

test("later outputs from the same node stack below earlier media instead of overlapping", () => {
  const existing = {
    ...workflowImage,
    id: "workflow_generate_poster_283",
    creationId: "283",
    workflowNodeKey: "generate_poster",
    x: 454,
    y: 352,
  };
  const merged = mergeWorkflowCanvasMediaElement({
    elements: [existing],
    element: { ...workflowImage, workflowNodeKey: "generate_poster" },
    anchor: { x: 500, y: 200, width: 228, height: 112 },
  });

  assert.equal(merged.element.x, 454);
  assert.equal(merged.element.y, 696);
});

test("workflow media is idempotent by element id or creation id", () => {
  const sameCreation = { ...workflowImage, id: "existing_image" };
  const merged = mergeWorkflowCanvasMediaElement({
    elements: [sameCreation],
    element: workflowImage,
    viewport: { x: 0, y: 0, scale: 1 },
    boardSize: { width: 1200, height: 800 },
  });

  assert.equal(merged.inserted, false);
  assert.equal(merged.elements.length, 1);
  assert.equal(merged.element.id, "existing_image");
});

test("save reconciliation restores generated media missing from stale local state", () => {
  const localNote = { id: "note-1", type: "text", text: "local edit" };
  const merged = mergeGeneratedCanvasMediaFromServer({
    localElements: [localNote],
    serverElements: [
      { id: "note-1", type: "text", text: "older server note" },
      { ...workflowImage, source: "workflow_generation" },
      {
        id: "agent-media-286",
        type: "video",
        creationId: "286",
        src: "/oss-proxy/video-286.mp4",
        source: "canvas_agent_generation",
      },
    ],
  });

  assert.equal(merged.changed, true);
  assert.equal(merged.elements[0], localNote);
  assert.deepEqual(merged.elements.slice(1).map((element) => element.creationId), ["284", "286"]);
});
