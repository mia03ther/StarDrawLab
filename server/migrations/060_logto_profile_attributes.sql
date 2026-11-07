-- Persist optional profile attributes exposed by Logto/OIDC.
-- Identity-owned identifiers stay on identity_links; presentation profile
-- attributes stay on user_profiles so the application remains provider-neutral.

BEGIN;

ALTER TABLE identity_links
  ADD COLUMN IF NOT EXISTS username VARCHAR(128),
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(64);

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS full_name VARCHAR(120),
  ADD COLUMN IF NOT EXISTS gender VARCHAR(32),
  ADD COLUMN IF NOT EXISTS birthdate DATE;

CREATE INDEX IF NOT EXISTS idx_identity_links_username
  ON identity_links (LOWER(username))
  WHERE username IS NOT NULL;

COMMIT;
