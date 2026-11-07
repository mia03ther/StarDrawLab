import assert from "node:assert/strict";
import test from "node:test";

import { resolveCharge } from "../services/pointsService.js";
import { GenerationApplicationService } from "../services/generationApplicationService.js";
import {
  assertTemplateMembership,
  composeImageProviderPrompt,
  deduplicateTemplateUserPrompt,
  normalizeGenerationPrompt,
  normalizeVideoDuration,
  parseVisualParameterSelection,
} from "../domain/generation/generationPolicy.js";

const template = {
  scene_key: "product",
  scene_name: "Product",
  output_type: "image",
  target_provider: "image_provider",
  default_model: "nano-banana-2",
  system_prompt: "system",
  required_membership_tier: "free",
  owner_user_id: null,
};

const videoTemplate = {
  ...template,
  scene_key: "cinematic-video",
  scene_name: "Cinematic video",
  output_type: "video",
  target_provider: "sora",
  default_model: "sora-2",
  default_size: "1280x720",
  default_seconds: 8,
};

const makeDependencies = (overrides = {}) => {
  const calls = [];
  const store = {
    findTemplate: async () => template,
    getMembershipTier: async () => "free",
    findDigitalHumanRole: async () => null,
    reserveImage: async (input) => { calls.push(["reserve", input]); return { isExisting: false, creationId: "91" }; },
    persistImageReference: async (input) => { calls.push(["reference", input]); },
    persistImageTask: async (input) => { calls.push(["persist-image", input]); },
    settleImage: async (input) => { calls.push(["settle", input]); },
    releaseImage: async (input) => { calls.push(["release", input]); return { released: true }; },
    reserveVideo: async (input) => { calls.push(["reserve-video", input]); return { isExisting: false, creationId: "92" }; },
    persistVideoTask: async (input) => { calls.push(["persist-video", input]); },
    releaseVideo: async (input) => { calls.push(["release-video", input]); return { released: true }; },
    ...overrides.store,
  };
  const imageGeneration = {
    normalizeRequest: ({ model, size }) => ({ model: model || "nano-banana-2", size: size || "1024x1024", routeProviderKeys: ["image_provider"] }),
    generate: async (input) => { calls.push(["generate", input]); return { imageBuffer: Buffer.from("result"), imageContentType: "image/png", providerMode: "generations", providerRaw: { id: "safe" } }; },
    ...overrides.imageGeneration,
  };
  const objectStorage = {
    buildObjectKey: (_userId, kind, ext) => `private/${kind}.${ext}`,
    uploadBuffer: async (_buffer, objectKey) => ({ objectKey, url: `/oss-proxy/${objectKey}` }),
    uploadFromUrl: async (_url, objectKey) => ({ objectKey, url: `/oss-proxy/${objectKey}` }),
    getSignedDownloadUrl: (objectKey, expiresSeconds) => `https://oss.invalid/${objectKey}?expires=${expiresSeconds}&signature=test-only`,
    ...overrides.objectStorage,
  };
  const videoGeneration = {
    classifyProvider: (provider) => provider === "heygen_video_agent" ? "digital_human" : "standard",
    normalizeRequest: ({ provider, model, size }) => ({
      kind: provider === "heygen_video_agent" ? "digital_human" : "standard",
      model: model || "sora-2",
      size: size || "1280x720",
      routeProviderKeys: [provider === "heygen_video_agent" ? "heygen_video_agent" : "sora"],
    }),
    submit: async (input) => {
      calls.push(["submit-video", input]);
      return { success: true, taskId: "provider-task-1", providerStatus: "queued" };
    },
    ...overrides.videoGeneration,
  };
  let tick = 1_000;
  return {
    calls,
    service: new GenerationApplicationService({
      store,
      imageGeneration,
      videoGeneration,
      objectStorage,
      modelRouter: async ({ outputType }) => outputType === "video"
        ? { id: "route-video", provider_key: "sora", upstream_model_id: "sora-2" }
        : { id: "route-1", provider_key: "image_provider", upstream_model_id: "nano-banana-2" },
      chargeCatalog: async () => 7,
      visualCompiler: async ({ basePrompt }) => ({ prompt: basePrompt, negativePrompt: "blur", selections: { style: ["clean"] } }),
      grantMembershipBonus: async () => {},
      cleanupObjects: async (input) => { calls.push(["cleanup", input]); },
      isOfflineRenderEnabled: () => false,
      offlineRenderDelayMs: () => 14_000,
      offlineTaskId: (creationId, timestamp) => `offline_${creationId}_${timestamp}`,
      publicAssetUrl: (url) => `https://app.example${url}`,
      log: { info() {}, warn() {}, error() {} },
      now: () => { tick += 10; return tick; },
      ...overrides.dependencies,
    }),
  };
};

test("generation application reserves, invokes, persists and settles one image", async () => {
  const { calls, service } = makeDependencies();
  const result = await service.generateImage({
    userId: "u1",
    idempotencyKey: "image-request-1",
    sceneKey: "product",
    userPrompt: "A clean product photo",
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.creationId, "91");
  assert.equal(result.pointsCharged, 7);
  assert.equal(result.content, "/oss-proxy/private/image.png");
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "generate", "settle"]);
  const settlement = calls.find(([name]) => name === "settle")[1];
  assert.equal(settlement.contentObjectKey, "private/image.png");
  assert.equal(settlement.metadata.upstreamModel, "nano-banana-2");
});

test("generation application returns a pending image task immediately after provider acceptance", async () => {
  const { calls, service } = makeDependencies({
    store: {
      persistImageTask: async (input) => { calls.push(["persist-image", input]); },
    },
    imageGeneration: {
      submit: async (input) => {
        calls.push(["submit-image", input]);
        return {
          success: true,
          taskId: "image-provider-task-1",
          providerStatus: "queued",
          providerRaw: { id: "image-provider-task-1", status: "queued" },
        };
      },
      generate: async () => { throw new Error("the image request must not synchronously poll"); },
    },
  });

  const result = await service.generateImage({
    userId: "u1",
    idempotencyKey: "image-async-request-1",
    sceneKey: "product",
    userPrompt: "A slow product render",
  });

  assert.deepEqual(result, {
    kind: "submitted",
    creationId: "91",
    status: "pending",
    taskId: "image-provider-task-1",
    providerStatus: "queued",
    pointsReserved: 7,
    expiresAt: "1970-01-31T00:00:01.020Z",
  });
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "submit-image", "persist-image"]);
});

test("accepted image tasks keep points reserved when task persistence is temporarily unavailable", async () => {
  const { calls, service } = makeDependencies({
    store: {
      persistImageTask: async (input) => {
        calls.push(["persist-image", input]);
        throw new Error("database temporarily unavailable");
      },
    },
    imageGeneration: {
      submit: async () => ({ success: true, taskId: "image-provider-task-2", providerStatus: "queued" }),
    },
  });

  await assert.rejects(
    service.generateImage({
      userId: "u1",
      idempotencyKey: "image-async-request-2",
      sceneKey: "product",
      userPrompt: "A slow product render",
    }),
    (error) => error.code === "PROVIDER_TASK_PERSISTENCE_FAILED"
      && error.pendingReconciliation === true
      && error.creationId === "91",
  );
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "persist-image", "persist-image", "persist-image"]);
});

test("generation application removes a formatting-only duplicate starter prompt before provider submission", async () => {
  const starterPrompt = "Premium product poster.\n\nSoft studio lighting, clean composition.";
  const systemPrompt = "Premium product poster. Soft studio lighting, clean composition.";
  const { calls, service } = makeDependencies({
    store: {
      findTemplate: async () => ({
        ...template,
        system_prompt: systemPrompt,
        starter_prompt: starterPrompt,
      }),
    },
  });

  await service.generateImage({
    userId: "u1",
    idempotencyKey: "deduplicate-starter-prompt",
    sceneKey: "product",
    userPrompt: " Premium product poster。 soft studio lighting，clean composition！ ",
  });

  const providerRequest = calls.find(([name]) => name === "generate")[1];
  assert.equal(providerRequest.prompt, `${systemPrompt}\n\nAvoid: blur`);
  const reservation = calls.find(([name]) => name === "reserve")[1];
  assert.equal(reservation.metadata.prompt_deduplicated, true);
});

test("generation application releases a reservation when the provider fails", async () => {
  const { calls, service } = makeDependencies({
    imageGeneration: { generate: async () => { throw Object.assign(new Error("provider down"), { code: "UPSTREAM_DOWN" }); } },
  });
  await assert.rejects(
    service.generateImage({
      userId: "u1",
      idempotencyKey: "image-request-2",
      sceneKey: "product",
      userPrompt: "A product photo",
    }),
    (error) => error.code === "UPSTREAM_DOWN",
  );
  assert.deepEqual(calls.map(([name]) => name), ["reserve", "release"]);
  assert.equal(calls[1][1].creationId, "91");
});

test("generation application rejects unsupported reference images before reserving points", async () => {
  const { calls, service } = makeDependencies({
    imageGeneration: { supportsReferenceImages: () => false },
    dependencies: {
      modelRouter: async () => ({
        id: "route-gpt",
        provider_key: "image_provider",
        upstream_model_id: "gpt-image-2",
      }),
    },
  });

  await assert.rejects(
    service.generateImage({
      userId: "u1",
      idempotencyKey: "unsupported-reference-model",
      sceneKey: "product",
      userPrompt: "Edit this image",
      model: "gpt-image-2",
      referenceImages: [{ buffer: Buffer.from("reference"), mimetype: "image/png" }],
    }),
    (error) => error.code === "IMAGE_MODEL_REFERENCE_IMAGES_UNSUPPORTED" && error.status === 400,
  );
  assert.deepEqual(calls, []);
});

test("generation application stages four image references and submits every signed URL", async () => {
  let referenceNumber = 0;
  const { calls, service } = makeDependencies({
    imageGeneration: {
      submit: async (input) => {
        calls.push(["submit-image", input]);
        return { success: true, taskId: "image-provider-task-multi", providerStatus: "queued" };
      },
    },
    objectStorage: {
      buildObjectKey: (_userId, kind, ext) => {
        if (kind === "image_reference") {
          referenceNumber += 1;
          return `private/${kind}-${referenceNumber}.${ext}`;
        }
        return `private/${kind}.${ext}`;
      },
    },
  });

  await service.generateImage({
    userId: "u1",
    idempotencyKey: "image-multi-reference-request",
    sceneKey: "product",
    userPrompt: "Combine all supplied references into one product poster",
    referenceImages: [1, 2, 3, 4].map((number) => ({
      buffer: Buffer.from(`reference-${number}`),
      mimetype: "image/png",
    })),
  });

  const persistence = calls.find(([name]) => name === "reference")[1];
  assert.equal(persistence.referenceImageObjectKeys.length, 4);
  assert.equal(persistence.referenceImageUrls.length, 4);
  const submission = calls.find(([name]) => name === "submit-image")[1];
  assert.deepEqual(submission.referenceImageUrls, [1, 2, 3, 4].map((number) => (
    `https://oss.invalid/private/image_reference-${number}.jpg?expires=1800&signature=test-only`
  )));
  const task = calls.find(([name]) => name === "persist-image")[1];
  assert.equal(task.metadata.referenceImageObjectKeys.length, 4);
  assert.doesNotMatch(JSON.stringify(task.metadata), /signature=test-only/);
});

test("generation application rejects more than four image references before reserving points", async () => {
  const { calls, service } = makeDependencies();
  await assert.rejects(
    service.generateImage({
      userId: "u1",
      idempotencyKey: "too-many-image-references",
      sceneKey: "product",
      userPrompt: "Too many references",
      referenceImages: [1, 2, 3, 4, 5].map(() => ({ buffer: Buffer.from("reference"), mimetype: "image/png" })),
    }),
    (error) => error.code === "TOO_MANY_REFERENCE_IMAGES" && error.status === 400,
  );
  assert.deepEqual(calls, []);
});

test("generation application reserves and durably records a video provider task", async () => {
  const { calls, service } = makeDependencies({
    store: { findTemplate: async () => videoTemplate },
  });
  const result = await service.generateVideo({
    userId: "u1",
    idempotencyKey: "video-request-1",
    sceneKey: "cinematic-video",
    userPrompt: "A slow dolly shot",
    referenceImages: [{ buffer: Buffer.from("reference"), mimetype: "image/jpeg" }],
  });

  assert.equal(result.kind, "submitted");
  assert.equal(result.creationId, "92");
  assert.equal(result.taskId, "provider-task-1");
  assert.deepEqual(calls.map(([name]) => name), ["reserve-video", "submit-video", "persist-video"]);
  const submission = calls.find(([name]) => name === "submit-video")[1];
  assert.equal(submission.imageUrl, "https://oss.invalid/private/video_reference.jpg?expires=1800&signature=test-only");
  assert.deepEqual(submission.imageUrls, ["https://oss.invalid/private/video_reference.jpg?expires=1800&signature=test-only"]);
  const persistence = calls.find(([name]) => name === "persist-video")[1];
  assert.equal(persistence.metadata.modelRouteId, "route-video");
  assert.equal(persistence.metadata.referenceImageUrl, "https://app.example/oss-proxy/private/video_reference.jpg");
  assert.doesNotMatch(JSON.stringify(persistence.metadata), /signature=test-only/);
});

test("generation application releases video points and schedules reference cleanup before provider acceptance", async () => {
  const { calls, service } = makeDependencies({
    store: { findTemplate: async () => videoTemplate },
    videoGeneration: { submit: async () => { throw Object.assign(new Error("provider down"), { code: "UPSTREAM_DOWN" }); } },
  });
  await assert.rejects(
    service.generateVideo({
      userId: "u1",
      idempotencyKey: "video-request-2",
      sceneKey: "cinematic-video",
      userPrompt: "A slow dolly shot",
      referenceImages: [{ buffer: Buffer.from("reference"), mimetype: "image/jpeg" }],
    }),
    (error) => error.code === "UPSTREAM_DOWN",
  );
  assert.deepEqual(calls.map(([name]) => name), ["reserve-video", "release-video", "cleanup"]);
});

test("generation application preserves a rejected video provider response", async () => {
  const { calls, service } = makeDependencies({
    store: { findTemplate: async () => videoTemplate },
    videoGeneration: {
      submit: async () => ({
        success: false,
        status: 422,
        code: "VIDEO_PROVIDER_DURATION_UNSUPPORTED",
        message: "视频模型仅支持 8 秒",
        providerCode: "invalid_duration",
      }),
    },
  });

  await assert.rejects(
    service.generateVideo({
      userId: "u1",
      idempotencyKey: "video-provider-rejection",
      sceneKey: "cinematic-video",
      userPrompt: "A slow dolly shot",
    }),
    (error) => error.status === 422
      && error.code === "VIDEO_PROVIDER_DURATION_UNSUPPORTED"
      && error.providerCode === "invalid_duration"
      && error.message === "视频模型仅支持 8 秒",
  );
  assert.deepEqual(calls.map(([name]) => name), ["reserve-video", "release-video"]);
});

test("generation application keeps points reserved if an accepted provider task cannot be persisted", async () => {
  const { calls, service } = makeDependencies({
    store: {
      findTemplate: async () => videoTemplate,
      persistVideoTask: async (input) => {
        calls.push(["persist-video", input]);
        throw new Error("database temporarily unavailable");
      },
    },
  });
  await assert.rejects(
    service.generateVideo({
      userId: "u1",
      idempotencyKey: "video-request-3",
      sceneKey: "cinematic-video",
      userPrompt: "A slow dolly shot",
    }),
    (error) => error.code === "PROVIDER_TASK_PERSISTENCE_FAILED"
      && error.pendingReconciliation === true
      && error.creationId === "92",
  );
  assert.deepEqual(calls.map(([name]) => name), [
    "reserve-video",
    "submit-video",
    "persist-video",
    "persist-video",
    "persist-video",
  ]);
});

test("generation application keeps a pending video without a task ID in reconciliation", async () => {
  const { calls, service } = makeDependencies({
    store: {
      findTemplate: async () => videoTemplate,
      reserveVideo: async (input) => {
        calls.push(["reserve-video", input]);
        return {
          isExisting: true,
          existing: {
            id: "92",
            status: "pending",
            task_id: null,
            points_reserved: 7,
            meta_info: { request_hash: input.metadata.request_hash },
          },
        };
      },
    },
  });

  const result = await service.generateVideo({
    userId: "u1",
    idempotencyKey: "video-request-reconcile",
    sceneKey: "cinematic-video",
    userPrompt: "A slow dolly shot",
  });

  assert.deepEqual(result, {
    kind: "reconciliation_pending",
    creationId: "92",
    status: "pending",
    pointsReserved: 7,
  });
  assert.deepEqual(calls.map(([name]) => name), ["reserve-video"]);
});

test("generation application records an enabled offline digital-human render without calling a provider", async () => {
  const digitalHumanTemplate = {
    ...videoTemplate,
    target_provider: "heygen_video_agent",
    default_model: "heygen-avatar-iv",
    default_size: "16:9",
    default_seconds: 30,
    preview_video_url: "/oss-proxy/private/demo.mp4",
  };
  const { calls, service } = makeDependencies({
    store: { findTemplate: async () => digitalHumanTemplate },
    dependencies: {
      modelRouter: async () => ({
        id: "route-heygen",
        provider_key: "heygen_video_agent",
        upstream_model_id: "heygen-avatar-iv",
      }),
      isOfflineRenderEnabled: () => true,
    },
  });
  const result = await service.generateVideo({
    userId: "u1",
    idempotencyKey: "video-request-4",
    sceneKey: "digital-human",
    userPrompt: "Present this product",
    requireDigitalHuman: true,
    allowOfflineRender: true,
  });

  assert.equal(result.kind, "submitted");
  assert.match(result.taskId, /^offline_92_/);
  assert.deepEqual(calls.map(([name]) => name), ["reserve-video", "persist-video"]);
  const persistence = calls.find(([name]) => name === "persist-video")[1];
  assert.equal(persistence.metadata.offlineRender.videoUrl, "/oss-proxy/private/demo.mp4");
});

test("generation policy validates prompts, visual JSON, duration and membership", () => {
  assert.equal(normalizeGenerationPrompt("  hello  "), "hello");
  assert.deepEqual(deduplicateTemplateUserPrompt({
    systemPrompt: "Create a clean commercial poster with natural light.",
    starterPrompt: "Create a clean commercial poster, with natural light!",
    userPrompt: " Create a clean commercial poster，with natural light。 ",
  }), {
    prompt: "",
    removed: true,
    reason: "starter_prompt_duplicate",
  });
  assert.deepEqual(deduplicateTemplateUserPrompt({
    systemPrompt: "Create a clean commercial poster with natural light.",
    starterPrompt: "Create a clean commercial poster with natural light.",
    userPrompt: "Create a clean commercial poster with natural light and add a red bottle.",
  }), {
    prompt: "Create a clean commercial poster with natural light and add a red bottle.",
    removed: false,
    reason: null,
  });
  assert.deepEqual(deduplicateTemplateUserPrompt({
    systemPrompt: "Create a clean commercial poster with natural light.",
    starterPrompt: "Create a clean commercial poster with natural light.",
    userPrompt: "Create a clean commercial poster with natural light.\n\nAdd a red bottle.",
  }), {
    prompt: "Add a red bottle.",
    removed: true,
    reason: "starter_prompt_removed_from_user_prompt",
  });
  assert.deepEqual(parseVisualParameterSelection('{"style":["clean"]}'), { style: ["clean"] });
  assert.equal(normalizeVideoDuration({ requestedSeconds: "15", isDigitalHuman: true }), 15);
  assert.throws(() => normalizeVideoDuration({ requestedSeconds: "14", isDigitalHuman: true }), (error) => error.code === "INVALID_VIDEO_DURATION");
  assert.throws(
    () => assertTemplateMembership({ template: { required_membership_tier: "pro" }, userId: "u1", membershipTier: "basic" }),
    (error) => error.code === "TEMPLATE_MEMBERSHIP_REQUIRED",
  );
});

test("image provider prompt keeps user instructions within the upstream UTF-8 budget", () => {
  const systemPrompt = "S".repeat(4_978);
  const userPrompt = "make the bottle red";
  const result = composeImageProviderPrompt({ systemPrompt, userPrompt });

  assert.ok(Buffer.byteLength(result.prompt, "utf8") <= 4_500);
  assert.ok(result.prompt.endsWith(userPrompt));
  assert.equal(result.truncated, true);
  assert.equal(result.originalUtf8Bytes, Buffer.byteLength(`${systemPrompt}\n\n${userPrompt}`, "utf8"));
});

test("image provider prompt truncation preserves valid Unicode", () => {
  const userPrompt = "保留用户要求";
  const result = composeImageProviderPrompt({
    systemPrompt: "高级商业摄影。".repeat(800),
    userPrompt,
  });

  assert.ok(Buffer.byteLength(result.prompt, "utf8") <= 4_500);
  assert.ok(result.prompt.endsWith(userPrompt));
  assert.doesNotMatch(result.prompt, /\uFFFD/);
});

test("server template price matches image reservation, settlement and returned charge", async () => {
  const { calls, service } = makeDependencies({ dependencies: { chargeCatalog: resolveCharge } });
  const result = await service.generateImage({ userId: "u1", idempotencyKey: "flat-template-image", sceneKey: "product", userPrompt: "A product image" });
  assert.equal(calls.find(([name]) => name === "reserve")[1].pointsCost, 18);
  assert.equal(calls.find(([name]) => name === "settle")[1].pointsCost, 18);
  assert.equal(result.pointsCharged, 18);
});

test("server template price matches asynchronous video reservation and accepted result", async () => {
  const { calls, service } = makeDependencies({
    store: { findTemplate: async () => videoTemplate },
    dependencies: { chargeCatalog: resolveCharge },
  });
  const result = await service.generateVideo({ userId: "u1", idempotencyKey: "flat-template-video", sceneKey: "cinematic-video", userPrompt: "A video shot", seconds: 8 });
  assert.equal(calls.find(([name]) => name === "reserve-video")[1].pointsCost, 18);
  assert.equal(result.pointsReserved, 18);
});
