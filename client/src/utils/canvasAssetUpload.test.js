import assert from "node:assert/strict";
import test from "node:test";

import {
  createCanvasAssetElement,
  createCanvasAssetUploadConfig,
  getCanvasAssetType,
  getCanvasDropPoint,
  normalizeCanvasAssetUploadResponse,
  uploadCanvasAsset,
} from "./canvasAssetUpload.js";

test("local canvas uploads identify supported media and always carry an idempotency key", () => {
  const file = { type: "image/png", name: "poster.png" };

  assert.equal(getCanvasAssetType(file), "image");
  assert.deepEqual(createCanvasAssetUploadConfig(file, "canvas-upload-1"), {
    type: "image",
    headers: { "X-Idempotency-Key": "canvas-upload-1" },
  });
});

test("local file selection reaches the canvas upload endpoint with the required request shape", async () => {
  const file = new File(["image"], "poster.png", { type: "image/png" });
  let capturedRequest = null;
  const asset = await uploadCanvasAsset({
    client: {
      post: async (...args) => {
        capturedRequest = args;
        return { data: { data: { id: "asset-1", type: "image", src: "/poster.png" } } };
      },
    },
    file,
    idempotencyKey: "canvas-upload-2",
  });

  assert.equal(capturedRequest[0], "/api/canvases/assets");
  assert.equal(capturedRequest[1].get("asset"), file);
  assert.equal(capturedRequest[1].get("type"), "image");
  assert.equal(capturedRequest[2].headers["X-Idempotency-Key"], "canvas-upload-2");
  assert.equal(asset.id, "asset-1");
});

test("canvas uploads unwrap legacy serialized snapshots into usable assets", async () => {
  const serialized = JSON.stringify({
    id: "asset-legacy",
    type: "image",
    object_key: "quickai/user/canvas image.jpg",
  });

  assert.deepEqual(normalizeCanvasAssetUploadResponse(serialized), {
    id: "asset-legacy",
    type: "image",
    object_key: "quickai/user/canvas image.jpg",
    objectKey: "quickai/user/canvas image.jpg",
    resourceId: "",
    src: "/oss-proxy/quickai/user/canvas%20image.jpg",
    url: "/oss-proxy/quickai/user/canvas%20image.jpg",
    source: "canvas_upload",
  });
});

test("a serialized upload response becomes a renderable canvas element", () => {
  const asset = normalizeCanvasAssetUploadResponse(JSON.stringify({
    id: "asset-legacy",
    type: "image",
    object_key: "quickai/user/canvas image.jpg",
    title: "Canvas image",
  }));

  assert.deepEqual(createCanvasAssetElement({
    asset,
    elementId: "image-1",
    center: { x: 500, y: 400 },
  }), {
    id: "image-1",
    type: "image",
    x: 340,
    y: 240,
    width: 320,
    height: 320,
    title: "Canvas image",
    creationId: "",
    src: "/oss-proxy/quickai/user/canvas%20image.jpg",
    poster: "",
    source: "canvas_upload",
    objectKey: "quickai/user/canvas image.jpg",
    resourceId: "",
  });
});

test("uploaded canvas elements retain the server-owned upload resource identity", () => {
  const element = createCanvasAssetElement({
    asset: {
      id: "upload-element",
      resource_id: 42,
      type: "image",
      src: "/oss-proxy/private/image.jpg",
      source: "canvas_upload",
    },
    elementId: "image-42",
  });

  assert.equal(element.resourceId, "42");
  assert.equal(element.creationId, "");
});

test("generated creations retain their creation identity when added to canvas", () => {
  const element = createCanvasAssetElement({
    asset: {
      id: "creation-9",
      type: "video",
      preview_video_url: "https://media.example/video.mp4",
      preview_image_url: "https://media.example/poster.jpg",
    },
    elementId: "video-1",
    center: { x: 0, y: 0 },
  });

  assert.equal(element.creationId, "creation-9");
  assert.equal(element.source, "");
  assert.equal(element.src, "https://media.example/video.mp4");
  assert.equal(element.poster, "https://media.example/poster.jpg");
});

test("canvas file drops convert client coordinates into centered world coordinates", () => {
  assert.deepEqual(getCanvasDropPoint({
    clientX: 300,
    clientY: 250,
    rect: { left: 100, top: 50, width: 800, height: 600 },
    viewport: { x: 20, y: -10, scale: 2 },
    elementWidth: 320,
    elementHeight: 320,
  }), { x: -70, y: -55 });
});
