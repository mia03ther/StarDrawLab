-- Add selectable Agent text models and route them through the configured
-- server-side Creative LLM adapter. Provider secrets remain in server/.env.

BEGIN;

CREATE TEMPORARY TABLE agent_text_models (
  model_key TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  display_order INTEGER NOT NULL
) ON COMMIT DROP;

INSERT INTO agent_text_models (model_key, display_name, display_order)
VALUES
  ('gpt-5.6-sol', 'GPT 5.6 Sol', 10),
  ('gpt-5.6-terra', 'GPT 5.6 Terra', 20),
  ('gpt-5.4-mini', 'GPT 5.4 Mini', 30),
  ('step-3.7-flash', 'Step 3.7 Flash', 40),
  ('minimax-m3', 'MiniMax M3', 50);

INSERT INTO model_catalog
  (model_key, display_name, output_type, description, capabilities,
   resolutions, aspect_ratios, minimum_membership_tier, is_active,
   display_order, metadata)
SELECT
  model_key,
  display_name,
  'agent',
  'Selectable text model for Canvas Agent, Global Agent, and creative prompt operations.',
  '{"tool_calling":true,"mcp":true,"skills":true,"reasoning":true}'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  'free',
  TRUE,
  display_order,
  jsonb_build_object(
    'ui_label', display_name,
    'upstream_model_id', model_key,
    'reasoning_effort', 'medium',
    'provider_family', 'ranai'
  )
FROM agent_text_models
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

INSERT INTO model_routes
  (model_key, provider_key, upstream_model_id, priority, is_active, route_config)
SELECT
  model_key,
  'canvas_agent',
  model_key,
  10,
  TRUE,
  '{"reasoning_effort":"medium"}'::jsonb
FROM agent_text_models
ON CONFLICT (model_key, provider_key, upstream_model_id) DO UPDATE
SET priority = EXCLUDED.priority,
    is_active = TRUE,
    route_config = EXCLUDED.route_config,
    updated_at = NOW();

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority, meta_rule)
SELECT
  'agent',
  'canvas_agent',
  operation.scene_key,
  model.model_key,
  NULL,
  NULL,
  1,
  100,
  '{"billing_type":"fixed"}'::jsonb
FROM agent_text_models model
CROSS JOIN (VALUES
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
    AND rule.model = model.model_key
    AND rule.is_active = TRUE
);

DO $migration$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM model_catalog
    WHERE output_type = 'agent'
      AND model_key IN (SELECT model_key FROM agent_text_models)
      AND is_active = TRUE
  ) <> 5 THEN
    RAISE EXCEPTION 'Agent text model catalog is incomplete';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM model_routes
    WHERE provider_key = 'canvas_agent'
      AND model_key IN (SELECT model_key FROM agent_text_models)
      AND is_active = TRUE
  ) <> 5 THEN
    RAISE EXCEPTION 'Agent text model routes are incomplete';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM generation_charge_rules
    WHERE output_type = 'agent'
      AND provider = 'canvas_agent'
      AND model IN (SELECT model_key FROM agent_text_models)
      AND scene_key IN (
        'canvas_agent_plan',
        'digital_human_script_optimizer',
        'generation_prompt_optimizer',
        'global_agent_plan'
      )
      AND is_active = TRUE
  ) <> 20 THEN
    RAISE EXCEPTION 'Agent text model charge rules are incomplete';
  END IF;
END;
$migration$;

COMMIT;
