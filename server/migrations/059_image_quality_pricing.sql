-- Image generation pricing by output quality and generation mode.
-- The generic rules are intentionally provider-scoped and keep the existing
-- scene/model/size rules available in the advanced pricing editor.

BEGIN;

CREATE TEMPORARY TABLE image_quality_prices (
  generation_mode VARCHAR(16) NOT NULL,
  image_quality VARCHAR(2) NOT NULL,
  points_cost INTEGER NOT NULL,
  PRIMARY KEY (generation_mode, image_quality)
) ON COMMIT DROP;

INSERT INTO image_quality_prices (generation_mode, image_quality, points_cost)
VALUES
  ('template', '1k', 18),
  ('template', '2k', 22),
  ('template', '4k', 35),
  ('freeform', '1k', 16),
  ('freeform', '2k', 20),
  ('freeform', '4k', 32);

UPDATE generation_charge_rules AS rules
SET points_cost = prices.points_cost,
    priority = 1,
    meta_rule = (
      CASE
        WHEN jsonb_typeof(rules.meta_rule) = 'object' THEN rules.meta_rule
        ELSE '{}'::jsonb
      END
    ) || jsonb_build_object(
      'billing_type', 'fixed',
      'image_quality', prices.image_quality,
      'source', '059_image_quality_pricing'
    ),
    updated_at = NOW()
FROM image_quality_prices AS prices
WHERE rules.output_type = 'image'
  AND rules.provider = 'image_provider'
  AND rules.scene_key IS NULL
  AND rules.model IS NULL
  AND rules.seconds IS NULL
  AND rules.size IS NULL
  AND rules.generation_mode = prices.generation_mode
  AND rules.meta_rule->>'image_quality' = prices.image_quality;

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost,
   priority, generation_mode, is_active, meta_rule)
SELECT
  'image', 'image_provider', NULL, NULL, NULL, NULL,
  prices.points_cost, 1, prices.generation_mode, TRUE,
  jsonb_build_object(
    'billing_type', 'fixed',
    'image_quality', prices.image_quality,
    'source', '059_image_quality_pricing'
  )
FROM image_quality_prices AS prices
WHERE NOT EXISTS (
  SELECT 1
  FROM generation_charge_rules AS rules
  WHERE rules.output_type = 'image'
    AND rules.provider = 'image_provider'
    AND rules.scene_key IS NULL
    AND rules.model IS NULL
    AND rules.seconds IS NULL
    AND rules.size IS NULL
    AND rules.generation_mode = prices.generation_mode
    AND rules.meta_rule->>'image_quality' = prices.image_quality
);

DO $migration$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM generation_charge_rules
    WHERE output_type = 'image'
      AND provider = 'image_provider'
      AND scene_key IS NULL
      AND model IS NULL
      AND seconds IS NULL
      AND size IS NULL
      AND generation_mode IN ('template', 'freeform')
      AND meta_rule->>'image_quality' IN ('1k', '2k', '4k')
      AND is_active = TRUE
  ) < 6 THEN
    RAISE EXCEPTION 'Image quality pricing rules are incomplete';
  END IF;
END;
$migration$;

COMMIT;
