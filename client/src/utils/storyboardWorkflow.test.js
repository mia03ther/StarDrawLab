import assert from "node:assert/strict";
import test from "node:test";
import { getStoryboardBoundElement, upsertStoryboardTimelineClip } from "./storyboardWorkflow.js";

test("binds only a visual canvas element to a storyboard shot", () => {
  const elements = [
    { id: "note-1", type: "text" },
    { id: "image-1", type: "image", src: "/image.png" },
  ];
  assert.equal(getStoryboardBoundElement({ elementId: "image-1" }, elements), elements[1]);
  assert.equal(getStoryboardBoundElement({ elementId: "note-1" }, elements), null);
});

test("adds then updates one timeline clip per storyboard shot", () => {
  let sequence = 0;
  const createId = (prefix) => `${prefix}-${++sequence}`;
  const first = upsertStoryboardTimelineClip({
    timeline: { fps: 30, tracks: [] },
    shot: { id: "shot-1", title: "Opening", duration: 4 },
    element: { id: "image-1", type: "image" },
    createId,
  });
  assert.equal(first.added, true);
  assert.equal(first.timeline.tracks[0].clips[0].assetType, "image");
  assert.equal(first.timeline.tracks[0].clips[0].duration, 4);

  const second = upsertStoryboardTimelineClip({
    timeline: first.timeline,
    shot: { id: "shot-1", title: "Opening video", duration: 6 },
    element: { id: "video-1", type: "video" },
    createId,
  });
  assert.equal(second.added, false);
  assert.equal(second.clipId, first.clipId);
  assert.equal(second.timeline.tracks[0].clips.length, 1);
  assert.equal(second.timeline.tracks[0].clips[0].assetId, "video-1");
  assert.equal(second.timeline.tracks[0].clips[0].duration, 6);
});
