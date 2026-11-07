-- =============================================================
-- Pricing update: Veo 3.1 video, Banana image, digital human,
-- and recharge packages.
-- Safe to run multiple times.
-- =============================================================

INSERT INTO point_packages (package_key, package_name, price_cents, points, bonus_points, is_active)
VALUES
  ('starter_1000',   '体验包', 1000,   1000,   0,     TRUE),
  ('standard_10000', '标准包', 10000,  10000,  0,     TRUE),
  ('growth_55000',   '增长包', 50000,  50000,  5000,  TRUE),
  ('pro_128000',     '专业包', 100000, 100000, 28000, TRUE)
ON CONFLICT (package_key) DO UPDATE
SET package_name = EXCLUDED.package_name,
    price_cents = EXCLUDED.price_cents,
    points = EXCLUDED.points,
    bonus_points = EXCLUDED.bonus_points,
    is_active = TRUE;

UPDATE point_packages
SET is_active = FALSE
WHERE package_key NOT IN ('starter_1000', 'standard_10000', 'growth_55000', 'pro_128000');

-- Image generation via Banana: template 18 points, freeform/default 16 points.
UPDATE generation_charge_rules
SET points_cost = CASE WHEN scene_key IS NULL OR scene_key = 'freeform_image' THEN 16 ELSE 18 END,
    updated_at = NOW()
WHERE output_type = 'image'
  AND provider IN ('nano_banana2', 'banana', 'nano_banana');

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority)
VALUES
  ('image', 'nano_banana2', 'freeform_image', NULL, NULL, NULL, 16, 20),
  ('image', 'nano_banana2', NULL, NULL, NULL, NULL, 16, 100)
ON CONFLICT DO NOTHING;

-- Veo 3.1 video through the sora2-compatible provider: template 160, freeform/default 150.
UPDATE prompt_templates
SET target_provider = 'sora2',
    default_model = 'veo-3-1',
    updated_at = NOW()
WHERE output_type = 'video'
  AND target_provider <> 'heygen_video_agent';

UPDATE generation_charge_rules
SET provider = 'sora2',
    points_cost = 160,
    updated_at = NOW()
WHERE output_type = 'video'
  AND provider <> 'heygen_video_agent'
  AND scene_key IS NOT NULL
  AND scene_key <> 'freeform_video';

UPDATE generation_charge_rules
SET points_cost = CASE WHEN scene_key IS NULL OR scene_key = 'freeform_video' THEN 150 ELSE 160 END,
    updated_at = NOW()
WHERE output_type = 'video'
  AND provider = 'sora2';

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority)
VALUES
  ('video', 'sora2', 'freeform_video', NULL, NULL, NULL, 150, 20),
  ('video', 'sora2', NULL, NULL, NULL, NULL, 150, 100)
ON CONFLICT DO NOTHING;

-- Template-scoped rules should win over older duration-specific fallback rules.
UPDATE generation_charge_rules
SET priority = 20,
    updated_at = NOW()
WHERE scene_key IN ('freeform_image', 'freeform_video');

UPDATE generation_charge_rules
SET priority = 120,
    updated_at = NOW()
WHERE output_type = 'video'
  AND provider = 'sora2'
  AND scene_key IS NULL
  AND seconds IS NOT NULL;

-- Digital human: role creation is free; render cost is 200 points/minute.
UPDATE generation_charge_rules
SET points_cost = 200,
    meta_rule = COALESCE(meta_rule, '{}'::jsonb)
      || '{"billing_type":"per_minute","points_per_minute":200,"role_creation_points":0}'::jsonb,
    seconds = NULL,
    updated_at = NOW()
WHERE output_type = 'video'
  AND provider = 'heygen_video_agent';

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority, meta_rule)
VALUES
  ('video', 'heygen_video_agent', 'heygen_digital_human_video', NULL, NULL, NULL, 200, 20,
   '{"billing_type":"per_minute","points_per_minute":200,"role_creation_points":0}'::jsonb),
  ('video', 'heygen_video_agent', NULL, NULL, NULL, NULL, 200, 100,
   '{"billing_type":"per_minute","points_per_minute":200,"role_creation_points":0,"fallback":true}'::jsonb)
ON CONFLICT DO NOTHING;
