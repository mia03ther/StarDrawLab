-- Subscription lifecycle follow-up. Additive and idempotent.
-- The scheduled snapshot is used for a downgrade: the current membership
-- remains active until the current paid period ends, then the next renewal
-- uses this snapshot.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS billing_anchor_day SMALLINT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id BIGINT,
  ADD COLUMN IF NOT EXISTS scheduled_plan_key VARCHAR(80),
  ADD COLUMN IF NOT EXISTS scheduled_plan_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS scheduled_membership_tier VARCHAR(20),
  ADD COLUMN IF NOT EXISTS scheduled_billing_interval VARCHAR(10),
  ADD COLUMN IF NOT EXISTS scheduled_price_cents INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_included_points INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_bonus_points INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_monthly_bonus_points INTEGER,
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_billing_anchor_day_check'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_billing_anchor_day_check
        CHECK (billing_anchor_day IS NULL OR billing_anchor_day BETWEEN 1 AND 31);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_scheduled_tier_check'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_scheduled_tier_check
        CHECK (scheduled_membership_tier IS NULL OR scheduled_membership_tier IN ('basic', 'pro', 'max', 'enterprise'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_scheduled_interval_check'
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_scheduled_interval_check
        CHECK (scheduled_billing_interval IS NULL OR scheduled_billing_interval IN ('month', 'year'));
  END IF;
END $$;

UPDATE subscriptions
SET billing_anchor_day = EXTRACT(DAY FROM COALESCE(started_at, current_period_start, created_at))::smallint
WHERE billing_anchor_day IS NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_scheduled_plan
  ON subscriptions (status, scheduled_at)
  WHERE scheduled_plan_key IS NOT NULL;

ALTER TABLE subscription_orders
  ADD COLUMN IF NOT EXISTS provider_response JSONB NOT NULL DEFAULT '{}'::jsonb;
