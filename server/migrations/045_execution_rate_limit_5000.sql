-- Raise the execution governor's per-minute operation limit uniformly.
-- This intentionally leaves concurrency, queue depth, daily quota, and
-- historical leases unchanged; the administrator can still tune those
-- controls independently.

BEGIN;

UPDATE execution_governor_policies
SET max_per_minute = 5000,
    updated_at = NOW()
WHERE max_per_minute IS DISTINCT FROM 5000;

COMMIT;
