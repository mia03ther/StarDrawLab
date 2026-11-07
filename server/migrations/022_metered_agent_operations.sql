-- Durable, per-call billing and idempotency for synchronous Agent operations.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

ALTER TABLE point_lot_allocations
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS source_id VARCHAR(255);

UPDATE point_lot_allocations
SET source_type = 'creation',
    source_id = creation_id::text
WHERE source_type IS NULL OR source_id IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM point_lot_allocations
    WHERE source_type IS NULL OR source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Point allocation source backfill is incomplete';
  END IF;
END;
$$;

ALTER TABLE point_lot_allocations
  ALTER COLUMN source_type SET NOT NULL,
  ALTER COLUMN source_id SET NOT NULL,
  ALTER COLUMN creation_id DROP NOT NULL;

ALTER TABLE point_lot_allocations
  DROP CONSTRAINT IF EXISTS point_lot_allocations_status_check;
ALTER TABLE point_lot_allocations
  ADD CONSTRAINT point_lot_allocations_status_check
  CHECK (status IN ('held', 'charged', 'released', 'refunded'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_point_lot_allocations_source_lot
  ON point_lot_allocations (source_type, source_id, lot_id);

CREATE INDEX IF NOT EXISTS idx_point_lot_allocations_source_status
  ON point_lot_allocations (user_id, source_type, source_id, status);

CREATE TABLE IF NOT EXISTS metered_agent_operations (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  VARCHAR(255) NOT NULL,
  operation_type           VARCHAR(60) NOT NULL,
  request_idempotency_key  VARCHAR(128) NOT NULL,
  request_hash             CHAR(64) NOT NULL,
  status                   VARCHAR(30) NOT NULL DEFAULT 'initializing',
  points_cost              INTEGER NOT NULL CHECK (points_cost > 0),
  model_key                VARCHAR(100) NOT NULL,
  model_route_id           BIGINT,
  response_snapshot        JSONB,
  error_code               VARCHAR(100),
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at             TIMESTAMPTZ,
  CONSTRAINT metered_agent_operations_type_check
    CHECK (operation_type IN ('canvas_agent_plan', 'digital_human_script_optimizer')),
  CONSTRAINT metered_agent_operations_status_check
    CHECK (status IN ('initializing', 'reserved', 'completed', 'failed')),
  CONSTRAINT metered_agent_operations_request_hash_check
    CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT metered_agent_operations_user_key_unique
    UNIQUE (user_id, request_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_metered_agent_operations_reconciliation
  ON metered_agent_operations (status, updated_at, id)
  WHERE status = 'reserved';

-- Non-zero fail-closed defaults. Root can change these prices later through
-- generation_charge_rules; calls fail if no active matching rule exists.
INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, points_cost, priority, meta_rule)
SELECT 'agent', 'canvas_agent', 'canvas_agent_plan', 'glm-5.2', 1, 100,
       '{"billing_type":"fixed"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM generation_charge_rules
  WHERE output_type = 'agent'
    AND provider = 'canvas_agent'
    AND scene_key = 'canvas_agent_plan'
    AND model = 'glm-5.2'
    AND is_active = TRUE
);

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, points_cost, priority, meta_rule)
SELECT 'agent', 'canvas_agent', 'digital_human_script_optimizer', 'glm-5.2', 1, 100,
       '{"billing_type":"fixed"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM generation_charge_rules
  WHERE output_type = 'agent'
    AND provider = 'canvas_agent'
    AND scene_key = 'digital_human_script_optimizer'
    AND model = 'glm-5.2'
    AND is_active = TRUE
);

COMMIT;
