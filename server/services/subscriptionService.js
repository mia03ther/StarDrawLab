import crypto from "crypto";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { createAlipayPaymentGateway } from "../adapters/alipayPaymentGateway.js";
import { sendOperationalAlert, sendSubscriptionExpiryReminder } from "./emailService.js";
import { checkAndGrantBonus } from "./membershipService.js";
import {
  ensureAccountTx,
  getAccountInfo,
  rechargePoints,
  refundReservedPoints,
  releasePoints,
  reservePoints,
} from "./pointsService.js";
import { writeAuditLog } from "./auditService.js";

const TIER_RANK = { free: 0, basic: 1, pro: 2, max: 3, enterprise: 4 };

let paymentGateway = createAlipayPaymentGateway();

/** Replace the external payment adapter at the application seam. */
export const setSubscriptionPaymentGateway = (gateway) => {
  if (!gateway
      || typeof gateway.isConfigured !== "function"
      || typeof gateway.queryPayment !== "function"
      || typeof gateway.closePayment !== "function"
      || typeof gateway.refundPayment !== "function"
      || typeof gateway.queryRefund !== "function") {
    throw new TypeError("A payment gateway adapter is required");
  }
  paymentGateway = gateway;
};

export const resetSubscriptionPaymentGateway = () => {
  paymentGateway = createAlipayPaymentGateway();
};

export const verifySubscriptionPaymentNotification = (params) =>
  paymentGateway.verifyNotification(params);

const normalizeEmail = (value) => {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 320) : null;
};

const monthStart = (value) => {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
};

// Calendar-aligned billing.  31 January rolls to the last day of February;
// the time-of-day and timezone instant are retained.
export const addBillingPeriod = (value, interval, anchorDay = null) => {
  const start = new Date(value);
  const monthDelta = interval === "year" ? 12 : 1;
  const targetMonth = start.getUTCMonth() + monthDelta;
  const targetYear = start.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  const requestedAnchorDay = Number(anchorDay);
  const billingDay = Number.isInteger(requestedAnchorDay) && requestedAnchorDay >= 1 && requestedAnchorDay <= 31
    ? requestedAnchorDay
    : start.getUTCDate();
  const day = Math.min(billingDay, lastDay);
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
    start.getUTCMilliseconds(),
  ));
};

const makeOrderNo = (prefix = "SO") =>
  `${prefix}${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

const makeRefundNo = () =>
  `RF${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

const REFUND_RECONCILIATION_LIMIT = 50;
const REFUND_RECONCILIATION_LEASE_MS = 10 * 60 * 1000;
const REFUND_RECONCILIATION_BASE_DELAY_SECONDS = 30;
const REFUND_RECONCILIATION_MAX_DELAY_SECONDS = 6 * 60 * 60;
const PAYMENT_RECONCILIATION_LIMIT = 50;
const PAYMENT_RECONCILIATION_LEASE_MS = 5 * 60 * 1000;
const PAYMENT_RECONCILIATION_MIN_AGE_MS = 2 * 60 * 1000;
const PAYMENT_RECONCILIATION_CLOSE_AFTER_MS = 35 * 60 * 1000;
const PAYMENT_RECONCILIATION_BASE_DELAY_SECONDS = 30;
const PAYMENT_RECONCILIATION_MAX_DELAY_SECONDS = 15 * 60;

const refundRequestFingerprint = ({ orderNo, reason }) => crypto
  .createHash("sha256")
  .update(JSON.stringify({
    orderNo: String(orderNo || ""),
    reason: String(reason || ""),
  }))
  .digest("hex");

const reconciliationLimit = (value) => {
  const requested = Number(value);
  if (!Number.isSafeInteger(requested) || requested <= 0) return REFUND_RECONCILIATION_LIMIT;
  return Math.min(requested, REFUND_RECONCILIATION_LIMIT);
};

const reconciliationDelaySeconds = (attempts) => Math.min(
  REFUND_RECONCILIATION_MAX_DELAY_SECONDS,
  REFUND_RECONCILIATION_BASE_DELAY_SECONDS * (2 ** Math.max(0, Number(attempts || 0) - 1)),
);

const normalizeProviderRefundState = (result) => {
  const state = String(result?.state || result?.status || "").trim().toLowerCase();
  if (["success", "succeeded", "completed"].includes(state)) return "success";
  if (["failed", "failure", "rejected"].includes(state)) return "failed";
  return "uncertain";
};

const safeProviderRefundSnapshot = (result, state) => ({
  state,
  providerCode: result?.providerCode ? String(result.providerCode).slice(0, 32) : null,
  providerSubCode: result?.providerSubCode ? String(result.providerSubCode).slice(0, 128) : null,
  providerRefundId: result?.providerRefundId
    ? String(result.providerRefundId).slice(0, 255)
    : null,
});

const safeRefundError = (error) => String(error?.message || error || "refund reconciliation failed").slice(0, 500);

const normalizeProviderPaymentState = (result) => {
  const state = String(result?.state || result?.tradeStatus || "").trim().toLowerCase();
  if (["success", "succeeded", "trade_success", "trade_finished"].includes(state)) return "success";
  if (["pending", "wait_buyer_pay"].includes(state)) return "pending";
  if (["closed", "trade_closed"].includes(state)) return "closed";
  if (state === "not_found") return "not_found";
  return "uncertain";
};

const paymentReconciliationDelaySeconds = (attempts) => Math.min(
  PAYMENT_RECONCILIATION_MAX_DELAY_SECONDS,
  PAYMENT_RECONCILIATION_BASE_DELAY_SECONDS * (2 ** Math.max(0, Number(attempts || 0) - 1)),
);

const safePaymentError = (error) => String(
  error?.code || error?.message || error || "payment reconciliation failed",
).replace(/\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]").slice(0, 500);

const planSnapshot = (plan) => ({
  plan_id: plan.id,
  plan_key: plan.plan_key,
  plan_name: plan.plan_name,
  membership_tier: plan.membership_tier,
  billing_interval: plan.billing_interval,
  price_cents: Number(plan.price_cents),
  included_points: Number(plan.included_points || 0),
  bonus_points: Number(plan.bonus_points || 0),
  monthly_bonus_points: Number(plan.monthly_bonus_points || 0),
});

const isHigherPlan = (plan, current) => {
  const planRank = TIER_RANK[plan.membership_tier] ?? 0;
  const currentRank = TIER_RANK[current.membership_tier] ?? 0;
  return planRank > currentRank
    || (planRank === currentRank && Number(plan.price_cents) > Number(current.price_cents));
};

const scheduledPlanSnapshot = (subscription) => {
  if (!subscription?.scheduled_plan_key) return null;
  return {
    plan_id: subscription.scheduled_plan_id,
    plan_key: subscription.scheduled_plan_key,
    plan_name: subscription.scheduled_plan_name,
    membership_tier: subscription.scheduled_membership_tier,
    billing_interval: subscription.scheduled_billing_interval,
    price_cents: Number(subscription.scheduled_price_cents || 0),
    included_points: Number(subscription.scheduled_included_points || 0),
    bonus_points: Number(subscription.scheduled_bonus_points || 0),
    monthly_bonus_points: Number(subscription.scheduled_monthly_bonus_points || 0),
  };
};

const safeProviderPaymentSnapshot = (payload) => {
  const source = payload && typeof payload === "object" ? payload : {};
  const allowed = [
    "code", "sub_code", "subCode", "msg", "trade_no", "tradeNo", "out_trade_no", "outTradeNo",
    "total_amount", "totalAmount", "trade_status", "tradeStatus", "refund_fee", "refundFee",
    "state", "providerCode", "providerSubCode", "providerTransactionId", "appId", "sellerId",
  ];
  return Object.fromEntries(allowed
    .filter((key) => source[key] !== undefined && source[key] !== null)
    .map((key) => [key, String(source[key]).slice(0, 255)]));
};

export const listActivePlans = async () => sql`
  SELECT id, plan_key, plan_name, membership_tier, billing_interval,
         price_cents, included_points, bonus_points, monthly_bonus_points,
         display_order, metadata
  FROM subscription_plans
  WHERE is_active = TRUE
  ORDER BY display_order ASC, price_cents ASC, id ASC
`;

export const getCurrentSubscription = async (userId) => {
  const [subscription] = await sql`
    SELECT *
    FROM subscriptions
    WHERE user_id = ${userId}
      AND status IN ('pending', 'active', 'past_due')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'past_due' THEN 1 ELSE 2 END,
             current_period_end DESC NULLS LAST, id DESC
    LIMIT 1
  `;
  return subscription || null;
};

export const getSubscriptionOverview = async (userId) => ({
  subscription: await getCurrentSubscription(userId),
  account: await getAccountInfo(userId),
});

const saveContactEmail = async (userId, email) => {
  if (!email) return;
  await sql`
    INSERT INTO user_profiles (user_id, email, email_updated_at)
    VALUES (${userId}, ${email}, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET email = EXCLUDED.email, email_updated_at = NOW(), updated_at = NOW()
  `;
};

export const createSubscriptionOrder = async ({
  userId,
  planKey,
  clientRequestId,
  contactEmail,
  returnUrl,
}) => {
  const email = normalizeEmail(contactEmail);
  if (!clientRequestId) {
    throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400 });
  }

  const result = await sql.begin(async (tx) => {
    const [existingOrder] = await tx`
      SELECT * FROM subscription_orders
      WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      LIMIT 1
    `;
    if (existingOrder) return { order: existingOrder, existing: true };

    const [plan] = await tx`
      SELECT * FROM subscription_plans
      WHERE plan_key = ${planKey} AND is_active = TRUE
      FOR SHARE
    `;
    if (!plan) {
      throw Object.assign(new Error("Subscription plan is unavailable"), { status: 400, code: "PLAN_UNAVAILABLE" });
    }

    const [current] = await tx`
      SELECT * FROM subscriptions
      WHERE user_id = ${userId} AND status IN ('pending', 'active', 'past_due')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id DESC
      LIMIT 1
      FOR UPDATE
    `;
    const snapshot = planSnapshot(plan);
    const periodStart = new Date();
    const billingAnchorDay = periodStart.getUTCDate();
    const periodEnd = addBillingPeriod(periodStart, snapshot.billing_interval, billingAnchorDay);
    if (current?.status === "pending") {
      if (current.plan_key === snapshot.plan_key && current.billing_interval === snapshot.billing_interval) {
        const [pendingOrder] = await tx`
          SELECT * FROM subscription_orders
          WHERE subscription_id = ${current.id} AND user_id = ${userId} AND status = 'pending'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `;
        if (pendingOrder) {
          return { order: pendingOrder, subscription: current, existing: true, paymentRetry: true };
        }
      }
      throw Object.assign(new Error("A subscription payment is already pending"), {
        status: 409,
        code: "SUBSCRIPTION_PAYMENT_PENDING",
        subscription_id: current.id,
      });
    }
    if (current && current.plan_key === snapshot.plan_key && current.billing_interval === snapshot.billing_interval) {
      throw Object.assign(new Error("This subscription plan is already active"), {
        status: 409,
        code: "SUBSCRIPTION_ALREADY_ACTIVE",
        subscription_id: current.id,
      });
    }

    // A lower tier (or a cheaper interval at the same tier) is scheduled for
    // the end of the paid period. The current membership and its benefits do
    // not change early, and no second payment is created today.
    if (current && !isHigherPlan(plan, current)) {
      if (current.status !== "active" || !current.current_period_end || new Date(current.current_period_end) <= new Date()) {
        throw Object.assign(new Error("The current subscription is not eligible for a plan change"), {
          status: 409,
          code: "SUBSCRIPTION_NOT_CHANGEABLE",
        });
      }

      const [scheduled] = await tx`
        UPDATE subscriptions
        SET scheduled_plan_id = ${snapshot.plan_id},
            scheduled_plan_key = ${snapshot.plan_key},
            scheduled_plan_name = ${snapshot.plan_name},
            scheduled_membership_tier = ${snapshot.membership_tier},
            scheduled_billing_interval = ${snapshot.billing_interval},
            scheduled_price_cents = ${snapshot.price_cents},
            scheduled_included_points = ${snapshot.included_points},
            scheduled_bonus_points = ${snapshot.bonus_points},
            scheduled_monthly_bonus_points = ${snapshot.monthly_bonus_points},
            scheduled_at = NOW(),
            contact_email = COALESCE(${email}, contact_email),
            updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *
      `;
      return { subscription: scheduled, scheduled: true, existing: false, order: null };
    }

    const orderNo = makeOrderNo(current ? "UP" : "SO");
    const orderType = current ? "upgrade" : "initial";
    let subscription;
    if (current) {
      [subscription] = await tx`
        UPDATE subscriptions
        SET contact_email = COALESCE(${email}, contact_email), updated_at = NOW()
        WHERE id = ${current.id}
        RETURNING *
      `;
    } else {
      const subscriptionId = crypto.randomUUID();
      [subscription] = await tx`
        INSERT INTO subscriptions
          (user_id, plan_id, plan_key, plan_name, membership_tier, billing_interval,
           price_cents, included_points, bonus_points, monthly_bonus_points,
           status, provider, contact_email, current_period_start, current_period_end,
           next_renewal_at, billing_anchor_day, metadata)
        VALUES
          (${userId}, ${snapshot.plan_id}, ${snapshot.plan_key}, ${snapshot.plan_name},
           ${snapshot.membership_tier}, ${snapshot.billing_interval}, ${snapshot.price_cents},
           ${snapshot.included_points}, ${snapshot.bonus_points}, ${snapshot.monthly_bonus_points},
           'pending', 'alipay', ${email}, ${periodStart.toISOString()}, ${periodEnd.toISOString()},
           ${periodEnd.toISOString()}, ${billingAnchorDay}, ${JSON.stringify({ external_subscription_id: subscriptionId })}::jsonb)
        RETURNING *
      `;
    }

    const [order] = await tx`
      INSERT INTO subscription_orders
        (user_id, subscription_id, plan_id, order_no, order_type, plan_key, plan_name,
         membership_tier, billing_interval, amount_cents, included_points, bonus_points,
         monthly_bonus_points, period_start, period_end, status, payment_method,
         client_request_id)
      VALUES
        (${userId}, ${subscription.id}, ${snapshot.plan_id}, ${orderNo}, ${orderType},
         ${snapshot.plan_key}, ${snapshot.plan_name}, ${snapshot.membership_tier},
         ${snapshot.billing_interval}, ${snapshot.price_cents}, ${snapshot.included_points},
         ${snapshot.bonus_points}, ${snapshot.monthly_bonus_points},
         ${periodStart.toISOString()}, ${periodEnd.toISOString()}, 'pending', 'alipay',
         ${clientRequestId})
      RETURNING *
    `;

    if (email) {
      await tx`
        INSERT INTO user_profiles (user_id, email, email_updated_at)
        VALUES (${userId}, ${email}, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET email = EXCLUDED.email, email_updated_at = NOW(), updated_at = NOW()
      `;
    }

    return { order, subscription, existing: false, scheduled: false };
  });

  let paymentUrl = null;
  let paymentConfigStatus = "ready";
  if (result.order?.status === "pending") {
    if (paymentGateway.isConfigured()) {
      try {
        paymentUrl = await paymentGateway.createPagePayment({
          orderNo: result.order.order_no,
          subject: result.order.plan_name,
          amountCents: result.order.amount_cents,
          returnUrl,
        });
      } catch (error) {
        paymentConfigStatus = error.code || "ALIPAY_PAYMENT_UNAVAILABLE";
        logger.warn("subscription.payment_url.failed", { orderNo: result.order.order_no, code: paymentConfigStatus });
      }
    } else {
      paymentConfigStatus = "ALIPAY_NOT_CONFIGURED";
    }
  }

  return { ...result, payment_url: paymentUrl, payment_config_status: paymentConfigStatus };
};

const grantInitialPointsTx = async (tx, order) => {
  const grant = async (amount, category, note) => {
    if (Number(amount || 0) <= 0) return null;
    return rechargePoints({
      userId: order.user_id,
      amount: Number(amount),
      sourceType: "subscription_order",
      sourceId: String(order.id),
      orderId: order.id,
      idempotencyKey: `subscription:points:${order.order_no}:${category}`,
      note,
      entryType: category === "package_bonus" ? "recharge" : "recharge",
      lotCategory: category,
      tx,
    });
  };

  await grant(order.included_points, "purchased", `订阅套餐积分：${order.plan_name}`);
  await grant(order.bonus_points, "package_bonus", `订阅套餐赠送积分：${order.plan_name}`);
};

export const activateSubscriptionOrder = async ({ orderNo, paymentTxnId, providerPayload = {} }) => {
  const result = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`stardraw:payment:${paymentTxnId || orderNo}`}, 0))`;
    const [order] = await tx`
      SELECT * FROM subscription_orders
      WHERE order_no = ${orderNo}
      FOR UPDATE
    `;
    if (!order) return { notFound: true };
    if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
      if (paymentTxnId && order.payment_txn_id && String(paymentTxnId) !== String(order.payment_txn_id)) {
        throw Object.assign(new Error("Payment transaction does not match the paid order"), {
          status: 409,
          code: "PAYMENT_TXN_MISMATCH",
        });
      }
      return { alreadyPaid: true, order };
    }
    if (order.status !== "pending") return { badStatus: order.status };

    if (paymentTxnId) {
      const [paymentConflict] = await tx`
        SELECT order_no FROM point_orders WHERE payment_txn_id = ${paymentTxnId} LIMIT 1
      `;
      if (paymentConflict) {
        throw Object.assign(new Error("Alipay trade number was already used"), {
          status: 409,
          code: "PAYMENT_TRADE_REPLAY",
        });
      }
    }

    const [subscription] = await tx`
      SELECT * FROM subscriptions WHERE id = ${order.subscription_id} FOR UPDATE
    `;
    if (!subscription) throw new Error("Subscription record is missing");

    await grantInitialPointsTx(tx, order);
    await ensureAccountTx(tx, order.user_id);

    const periodStart = order.period_start || new Date();
    const periodStartDate = new Date(periodStart);
    const billingAnchorDay = order.order_type === "renewal"
      ? Number(subscription.billing_anchor_day || periodStartDate.getUTCDate())
      : periodStartDate.getUTCDate();
    const periodEnd = order.period_end || addBillingPeriod(periodStart, order.billing_interval, billingAnchorDay);
    // A successful one-time payment does not grant periodic-debit authority.
    // Auto-renew is enabled only after Alipay returns an agreement id.
    const [updatedSubscription] = await tx`
      UPDATE subscriptions
      SET plan_id = ${order.plan_id},
          plan_key = ${order.plan_key},
          plan_name = ${order.plan_name},
          membership_tier = ${order.membership_tier},
          billing_interval = ${order.billing_interval},
          price_cents = ${order.amount_cents},
          included_points = ${order.included_points},
          bonus_points = ${order.bonus_points},
          monthly_bonus_points = ${order.monthly_bonus_points},
          scheduled_plan_id = NULL,
          scheduled_plan_key = NULL,
          scheduled_plan_name = NULL,
          scheduled_membership_tier = NULL,
          scheduled_billing_interval = NULL,
          scheduled_price_cents = NULL,
          scheduled_included_points = NULL,
          scheduled_bonus_points = NULL,
          scheduled_monthly_bonus_points = NULL,
          scheduled_at = NULL,
          status = 'active',
          started_at = COALESCE(started_at, ${periodStart}),
          current_period_start = ${periodStart},
          current_period_end = ${periodEnd},
          next_renewal_at = ${periodEnd},
          billing_anchor_day = ${billingAnchorDay},
          auto_renew = (provider_agreement_id IS NOT NULL),
          updated_at = NOW()
      WHERE id = ${subscription.id}
      RETURNING *
    `;

    await tx`
      UPDATE user_point_accounts
      SET membership_tier = ${order.membership_tier},
          monthly_bonus_points = ${order.monthly_bonus_points},
          bonus_cycle_anchor = ${monthStart(periodStart)},
          next_bonus_at = ${monthStart(periodStart)},
          updated_at = NOW()
      WHERE user_id = ${order.user_id}
    `;

    const [updatedOrder] = await tx`
      UPDATE subscription_orders
      SET status = 'paid', paid_at = NOW(),
          payment_txn_id = COALESCE(${paymentTxnId || null}, payment_txn_id),
          provider_payload = ${JSON.stringify(safeProviderPaymentSnapshot(providerPayload))}::jsonb,
          payment_reconciliation_state = 'succeeded',
          next_payment_reconciliation_at = NULL,
          last_payment_reconciliation_error = NULL,
          payment_reconciliation_claimed_at = NULL,
          payment_reconciliation_lease_id = NULL,
          updated_at = NOW()
      WHERE id = ${order.id}
      RETURNING *
    `;

    return { order: updatedOrder, subscription: updatedSubscription };
  });

  if (result.order && !result.alreadyPaid) {
    try {
      await checkAndGrantBonus(result.order.user_id);
    } catch (error) {
      logger.error("subscription.initial_bonus.error", { userId: result.order.user_id, error: error.message });
    }
  }

  return result;
};

export const cancelSubscriptionRenewal = async (userId, db = sql) => {
  const [row] = await db`
    UPDATE subscriptions
    SET auto_renew = FALSE,
        cancel_at_period_end = TRUE,
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE user_id = ${userId}
      AND status = 'active'
      AND provider_agreement_id IS NOT NULL
      AND auto_renew = TRUE
    RETURNING *
  `;
  return row || null;
};

export const createSubscriptionPeriodicAgreement = async ({ userId, returnUrl }) => {
  const [subscription] = await sql`
    SELECT * FROM subscriptions
    WHERE user_id = ${userId} AND status = 'active'
    ORDER BY current_period_end DESC NULLS LAST, id DESC
    LIMIT 1
  `;
  if (!subscription) {
    throw Object.assign(new Error("Active subscription not found"), { status: 404, code: "SUBSCRIPTION_NOT_FOUND" });
  }
  if (subscription.provider_agreement_id) {
    return { subscription, alreadySigned: true, payment_url: null };
  }

  const externalAgreementNo = `AG${subscription.id}${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  const paymentUrl = await paymentGateway.createPeriodicAgreement({
    externalAgreementNo,
    userId,
    returnUrl,
  });
  const [updated] = await sql`
    UPDATE subscriptions
    SET metadata = metadata || ${JSON.stringify({ external_agreement_no: externalAgreementNo })}::jsonb,
        updated_at = NOW()
    WHERE id = ${subscription.id}
    RETURNING *
  `;
  return { subscription: updated, alreadySigned: false, payment_url: paymentUrl };
};

export const attachProviderAgreement = async ({ externalAgreementNo, agreementNo, providerCustomerId }) => {
  if (!externalAgreementNo || !agreementNo) return null;
  const [subscription] = await sql`
    UPDATE subscriptions
    SET provider_agreement_id = ${String(agreementNo).slice(0, 255)},
        provider_customer_id = ${providerCustomerId ? String(providerCustomerId).slice(0, 255) : null},
        auto_renew = TRUE,
        cancel_at_period_end = FALSE,
        metadata = metadata || ${JSON.stringify({ agreement_signed_at: new Date().toISOString() })}::jsonb,
        updated_at = NOW()
    WHERE metadata->>'external_agreement_no' = ${String(externalAgreementNo)}
      AND status = 'active'
    RETURNING *
  `;
  return subscription || null;
};

const expireSubscription = async (subscriptionId) => sql.begin(async (tx) => {
  const [subscription] = await tx`
    SELECT * FROM subscriptions WHERE id = ${subscriptionId} FOR UPDATE
  `;
  if (!subscription || !['active', 'past_due'].includes(subscription.status)) return subscription || null;
  if (subscription.current_period_end && new Date(subscription.current_period_end) > new Date()) return subscription;

  await tx`
    UPDATE subscriptions
    SET status = 'expired', auto_renew = FALSE, cancel_at_period_end = FALSE,
        updated_at = NOW()
    WHERE id = ${subscription.id}
  `;
  await tx`
    UPDATE user_point_accounts
    SET membership_tier = 'free', monthly_bonus_points = 0,
        bonus_cycle_anchor = NULL, last_bonus_granted_at = NULL,
        next_bonus_at = NULL, updated_at = NOW()
    WHERE user_id = ${subscription.user_id}
  `;
  return { ...subscription, status: 'expired' };
});

const createRenewalOrder = async (subscription) => sql.begin(async (tx) => {
  const [locked] = await tx`
    SELECT * FROM subscriptions WHERE id = ${subscription.id} FOR UPDATE
  `;
  if (!locked || !['active', 'past_due'].includes(locked.status) || !locked.current_period_end) return null;
  const periodStart = new Date(locked.current_period_end);
  if (periodStart > new Date()) return null;

  const snapshot = scheduledPlanSnapshot(locked) || {
    plan_id: locked.plan_id,
    plan_key: locked.plan_key,
    plan_name: locked.plan_name,
    membership_tier: locked.membership_tier,
    billing_interval: locked.billing_interval,
    price_cents: Number(locked.price_cents),
    included_points: Number(locked.included_points || 0),
    bonus_points: Number(locked.bonus_points || 0),
    monthly_bonus_points: Number(locked.monthly_bonus_points || 0),
  };
  const clientRequestId = `renewal:${locked.id}:${periodStart.toISOString()}`;
  const [existing] = await tx`
    SELECT * FROM subscription_orders
    WHERE user_id = ${locked.user_id} AND client_request_id = ${clientRequestId}
    LIMIT 1
  `;
  if (existing) return { order: existing, subscription: locked, snapshot };

  const periodEnd = addBillingPeriod(periodStart, snapshot.billing_interval, locked.billing_anchor_day);
  const [order] = await tx`
    INSERT INTO subscription_orders
      (user_id, subscription_id, plan_id, order_no, order_type, plan_key, plan_name,
       membership_tier, billing_interval, amount_cents, included_points, bonus_points,
       monthly_bonus_points, period_start, period_end, status, payment_method,
       client_request_id)
    VALUES
      (${locked.user_id}, ${locked.id}, ${snapshot.plan_id}, ${makeOrderNo('RN')}, 'renewal',
       ${snapshot.plan_key}, ${snapshot.plan_name}, ${snapshot.membership_tier},
       ${snapshot.billing_interval}, ${snapshot.price_cents}, ${snapshot.included_points},
       ${snapshot.bonus_points}, ${snapshot.monthly_bonus_points}, ${periodStart},
       ${periodEnd}, 'pending', 'alipay', ${clientRequestId})
    RETURNING *
  `;
  return { order, subscription: locked, snapshot };
});

export const validateAlipayPaymentNotification = async ({ orderNo, providerPayload = {} }) => {
  const readPayload = (...keys) => {
    for (const key of keys) {
      const value = providerPayload?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return "";
  };
  const [order] = await sql`
    SELECT * FROM subscription_orders WHERE order_no = ${String(orderNo || "")} LIMIT 1
  `;
  if (!order) throw Object.assign(new Error("Subscription order not found"), { status: 404, code: "ORDER_NOT_FOUND" });
  if (String(readPayload("out_trade_no", "outTradeNo")) !== String(order.order_no)) {
    throw Object.assign(new Error("Alipay order number mismatch"), { status: 400, code: "PAYMENT_ORDER_MISMATCH" });
  }

  const { appId, sellerId } = paymentGateway.getAccountConfig();
  if (appId && String(readPayload("app_id", "appId")) !== appId) {
    throw Object.assign(new Error("Alipay app_id mismatch"), { status: 400, code: "PAYMENT_APP_MISMATCH" });
  }
  if (sellerId && String(readPayload("seller_id", "sellerId")) !== sellerId) {
    throw Object.assign(new Error("Alipay seller_id mismatch"), { status: 400, code: "PAYMENT_SELLER_MISMATCH" });
  }

  const amountCents = Math.round(Number(readPayload("total_amount", "totalAmount")) * 100);
  if (!Number.isFinite(amountCents) || amountCents !== Number(order.amount_cents)) {
    throw Object.assign(new Error("Alipay payment amount mismatch"), {
      status: 400,
      code: "PAYMENT_AMOUNT_MISMATCH",
      expected_amount_cents: Number(order.amount_cents),
      received_amount_cents: amountCents,
    });
  }

  const paymentTxnId = String(readPayload("trade_no", "tradeNo")).trim();
  if (!paymentTxnId) throw Object.assign(new Error("Alipay trade number is missing"), { status: 400, code: "PAYMENT_TRADE_NO_MISSING" });
  if (order.payment_txn_id && String(order.payment_txn_id) !== paymentTxnId) {
    throw Object.assign(new Error("Alipay trade number does not match the pending order"), {
      status: 409,
      code: "PAYMENT_TXN_MISMATCH",
    });
  }
  const [conflict] = await sql`
    SELECT order_no FROM subscription_orders
    WHERE payment_txn_id = ${paymentTxnId} AND order_no <> ${order.order_no}
    UNION ALL
    SELECT order_no FROM point_orders
    WHERE payment_txn_id = ${paymentTxnId}
    LIMIT 1
  `;
  if (conflict) throw Object.assign(new Error("Alipay trade number was already used"), { status: 409, code: "PAYMENT_TRADE_REPLAY" });
  return { order, paymentTxnId };
};

export const processSubscriptionRenewals = async () => {
  const periodicEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.ALIPAY_PERIODIC_ENABLED || "false").trim().toLowerCase(),
  );
  const due = await sql`
    SELECT * FROM subscriptions
    WHERE status IN ('active', 'past_due') AND current_period_end IS NOT NULL AND current_period_end <= NOW()
    ORDER BY current_period_end ASC, id ASC
    LIMIT 100
  `;
  let renewed = 0;
  let submitted = 0;
  let expired = 0;
  for (const subscription of due) {
    try {
      // When periodic billing is disabled, no subscription may remain in a
      // state that implies a future automatic charge. Expire it normally so
      // the user falls back to free access and can renew manually.
      if (!periodicEnabled) {
        await expireSubscription(subscription.id);
        expired++;
        continue;
      }
      if (!subscription.auto_renew || subscription.cancel_at_period_end || !subscription.provider_agreement_id) {
        await expireSubscription(subscription.id);
        expired++;
        continue;
      }
      const prepared = await createRenewalOrder(subscription);
      if (!prepared?.order) continue;
      if (prepared.order.status === 'paid') {
        renewed++;
        continue;
      }
      const response = await paymentGateway.createPeriodicPayment({
        orderNo: prepared.order.order_no,
        subject: prepared.order.plan_name,
        amountCents: prepared.order.amount_cents,
        agreementNo: subscription.provider_agreement_id,
      });
      const providerCode = String(response?.code || "");
      await sql`
        UPDATE subscription_orders
        SET provider_response = ${JSON.stringify(safeProviderPaymentSnapshot(response))}::jsonb, updated_at = NOW()
        WHERE id = ${prepared.order.id}
      `;
      const tradeNo = response?.trade_no || response?.tradeNo;
      if (['10000', '10003'].includes(providerCode)) {
        // The synchronous SDK response only confirms that Alipay accepted the
        // debit request. Membership extension and points issuance remain
        // exclusively driven by the signed asynchronous notification.
        await sql`
          UPDATE subscriptions
          SET status = 'past_due', updated_at = NOW()
          WHERE id = ${subscription.id} AND status IN ('active', 'past_due')
        `;
        if (tradeNo) {
          await sql`
            UPDATE subscription_orders
            SET payment_txn_id = COALESCE(payment_txn_id, ${tradeNo}), updated_at = NOW()
            WHERE id = ${prepared.order.id} AND status = 'pending'
          `;
        }
        submitted++;
      } else {
        await sql`UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE id = ${subscription.id}`;
      }
    } catch (error) {
      logger.error("subscription.renewal.error", { subscriptionId: subscription.id, error: error.message });
      await sql`UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE id = ${subscription.id} AND status = 'active'`;
    }
  }
  return { scanned: due.length, renewed, submitted, expired };
};

const refundableLotSummary = async (tx, orderId) => {
  const lots = await tx`
    SELECT id, available_points, held_points, consumed_points, expired_points, refunded_points
    FROM point_lots
    WHERE order_id = ${orderId}
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  `;
  const available = lots.reduce((sum, lot) => sum + Number(lot.available_points || 0), 0);
  const held = lots.reduce((sum, lot) => sum + Number(lot.held_points || 0), 0);
  return { lots, available, held };
};

// Refunds are deliberately service/admin-only.  There is no user-facing
// refund button.  Frozen points are not refundable until their generation
// task settles, which prevents a refund from racing an in-flight charge.
const getRefundForUpdate = async (tx, refundId, leaseId = null) => {
  if (leaseId) {
    const [refund] = await tx`
      SELECT * FROM subscription_refunds
      WHERE id = ${refundId} AND reconciliation_lease_id = ${leaseId}
      FOR UPDATE
    `;
    return refund || null;
  }
  const [refund] = await tx`
    SELECT * FROM subscription_refunds WHERE id = ${refundId} FOR UPDATE
  `;
  return refund || null;
};

const completeRefundTx = async ({ tx, refundId, providerResult, actor = null, req = null, reason = null, leaseId = null }) => {
  const refund = await getRefundForUpdate(tx, refundId, leaseId);
  if (!refund || refund.status !== "pending") return refund;

  const [order] = await tx`
    SELECT * FROM subscription_orders WHERE id = ${refund.order_id} FOR UPDATE
  `;
  if (!order) throw new Error("Subscription order is missing for refund");

  const pointsToRemove = Number(refund.requested_points || 0);
  await refundReservedPoints({
    userId: order.user_id,
    amount: pointsToRemove,
    sourceType: "subscription_refund",
    sourceId: String(refund.id),
    idempotencyKey: `refund:subscription:${refund.id}`,
    note: "订阅退款扣回未消费积分",
    tx,
  });

  await tx`
    UPDATE user_point_accounts
    SET membership_tier = 'free',
        monthly_bonus_points = 0, bonus_cycle_anchor = NULL,
        last_bonus_granted_at = NULL, next_bonus_at = NULL,
        version = version + 1, updated_at = NOW()
    WHERE user_id = ${order.user_id}
  `;
  await tx`
    UPDATE subscriptions
    SET status = 'cancelled', auto_renew = FALSE, cancel_at_period_end = FALSE,
        cancelled_at = NOW(), updated_at = NOW()
    WHERE id = ${order.subscription_id}
  `;

  const [previouslyRefunded] = await tx`
    SELECT COALESCE(SUM(refunded_points), 0)::integer AS points
    FROM subscription_refunds
    WHERE order_id = ${order.id} AND status = 'completed'
  `;
  const totalPoints = Number(order.included_points || 0) + Number(order.bonus_points || 0);
  const fullyRefunded = Number(previouslyRefunded?.points || 0) + pointsToRemove >= totalPoints;
  await tx`
    UPDATE subscription_orders
    SET status = ${fullyRefunded ? "refunded" : "partially_refunded"},
        refunded_at = NOW(), updated_at = NOW()
    WHERE id = ${order.id}
  `;

  const providerSnapshot = safeProviderRefundSnapshot(providerResult, "success");
  const [updatedRefund] = await tx`
    UPDATE subscription_refunds
    SET status = 'completed', reconciliation_state = 'success',
        refunded_points = ${pointsToRemove},
        provider_refund_id = COALESCE(${providerSnapshot.providerRefundId}, provider_refund_id),
        metadata = metadata || ${JSON.stringify({ provider: providerSnapshot })}::jsonb,
        last_reconciliation_error = NULL, next_reconciliation_at = NULL,
        reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL,
        completed_at = NOW()
    WHERE id = ${refund.id}
    RETURNING *
  `;
  if (actor?.userId && ["root", "admin"].includes(actor.role)) {
    await writeAuditLog({
      req,
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: "subscription.refunded",
      targetType: "subscription_order",
      targetId: order.order_no,
      reason,
      before: { order_status: order.status, refund_status: refund.status },
      after: {
        order_status: fullyRefunded ? "refunded" : "partially_refunded",
        refund_status: updatedRefund.status,
        refunded_points: updatedRefund.refunded_points,
        amount_cents: updatedRefund.amount_cents,
      },
      tx,
    });
  }
  return updatedRefund;
};

const failRefundTx = async ({ tx, refundId, error, leaseId = null }) => {
  const refund = await getRefundForUpdate(tx, refundId, leaseId);
  if (!refund || refund.status !== "pending") return refund;
  const [order] = await tx`
    SELECT user_id FROM subscription_orders WHERE id = ${refund.order_id} FOR UPDATE
  `;
  if (!order) throw new Error("Subscription order is missing for refund failure");
  await releasePoints({
    userId: order.user_id,
    amount: Number(refund.requested_points || 0),
    sourceType: "subscription_refund",
    sourceId: String(refund.id),
    idempotencyKey: `release:subscription-refund:${refund.id}`,
    note: "返还：支付渠道退款失败",
    tx,
  });
  const safeError = safeRefundError(error);
  const [updatedRefund] = await tx`
    UPDATE subscription_refunds
    SET status = 'failed', reconciliation_state = 'failed',
        last_reconciliation_error = ${safeError},
        metadata = metadata || ${JSON.stringify({ provider_status: "failed" })}::jsonb,
        next_reconciliation_at = NULL, reconciliation_claimed_at = NULL,
        reconciliation_lease_id = NULL, completed_at = NOW()
    WHERE id = ${refund.id} AND status = 'pending'
    RETURNING *
  `;
  return updatedRefund || refund;
};

const markRefundUncertain = async ({ refundId, error, leaseId = null, attempts = 0 }) => {
  const delaySeconds = reconciliationDelaySeconds(attempts);
  const safeError = safeRefundError(error);
  const [updatedRefund] = leaseId
    ? await sql`
      UPDATE subscription_refunds
      SET reconciliation_state = 'uncertain',
          last_reconciliation_error = ${safeError},
          metadata = metadata || ${JSON.stringify({ provider_status: "uncertain" })}::jsonb,
          next_reconciliation_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
          reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL
      WHERE id = ${refundId} AND status = 'pending' AND reconciliation_lease_id = ${leaseId}
      RETURNING *
    `
    : await sql`
      UPDATE subscription_refunds
      SET reconciliation_state = 'uncertain',
          last_reconciliation_error = ${safeError},
          metadata = metadata || ${JSON.stringify({ provider_status: "uncertain" })}::jsonb,
          next_reconciliation_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
          reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL
      WHERE id = ${refundId} AND status = 'pending'
      RETURNING *
    `;
  return updatedRefund || null;
};

export const refundSubscriptionOrder = async ({ orderNo, idempotencyKey, reason, actor = null, req = null }) => {
  if (!idempotencyKey) {
    throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400 });
  }

  const requestFingerprint = refundRequestFingerprint({ orderNo, reason });
  const prepared = await sql.begin(async (tx) => {
    const [existingRefund] = await tx`
      SELECT refunds.*, orders.order_no AS refund_order_no
      FROM subscription_refunds refunds
      JOIN subscription_orders orders ON orders.id = refunds.order_id
      WHERE refunds.idempotency_key = ${idempotencyKey}
      FOR UPDATE
    `;
    if (existingRefund) {
      const existingFingerprint = existingRefund.request_fingerprint
        || refundRequestFingerprint({ orderNo: existingRefund.refund_order_no, reason: existingRefund.reason });
      if (existingFingerprint !== requestFingerprint) {
        throw Object.assign(new Error("Idempotency key is already used for another refund request"), {
          status: 409,
          code: "REFUND_IDEMPOTENCY_KEY_CONFLICT",
        });
      }
      return { existingRefund };
    }

    const [order] = await tx`
      SELECT * FROM subscription_orders WHERE order_no = ${orderNo} FOR UPDATE
    `;
    if (!order) throw Object.assign(new Error("Subscription order not found"), { status: 404 });
    if (order.status !== "paid" && order.status !== "partially_refunded") {
      throw Object.assign(new Error("Only paid subscription orders can be refunded"), { status: 400 });
    }

    const summary = await refundableLotSummary(tx, order.id);
    if (summary.held > 0) {
      throw Object.assign(new Error("Refund is unavailable while points are held by running tasks"), {
        status: 409,
        code: "POINTS_HELD",
        held_points: summary.held,
      });
    }

    const totalPoints = Number(order.included_points || 0) + Number(order.bonus_points || 0);
    if (summary.available <= 0 || totalPoints <= 0) {
      throw Object.assign(new Error("No unconsumed points are refundable"), { status: 409, code: "NO_REFUNDABLE_POINTS" });
    }

    const refundPoints = Math.min(summary.available, totalPoints);
    const refundAmountCents = Math.floor((Number(order.amount_cents) * refundPoints) / totalPoints);
    if (refundAmountCents <= 0) {
      throw Object.assign(new Error("Refund amount is below the payment provider minimum"), { status: 409, code: "REFUND_TOO_SMALL" });
    }

    const [refund] = await tx`
      INSERT INTO subscription_refunds
        (order_id, user_id, refund_no, requested_points, refunded_points,
         amount_cents, status, reason, idempotency_key, request_fingerprint,
         reconciliation_state, next_reconciliation_at)
      VALUES
        (${order.id}, ${order.user_id}, ${makeRefundNo()}, ${refundPoints}, 0,
         ${refundAmountCents}, 'pending', ${reason || null}, ${idempotencyKey},
         ${requestFingerprint}, 'pending', NOW())
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `;
    if (!refund) {
      const [concurrentRefund] = await tx`
        SELECT refunds.*, orders.order_no AS refund_order_no
        FROM subscription_refunds refunds
        JOIN subscription_orders orders ON orders.id = refunds.order_id
        WHERE refunds.idempotency_key = ${idempotencyKey}
        FOR UPDATE
      `;
      const concurrentFingerprint = concurrentRefund?.request_fingerprint
        || refundRequestFingerprint({ orderNo: concurrentRefund?.refund_order_no, reason: concurrentRefund?.reason });
      if (concurrentFingerprint !== requestFingerprint) {
        throw Object.assign(new Error("Idempotency key is already used for another refund request"), {
          status: 409,
          code: "REFUND_IDEMPOTENCY_KEY_CONFLICT",
        });
      }
      return { existingRefund: concurrentRefund };
    }
    await reservePoints({
      userId: order.user_id,
      amount: refundPoints,
      sourceType: "subscription_refund",
      sourceId: String(refund.id),
      lotOrderId: order.id,
      idempotencyKey: `reserve:subscription-refund:${refund.id}`,
      note: "预占：订阅退款待处理积分",
      tx,
    });
    return { order, refund, summary, refundPoints, refundAmountCents };
  });

  if (prepared.existingRefund) return prepared.existingRefund;

  let providerResult;
  try {
    providerResult = await paymentGateway.refundPayment({
      transactionId: prepared.order.payment_txn_id,
      outTradeNo: prepared.order.order_no,
      refundRequestNo: prepared.refund.refund_no,
      refundAmountCents: prepared.refundAmountCents,
      reason,
    });
  } catch (error) {
    const definitelyRejected = error.providerOutcome === "failed"
      || ["ALIPAY_NOT_CONFIGURED", "ALIPAY_CALLBACK_NOT_CONFIGURED"].includes(error.code);
    if (!definitelyRejected) {
      await markRefundUncertain({ refundId: prepared.refund.id, error }).catch((persistenceError) => {
        logger.error("subscription.refund.uncertain.persist.error", {
          refundId: prepared.refund.id,
          error: safeRefundError(persistenceError),
        });
      });
      throw Object.assign(new Error("Refund provider status is uncertain; points remain held for reconciliation"), {
        status: 503,
        code: "REFUND_PROVIDER_STATUS_UNCERTAIN",
        providerCode: error.providerCode || null,
        providerSubCode: error.providerSubCode || null,
      });
    }

    await sql.begin(async (tx) => failRefundTx({ tx, refundId: prepared.refund.id, error })).catch((releaseError) => {
      logger.error("subscription.refund.release.error", {
        refundId: prepared.refund.id,
        error: safeRefundError(releaseError),
      });
    });
    throw error;
  }

  const completed = await sql.begin(async (tx) => completeRefundTx({
    tx,
    refundId: prepared.refund.id,
    providerResult,
    actor,
    req,
    reason,
  }));

  return completed;
};

/**
 * Reconcile refunds whose provider result was not observable. The database
 * lease makes this safe for multiple workers and the provider query is read
 * only, so a retry cannot create a second refund.
 */
export const processPendingRefundReconciliations = async ({
  limit = process.env.SUBSCRIPTION_REFUND_RECONCILIATION_LIMIT || REFUND_RECONCILIATION_LIMIT,
} = {}) => {
  const batchLimit = reconciliationLimit(limit);
  const leaseId = crypto.randomUUID();
  const leaseSeconds = Math.ceil(REFUND_RECONCILIATION_LEASE_MS / 1000);
  const claimed = await sql.begin(async (tx) => tx`
    WITH candidates AS (
      SELECT id
      FROM subscription_refunds
      WHERE status = 'pending'
        AND reconciliation_state IN ('pending', 'uncertain')
        AND (next_reconciliation_at IS NULL OR next_reconciliation_at <= NOW())
        AND (reconciliation_claimed_at IS NULL
          OR reconciliation_claimed_at <= NOW() - (${leaseSeconds} * INTERVAL '1 second'))
      ORDER BY COALESCE(next_reconciliation_at, created_at) ASC, id ASC
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE subscription_refunds refunds
    SET reconciliation_claimed_at = NOW(),
        reconciliation_lease_id = ${leaseId},
        reconciliation_attempts = reconciliation_attempts + 1,
        last_reconciliation_at = NOW()
    FROM candidates
    WHERE refunds.id = candidates.id
    RETURNING refunds.*,
      (SELECT payment_txn_id FROM subscription_orders WHERE id = refunds.order_id) AS payment_txn_id,
      (SELECT order_no FROM subscription_orders WHERE id = refunds.order_id) AS order_no
  `);

  let success = 0;
  let failed = 0;
  let stillUncertain = 0;
  for (const refund of claimed) {
    let result;
    try {
      result = await paymentGateway.queryRefund({
        transactionId: refund.payment_txn_id || null,
        outTradeNo: refund.order_no,
        refundRequestNo: refund.refund_no,
      });
    } catch (error) {
      result = { state: error.providerOutcome === "failed" ? "failed" : "uncertain", error };
    }

    const state = normalizeProviderRefundState(result);
    try {
      if (state === "success") {
        const updated = await sql.begin(async (tx) => completeRefundTx({
          tx,
          refundId: refund.id,
          providerResult: result,
          reason: refund.reason,
          leaseId,
        }));
        if (updated?.status === "completed") success++;
      } else if (state === "failed") {
        const updated = await sql.begin(async (tx) => failRefundTx({
          tx,
          refundId: refund.id,
          error: result.error || new Error("Payment provider confirmed refund failure"),
          leaseId,
        }));
        if (updated?.status === "failed") failed++;
      } else {
        await markRefundUncertain({
          refundId: refund.id,
          error: result.error || new Error("Payment provider refund status is still uncertain"),
          leaseId,
          attempts: refund.reconciliation_attempts,
        });
        stillUncertain++;
      }
    } catch (error) {
      logger.error("subscription.refund.reconciliation.persistence_error", {
        refundId: refund.id,
        error: safeRefundError(error),
      });
      // A persistence error must not release points. The lease will expire
      // and the row will be retried by a later scan.
      stillUncertain++;
    }
  }

  logger.info("subscription.refund.reconciliation.completed", {
    scanned: claimed.length,
    success,
    failed,
    stillUncertain,
  });
  return { scanned: claimed.length, success, failed, stillUncertain };
};

const paymentProviderPayload = (result) => ({
  app_id: result?.appId,
  seller_id: result?.sellerId,
  out_trade_no: result?.outTradeNo,
  trade_no: result?.providerTransactionId,
  total_amount: result?.totalAmount,
  trade_status: result?.tradeStatus,
});

const markPaymentReconciliationRetry = async ({ order, leaseId, state, result, error }) => {
  const delaySeconds = paymentReconciliationDelaySeconds(order.payment_reconciliation_attempts);
  const safeState = state === "pending" ? "pending" : "uncertain";
  const [updated] = await sql`
    UPDATE subscription_orders
    SET payment_reconciliation_state = ${safeState},
        next_payment_reconciliation_at = NOW() + (${delaySeconds} * INTERVAL '1 second'),
        last_payment_reconciliation_error = ${error ? safePaymentError(error) : null},
        provider_response = provider_response || ${JSON.stringify(safeProviderPaymentSnapshot(result))}::jsonb,
        payment_reconciliation_claimed_at = NULL,
        payment_reconciliation_lease_id = NULL,
        updated_at = NOW()
    WHERE id = ${order.id}
      AND status = 'pending'
      AND payment_reconciliation_lease_id = ${leaseId}
    RETURNING *
  `;
  return updated || null;
};

const markPaymentReconciliationFailed = async ({ order, leaseId, result, error }) => {
  const [updated] = await sql`
    UPDATE subscription_orders
    SET payment_reconciliation_state = 'failed',
        next_payment_reconciliation_at = NULL,
        last_payment_reconciliation_error = ${safePaymentError(error)},
        provider_response = provider_response || ${JSON.stringify(safeProviderPaymentSnapshot(result))}::jsonb,
        payment_reconciliation_claimed_at = NULL,
        payment_reconciliation_lease_id = NULL,
        updated_at = NOW()
    WHERE id = ${order.id}
      AND status = 'pending'
      AND payment_reconciliation_lease_id = ${leaseId}
    RETURNING *
  `;
  return updated || null;
};

const closePendingPaymentOrder = async ({ orderId, leaseId, providerResult }) => sql.begin(async (tx) => {
  const [order] = await tx`
    SELECT * FROM subscription_orders WHERE id = ${orderId} FOR UPDATE
  `;
  if (!order) return { notFound: true };
  if (order.status === "paid") return { alreadyPaid: true, order };
  if (order.status !== "pending") return { alreadyTerminal: true, order };
  if (String(order.payment_reconciliation_lease_id || "") !== String(leaseId)) {
    return { staleLease: true, order };
  }

  const [closedOrder] = await tx`
    UPDATE subscription_orders
    SET status = 'cancelled',
        payment_reconciliation_state = 'closed',
        payment_closed_at = NOW(),
        next_payment_reconciliation_at = NULL,
        last_payment_reconciliation_error = NULL,
        provider_response = provider_response || ${JSON.stringify(safeProviderPaymentSnapshot(providerResult))}::jsonb,
        payment_reconciliation_claimed_at = NULL,
        payment_reconciliation_lease_id = NULL,
        updated_at = NOW()
    WHERE id = ${order.id}
    RETURNING *
  `;

  if (order.order_type === "initial" && order.subscription_id) {
    await tx`
      UPDATE subscriptions
      SET status = 'cancelled', auto_renew = FALSE, updated_at = NOW()
      WHERE id = ${order.subscription_id}
        AND status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM subscription_orders other
          WHERE other.subscription_id = ${order.subscription_id}
            AND other.id <> ${order.id}
            AND other.status = 'pending'
        )
    `;
  }
  return { closed: true, order: closedOrder };
});

const sendPaymentReconciliationAlert = async ({ orderNo, error }) => {
  try {
    await sendOperationalAlert({
      subject: "StarDraw 支付订单需要人工检查",
      message: "支付宝主动查单结果未通过本地订单校验，系统未发放会员权益或积分。",
      details: { orderNo, errorCode: error?.code || "PAYMENT_RECONCILIATION_VALIDATION_FAILED" },
    });
  } catch (alertError) {
    logger.error("subscription.payment.reconciliation.alert_failed", {
      orderNo,
      error: safePaymentError(alertError),
    });
  }
};

export const processPendingPaymentReconciliations = async ({
  limit = PAYMENT_RECONCILIATION_LIMIT,
  minAgeMs = PAYMENT_RECONCILIATION_MIN_AGE_MS,
  closeAfterMs = PAYMENT_RECONCILIATION_CLOSE_AFTER_MS,
} = {}) => {
  const batchLimit = reconciliationLimit(limit);
  const normalizedMinAgeMs = Number.isFinite(Number(minAgeMs))
    ? Math.max(0, Number(minAgeMs))
    : PAYMENT_RECONCILIATION_MIN_AGE_MS;
  const normalizedCloseAfterMs = Number.isFinite(Number(closeAfterMs))
    ? Math.max(normalizedMinAgeMs, Number(closeAfterMs))
    : PAYMENT_RECONCILIATION_CLOSE_AFTER_MS;
  const minAgeSeconds = Math.ceil(normalizedMinAgeMs / 1000);
  const leaseSeconds = Math.ceil(PAYMENT_RECONCILIATION_LEASE_MS / 1000);
  const leaseId = crypto.randomUUID();
  const claimed = await sql.begin(async (tx) => tx`
    WITH candidates AS (
      SELECT id
      FROM subscription_orders
      WHERE status = 'pending'
        AND payment_reconciliation_state IN ('pending', 'uncertain')
        AND created_at <= NOW() - (${minAgeSeconds} * INTERVAL '1 second')
        AND (next_payment_reconciliation_at IS NULL OR next_payment_reconciliation_at <= NOW())
        AND (payment_reconciliation_claimed_at IS NULL
          OR payment_reconciliation_claimed_at <= NOW() - (${leaseSeconds} * INTERVAL '1 second'))
      ORDER BY COALESCE(next_payment_reconciliation_at, created_at) ASC, id ASC
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE subscription_orders orders
    SET payment_reconciliation_claimed_at = NOW(),
        payment_reconciliation_lease_id = ${leaseId},
        payment_reconciliation_attempts = payment_reconciliation_attempts + 1,
        last_payment_reconciliation_at = NOW()
    FROM candidates
    WHERE orders.id = candidates.id
    RETURNING orders.*
  `);

  let succeeded = 0;
  let closed = 0;
  let pending = 0;
  let uncertain = 0;
  let failed = 0;

  for (const order of claimed) {
    let result;
    try {
      result = await paymentGateway.queryPayment({ outTradeNo: order.order_no });
    } catch (error) {
      await markPaymentReconciliationRetry({ order, leaseId, state: "uncertain", result: {}, error });
      uncertain++;
      continue;
    }

    const state = normalizeProviderPaymentState(result);
    if (state === "success") {
      try {
        const providerPayload = paymentProviderPayload(result);
        const validated = await validateAlipayPaymentNotification({
          orderNo: order.order_no,
          providerPayload,
        });
        const activation = await activateSubscriptionOrder({
          orderNo: order.order_no,
          paymentTxnId: validated.paymentTxnId,
          providerPayload,
        });
        if (activation.notFound || activation.badStatus) {
          throw Object.assign(new Error("Payment order could not be activated"), {
            code: activation.notFound ? "ORDER_NOT_FOUND" : "PAYMENT_ORDER_BAD_STATUS",
          });
        }
        succeeded++;
      } catch (error) {
        await markPaymentReconciliationFailed({ order, leaseId, result, error });
        await sendPaymentReconciliationAlert({ orderNo: order.order_no, error });
        failed++;
      }
      continue;
    }

    if (state === "closed") {
      const closeResult = await closePendingPaymentOrder({ orderId: order.id, leaseId, providerResult: result });
      if (closeResult.closed || closeResult.alreadyTerminal) closed++;
      else if (closeResult.alreadyPaid) succeeded++;
      continue;
    }

    const orderAgeMs = Date.now() - new Date(order.created_at).getTime();
    if (["pending", "not_found"].includes(state) && orderAgeMs >= normalizedCloseAfterMs) {
      try {
        const closeResult = await paymentGateway.closePayment({ outTradeNo: order.order_no });
        const closeState = normalizeProviderPaymentState(closeResult);
        if (["closed", "not_found"].includes(closeState)) {
          const finalized = await closePendingPaymentOrder({
            orderId: order.id,
            leaseId,
            providerResult: closeResult,
          });
          if (finalized.closed || finalized.alreadyTerminal) closed++;
          else if (finalized.alreadyPaid) succeeded++;
          continue;
        }
        await markPaymentReconciliationRetry({
          order,
          leaseId,
          state: "uncertain",
          result: closeResult,
          error: new Error("Alipay close result is not terminal"),
        });
      } catch (error) {
        await markPaymentReconciliationRetry({ order, leaseId, state: "uncertain", result, error });
      }
      uncertain++;
      continue;
    }

    if (state === "pending" || state === "not_found") {
      await markPaymentReconciliationRetry({ order, leaseId, state: "pending", result });
      pending++;
    } else {
      await markPaymentReconciliationRetry({
        order,
        leaseId,
        state: "uncertain",
        result,
        error: new Error("Alipay payment status is uncertain"),
      });
      uncertain++;
    }
  }

  const summary = { scanned: claimed.length, succeeded, closed, pending, uncertain, failed };
  logger.info("subscription.payment.reconciliation.completed", summary);
  return summary;
};

export const processSubscriptionReminders = async () => {
  const rows = await sql`
    SELECT id, user_id, plan_name, current_period_end, contact_email
    FROM subscriptions
    WHERE status = 'active'
      AND current_period_end > NOW()
      AND current_period_end <= NOW() + INTERVAL '2 days'
      AND (last_reminder_at IS NULL OR last_reminder_at < current_period_end - INTERVAL '3 days')
  `;

  let sent = 0;
  for (const row of rows) {
    try {
      const result = await sendSubscriptionExpiryReminder({
        to: row.contact_email,
        planName: row.plan_name,
        expiresAt: row.current_period_end,
      });
      if (result.sent) {
        await sql`UPDATE subscriptions SET last_reminder_at = NOW(), updated_at = NOW() WHERE id = ${row.id}`;
        sent++;
      }
    } catch (error) {
      logger.error("subscription.reminder.error", { subscriptionId: row.id, error: error.message });
    }
  }

  return { scanned: rows.length, sent };
};

export {
  TIER_RANK,
  normalizeEmail,
  makeRefundNo,
  refundRequestFingerprint,
  normalizeProviderPaymentState,
  normalizeProviderRefundState,
  paymentReconciliationDelaySeconds,
  reconciliationDelaySeconds,
  safeProviderPaymentSnapshot,
  safeProviderRefundSnapshot,
};
