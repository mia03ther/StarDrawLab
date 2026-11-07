-- Durable idempotency for sensitive administrator mutations.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

CREATE TABLE IF NOT EXISTS administrator_operations (
  id                BIGSERIAL PRIMARY KEY,
  actor_user_id     VARCHAR(255) NOT NULL,
  actor_role        VARCHAR(16) NOT NULL,
  idempotency_key   VARCHAR(128) NOT NULL,
  action            VARCHAR(120) NOT NULL,
  target_type       VARCHAR(80) NOT NULL,
  target_id         VARCHAR(255) NOT NULL,
  request_hash      CHAR(64) NOT NULL,
  status            VARCHAR(24) NOT NULL DEFAULT 'claimed',
  response_snapshot JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  CONSTRAINT administrator_operations_actor_role_check
    CHECK (actor_role IN ('root', 'admin')),
  CONSTRAINT administrator_operations_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT administrator_operations_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT administrator_operations_status_check
    CHECK (status IN ('claimed', 'completed')),
  CONSTRAINT administrator_operations_completion_check
    CHECK (
      (status = 'claimed' AND response_snapshot IS NULL AND completed_at IS NULL)
      OR
      (status = 'completed' AND response_snapshot IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT administrator_operations_actor_key_unique
    UNIQUE (actor_user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_administrator_operations_target
  ON administrator_operations (target_type, target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_administrator_operations_claimed
  ON administrator_operations (updated_at, id)
  WHERE status = 'claimed';

COMMIT;
