import sql from "../configs/db.js";
import { hasPermission, PERMISSIONS } from "./accessControlService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { writeAuditLog } from "./auditService.js";

const TIERS = new Set(["basic", "pro", "max", "enterprise"]);
const INTERVALS = new Set(["month", "year"]);

const fail = (message, status = 400, code = "SUBSCRIPTION_PLAN_INVALID") => {
  throw Object.assign(new Error(message), { status, code });
};

const assertPlanPermission = (actor) => {
  if (!hasPermission(actor?.role, PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE)) {
    fail("Subscription plan management permission is required", 403, "USER_RBAC_DENIED");
  }
};

const normalizeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    fail("planId is invalid", 400, "INVALID_SUBSCRIPTION_PLAN_ID");
  }
  return id;
};

const normalizePlan = (input = {}, existing = null) => {
  const planKey = String(input.planKey ?? input.plan_key ?? existing?.plan_key ?? "").trim().slice(0, 80);
  const planName = String(input.planName ?? input.plan_name ?? existing?.plan_name ?? "").trim().slice(0, 120);
  const membershipTier = String(input.membershipTier ?? input.membership_tier ?? existing?.membership_tier ?? "").trim().toLowerCase();
  const billingInterval = String(input.billingInterval ?? input.billing_interval ?? existing?.billing_interval ?? "").trim().toLowerCase();
  const priceCents = Number(input.priceCents ?? input.price_cents ?? existing?.price_cents);
  const includedPoints = Number(input.includedPoints ?? input.included_points ?? existing?.included_points ?? 0);
  const bonusPoints = Number(input.bonusPoints ?? input.bonus_points ?? existing?.bonus_points ?? 0);
  const monthlyBonusPoints = Number(input.monthlyBonusPoints ?? input.monthly_bonus_points ?? existing?.monthly_bonus_points ?? 0);
  const displayOrder = Number(input.displayOrder ?? input.display_order ?? existing?.display_order ?? 0);
  if (!planKey || !planName) fail("planKey and planName are required");
  if (!TIERS.has(membershipTier) || !INTERVALS.has(billingInterval)) fail("Invalid membership tier or billing interval");
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) fail("priceCents must be a positive integer");
  if (![includedPoints, bonusPoints, monthlyBonusPoints].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    fail("Point entitlements must be non-negative integers");
  }
  if (!Number.isSafeInteger(displayOrder)) fail("displayOrder must be an integer");
  const isActiveInput = input.isActive ?? input.is_active;
  const metadata = input.metadata ?? existing?.metadata ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || JSON.stringify(metadata).length > 20_000) {
    fail("metadata must be a bounded JSON object");
  }
  return {
    planKey,
    planName,
    membershipTier,
    billingInterval,
    priceCents,
    includedPoints,
    bonusPoints,
    monthlyBonusPoints,
    isActive: isActiveInput == null ? Boolean(existing?.is_active) : Boolean(isActiveInput),
    displayOrder,
    metadata,
  };
};

export const listConfiguredSubscriptionPlans = async ({ actor, db = sql } = {}) => {
  assertPlanPermission(actor);
  return db`SELECT * FROM subscription_plans ORDER BY display_order ASC, price_cents ASC, id ASC`;
};

export const saveConfiguredSubscriptionPlan = async ({
  actor,
  planId = null,
  input,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPlanPermission(actor);
  const id = planId == null ? null : normalizeId(planId);
  const action = id ? "subscription_plan.updated" : "subscription_plan.created";
  const targetId = id || String(input?.planKey ?? input?.plan_key ?? "").trim();
  if (!targetId) fail("planKey is required");
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action,
    targetType: "subscription_plan",
    targetId,
    requestPayload: { input, reason },
    mutate: async (tx) => {
      const [before] = id ? await tx`SELECT * FROM subscription_plans WHERE id = ${id} FOR UPDATE` : [null];
      if (id && !before) fail("Subscription plan not found", 404, "SUBSCRIPTION_PLAN_NOT_FOUND");
      const normalized = normalizePlan(input, before);
      const [after] = id
        ? await tx`
            UPDATE subscription_plans
            SET plan_key = ${normalized.planKey}, plan_name = ${normalized.planName},
                membership_tier = ${normalized.membershipTier}, billing_interval = ${normalized.billingInterval},
                price_cents = ${normalized.priceCents}, included_points = ${normalized.includedPoints},
                bonus_points = ${normalized.bonusPoints}, monthly_bonus_points = ${normalized.monthlyBonusPoints},
                is_active = ${normalized.isActive}, display_order = ${normalized.displayOrder},
                metadata = ${tx.json(normalized.metadata)}, updated_at = NOW()
            WHERE id = ${before.id}
            RETURNING *
          `
        : await tx`
            INSERT INTO subscription_plans
              (plan_key, plan_name, membership_tier, billing_interval, price_cents,
               included_points, bonus_points, monthly_bonus_points, is_active, display_order, metadata)
            VALUES
              (${normalized.planKey}, ${normalized.planName}, ${normalized.membershipTier}, ${normalized.billingInterval},
               ${normalized.priceCents}, ${normalized.includedPoints}, ${normalized.bonusPoints},
               ${normalized.monthlyBonusPoints}, ${normalized.isActive}, ${normalized.displayOrder},
               ${tx.json(normalized.metadata)})
            RETURNING *
          `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "subscription_plan",
        targetId: after.id,
        reason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};

export const deactivateConfiguredSubscriptionPlan = async ({
  actor,
  planId,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPlanPermission(actor);
  const id = normalizeId(planId);
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action: "subscription_plan.deactivated",
    targetType: "subscription_plan",
    targetId: id,
    requestPayload: { reason },
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM subscription_plans WHERE id = ${id} FOR UPDATE`;
      if (!before) fail("Subscription plan not found", 404, "SUBSCRIPTION_PLAN_NOT_FOUND");
      const [after] = await tx`
        UPDATE subscription_plans SET is_active = FALSE, updated_at = NOW()
        WHERE id = ${before.id}
        RETURNING id, plan_key, is_active
      `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "subscription_plan.deactivated",
        targetType: "subscription_plan",
        targetId: id,
        reason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};
