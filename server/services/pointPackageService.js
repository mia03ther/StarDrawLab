import crypto from "crypto";

import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { createAlipayPaymentGateway } from "../adapters/alipayPaymentGateway.js";
import {
  rechargePoints,
  refundReservedPoints,
  releasePoints,
  reservePoints,
} from "./pointsService.js";
import { writeAuditLog } from "./auditService.js";

let paymentGateway = createAlipayPaymentGateway();

export const setPointPackagePaymentGateway = (gateway) => {
  if (!gateway
      || typeof gateway.isConfigured !== "function"
      || typeof gateway.getAccountConfig !== "function"
      || typeof gateway.createPagePayment !== "function"
      || typeof gateway.queryPayment !== "function"
      || typeof gateway.closePayment !== "function"
      || typeof gateway.refundPayment !== "function"
      || typeof gateway.queryRefund !== "function") {
    throw new TypeError("A payment gateway adapter is required");
  }
  paymentGateway = gateway;
};

export const resetPointPackagePaymentGateway = () => {
  paymentGateway = createAlipayPaymentGateway();
};

const makeOrderNo = () =>
  `PO${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
const makeRefundNo = () =>
  `PR${new Date().toISOString().slice(0, 10).replace(/-/g, "")}${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

const readPayloadField = (payload, ...fields) => {
  for (const field of fields) {
    const value = payload?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
};

const normalizePaymentState = (result) => {
  const state = String(result?.state || result?.tradeStatus || "").trim().toLowerCase();
  if (["success", "succeeded", "trade_success", "trade_finished"].includes(state)) return "success";
  if (["pending", "wait_buyer_pay"].includes(state)) return "pending";
  if (["closed", "trade_closed"].includes(state)) return "closed";
  if (state === "not_found") return "not_found";
  return "uncertain";
};

const normalizeRefundState = (result) => {
  const state = String(result?.state || result?.status || "").trim().toLowerCase();
  if (["success", "succeeded", "completed"].includes(state)) return "success";
  if (["failed", "failure", "rejected"].includes(state)) return "failed";
  return "uncertain";
};

const safeError = (error) => String(error?.code || error?.message || error || "payment operation failed")
  .replace(/\b(?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
  .slice(0, 500);

const safePaymentSnapshot = (payload) => {
  const source = payload && typeof payload === "object" ? payload : {};
  const allowed = [
    "code", "sub_code", "subCode", "msg", "trade_no", "tradeNo", "out_trade_no", "outTradeNo",
    "total_amount", "totalAmount", "trade_status", "tradeStatus", "state", "providerCode",
    "providerSubCode", "providerTransactionId", "appId", "sellerId",
  ];
  return Object.fromEntries(allowed
    .filter((key) => source[key] !== undefined && source[key] !== null)
    .map((key) => [key, String(source[key]).slice(0, 255)]));
};

const paymentProviderPayload = (result) => ({
  app_id: result?.appId,
  seller_id: result?.sellerId,
  out_trade_no: result?.outTradeNo,
  trade_no: result?.providerTransactionId,
  total_amount: result?.totalAmount,
  trade_status: result?.tradeStatus,
});

const retryDelaySeconds = (attempts) => Math.min(15 * 60, 30 * (2 ** Math.max(0, Number(attempts || 0) - 1)));
const refundRetryDelaySeconds = (attempts) => Math.min(6 * 60 * 60, 30 * (2 ** Math.max(0, Number(attempts || 0) - 1)));

export const listActivePointPackages = async () => sql`
  SELECT id, package_key, package_name, description, price_cents, points,
         bonus_points, (points + bonus_points)::integer AS total_points,
         display_order, metadata
  FROM point_packages
  WHERE is_active = TRUE
  ORDER BY display_order ASC, price_cents ASC, id ASC
`;

export const findPointPackageOrder = async (orderNo, db = sql) => {
  const [order] = await db`
    SELECT * FROM point_orders WHERE order_no = ${String(orderNo || "")} LIMIT 1
  `;
  return order || null;
};

export const createPointPackageOrder = async ({ userId, packageKey, clientRequestId, returnUrl }) => {
  if (!clientRequestId) {
    throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400 });
  }

  const result = await sql.begin(async (tx) => {
    const [existing] = await tx`
      SELECT * FROM point_orders
      WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      LIMIT 1
    `;
    if (existing) {
      if (String(existing.package_key) !== String(packageKey)) {
        throw Object.assign(new Error("Idempotency key is already used for another point package"), {
          status: 409,
          code: "POINT_ORDER_IDEMPOTENCY_KEY_CONFLICT",
        });
      }
      return { order: existing, existing: true };
    }

    const [pointPackage] = await tx`
      SELECT * FROM point_packages
      WHERE package_key = ${packageKey} AND is_active = TRUE
      FOR SHARE
    `;
    if (!pointPackage) {
      throw Object.assign(new Error("Point package is unavailable"), { status: 400, code: "POINT_PACKAGE_UNAVAILABLE" });
    }

    const totalPoints = Number(pointPackage.points) + Number(pointPackage.bonus_points || 0);
    let [order] = await tx`
      INSERT INTO point_orders
        (user_id, order_no, package_key, package_name, amount_cents,
         points, bonus_points, total_points, status, payment_method,
         client_request_id, payment_reconciliation_state, next_payment_reconciliation_at)
      VALUES
        (${userId}, ${makeOrderNo()}, ${pointPackage.package_key}, ${pointPackage.package_name},
         ${Number(pointPackage.price_cents)}, ${Number(pointPackage.points)},
         ${Number(pointPackage.bonus_points || 0)}, ${totalPoints}, 'pending', 'alipay',
         ${clientRequestId}, 'pending', NOW())
      ON CONFLICT (user_id, client_request_id) WHERE client_request_id IS NOT NULL
      DO NOTHING
      RETURNING *
    `;
    if (order) return { order, existing: false };

    [order] = await tx`
      SELECT * FROM point_orders
      WHERE user_id = ${userId} AND client_request_id = ${clientRequestId}
      LIMIT 1
    `;
    if (!order) throw Object.assign(new Error("Concurrent point order creation could not be resolved"), {
      status: 409,
      code: "POINT_ORDER_CONCURRENT_CONFLICT",
    });
    if (String(order.package_key) !== String(packageKey)) {
      throw Object.assign(new Error("Idempotency key is already used for another point package"), {
        status: 409,
        code: "POINT_ORDER_IDEMPOTENCY_KEY_CONFLICT",
      });
    }
    return { order, existing: true };
  });

  let paymentUrl = null;
  let paymentConfigStatus = "ready";
  if (result.order.status === "pending") {
    if (paymentGateway.isConfigured()) {
      try {
        paymentUrl = await paymentGateway.createPagePayment({
          orderNo: result.order.order_no,
          subject: `StarDraw 积分包 - ${result.order.package_name}`,
          amountCents: result.order.amount_cents,
          returnUrl,
        });
      } catch (error) {
        paymentConfigStatus = error.code || "ALIPAY_PAYMENT_UNAVAILABLE";
        logger.warn("pointPackage.payment_url.failed", { orderNo: result.order.order_no, code: paymentConfigStatus });
      }
    } else {
      paymentConfigStatus = "ALIPAY_NOT_CONFIGURED";
    }
  }

  return { ...result, payment_url: paymentUrl, payment_config_status: paymentConfigStatus };
};

export const validatePointPackagePayment = async ({ orderNo, providerPayload }) => {
  const order = await findPointPackageOrder(orderNo);
  if (!order) throw Object.assign(new Error("Point package order not found"), { status: 404, code: "ORDER_NOT_FOUND" });
  if (String(readPayloadField(providerPayload, "out_trade_no", "outTradeNo")) !== String(order.order_no)) {
    throw Object.assign(new Error("Alipay order number mismatch"), { status: 400, code: "PAYMENT_ORDER_MISMATCH" });
  }

  const { appId, sellerId } = paymentGateway.getAccountConfig();
  if (appId && String(readPayloadField(providerPayload, "app_id", "appId")) !== appId) {
    throw Object.assign(new Error("Alipay app_id mismatch"), { status: 400, code: "PAYMENT_APP_MISMATCH" });
  }
  if (sellerId && String(readPayloadField(providerPayload, "seller_id", "sellerId")) !== sellerId) {
    throw Object.assign(new Error("Alipay seller_id mismatch"), { status: 400, code: "PAYMENT_SELLER_MISMATCH" });
  }

  const amountCents = Math.round(Number(readPayloadField(providerPayload, "total_amount", "totalAmount")) * 100);
  if (!Number.isFinite(amountCents) || amountCents !== Number(order.amount_cents)) {
    throw Object.assign(new Error("Alipay payment amount mismatch"), { status: 400, code: "PAYMENT_AMOUNT_MISMATCH" });
  }
  const paymentTxnId = String(readPayloadField(providerPayload, "trade_no", "tradeNo")).trim();
  if (!paymentTxnId) throw Object.assign(new Error("Alipay trade number is missing"), { status: 400, code: "PAYMENT_TRADE_NO_MISSING" });
  if (order.payment_txn_id && String(order.payment_txn_id) !== paymentTxnId) {
    throw Object.assign(new Error("Alipay trade number does not match the order"), { status: 409, code: "PAYMENT_TXN_MISMATCH" });
  }
  const [conflict] = await sql`
    SELECT order_no FROM point_orders
    WHERE payment_txn_id = ${paymentTxnId} AND order_no <> ${order.order_no}
    UNION ALL
    SELECT order_no FROM subscription_orders
    WHERE payment_txn_id = ${paymentTxnId}
    LIMIT 1
  `;
  if (conflict) throw Object.assign(new Error("Alipay trade number was already used"), { status: 409, code: "PAYMENT_TRADE_REPLAY" });
  return { order, paymentTxnId };
};

export const activatePointPackageOrder = async ({ orderNo, paymentTxnId, providerPayload = {} }) => sql.begin(async (tx) => {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`stardraw:payment:${paymentTxnId || orderNo}`}, 0))`;
  const [order] = await tx`SELECT * FROM point_orders WHERE order_no = ${orderNo} FOR UPDATE`;
  if (!order) return { notFound: true };
  if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
    if (paymentTxnId && order.payment_txn_id && String(order.payment_txn_id) !== String(paymentTxnId)) {
      throw Object.assign(new Error("Payment transaction does not match the paid order"), { status: 409, code: "PAYMENT_TXN_MISMATCH" });
    }
    return { alreadyPaid: true, order };
  }
  if (order.status !== "pending") return { badStatus: order.status };

  if (paymentTxnId) {
    const [conflict] = await tx`
      SELECT order_no FROM point_orders WHERE payment_txn_id = ${paymentTxnId} AND id <> ${order.id}
      UNION ALL
      SELECT order_no FROM subscription_orders WHERE payment_txn_id = ${paymentTxnId}
      LIMIT 1
    `;
    if (conflict) throw Object.assign(new Error("Alipay trade number was already used"), { status: 409, code: "PAYMENT_TRADE_REPLAY" });
  }

  await rechargePoints({
    userId: order.user_id,
    amount: Number(order.total_points),
    sourceType: "point_package_order",
    sourceId: String(order.id),
    idempotencyKey: `point-package:points:${order.order_no}`,
    note: `长期积分包：${order.package_name}`,
    entryType: "recharge",
    lotCategory: "purchased",
    expiresAt: null,
    orderId: null,
    productOrderType: "point_package",
    productOrderId: order.id,
    tx,
  });

  const [updated] = await tx`
    UPDATE point_orders
    SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), confirmed_at = COALESCE(confirmed_at, NOW()),
        payment_txn_id = COALESCE(${paymentTxnId || null}, payment_txn_id),
        provider_payload = ${JSON.stringify(safePaymentSnapshot(providerPayload))}::jsonb,
        payment_reconciliation_state = 'succeeded', next_payment_reconciliation_at = NULL,
        last_payment_reconciliation_error = NULL, payment_reconciliation_claimed_at = NULL,
        payment_reconciliation_lease_id = NULL, updated_at = NOW()
    WHERE id = ${order.id}
    RETURNING *
  `;
  return { order: updated };
});

const closePendingOrder = async ({ orderId, leaseId, providerResult }) => sql.begin(async (tx) => {
  const [order] = await tx`SELECT * FROM point_orders WHERE id = ${orderId} FOR UPDATE`;
  if (!order) return { notFound: true };
  if (order.status === "paid") return { alreadyPaid: true };
  if (order.status !== "pending") return { alreadyTerminal: true };
  if (leaseId && String(order.payment_reconciliation_lease_id || "") !== String(leaseId)) return { leaseLost: true };
  await tx`
    UPDATE point_orders
    SET status = 'cancelled', payment_reconciliation_state = 'closed', payment_closed_at = NOW(),
        provider_response = provider_response || ${JSON.stringify(safePaymentSnapshot(providerResult))}::jsonb,
        next_payment_reconciliation_at = NULL, payment_reconciliation_claimed_at = NULL,
        payment_reconciliation_lease_id = NULL, updated_at = NOW()
    WHERE id = ${order.id}
  `;
  return { closed: true };
});

export const processPendingPointPackagePayments = async ({ limit = 50, minAgeMs = 120_000, closeAfterMs = 2_100_000 } = {}) => {
  const batchLimit = Math.min(50, Math.max(1, Number(limit) || 50));
  const leaseId = crypto.randomUUID();
  const leaseSeconds = 300;
  const claimed = await sql`
    WITH candidates AS (
      SELECT id FROM point_orders
      WHERE status = 'pending'
        AND payment_reconciliation_state IN ('pending', 'uncertain')
        AND created_at <= NOW() - (${Math.max(0, Number(minAgeMs) || 0)} * INTERVAL '1 millisecond')
        AND (next_payment_reconciliation_at IS NULL OR next_payment_reconciliation_at <= NOW())
        AND (payment_reconciliation_claimed_at IS NULL
          OR payment_reconciliation_claimed_at <= NOW() - (${leaseSeconds} * INTERVAL '1 second'))
      ORDER BY COALESCE(next_payment_reconciliation_at, created_at), id
      LIMIT ${batchLimit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE point_orders orders
    SET payment_reconciliation_claimed_at = NOW(), payment_reconciliation_lease_id = ${leaseId},
        payment_reconciliation_attempts = payment_reconciliation_attempts + 1,
        last_payment_reconciliation_at = NOW(), updated_at = NOW()
    FROM candidates WHERE orders.id = candidates.id
    RETURNING orders.*
  `;

  const summary = { scanned: claimed.length, succeeded: 0, closed: 0, pending: 0, uncertain: 0, failed: 0 };
  for (const order of claimed) {
    let result;
    try {
      result = await paymentGateway.queryPayment({ outTradeNo: order.order_no });
      const state = normalizePaymentState(result);
      if (state === "success") {
        const payload = paymentProviderPayload(result);
        const validated = await validatePointPackagePayment({ orderNo: order.order_no, providerPayload: payload });
        await activatePointPackageOrder({ orderNo: order.order_no, paymentTxnId: validated.paymentTxnId, providerPayload: payload });
        summary.succeeded++;
        continue;
      }
      if (state === "closed") {
        await closePendingOrder({ orderId: order.id, leaseId, providerResult: result });
        summary.closed++;
        continue;
      }
      const ageMs = Date.now() - new Date(order.created_at).getTime();
      if (["pending", "not_found"].includes(state) && ageMs >= Number(closeAfterMs)) {
        const closeResult = await paymentGateway.closePayment({ outTradeNo: order.order_no });
        const closeState = normalizePaymentState(closeResult);
        if (["closed", "not_found"].includes(closeState)) {
          await closePendingOrder({ orderId: order.id, leaseId, providerResult: closeResult });
          summary.closed++;
          continue;
        }
      }
      const reconciliationState = ["pending", "not_found"].includes(state) ? "pending" : "uncertain";
      await sql`
        UPDATE point_orders
        SET payment_reconciliation_state = ${reconciliationState},
            next_payment_reconciliation_at = NOW() + (${retryDelaySeconds(order.payment_reconciliation_attempts)} * INTERVAL '1 second'),
            provider_response = provider_response || ${JSON.stringify(safePaymentSnapshot(result))}::jsonb,
            last_payment_reconciliation_error = ${reconciliationState === "uncertain" ? "Alipay payment status is uncertain" : null},
            payment_reconciliation_claimed_at = NULL, payment_reconciliation_lease_id = NULL, updated_at = NOW()
        WHERE id = ${order.id} AND status = 'pending' AND payment_reconciliation_lease_id = ${leaseId}
      `;
      summary[reconciliationState]++;
    } catch (error) {
      const definite = error?.providerOutcome === "failed";
      await sql`
        UPDATE point_orders
        SET payment_reconciliation_state = ${definite ? "failed" : "uncertain"},
            next_payment_reconciliation_at = ${definite ? null : new Date(Date.now() + retryDelaySeconds(order.payment_reconciliation_attempts) * 1000)},
            last_payment_reconciliation_error = ${safeError(error)},
            provider_response = provider_response || ${JSON.stringify(safePaymentSnapshot(result))}::jsonb,
            payment_reconciliation_claimed_at = NULL, payment_reconciliation_lease_id = NULL, updated_at = NOW()
        WHERE id = ${order.id} AND status = 'pending' AND payment_reconciliation_lease_id = ${leaseId}
      `;
      summary.failed++;
    }
  }
  if (summary.scanned > 0) logger.info("pointPackage.payment.reconciliation.completed", summary);
  return summary;
};

const refundableLotSummary = async (tx, orderId) => {
  const lots = await tx`
    SELECT id, available_points, held_points
    FROM point_lots
    WHERE product_order_type = 'point_package' AND product_order_id = ${orderId}
    ORDER BY created_at ASC, id ASC
    FOR UPDATE
  `;
  return {
    available: lots.reduce((sum, lot) => sum + Number(lot.available_points || 0), 0),
    held: lots.reduce((sum, lot) => sum + Number(lot.held_points || 0), 0),
  };
};

const completePointPackageRefund = async ({ refundId, providerResult, actor = null, req = null, reason = null, leaseId = null }) => sql.begin(async (tx) => {
  const [refund] = leaseId
    ? await tx`SELECT * FROM point_package_refunds WHERE id = ${refundId} AND reconciliation_lease_id = ${leaseId} FOR UPDATE`
    : await tx`SELECT * FROM point_package_refunds WHERE id = ${refundId} FOR UPDATE`;
  if (!refund || refund.status !== "pending") return refund;
  const [order] = await tx`SELECT * FROM point_orders WHERE id = ${refund.order_id} FOR UPDATE`;
  if (!order) throw new Error("Point package order is missing for refund");

  await refundReservedPoints({
    userId: order.user_id,
    amount: Number(refund.requested_points),
    sourceType: "point_package_refund",
    sourceId: String(refund.id),
    idempotencyKey: `refund:point-package:${refund.id}`,
    note: "积分包退款扣回未消费积分",
    tx,
  });
  const [prior] = await tx`
    SELECT COALESCE(SUM(refunded_points), 0)::integer AS points
    FROM point_package_refunds WHERE order_id = ${order.id} AND status = 'completed'
  `;
  const fullyRefunded = Number(prior.points) + Number(refund.requested_points) >= Number(order.total_points);
  await tx`
    UPDATE point_orders SET status = ${fullyRefunded ? "refunded" : "partially_refunded"},
      refunded_at = NOW(), updated_at = NOW() WHERE id = ${order.id}
  `;
  const [updated] = await tx`
    UPDATE point_package_refunds
    SET status = 'completed', reconciliation_state = 'success', refunded_points = requested_points,
        provider_refund_id = COALESCE(${providerResult?.providerRefundId || null}, provider_refund_id),
        metadata = metadata || ${JSON.stringify({ provider: safePaymentSnapshot(providerResult) })}::jsonb,
        next_reconciliation_at = NULL, last_reconciliation_error = NULL,
        reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL, completed_at = NOW()
    WHERE id = ${refund.id} RETURNING *
  `;
  if (actor?.userId) {
    await writeAuditLog({
      req, actorUserId: actor.userId, actorRole: actor.role,
      action: "point_package.refunded", targetType: "point_package_order", targetId: order.order_no,
      reason, before: { order_status: order.status },
      after: { order_status: fullyRefunded ? "refunded" : "partially_refunded", refunded_points: updated.refunded_points },
      tx,
    });
  }
  return updated;
});

const releaseFailedRefund = async ({ refundId, error, leaseId = null }) => sql.begin(async (tx) => {
  const [refund] = leaseId
    ? await tx`SELECT * FROM point_package_refunds WHERE id = ${refundId} AND reconciliation_lease_id = ${leaseId} FOR UPDATE`
    : await tx`SELECT * FROM point_package_refunds WHERE id = ${refundId} FOR UPDATE`;
  if (!refund || refund.status !== "pending") return refund;
  await releasePoints({
    userId: refund.user_id, amount: Number(refund.requested_points),
    sourceType: "point_package_refund", sourceId: String(refund.id),
    idempotencyKey: `release:point-package-refund:${refund.id}`,
    note: "返还：积分包退款失败", tx,
  });
  const [updated] = await tx`
    UPDATE point_package_refunds SET status = 'failed', reconciliation_state = 'failed',
      last_reconciliation_error = ${safeError(error)}, next_reconciliation_at = NULL,
      reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL, completed_at = NOW()
    WHERE id = ${refund.id} RETURNING *
  `;
  return updated;
});

export const refundPointPackageOrder = async ({ orderNo, idempotencyKey, reason, actor = null, req = null }) => {
  if (!idempotencyKey) throw Object.assign(new Error("X-Idempotency-Key header is required"), { status: 400 });
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ orderNo, reason: String(reason || "") })).digest("hex");
  const prepared = await sql.begin(async (tx) => {
    const [existing] = await tx`SELECT * FROM point_package_refunds WHERE idempotency_key = ${idempotencyKey} FOR UPDATE`;
    if (existing) {
      if (existing.metadata?.request_fingerprint !== fingerprint) {
        throw Object.assign(new Error("Idempotency key is already used for another refund request"), { status: 409, code: "REFUND_IDEMPOTENCY_KEY_CONFLICT" });
      }
      return { existing };
    }
    const [order] = await tx`SELECT * FROM point_orders WHERE order_no = ${orderNo} FOR UPDATE`;
    if (!order) throw Object.assign(new Error("Point package order not found"), { status: 404 });
    if (!["paid", "partially_refunded"].includes(order.status)) {
      throw Object.assign(new Error("Only paid point package orders can be refunded"), { status: 400 });
    }
    const summary = await refundableLotSummary(tx, order.id);
    if (summary.held > 0) throw Object.assign(new Error("Refund is unavailable while points are held by running tasks"), { status: 409, code: "POINTS_HELD" });
    if (summary.available <= 0) throw Object.assign(new Error("No unconsumed points are refundable"), { status: 409, code: "NO_REFUNDABLE_POINTS" });
    const refundPoints = Math.min(summary.available, Number(order.total_points));
    const refundAmountCents = Math.floor(Number(order.amount_cents) * refundPoints / Number(order.total_points));
    if (refundAmountCents <= 0) throw Object.assign(new Error("Refund amount is below the payment provider minimum"), { status: 409, code: "REFUND_TOO_SMALL" });
    let [refund] = await tx`
      INSERT INTO point_package_refunds
        (order_id, user_id, refund_no, requested_points, amount_cents, reason,
         idempotency_key, reconciliation_state, next_reconciliation_at, metadata)
      VALUES
        (${order.id}, ${order.user_id}, ${makeRefundNo()}, ${refundPoints}, ${refundAmountCents},
         ${reason || null}, ${idempotencyKey}, 'pending', NOW(), ${JSON.stringify({ request_fingerprint: fingerprint })}::jsonb)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `;
    if (!refund) {
      [refund] = await tx`
        SELECT * FROM point_package_refunds WHERE idempotency_key = ${idempotencyKey} FOR UPDATE
      `;
      if (!refund || refund.metadata?.request_fingerprint !== fingerprint) {
        throw Object.assign(new Error("Idempotency key is already used for another refund request"), {
          status: 409,
          code: "REFUND_IDEMPOTENCY_KEY_CONFLICT",
        });
      }
      return { existing: refund };
    }
    await reservePoints({
      userId: order.user_id, amount: refundPoints,
      sourceType: "point_package_refund", sourceId: String(refund.id),
      lotProductOrderType: "point_package", lotProductOrderId: order.id,
      idempotencyKey: `reserve:point-package-refund:${refund.id}`,
      note: "预占：积分包退款待处理积分", tx,
    });
    return { order, refund };
  });
  if (prepared.existing) return prepared.existing;

  try {
    const providerResult = await paymentGateway.refundPayment({
      transactionId: prepared.order.payment_txn_id,
      outTradeNo: prepared.order.order_no,
      refundRequestNo: prepared.refund.refund_no,
      refundAmountCents: prepared.refund.amount_cents,
      reason,
    });
    return completePointPackageRefund({ refundId: prepared.refund.id, providerResult, actor, req, reason });
  } catch (error) {
    const definite = error?.providerOutcome === "failed"
      || ["ALIPAY_NOT_CONFIGURED", "ALIPAY_CALLBACK_NOT_CONFIGURED"].includes(error?.code);
    if (definite) await releaseFailedRefund({ refundId: prepared.refund.id, error });
    else await sql`
      UPDATE point_package_refunds
      SET reconciliation_state = 'uncertain', last_reconciliation_error = ${safeError(error)},
          next_reconciliation_at = NOW() + INTERVAL '30 seconds'
      WHERE id = ${prepared.refund.id} AND status = 'pending'
    `;
    throw error;
  }
};

export const processPendingPointPackageRefunds = async ({ limit = 50 } = {}) => {
  const leaseId = crypto.randomUUID();
  const claimed = await sql`
    WITH candidates AS (
      SELECT id FROM point_package_refunds
      WHERE status = 'pending' AND reconciliation_state IN ('pending', 'uncertain')
        AND (next_reconciliation_at IS NULL OR next_reconciliation_at <= NOW())
        AND (reconciliation_claimed_at IS NULL OR reconciliation_claimed_at <= NOW() - INTERVAL '10 minutes')
      ORDER BY COALESCE(next_reconciliation_at, created_at), id
      LIMIT ${Math.min(50, Math.max(1, Number(limit) || 50))}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE point_package_refunds refunds
    SET reconciliation_claimed_at = NOW(), reconciliation_lease_id = ${leaseId},
        reconciliation_attempts = reconciliation_attempts + 1, last_reconciliation_at = NOW()
    FROM candidates WHERE refunds.id = candidates.id RETURNING refunds.*
  `;
  const summary = { scanned: claimed.length, success: 0, failed: 0, uncertain: 0 };
  for (const refund of claimed) {
    try {
      const [order] = await sql`SELECT * FROM point_orders WHERE id = ${refund.order_id}`;
      const result = await paymentGateway.queryRefund({
        transactionId: order?.payment_txn_id || null,
        outTradeNo: order?.order_no || null,
        refundRequestNo: refund.refund_no,
      });
      const state = normalizeRefundState(result);
      if (state === "success") {
        await completePointPackageRefund({ refundId: refund.id, providerResult: result, leaseId });
        summary.success++;
      } else if (state === "failed") {
        await releaseFailedRefund({ refundId: refund.id, error: new Error("Alipay refund failed"), leaseId });
        summary.failed++;
      } else {
        await sql`
          UPDATE point_package_refunds
          SET reconciliation_state = 'uncertain', next_reconciliation_at = NOW() + (${refundRetryDelaySeconds(refund.reconciliation_attempts)} * INTERVAL '1 second'),
              last_reconciliation_error = 'Alipay refund status is uncertain',
              reconciliation_claimed_at = NULL, reconciliation_lease_id = NULL
          WHERE id = ${refund.id} AND reconciliation_lease_id = ${leaseId}
        `;
        summary.uncertain++;
      }
    } catch (error) {
      await sql`
        UPDATE point_package_refunds
        SET reconciliation_state = 'uncertain', next_reconciliation_at = NOW() + (${refundRetryDelaySeconds(refund.reconciliation_attempts)} * INTERVAL '1 second'),
            last_reconciliation_error = ${safeError(error)}, reconciliation_claimed_at = NULL,
            reconciliation_lease_id = NULL
        WHERE id = ${refund.id} AND reconciliation_lease_id = ${leaseId}
      `;
      summary.uncertain++;
    }
  }
  if (summary.scanned > 0) logger.info("pointPackage.refund.reconciliation.completed", summary);
  return summary;
};
