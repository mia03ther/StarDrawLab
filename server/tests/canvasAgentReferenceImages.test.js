import assert from "node:assert/strict";
import test from "node:test";

import { loadCanvasAgentReferenceImages } from "../modules/canvas-agent/toolRegistry.js";

const taggedDb = async (strings, ...values) => {
  const statement = strings.join("?");
  if (statement.includes("FROM canvases")) {
    return [{
      id: "canvas-1",
      title: "Canvas",
      canvas_state: {
        elements: [
          { id: "generated", type: "image", creationId: "creation-1", src: "https://untrusted.example/generated.jpg" },
          { id: "uploaded", type: "image", objectKey: "private/user/upload.jpg", src: "https://untrusted.example/upload.jpg" },
        ],
      },
      updated_at: new Date(),
    }];
  }
  if (statement.includes("FROM creations")) {
    assert.equal(values[0], "user-1");
    return [{ id: "creation-1", content_object_key: "private/user/generated.jpg" }];
  }
  if (statement.includes("FROM user_content_uploads")) {
    assert.equal(values[0], "user-1");
    return [{ id: 9, object_key: "private/user/upload.jpg" }];
  }
  throw new Error(`Unexpected SQL: ${statement}`);
};

test("Canvas Agent reloads selected image identities from the owned canvas and private storage records", async () => {
  const downloaded = [];
  const references = await loadCanvasAgentReferenceImages({
    userId: "user-1",
    canvasId: "canvas-1",
    elementIds: ["generated", "uploaded"],
    db: taggedDb,
    storage: {
      downloadBuffer: async (objectKey) => {
        downloaded.push(objectKey);
        return { buffer: Buffer.from(objectKey), contentType: "image/jpeg" };
      },
    },
  });

  assert.deepEqual(downloaded, ["private/user/generated.jpg", "private/user/upload.jpg"]);
  assert.equal(references.length, 2);
  assert.deepEqual(references.map((item) => item.mimetype), ["image/jpeg", "image/jpeg"]);
});

test("Canvas Agent rejects a canvas image that has only a browser URL", async () => {
  const db = async (strings) => {
    const statement = strings.join("?");
    if (statement.includes("FROM canvases")) {
      return [{ id: "canvas-1", title: "Canvas", canvas_state: { elements: [{ id: "external", type: "image", src: "https://attacker.example/image.jpg" }] } }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  };

  await assert.rejects(
    loadCanvasAgentReferenceImages({ userId: "user-1", canvasId: "canvas-1", elementIds: ["external"], db, storage: {} }),
    (error) => error.code === "REFERENCE_IMAGE_UNTRUSTED" && error.status === 422,
  );
});

test("Canvas Agent resolves an uploaded canvas image through resourceId", async () => {
  const downloaded = [];
  const db = async (strings, ...values) => {
    const statement = strings.join("?");
    if (statement.includes("FROM canvases")) {
      return [{
        id: "canvas-1",
        title: "Canvas",
        canvas_state: {
          elements: [{
            id: "uploaded",
            type: "image",
            source: "canvas_upload",
            resourceId: "42",
            src: "/oss-proxy/private/user/upload.jpg",
          }],
        },
      }];
    }
    if (statement.includes("FROM user_content_uploads")) {
      assert.equal(values[0], "user-1");
      return [{ id: 42, object_key: "private/user/upload.jpg", mime_type: "image/png" }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  };

  const references = await loadCanvasAgentReferenceImages({
    userId: "user-1",
    canvasId: "canvas-1",
    elementIds: ["uploaded"],
    db,
    storage: {
      downloadBuffer: async (objectKey) => {
        downloaded.push(objectKey);
        return { buffer: Buffer.from("uploaded-reference"), contentType: "image/png" };
      },
    },
  });

  assert.deepEqual(downloaded, ["private/user/upload.jpg"]);
  assert.equal(references[0].mimetype, "image/png");
});

test("Canvas Agent falls back from a stale creationId to the owned upload resource", async () => {
  const db = async (strings, ...values) => {
    const statement = strings.join("?");
    if (statement.includes("FROM canvases")) {
      return [{
        id: "canvas-1",
        canvas_state: {
          elements: [{
            id: "uploaded",
            type: "image",
            creationId: "stale-creation",
            resourceId: "42",
            objectKey: "private/user/upload.jpg",
          }],
        },
      }];
    }
    if (statement.includes("FROM creations")) return [];
    if (statement.includes("FROM user_content_uploads")) {
      assert.equal(values[0], "user-1");
      return [{ id: 42, object_key: "private/user/upload.jpg", mime_type: "image/jpeg" }];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  };

  const references = await loadCanvasAgentReferenceImages({
    userId: "user-1",
    canvasId: "canvas-1",
    elementIds: ["uploaded"],
    db,
    storage: { downloadBuffer: async () => ({ buffer: Buffer.from("reference"), contentType: "image/jpeg" }) },
  });

  assert.equal(references.length, 1);
  assert.equal(references[0].buffer.toString(), "reference");
});

test("Canvas Agent rejects an uploaded reference that is in the recycle bin", async () => {
  const db = async (strings) => {
    const statement = strings.join("?");
    if (statement.includes("FROM canvases")) {
      return [{ id: "canvas-1", canvas_state: { elements: [{ id: "uploaded", type: "image", resourceId: "42" }] } }];
    }
    if (statement.includes("FROM user_content_uploads")) return [];
    throw new Error(`Unexpected SQL: ${statement}`);
  };

  await assert.rejects(
    loadCanvasAgentReferenceImages({ userId: "user-1", canvasId: "canvas-1", elementIds: ["uploaded"], db, storage: {} }),
    (error) => error.code === "REFERENCE_IMAGE_UNAVAILABLE" && error.status === 404,
  );
});
