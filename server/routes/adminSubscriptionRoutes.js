import express from "express";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { refundSubscriptionOrder } from "../services/subscriptionService.js";
import { refundPointPackageOrder } from "../services/pointPackageService.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import { writeAuditLog } from "../services/auditService.js";
import { executeAdministratorOperation } from "../services/administratorOperationService.js";
import {
  deactivateConfiguredPointPackage,
  listConfiguredPointPackages,
  saveConfiguredPointPackage,
} from "../services/pointPackageConfigurationService.js";

const router = express.Router();

const requireIdempotencyKey = (req, res, next) => {
  if (!req.headers["x-idempotency-key"]) {
    return res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
  }
  next();
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return fallback;
};

const normalizeTier = (value) => {
  const tier = String(value || "").trim().toLowerCase();
  return ["basic", "pro", "max", "enterprise"].includes(tier) ? tier : null;
};

const normalizeInterval = (value) => {
  const interval = String(value || "").trim().toLowerCase();
  return ["month", "year"].includes(interval) ? interval : null;
};

const normalizePlanInput = (body = {}) => {
  const tier = normalizeTier(body.membership_tier);
  const billingInterval = normalizeInterval(body.billing_interval);
  const priceCents = Number(body.price_cents);
  const includedPoints = Number(body.included_points || 0);
  const bonusPoints = Number(body.bonus_points || 0);
  const monthlyBonusPoints = Number(body.monthly_bonus_points || 0);

  if (!tier || !billingInterval || !Number.isInteger(priceCents) || priceCents <= 0) {
    throw Object.assign(new Error("membership_tier, billing_interval and positive integer price_cents are required"), { status: 400 });
  }
  if (![includedPoints, bonusPoints, monthlyBonusPoints].every((value) => Number.isInteger(value) && value >= 0)) {
    throw Object.assign(new Error("Point entitlements must be non-negative integers"), { status: 400 });
  }

  return {
    planKey: String(body.plan_key || "").trim().slice(0, 80),
    planName: String(body.plan_name || "").trim().slice(0, 120),
    membershipTier: tier,
    billingInterval,
    priceCents,
    includedPoints,
    bonusPoints,
    monthlyBonusPoints,
    isActive: parseBoolean(body.is_active, false),
    displayOrder: Number.isInteger(Number(body.display_order)) ? Number(body.display_order) : 0,
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
  };
};

router.get("/point-packages", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), async (req, res) => {
  try {
    res.json({ success: true, data: await listConfiguredPointPackages({ actor: req.auth }) });
  } catch (error) {
    logger.error("admin.pointPackages.list.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load point packages" });
  }
});

router.post("/point-packages", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await saveConfiguredPointPackage({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      input: req.body,
      reason: req.body?.reason || "Point package created",
      req,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.pointPackages.create.error", { code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

router.put("/point-packages/:id", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await saveConfiguredPointPackage({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      packageId: req.params.id,
      input: req.body,
      reason: req.body?.reason || "Point package updated",
      req,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.pointPackages.update.error", { code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

router.delete("/point-packages/:id", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await deactivateConfiguredPointPackage({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      packageId: req.params.id,
      reason: req.body?.reason || "Point package deactivated",
      req,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.pointPackages.deactivate.error", { code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

router.get("/plans", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), async (_req, res) => {
  try {
    const rows = await sql`SELECT * FROM subscription_plans ORDER BY display_order ASC, price_cents ASC, id ASC`;
    res.json({ success: true, data: rows });
  } catch (error) {
    logger.error("admin.subscriptionPlans.list.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load subscription plans" });
  }
});

router.post("/plans", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const input = normalizePlanInput(req.body);
    if (!input.planKey || !input.planName) {
      return res.status(400).json({ success: false, message: "plan_key and plan_name are required" });
    }

    const row = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "subscription_plan.created",
      targetType: "subscription_plan",
      targetId: input.planKey,
      requestPayload: req.body,
      mutate: async (tx) => {
        const [created] = await tx`
          INSERT INTO subscription_plans
            (plan_key, plan_name, membership_tier, billing_interval, price_cents,
             included_points, bonus_points, monthly_bonus_points, is_active,
             display_order, metadata)
          VALUES
            (${input.planKey}, ${input.planName}, ${input.membershipTier}, ${input.billingInterval},
             ${input.priceCents}, ${input.includedPoints}, ${input.bonusPoints},
             ${input.monthlyBonusPoints}, ${input.isActive}, ${input.displayOrder},
             ${tx.json(input.metadata)})
          RETURNING *
        `;
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "subscription_plan.created", targetType: "subscription_plan",
          targetId: created.id, reason: req.body?.reason || "Subscription plan created",
          after: created, tx,
        });
        return created;
      },
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.subscriptionPlans.create.error", { error: error.message });
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.put("/plans/:id", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const input = normalizePlanInput(req.body);
    const row = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "subscription_plan.updated",
      targetType: "subscription_plan",
      targetId: req.params.id,
      requestPayload: req.body,
      mutate: async (tx) => {
        const [before] = await tx`SELECT * FROM subscription_plans WHERE id = ${req.params.id} FOR UPDATE`;
        if (!before) throw Object.assign(new Error("Subscription plan not found"), { status: 404 });
        const [updated] = await tx`
          UPDATE subscription_plans
          SET plan_key = ${input.planKey}, plan_name = ${input.planName},
              membership_tier = ${input.membershipTier}, billing_interval = ${input.billingInterval},
              price_cents = ${input.priceCents}, included_points = ${input.includedPoints},
              bonus_points = ${input.bonusPoints}, monthly_bonus_points = ${input.monthlyBonusPoints},
              is_active = ${input.isActive}, display_order = ${input.displayOrder},
              metadata = ${tx.json(input.metadata)}, updated_at = NOW()
          WHERE id = ${before.id}
          RETURNING *
        `;
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "subscription_plan.updated", targetType: "subscription_plan",
          targetId: updated.id, reason: req.body?.reason || "Subscription plan updated",
          before, after: updated, tx,
        });
        return updated;
      },
    });
    if (!row) return res.status(404).json({ success: false, message: "Subscription plan not found" });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.subscriptionPlans.update.error", { id: req.params.id, error: error.message });
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.delete("/plans/:id", requirePermission(PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "subscription_plan.deactivated",
      targetType: "subscription_plan",
      targetId: req.params.id,
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const [before] = await tx`SELECT * FROM subscription_plans WHERE id = ${req.params.id} FOR UPDATE`;
        if (!before) throw Object.assign(new Error("Subscription plan not found"), { status: 404 });
        const [updated] = await tx`
          UPDATE subscription_plans
          SET is_active = FALSE, updated_at = NOW()
          WHERE id = ${before.id}
          RETURNING id, plan_key, is_active
        `;
        await writeAuditLog({
          req, actorUserId: req.auth.userId, actorRole: req.auth.role,
          action: "subscription_plan.deactivated", targetType: "subscription_plan",
          targetId: updated.id, reason: req.body?.reason || "Subscription plan deactivated",
          before, after: updated, tx,
        });
        return updated;
      },
    });
    if (!row) return res.status(404).json({ success: false, message: "Subscription plan not found" });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("admin.subscriptionPlans.deactivate.error", { id: req.params.id, error: error.message });
    res.status(error.status || 500).json({ success: false, message: error.status ? error.message : "Unable to deactivate subscription plan" });
  }
});

router.get("/orders", requirePermission(PERMISSIONS.ORDER_READ), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size || "20", 10)));
    const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM subscription_orders`;
    const rows = await sql`
      SELECT id, user_id, subscription_id, plan_id, order_no, order_type,
             plan_key, plan_name, membership_tier, billing_interval,
             amount_cents, included_points, bonus_points, monthly_bonus_points,
             period_start, period_end, status, payment_method,
             created_at, paid_at, refunded_at, updated_at
      FROM subscription_orders
      ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    res.json({ success: true, data: rows, page, page_size: pageSize, total: countRow.count });
  } catch (error) {
    logger.error("admin.subscriptionOrders.list.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load subscription orders" });
  }
});

router.get("/point-orders", requirePermission(PERMISSIONS.ORDER_READ), async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page || "1", 10));
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(req.query.page_size || "20", 10)));
    const [countRow] = await sql`SELECT COUNT(*)::int AS count FROM point_orders`;
    const rows = await sql`
      SELECT id, user_id, order_no, package_key, package_name, amount_cents,
             points, bonus_points, total_points, status, payment_method,
             created_at, paid_at, refunded_at, updated_at
      FROM point_orders ORDER BY created_at DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;
    res.json({ success: true, data: rows, page, page_size: pageSize, total: countRow.count });
  } catch (error) {
    logger.error("admin.pointOrders.list.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load point package orders" });
  }
});

router.post("/point-orders/:orderNo/refund", requirePermission(PERMISSIONS.REFUND), requireIdempotencyKey, async (req, res) => {
  try {
    const data = await refundPointPackageOrder({
      orderNo: req.params.orderNo,
      idempotencyKey: req.headers["x-idempotency-key"],
      reason: String(req.body?.reason || "管理员处理积分包退款").slice(0, 500),
      actor: req.auth,
      req,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error("admin.pointPackageRefund.error", { orderNo: req.params.orderNo, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

// Deliberately admin/API-only.  The customer web app does not expose a
// refund button or endpoint.
router.post("/orders/:orderNo/refund", requirePermission(PERMISSIONS.REFUND), requireIdempotencyKey, async (req, res) => {
  try {
    const data = await refundSubscriptionOrder({
      orderNo: req.params.orderNo,
      idempotencyKey: req.headers["x-idempotency-key"],
      reason: String(req.body?.reason || "管理员处理订阅退款").slice(0, 500),
      actor: req.auth,
      req,
    });
    res.json({ success: true, data });
  } catch (error) {
    logger.error("admin.subscriptionRefund.error", { orderNo: req.params.orderNo, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

export default router;
