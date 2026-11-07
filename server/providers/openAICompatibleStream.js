import { normalizeAgentTokenUsage } from "../domain/pricing/agentTokenPricing.js";
import { isAgentRequestCancelled } from "../domain/agent/retryPolicy.js";

const chatCompletionsUrl = (baseUrl) => {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/v\d+$/i.test(normalized)) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
};

const stringifyMessageContent = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      return item?.text || item?.content || "";
    }).join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
};

const extractContentFromChunk = (data) => {
  const choice = data?.choices?.[0] || {};
  return stringifyMessageContent(
    choice.delta?.content ??
    choice.message?.content ??
    choice.text ??
    data?.output_text ??
    ""
  );
};

const extractReasoningFromChunk = (data) => {
  const choice = data?.choices?.[0] || {};
  return stringifyMessageContent(
    choice.delta?.reasoning_content
    ?? choice.message?.reasoning_content
    ?? data?.reasoning_content
    ?? "",
  );
};

const parseSseLine = (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.startsWith("data:")) return null;

  const payload = trimmed.replace(/^data:\s*/, "");
  if (!payload || payload === "[DONE]") return { done: true };

  try {
    return { data: JSON.parse(payload) };
  } catch {
    return { data: null };
  }
};

const classifyProviderHttpError = (status) => {
  if (status === 429) return "AGENT_PROVIDER_RATE_LIMITED";
  if (status >= 500) return "AGENT_PROVIDER_UNAVAILABLE";
  return "AGENT_PROVIDER_REJECTED";
};

const providerHost = (baseUrl) => {
  try {
    return new URL(String(baseUrl || "")).host;
  } catch {
    return "";
  }
};

const isProviderNetworkError = (error) => {
  const message = String(error?.message || "");
  return !error?.status && (
    /fetch failed|failed to fetch|network|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|TLS/i.test(message)
  );
};

const applyProviderHttpErrorMetadata = (error, response) => {
  const status = response.ok ? 502 : response.status;
  error.status = status;
  error.code = response.ok ? "AGENT_PROVIDER_INVALID_RESPONSE" : classifyProviderHttpError(status);
  const retryAfter = String(response.headers.get("retry-after") || "").trim();
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) error.retryAfterMs = Math.min(60_000, seconds * 1_000);
  } else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(retryAfter)) {
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) error.retryAfterMs = Math.min(60_000, Math.max(0, timestamp - Date.now()));
  }
  return error;
};

const parseNonStreamResponse = async (response, label) => {
  const rawText = await response.text();
  let data = {};
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    const err = applyProviderHttpErrorMetadata(
      new Error(`${label} provider returned non-JSON response (${response.status}).`),
      response,
    );
    err.details = rawText.slice(0, 500);
    throw err;
  }

  if (!response.ok) {
    const err = applyProviderHttpErrorMetadata(
      new Error(`${label} provider failed with HTTP ${response.status}.`),
      response,
    );
    err.details = data;
    throw err;
  }

  return {
    data,
    content: stringifyMessageContent(data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.output_text),
    reasoning: stringifyMessageContent(data?.choices?.[0]?.message?.reasoning_content || data?.reasoning_content),
    usage: normalizeAgentTokenUsage(data?.usage),
    streamed: false,
  };
};

const requestChatCompletionStreamRequest = async ({
  baseUrl,
  apiKey,
  body,
  timeoutMs = 45_000,
  label = "LLM",
  includeUsage = false,
}) => {
  const requestBody = {
    ...body,
    stream: true,
    ...(includeUsage ? {
      stream_options: { ...(body?.stream_options || {}), include_usage: true },
    } : {}),
  };
  const response = await fetch(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
    return parseNonStreamResponse(response, label);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let lastChunk = null;
  let usage = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const parsed = parseSseLine(line);
      if (!parsed) continue;
      if (parsed.done) {
        buffer = "";
        break;
      }
      if (!parsed.data) continue;

      lastChunk = parsed.data;
      content += extractContentFromChunk(parsed.data);
      reasoning += extractReasoningFromChunk(parsed.data);
      if (parsed.data?.usage) usage = normalizeAgentTokenUsage(parsed.data.usage);
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseLine(buffer);
    if (parsed?.data) {
      lastChunk = parsed.data;
      content += extractContentFromChunk(parsed.data);
      reasoning += extractReasoningFromChunk(parsed.data);
      if (parsed.data?.usage) usage = normalizeAgentTokenUsage(parsed.data.usage);
    }
  }

  return {
    data: {
      streamed: true,
      choices: [
        {
          message: {
            content,
            reasoning_content: reasoning,
          },
        },
      ],
      last_chunk: lastChunk,
    },
    content,
    reasoning,
    usage: usage || normalizeAgentTokenUsage(lastChunk?.usage),
    streamed: true,
  };
};

export const requestChatCompletionStream = async (options) => {
  try {
    return await requestChatCompletionStreamRequest(options);
  } catch (error) {
    if (isAgentRequestCancelled(error)) throw error;
    if (error?.name === "TimeoutError" || error?.code === 23) {
      throw Object.assign(new Error(`${options?.label || "LLM"} provider timed out.`), {
        status: 504,
        code: "AGENT_PROVIDER_TIMEOUT",
        cause: error,
      });
    }
    if (isProviderNetworkError(error)) {
      const host = providerHost(options?.baseUrl);
      const detail = host ? `${host}: ${String(error.message || "network request failed").slice(0, 180)}` : String(error.message || "network request failed").slice(0, 180);
      throw Object.assign(new Error(`${options?.label || "LLM"} provider connection failed.`), {
        status: 502,
        code: "AGENT_PROVIDER_UNAVAILABLE",
        details: { message: detail },
        cause: error,
      });
    }
    throw error;
  }
};

export { chatCompletionsUrl, stringifyMessageContent };
