-- Keep the built-in digital human template available for the generation page.
-- Template Studio can still create and manage user templates separately.

UPDATE prompt_templates
SET is_active = TRUE,
    scene_key = 'heygen_digital_human_video',
    scene_name = COALESCE(NULLIF(scene_name, ''), '数字人视频'),
    output_type = 'video',
    target_provider = 'heygen_video_agent',
    default_model = COALESCE(NULLIF(default_model, ''), 'video-agent'),
    default_seconds = COALESCE(default_seconds, 30),
    default_size = COALESCE(NULLIF(default_size, ''), '16:9'),
    updated_at = NOW()
WHERE scene_key = 'heygen_digital_human_video'
   OR scene_key = '_digital_human_video';

UPDATE generation_charge_rules
SET is_active = TRUE,
    points_cost = 200,
    seconds = NULL,
    meta_rule = '{"billing_type":"per_minute","points_per_minute":200,"role_creation_points":0}'::jsonb,
    updated_at = NOW()
WHERE output_type = 'video'
  AND provider = 'heygen_video_agent'
  AND (scene_key = 'heygen_digital_human_video' OR scene_key IS NULL);
