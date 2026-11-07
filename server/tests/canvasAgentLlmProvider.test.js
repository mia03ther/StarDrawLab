import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__canvasAgentLlmResponses = [];
globalThis.__canvasAgentLlmRequests = [];
globalThis.__canvasAgentLlmErrors = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/modules/canvas-agent/llmProvider.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../../providers/openAICompatibleStream.js", "canvas-agent-llm-test:stream"],
      ["../../services/modelConfigurationService.js", "canvas-agent-llm-test:model-route"],
      ["../../configs/logger.js", "canvas-agent-llm-test:logger"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "canvas-agent-llm-test:stream") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const requestChatCompletionStream = async (request) => {
            globalThis.__canvasAgentLlmRequests.push(request);
            const error = globalThis.__canvasAgentLlmErrors.shift();
            if (error) throw error;
            return { content: globalThis.__canvasAgentLlmResponses.shift() || "" };
          };
        `,
      };
    }
    if (url === "canvas-agent-llm-test:model-route") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const resolveActiveModelRoute = async () => ({
            id: 47,
            provider_key: "canvas_agent",
            upstream_model_id: "gpt-5.6-sol",
            route_config: { reasoning_effort: "medium" },
          });
        `,
      };
    }
    if (url === "canvas-agent-llm-test:logger") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default { warn() {}, error() {}, info() {}, debug() {} };",
      };
    }
    return nextLoad(url, context);
  },
});

const { requestCanvasAgentJson } = await import("../modules/canvas-agent/llmProvider.js");

const request = () => requestCanvasAgentJson({
  userId: "user-1",
  modelKey: "gpt-5.6-sol",
  system: "Return one JSON action.",
  messages: [{ role: "user", content: "Create a workflow" }],
});

test("Canvas Agent repairs one successful provider response that is not valid JSON", async () => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity,
    "I will create the workflow now.",
    JSON.stringify({ action: "tool", tool_key: "workflow.create", parameters: { name: "Poster" } }),
  );

  try {
    const result = await request();
    assert.equal(result.data.action, "tool");
    assert.equal(result.data.tool_key, "workflow.create");
    assert.equal(globalThis.__canvasAgentLlmRequests.length, 2);
    assert.match(
      globalThis.__canvasAgentLlmRequests[1].body.messages.at(-1).content,
      /only one valid JSON object/i,
    );
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
  }
});

test("Canvas Agent rejects two consecutive invalid structured responses", async () => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity, "plain text", "still plain text");

  try {
    await assert.rejects(request(), (error) => (
      error.code === "CANVAS_AGENT_INVALID_RESPONSE"
      && error.status === 502
      && error.details?.attempts === 2
    ));
    assert.equal(globalThis.__canvasAgentLlmRequests.length, 2);
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
  }
});

test("Canvas Agent retries a JSON-format rejection without response_format", async () => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmErrors.splice(0, Infinity, Object.assign(new Error("provider rejected response_format"), {
    status: 400,
    code: "AGENT_PROVIDER_REJECTED",
    details: { error: { message: "response_format is not supported" } },
  }));
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity,
    JSON.stringify({ action: "tool", tool_key: "workflow.read", parameters: { workflowId: "workflow-1" } }),
  );

  try {
    const result = await requestCanvasAgentJson({
      userId: "user-1",
      modelKey: "gpt-5.6-sol",
      system: "Return one JSON action.",
      messages: [{ role: "user", content: "Read the workflow" }],
      maxTokens: 4_000,
    });
    assert.equal(result.data.tool_key, "workflow.read");
    assert.equal(globalThis.__canvasAgentLlmRequests.length, 2);
    assert.deepEqual(globalThis.__canvasAgentLlmRequests[0].body.response_format, { type: "json_object" });
    assert.equal(globalThis.__canvasAgentLlmRequests[1].body.response_format, undefined);
  } finally {
    globalThis.__canvasAgentLlmErrors.length = 0;
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
  }
});

test("Canvas Agent retries a transient provider outage five times before succeeding", async () => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  const previousAttempts = process.env.AGENT_PROVIDER_MAX_ATTEMPTS;
  const previousDelay = process.env.AGENT_PROVIDER_RETRY_DELAY_MS;
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  process.env.AGENT_PROVIDER_MAX_ATTEMPTS = "6";
  process.env.AGENT_PROVIDER_RETRY_DELAY_MS = "1";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmErrors.splice(0, Infinity,
    ...Array.from({ length: 5 }, () => Object.assign(new Error("temporary provider outage"), {
      status: 503,
      code: "AGENT_PROVIDER_UNAVAILABLE",
    })),
  );
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity, JSON.stringify({
    action: "tool",
    tool_key: "workflow.read",
    parameters: { workflowId: "workflow-1" },
  }));

  try {
    const result = await request();
    assert.equal(result.data.tool_key, "workflow.read");
    assert.equal(globalThis.__canvasAgentLlmRequests.length, 6);
  } finally {
    globalThis.__canvasAgentLlmErrors.length = 0;
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
    if (previousAttempts == null) delete process.env.AGENT_PROVIDER_MAX_ATTEMPTS;
    else process.env.AGENT_PROVIDER_MAX_ATTEMPTS = previousAttempts;
    if (previousDelay == null) delete process.env.AGENT_PROVIDER_RETRY_DELAY_MS;
    else process.env.AGENT_PROVIDER_RETRY_DELAY_MS = previousDelay;
  }
});

test("Canvas Agent caps requested output by the configured context window", async () => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  const previousWindow = process.env.CANVAS_AGENT_CONTEXT_WINDOW_TOKENS;
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  process.env.CANVAS_AGENT_CONTEXT_WINDOW_TOKENS = "4096";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity,
    JSON.stringify({ action: "tool", tool_key: "workflow.create", parameters: { name: "Poster" } }),
  );

  try {
    await requestCanvasAgentJson({
      userId: "user-1",
      modelKey: "gpt-5.6-sol",
      system: "Return one JSON action.",
      messages: [{ role: "user", content: "small request" }],
      maxTokens: 32_000,
    });
    assert.ok(globalThis.__canvasAgentLlmRequests[0].body.max_tokens < 32_000);
    assert.ok(globalThis.__canvasAgentLlmRequests[0].body.max_tokens >= 512);
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
    if (previousWindow == null) delete process.env.CANVAS_AGENT_CONTEXT_WINDOW_TOKENS;
    else process.env.CANVAS_AGENT_CONTEXT_WINDOW_TOKENS = previousWindow;
  }
});

test("Canvas Agent never replays authorization failures or cancellation even with retry metadata", async (t) => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  t.after(() => {
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
    globalThis.__canvasAgentLlmErrors.length = 0;
  });
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  for (const error of [
    Object.assign(new Error("unauthorized"), { status: 401, retryAfterMs: 0 }),
    Object.assign(new Error("forbidden"), { status: 403, retryAfterMs: 0 }),
    Object.assign(new Error("cancelled"), { name: "AbortError", status: 503, retryAfterMs: 0 }),
  ]) {
    globalThis.__canvasAgentLlmRequests.length = 0;
    globalThis.__canvasAgentLlmErrors.splice(0, Infinity, error);
    globalThis.__canvasAgentLlmResponses.splice(0, Infinity, '{"action":"finish","summary":"must not run"}');
    await assert.rejects(request(), (actual) => actual === error);
    assert.equal(globalThis.__canvasAgentLlmRequests.length, 1);
  }
});

test("Canvas Agent still retries rate limiting with a valid explicit retry delay", async (t) => {
  const previousKey = process.env.CANVAS_AGENT_LLM_API_KEY;
  t.after(() => {
    if (previousKey == null) delete process.env.CANVAS_AGENT_LLM_API_KEY;
    else process.env.CANVAS_AGENT_LLM_API_KEY = previousKey;
    globalThis.__canvasAgentLlmErrors.length = 0;
  });
  process.env.CANVAS_AGENT_LLM_API_KEY = "test-key";
  globalThis.__canvasAgentLlmRequests.length = 0;
  globalThis.__canvasAgentLlmErrors.splice(0, Infinity, Object.assign(new Error("busy"), { status: 429, retryAfterMs: 0 }));
  globalThis.__canvasAgentLlmResponses.splice(0, Infinity, '{"action":"finish","summary":"ready"}');
  assert.equal((await request()).data.summary, "ready");
  assert.equal(globalThis.__canvasAgentLlmRequests.length, 2);
});
