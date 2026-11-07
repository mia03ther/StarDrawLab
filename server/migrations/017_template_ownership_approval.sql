-- Template ownership and publication workflow.
-- Existing administrator-created rows remain public and approved.

ALTER TABLE prompt_templates
  ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'public',
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(16) NOT NULL DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS required_membership_tier VARCHAR(20) NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS publication_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publication_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS publication_review_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_templates_visibility_check') THEN
    ALTER TABLE prompt_templates
      ADD CONSTRAINT prompt_templates_visibility_check
        CHECK (visibility IN ('public', 'private'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_templates_approval_status_check') THEN
    ALTER TABLE prompt_templates
      ADD CONSTRAINT prompt_templates_approval_status_check
        CHECK (approval_status IN ('approved', 'pending', 'rejected', 'private'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'prompt_templates_required_tier_check') THEN
    ALTER TABLE prompt_templates
      ADD CONSTRAINT prompt_templates_required_tier_check
        CHECK (required_membership_tier IN ('free', 'basic', 'pro', 'max', 'enterprise'));
  END IF;
END $$;

UPDATE prompt_templates
SET visibility = 'public', approval_status = 'approved', required_membership_tier = 'free'
WHERE owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_prompt_templates_catalog
  ON prompt_templates (is_active, visibility, approval_status, required_membership_tier, display_order);
CREATE INDEX IF NOT EXISTS idx_prompt_templates_owner
  ON prompt_templates (owner_user_id, is_active, updated_at DESC);

