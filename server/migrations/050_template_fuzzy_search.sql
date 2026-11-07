-- Indexed fuzzy matching for the canvas Agent template picker.
-- This migration is intentionally not executed by application startup.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_prompt_templates_marketplace_search_trgm
  ON prompt_templates USING GIN (
    LOWER(
      COALESCE(scene_key, '') || ' ' ||
      COALESCE(scene_name, '') || ' ' ||
      COALESCE(preview_title, '') || ' ' ||
      COALESCE(preview_description, '') || ' ' ||
      COALESCE(starter_prompt, '') || ' ' ||
      COALESCE(source_key, '') || ' ' ||
      COALESCE(catalog_metadata->>'category', '')
    ) gin_trgm_ops
  )
  WHERE is_active = TRUE;

COMMIT;
