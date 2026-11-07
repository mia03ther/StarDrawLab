import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import {
  attachTemporaryUploadCleanup,
  createSafeMediaUpload,
  purgeStaleTemporaryUploads,
} from "../infrastructure/safeMultipartUpload.js";

const listen = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
};

const postFile = async ({ url, bytes, filename, type }) => {
  const body = new FormData();
  body.append("asset", new Blob([bytes], { type }), filename);
  return fetch(`${url}/upload`, { method: "POST", body });
};

const createUploadApp = ({ tempRoot, imageMaxBytes = 16, mediaMaxBytes = 64, failHandler = false }) => {
  const app = express();
  const upload = createSafeMediaUpload({
    tempRoot,
    imageMaxBytes,
    videoMaxBytes: mediaMaxBytes,
    audioMaxBytes: mediaMaxBytes,
    files: 1,
  });

  app.post(
    "/upload",
    upload.single("asset"),
    attachTemporaryUploadCleanup,
    (req, res) => {
      if (failHandler) throw new Error("handler failed");
      res.json({
        storage: req.file.storage,
        path: req.file.path || null,
        hasBuffer: Buffer.isBuffer(req.file.buffer),
        kind: req.file.mediaKind,
        size: req.file.size,
      });
    },
  );
  app.use((error, _req, res, _next) => {
    res.status(error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500)).json({
      code: error.code || "UPLOAD_ERROR",
      message: error.message,
    });
  });
  return app;
};

const pathExists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const waitForRemoval = async (filePath) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!await pathExists(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`temporary upload still exists: ${filePath}`);
};

test("small images remain memory-backed for existing image handlers", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-test-"));
  const server = await listen(createUploadApp({ tempRoot }));
  t.after(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await postFile({
    url: server.url,
    bytes: Buffer.from("png-image"),
    filename: "preview.png",
    type: "image/png",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    storage: "memory",
    path: null,
    hasBuffer: true,
    kind: "image",
    size: 9,
  });
});

test("an image MIME with a non-image extension is rejected", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-test-"));
  const server = await listen(createUploadApp({ tempRoot }));
  t.after(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await postFile({
    url: server.url,
    bytes: Buffer.from("not-an-image"),
    filename: "preview.exe",
    type: "image/png",
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_UPLOAD_TYPE");
});

test("images exceeding their lower per-kind limit are rejected", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-test-"));
  const server = await listen(createUploadApp({ tempRoot, imageMaxBytes: 8 }));
  t.after(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await postFile({
    url: server.url,
    bytes: Buffer.alloc(9, 1),
    filename: "preview.png",
    type: "image/png",
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "LIMIT_FILE_SIZE");
});

test("videos use a temporary file and it is removed after a successful response", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-test-"));
  const server = await listen(createUploadApp({ tempRoot }));
  t.after(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await postFile({
    url: server.url,
    bytes: Buffer.alloc(32, 2),
    filename: "preview.mp4",
    type: "video/mp4",
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.storage, "temporary");
  assert.equal(payload.hasBuffer, false);
  assert.equal(payload.kind, "video");
  assert.equal(payload.size, 32);
  await waitForRemoval(payload.path);
});

test("temporary files are removed when the route handler fails", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-test-"));
  let stagedPath;
  const app = createUploadApp({ tempRoot, failHandler: true });
  app.use((req, _res, next) => {
    stagedPath = req.file?.path || stagedPath;
    next();
  });
  const server = await listen(app);
  t.after(async () => {
    await server.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const response = await postFile({
    url: server.url,
    bytes: Buffer.alloc(32, 3),
    filename: "preview.mp4",
    type: "video/mp4",
  });

  assert.equal(response.status, 500);
  const candidates = (await import("node:fs/promises")).readdir(tempRoot).then((names) => names.map((name) => path.join(tempRoot, name)));
  for (const candidate of await candidates) await waitForRemoval(candidate);
  if (stagedPath) await waitForRemoval(stagedPath);
});

test("startup cleanup removes only stale files and unexpected symlinks", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "stardraw-upload-purge-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const stale = path.join(tempRoot, "stale.mp4");
  const fresh = path.join(tempRoot, "fresh.mp4");
  const link = path.join(tempRoot, "unexpected-link.mp4");
  await writeFile(stale, "stale");
  await writeFile(fresh, "fresh");
  await symlink(fresh, link);
  await utimes(stale, new Date(1_000), new Date(1_000));
  await utimes(fresh, new Date(100_000), new Date(100_000));

  assert.deepEqual(await purgeStaleTemporaryUploads({
    tempRoot,
    maxAgeMs: 60_000,
    now: 120_000,
  }), { scanned: 3, removed: 2 });
  assert.equal(await pathExists(stale), false);
  assert.equal(await pathExists(link), false);
  assert.equal(await pathExists(fresh), true);
});
