import assert from "node:assert/strict";
import test from "node:test";

import { prepareWorkflowLoopConfig } from "../modules/canvas-workflows/loopNodeHandlers.js";

test("loop control fields interpolate without consuming child loop variables", () => {
  const body = {
    nodes: [{
      id: "make_image",
      type: "image.generate",
      config: {
        sceneKey: "freeform_image",
        prompt: "为 ${loop.item.name} 生成海报，第 ${loop.index} 张",
      },
    }],
    edges: [],
  };

  const prepared = prepareWorkflowLoopConfig({
    itemsExpression: "${inputs.products}",
    maxIterations: "${variables.limit}",
    body,
  }, {
    inputs: { products: [{ name: "香水" }] },
    variables: { limit: 8 },
    nodes: {},
    loop: {},
  });

  assert.deepEqual(prepared.itemsExpression, [{ name: "香水" }]);
  assert.equal(prepared.maxIterations, 8);
  assert.deepEqual(prepared.body, body);
  assert.equal(prepared.body.nodes[0].config.prompt, "为 ${loop.item.name} 生成海报，第 ${loop.index} 张");
});

test("repeat-until keeps child previous-result expressions for iteration time", () => {
  const prepared = prepareWorkflowLoopConfig({
    maxIterations: 4,
    until: {
      left: "${loop.result.nodes.review.result.approved}",
      operator: "equals",
      right: true,
    },
    body: {
      nodes: [{
        id: "revise",
        type: "agent.call",
        config: { prompt: "根据上轮结果 ${loop.previousResult} 再修改一次" },
      }],
      edges: [],
    },
  }, { inputs: {}, variables: {}, nodes: {}, loop: {} });

  assert.equal(prepared.until.left, "${loop.result.nodes.review.result.approved}");
  assert.equal(prepared.body.nodes[0].config.prompt, "根据上轮结果 ${loop.previousResult} 再修改一次");
});
