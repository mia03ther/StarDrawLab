-- Persisted DAG workflows and node-level execution state.
-- This migration is intentionally not executed by application startup.

BEGIN;

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  canvas_id             VARCHAR(64),
  title                 VARCHAR(160) NOT NULL DEFAULT 'Untitled workflow',
  request_idempotency_key VARCHAR(128) NOT NULL,
  request_hash          CHAR(64) NOT NULL,
  definition_snapshot   JSONB NOT NULL,
  status                VARCHAR(24) NOT NULL DEFAULT 'queued',
  estimated_points      INTEGER NOT NULL DEFAULT 0,
  points_charged        INTEGER NOT NULL DEFAULT 0,
  error_code            VARCHAR(120),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  CONSTRAINT workflow_runs_key_unique UNIQUE (user_id, request_idempotency_key),
  CONSTRAINT workflow_runs_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workflow_runs_status_check CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  CONSTRAINT workflow_runs_estimate_check CHECK (estimated_points >= 0),
  CONSTRAINT workflow_runs_charged_check CHECK (points_charged >= 0)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_user_updated
  ON workflow_runs (user_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status
  ON workflow_runs (status, updated_at, id);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_key              VARCHAR(128) NOT NULL,
  node_type             VARCHAR(80) NOT NULL,
  depends_on            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,
  points_estimate       INTEGER NOT NULL DEFAULT 0,
  points_charged        INTEGER NOT NULL DEFAULT 0,
  status                VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  result_snapshot       JSONB,
  error_code            VARCHAR(120),
  error_message         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  CONSTRAINT workflow_nodes_key_unique UNIQUE (run_id, node_key),
  CONSTRAINT workflow_nodes_status_check CHECK (status IN ('pending', 'waiting_approval', 'running', 'completed', 'paused', 'failed', 'skipped')),
  CONSTRAINT workflow_nodes_estimate_check CHECK (points_estimate >= 0),
  CONSTRAINT workflow_nodes_charged_check CHECK (points_charged >= 0),
  CONSTRAINT workflow_nodes_attempt_check CHECK (attempt_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_workflow_nodes_ready
  ON workflow_nodes (run_id, status, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_workflow_nodes_dependencies
  ON workflow_nodes USING GIN (depends_on);

CREATE TABLE IF NOT EXISTS workflow_events (
  id                    BIGSERIAL PRIMARY KEY,
  run_id                BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_key              VARCHAR(128),
  event_type            VARCHAR(80) NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_events_run
  ON workflow_events (run_id, id);

COMMIT;

