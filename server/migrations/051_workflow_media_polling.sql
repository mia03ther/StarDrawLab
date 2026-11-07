-- Allow durable workflow loops and long-running media polling without
-- resubmitting provider tasks. Application startup never applies migrations.

BEGIN;

ALTER TABLE persistent_jobs
  DROP CONSTRAINT IF EXISTS persistent_jobs_max_attempts_check;

ALTER TABLE persistent_jobs
  ADD CONSTRAINT persistent_jobs_max_attempts_check
  CHECK (max_attempts BETWEEN 1 AND 1000);

UPDATE persistent_jobs
SET max_attempts = GREATEST(max_attempts, 360), updated_at = NOW()
WHERE queue_name = 'workflow'
  AND job_type = 'workflow.node'
  AND status IN ('queued', 'running');

COMMIT;
