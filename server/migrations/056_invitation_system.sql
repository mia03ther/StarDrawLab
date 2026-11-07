-- User invitations and one-time reward settlement.
-- Invitation rewards use the existing point_lots/point_ledger transaction path.

BEGIN;

CREATE TABLE IF NOT EXISTS invitation_settings (
  id                       SMALLINT PRIMARY KEY DEFAULT 1,
  inviter_reward_points    INTEGER NOT NULL DEFAULT 0,
  invitee_reward_points    INTEGER NOT NULL DEFAULT 0,
  reward_validity_days     INTEGER NOT NULL DEFAULT 30,
  is_enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invitation_settings_singleton_check CHECK (id = 1),
  CONSTRAINT invitation_settings_inviter_reward_check CHECK (inviter_reward_points >= 0),
  CONSTRAINT invitation_settings_invitee_reward_check CHECK (invitee_reward_points >= 0),
  CONSTRAINT invitation_settings_validity_check CHECK (reward_validity_days >= 0)
);

INSERT INTO invitation_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS invitation_codes (
  id                BIGSERIAL PRIMARY KEY,
  code              VARCHAR(32) NOT NULL UNIQUE,
  code_type         VARCHAR(16) NOT NULL,
  owner_user_id     VARCHAR(255),
  created_by        VARCHAR(255),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,
  CONSTRAINT invitation_codes_type_check CHECK (code_type IN ('personal', 'common')),
  CONSTRAINT invitation_codes_owner_check CHECK (
    (code_type = 'personal' AND owner_user_id IS NOT NULL)
    OR (code_type = 'common')
  ),
  CONSTRAINT invitation_codes_state_check CHECK (
    (is_active = TRUE AND revoked_at IS NULL)
    OR (is_active = FALSE AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invitation_codes_active_personal_owner
  ON invitation_codes (owner_user_id)
  WHERE code_type = 'personal' AND is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_invitation_codes_common_active
  ON invitation_codes (is_active, created_at DESC)
  WHERE code_type = 'common';

CREATE TABLE IF NOT EXISTS invitation_redemptions (
  id                       BIGSERIAL PRIMARY KEY,
  code_id                  BIGINT NOT NULL REFERENCES invitation_codes(id),
  inviter_user_id          VARCHAR(255),
  invitee_user_id          VARCHAR(255) NOT NULL,
  inviter_reward_points    INTEGER NOT NULL DEFAULT 0,
  invitee_reward_points    INTEGER NOT NULL DEFAULT 0,
  reward_expires_at        TIMESTAMPTZ,
  inviter_point_ledger_id  BIGINT,
  invitee_point_ledger_id  BIGINT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT invitation_redemptions_inviter_reward_check CHECK (inviter_reward_points >= 0),
  CONSTRAINT invitation_redemptions_invitee_reward_check CHECK (invitee_reward_points >= 0),
  CONSTRAINT invitation_redemptions_not_self_check CHECK (
    inviter_user_id IS NULL OR inviter_user_id <> invitee_user_id
  ),
  CONSTRAINT invitation_redemptions_reward_check CHECK (
    inviter_reward_points > 0 OR invitee_reward_points > 0
  ),
  CONSTRAINT invitation_redemptions_code_invitee_unique UNIQUE (code_id, invitee_user_id),
  CONSTRAINT invitation_redemptions_invitee_unique UNIQUE (invitee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_invitation_redemptions_inviter
  ON invitation_redemptions (inviter_user_id, created_at DESC)
  WHERE inviter_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invitation_redemptions_code
  ON invitation_redemptions (code_id, created_at DESC);

COMMIT;
