import assert from "node:assert/strict";
import test from "node:test";

import {
  getObjectStorage,
  resetObjectStorage,
  setObjectStorageForTests,
} from "../services/objectStorageComposition.js";

test("object storage runtime keeps a stable seam while adapters are replaceable", async () => {
  const calls = [];
  const fake = {
    buildObjectKey: (...args) => { calls.push(["build", ...args]); return "bucket/key.png"; },
    uploadBuffer: async (...args) => { calls.push(["buffer", ...args]); return { objectKey: args[1], url: "/asset" }; },
    uploadFromUrl: async (...args) => { calls.push(["remote", ...args]); return { objectKey: args[1], url: "/asset" }; },
    getObjectMetadata: async (...args) => { calls.push(["metadata", ...args]); return { exists: true, sizeBytes: 1, contentType: "image/png" }; },
    downloadBuffer: async (...args) => { calls.push(["download", ...args]); return { buffer: Buffer.from("x"), contentType: "image/png" }; },
    deleteObject: async (...args) => { calls.push(["delete", ...args]); },
    deleteObjectsStrict: async (...args) => { calls.push(["deleteMany", ...args]); },
    getSignedDownloadUrl: (...args) => { calls.push(["sign", ...args]); return "https://signed.invalid/object"; },
  };
  const runtimeBefore = getObjectStorage();

  try {
    const runtimeAfter = setObjectStorageForTests(fake);
    assert.equal(runtimeAfter, runtimeBefore);
    assert.equal(runtimeBefore.buildObjectKey("u1", "image", "png"), "bucket/key.png");
    assert.deepEqual(
      await runtimeBefore.uploadBuffer(Buffer.from("x"), "bucket/key.png", "image/png"),
      { objectKey: "bucket/key.png", url: "/asset" },
    );
    assert.deepEqual(await runtimeBefore.getObjectMetadata("bucket/key.png"), { exists: true, sizeBytes: 1, contentType: "image/png" });
    assert.equal((await runtimeBefore.downloadBuffer("bucket/key.png")).contentType, "image/png");
    assert.equal(runtimeBefore.getSignedDownloadUrl("bucket/key.png", 60, "snapshot"), "https://signed.invalid/object");
    assert.deepEqual(calls.map(([name]) => name), ["build", "buffer", "metadata", "download", "sign"]);
  } finally {
    resetObjectStorage();
  }
});

test("object storage composition rejects shallow incomplete adapters", () => {
  assert.throws(() => setObjectStorageForTests({}), /requires buildObjectKey/);
});
