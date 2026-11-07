-- Durable PostgreSQL-backed jobs for long-running Agent/workflow work.
-- This migration is intentionally not executed automatically by application code.
-- payload/input_refs/result_snapshot contain JSON parameters and resource references
-- only; media bytes must remain in object storage.

BEGIN;

CREATE TABLE IF NOT EXISTS persistent_jobs (
  id                 BIGSERIAL PRIMARY KEY,
  queue_name         VARCHAR(80) NOT NULL DEFAULT 'default',
  job_type           VARCHAR(120) NOT NULL,
  user_id            VARCHAR(255),
  idempotency_key    VARCHAR(128),
  request_hash       CHAR(64) NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  input_refs         JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             VARCHAR(24) NOT NULL DEFAULT 'queued',
  priority           INTEGER NOT NULL DEFAULT 0,
  attempts           INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  available_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner        VARCHAR(180),
  lease_expires_at   TIMESTAMPTZ,
  last_heartbeat_at  TIMESTAMPTZ,
  result_snapshot    JSONB,
  error_code         VARCHAR(120),
  error_message      TEXT,
  cancel_reason      VARCHAR(500),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  failed_at          TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  CONSTRAINT persistent_jobs_queue_name_check
    CHECK (queue_name ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'),
  CONSTRAINT persistent_jobs_type_check
    CHECK (job_type ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT persistent_jobs_idempotency_key_check
    CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT persistent_jobs_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT persistent_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT persistent_jobs_priority_check
    CHECK (priority BETWEEN -100000 AND 100000),
  CONSTRAINT persistent_jobs_attempts_check
    CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT persistent_jobs_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 25),
  CONSTRAINT persistent_jobs_lease_check
    CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
  CONSTRAINT persistent_jobs_terminal_result_check
    CHECK (status <> 'completed' OR (result_snapshot IS NOT NULL AND completed_at IS NOT NULL)),
  CONSTRAINT persistent_jobs_terminal_failure_check
    CHECK (status <> 'failed' OR failed_at IS NOT NULL),
  CONSTRAINT persistent_jobs_terminal_cancel_check
    CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_persistent_jobs_idempotency
  ON persistent_jobs (queue_name, COALESCE(user_id, ''), idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_persistent_jobs_claimable
  ON persistent_jobs (queue_name, priority DESC, available_at, id)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_persistent_jobs_expired_leases
  ON persistent_jobs (queue_name, lease_expires_at, id)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_persistent_jobs_user_history
  ON persistent_jobs (user_id, created_at DESC, id DESC);

COMMIT;
