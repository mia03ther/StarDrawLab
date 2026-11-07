import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeCanvasAgentReferences,
  serializeCanvasAgentReferences,
  toCanvasAgentReference,
} from "./canvasAgentReferences.js";

test("Canvas Agent image attachments keep a preview locally but send only canvas element identity", () => {
  const reference = toCanvasAgentReference({
    id: "upload_1",
    type: "image",
    title: "产品参考图",
    src: "https://private.example/secret.jpg",
    objectKey: "private/user/secret.jpg",
  });

  assert.equal(reference.previewUrl, "https://private.example/secret.jpg");
  assert.deepEqual(serializeCanvasAgentReferences([reference]), [{
    elementId: "upload_1",
    title: "产品参考图",
  }]);
  assert.doesNotMatch(JSON.stringify(serializeCanvasAgentReferences([reference])), /secret\.jpg/);
});

test("Canvas Agent image attachments deduplicate selection and cap it at four", () => {
  const references = mergeCanvasAgentReferences(
    [{ elementId: "a", type: "image", title: "A", previewUrl: "/a.jpg" }],
    [
      { id: "a", type: "image", title: "A2", src: "/a2.jpg" },
      { id: "b", type: "image", src: "/b.jpg" },
      { id: "c", type: "image", src: "/c.jpg" },
      { id: "d", type: "image", src: "/d.jpg" },
      { id: "e", type: "image", src: "/e.jpg" },
    ],
  );

  assert.deepEqual(references.map((item) => item.elementId), ["a", "b", "c", "d"]);
  assert.equal(references[0].previewUrl, "/a2.jpg");
});
