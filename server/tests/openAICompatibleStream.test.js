import assert from "node:assert/strict";
import test from "node:test";

import { requestChatCompletionStream } from "../providers/openAICompatibleStream.js";

test("non-JSON provider 503 responses are classified as transient Agent unavailability", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("Service Unavailable", {
    status: 503,
    headers: { "Content-Type": "text/html" },
  });

  await assert.rejects(
    requestChatCompletionStream({
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-key",
      body: { model: "gpt-5.6-sol", messages: [] },
      label: "Agent",
    }),
    (error) => error.status === 503 && error.code === "AGENT_PROVIDER_UNAVAILABLE",
  );
});

test("provider network failures retain a safe host-level diagnostic", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };

  await assert.rejects(
    requestChatCompletionStream({
      baseUrl: "https://hkg.apikl.ai/v1",
      apiKey: "test-key",
      body: { model: "gpt-5.6-sol", messages: [] },
      label: "Canvas Agent",
    }),
    (error) => error.status === 502
      && error.code === "AGENT_PROVIDER_UNAVAILABLE"
      && error.details?.message === "hkg.apikl.ai: fetch failed",
  );
});

test("streamed reasoning is kept separate from the final JSON content", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const encoder = new TextEncoder();
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"I should inspect tools first."}}]}\n\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"summary\\":\\"ready\\",\\"calls\\":[]}"}}]}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

  const response = await requestChatCompletionStream({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "test-key",
    body: { model: "gpt-5.6-sol", messages: [] },
    label: "Agent",
  });

  assert.equal(response.content, '{"summary":"ready","calls":[]}');
  assert.equal(response.reasoning, "I should inspect tools first.");
  assert.equal(response.data.choices[0].message.content, response.content);
  assert.equal(response.data.choices[0].message.reasoning_content, response.reasoning);
});

test("stream usage is returned and requested through stream_options", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const encoder = new TextEncoder();
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":25}}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  const response = await requestChatCompletionStream({
    baseUrl: "https://provider.invalid/v1",
    apiKey: "test-key",
    body: { model: "gpt-5.6-sol", messages: [] },
    includeUsage: true,
  });

  assert.deepEqual(requestBody.stream_options, { include_usage: true });
  assert.deepEqual(response.usage, {
    inputTokens: 100,
    outputTokens: 25,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("provider errors do not invent an immediate retry when Retry-After is absent or invalid", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const value of [null, "", " ", "invalid", "-1"]) {
    globalThis.fetch = async () => new Response('{"error":{"message":"forbidden"}}', {
      status: 403,
      headers: { "Content-Type": "application/json", ...(value == null ? {} : { "Retry-After": value }) },
    });
    await assert.rejects(requestChatCompletionStream({ baseUrl: "https://provider.invalid/v1", apiKey: "test", body: {} }),
      (error) => error.status === 403 && !Object.hasOwn(error, "retryAfterMs"));
  }
});

test("provider Retry-After retains explicit zero, seconds and HTTP-date delays with a one-minute cap", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.method(Date, "now", () => Date.parse("2026-11-02T12:00:00Z"));
  for (const [header, expected] of [["0", 0], ["2", 2000], ["999", 60000], ["Mon, 02 Nov 2026 12:00:03 GMT", 3000]]) {
    globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "Retry-After": header } });
    await assert.rejects(requestChatCompletionStream({ baseUrl: "https://provider.invalid/v1", apiKey: "test", body: {} }),
      (error) => error.status === 429 && error.retryAfterMs === expected);
  }
});

test("explicit request cancellation is not converted into a retryable provider timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const cancelled = new DOMException("cancelled", "AbortError");
  globalThis.fetch = async () => { throw cancelled; };
  await assert.rejects(requestChatCompletionStream({ baseUrl: "https://provider.invalid/v1", apiKey: "test", body: {} }),
    (error) => error === cancelled);
});

test("a real request timeout remains a transient provider timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => { throw new DOMException("deadline", "TimeoutError"); };
  await assert.rejects(requestChatCompletionStream({ baseUrl: "https://provider.invalid/v1", apiKey: "test", body: {} }),
    (error) => error.status === 504 && error.code === "AGENT_PROVIDER_TIMEOUT");
});
