import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";

import express from "express";

const MOCKS = new Map([
  ["../controllers/canvasController.js", "canvas-stream-test:controller"],
  ["../configs/multer.js", "canvas-stream-test:multer"],
  ["../configs/db.js", "canvas-stream-test:db"],
  ["../configs/logger.js", "canvas-stream-test:logger"],
  ["../services/objectStorageComposition.js", "canvas-stream-test:object-storage"],
  ["../services/userOperationService.js", "canvas-stream-test:user-operation"],
  ["../infrastructure/stagedObjectUpload.js", "canvas-stream-test:staged-upload"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/routes/canvasRoutes.js") && MOCKS.has(specifier)) {
      return { shortCircuit: true, url: MOCKS.get(specifier) };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "canvas-stream-test:controller") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const noop = (_req, res) => res.json({ success: true });
          export const listCanvases = noop;
          export const createCanvas = noop;
          export const getCanvas = noop;
          export const updateCanvas = noop;
          export const deleteCanvas = noop;
          export const uploadCanvasAsset = (_req, res) => res.status(418).json({ success: false, message: "legacy buffer handler used" });
        `,
      };
    }
    if (url === "canvas-stream-test:multer") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const uploadPreview = {
            single: () => (req, _res, next) => {
              req.file = globalThis.__canvasStreamRouteTest.file;
              req.body = { type: "video" };
              next();
            },
          };
        `,
      };
    }
    if (url === "canvas-stream-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sql = async (strings) => String.raw({ raw: strings }) .includes("INSERT INTO user_content_uploads")
            ? [{ id: "upload-record-1" }]
            : [];
          sql.json = (value) => value;
          export default sql;
        `,
      };
    }
    if (url === "canvas-stream-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, info() {}, warn() {} };" };
    }
    if (url === "canvas-stream-test:object-storage") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const getObjectStorage = () => ({
            buildObjectKey: () => "quickai/u1/canvas_video.mp4",
            deleteObject: async () => {},
          });
        `,
      };
    }
    if (url === "canvas-stream-test:user-operation") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import sql from "canvas-stream-test:db";
          export const executeUserOperation = async ({ mutate }) => mutate(sql);
        `,
      };
    }
    if (url === "canvas-stream-test:staged-upload") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const uploadStagedMedia = async ({ file, objectKey, contentType }) => {
            globalThis.__canvasStreamRouteTest.upload = {
              storage: file.storage,
              hasBuffer: Boolean(file.buffer),
              objectKey,
              contentType,
            };
            return { objectKey, url: "/oss-proxy/quickai/u1/canvas_video.mp4" };
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const state = { file: null, upload: null };
globalThis.__canvasStreamRouteTest = state;

const { default: canvasRouter } = await import("../routes/canvasRoutes.js");

test("canvas video upload preserves the endpoint response while streaming from a staged file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardraw-canvas-route-test-"));
  const filePath = path.join(root, "clip.mp4");
  await writeFile(filePath, "video-content", { mode: 0o600 });
  state.file = {
    fieldname: "asset",
    originalname: "clip.mp4",
    mimetype: "video/mp4",
    mediaKind: "video",
    validatedExtension: ".mp4",
    storage: "temporary",
    path: filePath,
    size: 13,
    sha256: "c".repeat(64),
  };
  state.upload = null;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { userId: "u1", role: "user" };
    next();
  });
  app.use("/canvas", canvasRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/canvas/assets`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-idempotency-key": "canvas-upload-1" },
    body: "{}",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.type, "video");
  assert.equal(payload.data.resource_id, "upload-record-1");
  assert.deepEqual(state.upload, {
    storage: "temporary",
    hasBuffer: false,
    objectKey: "quickai/u1/canvas_video.mp4",
    contentType: "video/mp4",
  });
});
