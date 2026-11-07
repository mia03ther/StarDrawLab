import assert from "node:assert/strict";
import test from "node:test";

import {
  getWaitingWorkflowApproval,
  interpolateWorkflowApprovalText,
} from "./workflowApproval.js";

test("workflow approval resolves prior node output for the confirmation message", () => {
  const runtimeNodes = [
    { nodeKey: "write_prompt", status: "completed", result: { content: "最终海报提示词" } },
    { nodeKey: "approve_prompt", status: "waiting_approval", result: null },
  ];
  const definition = {
    nodes: [{
      id: "approve_prompt",
      title: "确认提示词",
      config: { message: "请确认：${nodes.write_prompt.content}" },
    }],
  };

  assert.deepEqual(getWaitingWorkflowApproval({ runtimeNodes, definition }), {
    nodeKey: "approve_prompt",
    title: "确认提示词",
    message: "请确认：最终海报提示词",
  });
});

test("persisted approval request remains usable without the editable workflow definition", () => {
  const approval = getWaitingWorkflowApproval({
    runtimeNodes: [{
      nodeKey: "approve",
      status: "waiting_approval",
      result: {
        kind: "workflow_approval_request",
        title: "确认生成",
        message: "确认后将生成视频",
      },
    }],
  });

  assert.equal(approval.title, "确认生成");
  assert.equal(approval.message, "确认后将生成视频");
});

test("approval expressions stay visible when their source is unavailable", () => {
  assert.equal(
    interpolateWorkflowApprovalText("检查 ${nodes.missing.content}", []),
    "检查 ${nodes.missing.content}",
  );
});
