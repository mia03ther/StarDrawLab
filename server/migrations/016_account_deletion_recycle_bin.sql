-- Account deletion policy:
--   free users are permanently removed after explicit confirmation;
--   paid members enter a 14-day recycle bin and can restore during that time.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS account_status VARCHAR(24) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_scheduled_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_account_status_check'
  ) THEN
    ALTER TABLE user_profiles
      ADD CONSTRAINT user_profiles_account_status_check
        CHECK (account_status IN ('active', 'deletion_pending'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_profiles_deletion_schedule
  ON user_profiles (account_status, deletion_scheduled_at)
  WHERE account_status = 'deletion_pending';

