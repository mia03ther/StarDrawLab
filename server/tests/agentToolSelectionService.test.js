import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_AGENT_TOOLS } from "../services/agentToolRegistry.js";
import { searchAgentCapabilities, selectAgentTools } from "../services/agentToolSelectionService.js";

test("workflow requests receive a bounded workflow-focused tool catalog", () => {
  const selected = selectAgentTools({
    tools: DEFAULT_AGENT_TOOLS,
    instruction: "在当前画布搭建一个图片生成后再生成视频的工作流",
    context: { currentCanvas: { id: "canvas-1" } },
  });
  const keys = new Set(selected.map((tool) => tool.toolKey));

  assert.ok(selected.length <= 24);
  assert.equal(keys.has("agent.capability.search"), true);
  assert.equal(keys.has("workflow.catalog"), true);
  assert.equal(keys.has("workflow.read"), true);
  assert.equal(keys.has("workflow.save"), true);
  assert.equal(keys.has("canvas.read"), true);
  assert.equal(keys.has("media.generate.image"), true);
  assert.equal(keys.has("media.generate.video"), true);
  assert.equal(keys.has("billing.refund"), false);
});

test("capability search only returns tools permitted for the authenticated role", () => {
  const userResults = searchAgentCapabilities({ tools: DEFAULT_AGENT_TOOLS, query: "模型路由配置", userRole: "user" });
  const rootResults = searchAgentCapabilities({ tools: DEFAULT_AGENT_TOOLS, query: "模型路由配置", userRole: "root" });

  assert.equal(userResults.some((tool) => tool.toolKey.startsWith("root.")), false);
  assert.equal(rootResults.some((tool) => tool.toolKey === "root.model-route.list"), true);
});
