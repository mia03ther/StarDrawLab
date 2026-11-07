-- Stable StarDraw identity links for authentication-provider migrations.
-- This migration never deletes or rewrites existing business ownership ids.

BEGIN;

CREATE TABLE IF NOT EXISTS identity_links (
  id                 BIGSERIAL PRIMARY KEY,
  provider           VARCHAR(64) NOT NULL,
  issuer             VARCHAR(512) NOT NULL,
  subject            VARCHAR(255) NOT NULL,
  stardraw_user_id   VARCHAR(255) NOT NULL,
  email              VARCHAR(320),
  email_verified_at  TIMESTAMPTZ,
  last_seen_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT identity_links_provider_check CHECK (LENGTH(BTRIM(provider)) > 0),
  CONSTRAINT identity_links_issuer_check CHECK (LENGTH(BTRIM(issuer)) > 0),
  CONSTRAINT identity_links_subject_check CHECK (LENGTH(BTRIM(subject)) > 0),
  CONSTRAINT identity_links_user_check CHECK (LENGTH(BTRIM(stardraw_user_id)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_links_external
  ON identity_links (provider, issuer, subject);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_links_provider_user
  ON identity_links (provider, stardraw_user_id);

CREATE INDEX IF NOT EXISTS idx_identity_links_verified_email
  ON identity_links (LOWER(email))
  WHERE email IS NOT NULL AND email_verified_at IS NOT NULL;

COMMIT;

