-- Permanent point packages alongside the existing membership subscriptions.
-- Product configuration stays admin-managed; paid orders retain immutable
-- snapshots and grants are attributable to a product-specific point lot.

BEGIN;

ALTER TABLE point_packages
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE point_packages
  DROP CONSTRAINT IF EXISTS point_packages_price_positive_check;
ALTER TABLE point_packages
  ADD CONSTRAINT point_packages_price_positive_check CHECK (price_cents > 0);
ALTER TABLE point_packages
  DROP CONSTRAINT IF EXISTS point_packages_points_positive_check;
ALTER TABLE point_packages
  ADD CONSTRAINT point_packages_points_positive_check CHECK (points > 0);
ALTER TABLE point_packages
  DROP CONSTRAINT IF EXISTS point_packages_bonus_nonnegative_check;
ALTER TABLE point_packages
  ADD CONSTRAINT point_packages_bonus_nonnegative_check CHECK (bonus_points >= 0);
ALTER TABLE point_packages
  DROP CONSTRAINT IF EXISTS point_packages_total_points_range_check;
ALTER TABLE point_packages
  ADD CONSTRAINT point_packages_total_points_range_check
  CHECK (points::BIGINT + bonus_points::BIGINT <= 2147483647);
ALTER TABLE point_packages
  DROP CONSTRAINT IF EXISTS point_packages_metadata_object_check;
ALTER TABLE point_packages
  ADD CONSTRAINT point_packages_metadata_object_check CHECK (jsonb_typeof(metadata) = 'object');

CREATE INDEX IF NOT EXISTS idx_point_packages_active_display
  ON point_packages (is_active, display_order, price_cents, id);

ALTER TABLE point_orders
  ADD COLUMN IF NOT EXISTS provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provider_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS payment_reconciliation_state VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS payment_reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_payment_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_reconciliation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_payment_reconciliation_error VARCHAR(500),
  ADD COLUMN IF NOT EXISTS payment_reconciliation_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payment_reconciliation_lease_id UUID,
  ADD COLUMN IF NOT EXISTS payment_closed_at TIMESTAMPTZ;

ALTER TABLE point_orders
  DROP CONSTRAINT IF EXISTS point_orders_status_check;
ALTER TABLE point_orders
  ADD CONSTRAINT point_orders_status_check
  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'));
ALTER TABLE point_orders
  DROP CONSTRAINT IF EXISTS point_orders_reconciliation_state_check;
ALTER TABLE point_orders
  ADD CONSTRAINT point_orders_reconciliation_state_check
  CHECK (payment_reconciliation_state IN ('pending', 'uncertain', 'succeeded', 'closed', 'failed'));
ALTER TABLE point_orders
  DROP CONSTRAINT IF EXISTS point_orders_reconciliation_attempts_check;
ALTER TABLE point_orders
  ADD CONSTRAINT point_orders_reconciliation_attempts_check
  CHECK (payment_reconciliation_attempts >= 0);

UPDATE point_orders
SET status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
    payment_reconciliation_state = CASE status
      WHEN 'paid' THEN 'succeeded'
      WHEN 'partially_refunded' THEN 'succeeded'
      WHEN 'refunded' THEN 'succeeded'
      WHEN 'cancelled' THEN 'closed'
      WHEN 'failed' THEN 'failed'
      WHEN 'pending' THEN 'closed'
      ELSE 'failed'
    END,
    next_payment_reconciliation_at = NULL,
    payment_closed_at = CASE WHEN status = 'pending' THEN COALESCE(payment_closed_at, NOW()) ELSE payment_closed_at END;

-- point_orders predates the production Alipay flow. Any pending rows present
-- while this migration runs are legacy/mock orders and must never be queried
-- or fulfilled by the new reconciliation worker. New orders created after the
-- migration explicitly initialize their own pending reconciliation schedule.

CREATE INDEX IF NOT EXISTS idx_point_orders_payment_reconciliation_due
  ON point_orders (COALESCE(next_payment_reconciliation_at, created_at), id)
  WHERE status = 'pending'
    AND payment_reconciliation_state IN ('pending', 'uncertain');

ALTER TABLE point_lots
  ADD COLUMN IF NOT EXISTS product_order_type VARCHAR(24),
  ADD COLUMN IF NOT EXISTS product_order_id BIGINT;

UPDATE point_lots
SET product_order_type = 'subscription',
    product_order_id = order_id
WHERE order_id IS NOT NULL
  AND product_order_type IS NULL;

ALTER TABLE point_lots
  DROP CONSTRAINT IF EXISTS point_lots_product_order_pair_check;
ALTER TABLE point_lots
  ADD CONSTRAINT point_lots_product_order_pair_check CHECK (
    (product_order_type IS NULL AND product_order_id IS NULL)
    OR (product_order_type IN ('subscription', 'point_package') AND product_order_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_point_lots_product_order
  ON point_lots (product_order_type, product_order_id, expires_at, id)
  WHERE product_order_type IS NOT NULL;

CREATE TABLE IF NOT EXISTS point_package_refunds (
  id                         BIGSERIAL PRIMARY KEY,
  order_id                   BIGINT NOT NULL REFERENCES point_orders(id),
  user_id                    VARCHAR(255) NOT NULL,
  refund_no                  VARCHAR(80) UNIQUE NOT NULL,
  requested_points           INTEGER NOT NULL CHECK (requested_points > 0),
  refunded_points            INTEGER NOT NULL DEFAULT 0 CHECK (refunded_points >= 0),
  amount_cents               INTEGER NOT NULL CHECK (amount_cents > 0),
  status                     VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason                     TEXT,
  provider_refund_id         VARCHAR(255),
  idempotency_key            VARCHAR(128) UNIQUE NOT NULL,
  reconciliation_state       VARCHAR(16) NOT NULL DEFAULT 'pending',
  reconciliation_attempts    INTEGER NOT NULL DEFAULT 0,
  next_reconciliation_at     TIMESTAMPTZ,
  last_reconciliation_at     TIMESTAMPTZ,
  last_reconciliation_error  VARCHAR(500),
  reconciliation_claimed_at  TIMESTAMPTZ,
  reconciliation_lease_id    UUID,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at               TIMESTAMPTZ,
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
  CHECK (reconciliation_state IN ('pending', 'uncertain', 'success', 'failed')),
  CHECK (reconciliation_attempts >= 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_point_package_refunds_due
  ON point_package_refunds (COALESCE(next_reconciliation_at, created_at), id)
  WHERE status = 'pending' AND reconciliation_state IN ('pending', 'uncertain');

COMMIT;
