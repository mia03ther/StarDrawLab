import assert from "node:assert/strict";
import test from "node:test";

import { isWorkflowRunBusy, shouldUnlockWorkflowRun } from "./workflowRunState.js";

test("approval pauses remain locked while insufficient-points pauses unlock editing", () => {
  assert.equal(isWorkflowRunBusy("paused", [{ status: "waiting_approval" }]), true);
  assert.equal(shouldUnlockWorkflowRun("paused", [{ status: "waiting_approval" }]), false);

  assert.equal(isWorkflowRunBusy("paused", [{ status: "paused", errorCode: "INSUFFICIENT_POINTS" }]), false);
  assert.equal(shouldUnlockWorkflowRun("paused", [{ status: "paused", errorCode: "INSUFFICIENT_POINTS" }]), true);
});
