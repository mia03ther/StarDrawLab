import express from "express";
import {
  listManagedUsers,
  PERMISSIONS,
  setUserRole,
  setUserSuspension,
} from "../services/accessControlService.js";
import { buildAuditCsv, exportAuditLogs, listAuditLogs, writeAuditLog } from "../services/auditService.js";
import { requirePermission, requireRoot } from "../middlewares/authorize.js";
import {
  normalizeAdministratorIdempotencyKey,
  normalizeAdministratorReason,
} from "../services/administratorOperationService.js";
import logger from "../configs/logger.js";
import sql from "../configs/db.js";
import { getRootUsageAnalytics } from "../services/rootUsageAnalyticsService.js";

export const authAccessRouter = express.Router();
export const adminAccessRouter = express.Router();
export const rootAccessRouter = express.Router();

const fail = (res, error, fallback) => res.status(error.status || 500).json({
  success: false,
  code: error.code,
  message: error.status ? error.message : fallback,
});

const requireMutationContext = (req, res, next) => {
  try {
    req.accessIdempotencyKey = normalizeAdministratorIdempotencyKey(req.headers["x-idempotency-key"]);
    req.accessReason = normalizeAdministratorReason(req.body?.reason);
    return next();
  } catch (error) {
    return fail(res, error, "Invalid administrator operation context");
  }
};

authAccessRouter.get("/me", async (req, res) => {
  const [profile] = await sql`
    SELECT up.display_name, up.avatar_url, up.full_name, up.gender, up.birthdate,
           COALESCE(up.email, identity.email) AS email,
           identity.username, identity.phone_number
    FROM user_profiles up
    LEFT JOIN LATERAL (
      SELECT il.email, il.username, il.phone_number
      FROM identity_links il
      WHERE il.stardraw_user_id = up.user_id
      ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
      LIMIT 1
    ) identity ON TRUE
    WHERE up.user_id = ${req.auth.userId}
    LIMIT 1
  `;
  res.set("Cache-Control", "no-store");
  res.json({
    success: true,
    data: {
      user_id: req.auth.userId,
      role: req.auth.role,
      account_status: req.auth.accountStatus,
      mfa_verified: Boolean(req.auth.mfaVerified),
      identity: {
        provider: req.auth.identityProvider,
        issuer: req.auth.identityIssuer,
        subject: req.auth.externalSubject,
      },
      profile: {
        display_name: profile?.display_name || null,
        avatar_url: profile?.avatar_url || null,
        email: profile?.email || null,
        username: profile?.username || null,
        phone: profile?.phone_number || null,
        full_name: profile?.full_name || null,
        gender: profile?.gender || null,
        birthdate: profile?.birthdate || null,
      },
    },
  });
});

adminAccessRouter.get("/users", requirePermission(PERMISSIONS.USER_READ), async (req, res) => {
  try {
    const data = await listManagedUsers({
      page: req.query.page,
      pageSize: req.query.page_size,
      query: req.query.query,
      status: req.query.status,
    });
    res.json({ success: true, data: { items: data.rows, total: data.total }, page: data.page, page_size: data.page_size });
  } catch (error) {
    logger.error("access.users.list.error", { actorUserId: req.auth.userId, error: error.message });
    fail(res, error, "Unable to load users");
  }
});

adminAccessRouter.post("/users/:userId/ban", requirePermission(PERMISSIONS.USER_SUSPEND), requireMutationContext, async (req, res) => {
  try {
    const data = await setUserSuspension({
      actor: req.auth,
      targetUserId: req.params.userId,
      suspended: true,
      reason: req.accessReason,
      idempotencyKey: req.accessIdempotencyKey,
      requestPayload: req.body,
      req,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.warn("access.user.suspend.failed", { actorUserId: req.auth.userId, targetUserId: req.params.userId, code: error.code, error: error.message });
    fail(res, error, "Unable to suspend user");
  }
});

adminAccessRouter.post("/users/:userId/unban", requirePermission(PERMISSIONS.USER_SUSPEND), requireMutationContext, async (req, res) => {
  try {
    const data = await setUserSuspension({
      actor: req.auth,
      targetUserId: req.params.userId,
      suspended: false,
      reason: req.accessReason,
      idempotencyKey: req.accessIdempotencyKey,
      requestPayload: req.body,
      req,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.warn("access.user.restore.failed", { actorUserId: req.auth.userId, targetUserId: req.params.userId, code: error.code, error: error.message });
    fail(res, error, "Unable to restore user");
  }
});

rootAccessRouter.use(requireRoot());

rootAccessRouter.patch("/users/:userId/role", requireMutationContext, async (req, res) => {
  try {
    const data = await setUserRole({
      actor: req.auth,
      targetUserId: req.params.userId,
      role: String(req.body?.role || "").trim().toLowerCase(),
      reason: req.accessReason,
      idempotencyKey: req.accessIdempotencyKey,
      requestPayload: req.body,
      req,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.warn("access.user.role.failed", { actorUserId: req.auth.userId, targetUserId: req.params.userId, code: error.code, error: error.message });
    fail(res, error, "Unable to change role");
  }
});

// Keep HTTP query handling explicit: only these aliases can become audit filters.
const auditFiltersFromQuery = (query = {}) => ({
  page: query.page,
  pageSize: query.page_size,
  actorUserId: query.actor_user_id ?? query.actor,
  action: query.action,
  targetType: query.target_type,
  targetId: query.target_id,
  targetQuery: query.target,
  dateFrom: query.date_from ?? query.from,
  dateTo: query.date_to ?? query.to,
  query: query.query,
});

const loadAudit = async (req) => listAuditLogs(auditFiltersFromQuery(req.query));

rootAccessRouter.get("/audit-logs", async (req, res) => {
  try {
    const data = await loadAudit(req);
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      data: {
        items: data.rows,
        rows: data.rows,
        total: data.total,
        pagination: { total: data.total, page: data.page, page_size: data.page_size },
      },
      total: data.total,
      page: data.page,
      page_size: data.page_size,
    });
  } catch (error) {
    logger.error("access.audit.list.error", { actorUserId: req.auth.userId, error: error.message });
    fail(res, error, "Unable to load audit logs");
  }
});

rootAccessRouter.get("/usage-analytics", async (req, res) => {
  try {
    const data = await getRootUsageAnalytics(req.query);
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    logger.error("access.usage_analytics.list.error", { actorUserId: req.auth.userId, code: error.code, error: error.message });
    return fail(res, error, "Unable to load usage analytics");
  }
});

rootAccessRouter.get("/audit-logs/export", async (req, res) => {
  try {
    const data = await exportAuditLogs(auditFiltersFromQuery(req.query));
    const csv = buildAuditCsv(data.rows);
    await writeAuditLog({
      req,
      actorUserId: req.auth.userId,
      actorRole: req.auth.role,
      action: "audit.exported",
      targetType: "administrator_audit_log",
      targetId: "export",
      reason: String(req.query.reason || "Root audit export").slice(0, 2000),
      metadata: { filters: auditFiltersFromQuery(req.query), exported_count: data.rows.length, total: data.total, truncated: data.truncated },
    });
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=administrator-audit.csv",
      "Cache-Control": "no-store",
      "X-Total-Count": String(data.total),
      "X-Exported-Count": String(data.rows.length),
      "X-Export-Truncated": data.truncated ? "true" : "false",
    });
    res.send(`\uFEFF${csv}`);
  } catch (error) {
    logger.error("access.audit.export.error", { actorUserId: req.auth.userId, error: error.message });
    fail(res, error, "Unable to export audit logs");
  }
});

export default authAccessRouter;
