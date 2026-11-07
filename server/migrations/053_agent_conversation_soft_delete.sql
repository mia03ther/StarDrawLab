-- User-deleted Global Agent conversations remain recoverable at the data
-- layer while disappearing immediately from the active conversation UI.

BEGIN;

ALTER TABLE agent_conversations
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_active_history
  ON agent_conversations (user_id, surface, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;

COMMIT;
