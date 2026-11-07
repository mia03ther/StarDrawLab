import { randomUUID } from "node:crypto";
import {
  normalizeAgentConversationCanvasId,
  normalizeAgentConversationMessages,
  normalizeAgentConversationRuntime,
  normalizeAgentConversationSurface,
  normalizeAgentConversationTitle,
  titleFromAgentMessages,
} from "../domain/agent/agentConversation.js";
import { PostgresAgentConversationStore } from "../infrastructure/postgresAgentConversationStore.js";

const store = new PostgresAgentConversationStore();
const notFound = () => Object.assign(new Error("Agent conversation not found"), {
  status: 404,
  code: "AGENT_CONVERSATION_NOT_FOUND",
});

export const createAgentConversation = async ({ userId, surface: rawSurface, canvasId: rawCanvasId, title }) => {
  const surface = normalizeAgentConversationSurface(rawSurface);
  const canvasId = normalizeAgentConversationCanvasId(surface, rawCanvasId);
  return store.create({
    id: `agent_${randomUUID()}`,
    userId,
    surface,
    canvasId,
    title: normalizeAgentConversationTitle(title) || "New conversation",
  });
};

export const listAgentConversations = async ({ userId, surface: rawSurface, canvasId: rawCanvasId, limit }) => {
  const surface = normalizeAgentConversationSurface(rawSurface);
  const canvasId = normalizeAgentConversationCanvasId(surface, rawCanvasId);
  return store.list({
    userId,
    surface,
    canvasId,
    limit: Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 30)),
  });
};

export const getAgentConversation = async ({ userId, conversationId }) => {
  const conversation = await store.get({ userId, conversationId: String(conversationId || "").slice(0, 80) });
  if (!conversation) throw notFound();
  return conversation;
};

export const saveAgentConversation = async ({ userId, conversationId, title, messages, runtimeState }) => {
  const normalizedMessages = normalizeAgentConversationMessages(messages);
  const conversation = await store.save({
    userId,
    conversationId: String(conversationId || "").slice(0, 80),
    title: normalizeAgentConversationTitle(title) || titleFromAgentMessages(normalizedMessages),
    messages: normalizedMessages,
    runtimeState: normalizeAgentConversationRuntime(runtimeState),
  });
  if (!conversation) throw notFound();
  return conversation;
};

export const deleteAgentConversation = async ({ userId, conversationId }) => {
  const deleted = await store.softDelete({
    userId,
    conversationId: String(conversationId || "").slice(0, 80),
  });
  if (!deleted) throw notFound();
  return deleted;
};
