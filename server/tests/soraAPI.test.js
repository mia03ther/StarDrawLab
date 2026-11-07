import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SORA_API_KEY = "test-only-not-a-real-key";
process.env.SORA_BASE_URL = "https://provider.invalid";
process.env.VIDEO_MODEL = "veo-3-1";

const {
  buildSoraVideoPayload,
  normalizeSoraProviderFailure,
} = await import(`../providers/soraAPI.js?sora-api-test=${Date.now()}`);

test("veo-3-1 submits Mirrmart's fixed 240-frame payload", () => {
  const payload = buildSoraVideoPayload({
    prompt: "A cinematic orbit shot",
    model: "veo-3-1",
    seconds: "8",
    size: "720x1280",
  });

  assert.equal(payload.model, "veo-3-1");
  assert.equal(payload.n_frames, 240);
  assert.equal(typeof payload.n_frames, "number");
  assert.equal("duration" in payload, false);
});

test("multiple video references use Mirrmart's multi-frame contract", () => {
  const payload = buildSoraVideoPayload({
    prompt: "Blend the supplied references into one motion shot",
    model: "veo-3-1",
    size: "1280x720",
    imageUrls: ["https://ref.invalid/1.jpg", "https://ref.invalid/2.jpg", "https://ref.invalid/3.jpg", "https://ref.invalid/4.jpg"],
  });

  assert.equal(payload.input_mode, "multi_frame_reference");
  assert.deepEqual(payload.reference_images, ["https://ref.invalid/1.jpg", "https://ref.invalid/2.jpg", "https://ref.invalid/3.jpg", "https://ref.invalid/4.jpg"]);
  assert.equal("input_reference" in payload, false);
});

test("provider duration errors retain status and become a useful safe message", () => {
  const result = normalizeSoraProviderFailure({
    message: "Request failed with status code 400",
    response: {
      status: 400,
      data: {
        error: {
          code: "invalid_duration",
          message: "veo-3-1 only supports duration=8",
        },
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 422);
  assert.equal(result.code, "VIDEO_PROVIDER_DURATION_UNSUPPORTED");
  assert.equal(result.providerCode, "invalid_duration");
  assert.equal(result.providerStatus, 400);
  assert.equal(result.message, "视频模型仅支持 8 秒");
});

test("unavailable upstream video channels report a service error without exposing the distributor group", () => {
  const result = normalizeSoraProviderFailure({response:{status:503,data:{error:{message:"分组 internal-test 下模型 veo-3-1 无可用渠道（distributor）"}}}});
  assert.equal(result.status,503);
  assert.equal(result.code,"VIDEO_PROVIDER_CHANNEL_UNAVAILABLE");
  assert.match(result.message,/供应商/);
  assert.doesNotMatch(result.message,/internal-test|distributor/);
});
