-- Durable idempotency for authenticated user mutations that do not already
-- have a domain-specific operation table.

BEGIN;

CREATE TABLE IF NOT EXISTS user_operations (
  id                BIGSERIAL PRIMARY KEY,
  user_id           VARCHAR(255) NOT NULL,
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
  CONSTRAINT user_operations_key_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT user_operations_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT user_operations_status_check
    CHECK (status IN ('claimed', 'completed')),
  CONSTRAINT user_operations_completion_check
    CHECK (
      (status = 'claimed' AND response_snapshot IS NULL AND completed_at IS NULL)
      OR
      (status = 'completed' AND response_snapshot IS NOT NULL AND completed_at IS NOT NULL)
    ),
  CONSTRAINT user_operations_user_key_unique
    UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_user_operations_target
  ON user_operations (target_type, target_id, created_at DESC);

COMMIT;
