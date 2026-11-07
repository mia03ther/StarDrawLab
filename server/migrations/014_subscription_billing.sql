-- StarDraw subscriptions, point lots, and operational billing records.
--
-- This migration is additive and idempotent.  It deliberately keeps the
-- legacy point_packages / point_orders tables for historical reporting, but
-- deactivates the legacy products so new purchases use subscription_plans.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS email VARCHAR(320),
  ADD COLUMN IF NOT EXISTS email_updated_at TIMESTAMPTZ;

ALTER TABLE point_ledger
  ADD COLUMN IF NOT EXISTS lot_id BIGINT;

ALTER TABLE membership_bonus_grants
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lot_id BIGINT;

-- Purchased products.  A plan row represents one billing interval: month or
-- year.  The admin UI is the source of truth for prices and entitlements.
CREATE TABLE IF NOT EXISTS subscription_plans (
  id                    BIGSERIAL PRIMARY KEY,
  plan_key              VARCHAR(80) UNIQUE NOT NULL,
  plan_name             VARCHAR(120) NOT NULL,
  membership_tier       VARCHAR(20) NOT NULL,
  billing_interval      VARCHAR(10) NOT NULL,
  price_cents           INTEGER NOT NULL CHECK (price_cents > 0),
  included_points       INTEGER NOT NULL DEFAULT 0 CHECK (included_points >= 0),
  bonus_points          INTEGER NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  monthly_bonus_points  INTEGER NOT NULL DEFAULT 0 CHECK (monthly_bonus_points >= 0),
  is_active             BOOLEAN NOT NULL DEFAULT FALSE,
  display_order         INTEGER NOT NULL DEFAULT 0,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (membership_tier IN ('basic', 'pro', 'max', 'enterprise')),
  CHECK (billing_interval IN ('month', 'year'))
);

CREATE INDEX IF NOT EXISTS idx_subscription_plans_active_order
  ON subscription_plans (is_active, display_order, price_cents);

-- One current or historical subscription per user.  Plan values are copied
-- into the subscription so later admin edits cannot rewrite history.
CREATE TABLE IF NOT EXISTS subscriptions (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  plan_id               BIGINT,
  plan_key              VARCHAR(80) NOT NULL,
  plan_name             VARCHAR(120) NOT NULL,
  membership_tier       VARCHAR(20) NOT NULL,
  billing_interval      VARCHAR(10) NOT NULL,
  price_cents           INTEGER NOT NULL,
  included_points       INTEGER NOT NULL DEFAULT 0,
  bonus_points          INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_points  INTEGER NOT NULL DEFAULT 0,
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  provider              VARCHAR(40) NOT NULL DEFAULT 'alipay',
  provider_customer_id  VARCHAR(255),
  provider_agreement_id VARCHAR(255),
  contact_email         VARCHAR(320),
  started_at            TIMESTAMPTZ,
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  next_renewal_at       TIMESTAMPTZ,
  billing_anchor_day    SMALLINT CHECK (billing_anchor_day BETWEEN 1 AND 31),
  auto_renew            BOOLEAN NOT NULL DEFAULT TRUE,
  cancel_at_period_end  BOOLEAN NOT NULL DEFAULT FALSE,
  cancelled_at          TIMESTAMPTZ,
  last_reminder_at      TIMESTAMPTZ,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (membership_tier IN ('basic', 'pro', 'max', 'enterprise')),
  CHECK (billing_interval IN ('month', 'year')),
  CHECK (status IN ('pending', 'active', 'past_due', 'cancelled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_status
  ON subscriptions (user_id, status, current_period_end DESC);

CREATE INDEX IF NOT EXISTS idx_subscriptions_renewal_due
  ON subscriptions (status, auto_renew, next_renewal_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_live_per_user
  ON subscriptions (user_id)
  WHERE status IN ('pending', 'active', 'past_due');

CREATE TABLE IF NOT EXISTS subscription_orders (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  subscription_id       BIGINT,
  plan_id               BIGINT,
  order_no               VARCHAR(80) UNIQUE NOT NULL,
  order_type             VARCHAR(20) NOT NULL DEFAULT 'initial',
  plan_key               VARCHAR(80) NOT NULL,
  plan_name              VARCHAR(120) NOT NULL,
  membership_tier        VARCHAR(20) NOT NULL,
  billing_interval       VARCHAR(10) NOT NULL,
  amount_cents           INTEGER NOT NULL CHECK (amount_cents >= 0),
  included_points        INTEGER NOT NULL DEFAULT 0,
  bonus_points           INTEGER NOT NULL DEFAULT 0,
  monthly_bonus_points   INTEGER NOT NULL DEFAULT 0,
  period_start           TIMESTAMPTZ,
  period_end             TIMESTAMPTZ,
  status                 VARCHAR(24) NOT NULL DEFAULT 'pending',
  payment_method         VARCHAR(40) NOT NULL DEFAULT 'alipay',
  payment_txn_id         VARCHAR(255),
  provider_agreement_id  VARCHAR(255),
  client_request_id      VARCHAR(128),
  provider_request_id    VARCHAR(255),
  provider_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at                TIMESTAMPTZ,
  refunded_at            TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (order_type IN ('initial', 'renewal', 'upgrade')),
  CHECK (billing_interval IN ('month', 'year')),
  CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_orders_user_client_request
  ON subscription_orders (user_id, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_orders_payment_txn
  ON subscription_orders (payment_txn_id)
  WHERE payment_txn_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subscription_orders_user_created
  ON subscription_orders (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscription_refunds (
  id                    BIGSERIAL PRIMARY KEY,
  order_id              BIGINT NOT NULL,
  user_id               VARCHAR(255) NOT NULL,
  refund_no             VARCHAR(80) UNIQUE NOT NULL,
  requested_points      INTEGER NOT NULL DEFAULT 0,
  refunded_points       INTEGER NOT NULL DEFAULT 0,
  amount_cents          INTEGER NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  status                VARCHAR(20) NOT NULL DEFAULT 'pending',
  reason                TEXT,
  provider_refund_id    VARCHAR(255),
  idempotency_key       VARCHAR(128) UNIQUE NOT NULL,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          TIMESTAMPTZ,
  CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS point_lots (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  source_type           VARCHAR(50) NOT NULL,
  source_id             VARCHAR(255) NOT NULL,
  order_id              BIGINT,
  category              VARCHAR(30) NOT NULL DEFAULT 'purchased',
  total_points          INTEGER NOT NULL CHECK (total_points > 0),
  available_points      INTEGER NOT NULL DEFAULT 0 CHECK (available_points >= 0),
  held_points           INTEGER NOT NULL DEFAULT 0 CHECK (held_points >= 0),
  consumed_points       INTEGER NOT NULL DEFAULT 0 CHECK (consumed_points >= 0),
  expired_points        INTEGER NOT NULL DEFAULT 0 CHECK (expired_points >= 0),
  refunded_points       INTEGER NOT NULL DEFAULT 0 CHECK (refunded_points >= 0),
  expires_at             TIMESTAMPTZ,
  idempotency_key        VARCHAR(128) UNIQUE NOT NULL,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (category IN ('purchased', 'package_bonus', 'membership_bonus', 'legacy', 'manual')),
  CHECK (available_points + held_points + consumed_points + expired_points + refunded_points = total_points)
);

CREATE INDEX IF NOT EXISTS idx_point_lots_user_available
  ON point_lots (user_id, expires_at, created_at, id);

CREATE TABLE IF NOT EXISTS point_lot_allocations (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  creation_id           BIGINT NOT NULL,
  lot_id                BIGINT NOT NULL,
  amount_points         INTEGER NOT NULL CHECK (amount_points > 0),
  status                VARCHAR(20) NOT NULL DEFAULT 'held',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (creation_id, lot_id),
  CHECK (status IN ('held', 'charged', 'released'))
);

CREATE INDEX IF NOT EXISTS idx_point_lot_allocations_creation
  ON point_lot_allocations (creation_id, status);

CREATE INDEX IF NOT EXISTS idx_point_lot_allocations_lot
  ON point_lot_allocations (lot_id, status);

-- Existing balances are preserved as a non-expiring compatibility lot.  This
-- does not change the account balance and allows new charge/refund logic to
-- coexist with historical accounts safely.
INSERT INTO point_lots
  (user_id, source_type, source_id, category, total_points, available_points,
   held_points, consumed_points, idempotency_key, metadata)
SELECT
  a.user_id,
  'legacy_balance',
  a.user_id,
  'legacy',
  a.balance_points,
  a.balance_points - a.held_points,
  a.held_points,
  0,
  'legacy:balance:' || a.user_id,
  '{"migrated":true}'::jsonb
FROM user_point_accounts a
WHERE a.balance_points > 0
  AND NOT EXISTS (
    SELECT 1 FROM point_lots l WHERE l.idempotency_key = 'legacy:balance:' || a.user_id
  );

-- Every historical hold must remain attributable to its creation. Refuse to
-- continue if the account aggregate cannot be reconciled deterministically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM user_point_accounts accounts
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(creations.points_reserved), 0)::bigint AS reserved_points
      FROM creations
      WHERE creations.user_id = accounts.user_id
        AND creations.charge_status = 'reserved'
        AND creations.points_reserved > 0
    ) holds ON TRUE
    WHERE accounts.held_points <> holds.reserved_points
  ) THEN
    RAISE EXCEPTION 'Historical held points cannot be reconciled with reserved creations';
  END IF;
END;
$$;

INSERT INTO point_lot_allocations
  (user_id, creation_id, lot_id, amount_points, status)
SELECT
  creations.user_id,
  creations.id,
  lots.id,
  creations.points_reserved,
  'held'
FROM creations
JOIN point_lots lots
  ON lots.user_id = creations.user_id
 AND lots.idempotency_key = 'legacy:balance:' || creations.user_id
WHERE creations.charge_status = 'reserved'
  AND creations.points_reserved > 0
  AND NOT EXISTS (
    SELECT 1 FROM point_lot_allocations allocations
    WHERE allocations.creation_id = creations.id
  )
ON CONFLICT (creation_id, lot_id) DO NOTHING;

-- Old pure point products are retained for historical references but cannot
-- be purchased after this migration.
UPDATE point_packages SET is_active = FALSE WHERE is_active = TRUE;
