import assert from "node:assert/strict";
import test from "node:test";

// This test module never calls a real provider. The fake key only makes the
// provider take its HTTP path; fetch is replaced before the module is loaded.
process.env.NODE_ENV = "test";
process.env.IMAGE_PROVIDER_KEY = "test-only-not-a-real-key";
process.env.IMAGE_PROVIDER_BASE_URL = "https://provider.invalid/v1";
process.env.IMAGE_PROVIDER_MODEL = "gpt-image-2";
process.env.IMAGE_PROVIDER_FALLBACK_MODEL = "gpt-image-2";
process.env.IMAGE_PROVIDER_MODELS = "gpt-image-2";
process.env.IMAGE_PROVIDER_REFERENCE_IMAGE_MODELS = "gpt-image-2";

const { generateImage } = await import(`../providers/imageProvider.js?image-provider-test=${Date.now()}`);

const reference = {
  buffer: Buffer.from("fake-reference-image"),
  mimetype: "image/png",
  originalname: "reference.png",
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("an unavailable legacy model is rejected instead of silently routing to GPT Image 2", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ data: [{ url: "https://provider.invalid/should-not-exist.png" }] });
  };

  try {
    await assert.rejects(
      generateImage("edit this", "1024x1024", [reference], "nano-banana-2"),
      (error) => {
        assert.equal(error.code, "IMAGE_MODEL_UNAVAILABLE");
        assert.equal(error.status, 400);
        return true;
      },
    );
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("another retired image model is rejected before any provider call", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return jsonResponse({ data: [{ url: "https://provider.invalid/should-not-exist.png" }] });
  };

  try {
    await assert.rejects(
      generateImage("edit this", "1024x1024", [reference], "gemini-3-pro-image"),
      (error) => error.code === "IMAGE_MODEL_UNAVAILABLE",
    );
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reference-image 504 HTML is surfaced as an uncertain, non-retryable provider failure", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(
      "<html><title>504 Gateway Time-out</title></html>",
      { status: 504, headers: { "content-type": "text/html" } },
    );
  };

  try {
    await assert.rejects(
      generateImage("edit this", "1024x1024", [reference], "gpt-image-2"),
      (error) => {
        assert.equal(error.code, "IMAGE_PROVIDER_UPSTREAM_TIMEOUT");
        assert.equal(error.status, 504);
        assert.equal(error.retryable, false);
        assert.equal(error.outcomeUnknown, true);
        assert.match(error.message, /timed out/i);
        return true;
      },
    );
    assert.equal(requests.length, 1, "a gateway timeout must never trigger a second paid request");
    assert.equal(requests[0].url, "https://provider.invalid/v1/images/edits");
    assert.equal(requests[0].init.body.get("model"), "gpt-image-2");
    assert.equal(requests[0].init.body.get("image").name, "reference.png");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a structured 503 is not retried when no distinct fallback model exists", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ error: { message: "no available channel" } }, 503);
  };

  try {
    await assert.rejects(
      generateImage("edit this", "1024x1024", [reference], "gpt-image-2"),
      (error) => error.status === 503,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://provider.invalid/v1/images/edits");
    assert.equal(requests[0].init.body.get("model"), "gpt-image-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a gateway timeout is never retried", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response("<html><h1>504 Gateway Time-out</h1></html>", { status: 504 });
  };

  try {
    await assert.rejects(
      generateImage("edit this", "1024x1024", [reference], "gpt-image-2"),
      (error) => error.code === "IMAGE_PROVIDER_UPSTREAM_TIMEOUT" && error.outcomeUnknown === true,
    );
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
