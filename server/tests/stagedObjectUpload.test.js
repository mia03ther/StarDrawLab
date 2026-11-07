import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { uploadStagedMedia } from "../infrastructure/stagedObjectUpload.js";

test("memory-backed images keep using the object-storage buffer interface", async () => {
  const calls = [];
  const objectStorage = {
    uploadBuffer: async (...args) => {
      calls.push(args);
      return { objectKey: args[1], url: "/oss-proxy/image.png" };
    },
  };

  const result = await uploadStagedMedia({
    file: { buffer: Buffer.from("image"), size: 5, storage: "memory" },
    objectKey: "users/u1/image.png",
    contentType: "image/png",
    objectStorage,
  });

  assert.equal(result.url, "/oss-proxy/image.png");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].toString(), "image");
});

test("temporary videos are uploaded as a bounded stream instead of a Buffer", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardraw-staged-upload-test-"));
  const filePath = path.join(root, "video.mp4");
  await writeFile(filePath, Buffer.from("video-content"), { mode: 0o600 });
  t.after(() => rm(root, { recursive: true, force: true }));

  let received;
  const result = await uploadStagedMedia({
    file: { path: filePath, size: 13, storage: "temporary" },
    objectKey: "users/u1/video.mp4",
    contentType: "video/mp4",
    objectStorage: {
      uploadBuffer: async () => assert.fail("temporary files must not use uploadBuffer"),
    },
    streamUploader: async (input) => {
      const chunks = [];
      for await (const chunk of input.stream) chunks.push(chunk);
      received = { ...input, stream: undefined, content: Buffer.concat(chunks).toString() };
      return { objectKey: input.objectKey, url: "/oss-proxy/video.mp4" };
    },
  });

  assert.equal(result.url, "/oss-proxy/video.mp4");
  assert.deepEqual(received, {
    stream: undefined,
    objectKey: "users/u1/video.mp4",
    contentType: "video/mp4",
    contentLength: 13,
    content: "video-content",
  });
});

test("temporary uploads reject symlinks before opening the file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stardraw-staged-upload-test-"));
  const target = path.join(root, "target.mp4");
  const link = path.join(root, "link.mp4");
  await writeFile(target, "video");
  const { symlink } = await import("node:fs/promises");
  await symlink(target, link);
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(() => uploadStagedMedia({
    file: { path: link, size: 5, storage: "temporary" },
    objectKey: "users/u1/video.mp4",
    contentType: "video/mp4",
    objectStorage: { uploadBuffer: async () => ({}) },
    streamUploader: async () => ({}),
  }), /regular temporary file/);
});
