import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__canvasAgentProviderResponses = [];
globalThis.__canvasAgentProviderRequests = [];
globalThis.__canvasAgentProviderErrors = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/providers/canvasAgentProvider.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/logger.js", "canvas-agent-recovery-test:logger"],
      ["./openAICompatibleStream.js", "canvas-agent-recovery-test:stream"],
      ["../services/creativeLlmConfiguration.js", "canvas-agent-recovery-test:llm-config"],
      ["../services/agentSkillRegistry.js", "canvas-agent-recovery-test:skills"],
      ["../services/visualParameterService.js", "canvas-agent-recovery-test:visual-parameters"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "canvas-agent-recovery-test:logger") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default { error() {}, warn() {}, info() {}, debug() {} };",
      };
    }
    if (url === "canvas-agent-recovery-test:stream") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const stringifyMessageContent = (value) => typeof value === "string" ? value : "";
          export const requestChatCompletionStream = async (request) => {
            globalThis.__canvasAgentProviderRequests.push(request);
            const error = globalThis.__canvasAgentProviderErrors.shift();
            if (error) throw error;
            const content = globalThis.__canvasAgentProviderResponses.shift();
            return { data: { choices: [{ message: { content } }] } };
          };
        `,
      };
    }
    if (url === "canvas-agent-recovery-test:llm-config") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const resolveCreativeLlmConfiguration = async () => ({
            key: process.env.CANVAS_AGENT_KEY,
            baseUrl: process.env.CANVAS_AGENT_BASE_URL,
            model: "gpt-5.6-sol",
            modelKey: "gpt-5.6-sol",
            routeId: 8,
            reasoningEffort: "medium",
          });
          export const withCreativeLlmOptions = (config, body) => ({
            ...body,
            model: config.model,
            reasoning_effort: config.reasoningEffort,
          });
        `,
      };
    }
    if (url === "canvas-agent-recovery-test:skills") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const getAgentSkillRegistry = () => ({ contextForInstruction: async () => '' });",
      };
    }
    if (url === "canvas-agent-recovery-test:visual-parameters") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export const compileConfiguredVisualPrompt = async ({ basePrompt }) => ({ prompt: basePrompt, negativePrompt: '', selections: {} });",
      };
    }
    return nextLoad(url, context);
  },
});

const { generateGlobalAgentPlan } = await import("../providers/canvasAgentProvider.js");

test("global Agent answers conversational requests without inventing a tool task", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  process.env.CANVAS_AGENT_KEY = "test-key";
  globalThis.__canvasAgentProviderRequests.length = 0;
  globalThis.__canvasAgentProviderResponses.length = 0;

  try {
    const result = await generateGlobalAgentPlan({
      userId: "user-1",
      instruction: "你好，你会做什么？",
      tools: [{
        toolKey: "agent.capability.search",
        name: "Search Agent capabilities",
        description: "Search available tools.",
        operationClass: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      language: "zh",
    });

    assert.equal(globalThis.__canvasAgentProviderRequests.length, 0);
    assert.deepEqual(result.calls, []);
    assert.match(result.response, /生成图片和视频/);
    assert.equal(result.provider, "direct");
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
  }
});

test("global Agent repairs a successful provider response that contains non-JSON text", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  const previousBaseUrl = process.env.CANVAS_AGENT_BASE_URL;
  process.env.CANVAS_AGENT_KEY = "test-key";
  process.env.CANVAS_AGENT_BASE_URL = "https://provider.example/v1";
  globalThis.__canvasAgentProviderRequests.length = 0;
  globalThis.__canvasAgentProviderResponses.splice(0, Infinity,
    "I could not produce the requested JSON response.",
    JSON.stringify({
      summary: "List canvases first.",
      execution_mode: "reactive",
      calls: [{
        id: "list_canvas",
        name: "List canvases",
        toolKey: "canvas.list",
        parameters: { limit: 20 },
        reason: "The current canvas id is not trusted context.",
      }],
    }),
  );

  try {
    const result = await generateGlobalAgentPlan({
      userId: "user-1",
      instruction: "Use the current canvas elements to make a video",
      context: { currentPath: "/ai/canvas" },
      tools: [{
        toolKey: "canvas.list",
        name: "List canvases",
        description: "List canvases owned by the current user.",
        operationClass: "read",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer" } },
          additionalProperties: false,
        },
      }],
      language: "en",
    });

    assert.equal(globalThis.__canvasAgentProviderRequests.length, 2);
    assert.match(
      globalThis.__canvasAgentProviderRequests[0].body.messages[0].content,
      /currentPath is only a browser route/i,
    );
    assert.equal(globalThis.__canvasAgentProviderRequests[0].body.model, "gpt-5.6-sol");
    assert.equal(globalThis.__canvasAgentProviderRequests[0].body.reasoning_effort, "medium");
    assert.match(
      globalThis.__canvasAgentProviderRequests[1].body.messages.at(-1).content,
      /valid JSON/i,
    );
    assert.equal(result.calls[0].toolKey, "canvas.list");
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
    if (previousBaseUrl == null) delete process.env.CANVAS_AGENT_BASE_URL;
    else process.env.CANVAS_AGENT_BASE_URL = previousBaseUrl;
  }
});

test("global Agent retries a transient provider outage five times before succeeding", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  const previousBaseUrl = process.env.CANVAS_AGENT_BASE_URL;
  const previousAttempts = process.env.AGENT_PROVIDER_MAX_ATTEMPTS;
  const previousDelay = process.env.AGENT_PROVIDER_RETRY_DELAY_MS;
  process.env.CANVAS_AGENT_KEY = "test-key";
  process.env.CANVAS_AGENT_BASE_URL = "https://provider.example/v1";
  process.env.AGENT_PROVIDER_MAX_ATTEMPTS = "6";
  process.env.AGENT_PROVIDER_RETRY_DELAY_MS = "1";
  globalThis.__canvasAgentProviderRequests.length = 0;
  globalThis.__canvasAgentProviderErrors.splice(0, Infinity,
    ...Array.from({ length: 5 }, () => Object.assign(new Error("temporary provider outage"), {
      status: 503,
      code: "AGENT_PROVIDER_UNAVAILABLE",
    })),
  );
  globalThis.__canvasAgentProviderResponses.splice(0, Infinity, JSON.stringify({
    summary: "Retry succeeded.",
    execution_mode: "reactive",
    calls: [{
      id: "list_canvas",
      name: "List canvases",
      toolKey: "canvas.list",
      parameters: { limit: 20 },
      reason: "Read the user's canvases.",
    }],
  }));

  try {
    const result = await generateGlobalAgentPlan({
      userId: "user-1",
      instruction: "List my canvases",
      tools: [{
        toolKey: "canvas.list",
        name: "List canvases",
        description: "List canvases owned by the current user.",
        operationClass: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      language: "en",
    });

    assert.equal(result.calls[0].toolKey, "canvas.list");
    assert.equal(globalThis.__canvasAgentProviderRequests.length, 6);
  } finally {
    globalThis.__canvasAgentProviderErrors.length = 0;
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
    if (previousBaseUrl == null) delete process.env.CANVAS_AGENT_BASE_URL;
    else process.env.CANVAS_AGENT_BASE_URL = previousBaseUrl;
    if (previousAttempts == null) delete process.env.AGENT_PROVIDER_MAX_ATTEMPTS;
    else process.env.AGENT_PROVIDER_MAX_ATTEMPTS = previousAttempts;
    if (previousDelay == null) delete process.env.AGENT_PROVIDER_RETRY_DELAY_MS;
    else process.env.AGENT_PROVIDER_RETRY_DELAY_MS = previousDelay;
  }
});

test("global Agent classifies repeated non-JSON output as an invalid provider response", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  process.env.CANVAS_AGENT_KEY = "test-key";
  globalThis.__canvasAgentProviderRequests.length = 0;
  globalThis.__canvasAgentProviderResponses.splice(0, Infinity,
    "The first response is plain text.",
    "The repaired response is still plain text.",
  );

  try {
    await assert.rejects(
      generateGlobalAgentPlan({
        userId: "user-1",
        instruction: "List my canvases",
        tools: [{
          toolKey: "canvas.list",
          name: "List canvases",
          description: "List canvases owned by the current user.",
          operationClass: "read",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
        language: "en",
      }),
      (error) => error.code === "AGENT_PROVIDER_INVALID_RESPONSE"
        && error.status === 502
        && error.details?.contentLength > 0,
    );
    assert.equal(globalThis.__canvasAgentProviderRequests.length, 2);
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
  }
});

test("global Agent routes an untemplated image request to freeform and preserves the user prompt", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  process.env.CANVAS_AGENT_KEY = "test-key";
  globalThis.__canvasAgentProviderResponses.splice(0, Infinity, JSON.stringify({
    summary: "Generate an image.",
    execution_mode: "reactive",
    calls: [{
      id: "generate_image",
      toolKey: "media.generate.image",
      parameters: {
        sceneKey: "unrelated_business_template",
        prompt: "A glossy product campaign with a watch on marble",
      },
    }],
  }));

  try {
    const result = await generateGlobalAgentPlan({
      userId: "user-1",
      instruction: "生成一张雨夜里撑伞的猫，不使用模板",
      context: {
        templates: {
          availableImages: [
            { id: "business-1", scene_key: "unrelated_business_template", scene_name: "Product campaign", output_type: "image" },
            { id: "freeform-1", scene_key: "freeform_image", scene_name: "自由图片生成", output_type: "image" },
          ],
          availableVideos: [],
        },
      },
      tools: [{
        toolKey: "media.generate.image",
        name: "Generate image",
        description: "Generate an image.",
        operationClass: "creative",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      language: "zh",
    });

    assert.equal(result.calls[0].parameters.sceneKey, "freeform_image");
    assert.equal(result.calls[0].parameters.userModification, "生成一张雨夜里撑伞的猫，不使用模板");
    assert.equal("templateId" in result.calls[0].parameters, false);
    assert.equal("templateVersion" in result.calls[0].parameters, false);
    assert.equal("prompt" in result.calls[0].parameters, false);
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
  }
});

test("global Agent preserves a user-selected template for a matching generation type", async () => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  process.env.CANVAS_AGENT_KEY = "test-key";
  globalThis.__canvasAgentProviderResponses.splice(0, Infinity, JSON.stringify({
    summary: "Use the selected template.",
    execution_mode: "reactive",
    calls: [{
      id: "generate_image",
      toolKey: "media.generate.image",
      parameters: { sceneKey: "another_template", prompt: "Make the selected template more cinematic" },
    }],
  }));

  try {
    const result = await generateGlobalAgentPlan({
      userId: "user-1",
      instruction: "用这个模板生成一张更有电影感的海报",
      context: {
        requestedTemplate: {
          id: "selected-1",
          scene_key: "selected_template",
          scene_name: "Selected poster",
          output_type: "image",
          version: 3,
          default_model: "gpt-image-2",
        },
      },
      tools: [{
        toolKey: "media.generate.image",
        name: "Generate image",
        description: "Generate an image.",
        operationClass: "creative",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
      language: "zh",
    });

    assert.equal(result.calls[0].parameters.sceneKey, "selected_template");
    assert.equal(result.calls[0].parameters.templateId, "selected-1");
    assert.equal(result.calls[0].parameters.templateVersion, 3);
    assert.equal(result.calls[0].parameters.userModification, "Make the selected template more cinematic");
  } finally {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
  }
});

test("global Agent never retries an authorization rejection or explicit cancellation", async (t) => {
  const previousKey = process.env.CANVAS_AGENT_KEY;
  process.env.CANVAS_AGENT_KEY = "test-key";
  t.after(() => {
    if (previousKey == null) delete process.env.CANVAS_AGENT_KEY;
    else process.env.CANVAS_AGENT_KEY = previousKey;
    globalThis.__canvasAgentProviderErrors.length = 0;
  });
  for (const error of [
    Object.assign(new Error("unauthorized"), { status: 401, retryAfterMs: 0 }),
    Object.assign(new Error("forbidden"), { status: 403, retryAfterMs: 0 }),
    Object.assign(new Error("cancelled"), { name: "AbortError", status: 503, retryAfterMs: 0 }),
  ]) {
    globalThis.__canvasAgentProviderRequests.length = 0;
    globalThis.__canvasAgentProviderErrors.splice(0, Infinity, error);
    globalThis.__canvasAgentProviderResponses.splice(0, Infinity, '{"summary":"must not run","calls":[]}');
    await assert.rejects(generateGlobalAgentPlan({
      userId: "user-1", instruction: "List my canvases", language: "en",
      tools: [{ toolKey: "canvas.list", name: "List canvases", description: "List owned canvases.", operationClass: "read",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    }), (actual) => actual === error);
    assert.equal(globalThis.__canvasAgentProviderRequests.length, 1);
  }
});
