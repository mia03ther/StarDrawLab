-- Explicit pricing modes for image/video generation.
-- Existing rows remain valid as the all-mode fallback. No historical charge is changed.

BEGIN;

ALTER TABLE generation_charge_rules
  ADD COLUMN IF NOT EXISTS generation_mode VARCHAR(16) NOT NULL DEFAULT 'all';

ALTER TABLE generation_charge_rules
  DROP CONSTRAINT IF EXISTS generation_charge_rules_mode_check;
ALTER TABLE generation_charge_rules
  ADD CONSTRAINT generation_charge_rules_mode_check
  CHECK (generation_mode IN ('all', 'freeform', 'template'));

CREATE INDEX IF NOT EXISTS idx_generation_charge_rules_mode_lookup
  ON generation_charge_rules (output_type, provider, generation_mode, is_active, priority);

UPDATE generation_charge_rules
SET generation_mode = CASE
      WHEN output_type IN ('image', 'video') AND scene_key = 'freeform_' || output_type THEN 'freeform'
      WHEN output_type IN ('image', 'video') AND scene_key IS NOT NULL THEN 'template'
      ELSE 'all'
    END,
    updated_at = NOW()
WHERE generation_mode = 'all';

-- Preserve the existing provider-specific default prices while making both
-- media modes explicit. The INSERT guards make this safe to replay.
WITH defaults AS (
  SELECT DISTINCT ON (output_type, provider)
         output_type, provider, points_cost
  FROM generation_charge_rules
  WHERE output_type IN ('image', 'video')
    AND scene_key IS NULL
    AND model IS NULL
    AND seconds IS NULL
    AND size IS NULL
    AND is_active = TRUE
  ORDER BY output_type, provider, priority ASC, id ASC
)
INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost,
   priority, generation_mode, is_active, meta_rule)
SELECT d.output_type, d.provider, 'freeform_' || d.output_type, NULL, NULL, NULL,
       d.points_cost, 20, 'freeform', TRUE,
       jsonb_build_object('billing_type', 'fixed', 'source', '057_generation_pricing_modes')
FROM defaults d
WHERE NOT EXISTS (
  SELECT 1
  FROM generation_charge_rules existing
  WHERE existing.output_type = d.output_type
    AND existing.provider = d.provider
    AND existing.scene_key = 'freeform_' || d.output_type
    AND existing.generation_mode = 'freeform'
);

WITH defaults AS (
  SELECT DISTINCT ON (output_type, provider)
         output_type, provider, points_cost, meta_rule
  FROM generation_charge_rules
  WHERE output_type IN ('image', 'video')
    AND scene_key IS NULL
    AND model IS NULL
    AND seconds IS NULL
    AND size IS NULL
    AND is_active = TRUE
  ORDER BY output_type, provider, priority ASC, id ASC
)
INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost,
   priority, generation_mode, is_active, meta_rule)
SELECT d.output_type, d.provider, NULL, NULL, NULL, NULL,
       CASE WHEN d.output_type = 'image' THEN d.points_cost + 2
            WHEN d.output_type = 'video' THEN d.points_cost + 10
            ELSE d.points_cost END,
       100, 'template', TRUE,
       COALESCE(d.meta_rule, '{}'::jsonb) || jsonb_build_object('source', '057_generation_pricing_modes')
FROM defaults d
WHERE NOT EXISTS (
  SELECT 1
  FROM generation_charge_rules existing
  WHERE existing.output_type = d.output_type
    AND existing.provider = d.provider
    AND existing.scene_key IS NULL
    AND existing.model IS NULL
    AND existing.seconds IS NULL
    AND existing.size IS NULL
    AND existing.generation_mode = 'template'
);

COMMIT;
