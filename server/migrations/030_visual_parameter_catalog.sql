-- Root/admin-managed visual controls for image/video prompt composition.
-- This migration is intentionally not run by application startup. Apply it in
-- the controlled migration window before enabling the admin editor.

BEGIN;

CREATE TABLE IF NOT EXISTS visual_parameter_options (
  id                         BIGSERIAL PRIMARY KEY,
  parameter_key              VARCHAR(40) NOT NULL,
  option_key                 VARCHAR(80) NOT NULL,
  display_name               VARCHAR(160) NOT NULL,
  display_name_en            VARCHAR(160) NOT NULL,
  description                VARCHAR(1000),
  prompt_fragment            VARCHAR(1200) NOT NULL,
  negative_prompt_fragment   VARCHAR(1200),
  supported_output_types     JSONB NOT NULL DEFAULT '["image", "video"]'::jsonb,
  model_keys                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order              INTEGER NOT NULL DEFAULT 0,
  is_active                  BOOLEAN NOT NULL DEFAULT FALSE,
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id         VARCHAR(255),
  updated_by_user_id         VARCHAR(255),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT visual_parameter_key_check CHECK (parameter_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  -- Option keys may begin with a digit (for example `3d-render`), while
  -- still rejecting path-like or punctuation-prefixed identifiers.
  CONSTRAINT visual_parameter_option_key_check CHECK (option_key ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  CONSTRAINT visual_parameter_output_types_check CHECK (jsonb_typeof(supported_output_types) = 'array'),
  CONSTRAINT visual_parameter_model_keys_check CHECK (jsonb_typeof(model_keys) = 'array'),
  CONSTRAINT visual_parameter_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT visual_parameter_option_unique UNIQUE (parameter_key, option_key)
);

CREATE INDEX IF NOT EXISTS idx_visual_parameter_active_order
  ON visual_parameter_options (parameter_key, is_active, display_order, option_key);

INSERT INTO visual_parameter_options
  (parameter_key, option_key, display_name, display_name_en, prompt_fragment,
   negative_prompt_fragment, supported_output_types, display_order, is_active, metadata)
VALUES
  ('style', 'commercial', '商业广告', 'Commercial', 'clean commercial product photography, premium brand language', 'text, watermark, logo, unintended extra objects', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('style', 'cinematic', '电影感', 'Cinematic', 'cinematic visual language, controlled contrast, rich depth and intentional composition', 'text, watermark, logo, unintended extra objects', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('style', 'photorealistic', '写实摄影', 'Photorealistic', 'photorealistic detail, physically plausible materials and natural proportions', 'text, watermark, logo, unintended extra objects', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('style', '3d-render', '3D 渲染', '3D Render', 'high-end 3D render, polished materials, precise product geometry', 'text, watermark, logo, unintended extra objects', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('style', 'illustration', '插画', 'Illustration', 'refined editorial illustration, expressive shapes and controlled color palette', 'text, watermark, logo, unintended extra objects', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb),
  ('camera', 'static', '稳定定机', 'Static', 'locked-off camera, stable framing', 'unwanted camera shake', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('camera', 'dolly-in', '缓慢推进', 'Dolly In', 'slow dolly-in, gradual emphasis on the subject', 'abrupt camera movement', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('camera', 'orbit', '环绕主体', 'Orbit', 'smooth orbit around the subject, consistent perspective', 'warped perspective, unstable framing', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('camera', 'handheld', '轻微手持', 'Handheld', 'subtle handheld camera texture, restrained and intentional movement', 'excessive shake', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('camera', 'overhead', '俯拍', 'Overhead', 'overhead camera angle with clear top-down composition', 'tilted horizon', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb),
  ('lighting', 'softbox', '柔光箱', 'Softbox', 'large softbox lighting, gentle shadows and clean highlights', 'harsh blown highlights', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('lighting', 'golden-hour', '黄金时刻', 'Golden Hour', 'warm golden-hour light, long soft shadows and a natural glow', 'flat artificial lighting', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('lighting', 'high-key', '高调明亮', 'High Key', 'bright high-key lighting, soft low-contrast shadows', 'heavy dark shadows', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('lighting', 'low-key', '低调戏剧光', 'Low Key', 'low-key cinematic lighting, controlled deep shadows and focused highlights', 'washed-out lighting', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('lighting', 'neon', '霓虹光', 'Neon', 'stylized neon rim light with controlled colored reflections', 'uncontrolled color cast', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb),
  ('background', 'studio', '纯净影棚', 'Studio', 'minimal seamless studio background, no distracting objects', 'cluttered background', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('background', 'gradient', '渐变背景', 'Gradient', 'clean premium gradient background matched to the subject', 'banding, clutter', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('background', 'marble', '大理石台面', 'Marble', 'elegant marble surface with a refined commercial setting', 'dirty or damaged surface', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('background', 'nature', '自然环境', 'Nature', 'natural outdoor environment with believable atmospheric depth', 'unrealistic scenery', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('background', 'urban', '城市环境', 'Urban', 'modern urban environment with readable architectural depth', 'unreadable signage, clutter', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb),
  ('shot', 'macro', '微距', 'Macro', 'macro close-up, fine material texture and shallow depth of field', 'soft subject detail', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('shot', 'close-up', '近景', 'Close Up', 'close-up framing that keeps the subject prominent and detailed', 'subject too small', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('shot', 'medium', '中景', 'Medium', 'medium shot with balanced subject and environment', 'unbalanced framing', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('shot', 'wide', '广角全景', 'Wide', 'wide establishing shot with clear spatial relationships', 'cropped context', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('shot', 'detail', '细节特写', 'Detail', 'focused detail shot highlighting the most important feature', 'unfocused key feature', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb),
  ('motion', 'none', '无运镜', 'None', 'no camera movement, maintain a stable visual focus', 'camera shake', '["image","video"]', 10, TRUE, '{"source":"seed"}'::jsonb),
  ('motion', 'pan', '水平摇镜', 'Pan', 'slow controlled horizontal pan', 'jerky movement', '["image","video"]', 20, TRUE, '{"source":"seed"}'::jsonb),
  ('motion', 'push-in', '推进', 'Push In', 'smooth forward push-in toward the subject', 'abrupt zoom', '["image","video"]', 30, TRUE, '{"source":"seed"}'::jsonb),
  ('motion', 'orbit-reveal', '环绕揭示', 'Orbit Reveal', 'smooth orbit that reveals the subject progressively', 'warped motion', '["image","video"]', 40, TRUE, '{"source":"seed"}'::jsonb),
  ('motion', 'pull-back', '拉远', 'Pull Back', 'smooth pull-back to reveal context and scale', 'abrupt pull-back', '["image","video"]', 50, TRUE, '{"source":"seed"}'::jsonb)
ON CONFLICT (parameter_key, option_key) DO NOTHING;

COMMIT;
