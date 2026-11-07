import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCanvasAgentRunContextParameters,
  CanvasAgentRunService,
  mapPublicCanvasAgentRun,
  normalizeCanvasAgentRunContext,
  trustedWorkflowTemplateObservations,
  unresolvedMediaCreation,
} from "../modules/canvas-agent/runService.js";

const baseRun = (patch = {}) => ({
  id: "carun_11111111111111111111111111111111",
  conversationId: "caconv_11111111111111111111111111111111",
  userId: "user-1",
  canvasId: "canvas-1",
  userRole: "user",
  membershipTier: "pro",
  agentMode: "approve_for_me",
  textModel: "gpt-5.6-sol",
  imageModel: "gpt-image2-1k",
  videoModel: "veo-3-1",
  instruction: "生成一个视频",
  language: "zh",
  status: "running",
  currentStep: 0,
  progress: 0,
  activeJobId: "job-current",
  steps: [],
  ...patch,
});

const createHarness = ({ run, planner, executeTool }) => {
  let nextStepId = 10;
  let nextJobId = 20;
  const queued = [];
  const toolCalls = [];
  const conversation = {
    id: run.conversationId,
    canvas_id: run.canvasId,
    title: "Conversation",
    messages: [],
    runtime_state: { activeRunId: run.id },
    model_preferences: { textModel: run.textModel },
  };
  const conversationSaves = [];
  const store = {
    createRun: async () => run,
    getRun: async () => run,
    addStep: async ({ thought, toolKey, parameters, executionIdempotencyKey }) => {
      const step = { id: nextStepId++, position: run.steps.length + 1, thought, toolKey, parameters, executionIdempotencyKey, status: "ready" };
      run.steps.push(step);
      return step;
    },
    markStepRunning: async ({ stepId, parameterDigest }) => {
      const step = run.steps.find((item) => item.id === stepId);
      step.status = "running";
      step.parameterDigest = parameterDigest;
      run.status = "running";
    },
    completeStep: async ({ stepId, result, waitingExternal }) => {
      const step = run.steps.find((item) => item.id === stepId);
      step.status = "completed";
      step.result = result;
      run.currentStep = step.position;
      run.status = waitingExternal ? "waiting_external" : "running";
    },
    completeRun: async ({ summary }) => {
      run.status = "completed";
      run.finalSummary = summary;
      run.progress = 100;
      run.activeJobId = null;
      return run;
    },
    attachJob: async ({ jobId, status }) => {
      run.activeJobId = jobId;
      run.status = status;
    },
    failRun: async ({ errorCode, errorMessage }) => {
      run.status = "failed";
      run.errorCode = errorCode;
      run.errorMessage = errorMessage;
      return run;
    },
  };
  const service = new CanvasAgentRunService({
    store,
    planner,
    toolRegistry: {
      list: () => [{ toolKey: "canvas.read" }, { toolKey: "creation.get" }, { toolKey: "media.generate.video" }],
      assess: ({ toolKey }) => ({ definition: { toolKey, operationClass: "read" }, requiresApproval: false }),
      execute: async (input) => {
        toolCalls.push(input);
        return executeTool(input);
      },
    },
    jobQueue: {
      enqueue: async (input) => {
        const job = { id: `job-${nextJobId++}`, ...input };
        queued.push(job);
        return job;
      },
    },
    conversationRepository: {
      get: async () => conversation,
      save: async (input) => {
        conversation.messages = input.messages;
        conversation.runtime_state = input.runtimeState;
        conversationSaves.push(input);
        return conversation;
      },
    },
    auditWriter: async () => null,
    mediaPollIntervalMs: 1_000,
  });
  return { service, queued, toolCalls, conversation, conversationSaves };
};

test("pending media observations keep the original creation and never submit a replacement", async () => {
  const pendingStep = {
    id: 1,
    position: 1,
    thought: "提交视频",
    toolKey: "media.generate.video",
    parameters: { prompt: "城市夜景" },
    status: "completed",
    result: { creationId: "creation-42", status: "pending" },
  };
  const run = baseRun({ currentStep: 1, steps: [pendingStep] });
  let plannerCalls = 0;
  const harness = createHarness({
    run,
    planner: async () => { plannerCalls += 1; throw new Error("planner must not run while media is pending"); },
    executeTool: async ({ toolKey, parameters }) => {
      assert.equal(toolKey, "creation.get");
      assert.deepEqual(parameters, { creationId: "creation-42" });
      return { creationId: "creation-42", status: "pending" };
    },
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });

  assert.equal(plannerCalls, 0);
  assert.deepEqual(harness.toolCalls.map((call) => call.toolKey), ["creation.get"]);
  assert.equal(run.steps.length, 2);
  assert.equal(run.steps[1].parameters.creationId, "creation-42");
  assert.equal(harness.queued.length, 1);
  assert.equal(harness.queued[0].jobType, "canvas.agent.react");
});

test("each ReAct worker cycle plans and executes exactly one tool", async () => {
  const run = baseRun();
  let plannerCalls = 0;
  const harness = createHarness({
    run,
    planner: async () => {
      plannerCalls += 1;
      return { action: "tool", thought: "先读取当前画布", toolKey: "canvas.read", parameters: {} };
    },
    executeTool: async ({ toolKey }) => {
      assert.equal(toolKey, "canvas.read");
      return { id: "canvas-1", state: { elements: [] } };
    },
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });

  assert.equal(plannerCalls, 1);
  assert.deepEqual(harness.toolCalls.map((call) => call.toolKey), ["canvas.read"]);
  assert.equal(run.steps.length, 1);
  assert.equal(run.steps[0].status, "completed");
  assert.equal(harness.queued.length, 1);
});

test("Canvas Agent does not submit the same completed image intent twice", async () => {
  const existingStep = {
    id: 1,
    position: 1,
    thought: "生成新图",
    toolKey: "media.generate.image",
    parameters: {
      prompt: "基于参考图生成一张新的创意图片",
      referenceElementIds: ["image-1"],
      model: "gpt-image-2-1k",
    },
    status: "completed",
    result: { creationId: "307", status: "completed", content: "/oss-proxy/307.png" },
  };
  const run = baseRun({ currentStep: 1, steps: [existingStep] });
  let plannerCalls = 0;
  const harness = createHarness({
    run,
    planner: async () => {
      plannerCalls += 1;
      return {
        action: "tool",
        thought: "再次生成同一张图",
        toolKey: "media.generate.image",
        parameters: {
          prompt: "基于参考图生成一张新的创意图片",
          referenceElementIds: ["image-1"],
          model: "gpt-image-2-1k",
        },
      };
    },
    executeTool: async () => {
      throw new Error("duplicate image generation must not reach the provider");
    },
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });

  assert.equal(plannerCalls, 1);
  assert.equal(harness.toolCalls.length, 0);
  assert.equal(run.status, "completed");
  assert.match(run.finalSummary, /307/);
});

test("Canvas Agent tool execution carries only the selected template reference from its own run", async () => {
  const run = baseRun({ contextSnapshot: { selectedTemplateId: "573", templates: [{ id: "573", injected: "ignored by executor" }] } });
  const harness = createHarness({
    run,
    planner: async () => ({ action: "tool", thought: "读取画布", toolKey: "canvas.read", parameters: {} }),
    executeTool: async () => ({ id: "canvas-1" }),
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });

  assert.equal(harness.toolCalls[0].executionContext.source, "canvas_agent");
  assert.equal(harness.toolCalls[0].executionContext.selectedTemplateId, "573");
  assert.equal(harness.toolCalls[0].executionContext.injected, undefined);
});

test("media observation helper clears a creation only after a terminal observation", () => {
  const steps = [
    { status: "completed", toolKey: "media.generate.image", result: { creationId: "creation-9", status: "queued" } },
    { status: "completed", toolKey: "creation.get", parameters: { creationId: "creation-9" }, result: { creationId: "creation-9", status: "completed" } },
  ];
  assert.equal(unresolvedMediaCreation(steps), null);
});

test("workflow-submitted media is polled instead of starting a duplicate workflow", () => {
  const steps = [
    { status: "completed", toolKey: "workflow.run", result: { id: "run-1", status: "running" } },
    { status: "completed", toolKey: "workflow.get", result: { id: "run-1", status: "completed", nodes: [{ result: { creationId: "creation-9", status: "pending" } }] } },
  ];
  assert.equal(unresolvedMediaCreation(steps)?.creationId, "creation-9");
});

test("completed workflow observations finish without another planner cycle", async () => {
  const run = baseRun({
    currentStep: 2,
    steps: [{ id: 1, position: 1, toolKey: "workflow.get", status: "completed", result: { id: "run-1", status: "completed", nodes: [] } }],
  });
  const harness = createHarness({
    run,
    planner: async () => { throw new Error("completed workflow must not be planned again"); },
    executeTool: async () => { throw new Error("completed workflow must not execute another tool"); },
  });
  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });
  assert.equal(run.status, "completed");
  assert.match(run.finalSummary, /工作流已完成/);
});

test("Canvas Agent run context keeps bounded selectors and discards browser URLs or embedded template data", () => {
  const context = normalizeCanvasAgentRunContext({
    selectedTemplateId: "573",
    templates: [{ id: "573", sceneKey: "poster", outputType: "image", template: { system_prompt: "untrusted" } }],
    referenceImages: [{ elementId: "upload_1", title: "Reference", previewUrl: "https://private.example/image.jpg", objectKey: "private/key" }],
    arbitrary: { injected: true },
  });

  assert.deepEqual(context, {
    selectedTemplateId: "573",
    templates: [{ kind: "template", id: "573", sceneKey: "poster", outputType: "image" }],
    referenceImages: [{ kind: "canvas_image", elementId: "upload_1", title: "Reference" }],
  });
  assert.doesNotMatch(JSON.stringify(context), /private|system_prompt|arbitrary/);
});

test("attached canvas images are bound to every media step before approval and execution", () => {
  assert.deepEqual(bindCanvasAgentRunContextParameters({
    toolKey: "media.generate.video",
    parameters: { prompt: "让画面动起来", referenceElementIds: ["explicit_1"] },
    contextSnapshot: { referenceImages: [{ elementId: "selected_1" }, { elementId: "explicit_1" }] },
  }), {
    prompt: "让画面动起来",
    referenceElementIds: ["explicit_1", "selected_1"],
  });
});

test("workflow tools receive only trusted template observations produced by server tools", () => {
  const templates = trustedWorkflowTemplateObservations([
    {
      status: "completed",
      toolKey: "workflow.catalog",
      result: { fallbackTemplates: { image: { sceneKey: "freeform_image", outputType: "image", fallback: true } } },
    },
    {
      status: "completed",
      toolKey: "template.search",
      result: [{ id: 573, scene_key: "awesome_gpt_image_2_case_497", output_type: "image", starter_prompt: "not forwarded" }],
    },
    {
      status: "failed",
      toolKey: "template.search",
      result: [{ id: 999, scene_key: "untrusted_failed_result", output_type: "image" }],
    },
  ]);

  assert.deepEqual(templates, [
    { id: null, sceneKey: "freeform_image", outputType: "image", fallback: true },
    { id: "573", sceneKey: "awesome_gpt_image_2_case_497", outputType: "image", fallback: false },
  ]);
  assert.doesNotMatch(JSON.stringify(templates), /starter_prompt|untrusted_failed_result/);
});

test("a terminal planner failure clears the active run and records one result", async () => {
  const run = baseRun();
  const harness = createHarness({
    run,
    planner: async () => {
      throw Object.assign(new Error("provider rejected the response"), {
        status: 422,
        code: "CANVAS_AGENT_INVALID_RESPONSE",
      });
    },
    executeTool: async () => null,
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 1, payload: { runId: run.id } });

  assert.equal(run.status, "failed");
  assert.equal(harness.conversation.runtime_state.activeRunId, null);
  assert.equal(harness.conversation.runtime_state.lastRunId, run.id);
  assert.equal(harness.conversation.runtime_state.lastRunStatus, "failed");
  assert.equal(harness.conversation.messages.filter((message) => message.role === "assistant" && message.runId === run.id).length, 1);

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 1, payload: { runId: run.id } });
  assert.equal(harness.conversation.messages.filter((message) => message.role === "assistant" && message.runId === run.id).length, 1);
});

test("Canvas Agent step failures retain a safe operational error code", async () => {
  const run = baseRun();
  const harness = createHarness({
    run,
    planner: async () => ({ action: "tool", thought: "读取当前画布", toolKey: "canvas.read", parameters: {} }),
    executeTool: async () => {
      throw Object.assign(new Error("fetch failed"), {
        status: 502,
        code: "AGENT_PROVIDER_UNAVAILABLE",
      });
    },
  });

  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 1, payload: { runId: run.id } });

  assert.equal(run.status, "failed");
  assert.equal(run.errorMessage, "Canvas Agent step execution failed (AGENT_PROVIDER_UNAVAILABLE)");
});

test("Canvas Agent public runs contain JSON-safe timestamps for durable job results", () => {
  const timestamp = new Date("2026-08-17T10:00:00.000Z");
  const run = mapPublicCanvasAgentRun(baseRun({
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    failedAt: null,
    cancelledAt: null,
    steps: [{
      id: "step-1",
      position: 1,
      thought: "读取画布",
      toolKey: "canvas.read",
      parameters: {},
      result: { id: "canvas-1" },
      status: "completed",
      requiresApproval: false,
      approvalReasonCode: null,
      approvedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
    }],
  }));

  assert.equal(run.createdAt, timestamp.toISOString());
  assert.equal(run.steps[0].completedAt, timestamp.toISOString());
  assert.equal(run.failedAt, null);
  const assertQueueJson = (value, path = "result") => {
    assert.notEqual(typeof value, "undefined", `${path} must not contain undefined`);
    assert.equal(value instanceof Date, false, `${path} must not contain Date objects`);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) assertQueueJson(item, `${path}.${key}`);
  };
  assertQueueJson(run);
});

test("a terminal Canvas Agent job remains complete after its conversation is archived", async () => {
  const run = baseRun({ status: "completed", finalSummary: "画布为空", progress: 100 });
  const service = new CanvasAgentRunService({
    store: {
      createRun: async () => run,
      getRun: async () => run,
    },
    jobQueue: { enqueue: async () => ({ id: "unused" }) },
    toolRegistry: { execute: async () => null },
    planner: async () => ({ action: "finish", summary: "unused" }),
    conversationRepository: {
      get: async () => {
        throw Object.assign(new Error("archived"), { code: "CANVAS_AGENT_CONVERSATION_NOT_FOUND", status: 404 });
      },
      save: async () => null,
    },
    auditWriter: async () => null,
  });

  const result = await service.executeJob({ id: "job-terminal", payload: { runId: run.id } });
  assert.equal(result.status, "completed");
});

test("a permanent planner rejection settles the run instead of using remaining worker attempts", async () => {
  const run = baseRun();
  let plannerCalls = 0;
  const harness = createHarness({ run, planner: async () => {
    plannerCalls += 1;
    throw Object.assign(new Error("provider denied access"), { status: 403, code: "AGENT_PROVIDER_REJECTED", retryAfterMs: 0 });
  }, executeTool: async () => null });
  await harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } });
  assert.equal(run.status, "failed");
  assert.equal(run.errorCode, "AGENT_PROVIDER_REJECTED");
  assert.equal(harness.conversation.runtime_state.activeRunId, null);
  await harness.service.executeJob({ id: "job-current", attempts: 2, maxAttempts: 3, payload: { runId: run.id } });
  assert.equal(plannerCalls, 1);
  assert.equal(harness.queued.length, 0);
});

test("rate limited planning still defers to the worker for a later attempt", async () => {
  const run = baseRun();
  const error = Object.assign(new Error("busy"), { status: 429 });
  const harness = createHarness({ run, planner: async () => { throw error; }, executeTool: async () => null });
  await assert.rejects(harness.service.executeJob({ id: "job-current", attempts: 1, maxAttempts: 3, payload: { runId: run.id } }),
    (actual) => actual === error);
  assert.equal(run.status, "running");
});
