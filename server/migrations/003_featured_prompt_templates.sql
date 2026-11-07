-- =============================================================
-- Featured template metadata for customer-facing template gallery
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

UPDATE prompt_templates
SET
  is_featured = TRUE,
  featured_order = 30,
  preview_title = COALESCE(preview_title, '人物手办展示盒'),
  preview_description = COALESCE(preview_description, '上传人物照片，直接生成带亚克力展示盒和桌面陈列感的高品质手办效果图。'),
  starter_prompt = COALESCE(starter_prompt, '保留人物服装和发型特征，做成高级收藏级手办，展示盒质感通透，桌面有程序员工作氛围，灯光细腻。'),
  placeholder_text = COALESCE(placeholder_text, '补充你想要的手办风格、桌面布置、灯光、材质细节...'),
  requires_reference = TRUE,
  tags = CASE
    WHEN jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) > 0 THEN tags
    ELSE '["figure","display","reference"]'::jsonb
  END
WHERE scene_key = 'pvc_figure_display_case';

UPDATE prompt_templates
SET
  is_featured = TRUE,
  featured_order = 40,
  preview_title = COALESCE(preview_title, '动物贴纸整版'),
  preview_description = COALESCE(preview_description, '上传动物照片，一次生成 20 枚统一风格的白底贴纸整版，适合周边和电商素材。'),
  starter_prompt = COALESCE(starter_prompt, '做成可爱治愈系贴纸，表情更丰富一些，保留动物主要毛色特征，整体更适合打印。'),
  placeholder_text = COALESCE(placeholder_text, '补充你想要的贴纸风格、配色、情绪、动作方向...'),
  requires_reference = TRUE,
  tags = CASE
    WHEN jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) > 0 THEN tags
    ELSE '["sticker","animal","sheet"]'::jsonb
  END
WHERE scene_key = 'animal_sticker_sheet';
