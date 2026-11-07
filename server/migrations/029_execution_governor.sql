-- Shared, database-backed admission control for Agent, MCP and workflow work.
-- This migration is intentionally not executed by application startup. Apply
-- it during the controlled pre-launch migration window, then set
-- EXECUTION_GOVERNOR_ENABLED=true.

BEGIN;

CREATE TABLE IF NOT EXISTS execution_governor_policies (
  id                 BIGSERIAL PRIMARY KEY,
  membership_tier    VARCHAR(20) NOT NULL,
  operation_key      VARCHAR(128) NOT NULL,
  max_per_minute     INTEGER NOT NULL CHECK (max_per_minute > 0),
  max_concurrent     INTEGER NOT NULL CHECK (max_concurrent > 0),
  max_queue_depth    INTEGER NOT NULL CHECK (max_queue_depth > 0),
  daily_quota        INTEGER NOT NULL CHECK (daily_quota > 0),
  lease_duration_ms  INTEGER NOT NULL DEFAULT 1800000
    CHECK (lease_duration_ms BETWEEN 10000 AND 86400000),
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT execution_governor_tier_check
    CHECK (membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise')),
  CONSTRAINT execution_governor_operation_check
    CHECK (operation_key = '*' OR operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT execution_governor_policy_unique
    UNIQUE (membership_tier, operation_key)
);

CREATE INDEX IF NOT EXISTS idx_execution_governor_policy_lookup
  ON execution_governor_policies (membership_tier, operation_key, enabled);

CREATE TABLE IF NOT EXISTS execution_governor_leases (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            VARCHAR(255) NOT NULL,
  membership_tier    VARCHAR(20) NOT NULL,
  operation_key      VARCHAR(128) NOT NULL,
  queue_name         VARCHAR(80) NOT NULL DEFAULT 'default',
  idempotency_key    VARCHAR(128),
  state              VARCHAR(20) NOT NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message      VARCHAR(2000),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  CONSTRAINT execution_governor_lease_tier_check
    CHECK (membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise')),
  CONSTRAINT execution_governor_lease_operation_check
    CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT execution_governor_lease_queue_check
    CHECK (queue_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  CONSTRAINT execution_governor_lease_state_check
    CHECK (state IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT execution_governor_lease_idempotency_check
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT execution_governor_lease_running_check
    CHECK (state NOT IN ('queued', 'running') OR expires_at IS NOT NULL),
  CONSTRAINT execution_governor_lease_terminal_check
    CHECK (state IN ('queued', 'running') OR completed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_governor_lease_idempotency
  ON execution_governor_leases (user_id, operation_key, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_execution_governor_lease_counts
  ON execution_governor_leases (user_id, operation_key, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_governor_lease_expiry
  ON execution_governor_leases (state, expires_at)
  WHERE state IN ('queued', 'running');

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS execution_lease_id BIGINT
    REFERENCES execution_governor_leases(id);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_execution_lease
  ON workflow_runs (execution_lease_id)
  WHERE execution_lease_id IS NOT NULL;

-- Conservative, editable defaults. These are operational safety caps, not
-- product promises; root may change them before launch through the admin
-- configuration surface added in a later migration.
INSERT INTO execution_governor_policies
  (membership_tier, operation_key, max_per_minute, max_concurrent,
   max_queue_depth, daily_quota, lease_duration_ms, metadata)
VALUES
  ('free',       '*',  5, 1,  2,   50, 1800000, '{"source":"safe_default"}'::jsonb),
  ('basic',      '*', 10, 2,  5,  200, 1800000, '{"source":"safe_default"}'::jsonb),
  ('pro',        '*', 20, 4, 10,  500, 1800000, '{"source":"safe_default"}'::jsonb),
  ('max',        '*', 40, 8, 20, 1000, 1800000, '{"source":"safe_default"}'::jsonb),
  ('enterprise', '*',120,16, 50, 5000, 1800000, '{"source":"safe_default"}'::jsonb)
ON CONFLICT (membership_tier, operation_key) DO NOTHING;

COMMIT;
