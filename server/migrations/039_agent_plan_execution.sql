-- Durable multi-step Global Agent plans.
-- One-time approval tokens are never stored here. A user confirmation is
-- recorded as a bound approval fact; the worker mints and immediately
-- consumes a short-lived approval token only when it resumes that step.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_plan_runs (
  id                    VARCHAR(80) PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  user_role             VARCHAR(20) NOT NULL,
  membership_tier       VARCHAR(20) NOT NULL DEFAULT 'free',
  session_id            VARCHAR(255) NOT NULL,
  agent_mode            VARCHAR(40) NOT NULL,
  instruction           TEXT NOT NULL,
  language              VARCHAR(8) NOT NULL DEFAULT 'zh',
  summary               VARCHAR(800) NOT NULL,
  plan_snapshot         JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_idempotency_key VARCHAR(128) NOT NULL,
  request_hash          CHAR(64) NOT NULL,
  status                VARCHAR(32) NOT NULL DEFAULT 'queued',
  current_step          INTEGER NOT NULL DEFAULT 0,
  total_steps           INTEGER NOT NULL,
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
  CONSTRAINT agent_plan_runs_role_check
    CHECK (user_role IN ('user', 'admin', 'root')),
  CONSTRAINT agent_plan_runs_tier_check
    CHECK (membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise')),
  CONSTRAINT agent_plan_runs_mode_check
    CHECK (agent_mode IN ('ask_for_approval', 'approve_for_me', 'full_access')),
  CONSTRAINT agent_plan_runs_language_check
    CHECK (language IN ('zh', 'en')),
  CONSTRAINT agent_plan_runs_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_plan_runs_request_key_check
    CHECK (request_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT agent_plan_runs_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_plan_runs_progress_check
    CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT agent_plan_runs_steps_check
    CHECK (total_steps BETWEEN 1 AND 12 AND current_step BETWEEN 0 AND total_steps)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_plan_runs_request_idempotency
  ON agent_plan_runs (user_id, request_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_agent_plan_runs_user_history
  ON agent_plan_runs (user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_agent_plan_runs_active
  ON agent_plan_runs (status, updated_at, id)
  WHERE status IN ('queued', 'running', 'waiting_approval');

CREATE TABLE IF NOT EXISTS agent_plan_steps (
  id                         BIGSERIAL PRIMARY KEY,
  run_id                     VARCHAR(80) NOT NULL REFERENCES agent_plan_runs(id) ON DELETE CASCADE,
  position                   INTEGER NOT NULL,
  call_id                    VARCHAR(80) NOT NULL,
  call_name                  VARCHAR(160) NOT NULL,
  tool_key                   VARCHAR(128) NOT NULL,
  reason                     VARCHAR(500) NOT NULL DEFAULT '',
  parameters                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_parameters        JSONB,
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
  CONSTRAINT agent_plan_steps_position_unique UNIQUE (run_id, position),
  CONSTRAINT agent_plan_steps_call_unique UNIQUE (run_id, call_id),
  CONSTRAINT agent_plan_steps_position_check CHECK (position BETWEEN 1 AND 12),
  CONSTRAINT agent_plan_steps_status_check
    CHECK (status IN ('ready', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  CONSTRAINT agent_plan_steps_digest_check
    CHECK (parameter_digest IS NULL OR parameter_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_plan_steps_idempotency_check
    CHECK (execution_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$')
);

CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_run_position
  ON agent_plan_steps (run_id, position);

COMMIT;
