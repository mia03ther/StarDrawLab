-- Idempotent notification state for direct image/video/digital-human tasks.
-- Generation status remains authoritative; these fields only coordinate mail.
ALTER TABLE creations
  ADD COLUMN IF NOT EXISTS completion_notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_notification_skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completion_notification_last_error VARCHAR(500);

CREATE INDEX IF NOT EXISTS idx_creations_completion_notification
  ON creations (status, updated_at)
  WHERE status IN ('completed', 'failed')
    AND completion_notification_sent_at IS NULL
    AND completion_notification_skipped_at IS NULL;
