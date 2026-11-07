-- Harden digital-human capture links. Resource grants are stateless HMAC tokens
-- and therefore require no database table.

BEGIN;

ALTER TABLE digital_human_roles
  ADD COLUMN IF NOT EXISTS qr_token_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_token_claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_token_consumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS qr_token_revoked_at TIMESTAMPTZ;

-- Legacy tokens were generated with Math.random() and had no expiry. Expire them
-- during migration instead of silently treating them as secure active links.
UPDATE digital_human_roles
SET qr_token_expires_at = CURRENT_TIMESTAMP
WHERE qr_token_expires_at IS NULL;

UPDATE digital_human_roles
SET qr_token_issued_at = qr_token_expires_at - INTERVAL '24 hours'
WHERE qr_token_issued_at IS NULL;

ALTER TABLE digital_human_roles
  ALTER COLUMN qr_token_issued_at SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN qr_token_issued_at SET NOT NULL,
  ALTER COLUMN qr_token_expires_at SET DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
  ALTER COLUMN qr_token_expires_at SET NOT NULL;

ALTER TABLE digital_human_roles
  DROP CONSTRAINT IF EXISTS digital_human_roles_capture_token_ttl_check;
ALTER TABLE digital_human_roles
  ADD CONSTRAINT digital_human_roles_capture_token_ttl_check
  CHECK (
    qr_token_expires_at >= qr_token_issued_at
    AND qr_token_expires_at <= qr_token_issued_at + INTERVAL '24 hours'
  );

CREATE INDEX IF NOT EXISTS idx_digital_human_roles_capture_token_active
  ON digital_human_roles (qr_token, qr_token_expires_at)
  WHERE qr_token_revoked_at IS NULL AND qr_token_consumed_at IS NULL;

COMMENT ON COLUMN digital_human_roles.qr_token_expires_at IS
  'Capture token expires no later than 24 hours after issuance.';
COMMENT ON COLUMN digital_human_roles.qr_token_issued_at IS
  'Server-recorded issuance time used to enforce the 24-hour maximum lifetime.';
COMMENT ON COLUMN digital_human_roles.qr_token_claimed_at IS
  'Set atomically before public upload to prevent concurrent token reuse.';
COMMENT ON COLUMN digital_human_roles.qr_token_consumed_at IS
  'Set after a successful public capture upload; consumed tokens cannot be reused.';
COMMENT ON COLUMN digital_human_roles.qr_token_revoked_at IS
  'Set when the owner revokes or rotates the capture token.';

COMMIT;
