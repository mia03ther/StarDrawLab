import assert from "node:assert/strict";
import test from "node:test";

import {
  bindCanvasAgentWorkflowTemplates,
  CanvasAgentToolRegistry,
  tokenizeCanvasAgentTemplateSearch,
} from "../modules/canvas-agent/toolRegistry.js";
import { repairAgentWorkflowEdgeReferences } from "../domain/workflow/workflowAgentDefinition.js";

const workflow = (type) => ({
  id: "cwf_11111111111111111111111111111111",
  definition: { nodes: [{ id: "node-1", type }], edges: [] },
});

test("Approve for me runs ordinary workflows but asks before workflows containing MCP", async () => {
  const ordinary = new CanvasAgentToolRegistry({ workflowReader: async () => workflow("image.generate") });
  const external = new CanvasAgentToolRegistry({ workflowReader: async () => workflow("mcp.call") });
  const input = {
    userId: "user-1",
    toolKey: "workflow.run",
    parameters: { workflowId: "cwf_11111111111111111111111111111111" },
    agentMode: "approve_for_me",
  };

  assert.equal((await ordinary.assess(input)).requiresApproval, false);
  const externalAssessment = await external.assess(input);
  assert.equal(externalAssessment.requiresApproval, true);
  assert.equal(externalAssessment.definition.operationClass, "external");
  assert.equal((await external.assess({ ...input, agentMode: "full_access" })).requiresApproval, false);
});

test("template search splits broad natural-language queries into reusable fuzzy terms", () => {
  assert.deepEqual(
    tokenizeCanvasAgentTemplateSearch("文案 海报、商业海报 / 社交媒体"),
    ["文案", "海报", "商业海报", "社交媒体"],
  );
  assert.deepEqual(tokenizeCanvasAgentTemplateSearch("海报 海报"), ["海报"]);
});

test("Agent workflow media nodes bind to observed templates and never keep invented scene keys", () => {
  const definition = bindCanvasAgentWorkflowTemplates({
    definition: {
      nodes: [{
        id: "poster",
        type: "image.generate",
        fields: { sceneKey: "poster", prompt: "生成商业海报" },
      }],
      edges: [],
    },
    trustedTemplates: [{
      id: 573,
      scene_key: "agpt2_style_poster_layout_system",
      output_type: "image",
    }],
  });

  assert.deepEqual(definition.nodes[0].config, {
    sceneKey: "agpt2_style_poster_layout_system",
    prompt: "生成商业海报",
    templateId: "573",
  });
});

test("Agent workflow repairs an unambiguous template-prefixed edge to the real media node", () => {
  const repaired = repairAgentWorkflowEdgeReferences({
    nodes: [
      { id: "input_reference_image", type: "input", config: { inputType: "image" } },
      { id: "poster", type: "image.generate", config: { templateId: "1070" } },
    ],
    edges: [{ from: "input_reference_image", to: "template_poster" }],
  });

  assert.equal(repaired.edges[0].from, "input_reference_image");
  assert.equal(repaired.edges[0].to, "poster");
});
