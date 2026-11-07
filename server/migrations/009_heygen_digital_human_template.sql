-- =============================================================
-- HeyGen digital human video template.
-- Safe to run multiple times.
-- =============================================================

INSERT INTO prompt_templates
  (scene_key, scene_name, output_type, target_provider, default_model, default_seconds,
   default_size, system_prompt, display_order, is_featured, featured_order,
   preview_title, preview_description, starter_prompt, placeholder_text,
   requires_reference, tags)
VALUES
  (
    'heygen_digital_human_video',
    'HeyGen 数字人视频',
    'video',
    'heygen_video_agent',
    'video-agent',
    30,
    '16:9',
    'Create a polished digital human presenter video. The presenter should explain the user topic clearly, with a professional script, natural delivery, clean pacing, and business-ready visual style. Keep the final video concise and suitable for product introductions, training, announcements, or sales enablement.',
    120,
    FALSE,
    120,
    'HeyGen 数字人讲解',
    '输入主题后自动生成数字人脚本、选择讲解风格并渲染成视频。',
    '一位专业数字人主持人，用 30 秒介绍我们的产品亮点、适用人群和行动建议。',
    '描述数字人要讲解的主题、产品、受众和语气...',
    FALSE,
    '["video","digital-human","heygen","avatar","presenter"]'::jsonb
  )
ON CONFLICT (scene_key) DO UPDATE
SET
  scene_name = EXCLUDED.scene_name,
  output_type = EXCLUDED.output_type,
  target_provider = EXCLUDED.target_provider,
  default_model = EXCLUDED.default_model,
  default_seconds = EXCLUDED.default_seconds,
  default_size = EXCLUDED.default_size,
  system_prompt = EXCLUDED.system_prompt,
  display_order = EXCLUDED.display_order,
  is_featured = EXCLUDED.is_featured,
  featured_order = EXCLUDED.featured_order,
  preview_title = EXCLUDED.preview_title,
  preview_description = EXCLUDED.preview_description,
  starter_prompt = EXCLUDED.starter_prompt,
  placeholder_text = EXCLUDED.placeholder_text,
  requires_reference = EXCLUDED.requires_reference,
  tags = EXCLUDED.tags,
  is_active = TRUE,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority, meta_rule)
VALUES
  (
    'video',
    'heygen_video_agent',
    'heygen_digital_human_video',
    'video-agent',
    NULL,
    NULL,
    200,
    10,
    '{"provider":"heygen","endpoint":"/v3/video-agents","billing_type":"per_minute","points_per_minute":200,"role_creation_points":0}'::jsonb
  ),
  (
    'video',
    'heygen_video_agent',
    NULL,
    NULL,
    NULL,
    NULL,
    200,
    100,
    '{"provider":"heygen","endpoint":"/v3/video-agents","fallback":true,"billing_type":"per_minute","points_per_minute":200,"role_creation_points":0}'::jsonb
  )
ON CONFLICT DO NOTHING;
