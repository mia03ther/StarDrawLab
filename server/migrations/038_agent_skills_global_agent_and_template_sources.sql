-- Agent database Skills, provider catalog provenance, and global Agent plans.
-- Additive and idempotent. Apply during the controlled migration window.

BEGIN;

ALTER TABLE prompt_templates
  ADD COLUMN IF NOT EXISTS source_key VARCHAR(120),
  ADD COLUMN IF NOT EXISTS source_item_id VARCHAR(120),
  ADD COLUMN IF NOT EXISTS source_url TEXT,
  ADD COLUMN IF NOT EXISTS catalog_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prompt_templates_catalog_metadata_object_check'
  ) THEN
    ALTER TABLE prompt_templates
      ADD CONSTRAINT prompt_templates_catalog_metadata_object_check
      CHECK (jsonb_typeof(catalog_metadata) = 'object');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_templates_source_item
  ON prompt_templates (source_key, source_item_id);

CREATE INDEX IF NOT EXISTS idx_prompt_templates_source_catalog
  ON prompt_templates (source_key, is_active, display_order, id)
  WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_skills (
  id                BIGSERIAL PRIMARY KEY,
  name              VARCHAR(64) NOT NULL UNIQUE,
  title             VARCHAR(160) NOT NULL,
  description       VARCHAR(500) NOT NULL DEFAULT '',
  content           TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,
  status            VARCHAR(16) NOT NULL DEFAULT 'active',
  content_sha256    CHAR(64) NOT NULL,
  source_key        VARCHAR(120),
  created_by_user_id VARCHAR(255) NOT NULL,
  updated_by_user_id VARCHAR(255) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_skills_name_check
    CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
  CONSTRAINT agent_skills_content_size_check
    CHECK (octet_length(content) <= 65536),
  CONSTRAINT agent_skills_status_check
    CHECK (status IN ('active', 'inactive')),
  CONSTRAINT agent_skills_sha256_check
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_agent_skills_catalog
  ON agent_skills (status, updated_at DESC, id DESC);

ALTER TABLE metered_agent_operations
  DROP CONSTRAINT IF EXISTS metered_agent_operations_type_check;
ALTER TABLE metered_agent_operations
  ADD CONSTRAINT metered_agent_operations_type_check
  CHECK (operation_type IN (
    'canvas_agent_plan',
    'digital_human_script_optimizer',
    'global_agent_plan'
  ));

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority, meta_rule)
SELECT 'agent', 'canvas_agent', 'global_agent_plan', 'glm-5.2', NULL, NULL, 1, 100,
       '{"billing_type":"fixed"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM generation_charge_rules
  WHERE output_type = 'agent'
    AND provider = 'canvas_agent'
    AND scene_key = 'global_agent_plan'
    AND model = 'glm-5.2'
    AND is_active = TRUE
);

COMMIT;
