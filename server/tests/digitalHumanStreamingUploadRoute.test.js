import assert from "node:assert/strict";
import http from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";

import express from "express";

const MOCKS = new Map([
  ["../controllers/digitalHumanRoleController.js", "digital-stream-test:controller"],
  ["../controllers/contentRecycleController.js", "digital-stream-test:recycle"],
  ["../infrastructure/safeMultipartUpload.js", "digital-stream-test:multipart"],
  ["../infrastructure/stagedObjectUpload.js", "digital-stream-test:staged-upload"],
  ["../configs/db.js", "digital-stream-test:db"],
  ["../configs/logger.js", "digital-stream-test:logger"],
  ["../services/objectStorageComposition.js", "digital-stream-test:object-storage"],
  ["../services/userOperationService.js", "digital-stream-test:user-operation"],
  ["../services/resourceAccessService.js", "digital-stream-test:resource-access"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/routes/digitalHumanRoleRoutes.js") && MOCKS.has(specifier)) {
      return { shortCircuit: true, url: MOCKS.get(specifier) };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "digital-stream-test:controller") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const noop = (_req, res) => res.json({ success: true });
          export const listDigitalHumanRoles = noop;
          export const createDigitalHumanRole = noop;
          export const getDigitalHumanRoleByToken = noop;
          export const uploadDigitalHumanRoleAsset = (_req, res) => res.status(418).json({ message: "legacy private handler used" });
          export const completeDigitalHumanRoleCapture = (_req, res) => res.status(418).json({ message: "legacy capture handler used" });
        `,
      };
    }
    if (url === "digital-stream-test:recycle") {
      return { format: "module", shortCircuit: true, source: "export const deleteOwnContentController = (_req, res) => res.json({ success: true });" };
    }
    if (url === "digital-stream-test:multipart") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const DEFAULT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
          export const DEFAULT_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
          export const createSafeMediaUpload = () => ({
            single: () => (req, _res, next) => {
              req.file = globalThis.__digitalStreamRouteTest.file;
              req.body = { kind: "video" };
              next();
            },
          });
          export const attachTemporaryUploadCleanup = (_req, _res, next) => next();
        `,
      };
    }
    if (url === "digital-stream-test:staged-upload") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const uploadStagedMedia = async ({ file, objectKey, contentType }) => {
            globalThis.__digitalStreamRouteTest.upload = {
              storage: file.storage,
              hasBuffer: Boolean(file.buffer),
              objectKey,
              contentType,
            };
            return { objectKey, url: "/oss-proxy/" + objectKey };
          };
        `,
      };
    }
    if (url === "digital-stream-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const role = {
            id: "role-1", user_id: "u1", role_name: "Actor", status: "training",
            demo_video_url: null, demo_video_object_key: null, avatar_url: null,
            avatar_object_key: null, ready_at: null, meta_info: {}, created_at: "now", updated_at: "now",
            qr_token: "dh_" + "a".repeat(43),
          };
          const sql = async (strings) => {
            const query = strings.join(" ");
            if (query.includes("SELECT * FROM digital_human_roles")) return [role];
            if (query.includes("SET qr_token_claimed_at = NOW()")) return [role];
            if (query.includes("UPDATE digital_human_roles") && query.includes("demo_video_url")) {
              return [{ ...role, demo_video_url: "/oss-proxy/digital.mp4", demo_video_object_key: "quickai/u1/digital.mp4" }];
            }
            return [];
          };
          sql.json = (value) => value;
          export default sql;
        `,
      };
    }
    if (url === "digital-stream-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, info() {}, warn() {} };" };
    }
    if (url === "digital-stream-test:object-storage") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const getObjectStorage = () => ({
            buildObjectKey: () => "quickai/u1/digital.mp4",
            deleteObject: async () => {},
          });
        `,
      };
    }
    if (url === "digital-stream-test:user-operation") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import sql from "digital-stream-test:db";
          export const executeUserOperation = async ({ mutate }) => mutate(sql);
        `,
      };
    }
    if (url === "digital-stream-test:resource-access") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const buildGrantedProxyUrl = ({ objectKey }) => '/oss-proxy/' + objectKey + '?grant=test';",
      };
    }
    return nextLoad(url, context);
  },
});

const state = {
  file: {
    fieldname: "asset",
    originalname: "actor.mp4",
    mimetype: "video/mp4",
    mediaKind: "video",
    validatedExtension: ".mp4",
    storage: "temporary",
    path: "/tmp/staged-actor.mp4",
    size: 13,
    sha256: "d".repeat(64),
  },
  upload: null,
};
globalThis.__digitalStreamRouteTest = state;

const {
  default: roleRouter,
  publicDigitalHumanRoleRouter,
} = await import("../routes/digitalHumanRoleRoutes.js");

test("digital-human video assets preserve the private API response while using staged streaming", async (t) => {
  state.upload = null;
  const app = express();
  app.use((req, _res, next) => {
    req.auth = { userId: "u1", role: "user" };
    next();
  });
  app.use("/digital-human", roleRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/digital-human/roles/role-1/assets`, {
    method: "POST",
    headers: { "x-idempotency-key": "digital-upload-1" },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.id, "role-1");
  assert.equal(payload.data.status, "training");
  assert.deepEqual(state.upload, {
    storage: "temporary",
    hasBuffer: false,
    objectKey: "quickai/u1/digital.mp4",
    contentType: "video/mp4",
  });
});

test("public digital-human capture streams video and preserves the one-time capture response", async (t) => {
  state.upload = null;
  const app = express();
  app.use("/public", publicDigitalHumanRoleRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const token = `dh_${"a".repeat(43)}`;
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/public/capture/${token}`, { method: "POST" });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(payload.data.role_name, "Actor");
  assert.equal(payload.data.status, "training");
  assert.deepEqual(state.upload, {
    storage: "temporary",
    hasBuffer: false,
    objectKey: "quickai/u1/digital.mp4",
    contentType: "video/mp4",
  });
});
