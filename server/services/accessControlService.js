import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { writeAuditLog } from "./auditService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";

export const ROLES = Object.freeze({ ROOT: "root", ADMIN: "admin", USER: "user" });
export const ACCOUNT_STATUSES = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended" });

export const PERMISSIONS = Object.freeze({
  USER_READ: "user.read",
  USER_SUSPEND: "user.suspend",
  TEMPLATE_MANAGE: "template.manage",
  SUBSCRIPTION_PLAN_MANAGE: "subscription_plan.manage",
  ORDER_READ: "order.read",
  CONTENT_MODERATE: "content.moderate",
  RECYCLE_RESTORE_REQUEST: "recycle.restore_request",
  ROLE_MANAGE: "role.manage",
  MODEL_MANAGE: "model.manage",
  SECRET_MANAGE: "secret.manage",
  POINTS_ADJUST: "points.adjust",
  MEMBERSHIP_ADJUST: "membership.adjust",
  REFUND: "refund",
  AUDIT_READ: "audit.read",
  PRIVATE_CONTENT_REVIEW: "private_content.review",
  RECYCLE_RESTORE_APPROVE: "recycle.restore_approve",
  RECYCLE_PURGE: "recycle.purge",
  EXECUTION_POLICY_MANAGE: "execution_policy.manage",
  VISUAL_PARAMETER_MANAGE: "visual_parameter.manage",
  AGENT_SKILL_MANAGE: "agent_skill.manage",
  MCP_TOOL_MANAGE: "mcp_tool.manage",
  MCP_SERVER_MANAGE: "mcp_server.manage",
  INVITATION_MANAGE: "invitation.manage",
  CHARGE_RULE_MANAGE: "charge_rule.manage",
  ANNOUNCEMENT_MANAGE: "announcement.manage",
});

const ADMIN_PERMISSIONS = new Set([
  PERMISSIONS.USER_READ,
  PERMISSIONS.USER_SUSPEND,
  PERMISSIONS.TEMPLATE_MANAGE,
  PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE,
  PERMISSIONS.ORDER_READ,
  PERMISSIONS.CONTENT_MODERATE,
  PERMISSIONS.RECYCLE_RESTORE_REQUEST,
  PERMISSIONS.VISUAL_PARAMETER_MANAGE,
  PERMISSIONS.AGENT_SKILL_MANAGE,
  PERMISSIONS.MCP_TOOL_MANAGE,
  PERMISSIONS.INVITATION_MANAGE,
  PERMISSIONS.CHARGE_RULE_MANAGE,
  PERMISSIONS.ANNOUNCEMENT_MANAGE,
]);

export const hasPermission = (role, permission) => role === ROLES.ROOT || (role === ROLES.ADMIN && ADMIN_PERMISSIONS.has(permission));

const configuredRootUserId = () => String(process.env.ROOT_ADMIN_USER_ID || "").trim();

export const assertRootTargetMutable = (targetUserId) => {
  if (String(targetUserId || "") === configuredRootUserId()) {
    throw Object.assign(new Error("The fixed root administrator cannot be modified"), { status: 409, code: "ROOT_IMMUTABLE" });
  }
};

export const sessionTokenIsRevoked = (payload = {}, authValidAfter) => {
  const issuedAtSeconds = Number(payload.iat || 0);
  if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) return true;
  const issuedAtMs = issuedAtSeconds * 1000;
  const validAfterMs = new Date(authValidAfter || 0).getTime();
  return Boolean(validAfterMs && issuedAtMs < validAfterMs);
};

export const isMfaVerified = (payload = {}) => {
  const values = [payload.amr, payload["https://quickai/amr"], payload.auth_methods]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : [])
    .map((value) => String(value).toLowerCase());
  if (values.some((value) => ["mfa", "otp", "totp", "webauthn"].includes(value))) return true;

  // SMS or email can be the sole passwordless login factor.  Only accept
  // those methods as MFA when Authing also reports a distinct first factor.
  const normalizedMethods = new Set(values.map((value) => {
    if (["pwd", "password"].includes(value)) return "password";
    if (["sms", "phone"].includes(value)) return "sms";
    if (["email", "mail"].includes(value)) return "email";
    return value;
  }));
  if (normalizedMethods.has("password") && [...normalizedMethods].some((value) => ["sms", "email"].includes(value))) {
    return true;
  }
  const acr = String(payload.acr || payload["https://quickai/acr"] || "").toLowerCase();
  return acr.includes("mfa") || acr.includes("multi-factor") || acr.endsWith(":2");
};

export const resolveMfaVerifiedAt = (payload, mfaVerified, now = Date.now()) => {
  if (!mfaVerified) return null;
  const raw = payload.mfa_time
    || payload["https://quickai/mfa_time"]
    || payload.auth_time;
  const seconds = Number(raw || 0);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const timestamp = seconds * 1000;
  // Seconds since epoch are expected. Millisecond values overflow this
  // reasonable upper bound and future claims beyond clock skew fail closed.
  if (!Number.isSafeInteger(timestamp) || timestamp > now + 60_000) return null;
  return new Date(timestamp);
};

export const isRecentMfaVerification = (value, now = Date.now()) => {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value || 0).getTime();
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= -60_000 && age <= 10 * 60 * 1000;
};

const ensureProfile = async (userId) => {
  await sql`
    INSERT INTO user_profiles (user_id, app_role, role_updated_at, last_seen_at)
    VALUES (${userId}, 'user', NOW(), NOW())
    ON CONFLICT (user_id) DO NOTHING
  `;

  const [row] = await sql`
    SELECT up.user_id, up.app_role, up.account_status, up.auth_valid_after,
           up.suspended_at, up.suspension_reason, up.last_seen_at,
           COALESCE(upa.membership_tier, 'free') AS membership_tier
    FROM user_profiles up
    LEFT JOIN user_point_accounts upa ON upa.user_id = up.user_id
    WHERE up.user_id = ${userId}
  `;
  if (row && (!row.last_seen_at || new Date(row.last_seen_at).getTime() < Date.now() - 5 * 60 * 1000)) {
    sql`UPDATE user_profiles SET last_seen_at = NOW() WHERE user_id = ${userId}`.catch((error) => {
      logger.warn("access.last_seen.update_failed", { userId, error: error.message });
    });
  }
  return row;
};

export const initializeFixedRootAdministrator = async () => {
  const rootUserId = configuredRootUserId();
  if (!rootUserId) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("ROOT_ADMIN_USER_ID is required in production"), { code: "ROOT_CONFIGURATION_MISSING" });
    }
    logger.warn("access.root.not_configured");
    return { changed: false, configured: false };
  }
  if (rootUserId.length > 255) {
    throw Object.assign(new Error("ROOT_ADMIN_USER_ID is invalid"), { code: "ROOT_CONFIGURATION_INVALID" });
  }

  return sql.begin(async (tx) => {
    const [otherRoot] = await tx`
      SELECT user_id FROM user_profiles
      WHERE app_role = 'root' AND user_id <> ${rootUserId}
      FOR UPDATE
    `;
    if (otherRoot) {
      throw Object.assign(new Error("A different root administrator already exists"), { code: "ROOT_CONFIGURATION_MISMATCH" });
    }

    const [before] = await tx`
      SELECT user_id, app_role, account_status, auth_valid_after,
             suspended_at, suspended_by, suspension_reason
      FROM user_profiles WHERE user_id = ${rootUserId}
      FOR UPDATE
    `;
    if (
      before?.app_role === ROLES.ROOT
      && before.account_status === ACCOUNT_STATUSES.ACTIVE
      && !before.suspended_at
      && !before.suspended_by
      && !before.suspension_reason
    ) {
      return { changed: false, configured: true, userId: rootUserId };
    }

    const [after] = before
      ? await tx`
          UPDATE user_profiles
          SET app_role = 'root', account_status = 'active', role_updated_at = NOW(),
              auth_valid_after = NOW(), suspended_at = NULL, suspended_by = NULL,
              suspension_reason = NULL, updated_at = NOW()
          WHERE user_id = ${rootUserId}
          RETURNING user_id, app_role, account_status, auth_valid_after
        `
      : await tx`
          INSERT INTO user_profiles
            (user_id, app_role, account_status, role_updated_at, auth_valid_after, last_seen_at)
          VALUES (${rootUserId}, 'root', 'active', NOW(), NOW(), NULL)
          RETURNING user_id, app_role, account_status, auth_valid_after
        `;

    await writeAuditLog({
      actorUserId: rootUserId,
      actorRole: ROLES.ROOT,
      action: "root.bootstrap",
      targetType: "user",
      targetId: rootUserId,
      reason: "Fixed root administrator bootstrap",
      before,
      after,
      metadata: { source: "server_startup" },
      tx,
    });
    return { changed: true, configured: true, userId: rootUserId };
  });
};

export const resolveAccessContext = async ({
  userId,
  payload = {},
  externalSubject = null,
  identityProvider = null,
  identityIssuer = null,
}) => {
  const profile = await ensureProfile(userId);
  const rootUserId = configuredRootUserId();
  if (profile.app_role === ROLES.ROOT && (!rootUserId || userId !== rootUserId)) {
    logger.error("access.root.configuration_mismatch", { userId });
    throw Object.assign(new Error("Root administrator configuration mismatch"), { status: 503, code: "ROOT_CONFIGURATION_MISMATCH" });
  }

  if (sessionTokenIsRevoked(payload, profile.auth_valid_after)) {
    throw Object.assign(new Error("Session has been revoked"), { status: 401, code: "SESSION_REVOKED" });
  }

  const mfaVerified = isMfaVerified(payload);
  return {
    userId,
    externalSubject: externalSubject || null,
    identityProvider: identityProvider || null,
    identityIssuer: identityIssuer || null,
    role: profile.app_role || ROLES.USER,
    membershipTier: profile.membership_tier || "free",
    accountStatus: profile.account_status || ACCOUNT_STATUSES.ACTIVE,
    mfaVerified,
    // Never use a refresh token's iat as proof of a recent MFA challenge.
    mfaVerifiedAt: resolveMfaVerifiedAt(payload, mfaVerified),
    authValidAfter: profile.auth_valid_after,
  };
};

export const listManagedUsers = async ({ page = 1, pageSize = 50, query = "", status = "" }) => {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
  const search = String(query || "").trim();
  const pattern = `%${search}%`;
  const statusFilter = [ACCOUNT_STATUSES.ACTIVE, ACCOUNT_STATUSES.SUSPENDED].includes(String(status || ""))
    ? String(status)
    : null;
  const [countRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM user_profiles up
    LEFT JOIN LATERAL (
      SELECT il.provider, il.issuer, il.subject, il.email, il.username, il.email_verified_at
      FROM identity_links il
      WHERE il.stardraw_user_id = up.user_id
      ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
      LIMIT 1
    ) identity ON TRUE
    WHERE (${search} = ''
      OR up.user_id ILIKE ${pattern}
      OR COALESCE(up.display_name, '') ILIKE ${pattern}
      OR COALESCE(up.full_name, '') ILIKE ${pattern}
      OR COALESCE(up.email, '') ILIKE ${pattern}
      OR COALESCE(identity.email, '') ILIKE ${pattern}
      OR COALESCE(identity.username, '') ILIKE ${pattern}
      OR COALESCE(identity.subject, '') ILIKE ${pattern})
      AND (${statusFilter}::text IS NULL OR up.account_status = ${statusFilter})
  `;
  const rows = await sql`
    SELECT up.user_id, up.display_name, up.full_name, COALESCE(up.email, identity.email) AS email,
           identity.username, identity.phone_number,
           up.app_role, up.account_status,
           up.created_at, up.updated_at, up.last_seen_at, up.suspended_at,
           up.suspension_reason,
           identity.provider AS identity_provider,
           identity.issuer AS identity_issuer,
           identity.subject AS identity_subject,
           identity.email_verified_at AS identity_email_verified_at,
           (SELECT COUNT(*)::int FROM identity_links all_identities
            WHERE all_identities.stardraw_user_id = up.user_id) AS identity_count,
           COALESCE(upa.membership_tier, 'free') AS membership_tier,
           COALESCE((SELECT COUNT(*) FROM creations c WHERE c.user_id = up.user_id), 0)::int AS creation_count,
           COALESCE((SELECT COUNT(*) FROM subscription_orders so WHERE so.user_id = up.user_id), 0)::int AS order_count,
           COALESCE((
             SELECT SUM(-pl.change_points)
             FROM point_ledger pl
             WHERE pl.user_id = up.user_id AND pl.entry_type = 'charge'
           ), 0)::bigint AS total_points_spent
    FROM user_profiles up
    LEFT JOIN user_point_accounts upa ON upa.user_id = up.user_id
    LEFT JOIN LATERAL (
      SELECT il.provider, il.issuer, il.subject, il.email, il.username, il.phone_number, il.email_verified_at
      FROM identity_links il
      WHERE il.stardraw_user_id = up.user_id
      ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
      LIMIT 1
    ) identity ON TRUE
    WHERE (${search} = ''
      OR up.user_id ILIKE ${pattern}
      OR COALESCE(up.display_name, '') ILIKE ${pattern}
      OR COALESCE(up.full_name, '') ILIKE ${pattern}
      OR COALESCE(up.email, '') ILIKE ${pattern}
      OR COALESCE(identity.email, '') ILIKE ${pattern}
      OR COALESCE(identity.username, '') ILIKE ${pattern}
      OR COALESCE(identity.subject, '') ILIKE ${pattern})
      AND (${statusFilter}::text IS NULL OR up.account_status = ${statusFilter})
    ORDER BY up.created_at DESC, up.user_id ASC
    LIMIT ${safeSize} OFFSET ${(safePage - 1) * safeSize}
  `;
  return { rows, total: countRow?.count || 0, page: safePage, page_size: safeSize };
};

export const setUserRole = async ({
  actor,
  targetUserId,
  role,
  req,
  reason,
  idempotencyKey,
  requestPayload,
}) => {
  if (actor?.role !== ROLES.ROOT) {
    throw Object.assign(new Error("Root administrator privileges are required"), { status: 403, code: "ROOT_REQUIRED" });
  }
  if (![ROLES.ADMIN, ROLES.USER].includes(role)) {
    throw Object.assign(new Error("Only admin or user roles can be assigned"), { status: 400, code: "INVALID_ROLE" });
  }
  assertRootTargetMutable(targetUserId);
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action: "user.role_changed",
    targetType: "user",
    targetId: targetUserId,
    requestPayload: requestPayload ?? { role, reason },
    mutate: async (tx) => {
      const [before] = await tx`
        SELECT user_id, app_role, account_status, role_updated_at
        FROM user_profiles WHERE user_id = ${targetUserId} FOR UPDATE
      `;
      if (!before) throw Object.assign(new Error("User not found"), { status: 404, code: "USER_NOT_FOUND" });
      const [after] = before.app_role === role
        ? [before]
        : await tx`
            UPDATE user_profiles
            SET app_role = ${role}, role_updated_at = NOW(), auth_valid_after = NOW(), updated_at = NOW()
            WHERE user_id = ${targetUserId}
            RETURNING user_id, app_role, account_status, role_updated_at
          `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "user.role_changed",
        targetType: "user",
        targetId: targetUserId,
        reason,
        before,
        after,
        metadata: { changed: before.app_role !== role },
        tx,
      });
      return after;
    },
  });
};

export const setUserSuspension = async ({
  actor,
  targetUserId,
  suspended,
  reason,
  req,
  idempotencyKey,
  requestPayload,
}) => {
  assertRootTargetMutable(targetUserId);
  const cleanReason = String(reason || "").trim().slice(0, 2000);
  if (suspended && !cleanReason) throw Object.assign(new Error("Suspension reason is required"), { status: 400, code: "REASON_REQUIRED" });

  const action = suspended ? "user.suspended" : "user.restored";
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action,
    targetType: "user",
    targetId: targetUserId,
    requestPayload: requestPayload ?? { suspended: Boolean(suspended), reason: cleanReason },
    mutate: async (tx) => {
      const [before] = await tx`
        SELECT user_id, app_role, account_status, suspended_at, suspension_reason
        FROM user_profiles WHERE user_id = ${targetUserId} FOR UPDATE
      `;
      if (!before) throw Object.assign(new Error("User not found"), { status: 404, code: "USER_NOT_FOUND" });
      if (actor.role === ROLES.ADMIN && before.app_role !== ROLES.USER) {
        throw Object.assign(new Error("Administrators cannot suspend or restore another administrator"), { status: 403, code: "ROOT_REQUIRED" });
      }
      const status = suspended ? ACCOUNT_STATUSES.SUSPENDED : ACCOUNT_STATUSES.ACTIVE;
      const [after] = before.account_status === status
        ? [before]
        : await tx`
            UPDATE user_profiles
            SET account_status = ${status},
                suspended_at = ${suspended ? new Date() : null},
                suspended_by = ${suspended ? actor.userId : null},
                suspension_reason = ${suspended ? cleanReason : null},
                auth_valid_after = NOW(), updated_at = NOW()
            WHERE user_id = ${targetUserId}
            RETURNING user_id, app_role, account_status, suspended_at, suspension_reason
          `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "user",
        targetId: targetUserId,
        reason: cleanReason || reason,
        before,
        after,
        metadata: { changed: before.account_status !== status },
        tx,
      });
      return after;
    },
  });
};

export const getRootAdminUserId = configuredRootUserId;
