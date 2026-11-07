-- Durable hand-off for Agent actions that must execute in the signed-in
-- browser (canvas PNG export, local timeline render, authenticated downloads).
-- No provider credential or media byte is persisted in the plan tables.
--
-- This migration deliberately validates replacement constraints before the
-- brief final name swap, and builds the replacement partial index
-- concurrently. Run it with psql ON_ERROR_STOP enabled. CREATE INDEX
-- CONCURRENTLY means the whole file must not be wrapped in another transaction.

SET lock_timeout = '5s';
SET statement_timeout = '5min';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_plan_runs
    WHERE status NOT IN (
      'queued', 'running', 'waiting_approval', 'waiting_client',
      'completed', 'failed', 'cancelled'
    )
  ) THEN
    RAISE EXCEPTION 'agent_plan_runs contains an unsupported status';
  END IF;

  IF EXISTS (
    SELECT 1 FROM agent_plan_steps
    WHERE status NOT IN (
      'ready', 'running', 'waiting_approval', 'waiting_client',
      'completed', 'failed', 'cancelled'
    )
  ) THEN
    RAISE EXCEPTION 'agent_plan_steps contains an unsupported status';
  END IF;
END $$;

ALTER TABLE agent_plan_runs
  DROP CONSTRAINT IF EXISTS agent_plan_runs_status_check_v040;
ALTER TABLE agent_plan_runs
  ADD CONSTRAINT agent_plan_runs_status_check_v040
  CHECK (status IN (
    'queued', 'running', 'waiting_approval', 'waiting_client',
    'completed', 'failed', 'cancelled'
  )) NOT VALID;
ALTER TABLE agent_plan_runs
  VALIDATE CONSTRAINT agent_plan_runs_status_check_v040;

ALTER TABLE agent_plan_steps
  DROP CONSTRAINT IF EXISTS agent_plan_steps_status_check_v040;
ALTER TABLE agent_plan_steps
  ADD CONSTRAINT agent_plan_steps_status_check_v040
  CHECK (status IN (
    'ready', 'running', 'waiting_approval', 'waiting_client',
    'completed', 'failed', 'cancelled'
  )) NOT VALID;
ALTER TABLE agent_plan_steps
  VALIDATE CONSTRAINT agent_plan_steps_status_check_v040;

DROP INDEX CONCURRENTLY IF EXISTS idx_agent_plan_runs_active_v040;
CREATE INDEX CONCURRENTLY idx_agent_plan_runs_active_v040
  ON agent_plan_runs (status, updated_at, id)
  WHERE status IN ('queued', 'running', 'waiting_approval', 'waiting_client');

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

ALTER TABLE agent_plan_runs
  DROP CONSTRAINT IF EXISTS agent_plan_runs_status_check;
ALTER TABLE agent_plan_runs
  RENAME CONSTRAINT agent_plan_runs_status_check_v040 TO agent_plan_runs_status_check;

ALTER TABLE agent_plan_steps
  DROP CONSTRAINT IF EXISTS agent_plan_steps_status_check;
ALTER TABLE agent_plan_steps
  RENAME CONSTRAINT agent_plan_steps_status_check_v040 TO agent_plan_steps_status_check;

DROP INDEX IF EXISTS idx_agent_plan_runs_active;
ALTER INDEX idx_agent_plan_runs_active_v040 RENAME TO idx_agent_plan_runs_active;

COMMIT;
