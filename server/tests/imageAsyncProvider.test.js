import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.IMAGE_PROVIDER_BASE_URL = "https://www.aimh8.com/agent/openapi/fpbrowser2api";
process.env.SORA_API_KEY = "test-only-not-a-real-key";
process.env.IMAGE_PROVIDER_MODEL = "gpt-image-2";
process.env.IMAGE_PROVIDER_MODELS = "gpt-image-2";
process.env.IMAGE_PROVIDER_REFERENCE_IMAGE_MODELS = "gpt-image-2";
process.env.IMAGE_PROVIDER_POLL_INTERVAL_MS = "500";

const { submitImage, checkImage } = await import(`../providers/imageProvider.js?async-image-test=${Date.now()}`);

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("image submission returns after the provider queues the task", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ id: "image-task-1", status: "queued", model: "gpt-image2-1k" });
  };

  try {
    const result = await submitImage({
      prompt: "A product poster",
      size: "1024x1024",
      model: "gpt-image-2",
    });
    assert.deepEqual({
      success: result.success,
      status: result.status,
      providerStatus: result.providerStatus,
      taskId: result.taskId,
    }, {
      success: true,
      status: "queued",
      providerStatus: "queued",
      taskId: "image-task-1",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://www.aimh8.com/agent/openapi/fpbrowser2api/v1/videos");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image status check normalizes the completed provider result", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      id: "image-task-1",
      status: "completed",
      image_url: "https://oss.example/image.png",
      progress: 100,
    });
  };

  try {
    const result = await checkImage("image-task-1");
    assert.deepEqual({
      success: result.success,
      status: result.status,
      progress: result.progress,
      url: result.url,
    }, {
      success: true,
      status: "completed",
      progress: 100,
      url: "https://oss.example/image.png",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://www.aimh8.com/agent/openapi/fpbrowser2api/v1/videos/image-task-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Mirrmart image requests send the selected aspect ratio with the pixel size", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return jsonResponse({ id: "ratio-task-1", status: "queued" });
  };

  try {
    await submitImage({ prompt: "landscape poster", model: "gpt-image-2", size: "1024x576" });
    await submitImage({ prompt: "portrait poster", model: "gpt-image-2", size: "576x1024" });
    assert.deepEqual(requests.map(({ body }) => ({ size: body.size, aspect_ratio: body.aspect_ratio })), [
      { size: "1024x576", aspect_ratio: "16:9" },
      { size: "576x1024", aspect_ratio: "9:16" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
