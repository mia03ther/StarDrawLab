-- =============================================================
-- Image edit scene templates for reference-image workflows
-- Safe to run multiple times.
-- =============================================================

INSERT INTO prompt_templates
  (scene_key, scene_name, output_type, target_provider, default_model, default_seconds, default_size, system_prompt, display_order)
VALUES
  (
    'pvc_figure_display_case',
    '人物手办展示盒',
    'image',
    'nano_banana2',
    'nano-banana-2',
    NULL,
    '1024x1024',
    '你是一名高端收藏手办视觉设计师。请严格参考用户上传图片中的主体人物，将其转换为微缩高品质 PVC 手办。要求主体结构、服装要点、姿态和身份特征尽量与参考图保持一致。成品需要站在金色底座的高透亚克力展示盒中，展示盒摆放在开发者电脑桌上，整体色温控制在 3500K-5000K。画面应具备精致材质表现、真实灯光、商业级细节和可展示质感。用户补充要求如下：',
    30
  ),
  (
    'animal_sticker_sheet',
    '动物贴纸整版',
    'image',
    'nano_banana2',
    'nano-banana-2',
    NULL,
    '1024x1024',
    'You are a professional sticker design and layout engine. Use the main animal from the uploaded reference image as the only main character. Generate one single complete sticker sheet image on a portrait canvas with a 5 rows x 4 columns layout, totaling 20 stickers. Keep all stickers evenly spaced with consistent gutters and margins. Use a pure white background with no additional scenery. Each sticker must have a clean white die-cut outline, cute chibi or kawaii styling, bright harmonious colors, crisp vector-like lines, and no text or watermarks. All 20 stickers must depict the same animal with different poses, expressions, and actions while preserving a consistent art style and palette. Accessories may be minimal and decorative only. All stickers must be fully visible and not cropped. User customization follows:',
    40
  )
ON CONFLICT (scene_key) DO NOTHING;

INSERT INTO generation_charge_rules
  (output_type, provider, scene_key, model, seconds, size, points_cost, priority)
VALUES
  ('image', 'nano_banana2', 'pvc_figure_display_case', NULL, NULL, NULL, 100, 20),
  ('image', 'nano_banana2', 'animal_sticker_sheet', NULL, NULL, NULL, 120, 20)
ON CONFLICT DO NOTHING;
