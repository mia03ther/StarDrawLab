import { randomUUID } from "node:crypto";

import sql from "../../configs/db.js";
import {
  getCanvasModelPreferences,
  saveCanvasModelPreferences,
  validateCanvasConversationModels,
} from "./modelPreferencesService.js";

const MAX_MESSAGES = 240;
const MAX_MESSAGE_CHARS = 24_000;

const fail = (message, code, status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

const clean = (value, max = 160) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const safeJsonObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const normalizeMessages = (value) => {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_MESSAGES).map((message) => ({
    ...safeJsonObject(message),
    id: clean(message?.id, 100),
    role: ["user", "assistant", "system"].includes(message?.role) ? message.role : "assistant",
    content: String(message?.content || "").slice(0, MAX_MESSAGE_CHARS),
  }));
};

const mapConversation = (row) => row ? ({
  id: row.id,
  canvas_id: row.canvas_id,
  title: row.title,
  messages: row.messages || [],
  model_preferences: row.model_preferences || {},
  runtime_state: row.runtime_state || {},
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_message_at: row.last_message_at,
}) : null;

const assertOwnedCanvas = async ({ userId, canvasId, db = sql }) => {
  const [canvas] = await db`SELECT id FROM canvases WHERE id = ${canvasId} AND user_id = ${userId} LIMIT 1`;
  if (!canvas) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  return canvas;
};

export const createCanvasAgentConversation = async ({ userId, canvasId, title, db = sql } = {}) => {
  const targetCanvasId = clean(canvasId, 64);
  await assertOwnedCanvas({ userId, canvasId: targetCanvasId, db });
  const { preferences } = await getCanvasModelPreferences({ userId, db });
  const id = `caconv_${randomUUID().replaceAll("-", "")}`;
  const [row] = await db`
    INSERT INTO canvas_agent_conversations
      (id, user_id, canvas_id, title, model_preferences)
    VALUES
      (${id}, ${userId}, ${targetCanvasId}, ${clean(title) || "New conversation"}, ${db.json(preferences)})
    RETURNING *
  `;
  return mapConversation(row);
};

export const listCanvasAgentConversations = async ({ userId, canvasId, limit = 30, db = sql } = {}) => {
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 30));
  const rows = await db`
    SELECT id, canvas_id, title, model_preferences, runtime_state,
           created_at, updated_at, last_message_at
    FROM canvas_agent_conversations
    WHERE user_id = ${userId} AND canvas_id = ${clean(canvasId, 64)} AND archived_at IS NULL
    ORDER BY updated_at DESC, id DESC
    LIMIT ${safeLimit}
  `;
  return rows.map(mapConversation);
};

export const getCanvasAgentConversation = async ({ userId, conversationId, db = sql } = {}) => {
  const [row] = await db`
    SELECT * FROM canvas_agent_conversations
    WHERE id = ${clean(conversationId, 80)} AND user_id = ${userId} AND archived_at IS NULL
    LIMIT 1
  `;
  if (!row) fail("Canvas Agent conversation not found", "CANVAS_AGENT_CONVERSATION_NOT_FOUND", 404);
  return mapConversation(row);
};

export const saveCanvasAgentConversation = async ({
  userId,
  conversationId,
  title,
  messages,
  runtimeState,
  modelPreferences,
  rememberModels = true,
  db = sql,
} = {}) => {
  const existing = await getCanvasAgentConversation({ userId, conversationId, db });
  const models = await validateCanvasConversationModels({
    userId,
    preferences: modelPreferences || existing.model_preferences,
    db,
  });
  const normalizedMessages = normalizeMessages(messages ?? existing.messages);
  const [row] = await db`
    UPDATE canvas_agent_conversations
    SET title = ${clean(title) || existing.title || "New conversation"},
        messages = ${db.json(normalizedMessages)},
        runtime_state = ${db.json(safeJsonObject(runtimeState ?? existing.runtime_state))},
        model_preferences = ${db.json(models)},
        last_message_at = ${normalizedMessages.length ? new Date() : existing.last_message_at},
        updated_at = NOW()
    WHERE id = ${existing.id} AND user_id = ${userId} AND archived_at IS NULL
    RETURNING *
  `;
  if (rememberModels) await saveCanvasModelPreferences({ userId, patch: models, db });
  return mapConversation(row);
};

export const archiveCanvasAgentConversation = async ({ userId, conversationId, db = sql } = {}) => {
  const targetId = clean(conversationId, 80);
  const [row] = await db`
    UPDATE canvas_agent_conversations
    SET archived_at = NOW(), updated_at = NOW()
    WHERE id = ${targetId} AND user_id = ${userId} AND archived_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM canvas_agent_runs
        WHERE conversation_id = ${targetId}
          AND user_id = ${userId}
          AND status IN ('queued', 'running', 'waiting_approval', 'waiting_external')
      )
    RETURNING id
  `;
  if (!row) {
    const [existing] = await db`
      SELECT id
      FROM canvas_agent_conversations
      WHERE id = ${targetId} AND user_id = ${userId} AND archived_at IS NULL
      LIMIT 1
    `;
    if (existing) fail(
      "Stop the active Canvas Agent run before deleting this conversation",
      "CANVAS_AGENT_CONVERSATION_ACTIVE",
      409,
    );
    fail("Canvas Agent conversation not found", "CANVAS_AGENT_CONVERSATION_NOT_FOUND", 404);
  }
  return { id: row.id, archived: true };
};

export { mapConversation };
