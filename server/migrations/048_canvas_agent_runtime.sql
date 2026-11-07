-- Independent Canvas Agent runtime and account-level canvas model preferences.
-- This migration is intentionally not executed by application startup.

BEGIN;

CREATE TABLE IF NOT EXISTS canvas_model_preferences (
  user_id             VARCHAR(255) PRIMARY KEY,
  text_model_key      VARCHAR(100),
  image_model_key     VARCHAR(100),
  video_model_key     VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canvas_agent_conversations (
  id                  VARCHAR(80) PRIMARY KEY,
  user_id             VARCHAR(255) NOT NULL,
  canvas_id           VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  title               VARCHAR(160) NOT NULL DEFAULT '',
  messages            JSONB NOT NULL DEFAULT '[]'::jsonb,
  model_preferences   JSONB NOT NULL DEFAULT '{}'::jsonb,
  runtime_state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at     TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  CONSTRAINT canvas_agent_conversations_id_check
    CHECK (id ~ '^caconv_[0-9a-f]{32}$'),
  CONSTRAINT canvas_agent_conversations_messages_check
    CHECK (jsonb_typeof(messages) = 'array'),
  CONSTRAINT canvas_agent_conversations_models_check
    CHECK (jsonb_typeof(model_preferences) = 'object'),
  CONSTRAINT canvas_agent_conversations_runtime_check
    CHECK (jsonb_typeof(runtime_state) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_canvas_agent_conversations_history
  ON canvas_agent_conversations (user_id, canvas_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS canvas_agent_runs (
  id                    VARCHAR(80) PRIMARY KEY,
  conversation_id       VARCHAR(80) NOT NULL REFERENCES canvas_agent_conversations(id) ON DELETE CASCADE,
  user_id               VARCHAR(255) NOT NULL,
  canvas_id             VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  user_role             VARCHAR(20) NOT NULL DEFAULT 'user',
  membership_tier       VARCHAR(20) NOT NULL DEFAULT 'free',
  agent_mode            VARCHAR(40) NOT NULL,
  text_model_key        VARCHAR(100) NOT NULL,
  image_model_key       VARCHAR(100),
  video_model_key       VARCHAR(100),
  instruction           TEXT NOT NULL,
  language              VARCHAR(8) NOT NULL DEFAULT 'zh',
  context_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_summary         TEXT,
  request_idempotency_key VARCHAR(128) NOT NULL,
  request_hash          CHAR(64) NOT NULL,
  status                VARCHAR(32) NOT NULL DEFAULT 'queued',
  current_step          INTEGER NOT NULL DEFAULT 0,
  progress              INTEGER NOT NULL DEFAULT 0,
  active_job_id         BIGINT REFERENCES persistent_jobs(id),
  error_code            VARCHAR(120),
  error_message         VARCHAR(500),
  cancel_reason         VARCHAR(500),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  CONSTRAINT canvas_agent_runs_id_check
    CHECK (id ~ '^carun_[0-9a-f]{32}$'),
  CONSTRAINT canvas_agent_runs_role_check
    CHECK (user_role IN ('user', 'admin', 'root')),
  CONSTRAINT canvas_agent_runs_tier_check
    CHECK (membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise')),
  CONSTRAINT canvas_agent_runs_mode_check
    CHECK (agent_mode IN ('ask_for_approval', 'approve_for_me', 'full_access')),
  CONSTRAINT canvas_agent_runs_language_check
    CHECK (language IN ('zh', 'en')),
  CONSTRAINT canvas_agent_runs_context_check
    CHECK (jsonb_typeof(context_snapshot) = 'object'),
  CONSTRAINT canvas_agent_runs_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_external', 'completed', 'failed', 'cancelled')),
  CONSTRAINT canvas_agent_runs_request_key_check
    CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT canvas_agent_runs_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT canvas_agent_runs_progress_check
    CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT canvas_agent_runs_step_check
    CHECK (current_step BETWEEN 0 AND 240)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_agent_runs_idempotency
  ON canvas_agent_runs (user_id, request_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_canvas_agent_runs_conversation
  ON canvas_agent_runs (conversation_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_canvas_agent_runs_active
  ON canvas_agent_runs (status, updated_at, id)
  WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_external');

CREATE TABLE IF NOT EXISTS canvas_agent_steps (
  id                         BIGSERIAL PRIMARY KEY,
  run_id                     VARCHAR(80) NOT NULL REFERENCES canvas_agent_runs(id) ON DELETE CASCADE,
  position                   INTEGER NOT NULL,
  thought                    VARCHAR(1200) NOT NULL DEFAULT '',
  tool_key                   VARCHAR(128),
  parameters                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot            JSONB,
  status                     VARCHAR(32) NOT NULL DEFAULT 'ready',
  requires_approval          BOOLEAN NOT NULL DEFAULT FALSE,
  approval_reason_code       VARCHAR(120),
  parameter_digest           CHAR(64),
  approved_by_user_id        VARCHAR(255),
  approved_at                TIMESTAMPTZ,
  approval_consumed_at       TIMESTAMPTZ,
  execution_idempotency_key  VARCHAR(128) NOT NULL,
  error_code                 VARCHAR(120),
  error_message              VARCHAR(500),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at                 TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  failed_at                  TIMESTAMPTZ,
  CONSTRAINT canvas_agent_steps_position_unique UNIQUE (run_id, position),
  CONSTRAINT canvas_agent_steps_position_check CHECK (position BETWEEN 1 AND 240),
  CONSTRAINT canvas_agent_steps_parameters_check CHECK (jsonb_typeof(parameters) = 'object'),
  CONSTRAINT canvas_agent_steps_status_check
    CHECK (status IN ('ready', 'running', 'waiting_approval', 'waiting_external', 'completed', 'failed', 'cancelled')),
  CONSTRAINT canvas_agent_steps_digest_check
    CHECK (parameter_digest IS NULL OR parameter_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT canvas_agent_steps_idempotency_check
    CHECK (execution_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$')
);

CREATE INDEX IF NOT EXISTS idx_canvas_agent_steps_run_position
  ON canvas_agent_steps (run_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_agent_steps_execution_key
  ON canvas_agent_steps (execution_idempotency_key);

CREATE TABLE IF NOT EXISTS canvas_agent_events (
  id                  BIGSERIAL PRIMARY KEY,
  run_id              VARCHAR(80) NOT NULL REFERENCES canvas_agent_runs(id) ON DELETE CASCADE,
  user_id             VARCHAR(255) NOT NULL,
  event_type          VARCHAR(80) NOT NULL,
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canvas_agent_events_payload_check CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_canvas_agent_events_stream
  ON canvas_agent_events (run_id, id);

ALTER TABLE canvas_agent_runs
  DROP CONSTRAINT IF EXISTS canvas_agent_runs_step_check;
ALTER TABLE canvas_agent_runs
  ADD CONSTRAINT canvas_agent_runs_step_check
  CHECK (current_step BETWEEN 0 AND 240);

ALTER TABLE canvas_agent_steps
  DROP CONSTRAINT IF EXISTS canvas_agent_steps_position_check;
ALTER TABLE canvas_agent_steps
  ADD CONSTRAINT canvas_agent_steps_position_check
  CHECK (position BETWEEN 1 AND 240);

COMMIT;
