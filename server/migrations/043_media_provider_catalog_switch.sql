-- Keep the product model catalog aligned with the configured APIKL image
-- provider. Provider credentials and endpoint URLs remain server secrets and
-- are deliberately not stored in this catalog.

BEGIN;

UPDATE prompt_templates
SET default_model = 'gpt-image-2',
    updated_at = NOW()
WHERE output_type = 'image'
  AND default_model IS DISTINCT FROM 'gpt-image-2';

UPDATE generation_charge_rules
SET model = 'gpt-image-2',
    updated_at = NOW()
WHERE output_type = 'image'
  AND model IN (
    'image2', 'nano-banana', 'nano-banana-1', 'nano-banana-2',
    'nana-banana-2', 'nana-banana-pro', 'gemini-3-pro-image'
  );

UPDATE model_catalog
SET is_active = FALSE,
    updated_at = NOW()
WHERE output_type = 'image'
  AND model_key <> 'gpt-image-2';

UPDATE model_catalog
SET display_name = 'GPT Image 2',
    description = 'Image generation and reference-image editing through the configured image provider.',
    capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"reference_images":true}'::jsonb,
    is_active = TRUE,
    updated_at = NOW()
WHERE model_key = 'gpt-image-2'
  AND output_type = 'image';

UPDATE model_routes
SET is_active = FALSE,
    updated_at = NOW()
WHERE provider_key = 'image_provider'
  AND model_key <> 'gpt-image-2';

INSERT INTO model_routes
  (model_key, provider_key, upstream_model_id, priority, is_active)
VALUES
  ('gpt-image-2', 'image_provider', 'gpt-image-2', 1, TRUE)
ON CONFLICT (model_key, provider_key, upstream_model_id) DO UPDATE
SET priority = EXCLUDED.priority,
    is_active = TRUE,
    updated_at = NOW();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM model_catalog
    WHERE output_type = 'image' AND is_active = TRUE AND model_key <> 'gpt-image-2'
  ) THEN
    RAISE EXCEPTION 'Legacy image models remain active after provider switch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM model_catalog c
    JOIN model_routes r ON r.model_key = c.model_key
    WHERE c.model_key = 'gpt-image-2'
      AND c.output_type = 'image'
      AND c.is_active = TRUE
      AND c.capabilities @> '{"reference_images":true}'::jsonb
      AND r.provider_key = 'image_provider'
      AND r.upstream_model_id = 'gpt-image-2'
      AND r.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'GPT Image 2 catalog route or reference-image capability is missing';
  END IF;

  IF EXISTS (
    SELECT 1 FROM prompt_templates
    WHERE output_type = 'image'
      AND is_active = TRUE
      AND default_model IS DISTINCT FROM 'gpt-image-2'
  ) THEN
    RAISE EXCEPTION 'An active image template still targets a legacy image model';
  END IF;
END;
$$;

COMMIT;
