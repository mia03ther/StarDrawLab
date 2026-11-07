import test from "node:test";
import assert from "node:assert/strict";

import { applyHeyGenDurationDirective } from "../utils/heygenDuration.js";

test("HeyGen duration directive is appended exactly once", () => {
  const first = applyHeyGenDurationDirective("Create a presenter video", 30);
  const second = applyHeyGenDurationDirective(first, 30);

  assert.equal(first, "Create a presenter video\n\nTarget duration: 30 seconds. Do not exceed this duration.");
  assert.equal(second, first);
});

test("HeyGen duration directive rejects unsafe or unsupported durations", () => {
  for (const value of [0, 14, 181, 30.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => applyHeyGenDurationDirective("Create a presenter video", value),
      (error) => error?.code === "INVALID_VIDEO_DURATION",
    );
  }
});
