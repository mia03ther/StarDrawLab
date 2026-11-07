import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  activateCanvasVideoAudio,
  muteCanvasVideo,
} from "./canvasVideoPlayback.js";

test("canvas audio activation unmutes one video, restores volume and mutes the rest", async () => {
  const calls = [];
  const first = { muted: false, volume: 0.4, play: async () => calls.push("first") };
  const target = { muted: true, volume: 0, play: async () => calls.push("target") };

  const activated = await activateCanvasVideoAudio({
    videos: { first, target },
    elementId: "target",
  });

  assert.equal(activated, true);
  assert.equal(first.muted, true);
  assert.equal(target.muted, false);
  assert.equal(target.volume, 1);
  assert.deepEqual(calls, ["target"]);
  assert.equal(muteCanvasVideo(target), true);
  assert.equal(target.muted, true);
});

test("the main canvas exposes explicit sound controls instead of trapping videos in muted preview", () => {
  const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.readFileSync(path.join(clientRoot, "pages", "CanvasStudio.jsx"), "utf8");

  assert.match(source, /toggleCanvasVideoAudio/);
  assert.match(source, /volume_up/);
  assert.match(source, /volume_off/);
  assert.match(source, /canvas-video-audio-control/);
  assert.match(source, /muted=\{audibleVideoId !== element\.id\}/);
  assert.doesNotMatch(source, /\n\s+muted\n/);
});
