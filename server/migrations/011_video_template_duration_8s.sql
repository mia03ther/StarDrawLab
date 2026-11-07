-- =============================================================
-- Veo 3.1 renders 8-second clips. Normalize video template copy
-- and default duration away from older 15s wording.
-- Safe to run multiple times.
-- =============================================================

UPDATE prompt_templates
SET default_seconds = 8,
    preview_description = REPLACE(REPLACE(preview_description, '15s', '8s'), '15秒', '8秒'),
    starter_prompt = REPLACE(REPLACE(starter_prompt, '15s', '8s'), '15秒', '8秒'),
    placeholder_text = REPLACE(REPLACE(placeholder_text, '15s', '8s'), '15秒', '8秒'),
    system_prompt = REPLACE(REPLACE(system_prompt, '15s', '8s'), '15秒', '8秒'),
    updated_at = NOW()
WHERE output_type = 'video'
  AND target_provider <> 'heygen_video_agent';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '15-second', '8-second'),
    updated_at = NOW()
WHERE output_type = 'video'
  AND target_provider <> 'heygen_video_agent'
  AND system_prompt LIKE '%15-second%';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '15 seconds', '8 seconds'),
    updated_at = NOW()
WHERE output_type = 'video'
  AND target_provider <> 'heygen_video_agent'
  AND system_prompt LIKE '%15 seconds%';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '0-5s (Shot 1)', '0-3s (Shot 1)'),
    updated_at = NOW()
WHERE scene_key = 'Necklace On Model Showcase Template';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '5-10s (Shot 2)', '3-6s (Shot 2)'),
    updated_at = NOW()
WHERE scene_key = 'Necklace On Model Showcase Template';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '10-15s (Shot 3)', '6-8s (Shot 3)'),
    updated_at = NOW()
WHERE scene_key = 'Necklace On Model Showcase Template';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '0–4s', '0–2s'),
    updated_at = NOW()
WHERE scene_key = 'Professional ad yellow backdrop showcase template';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '4–9s', '2–5s'),
    updated_at = NOW()
WHERE scene_key = 'Professional ad yellow backdrop showcase template';

UPDATE prompt_templates
SET system_prompt = REPLACE(system_prompt, '9–15s', '5–8s'),
    updated_at = NOW()
WHERE scene_key = 'Professional ad yellow backdrop showcase template';
