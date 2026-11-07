-- NewToken exposes gpt-image-2 for prompt-only submission. Keep model
-- capabilities aligned so clients do not offer reference-image editing and
-- the application can reject invalid requests before reserving points.

BEGIN;

UPDATE model_catalog
SET capabilities = COALESCE(capabilities, '{}'::jsonb) || '{"reference_images":false}'::jsonb,
    description = 'Image generation through the configured image provider.',
    updated_at = CURRENT_TIMESTAMP
WHERE model_key = 'gpt-image-2';

COMMIT;
