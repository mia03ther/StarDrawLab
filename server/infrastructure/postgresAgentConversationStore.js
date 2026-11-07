import sql from "../configs/db.js";

export const agentConversationPersistenceValues = ({ messages, runtimeState }) => ({
  messages,
  runtimeState,
});

const publicConversation = (row, { includePayload = false } = {}) => row ? ({
  id: row.id,
  surface: row.surface,
  canvas_id: row.canvas_id,
  title: row.title,
  message_count: Array.isArray(row.messages) ? row.messages.length : Number(row.message_count || 0),
  created_at: row.created_at,
  updated_at: row.updated_at,
  last_message_at: row.last_message_at,
  ...(includePayload ? {
    messages: Array.isArray(row.messages) ? row.messages : [],
    runtime_state: row.runtime_state && typeof row.runtime_state === "object" ? row.runtime_state : {},
  } : {}),
}) : null;

export class PostgresAgentConversationStore {
  async create({ id, userId, surface, canvasId, title }) {
    const [row] = await sql`
      INSERT INTO agent_conversations (id, user_id, surface, canvas_id, title)
      VALUES (${id}, ${userId}, ${surface}, ${canvasId}, ${title})
      RETURNING *
    `;
    return publicConversation(row, { includePayload: true });
  }

  async list({ userId, surface, canvasId, limit }) {
    const rows = surface === "canvas"
      ? await sql`
          SELECT id, surface, canvas_id, title, jsonb_array_length(messages) AS message_count,
                 created_at, updated_at, last_message_at
          FROM agent_conversations
          WHERE user_id = ${userId} AND surface = 'canvas' AND canvas_id = ${canvasId}
            AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT id, surface, canvas_id, title, jsonb_array_length(messages) AS message_count,
                 created_at, updated_at, last_message_at
          FROM agent_conversations
          WHERE user_id = ${userId} AND surface = 'global' AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC
          LIMIT ${limit}
        `;
    return rows.map((row) => publicConversation(row));
  }

  async get({ userId, conversationId }) {
    const [row] = await sql`
      SELECT * FROM agent_conversations
      WHERE id = ${conversationId} AND user_id = ${userId} AND deleted_at IS NULL
      LIMIT 1
    `;
    return publicConversation(row, { includePayload: true });
  }

  async save({ userId, conversationId, title, messages, runtimeState }) {
    const values = agentConversationPersistenceValues({ messages, runtimeState });
    const [row] = await sql`
      UPDATE agent_conversations
      SET title = ${title},
          messages = ${values.messages}::jsonb,
          runtime_state = ${values.runtimeState}::jsonb,
          last_message_at = CASE WHEN ${messages.length}::int > 0 THEN NOW() ELSE last_message_at END,
          updated_at = NOW()
      WHERE id = ${conversationId} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING *
    `;
    return publicConversation(row, { includePayload: true });
  }

  async softDelete({ userId, conversationId }) {
    const [row] = await sql`
      UPDATE agent_conversations
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${conversationId} AND user_id = ${userId} AND deleted_at IS NULL
      RETURNING id
    `;
    return row ? { id: row.id, deleted: true } : null;
  }
}
