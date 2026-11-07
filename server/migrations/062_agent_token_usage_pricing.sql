-- Bill Agent model calls by provider-reported token usage.
-- Prices are CNY per one million tokens; one CNY equals 100 points.
-- The migration keeps the original points_cost column for compatibility and
-- adds explicit reservation, settlement, usage, and pricing snapshots.

BEGIN;

ALTER TABLE metered_agent_operations
  ADD COLUMN IF NOT EXISTS reserved_points INTEGER,
  ADD COLUMN IF NOT EXISTS charged_points INTEGER,
  ADD COLUMN IF NOT EXISTS usage_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB;

UPDATE metered_agent_operations
SET reserved_points = COALESCE(reserved_points, points_cost),
    charged_points = CASE
      WHEN status = 'completed' THEN COALESCE(charged_points, points_cost)
      ELSE charged_points
    END
WHERE reserved_points IS NULL OR (status = 'completed' AND charged_points IS NULL);

ALTER TABLE metered_agent_operations
  ALTER COLUMN reserved_points SET NOT NULL;

ALTER TABLE metered_agent_operations
  ADD CONSTRAINT metered_agent_operations_reserved_points_check
    CHECK (reserved_points > 0),
  ADD CONSTRAINT metered_agent_operations_charged_points_check
    CHECK (charged_points IS NULL OR charged_points >= 0);

CREATE INDEX IF NOT EXISTS idx_metered_agent_operations_billing_state
  ON metered_agent_operations (status, updated_at, id)
  WHERE status = 'settlement_pending';

-- Retire the old per-operation fixed-price rows for the selectable models.
-- Existing ledger entries are immutable; this only changes future matching.
UPDATE generation_charge_rules
SET is_active = FALSE, updated_at = NOW()
WHERE output_type = 'agent'
  AND provider = 'canvas_agent'
  AND model IN ('gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'step-3.7-flash', 'minimax-m3')
  AND is_active = TRUE;

CREATE TEMPORARY TABLE agent_token_pricing (
  model_key TEXT PRIMARY KEY,
  billing_type TEXT NOT NULL,
  input_price NUMERIC NOT NULL,
  output_price NUMERIC NOT NULL,
  cache_read_price NUMERIC NOT NULL,
  cache_write_price NUMERIC NOT NULL
) ON COMMIT DROP;

INSERT INTO agent_token_pricing
  (model_key, billing_type, input_price, output_price, cache_read_price, cache_write_price)
VALUES
  ('gpt-5.4-mini', 'token_usage', 0.225, 1.35, 0.03, 0.3),
  ('gpt-5.6-sol', 'token_usage', 1.5, 9, 0.15, 1.875),
  ('gpt-5.6-terra', 'token_usage', 0.6, 3.6, 0.06, 0.75),
  ('step-3.7-flash', 'fixed', 0, 0, 0, 0),
  ('minimax-m3', 'fixed', 0, 0, 0, 0);

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost,
   priority, generation_mode, is_active, meta_rule)
SELECT
  'agent', 'canvas_agent', NULL, pricing.model_key, NULL, NULL, 1,
  1, 'all', TRUE,
  CASE WHEN pricing.billing_type = 'token_usage' THEN jsonb_build_object(
    'billing_type', 'token_usage',
    'currency', 'CNY',
    'unit_tokens', 1000000,
    'points_per_currency_unit', 100,
    'input_price', pricing.input_price,
    'output_price', pricing.output_price,
    'cache_read_price', pricing.cache_read_price,
    'cache_write_price', pricing.cache_write_price,
    'minimum_points', 1,
    'source', '062_agent_token_usage_pricing'
  ) ELSE jsonb_build_object(
    'billing_type', 'fixed',
    'source', '062_agent_token_usage_pricing'
  ) END
FROM agent_token_pricing pricing
WHERE NOT EXISTS (
  SELECT 1
  FROM generation_charge_rules existing
  WHERE existing.output_type = 'agent'
    AND existing.provider = 'canvas_agent'
    AND existing.scene_key IS NULL
    AND existing.model = pricing.model_key
    AND existing.is_active = TRUE
);

DO $migration$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM generation_charge_rules
    WHERE output_type = 'agent'
      AND provider = 'canvas_agent'
      AND scene_key IS NULL
      AND model IN ('gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra', 'step-3.7-flash', 'minimax-m3')
      AND is_active = TRUE
  ) <> 5 THEN
    RAISE EXCEPTION 'Agent model charge rules are incomplete';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM generation_charge_rules
    WHERE output_type = 'agent'
      AND provider = 'canvas_agent'
      AND meta_rule->>'billing_type' = 'token_usage'
      AND model IN ('gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.6-terra')
      AND is_active = TRUE
  ) <> 3 THEN
    RAISE EXCEPTION 'Agent token pricing rules are incomplete';
  END IF;
END;
$migration$;

COMMIT;
