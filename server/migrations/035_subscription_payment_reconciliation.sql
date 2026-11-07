-- Durable reconciliation for subscription payment orders.
-- Additive and idempotent; application code never executes this automatically.

BEGIN;

ALTER TABLE subscription_orders
  ADD COLUMN IF NOT EXISTS payment_reconciliation_state VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_payment_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_reconciliation_error VARCHAR(500),
  ADD COLUMN IF NOT EXISTS payment_reconciliation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reconciliation_lease_id UUID,
  ADD COLUMN IF NOT EXISTS payment_closed_at TIMESTAMPTZ;

ALTER TABLE subscription_orders
  DROP CONSTRAINT IF EXISTS subscription_orders_payment_reconciliation_state_check;

ALTER TABLE subscription_orders
  ADD CONSTRAINT subscription_orders_payment_reconciliation_state_check
  CHECK (payment_reconciliation_state IN ('pending', 'uncertain', 'succeeded', 'closed', 'failed'));

ALTER TABLE subscription_orders
  DROP CONSTRAINT IF EXISTS subscription_orders_payment_reconciliation_attempts_check;

ALTER TABLE subscription_orders
  ADD CONSTRAINT subscription_orders_payment_reconciliation_attempts_check
  CHECK (payment_reconciliation_attempts >= 0);

UPDATE subscription_orders
SET payment_reconciliation_state = CASE status
      WHEN 'paid' THEN 'succeeded'
      WHEN 'cancelled' THEN 'closed'
      WHEN 'failed' THEN 'failed'
      WHEN 'refunded' THEN 'succeeded'
      WHEN 'partially_refunded' THEN 'succeeded'
      ELSE payment_reconciliation_state
    END,
    next_payment_reconciliation_at = CASE
      WHEN status = 'pending' AND payment_reconciliation_state IN ('pending', 'uncertain')
        THEN COALESCE(next_payment_reconciliation_at, NOW())
      ELSE NULL
    END;

CREATE INDEX IF NOT EXISTS idx_subscription_orders_payment_reconciliation_due
  ON subscription_orders (COALESCE(next_payment_reconciliation_at, created_at), id)
  WHERE status = 'pending'
    AND payment_reconciliation_state IN ('pending', 'uncertain');

CREATE INDEX IF NOT EXISTS idx_subscription_orders_payment_reconciliation_lease
  ON subscription_orders (payment_reconciliation_claimed_at, id)
  WHERE status = 'pending'
    AND payment_reconciliation_state IN ('pending', 'uncertain');

COMMIT;
