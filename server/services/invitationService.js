import crypto from "node:crypto";

import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { rechargePoints } from "./pointsService.js";

const MAX_POINT_AMOUNT = 2_147_483_647;
const MAX_VALIDITY_DAYS = 3650;
const CODE_PATTERN = /^[A-Z0-9]{8,32}$/;

const fail = (message, status, code) => {
  throw Object.assign(new Error(message), { status, code });
};

const asNonNegativeInteger = (value, name, maximum = MAX_POINT_AMOUNT) => {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0 || normalized > maximum) {
    fail(`${name} must be a non-negative integer`, 400, "INVALID_INVITATION_SETTINGS");
  }
  return normalized;
};

const asBoolean = (value, name) => {
  if (typeof value === "boolean") return value;
  if (["true", "1", "yes", "on"].includes(String(value).trim().toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(String(value).trim().toLowerCase())) return false;
  fail(`${name} must be a boolean`, 400, "INVALID_INVITATION_SETTINGS");
};

export const normalizeInvitationCode = (value) => {
  const code = String(value || "").trim().toUpperCase();
  if (!CODE_PATTERN.test(code)) fail("Invitation code is invalid", 400, "INVALID_INVITATION_CODE");
  return code;
};

export const normalizeInvitationSettings = (input = {}, current = {}) => {
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  return {
    inviter_reward_points: asNonNegativeInteger(
      has("inviter_reward_points") ? input.inviter_reward_points : current.inviter_reward_points ?? 0,
      "inviter_reward_points",
    ),
    invitee_reward_points: asNonNegativeInteger(
      has("invitee_reward_points") ? input.invitee_reward_points : current.invitee_reward_points ?? 0,
      "invitee_reward_points",
    ),
    reward_validity_days: asNonNegativeInteger(
      has("reward_validity_days") ? input.reward_validity_days : current.reward_validity_days ?? 30,
      "reward_validity_days",
      MAX_VALIDITY_DAYS,
    ),
    is_enabled: has("is_enabled")
      ? asBoolean(input.is_enabled, "is_enabled")
      : Boolean(current.is_enabled ?? false),
  };
};

const generateInvitationCode = () => crypto.randomBytes(10).toString("hex").toUpperCase();

const insertCodeTx = async (tx, { codeType, ownerUserId = null, createdBy = null }) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInvitationCode();
    const [row] = await tx`
      INSERT INTO invitation_codes (code, code_type, owner_user_id, created_by)
      VALUES (${code}, ${codeType}, ${ownerUserId}, ${createdBy})
      ON CONFLICT (code) DO NOTHING
      RETURNING id, code, code_type, owner_user_id, created_by, is_active, created_at, revoked_at
    `;
    if (row) return row;
  }
  fail("Unable to allocate a unique invitation code", 503, "INVITATION_CODE_ALLOCATION_FAILED");
};

const toPublicCode = (row, appBaseUrl = process.env.APP_BASE_URL) => {
  if (!row) return null;
  const baseUrl = String(appBaseUrl || "").trim().replace(/\/+$/, "");
  return {
    id: row.id,
    code: row.code,
    code_type: row.code_type,
    owner_user_id: row.owner_user_id || null,
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    revoked_at: row.revoked_at || null,
    link: `${baseUrl || ""}/invite?code=${encodeURIComponent(row.code)}`,
  };
};

export const getInvitationSettings = async () => {
  const [row] = await sql`
    SELECT id, inviter_reward_points, invitee_reward_points,
           reward_validity_days, is_enabled, created_at, updated_at
    FROM invitation_settings
    WHERE id = 1
  `;
  return row || null;
};

export const getInvitationOverview = async (userId, appBaseUrl = process.env.APP_BASE_URL) => {
  const [[settings], [personal], [stats]] = await Promise.all([
    sql`
      SELECT inviter_reward_points, invitee_reward_points,
             reward_validity_days, is_enabled
      FROM invitation_settings WHERE id = 1
    `,
    sql`
      SELECT id, code, code_type, owner_user_id, is_active, created_at, revoked_at
      FROM invitation_codes
      WHERE owner_user_id = ${userId} AND code_type = 'personal' AND is_active = TRUE
      LIMIT 1
    `,
    sql`
      SELECT COUNT(*)::int AS invited_count,
             COALESCE(SUM(inviter_reward_points), 0)::int AS inviter_reward_points,
             COALESCE(SUM(invitee_reward_points), 0)::int AS invitee_reward_points
      FROM invitation_redemptions
      WHERE inviter_user_id = ${userId}
    `,
  ]);

  return {
    settings: settings || null,
    personal: toPublicCode(personal, appBaseUrl),
    stats: {
      invited_count: Number(stats?.invited_count || 0),
      inviter_reward_points: Number(stats?.inviter_reward_points || 0),
      invitee_reward_points: Number(stats?.invitee_reward_points || 0),
    },
  };
};

export const regeneratePersonalInvitationTx = async (tx, userId) => {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${"invitation:personal:" + userId}, 0))`;
  await tx`
    UPDATE invitation_codes
    SET is_active = FALSE, revoked_at = NOW()
    WHERE owner_user_id = ${userId} AND code_type = 'personal' AND is_active = TRUE
  `;
  return insertCodeTx(tx, { codeType: "personal", ownerUserId: userId });
};

export const createCommonInvitationTx = async (tx, createdBy) => (
  insertCodeTx(tx, { codeType: "common", createdBy })
);

export const revokeCommonInvitationTx = async (tx, invitationId) => {
  const [before] = await tx`
    SELECT id, code, code_type, owner_user_id, created_by, is_active, created_at, revoked_at
    FROM invitation_codes
    WHERE id = ${invitationId} AND code_type = 'common'
    FOR UPDATE
  `;
  if (!before) fail("Common invitation link was not found", 404, "INVITATION_LINK_NOT_FOUND");
  if (!before.is_active) return before;
  const [after] = await tx`
    UPDATE invitation_codes
    SET is_active = FALSE, revoked_at = NOW()
    WHERE id = ${invitationId}
    RETURNING id, code, code_type, owner_user_id, created_by, is_active, created_at, revoked_at
  `;
  return after;
};

export const regenerateCommonInvitationTx = async (tx, invitationId, createdBy) => {
  await revokeCommonInvitationTx(tx, invitationId);
  return insertCodeTx(tx, { codeType: "common", createdBy });
};

export const listCommonInvitations = async (appBaseUrl = process.env.APP_BASE_URL) => {
  const rows = await sql`
    SELECT c.id, c.code, c.code_type, c.owner_user_id, c.created_by,
           c.is_active, c.created_at, c.revoked_at,
           COUNT(r.id)::int AS redemption_count
    FROM invitation_codes c
    LEFT JOIN invitation_redemptions r ON r.code_id = c.id
    WHERE c.code_type = 'common'
    GROUP BY c.id
    ORDER BY c.created_at DESC, c.id DESC
  `;
  return rows.map((row) => ({ ...toPublicCode(row, appBaseUrl), created_by: row.created_by || null, redemption_count: Number(row.redemption_count || 0) }));
};

export const updateInvitationSettingsTx = async (tx, input) => {
  const [current] = await tx`
    SELECT id, inviter_reward_points, invitee_reward_points,
           reward_validity_days, is_enabled, created_at, updated_at
    FROM invitation_settings
    WHERE id = 1
    FOR UPDATE
  `;
  if (!current) fail("Invitation settings migration is not applied", 503, "INVITATION_SCHEMA_NOT_READY");
  const normalized = normalizeInvitationSettings(input, current);
  const [updated] = await tx`
    UPDATE invitation_settings
    SET inviter_reward_points = ${normalized.inviter_reward_points},
        invitee_reward_points = ${normalized.invitee_reward_points},
        reward_validity_days = ${normalized.reward_validity_days},
        is_enabled = ${normalized.is_enabled},
        updated_at = NOW()
    WHERE id = 1
    RETURNING id, inviter_reward_points, invitee_reward_points,
              reward_validity_days, is_enabled, created_at, updated_at
  `;
  return updated;
};

export const claimInvitationTx = async (tx, { userId, rawCode }) => {
  const code = normalizeInvitationCode(rawCode);
  const [settings] = await tx`
    SELECT inviter_reward_points, invitee_reward_points,
           reward_validity_days, is_enabled
    FROM invitation_settings
    WHERE id = 1
    FOR UPDATE
  `;
  if (!settings) fail("Invitation settings migration is not applied", 503, "INVITATION_SCHEMA_NOT_READY");

  const [existing] = await tx`
    SELECT id, code_id, inviter_reward_points, invitee_reward_points, reward_expires_at
    FROM invitation_redemptions
    WHERE invitee_user_id = ${userId}
    FOR UPDATE
  `;
  const [invitation] = await tx`
    SELECT id, code, code_type, owner_user_id, is_active, revoked_at
    FROM invitation_codes
    WHERE code = ${code}
    FOR UPDATE
  `;
  if (!invitation) fail("Invitation code was not found", 404, "INVITATION_CODE_NOT_FOUND");

  if (existing) {
    if (Number(existing.code_id) === Number(invitation.id)) {
      return {
        already_claimed: true,
        redemption_id: existing.id,
        inviter_reward_points: Number(existing.inviter_reward_points || 0),
        invitee_reward_points: Number(existing.invitee_reward_points || 0),
        reward_expires_at: existing.reward_expires_at || null,
      };
    }
    fail("This account has already claimed an invitation reward", 409, "INVITATION_ALREADY_CLAIMED");
  }
  if (!settings.is_enabled) fail("Invitation rewards are currently disabled", 409, "INVITATIONS_DISABLED");
  if (!invitation.is_active || invitation.revoked_at) fail("This invitation link is no longer active", 410, "INVITATION_LINK_INACTIVE");
  if (invitation.owner_user_id && invitation.owner_user_id === userId) {
    fail("You cannot claim your own invitation link", 409, "INVITATION_SELF_CLAIM");
  }

  const inviterRewardPoints = invitation.owner_user_id ? Number(settings.inviter_reward_points || 0) : 0;
  const inviteeRewardPoints = Number(settings.invitee_reward_points || 0);
  if (inviterRewardPoints <= 0 && inviteeRewardPoints <= 0) {
    fail("Invitation rewards are not configured", 409, "INVITATION_REWARDS_EMPTY");
  }

  const [redemption] = await tx`
    INSERT INTO invitation_redemptions
      (code_id, inviter_user_id, invitee_user_id, inviter_reward_points,
       invitee_reward_points, reward_expires_at)
    VALUES
      (${invitation.id}, ${invitation.owner_user_id || null}, ${userId},
       ${inviterRewardPoints}, ${inviteeRewardPoints},
       CASE WHEN ${Number(settings.reward_validity_days || 0)} = 0
         THEN NULL
         ELSE NOW() + (${Number(settings.reward_validity_days || 0)} * INTERVAL '1 day')
       END)
    RETURNING id, reward_expires_at
  `;

  let inviterLedgerId = null;
  let inviteeLedgerId = null;
  if (invitation.owner_user_id && inviterRewardPoints > 0) {
    const result = await rechargePoints({
      userId: invitation.owner_user_id,
      amount: inviterRewardPoints,
      sourceType: "invitation_reward",
      sourceId: `${redemption.id}:inviter`,
      idempotencyKey: `invitation:reward:${redemption.id}:inviter`,
      note: "邀请成功奖励",
      entryType: "recharge",
      lotCategory: "manual",
      expiresAt: redemption.reward_expires_at,
      tx,
    });
    inviterLedgerId = result.ledger?.id || null;
  }
  if (inviteeRewardPoints > 0) {
    const result = await rechargePoints({
      userId,
      amount: inviteeRewardPoints,
      sourceType: "invitation_reward",
      sourceId: `${redemption.id}:invitee`,
      idempotencyKey: `invitation:reward:${redemption.id}:invitee`,
      note: "注册邀请奖励",
      entryType: "recharge",
      lotCategory: "manual",
      expiresAt: redemption.reward_expires_at,
      tx,
    });
    inviteeLedgerId = result.ledger?.id || null;
  }

  const [updated] = await tx`
    UPDATE invitation_redemptions
    SET inviter_point_ledger_id = ${inviterLedgerId},
        invitee_point_ledger_id = ${inviteeLedgerId}
    WHERE id = ${redemption.id}
    RETURNING id, inviter_reward_points, invitee_reward_points, reward_expires_at
  `;
  logger.info("invitation.claimed", {
    invitationId: invitation.id,
    redemptionId: redemption.id,
    inviterUserId: invitation.owner_user_id || null,
    inviteeUserId: userId,
  });
  return {
    already_claimed: false,
    redemption_id: updated.id,
    inviter_reward_points: Number(updated.inviter_reward_points || 0),
    invitee_reward_points: Number(updated.invitee_reward_points || 0),
    reward_expires_at: updated.reward_expires_at || null,
  };
};
