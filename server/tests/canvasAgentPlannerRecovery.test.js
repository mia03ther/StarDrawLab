import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__canvasPlannerResponses = [];
globalThis.__canvasPlannerRequests = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/modules/canvas-agent/planner.js") && specifier === "./llmProvider.js") {
      return { shortCircuit: true, url: "canvas-planner-recovery-test:provider" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "canvas-planner-recovery-test:provider") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const requestCanvasAgentJson = async (request) => {
            globalThis.__canvasPlannerRequests.push(request);
            return {
              data: globalThis.__canvasPlannerResponses.shift(),
              model: request.modelKey,
              routeId: 10,
            };
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const { planCanvasAgentNextAction } = await import("../modules/canvas-agent/planner.js");

test("workflow creation cannot finish before workflow.create succeeds", async () => {
  globalThis.__canvasPlannerRequests.length = 0;
  globalThis.__canvasPlannerResponses.splice(0, Infinity,
    { action: "finish", summary: "工作流已经准备好了。" },
    {
      action: "tool",
      thought: "创建已经设计好的工作流。",
      tool_key: "workflow.create",
      parameters: { name: "文案到海报", definition: { nodes: [], edges: [] } },
    },
  );

  const decision = await planCanvasAgentNextAction({
    userId: "user-1",
    modelKey: "gpt-5.6-sol",
    instruction: "创建一个从文案到海报的工作流",
    language: "zh",
    conversation: { messages: [] },
    run: {
      canvasId: "canvas-1",
      textModel: "gpt-5.6-sol",
      steps: [
        { position: 1, toolKey: "workflow.catalog", status: "completed", result: {} },
        { position: 2, toolKey: "template.search", status: "completed", result: [] },
      ],
    },
    tools: [{
      toolKey: "workflow.create",
      description: "Create workflow",
      inputSchema: { type: "object" },
    }],
  });

  assert.equal(decision.action, "tool");
  assert.equal(decision.toolKey, "workflow.create");
  assert.equal(globalThis.__canvasPlannerRequests.length, 2);
  assert.match(
    globalThis.__canvasPlannerRequests[1].messages.at(-1).content,
    /workflow\.create step must complete successfully/i,
  );
});
