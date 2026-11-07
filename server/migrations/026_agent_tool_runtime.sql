-- Durable Agent tool definitions, one-time approval credentials and tool audit events.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

CREATE TABLE IF NOT EXISTS agent_tools (
  id                 BIGSERIAL PRIMARY KEY,
  tool_key           VARCHAR(128) NOT NULL,
  display_name       VARCHAR(160) NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  version            INTEGER NOT NULL DEFAULT 1,
  operation_class    VARCHAR(32) NOT NULL,
  required_roles     TEXT[] NOT NULL DEFAULT ARRAY['user']::TEXT[],
  allowed_modes      TEXT[] NOT NULL DEFAULT ARRAY['ask_for_approval', 'approve_for_me', 'full_access']::TEXT[],
  resource_scope     VARCHAR(24) NOT NULL DEFAULT 'user_owned',
  requires_ownership BOOLEAN NOT NULL DEFAULT FALSE,
  approval_policy    VARCHAR(16) NOT NULL DEFAULT 'policy',
  input_schema       JSONB,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_tools_key_check CHECK (tool_key ~ '^[a-z0-9][a-z0-9._:-]{1,127}$'),
  CONSTRAINT agent_tools_version_check CHECK (version > 0),
  CONSTRAINT agent_tools_operation_class_check CHECK (
    operation_class IN ('read', 'creative', 'reversible', 'destructive', 'publish', 'external_mcp', 'payment', 'recharge', 'refund')
  ),
  CONSTRAINT agent_tools_roles_check CHECK (
    cardinality(required_roles) > 0 AND required_roles <@ ARRAY['root', 'admin', 'user']::TEXT[]
  ),
  CONSTRAINT agent_tools_modes_check CHECK (
    cardinality(allowed_modes) > 0 AND allowed_modes <@ ARRAY['ask_for_approval', 'approve_for_me', 'full_access']::TEXT[]
  ),
  CONSTRAINT agent_tools_scope_check CHECK (resource_scope IN ('user_owned', 'platform')),
  CONSTRAINT agent_tools_approval_policy_check CHECK (approval_policy IN ('policy', 'always')),
  CONSTRAINT agent_tools_key_version_unique UNIQUE (tool_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tools_enabled_key
  ON agent_tools (tool_key) WHERE enabled;

CREATE TABLE IF NOT EXISTS agent_approval_credentials (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            VARCHAR(255) NOT NULL,
  session_id         VARCHAR(255) NOT NULL,
  tool_key           VARCHAR(128) NOT NULL,
  parameter_digest   CHAR(64) NOT NULL,
  token_digest       CHAR(64) NOT NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'issued',
  reason             VARCHAR(500) NOT NULL DEFAULT '',
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  consumed_at        TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  CONSTRAINT agent_approval_parameter_digest_check CHECK (parameter_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_approval_token_digest_check CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT agent_approval_status_check CHECK (status IN ('issued', 'consumed', 'expired', 'revoked')),
  CONSTRAINT agent_approval_status_times_check CHECK (
    (status = 'issued' AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'consumed' AND consumed_at IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'expired' AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND consumed_at IS NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT agent_approval_token_unique UNIQUE (token_digest)
);

ALTER TABLE agent_approval_credentials
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_agent_approval_user_session
  ON agent_approval_credentials (user_id, session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_approval_expiry
  ON agent_approval_credentials (expires_at) WHERE status = 'issued';

CREATE TABLE IF NOT EXISTS agent_tool_audit_events (
  id                BIGSERIAL PRIMARY KEY,
  event_type        VARCHAR(80) NOT NULL,
  outcome           VARCHAR(24) NOT NULL,
  actor_type        VARCHAR(24) NOT NULL DEFAULT 'agent',
  user_id           VARCHAR(255) NOT NULL,
  session_id        VARCHAR(255) NOT NULL,
  tool_key          VARCHAR(128) NOT NULL,
  approval_id       BIGINT REFERENCES agent_approval_credentials(id),
  parameter_digest  CHAR(64),
  reason_code       VARCHAR(80),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_tool_audit_outcome_check CHECK (outcome IN ('issued', 'approved', 'denied', 'executed', 'failed')),
  CONSTRAINT agent_tool_audit_actor_check CHECK (actor_type = 'agent'),
  CONSTRAINT agent_tool_audit_digest_check CHECK (parameter_digest IS NULL OR parameter_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_user_created
  ON agent_tool_audit_events (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_session
  ON agent_tool_audit_events (session_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_tool_audit_tool
  ON agent_tool_audit_events (tool_key, created_at DESC, id DESC);

COMMIT;
