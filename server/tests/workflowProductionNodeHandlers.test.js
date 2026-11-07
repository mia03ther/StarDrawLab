import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorkflowProductionNodeHandlers,
  resolveWorkflowProductionNodeCost,
  WorkflowProductionNodeHandlerModule,
} from "../services/workflowProductionNodeHandlers.js";

const makeModule = (overrides = {}) => {
  const calls = [];
  const generation = {
    async generateImage(input) {
      calls.push(["image", input]);
      return { kind: "completed", creationId: "image-1", pointsCharged: 7 };
    },
    async generateVideo(input) {
      calls.push(["video", input]);
      return { kind: "submitted", creationId: "video-1", pointsReserved: 12 };
    },
    ...overrides.generation,
  };
  const creativeAgent = {
    async planCanvas(input) {
      calls.push(["agent-provider", input]);
      return { actions: [{ type: "add_note" }] };
    },
    async optimizeDigitalHumanScript(input) {
      calls.push(["script-provider", input]);
      return { optimized: "better" };
    },
    ...overrides.creativeAgent,
  };
  const executeMetered = overrides.executeMetered || (async (input) => {
    calls.push(["metered", input]);
    const result = await input.invoke({ route: { id: "route-1" } });
    return { operationId: `operation-${calls.length}`, pointsCost: 3, replayed: false, result };
  });
  const mcp = {
    async callTool(input) {
      calls.push(["mcp", input]);
      return { toolName: input.toolName, result: { ok: true } };
    },
    ...overrides.mcp,
  };
  const dependencies = {
    generationApplicationFactory: () => generation,
    creativeAgentFactory: () => creativeAgent,
    executeMeteredAgentOperation: executeMetered,
    mcpRuntimeFactory: () => mcp,
    videoResultResolver: overrides.videoResultResolver,
    referenceImageResolver: overrides.referenceImageResolver,
    canvasResultWriter: overrides.canvasResultWriter,
  };
  return {
    calls,
    dependencies,
    module: new WorkflowProductionNodeHandlerModule(dependencies),
  };
};

const context = (nodeType, config = {}) => ({
  userId: "run-owner",
  runId: "run-17",
  nodeKey: nodeType.replaceAll(".", "-"),
  nodeType,
  canvasId: "canvas-9",
  config: { userId: "config-attacker", user_id: "config-attacker", ...config },
});

test("workflow production handler map routes all supported node types through application modules", async () => {
  const { calls, dependencies } = makeModule();
  const handlers = createWorkflowProductionNodeHandlers(dependencies);

  await handlers.get("image.generate")(context("image.generate", { sceneKey: "freeform_image", prompt: "draw" }));
  await handlers.get("video.generate")(context("video.generate", { sceneKey: "freeform_video", prompt: "move", seconds: 8 }));
  await handlers.get("agent.call")(context("agent.call", { prompt: "arrange", canvas: { id: "config-canvas", state: { elements: [] } } }));
  await handlers.get("script.optimize")(context("script.optimize", { prompt: "rough script", durationSeconds: 45 }));
  await handlers.get("mcp.call")(context("mcp.call", {
    connectionId: "connection-1",
    tool: "pages.search",
    arguments: { query: "canvas" },
  }));

  assert.deepEqual(calls.map(([name]) => name), [
    "image",
    "video",
    "metered",
    "agent-provider",
    "metered",
    "script-provider",
    "mcp",
  ]);
  assert.equal(calls[0][1].userId, "run-owner");
  assert.equal(calls[1][1].userId, "run-owner");
  assert.equal(calls[2][1].operationType, "canvas_agent_plan");
  assert.equal(calls[2][1].requestPayload.canvas.id, "canvas-9");
  assert.equal(calls[4][1].operationType, "digital_human_script_optimizer");
  assert.match(calls[0][1].idempotencyKey, /^workflow-node:[0-9a-f]{64}$/);
  assert.equal(calls[0][1].idempotencyKey.length, 78);
});

test("workflow production costs are zero because downstream modules are the billing owners", () => {
  for (const nodeType of [
    "image.generate",
    "video.generate",
    "agent.call",
    "script.optimize",
    "mcp.call",
  ]) {
    assert.equal(resolveWorkflowProductionNodeCost(nodeType), 0);
  }
});

test("MCP handler binds the run owner to the user's OAuth connection", async () => {
  const { calls, module } = makeModule();
  await module.execute(context("mcp.call", {
    userId: "other-user",
    userRole: "root",
    approvalId: "untrusted-approval",
    connectionId: "own-connection",
    toolName: "pages.search",
    arguments: { query: "safe" },
  }));

  const input = calls.find(([name]) => name === "mcp")[1];
  assert.equal(input.userId, "run-owner");
  assert.equal(input.userRole, "user");
  assert.equal(input.connectionId, "own-connection");
  assert.equal(input.approvalId, null);
  assert.equal(input.agentMode, "ask_for_approval");
});

test("MCP workflow nodes use only server-bound Agent mode and approval context", async () => {
  const { calls, module } = makeModule();
  await module.execute(context("mcp.call", {
    agentMode: "full_access",
    approvalId: "untrusted-approval",
    connectionId: "own-connection",
    toolName: "pages.update",
    __stardrawExecutionContext: {
      source: "agent",
      userRole: "user",
      agentMode: "approve_for_me",
      approvalId: "trusted-consumed-approval",
    },
  }));

  const input = calls.find(([name]) => name === "mcp")[1];
  assert.equal(input.agentMode, "approve_for_me");
  assert.equal(input.approvalId, "trusted-consumed-approval");
  assert.equal(input.userRole, "user");
});

test("generation reconciliation remains pending instead of completing a workflow node", async () => {
  const pending = Object.assign(new Error("provider task persistence failed"), {
    code: "PROVIDER_TASK_PERSISTENCE_FAILED",
    pendingReconciliation: true,
    creationId: "video-9",
  });
  const direct = makeModule({ generation: { generateVideo: async () => { throw pending; } } }).module;
  await assert.rejects(
    direct.execute(context("video.generate", { sceneKey: "freeform_video", prompt: "move" })),
    (error) => error === pending,
  );

  const replay = makeModule({
    generation: {
      generateVideo: async () => ({ kind: "reconciliation_pending", creationId: "video-9", pointsReserved: 12 }),
    },
  }).module;
  await assert.rejects(
    replay.execute(context("video.generate", { sceneKey: "freeform_video", prompt: "move" })),
    (error) => error.code === "WORKFLOW_NODE_RECONCILIATION_PENDING"
      && error.pendingReconciliation === true
      && error.creationId === "video-9",
  );
});

test("video nodes inherit dependency prompts and reference completed image creations", async () => {
  const resolverCalls = [];
  const { calls, module } = makeModule({
    referenceImageResolver: async (input) => {
      resolverCalls.push(["reference", input]);
      return [{ buffer: Buffer.from("image"), mimetype: "image/png" }];
    },
    videoResultResolver: async (input) => {
      resolverCalls.push(["video", input]);
      return { kind: "completed", creationId: "video-1", pointsCharged: 12 };
    },
  });

  const result = await module.execute({
    ...context("video.generate", {
      sceneKey: "freeform_video",
      prompt: "Animate {{inputs.copy.result.prompt}}",
    }),
    inputs: {
      image: { creationId: "image-7" },
      copy: { result: { prompt: "a paper bird" } },
    },
    inputTypes: { image: "image.generate", copy: "agent.call" },
    attemptCount: 4,
  });

  const videoCall = calls.find(([name]) => name === "video")[1];
  assert.equal(videoCall.userPrompt, "Animate a paper bird");
  assert.equal(videoCall.referenceImages.length, 1);
  assert.deepEqual(resolverCalls[0], ["reference", { userId: "run-owner", creationId: "image-7" }]);
  assert.equal(resolverCalls[1][1].attemptCount, 4);
  assert.equal(result.pointsCharged, 12);
});

test("image generation accepts multiple canvas image source nodes as references", async () => {
  const resolverCalls = [];
  const { calls, module } = makeModule({
    referenceImageResolver: async ({ creationId }) => {
      resolverCalls.push(creationId);
      return [{ buffer: Buffer.from(creationId), mimetype: "image/png" }];
    },
  });
  await module.execute({
    ...context("image.generate", { sceneKey: "freeform_image", prompt: "Make a collage" }),
    inputs: {
      canvas_image_a: { referenceId: "creation-a", mediaType: "image" },
      canvas_image_b: { referenceId: "upload:7", mediaType: "image" },
      canvas_video: { referenceId: "video-1", mediaType: "video" },
    },
    inputTypes: {
      canvas_image_a: "canvas.image",
      canvas_image_b: "canvas.image",
      canvas_video: "canvas.video",
    },
  });
  assert.deepEqual(resolverCalls, ["upload:7", "creation-a"]);
  assert.equal(calls.find(([name]) => name === "image")[1].referenceImages.length, 2);
});

test("workflow generation resolves declared variables from the persisted execution context", async () => {
  const { calls, module } = makeModule();
  await module.execute({
    ...context("image.generate", {
      sceneKey: "freeform_image",
      prompt: "Poster for ${variables.subject} in ${inputs.style} style",
    }),
    executionContext: {
      variables: { subject: "StarDraw" },
      inputs: { subject: "StarDraw", style: "cinematic" },
    },
  });

  const imageCall = calls.find(([name]) => name === "image")[1];
  assert.equal(imageCall.userPrompt, "Poster for StarDraw in cinematic style");
});

test("workflow generation keeps a private upload token opaque until the owner-scoped resolver", async () => {
  const resolverCalls = [];
  const { calls, module } = makeModule({
    referenceImageResolver: async (input) => {
      resolverCalls.push(input);
      return [{ buffer: Buffer.from("uploaded-image"), mimetype: "image/jpeg" }];
    },
  });

  await module.execute({
    ...context("image.generate", {
      sceneKey: "freeform_image",
      prompt: "Create a product poster",
      referenceExpression: "${variables.referenceElementId}",
    }),
    executionContext: {
      variables: { referenceElementId: "upload:42" },
      inputs: { referenceElementId: "upload:42" },
    },
  });

  assert.deepEqual(resolverCalls, [{ userId: "run-owner", creationId: "upload:42" }]);
  assert.equal(calls.find(([name]) => name === "image")[1].referenceImages.length, 1);
});

test("pending video checkpoints query the original creation without submitting again", async () => {
  const resolverCalls = [];
  const { calls, module } = makeModule({
    videoResultResolver: async (input) => {
      resolverCalls.push(input);
      return { kind: "completed", creationId: input.result.creationId, pointsCharged: 12 };
    },
  });

  const result = await module.execute({
    ...context("video.generate", { sceneKey: "freeform_video", prompt: "move" }),
    checkpoint: { kind: "workflow_external_task", creationId: "video-existing", status: "pending" },
    attemptCount: 8,
  });

  assert.equal(calls.some(([name]) => name === "video"), false);
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].result.creationId, "video-existing");
  assert.equal(resolverCalls[0].attemptCount, 8);
  assert.equal(result.creationId, "video-existing");
});

test("unsupported workflow node types fail with a stable error", async () => {
  const { module } = makeModule();
  await assert.rejects(
    module.execute(context("unknown.execute")),
    (error) => error.code === "WORKFLOW_NODE_TYPE_UNSUPPORTED"
      && error.status === 422
      && error.nodeType === "unknown.execute",
  );
  assert.throws(
    () => resolveWorkflowProductionNodeCost("unknown.execute"),
    (error) => error.code === "WORKFLOW_NODE_TYPE_UNSUPPORTED" && error.status === 422,
  );
});
