import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

process.env.LOG_DIR = "/tmp/stardraw-workflow-runtime-test-logs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") {
      return { shortCircuit: true, url: "workflow-runtime-test:db" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "workflow-runtime-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: [
          "const forbidden = () => { throw new Error('database access forbidden'); };",
          "forbidden.begin = forbidden;",
          "export default forbidden;",
        ].join("\n"),
      };
    }
    return nextLoad(url, context);
  },
});

const {
  createCanvasReadNodeHandler,
  createCanvasMediaNodeHandler,
  createWorkflowReferenceImageResolver,
  resolveWorkflowCanvasPlacement,
  resolveWorkflowNodeExecutionCosts,
} = await import("../services/workflowRuntimeComposition.js");
const {
  normalizeCanvasWorkflowDefinition,
} = await import("../modules/canvas-workflows/definitionService.js");

test("workflow canvas reads unwrap legacy serialized state into a structured object", async () => {
  const legacyState = JSON.stringify({
    schemaVersion: 2,
    viewport: { x: 12, y: 34, scale: 0.75 },
    elements: [{ id: "note-1", type: "text", text: "legacy" }],
  });
  const handler = createCanvasReadNodeHandler(async () => [{
    id: "canvas-1",
    title: "Legacy canvas",
    canvas_state: legacyState,
    created_at: new Date("2026-08-17T00:00:00.000Z"),
    updated_at: new Date("2026-08-17T00:01:00.000Z"),
  }]);

  const result = await handler({ userId: "owner-1", canvasId: "canvas-1" });

  assert.equal(typeof result.state, "object");
  assert.equal(result.state.viewport.scale, 0.75);
  assert.equal(result.state.elements[0].text, "legacy");
});

test("canvas media source nodes resolve only owned image or video elements", async () => {
  const sqlClient = async () => [{
    id: "canvas-1",
    canvas_state: {
      elements: [
        { id: "image-1", type: "image", title: "Poster", creationId: "creation-1", src: "https://oss.example.test/private-image" },
        { id: "video-1", type: "video", title: "Cut", resourceId: "42", src: "https://oss.example.test/private-video", poster: "https://oss.example.test/poster" },
      ],
    },
  }];
  const image = await createCanvasMediaNodeHandler(sqlClient, "image")({
    userId: "owner-1",
    canvasId: "canvas-1",
    config: { elementId: "image-1" },
  });
  assert.deepEqual(image, {
    kind: "canvas_media",
    mediaType: "image",
    elementId: "image-1",
    creationId: "creation-1",
    resourceId: "",
    referenceId: "creation-1",
    content: "https://oss.example.test/private-image",
    thumbnailUrl: "https://oss.example.test/private-image",
    title: "Poster",
    objectKey: "",
  });

  const video = await createCanvasMediaNodeHandler(sqlClient, "video")({
    userId: "owner-1",
    canvasId: "canvas-1",
    config: { elementId: "video-1" },
  });
  assert.equal(video.referenceId, "upload:42");
  assert.equal(video.mediaType, "video");
  await assert.rejects(
    createCanvasMediaNodeHandler(sqlClient, "image")({ userId: "owner-1", canvasId: "canvas-1", config: { elementId: "video-1" } }),
    (error) => error.code === "CANVAS_MEDIA_ELEMENT_NOT_FOUND" && error.status === 404,
  );
});

test("workflow media lands below its generating node and falls back to the persisted viewport", () => {
  assert.deepEqual(resolveWorkflowCanvasPlacement({
    state: { viewport: { x: -400, y: -240, scale: 2 } },
    nodePosition: { x: 500, y: 200 },
    width: 320,
    height: 320,
  }), { x: 454, y: 352 });

  assert.deepEqual(resolveWorkflowCanvasPlacement({
    state: { viewport: { x: -400, y: -240, scale: 2 } },
    width: 320,
    height: 320,
    index: 8,
  }), { x: 360, y: 140 });

  assert.deepEqual(resolveWorkflowCanvasPlacement({
    state: { viewport: { x: 0, y: 0, scale: 1 } },
    config: { canvasPosition: { x: 44, y: 88 } },
    width: 320,
    height: 320,
  }), { x: 44, y: 88 });
});

test("workflow reference uploads are resolved through an owner-scoped private upload record", async () => {
  const queries = [];
  const sqlClient = async (strings, ...values) => {
    queries.push({ text: strings.join("?"), values });
    return [{ object_key: "users/owner-1/canvas_image/reference.jpg", mime_type: "image/jpeg" }];
  };
  const downloads = [];
  const resolver = createWorkflowReferenceImageResolver(sqlClient, {
    downloadBuffer: async (objectKey) => {
      downloads.push(objectKey);
      return { buffer: Buffer.from("private-reference"), contentType: "image/jpeg" };
    },
  });

  const result = await resolver({ userId: "owner-1", creationId: "upload:42" });

  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /FROM user_content_uploads upload/);
  assert.match(queries[0].text, /upload\.user_id/);
  assert.match(queries[0].text, /content_recycle_entries/);
  assert.deepEqual(queries[0].values, ["42", "owner-1"]);
  assert.deepEqual(downloads, ["users/owner-1/canvas_image/reference.jpg"]);
  assert.equal(result[0].buffer.toString(), "private-reference");
});

test("workflow composition uses trusted templates and billing rules for estimates", async () => {
  const nodeTypes = [
    "image.generate",
    "video.generate",
    "agent.call",
    "script.optimize",
    "mcp.call",
  ];
  const definition = {
    nodes: nodeTypes.map((type, index) => ({
      id: `node-${index}`,
      type,
      pointsEstimate: 999,
      config: {
        provider: "untrusted",
        userId: "untrusted",
        sceneKey: type.includes("video") ? "freeform_video" : "freeform_image",
      },
    })),
  };
  const templateLookups = [];
  const chargeLookups = [];
  const sqlClient = async (strings, ...values) => {
    templateLookups.push(values);
    return [{
      target_provider: values[0] === "freeform_video" ? "video_provider" : "image_provider",
      default_model: values[0] === "freeform_video" ? "video-model" : "image-model",
      default_seconds: 8,
      default_size: "16:9",
    }];
  };
  const resolveChargeFn = async (input) => {
    chargeLookups.push(input);
    if (input.outputType === "video") return 150;
    if (input.sceneKey === "canvas_agent_plan") return 2;
    if (input.sceneKey === "digital_human_script_optimizer") return 1;
    return 16;
  };

  const costs = await resolveWorkflowNodeExecutionCosts(definition, {
    userId: "owner-1",
    sqlClient,
    resolveChargeFn,
  });

  assert.deepEqual([...costs.values()], [16, 150, 2, 1, 0]);
  assert.equal(templateLookups.length, 2);
  assert.equal(templateLookups[0][1], "owner-1");
  assert.equal(chargeLookups[0].provider, "image_provider");
  assert.equal(chargeLookups[1].provider, "video_provider");
});

test("workflow composition rejects unknown node types before execution", async () => {
  await assert.rejects(
    resolveWorkflowNodeExecutionCosts({ nodes: [{ id: "unknown", type: "unknown.execute" }] }),
    (error) => error.code === "WORKFLOW_NODE_TYPE_UNSUPPORTED" && error.status === 422,
  );
});

test("Canvas Agent workflow nodes preserve catalog-shaped fields as runtime config", () => {
  const normalized = normalizeCanvasWorkflowDefinition({
    schemaVersion: 2,
    nodes: [
      {
        id: "copywriter",
        type: "agent.call",
        fields: {
          model: "gpt-5.6-sol",
          prompt: "整理海报文案",
        },
      },
      {
        id: "poster",
        type: "image.generate",
        fields: {
          sceneKey: "agpt2_style_poster_layout_system",
          model: "gpt-image-2",
          size: "1024x1536",
          prompt: "${nodes.copywriter.content}",
        },
      },
    ],
    edges: [{ from: "copywriter", to: "poster" }],
  });

  assert.deepEqual(normalized.nodes[0].config, {
    model: "gpt-5.6-sol",
    prompt: "整理海报文案",
  });
  assert.deepEqual(normalized.nodes[1].config, {
    sceneKey: "agpt2_style_poster_layout_system",
    model: "gpt-image-2",
    size: "1024x1536",
    prompt: "${nodes.copywriter.content}",
  });
});

test("workflow normalization materializes dependency-only links as graph edges", () => {
  const normalized = normalizeCanvasWorkflowDefinition({
    nodes: [
      { id: "canvas-image", type: "canvas.image", config: { elementId: "image-1" } },
      { id: "poster", type: "image.generate", dependsOn: ["canvas-image"], config: { prompt: "Use the canvas image" } },
    ],
  });

  assert.deepEqual(normalized.edges, [{
    id: "canvas-image->poster",
    from: "canvas-image",
    to: "poster",
    branch: null,
  }]);
  assert.deepEqual(normalized.nodes[1].dependsOn, ["canvas-image"]);
});

test("workflow normalization preserves a dependency-only condition branch", () => {
  const normalized = normalizeCanvasWorkflowDefinition({
    nodes: [
      { id: "condition", type: "condition.rule" },
      {
        id: "poster",
        type: "image.generate",
        dependsOn: ["condition"],
        config: { when: { nodeKey: "condition", branch: "true" }, prompt: "Create poster" },
      },
    ],
  });

  assert.deepEqual(normalized.edges, [{
    id: "condition->poster:true",
    from: "condition",
    to: "poster",
    branch: "true",
  }]);
});
