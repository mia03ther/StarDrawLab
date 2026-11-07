-- Versioned named workflows, canvas history, and bounded loop state.
-- This migration is intentionally not executed by application startup.

BEGIN;

CREATE TABLE IF NOT EXISTS canvas_workflows (
  id                  VARCHAR(80) PRIMARY KEY,
  user_id             VARCHAR(255) NOT NULL,
  canvas_id           VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  name                VARCHAR(160) NOT NULL,
  current_version     INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at         TIMESTAMPTZ,
  CONSTRAINT canvas_workflows_id_check CHECK (id ~ '^cwf_[0-9a-f]{32}$'),
  CONSTRAINT canvas_workflows_version_check CHECK (current_version >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_workflows_canvas_name_active
  ON canvas_workflows (user_id, canvas_id, LOWER(name))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_canvas_workflows_canvas_updated
  ON canvas_workflows (user_id, canvas_id, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS canvas_workflow_versions (
  workflow_id         VARCHAR(80) NOT NULL REFERENCES canvas_workflows(id) ON DELETE CASCADE,
  version             INTEGER NOT NULL,
  definition          JSONB NOT NULL,
  created_by_user_id  VARCHAR(255) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workflow_id, version),
  CONSTRAINT canvas_workflow_versions_version_check CHECK (version >= 1),
  CONSTRAINT canvas_workflow_versions_definition_check CHECK (jsonb_typeof(definition) = 'object')
);

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS workflow_id VARCHAR(80) REFERENCES canvas_workflows(id),
  ADD COLUMN IF NOT EXISTS workflow_version INTEGER,
  ADD COLUMN IF NOT EXISTS parent_run_id BIGINT REFERENCES workflow_runs(id),
  ADD COLUMN IF NOT EXISTS execution_context JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE workflow_runs
  DROP CONSTRAINT IF EXISTS workflow_runs_execution_context_check;
ALTER TABLE workflow_runs
  ADD CONSTRAINT workflow_runs_execution_context_check
  CHECK (jsonb_typeof(execution_context) = 'object');

CREATE INDEX IF NOT EXISTS idx_workflow_runs_definition_lock
  ON workflow_runs (workflow_id, status, updated_at DESC)
  WHERE workflow_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_loop_iterations (
  id                    BIGSERIAL PRIMARY KEY,
  parent_run_id         BIGINT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  parent_node_key       VARCHAR(128) NOT NULL,
  iteration_index       INTEGER NOT NULL,
  child_run_id          BIGINT REFERENCES workflow_runs(id),
  item_snapshot         JSONB,
  status                VARCHAR(24) NOT NULL DEFAULT 'pending',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT workflow_loop_iterations_unique UNIQUE (parent_run_id, parent_node_key, iteration_index),
  CONSTRAINT workflow_loop_iterations_index_check CHECK (iteration_index BETWEEN 0 AND 999),
  CONSTRAINT workflow_loop_iterations_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_loop_iterations_parent
  ON workflow_loop_iterations (parent_run_id, parent_node_key, iteration_index);

CREATE TABLE IF NOT EXISTS canvas_revisions (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  canvas_id             VARCHAR(64) NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  version               INTEGER NOT NULL,
  title                 VARCHAR(120) NOT NULL,
  canvas_state          JSONB NOT NULL,
  workflows_snapshot    JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason                VARCHAR(120) NOT NULL DEFAULT 'canvas.updated',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT canvas_revisions_unique UNIQUE (canvas_id, version),
  CONSTRAINT canvas_revisions_state_check CHECK (jsonb_typeof(canvas_state) = 'object'),
  CONSTRAINT canvas_revisions_workflows_check CHECK (jsonb_typeof(workflows_snapshot) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_canvas_revisions_history
  ON canvas_revisions (user_id, canvas_id, version DESC);

COMMIT;
