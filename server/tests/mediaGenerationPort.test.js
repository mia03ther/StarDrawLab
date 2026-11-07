import assert from "node:assert/strict";
import test from "node:test";

import { ImageGenerationAdapter } from "../infrastructure/imageGenerationAdapter.js";
import { VideoGenerationAdapter } from "../infrastructure/videoGenerationAdapter.js";
import { VIDEO_PROVIDER_KINDS } from "../ports/mediaGenerationPort.js";
import {
  getImageGenerationProvider,
  getVideoGenerationProvider,
  resetMediaGenerationProviders,
  setMediaGenerationProvidersForTests,
} from "../services/mediaGenerationComposition.js";

test("image generation adapter hides positional provider calls", async () => {
  const calls = [];
  const adapter = new ImageGenerationAdapter({
    provider: {
      normalizeImageModel: (value) => value === "legacy" ? "canonical" : value || "default-image",
      normalizeImageSize: (value) => value || "1024x1024",
      imageModelSupportsReferenceImages: (value) => value !== "text-only",
      generateImage: async (...args) => { calls.push(args); return { imageUrl: "https://image.invalid/result" }; },
    },
  });

  assert.deepEqual(adapter.normalizeRequest({ model: "legacy" }), {
    model: "canonical",
    size: "1024x1024",
    routeProviderKeys: ["image_provider"],
  });
  assert.equal(adapter.supportsReferenceImages("canonical"), true);
  assert.equal(adapter.supportsReferenceImages("text-only"), false);
  const references = [{ buffer: Buffer.from("image") }];
  assert.deepEqual(
    await adapter.generate({ prompt: "draw", size: "1024x1024", referenceImages: references, model: "canonical" }),
    { imageUrl: "https://image.invalid/result" },
  );
  assert.deepEqual(calls[0], ["draw", "1024x1024", references, "canonical"]);
});

test("video generation adapter routes standard and digital-human providers", async () => {
  const calls = [];
  const standardProvider = {
    normalizeVideoProviderModel: (value) => value || "standard-model",
    normalizeVideoProviderSize: (value) => value || "1280x720",
    submitSoraVideoTask: async (...args) => { calls.push(["standard.submit", ...args]); return { success: true, taskId: "std-1" }; },
    checkSoraVideoStatus: async (taskId) => { calls.push(["standard.check", taskId]); return { success: true, status: "completed" }; },
  };
  const digitalHumanProvider = {
    isHeyGenProvider: (value) => value === "digital-provider",
    normalizeHeyGenModel: (value) => value || "digital-model",
    normalizeHeyGenSize: (value) => value || "16:9",
    submitHeyGenVideoAgentTask: async (...args) => { calls.push(["digital.submit", ...args]); return { success: true, taskId: "digital-1" }; },
    checkHeyGenVideoAgentStatus: async (taskId) => { calls.push(["digital.check", taskId]); return { success: true, status: "completed" }; },
  };
  const adapter = new VideoGenerationAdapter({ standardProvider, digitalHumanProvider });

  assert.deepEqual(adapter.normalizeRequest({ provider: "standard", model: "v1", size: "720x1280" }), {
    kind: VIDEO_PROVIDER_KINDS.STANDARD,
    model: "v1",
    size: "720x1280",
    routeProviderKeys: ["sora"],
  });
  assert.deepEqual(adapter.normalizeRequest({ provider: "digital-provider", model: "avatar", size: "9:16" }), {
    kind: VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN,
    model: "avatar",
    size: "9:16",
    routeProviderKeys: ["heygen_video_agent"],
  });

  await adapter.submit({
    provider: "standard",
    prompt: "p",
    model: "v1",
    seconds: 6,
    size: "1280x720",
    imageUrl: "https://ref.invalid",
    imageUrls: ["https://ref.invalid", "https://ref.invalid/second"],
  });
  await adapter.submit({ provider: "digital-provider", prompt: "p2", model: "avatar", seconds: 10, size: "16:9" });
  await adapter.check({ provider: "standard", taskId: "std-1" });
  await adapter.check({ provider: "digital-provider", taskId: "digital-1" });

  assert.deepEqual(calls, [
    ["standard.submit", "p", "v1", 6, "1280x720", "https://ref.invalid", ["https://ref.invalid", "https://ref.invalid/second"]],
    ["digital.submit", "p2", { model: "avatar", seconds: 10, size: "16:9" }],
    ["standard.check", "std-1"],
    ["digital.check", "digital-1"],
  ]);
});

test("media generation runtimes remain stable when test adapters change", () => {
  const imageRuntime = getImageGenerationProvider();
  const videoRuntime = getVideoGenerationProvider();
  const image = { normalizeRequest: () => ({ model: "fake", size: "1x1" }), generate: async () => ({}) };
  const video = {
    classifyProvider: () => VIDEO_PROVIDER_KINDS.STANDARD,
    normalizeRequest: () => ({ kind: VIDEO_PROVIDER_KINDS.STANDARD, model: "fake", size: "1x1", routeProviderKeys: ["fake"] }),
    submit: async () => ({}),
    check: async () => ({}),
  };

  try {
    const replaced = setMediaGenerationProvidersForTests({ image, video });
    assert.equal(replaced.image, imageRuntime);
    assert.equal(replaced.video, videoRuntime);
    assert.equal(imageRuntime.normalizeRequest().model, "fake");
    assert.equal(videoRuntime.normalizeRequest().routeProviderKeys[0], "fake");
  } finally {
    resetMediaGenerationProviders();
  }
});
