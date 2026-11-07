import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTimelinePlayhead,
  collectTimelineSnapPoints,
  getTimelineClipOpacity,
  getTimelineEffectOverlay,
  getTimelinePlaybackState,
  moveTimelineClip,
  normalizeTimelineClip,
  splitTimelineClip,
  trimTimelineClip,
} from "./browserTimelineRenderer.js";

test("normalizes editable clip playback and effect parameters", () => {
  assert.deepEqual(normalizeTimelineClip({
    id: "clip-a",
    start: -2,
    duration: 0,
    speed: 20,
    volume: -1,
    fadeIn: 9,
    fadeOut: 9,
    effect: "fade-out",
    effectAmount: 3,
  }), {
    id: "clip-a",
    assetId: "",
    start: 0,
    duration: 3,
    sourceStart: 0,
    sourceDuration: 0,
    speed: 8,
    volume: 0,
    text: "",
    transition: "",
    fadeIn: 1.5,
    fadeOut: 1.5,
    effect: "fade-out",
    effectAmount: 1,
  });
});

test("collects stable magnetic snap points without the clip being edited", () => {
  const points = collectTimelineSnapPoints([
    { clips: [{ id: "moving", start: 1, duration: 2 }, { id: "anchor", start: 5, duration: 2 }] },
    { clips: [{ id: "other", start: 9, duration: 1 }] },
  ], { excludeClipId: "moving", playhead: 4 });

  assert.deepEqual(points, [0, 4, 5, 7, 9, 10]);
});

test("moves a clip and snaps either its leading or trailing edge", () => {
  const clip = { id: "moving", start: 1, duration: 2, sourceStart: 0, speed: 1 };
  assert.equal(moveTimelineClip(clip, 1.94, { snapPoints: [5], snapThreshold: 0.1 }).start, 3);
  assert.equal(moveTimelineClip(clip, -4, { snapPoints: [], snapThreshold: 0.1 }).start, 0);
});

test("left and right trims preserve source timing and use magnetic edges", () => {
  const clip = { id: "clip", start: 2, duration: 4, sourceStart: 1, sourceDuration: 12, speed: 2 };
  assert.deepEqual(trimTimelineClip(clip, "left", 0.96, { snapPoints: [3], snapThreshold: 0.1 }), {
    ...clip,
    start: 3,
    duration: 3,
    sourceStart: 3,
  });
  assert.deepEqual(trimTimelineClip(clip, "right", 1.96, { snapPoints: [8], snapThreshold: 0.1 }), {
    ...clip,
    duration: 6,
  });
  assert.deepEqual(trimTimelineClip(clip, "left", -1, { snapPoints: [], snapThreshold: 0 }), {
    ...clip,
    start: 1.5,
    duration: 4.5,
    sourceStart: 0,
  });
});

test("splits a clip at the playhead without changing its source continuity", () => {
  const clip = { id: "clip", start: 2, duration: 6, sourceStart: 1, sourceDuration: 12, speed: 1.5 };
  assert.deepEqual(splitTimelineClip(clip, 5, { rightId: "clip-right" }), [
    { ...clip, duration: 3 },
    { ...clip, id: "clip-right", start: 5, duration: 3, sourceStart: 5.5 },
  ]);
  assert.equal(splitTimelineClip(clip, 2), null);
  assert.equal(splitTimelineClip(clip, 8), null);
});

test("clamps the playhead and computes clip fades as deterministic envelopes", () => {
  assert.equal(clampTimelinePlayhead(-1, 12), 0);
  assert.equal(clampTimelinePlayhead(20, 12), 12);
  assert.equal(getTimelineClipOpacity({ duration: 4, transition: "fade", fadeIn: 1, fadeOut: 2 }, 0.5), 0.5);
  assert.equal(getTimelineClipOpacity({ duration: 4, transition: "fade", fadeIn: 1, fadeOut: 2 }, 3), 0.5);
  assert.equal(getTimelineClipOpacity({ duration: 4, transition: "" }, 3), 1);
});

test("effect tracks produce usable fade-in, fade-out and dim overlays", () => {
  const base = { duration: 4, effectAmount: 0.8, fadeIn: 1, fadeOut: 2 };
  assert.deepEqual(getTimelineEffectOverlay({ ...base, effect: "fade-in" }, 0.5), { color: "#000000", alpha: 0.4 });
  assert.deepEqual(getTimelineEffectOverlay({ ...base, effect: "fade-out" }, 3), { color: "#000000", alpha: 0.4 });
  assert.deepEqual(getTimelineEffectOverlay({ ...base, effect: "dim" }, 2), { color: "#000000", alpha: 0.8 });
  assert.deepEqual(getTimelineEffectOverlay({ ...base, effect: "none" }, 2), { color: "#000000", alpha: 0 });
});

test("derives source time, playback speed and faded output gain for rendering", () => {
  assert.deepEqual(getTimelinePlaybackState({
    start: 2,
    duration: 4,
    sourceStart: 10,
    speed: 1.5,
    volume: 1.2,
    transition: "fade-in",
    fadeIn: 1,
  }, 2.5), {
    active: true,
    localTime: 0.5,
    sourceTime: 10.75,
    playbackRate: 1.5,
    opacity: 0.5,
    gain: 0.6,
  });
  assert.deepEqual(getTimelinePlaybackState({ start: 2, duration: 4 }, 8), {
    active: false,
    localTime: 6,
    sourceTime: 6,
    playbackRate: 1,
    opacity: 0,
    gain: 0,
  });
});
