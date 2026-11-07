-- Immutable migration ledger bootstrap. This intentionally records no
-- historical rows: versions 001-040 must be audited before any backfill.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version               INTEGER PRIMARY KEY CHECK (version > 0),
  filename              VARCHAR(255) NOT NULL UNIQUE,
  sha256                CHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by            VARCHAR(255) NOT NULL,
  release_version       VARCHAR(128) NOT NULL,
  execution_duration_ms BIGINT NOT NULL CHECK (execution_duration_ms >= 0)
);

COMMENT ON TABLE schema_migrations IS
  'Immutable checksums for controlled database migrations; historical rows require a separate audited backfill.';

COMMIT;
