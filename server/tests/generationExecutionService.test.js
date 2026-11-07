import assert from "node:assert/strict";
import test from "node:test";

import { GenerationExecutionService } from "../services/generationExecutionService.js";

const makeService = ({ imageResult = { kind: "completed" }, videoError = null } = {}) => {
  const calls = [];
  const governor = {
    admit: async (input) => {
      calls.push(["admit", input]);
      return { admitted: true, leaseId: "lease-1" };
    },
    complete: async (input) => { calls.push(["complete", input]); },
    release: async (input) => { calls.push(["release", input]); },
  };
  const generationApplication = {
    generateImage: async (input) => { calls.push(["image", input]); return imageResult; },
    generateVideo: async (input) => {
      calls.push(["video", input]);
      if (videoError) throw videoError;
      return { kind: "submitted" };
    },
  };
  return {
    calls,
    service: new GenerationExecutionService({
      generationApplication,
      governor,
      log: { error() {} },
    }),
  };
};

test("direct image generation uses shared paid-tier admission before provider work", async () => {
  const { calls, service } = makeService();
  const result = await service.generateImage({
    userId: "paid-user",
    membershipTier: "PRO",
    idempotencyKey: "image-request-1",
    sceneKey: "product",
  });

  assert.deepEqual(result, { kind: "completed" });
  assert.deepEqual(calls.map(([name]) => name), ["admit", "image", "complete"]);
  assert.deepEqual(calls[0][1], {
    userId: "paid-user",
    membershipTier: "pro",
    operationKey: "generation.image",
    queueName: "media-generation",
    idempotencyKey: "image-request-1",
    leaseDurationMs: 30 * 60 * 1000,
    metadata: { source: "direct_media_generation", sceneKey: "product" },
  });
  assert.equal(calls[1][1].membershipTier, undefined);
});

test("direct video generation releases shared capacity while preserving provider errors", async () => {
  const providerError = Object.assign(new Error("provider down"), { code: "UPSTREAM_DOWN" });
  const { calls, service } = makeService({ videoError: providerError });

  await assert.rejects(
    service.generateVideo({
      userId: "paid-user",
      membershipTier: "max",
      idempotencyKey: "video-request-1",
      sceneKey: "cinematic-video",
    }),
    (error) => error === providerError,
  );
  assert.deepEqual(calls.map(([name]) => name), ["admit", "video", "release"]);
  assert.equal(calls[2][1].outcome, "failed");
  assert.equal(calls[2][1].error, providerError);
});

test("direct generation still works when the shared governor is disabled", async () => {
  const calls = [];
  const service = new GenerationExecutionService({
    generationApplication: {
      generateImage: async (input) => { calls.push(input); return { kind: "completed" }; },
      generateVideo: async () => ({ kind: "submitted" }),
    },
    governor: null,
  });

  assert.deepEqual(await service.generateImage({ userId: "u1", sceneKey: "product" }), { kind: "completed" });
  assert.equal(calls.length, 1);
});
