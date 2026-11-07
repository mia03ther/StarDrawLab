-- Account-level preferences for the Global Agent composer.
-- The conversation runtime remains independent; this table only stores the
-- user's defaults for the next conversation or device.

BEGIN;

CREATE TABLE IF NOT EXISTS global_agent_preferences (
  user_id       VARCHAR(255) PRIMARY KEY,
  access_mode   VARCHAR(40) NOT NULL DEFAULT 'approve_for_me',
  preferences   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT global_agent_preferences_mode_check
    CHECK (access_mode IN ('ask_for_approval', 'approve_for_me', 'full_access')),
  CONSTRAINT global_agent_preferences_preferences_check
    CHECK (jsonb_typeof(preferences) = 'object')
);

COMMIT;
