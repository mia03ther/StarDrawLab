-- Durable reconciliation state for provider refunds.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

ALTER TABLE subscription_refunds
  ADD COLUMN IF NOT EXISTS request_fingerprint CHAR(64),
  ADD COLUMN IF NOT EXISTS reconciliation_state VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reconciliation_error VARCHAR(500),
  ADD COLUMN IF NOT EXISTS reconciliation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reconciliation_lease_id UUID;

ALTER TABLE subscription_refunds
  DROP CONSTRAINT IF EXISTS subscription_refunds_reconciliation_state_check;

ALTER TABLE subscription_refunds
  ADD CONSTRAINT subscription_refunds_reconciliation_state_check
  CHECK (reconciliation_state IN ('pending', 'success', 'failed', 'uncertain'));

ALTER TABLE subscription_refunds
  DROP CONSTRAINT IF EXISTS subscription_refunds_reconciliation_attempts_check;

ALTER TABLE subscription_refunds
  ADD CONSTRAINT subscription_refunds_reconciliation_attempts_check
  CHECK (reconciliation_attempts >= 0);

-- Preserve the existing terminal outcome when this migration is applied to a
-- database that already contains refunds. Unknown pending rows are retried.
UPDATE subscription_refunds
SET reconciliation_state = CASE
      WHEN status = 'completed' THEN 'success'
      WHEN status IN ('failed', 'cancelled') THEN 'failed'
      WHEN metadata->>'provider_status' = 'uncertain' THEN 'uncertain'
      ELSE 'pending'
    END,
    next_reconciliation_at = CASE
      WHEN status = 'pending' THEN COALESCE(next_reconciliation_at, NOW())
      ELSE NULL
    END
WHERE reconciliation_state = 'pending'
   OR next_reconciliation_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_refunds_reconciliation_due
  ON subscription_refunds (COALESCE(next_reconciliation_at, created_at), id)
  WHERE status = 'pending' AND reconciliation_state IN ('pending', 'uncertain');

CREATE INDEX IF NOT EXISTS idx_subscription_refunds_reconciliation_lease
  ON subscription_refunds (reconciliation_claimed_at, id)
  WHERE status = 'pending' AND reconciliation_state IN ('pending', 'uncertain');

COMMIT;
