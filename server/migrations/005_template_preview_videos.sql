-- =============================================================
-- Add video preview support for featured templates
-- Safe to run multiple times.
-- =============================================================

ALTER TABLE prompt_templates
  ADD COLUMN IF NOT EXISTS preview_video_url TEXT,
  ADD COLUMN IF NOT EXISTS preview_video_object_key VARCHAR(255);
