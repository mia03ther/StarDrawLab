-- Durable provider-result snapshots and retry state for Agent billing.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

ALTER TABLE metered_agent_operations
  ADD COLUMN IF NOT EXISTS provider_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_error TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_alerted_at TIMESTAMPTZ;

ALTER TABLE metered_agent_operations
  DROP CONSTRAINT IF EXISTS metered_agent_operations_status_check;
ALTER TABLE metered_agent_operations
  ADD CONSTRAINT metered_agent_operations_status_check
  CHECK (status IN ('initializing', 'reserved', 'settlement_pending', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_metered_agent_operations_settlement_pending
  ON metered_agent_operations (updated_at, id)
  WHERE status = 'settlement_pending' AND provider_completed_at IS NOT NULL;

COMMIT;

