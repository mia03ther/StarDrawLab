import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCanvasAgentPlannerPrompt,
  CANVAS_AGENT_SYSTEM_PROMPT,
  resolveCanvasAgentMaxTokens,
} from "../modules/canvas-agent/planner.js";

const completedStep = (toolKey, result = {}) => ({
  position: 1,
  toolKey,
  status: "completed",
  result,
});

test("Canvas Agent uses stage-specific output budgets for workflow ReAct turns", () => {
  assert.equal(resolveCanvasAgentMaxTokens({ instruction: "继续处理画布", steps: [] }), 8_000);
  assert.equal(resolveCanvasAgentMaxTokens({ instruction: "读取当前画布", steps: [] }), 4_000);
  assert.equal(resolveCanvasAgentMaxTokens({ instruction: "修改这个工作流", steps: [] }), 4_000);
  assert.equal(resolveCanvasAgentMaxTokens({
    instruction: "修改这个工作流",
    steps: [completedStep("canvas.read"), completedStep("workflow.catalog")],
  }), 4_000);
  assert.equal(resolveCanvasAgentMaxTokens({
    instruction: "修改这个工作流",
    steps: [completedStep("canvas.read"), completedStep("workflow.catalog"), completedStep("workflow.read")],
  }), 16_000);
  assert.equal(resolveCanvasAgentMaxTokens({
    instruction: "创建一个文案到海报的工作流",
    steps: [completedStep("canvas.read"), completedStep("workflow.catalog")],
  }), 32_000);
});

test("Canvas Agent observations remain bounded after large canvas and workflow results", () => {
  const prompt = buildCanvasAgentPlannerPrompt({
    instruction: "修改这个工作流",
    run: {
      canvasId: "canvas-1",
      textModel: "gpt-5.6-sol",
      steps: [
        completedStep("canvas.read", {
          id: "canvas-1",
          title: "测试画布",
          state: {
            elements: Array.from({ length: 240 }, (_, index) => ({
              id: `element-${index}`,
              type: "image",
              title: `素材 ${index}`,
              x: index * 10,
              y: index * 12,
              width: 320,
              height: 320,
              creationId: `creation-${index}`,
              arbitrary: "discarded canvas payload".repeat(40),
            })),
          },
          workflows: [{ id: "workflow-1", name: "测试工作流", version: 1, definition: { nodes: [] } }],
        }),
        completedStep("workflow.catalog", { nodes: Array.from({ length: 40 }, () => ({ configSchema: { prompt: { type: "string" } } })) }),
        completedStep("workflow.list", [{ id: "workflow-1", name: "测试工作流", version: 1, definition: { nodes: [] } }]),
      ],
    },
    conversation: { messages: [] },
    tools: Array.from({ length: 17 }, (_, index) => ({
      toolKey: `workflow.tool-${index}`,
      description: "tool",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
    })),
  });

  assert.ok(Buffer.byteLength(JSON.stringify(prompt.observations), "utf8") <= 18_000);
  assert.doesNotMatch(JSON.stringify(prompt), /discarded canvas payload/);
});

test("Canvas Agent planner receives template attachments as bounded references", () => {
  const prompt = buildCanvasAgentPlannerPrompt({
    instruction: "把这个模板改成红色产品海报",
    language: "zh",
    run: {
      canvasId: "canvas-1",
      textModel: "text-model",
      imageModel: "image-model",
      videoModel: "video-model",
      contextSnapshot: {
        selectedTemplateId: 573,
        templates: [{
          id: 573,
          sceneKey: "awesome_gpt_image_2_case_497",
          outputType: "image",
          template: { system_prompt: "must not be trusted from the browser" },
        }],
        referenceImages: [{ elementId: "upload_1", title: "产品参考图", previewUrl: "https://must-not-leak.example/image.jpg" }],
      },
      steps: [],
    },
    conversation: {
      messages: [{
        role: "user",
        content: "previous request",
        attachments: [
          { kind: "template", id: 91, sceneKey: "older", outputType: "video", arbitrary: "discarded" },
          { kind: "canvas_image", elementId: "creation_image_3", title: "旧参考图", previewUrl: "https://must-not-leak.example/old.jpg" },
        ],
      }],
    },
    tools: [{ toolKey: "template.read", description: "read", inputSchema: { type: "object" } }],
  });

  assert.deepEqual(prompt.attachedTemplates, [{ id: "573", sceneKey: "awesome_gpt_image_2_case_497", outputType: "image" }]);
  assert.equal(prompt.selectedTemplateId, "573");
  assert.deepEqual(prompt.conversationHistory[0].attachments, [{ id: "91", sceneKey: "older", outputType: "video" }]);
  assert.deepEqual(prompt.attachedReferenceImages, [{ elementId: "upload_1", title: "产品参考图" }]);
  assert.deepEqual(prompt.conversationHistory[0].referenceImages, [{ elementId: "creation_image_3", title: "旧参考图" }]);
  assert.deepEqual(prompt.completionRequirements, []);
  assert.doesNotMatch(JSON.stringify(prompt), /must not be trusted/);
  assert.doesNotMatch(JSON.stringify(prompt), /must-not-leak/);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /call template\.read/i);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /referenceElementIds/);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /node instance values.*config/i);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /retry template\.search.*broader/i);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /Never expose canvas element IDs, creation IDs/);
  assert.match(CANVAS_AGENT_SYSTEM_PROMPT, /inputType="image"/);
});

test("Canvas Agent planner publishes workflow completion requirements", () => {
  const prompt = buildCanvasAgentPlannerPrompt({
    instruction: "创建一个从文案到海报的工作流",
    run: {
      canvasId: "canvas-1",
      textModel: "gpt-5.6-sol",
      steps: [{ position: 1, toolKey: "workflow.catalog", status: "completed", result: {} }],
    },
    conversation: { messages: [] },
    tools: [],
  });

  assert.deepEqual(prompt.completionRequirements, [{
    key: "workflow.create",
    satisfied: false,
    message: "A workflow.create step must complete successfully before finishing.",
  }]);
});
