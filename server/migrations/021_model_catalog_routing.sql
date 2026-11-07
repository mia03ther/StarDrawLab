-- Root-managed model catalog and provider routing metadata. Provider secrets
-- remain in server configuration and are never stored in these tables.

BEGIN;

CREATE TABLE IF NOT EXISTS model_catalog (
  model_key               VARCHAR(100) PRIMARY KEY,
  display_name            VARCHAR(160) NOT NULL,
  output_type             VARCHAR(20) NOT NULL,
  description             TEXT,
  capabilities            JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolutions             JSONB NOT NULL DEFAULT '[]'::jsonb,
  aspect_ratios           JSONB NOT NULL DEFAULT '[]'::jsonb,
  minimum_membership_tier VARCHAR(20) NOT NULL DEFAULT 'free',
  is_active               BOOLEAN NOT NULL DEFAULT FALSE,
  display_order           INTEGER NOT NULL DEFAULT 0,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id      VARCHAR(255),
  updated_by_user_id      VARCHAR(255),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT model_catalog_output_type_check
    CHECK (output_type IN ('image', 'video', 'agent')),
  CONSTRAINT model_catalog_tier_check
    CHECK (minimum_membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise')),
  CONSTRAINT model_catalog_capabilities_object_check
    CHECK (jsonb_typeof(capabilities) = 'object'),
  CONSTRAINT model_catalog_resolutions_array_check
    CHECK (jsonb_typeof(resolutions) = 'array'),
  CONSTRAINT model_catalog_aspect_ratios_array_check
    CHECK (jsonb_typeof(aspect_ratios) = 'array'),
  CONSTRAINT model_catalog_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_model_catalog_active_display
  ON model_catalog (output_type, is_active, display_order, model_key);

CREATE TABLE IF NOT EXISTS model_routes (
  id                 BIGSERIAL PRIMARY KEY,
  model_key          VARCHAR(100) NOT NULL REFERENCES model_catalog(model_key),
  -- Kept aligned with prompt_templates.target_provider and
  -- generation_charge_rules.provider so route synchronization cannot overflow.
  provider_key       VARCHAR(50) NOT NULL,
  upstream_model_id  VARCHAR(160) NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 100,
  is_active          BOOLEAN NOT NULL DEFAULT FALSE,
  route_config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id VARCHAR(255),
  updated_by_user_id VARCHAR(255),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT model_routes_config_object_check CHECK (jsonb_typeof(route_config) = 'object'),
  CONSTRAINT model_routes_unique_target UNIQUE (model_key, provider_key, upstream_model_id)
);

ALTER TABLE model_routes
  ALTER COLUMN provider_key TYPE VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_model_routes_resolution
  ON model_routes (model_key, is_active, priority, id);

INSERT INTO model_catalog
  (model_key, display_name, output_type, description, capabilities,
   resolutions, aspect_ratios, minimum_membership_tier, is_active, display_order)
VALUES
  ('nano-banana-1', 'Nano Banana 1', 'image', 'Fast general-purpose image generation.',
   '{"reference_images":true}'::jsonb,
   '["1K","2K","4K"]'::jsonb, '["9:16","16:9","21:9","4:3","3:4","1:1"]'::jsonb,
   'free', TRUE, 10),
  ('nano-banana-2', 'Nano Banana 2', 'image', 'High-quality general-purpose image generation.',
   '{"reference_images":true}'::jsonb,
   '["1K","2K","4K"]'::jsonb, '["9:16","16:9","21:9","4:3","3:4","1:1"]'::jsonb,
   'free', TRUE, 20),
  ('gemini-3-pro-image', 'Gemini 3 Pro Image', 'image', 'Professional image generation and editing.',
   '{"reference_images":true}'::jsonb,
   '["1K","2K","4K"]'::jsonb, '["9:16","16:9","21:9","4:3","3:4","1:1"]'::jsonb,
   'free', TRUE, 30),
  ('gpt-image-2', 'GPT Image 2', 'image', 'Image generation through the configured image provider.',
   '{"reference_images":false}'::jsonb,
   '["1K","2K","4K"]'::jsonb, '["9:16","16:9","21:9","4:3","3:4","1:1"]'::jsonb,
   'free', TRUE, 40),
  ('nano-banana', 'Nano Banana (Legacy)', 'image', 'Compatibility model for existing templates.',
   '{"reference_images":true,"legacy":true}'::jsonb,
   '["1K","2K"]'::jsonb, '["9:16","16:9","4:3","3:4","1:1"]'::jsonb,
   'free', TRUE, 90),
  ('veo-3-1', 'Veo 3.1', 'video', 'Video generation through the configured video provider.',
   '{"reference_images":true}'::jsonb,
   '["720p"]'::jsonb, '["9:16","16:9"]'::jsonb,
   'free', TRUE, 10),
  ('video-agent', 'HeyGen Video Agent', 'video', 'Digital-human presenter video generation.',
   '{"digital_human":true}'::jsonb,
   '[]'::jsonb, '["9:16","16:9"]'::jsonb,
   'free', TRUE, 20),
  ('glm-5.2', 'GLM-5.2', 'agent', 'Canvas and workflow agent model.',
   '{"tool_calling":true,"mcp":true,"skills":true}'::jsonb,
   '[]'::jsonb, '[]'::jsonb,
   'free', TRUE, 10)
ON CONFLICT (model_key) DO NOTHING;

INSERT INTO model_routes
  (model_key, provider_key, upstream_model_id, priority, is_active)
VALUES
  ('nano-banana-1', 'image_provider', 'nano-banana-1', 10, TRUE),
  ('nano-banana-2', 'image_provider', 'nano-banana-2', 10, TRUE),
  ('gemini-3-pro-image', 'image_provider', 'gemini-3-pro-image', 10, TRUE),
  ('gpt-image-2', 'image_provider', 'gpt-image-2', 10, TRUE),
  ('nano-banana', 'image_provider', 'nano-banana', 10, TRUE),
  ('veo-3-1', 'sora', 'veo-3-1', 10, TRUE),
  ('video-agent', 'heygen_video_agent', 'video-agent', 10, TRUE),
  ('glm-5.2', 'canvas_agent', 'glm-5.2', 10, TRUE)
ON CONFLICT (model_key, provider_key, upstream_model_id) DO NOTHING;

-- Preview provider/model alias convergence before changing any charge rule.
-- Two selectors overlap when there is at least one request for which every
-- nullable selector can match both rows. Exact duplicate selectors are always
-- checked; other overlaps are checked when this alias convergence newly brings
-- the rules together. Intentional specific/fallback pairs which already shared
-- the same provider/model namespace retain their current behavior. Different
-- effective pricing fields must be resolved explicitly rather than selected by
-- priority/id by accident; non-pricing metadata does not create a false alarm.
CREATE TEMPORARY TABLE model_alias_charge_rule_preview
ON COMMIT DROP
AS
SELECT
  normalized.*,
  (
    normalized.provider IS DISTINCT FROM normalized.canonical_provider
    OR normalized.model IS DISTINCT FROM normalized.canonical_model
  ) AS alias_changes_selector
FROM (
  SELECT
    rules.id,
    rules.output_type,
    rules.provider,
    CASE
      WHEN rules.output_type = 'image'
       AND rules.provider IN ('nano_banana2', 'nano-banana-2', 'nano_banana', 'banana')
        THEN 'image_provider'
      WHEN rules.output_type = 'video'
       AND rules.provider IN ('sora2', 'sora-2')
        THEN 'sora'
      WHEN rules.output_type = 'video'
       AND rules.provider IN ('heygen', 'heygen-digital-human')
        THEN 'heygen_video_agent'
      ELSE rules.provider
    END AS canonical_provider,
    rules.scene_key,
    rules.model,
    CASE
      WHEN rules.output_type = 'image' AND rules.model = 'image2'
        THEN 'gpt-image-2'
      WHEN rules.output_type = 'video'
       AND rules.model IN ('sora2', 'sora-2', 'veo3.1', 'veo31')
        THEN 'veo-3-1'
      ELSE rules.model
    END AS canonical_model,
    rules.seconds,
    rules.size,
    rules.points_cost,
    rules.priority,
    CASE
      WHEN COALESCE(rules.meta_rule->>'billing_type', 'fixed') = 'per_minute'
        THEN 'per_minute'
      ELSE 'fixed'
    END AS billing_type,
    CASE
      WHEN COALESCE(rules.meta_rule->>'billing_type', 'fixed') = 'per_minute'
        THEN COALESCE(NULLIF(rules.meta_rule->>'points_per_minute', ''), rules.points_cost::text)
      ELSE rules.points_cost::text
    END AS effective_points_rate,
    CASE
      WHEN COALESCE(rules.meta_rule->>'billing_type', 'fixed') = 'per_minute'
        THEN COALESCE(NULLIF(rules.meta_rule->>'minimum_points', ''), '0')
      ELSE '0'
    END AS effective_minimum_points,
    COALESCE(NULLIF(rules.meta_rule->>'role_creation_points', ''), '0')
      AS effective_role_creation_points
  FROM generation_charge_rules rules
  WHERE rules.is_active = TRUE
) normalized;

DO $migration$
DECLARE
  invalid_alias RECORD;
  price_conflict RECORD;
BEGIN
  -- Known aliases in an incompatible output type are data errors. Mapping
  -- them to an image/video adapter or model would be a guess.
  SELECT source_type, source_id, output_type, alias_value
  INTO invalid_alias
  FROM (
    SELECT
      'prompt_template_provider'::text AS source_type,
      id::text AS source_id,
      output_type,
      target_provider AS alias_value
    FROM prompt_templates
    WHERE (
      target_provider IN ('nano_banana2', 'nano-banana-2', 'nano_banana', 'banana')
      AND output_type <> 'image'
    ) OR (
      target_provider IN ('sora2', 'sora-2', 'heygen', 'heygen-digital-human')
      AND output_type <> 'video'
    )

    UNION ALL

    SELECT
      'prompt_template_model', id::text, output_type, default_model
    FROM prompt_templates
    WHERE (default_model = 'image2' AND output_type <> 'image')
       OR (
         default_model IN ('sora2', 'sora-2', 'veo3.1', 'veo31')
         AND output_type <> 'video'
       )

    UNION ALL

    SELECT
      'charge_rule_provider', id::text, output_type, provider
    FROM generation_charge_rules
    WHERE (
      provider IN ('nano_banana2', 'nano-banana-2', 'nano_banana', 'banana')
      AND output_type <> 'image'
    ) OR (
      provider IN ('sora2', 'sora-2', 'heygen', 'heygen-digital-human')
      AND output_type <> 'video'
    )

    UNION ALL

    SELECT
      'charge_rule_model', id::text, output_type, model
    FROM generation_charge_rules
    WHERE (model = 'image2' AND output_type <> 'image')
       OR (
         model IN ('sora2', 'sora-2', 'veo3.1', 'veo31')
         AND output_type <> 'video'
       )
  ) invalid_aliases
  ORDER BY source_type, source_id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Historical provider/model alias has an incompatible output type',
      DETAIL = format(
        'source=%s, id=%s, output_type=%s, alias=%s',
        invalid_alias.source_type,
        invalid_alias.source_id,
        invalid_alias.output_type,
        invalid_alias.alias_value
      ),
      HINT = 'Review and correct the row explicitly before retrying migration 021; incompatible aliases are never remapped heuristically.';
  END IF;

  SELECT
    left_rule.id AS left_rule_id,
    right_rule.id AS right_rule_id,
    left_rule.output_type,
    left_rule.canonical_provider,
    left_rule.points_cost AS left_points_cost,
    right_rule.points_cost AS right_points_cost,
    left_rule.billing_type AS left_billing_type,
    right_rule.billing_type AS right_billing_type,
    left_rule.effective_points_rate AS left_points_rate,
    right_rule.effective_points_rate AS right_points_rate,
    left_rule.effective_minimum_points AS left_minimum_points,
    right_rule.effective_minimum_points AS right_minimum_points
  INTO price_conflict
  FROM model_alias_charge_rule_preview left_rule
  JOIN model_alias_charge_rule_preview right_rule
    ON left_rule.id < right_rule.id
   AND left_rule.output_type = right_rule.output_type
   AND left_rule.canonical_provider = right_rule.canonical_provider
   AND (
     left_rule.scene_key IS NULL
     OR right_rule.scene_key IS NULL
     OR left_rule.scene_key = right_rule.scene_key
   )
   AND (
     left_rule.canonical_model IS NULL
     OR right_rule.canonical_model IS NULL
     OR left_rule.canonical_model = right_rule.canonical_model
   )
   AND (
     left_rule.seconds IS NULL
     OR right_rule.seconds IS NULL
     OR left_rule.seconds = right_rule.seconds
   )
   AND (
     left_rule.size IS NULL
     OR right_rule.size IS NULL
     OR left_rule.size = right_rule.size
   )
  WHERE (
      (
        (left_rule.alias_changes_selector OR right_rule.alias_changes_selector)
        AND (
          left_rule.provider IS DISTINCT FROM right_rule.provider
          OR left_rule.model IS DISTINCT FROM right_rule.model
        )
      )
      OR (
        left_rule.provider IS NOT DISTINCT FROM right_rule.provider
        AND left_rule.scene_key IS NOT DISTINCT FROM right_rule.scene_key
        AND left_rule.model IS NOT DISTINCT FROM right_rule.model
        AND left_rule.seconds IS NOT DISTINCT FROM right_rule.seconds
        AND left_rule.size IS NOT DISTINCT FROM right_rule.size
      )
    )
    AND (
      left_rule.points_cost IS DISTINCT FROM right_rule.points_cost
      OR left_rule.billing_type IS DISTINCT FROM right_rule.billing_type
      OR left_rule.effective_points_rate IS DISTINCT FROM right_rule.effective_points_rate
      OR left_rule.effective_minimum_points IS DISTINCT FROM right_rule.effective_minimum_points
      OR left_rule.effective_role_creation_points IS DISTINCT FROM right_rule.effective_role_creation_points
    )
  ORDER BY left_rule.id, right_rule.id
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Provider/model alias convergence would create conflicting active pricing rules',
      DETAIL = format(
        'rule_ids=%s,%s, output_type=%s, canonical_provider=%s, points=%s/%s, billing=%s/%s, effective_rate=%s/%s, minimum=%s/%s',
        price_conflict.left_rule_id,
        price_conflict.right_rule_id,
        price_conflict.output_type,
        price_conflict.canonical_provider,
        price_conflict.left_points_cost,
        price_conflict.right_points_cost,
        price_conflict.left_billing_type,
        price_conflict.right_billing_type,
        price_conflict.left_points_rate,
        price_conflict.right_points_rate,
        price_conflict.left_minimum_points,
        price_conflict.right_minimum_points
      ),
      HINT = 'Review both active rules and explicitly deactivate or reconcile one before retrying migration 021; priority and id are not used to guess a price.';
  END IF;
END;
$migration$;

-- Converge historical provider aliases on the runtime adapter identifiers used
-- by model_routes. Templates and charge rules must change together or a newly
-- routed template can be generated without a matching price rule.
UPDATE prompt_templates
SET target_provider = 'image_provider', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'image'
  AND target_provider IN ('nano_banana2', 'nano-banana-2', 'nano_banana', 'banana');

UPDATE generation_charge_rules
SET provider = 'image_provider', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'image'
  AND provider IN ('nano_banana2', 'nano-banana-2', 'nano_banana', 'banana');

UPDATE prompt_templates
SET target_provider = 'sora', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'video'
  AND target_provider IN ('sora2', 'sora-2');

UPDATE generation_charge_rules
SET provider = 'sora', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'video'
  AND provider IN ('sora2', 'sora-2');

UPDATE prompt_templates
SET target_provider = 'heygen_video_agent', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'video'
  AND target_provider IN ('heygen', 'heygen-digital-human');

UPDATE generation_charge_rules
SET provider = 'heygen_video_agent', updated_at = CURRENT_TIMESTAMP
WHERE output_type = 'video'
  AND provider IN ('heygen', 'heygen-digital-human');

-- Historical product/model labels converge on catalog model keys. These are
-- routing/pricing selectors, not provider upstream_model_id values.
UPDATE prompt_templates
SET default_model = CASE
      WHEN default_model = 'image2' THEN 'gpt-image-2'
      WHEN default_model IN ('sora2', 'sora-2', 'veo3.1', 'veo31') THEN 'veo-3-1'
      ELSE default_model
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE (output_type = 'image' AND default_model = 'image2')
   OR (
     output_type = 'video'
     AND default_model IN ('sora2', 'sora-2', 'veo3.1', 'veo31')
   );

UPDATE generation_charge_rules
SET model = CASE
      WHEN model = 'image2' THEN 'gpt-image-2'
      WHEN model IN ('sora2', 'sora-2', 'veo3.1', 'veo31') THEN 'veo-3-1'
      ELSE model
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE (output_type = 'image' AND model = 'image2')
   OR (
     output_type = 'video'
     AND model IN ('sora2', 'sora-2', 'veo3.1', 'veo31')
   );

COMMIT;
