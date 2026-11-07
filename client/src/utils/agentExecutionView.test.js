import assert from "node:assert/strict";
import test from "node:test";

import { getAgentExecutionView, getAgentCallDisplayStatus } from "./agentExecutionView.js";

test("shows the exact tool currently executing", () => {
  const view = getAgentExecutionView({
    language: "zh",
    run: { status: "running", currentStep: 2, totalSteps: 2, progress: 50 },
    calls: [
      { status: "completed", callName: "读取画布", toolKey: "canvas.read" },
      { status: "running", callName: "生成视频", toolKey: "media.generate.video", reason: "根据画布图片生成视频" },
    ],
  });

  assert.equal(view.active, true);
  assert.equal(view.phase, "tool");
  assert.equal(view.title, "正在执行：生成视频");
  assert.equal(view.stepNumber, 2);
  assert.equal(view.toolKey, "media.generate.video");
});

test("shows observation and replanning between ReAct tool calls", () => {
  const view = getAgentExecutionView({
    language: "zh",
    run: { status: "running", currentStep: 1, totalSteps: 1, progress: 100 },
    calls: [{ status: "completed", callName: "读取画布", toolKey: "canvas.read", result: { id: "canvas-1" } }],
  });

  assert.equal(view.active, true);
  assert.equal(view.phase, "observe");
  assert.equal(view.title, "正在分析工具结果");
});

test("makes approval pauses explicit", () => {
  const view = getAgentExecutionView({
    language: "zh",
    run: { status: "waiting_approval", currentStep: 1, totalSteps: 1, progress: 0 },
    calls: [{ status: "waiting_approval", callName: "发布作品", toolKey: "community.publish" }],
  });

  assert.equal(view.phase, "approval");
  assert.equal(view.title, "等待你确认：发布作品");
});

test("terminal run state overrides stale active steps and pending UI flags", () => {
  for (const status of ["failed", "cancelled", "completed"]) {
    for (const stepStatus of ["running", "queued", "waiting_approval", "waiting_client"]) {
      const view = getAgentExecutionView({
        planning: true, actionBusy: true,
        run: { status, progress: 40 },
        calls: [{ id: "old-step", status: stepStatus, toolKey: "media.generate.video", reason: "Old running text" }],
      });
      assert.equal(view.phase, status === "completed" ? "done" : "failed");
      assert.equal(view.active, false);
      assert.equal(view.call, null);
      assert.equal(view.description, "");
      assert.equal(view.progress, status === "completed" ? 100 : 40);
    }
  }
});

test("stale active steps become stopped after the run ends without losing completed results", () => {
  for (const runStatus of ["failed", "cancelled", "completed"]) {
    assert.equal(getAgentCallDisplayStatus({ status: "running" }, runStatus), "stopped");
    assert.equal(getAgentCallDisplayStatus({ status: "waiting_approval" }, runStatus), "stopped");
    assert.equal(getAgentCallDisplayStatus({ status: "completed" }, runStatus), "completed");
    assert.equal(getAgentCallDisplayStatus({ status: "failed" }, runStatus), "failed");
  }
  assert.equal(getAgentCallDisplayStatus({ status: "running" }, "running"), "running");
});
