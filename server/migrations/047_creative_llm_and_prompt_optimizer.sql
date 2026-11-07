-- Switch every Creative Agent capability to gpt-5.6-sol and add the metered
-- image/video prompt optimizer. Historical model and operation rows remain.

BEGIN;

INSERT INTO model_catalog
  (model_key, display_name, output_type, description, capabilities,
   resolutions, aspect_ratios, minimum_membership_tier, is_active, display_order, metadata)
VALUES
  ('gpt-5.6-sol', 'GPT', 'agent', 'Creative planning and prompt optimization model.',
   '{"tool_calling":true,"mcp":true,"skills":true,"reasoning":true}'::jsonb,
   '[]'::jsonb, '[]'::jsonb, 'free', TRUE, 10,
   '{"ui_label":"GPT","upstream_model_id":"gpt-5.6-sol","reasoning_effort":"medium"}'::jsonb)
ON CONFLICT (model_key) DO UPDATE
SET display_name = EXCLUDED.display_name,
    output_type = EXCLUDED.output_type,
    description = EXCLUDED.description,
    capabilities = EXCLUDED.capabilities,
    minimum_membership_tier = EXCLUDED.minimum_membership_tier,
    is_active = TRUE,
    display_order = EXCLUDED.display_order,
    metadata = COALESCE(model_catalog.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = NOW();

UPDATE model_catalog
SET is_active = FALSE,
    metadata = COALESCE(metadata, '{}'::jsonb) || '{"deprecated":true,"replaced_by":"gpt-5.6-sol"}'::jsonb,
    updated_at = NOW()
WHERE model_key = 'glm-5.2' AND output_type = 'agent';

UPDATE model_routes
SET is_active = FALSE, updated_at = NOW()
WHERE provider_key = 'canvas_agent' AND model_key <> 'gpt-5.6-sol';

INSERT INTO model_routes
  (model_key, provider_key, upstream_model_id, priority, is_active, route_config)
VALUES
  ('gpt-5.6-sol', 'canvas_agent', 'gpt-5.6-sol', 10, TRUE,
   '{"reasoning_effort":"medium"}'::jsonb)
ON CONFLICT (model_key, provider_key, upstream_model_id) DO UPDATE
SET priority = EXCLUDED.priority,
    is_active = TRUE,
    route_config = EXCLUDED.route_config,
    updated_at = NOW();

ALTER TABLE metered_agent_operations
  DROP CONSTRAINT IF EXISTS metered_agent_operations_type_check;
ALTER TABLE metered_agent_operations
  ADD CONSTRAINT metered_agent_operations_type_check
  CHECK (operation_type IN (
    'canvas_agent_plan',
    'digital_human_script_optimizer',
    'generation_prompt_optimizer',
    'global_agent_plan'
  ));

UPDATE generation_charge_rules
SET is_active = FALSE, updated_at = NOW()
WHERE output_type = 'agent' AND model = 'glm-5.2' AND is_active = TRUE;

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority, meta_rule)
SELECT 'agent', 'canvas_agent', operation.scene_key, 'gpt-5.6-sol', NULL, NULL, 1, 100,
       '{"billing_type":"fixed"}'::jsonb
FROM (VALUES
  ('canvas_agent_plan'),
  ('digital_human_script_optimizer'),
  ('generation_prompt_optimizer'),
  ('global_agent_plan')
) AS operation(scene_key)
WHERE NOT EXISTS (
  SELECT 1
  FROM generation_charge_rules rule
  WHERE rule.output_type = 'agent'
    AND rule.provider = 'canvas_agent'
    AND rule.scene_key = operation.scene_key
    AND rule.model = 'gpt-5.6-sol'
    AND rule.is_active = TRUE
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM model_routes route
    JOIN model_catalog model ON model.model_key = route.model_key
    WHERE route.model_key = 'gpt-5.6-sol'
      AND route.provider_key = 'canvas_agent'
      AND route.upstream_model_id = 'gpt-5.6-sol'
      AND route.route_config->>'reasoning_effort' = 'medium'
      AND route.is_active = TRUE
      AND model.is_active = TRUE
  ) THEN
    RAISE EXCEPTION 'Active gpt-5.6-sol Creative LLM route is missing';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM generation_charge_rules
    WHERE output_type = 'agent'
      AND provider = 'canvas_agent'
      AND model = 'gpt-5.6-sol'
      AND scene_key IN (
        'canvas_agent_plan',
        'digital_human_script_optimizer',
        'generation_prompt_optimizer',
        'global_agent_plan'
      )
      AND is_active = TRUE
  ) <> 4 THEN
    RAISE EXCEPTION 'Creative LLM charge rules are incomplete';
  END IF;
END;
$migration$;

COMMIT;
