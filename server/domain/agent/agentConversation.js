const SURFACES = new Set(["global", "canvas"]);
const MAX_MESSAGES = 240;
const MAX_MESSAGES_BYTES = 768 * 1024;
const MAX_RUNTIME_BYTES = 512 * 1024;

const fail = (message, code) => {
  throw Object.assign(new Error(message), { status: 400, code });
};

const jsonClone = (value, fallback, code, maxBytes) => {
  let serialized;
  try {
    serialized = JSON.stringify(value ?? fallback);
  } catch {
    fail("Agent conversation data must be valid JSON", code);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    fail("Agent conversation data is too large", code);
  }
  return JSON.parse(serialized);
};

export const normalizeAgentConversationSurface = (value) => {
  const surface = String(value || "").trim().toLowerCase();
  if (!SURFACES.has(surface)) fail("Unsupported Agent conversation surface", "INVALID_AGENT_CONVERSATION_SURFACE");
  return surface;
};

export const normalizeAgentConversationCanvasId = (surface, value) => {
  const canvasId = String(value || "").trim().slice(0, 80);
  if (surface === "canvas" && !canvasId) fail("canvasId is required", "AGENT_CONVERSATION_CANVAS_REQUIRED");
  return surface === "canvas" ? canvasId : null;
};

export const normalizeAgentConversationTitle = (value) => (
  String(value || "").replace(/\s+/g, " ").trim().slice(0, 160)
);

export const normalizeAgentConversationMessages = (value) => {
  if (!Array.isArray(value)) fail("messages must be an array", "INVALID_AGENT_CONVERSATION_MESSAGES");
  if (value.length > MAX_MESSAGES) fail("Agent conversation has too many messages", "AGENT_CONVERSATION_MESSAGES_LIMIT");
  return jsonClone(value, [], "AGENT_CONVERSATION_MESSAGES_TOO_LARGE", MAX_MESSAGES_BYTES);
};

export const normalizeAgentConversationRuntime = (value) => {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("runtimeState must be an object", "INVALID_AGENT_CONVERSATION_RUNTIME");
  }
  return jsonClone(value, {}, "AGENT_CONVERSATION_RUNTIME_TOO_LARGE", MAX_RUNTIME_BYTES);
};

export const titleFromAgentMessages = (messages, fallback = "New conversation") => {
  const firstUserMessage = messages.find((message) => message?.role === "user" && String(message?.content || "").trim());
  return normalizeAgentConversationTitle(firstUserMessage?.content || fallback);
};
