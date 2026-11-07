-- Remove membership-tier differences from application-level execution
-- concurrency. Provider throttling, database pool limits, idempotency, and
-- infrastructure overload protection remain independent safety boundaries.

BEGIN;

UPDATE execution_governor_policies
SET max_concurrent = 5000,
    max_queue_depth = 5000,
    updated_at = NOW(),
    metadata = COALESCE(metadata, '{}'::jsonb)
      || '{"concurrency_policy":"uniform_5000"}'::jsonb
WHERE max_concurrent IS DISTINCT FROM 5000
   OR max_queue_depth IS DISTINCT FROM 5000
   OR metadata ->> 'concurrency_policy' IS DISTINCT FROM 'uniform_5000';

COMMIT;
