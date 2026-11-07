-- Durable, deduplicated mail delivery state for terminal jobs and workflows.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

ALTER TABLE persistent_jobs
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_notification_skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_notification_last_error VARCHAR(120),
  ADD COLUMN IF NOT EXISTS dead_letter_alert_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_letter_alerted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_letter_alert_last_error VARCHAR(120);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS terminal_notification_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_notification_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_notification_skipped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_notification_last_error VARCHAR(120);

ALTER TABLE persistent_jobs
  DROP CONSTRAINT IF EXISTS persistent_jobs_user_notification_outcome_check;
ALTER TABLE persistent_jobs
  ADD CONSTRAINT persistent_jobs_user_notification_outcome_check
  CHECK (user_notification_sent_at IS NULL OR user_notification_skipped_at IS NULL);

ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_terminal_notification_outcome_check;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_terminal_notification_outcome_check
  CHECK (terminal_notification_sent_at IS NULL OR terminal_notification_skipped_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_persistent_jobs_pending_user_notification
  ON persistent_jobs (queue_name, updated_at, id)
  WHERE status IN ('completed', 'failed')
    AND user_notification_sent_at IS NULL
    AND user_notification_skipped_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_persistent_jobs_pending_dead_letter_alert
  ON persistent_jobs (queue_name, updated_at, id)
  WHERE status = 'failed' AND dead_letter_alerted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_runs_pending_terminal_notification
  ON workflow_runs (updated_at, id)
  WHERE status IN ('completed', 'failed')
    AND terminal_notification_sent_at IS NULL
    AND terminal_notification_skipped_at IS NULL;

COMMIT;
