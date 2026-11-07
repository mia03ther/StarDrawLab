-- Route the existing Agent logical model to the provider's supported GPT-5.4
-- mini upstream. Keep the logical key and historical billing rows unchanged.

BEGIN;

UPDATE model_catalog
SET display_name = 'GPT',
    description = 'StarDraw Agent model.',
    metadata = COALESCE(metadata, '{}'::jsonb) || '{"ui_label":"GPT","upstream_model_id":"gpt-5.4-mini"}'::jsonb,
    updated_at = NOW()
WHERE model_key = 'glm-5.2' AND output_type = 'agent';

UPDATE model_routes
SET upstream_model_id = 'gpt-5.4-mini',
    priority = 1,
    is_active = TRUE,
    updated_at = NOW()
WHERE model_key = 'glm-5.2' AND provider_key = 'canvas_agent';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_routes
    WHERE model_key = 'glm-5.2' AND provider_key = 'canvas_agent'
      AND upstream_model_id = 'gpt-5.4-mini' AND is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Agent model route glm-5.2/canvas_agent is missing';
  END IF;
END;
$$;

COMMIT;
