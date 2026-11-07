-- Persistent conversation history shared by Global Agent and Canvas Agent.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_conversations (
  id                 VARCHAR(80) PRIMARY KEY,
  user_id            VARCHAR(255) NOT NULL,
  surface            VARCHAR(20) NOT NULL,
  canvas_id          VARCHAR(80),
  title              VARCHAR(160) NOT NULL DEFAULT '',
  messages           JSONB NOT NULL DEFAULT '[]'::jsonb,
  runtime_state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at    TIMESTAMPTZ,
  CONSTRAINT agent_conversations_id_check
    CHECK (id ~ '^agent_[0-9a-f-]{36}$'),
  CONSTRAINT agent_conversations_surface_check
    CHECK (surface IN ('global', 'canvas')),
  CONSTRAINT agent_conversations_canvas_check
    CHECK ((surface = 'global' AND canvas_id IS NULL) OR (surface = 'canvas' AND canvas_id IS NOT NULL)),
  CONSTRAINT agent_conversations_messages_check
    CHECK (jsonb_typeof(messages) = 'array'),
  CONSTRAINT agent_conversations_runtime_check
    CHECK (jsonb_typeof(runtime_state) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_user_surface_history
  ON agent_conversations (user_id, surface, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_canvas_history
  ON agent_conversations (user_id, canvas_id, updated_at DESC, id DESC)
  WHERE surface = 'canvas';

COMMIT;
