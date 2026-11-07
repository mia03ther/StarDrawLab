-- Root-managed MCP allowlist, per-user OAuth connections and append-only call audit.
-- This migration is intentionally not executed automatically by application code.

BEGIN;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                    BIGSERIAL PRIMARY KEY,
  server_key            VARCHAR(80) NOT NULL UNIQUE,
  display_name          VARCHAR(160) NOT NULL,
  canonical_url         TEXT NOT NULL,
  provider_adapter      VARCHAR(80) NOT NULL,
  status                VARCHAR(24) NOT NULL DEFAULT 'draft',
  transport             VARCHAR(32) NOT NULL DEFAULT 'streamable_http',
  allowed_domains       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  oauth_config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovery_cache       JSONB NOT NULL DEFAULT '{}'::jsonb,
  admin_notes           TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_servers_status_check CHECK (status IN ('draft', 'enabled', 'disabled', 'catalog_pending')),
  CONSTRAINT mcp_servers_transport_check CHECK (transport IN ('streamable_http', 'sse'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_status
  ON mcp_servers (enabled, status, server_key);

CREATE TABLE IF NOT EXISTS mcp_server_tools (
  id                    BIGSERIAL PRIMARY KEY,
  server_id             BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name             VARCHAR(160) NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  operation_class       VARCHAR(32) NOT NULL DEFAULT 'external_mcp',
  required_roles        TEXT[] NOT NULL DEFAULT ARRAY['user','admin','root']::TEXT[],
  approval_policy       VARCHAR(16) NOT NULL DEFAULT 'policy',
  input_schema          JSONB,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_server_tools_unique UNIQUE (server_id, tool_name),
  CONSTRAINT mcp_server_tools_operation_check CHECK (operation_class IN ('read', 'creative', 'reversible', 'destructive', 'publish', 'external_mcp')),
  CONSTRAINT mcp_server_tools_approval_check CHECK (approval_policy IN ('policy', 'always'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_tools_enabled
  ON mcp_server_tools (server_id, enabled, tool_name);

CREATE TABLE IF NOT EXISTS oauth_client_registrations (
  id                    BIGSERIAL PRIMARY KEY,
  mcp_server_id         BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  issuer                TEXT NOT NULL,
  registration_mode     VARCHAR(32) NOT NULL,
  client_id             TEXT NOT NULL,
  encrypted_client_secret TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oauth_client_registration_unique UNIQUE (mcp_server_id, issuer),
  CONSTRAINT oauth_client_registration_mode_check CHECK (registration_mode IN ('pre_registered', 'client_id_metadata', 'dynamic_registration', 'manual'))
);

CREATE TABLE IF NOT EXISTS mcp_oauth_transactions (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  mcp_server_id         BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  issuer                TEXT NOT NULL,
  resource_uri          TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint        TEXT NOT NULL,
  revoke_endpoint       TEXT,
  redirect_uri          TEXT NOT NULL,
  state_hash            CHAR(64) NOT NULL UNIQUE,
  encrypted_pkce_verifier TEXT NOT NULL,
  client_id             TEXT NOT NULL,
  scopes                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                VARCHAR(16) NOT NULL DEFAULT 'pending',
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at               TIMESTAMPTZ,
  failure_reason        TEXT,
  CONSTRAINT mcp_oauth_transaction_status_check CHECK (status IN ('pending', 'used', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_oauth_transactions_user
  ON mcp_oauth_transactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_transactions_expiry
  ON mcp_oauth_transactions (expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS mcp_connections (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  mcp_server_id         BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  provider_account_id   VARCHAR(255) NOT NULL,
  issuer                TEXT NOT NULL,
  resource_uri          TEXT NOT NULL,
  token_endpoint        TEXT,
  revoke_endpoint       TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  token_type            VARCHAR(40) NOT NULL DEFAULT 'Bearer',
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                VARCHAR(16) NOT NULL DEFAULT 'active',
  last_refresh_at       TIMESTAMPTZ,
  last_used_at          TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  last_error_code       VARCHAR(100),
  last_error_message    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_connections_unique_account UNIQUE (user_id, mcp_server_id, provider_account_id),
  CONSTRAINT mcp_connections_status_check CHECK (status IN ('active', 'revoked', 'error'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_connections_user_status
  ON mcp_connections (user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mcp_call_audit (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               VARCHAR(255) NOT NULL,
  mcp_server_id         BIGINT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  connection_id         BIGINT REFERENCES mcp_connections(id) ON DELETE SET NULL,
  tool_name             VARCHAR(160) NOT NULL,
  parameter_digest      CHAR(64),
  approval_id            BIGINT,
  outcome                VARCHAR(24) NOT NULL,
  status_code            INTEGER,
  latency_ms             INTEGER,
  error_code             VARCHAR(120),
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_call_audit_outcome_check CHECK (outcome IN ('started', 'succeeded', 'failed', 'denied'))
);

CREATE INDEX IF NOT EXISTS idx_mcp_call_audit_user_created
  ON mcp_call_audit (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_call_audit_server_tool
  ON mcp_call_audit (mcp_server_id, tool_name, created_at DESC);

COMMIT;
