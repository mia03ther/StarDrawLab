-- =============================================================
-- Freeform generation templates for Canvas Agent.
-- These act as neutral fallbacks when the user asks not to use
-- a business template or when no featured template fits.
-- Safe to run multiple times.
-- =============================================================

ALTER TABLE prompt_templates
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS featured_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preview_title VARCHAR(120),
  ADD COLUMN IF NOT EXISTS preview_description TEXT,
  ADD COLUMN IF NOT EXISTS preview_image_url TEXT,
  ADD COLUMN IF NOT EXISTS preview_object_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS starter_prompt TEXT,
  ADD COLUMN IF NOT EXISTS placeholder_text TEXT,
  ADD COLUMN IF NOT EXISTS requires_reference BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;

INSERT INTO prompt_templates
  (scene_key, scene_name, output_type, target_provider, default_model, default_seconds,
   default_size, system_prompt, display_order, is_featured, featured_order,
   preview_title, preview_description, starter_prompt, placeholder_text,
   requires_reference, tags)
VALUES
  (
    'freeform_image',
    '自由图片生成',
    'image',
    'nano_banana2',
    'nano-banana',
    NULL,
    '1024x1024',
    'Follow the user prompt directly. Generate or edit the image without applying any preset business template. Keep the result high quality, clean, coherent, and free of watermarks unless the user explicitly asks otherwise.',
    900,
    FALSE,
    900,
    '自由图片生成',
    '不套用精选模板，直接按用户指令生成或修改图片。',
    '直接按我的描述生成或修改图片，不套用固定模板。',
    '描述你想生成或修改的内容...',
    FALSE,
    '["freeform","agent","image"]'::jsonb
  ),
  (
    'freeform_video',
    '自由视频生成',
    'video',
    'sora2',
    'veo-3-1',
    8,
    '720x1280',
    'Follow the user prompt directly. Generate a clean high-quality video without applying any preset business template. Keep subject motion, camera movement, lighting, and pacing coherent. Do not add text or watermarks unless explicitly requested.',
    900,
    FALSE,
    900,
    '自由视频生成',
    '不套用精选模板，直接按用户指令生成视频。',
    '直接按我的描述生成视频，不套用固定模板。',
    '描述镜头、动作、主体和氛围...',
    FALSE,
    '["freeform","agent","video"]'::jsonb
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
