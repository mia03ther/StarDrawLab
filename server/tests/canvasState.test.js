import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeConcurrentGeneratedCanvasMedia,
  normalizeCanvasState,
} from "../domain/canvas/canvasState.js";

test("canvas state round-trips rotation, prompts and owned media metadata", () => {
  const normalized = normalizeCanvasState({
    viewport: { x: 12, y: -34, scale: 1.25 },
    elements: [
      {
        id: "note-1",
        type: "text",
        x: 10,
        y: 20,
        width: 300,
        height: 180,
        rotation: 405,
        title: "Shot note",
        text: "Slow push in",
        background: "#112233",
        color: "#abcdef",
        fontSize: 20,
        source: "ai_generation_pending",
        groupId: "sequence-1",
      },
      {
        id: "image-1",
        type: "image",
        x: 40,
        y: 50,
        width: 640,
        height: 360,
        rotation: -725,
        title: "Opening frame",
        src: "/oss-proxy/quickai/user/image.png",
        creationId: "creation-12",
        source: "ai_generation",
        objectKey: "quickai/user/image.png",
        prompt: "Cinematic sunrise, 21:9",
        groupId: "sequence-1",
      },
      {
        id: "video-1",
        type: "video",
        src: "https://cdn.example.com/video.mp4?token=short-lived",
        poster: "https://cdn.example.com/poster.jpg",
        rotation: 15,
        prompt: "A slow dolly shot",
      },
    ],
  });

  assert.deepEqual(normalized.viewport, { x: 12, y: -34, scale: 1.25 });
  assert.equal(normalized.elements[0].rotation, 45);
  assert.equal(normalized.elements[0].source, "ai_generation_pending");
  assert.equal(normalized.elements[1].rotation, -5);
  assert.equal(normalized.elements[1].prompt, "Cinematic sunrise, 21:9");
  assert.equal(normalized.elements[1].creationId, "creation-12");
  assert.equal(normalized.elements[1].objectKey, "quickai/user/image.png");
  assert.equal(normalized.elements[2].prompt, "A slow dolly shot");
  assert.equal(normalized.elements[2].poster, "https://cdn.example.com/poster.jpg");
});

test("canvas state preserves private audio elements for timeline sources", () => {
  const normalized = normalizeCanvasState({
    elements: [{
      id: "audio-1",
      type: "audio",
      src: "/oss-proxy/user/audio.mp3",
      objectKey: "quickai/user/audio.mp3",
      width: 420,
      height: 130,
    }],
  });
  assert.equal(normalized.elements[0].type, "audio");
  assert.equal(normalized.elements[0].src, "/oss-proxy/user/audio.mp3");
  assert.equal(normalized.elements[0].height, 130);
  assert.equal(normalized.elements[0].objectKey, "quickai/user/audio.mp3");
});

test("canvas state accepts legacy media URL aliases without preserving arbitrary fields", () => {
  const normalized = normalizeCanvasState(JSON.stringify({
    elements: [{
      id: "legacy-image",
      type: "image",
      content: "/oss-proxy/legacy/image.png",
      thumbnail_url: "/oss-proxy/legacy/thumb.png",
      onclick: "alert(1)",
      html: "<script>alert(1)</script>",
      nested: { secret: "must-not-persist" },
    }],
  }));

  assert.equal(normalized.elements[0].src, "/oss-proxy/legacy/image.png");
  assert.equal(normalized.elements[0].poster, "/oss-proxy/legacy/thumb.png");
  assert.equal(Object.hasOwn(normalized.elements[0], "onclick"), false);
  assert.equal(Object.hasOwn(normalized.elements[0], "html"), false);
  assert.equal(Object.hasOwn(normalized.elements[0], "nested"), false);
});

test("canvas state preserves legacy media ownership aliases for Agent reference loading", () => {
  const normalized = normalizeCanvasState({
    elements: [{
      id: "uploaded-image",
      type: "image",
      creation_id: "creation-legacy",
      resource_id: "42",
      object_key: "private/user/upload.jpg",
    }],
  });

  assert.equal(normalized.elements[0].creationId, "creation-legacy");
  assert.equal(normalized.elements[0].resourceId, "42");
  assert.equal(normalized.elements[0].objectKey, "private/user/upload.jpg");
});

test("canvas state rejects active URL schemes, protocol-relative URLs and unsafe object keys", () => {
  const elements = normalizeCanvasState({
    elements: [
      { type: "image", src: "javascript:alert(1)", objectKey: "../secret" },
      { type: "image", src: "data:text/html,<script>alert(1)</script>", objectKey: "folder%2Fsecret" },
      { type: "video", src: "//tracker.example/video.mp4", poster: "https://user:pass@example.com/poster.jpg" },
    ],
  }).elements;

  for (const element of elements) assert.equal(element.src, "");
  assert.equal(elements[0].objectKey, "");
  assert.equal(elements[1].objectKey, "");
  assert.equal(elements[2].poster, "");
});

test("canvas state keeps bounded values and remains compatible with empty legacy states", () => {
  const normalized = normalizeCanvasState({
    viewport: { x: Number.POSITIVE_INFINITY, y: -2_000_000_000, scale: 0 },
    elements: [{
      type: "text",
      width: 1,
      height: Number.NaN,
      rotation: Number.NaN,
      text: "x".repeat(5000),
      prompt: "not a text element field",
      groupId: "orphan-group",
    }],
  });

  assert.deepEqual(normalized.viewport, { x: 0, y: -1_000_000_000, scale: 0.05 });
  assert.equal(normalized.elements[0].width, 180);
  assert.equal(normalized.elements[0].height, 220);
  assert.equal(normalized.elements[0].rotation, 0);
  assert.equal(normalized.elements[0].text.length, 4000);
  assert.equal(normalized.elements[0].groupId, "");
  assert.equal(Object.hasOwn(normalized.elements[0], "prompt"), false);
  assert.deepEqual(normalizeCanvasState(null), {
    schemaVersion: 2,
    viewport: { x: 0, y: 0, scale: 1 },
    elements: [],
    background: { mode: "grid" },
    workflow: { version: 1, nodes: [], edges: [] },
    storyboard: { shots: [] },
    timeline: { fps: 30, tracks: [] },
    director3d: {
      enabled: false,
      scene: "",
      camera: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        focalLength: 50,
      },
      lighting: "",
      environment: "",
    },
  });
});

test("canvas state provides a bounded mixed-canvas project model", () => {
  const normalized = normalizeCanvasState({
    workflow: {
      nodes: [
        { id: "input", type: "input", x: 10, y: 20, label: "Input" },
        {
          id: "generate",
          type: "image.generate",
          prompt: "A wide shot",
          sceneKey: "freeform_image",
          model: "nano-banana-2",
          tool: "media.generate.image",
          pointsEstimate: 16,
          dependsOn: ["input", "missing", "generate"],
          config: {
            sceneKey: "freeform_image",
            provider: "image_provider",
            nested: { arguments: ["one", 2, true] },
            nonFinite: Number.POSITIVE_INFINITY,
          },
        },
      ],
      edges: [{ id: "input-edge", from: "input", to: "generate" }, { from: "missing", to: "generate" }],
    },
    storyboard: { shots: [{ id: "shot-1", title: "Opening", description: "A quiet opening", duration: 8, camera: "dolly" }] },
    timeline: { fps: 24, tracks: [{ id: "v1", type: "video", clips: [{ assetId: "asset-1", start: 0, duration: 8, speed: 1.25 }] }] },
    director3d: { enabled: true, scene: "studio", camera: { focalLength: 35 } },
  });

  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.workflow.nodes.length, 2);
  assert.deepEqual(normalized.workflow.edges, [{ id: "input-edge", from: "input", to: "generate" }]);
  assert.deepEqual(normalized.workflow.nodes[1].dependsOn, ["input"]);
  assert.equal(normalized.workflow.nodes[1].sceneKey, "freeform_image");
  assert.equal(normalized.workflow.nodes[1].pointsEstimate, 16);
  assert.equal(normalized.workflow.nodes[1].tool, "media.generate.image");
  assert.deepEqual(normalized.workflow.nodes[1].config.nested.arguments, ["one", 2, true]);
  assert.equal(normalized.workflow.nodes[1].config.nonFinite, null);
  assert.equal(normalized.storyboard.shots[0].duration, 8);
  assert.equal(normalized.storyboard.shots[0].description, "A quiet opening");
  assert.equal(normalized.storyboard.shots[0].camera, "dolly");
  assert.equal(normalized.timeline.fps, 24);
  assert.equal(normalized.timeline.tracks[0].clips[0].speed, 1.25);
  assert.equal(normalized.director3d.camera.focalLength, 35);
});

test("stale canvas saves preserve media inserted concurrently by Agent and workflow runtimes", () => {
  const merged = mergeConcurrentGeneratedCanvasMedia({
    currentState: {
      elements: [
        { id: "note-1", type: "text", text: "server note" },
        {
          id: "agent-media-286",
          type: "video",
          creationId: "286",
          src: "/oss-proxy/video-286.mp4",
          source: "canvas_agent_generation",
        },
        {
          id: "workflow-media-287",
          type: "image",
          creationId: "287",
          src: "/oss-proxy/image-287.png",
          source: "workflow_generation",
        },
      ],
    },
    incomingState: {
      elements: [{ id: "note-1", type: "text", text: "client edit" }],
    },
    baseUpdatedAt: "2026-08-18T00:00:00.000Z",
    currentUpdatedAt: "2026-08-18T00:01:00.000Z",
    deletedElementIds: [],
  });

  assert.equal(merged.concurrent, true);
  assert.deepEqual(merged.preservedElementIds, ["agent-media-286", "workflow-media-287"]);
  assert.equal(merged.state.elements.length, 3);
  assert.equal(merged.state.elements[0].text, "client edit");
  assert.deepEqual(merged.state.elements.slice(1).map((element) => element.creationId), ["286", "287"]);
});

test("current canvas saves and explicit deletions do not resurrect generated media", () => {
  const currentState = {
    elements: [{
      id: "agent-media-286",
      type: "video",
      creationId: "286",
      src: "/oss-proxy/video-286.mp4",
      source: "canvas_agent_generation",
    }],
  };
  const currentSave = mergeConcurrentGeneratedCanvasMedia({
    currentState,
    incomingState: { elements: [] },
    baseUpdatedAt: "2026-08-18T00:01:00.000Z",
    currentUpdatedAt: "2026-08-18T00:01:00.000Z",
  });
  const explicitDelete = mergeConcurrentGeneratedCanvasMedia({
    currentState,
    incomingState: { elements: [] },
    baseUpdatedAt: "2026-08-18T00:00:00.000Z",
    currentUpdatedAt: "2026-08-18T00:01:00.000Z",
    deletedElementIds: ["agent-media-286"],
  });

  assert.equal(currentSave.state.elements.length, 0);
  assert.equal(explicitDelete.state.elements.length, 0);
});
