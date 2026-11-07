import logger from "../configs/logger.js";
import sql from "../configs/db.js";
import {
  activateSubscriptionOrder,
  attachProviderAgreement,
  cancelSubscriptionRenewal,
  createSubscriptionOrder,
  createSubscriptionPeriodicAgreement,
  getCurrentSubscription,
  getSubscriptionOverview,
  listActivePlans,
  validateAlipayPaymentNotification,
  verifySubscriptionPaymentNotification,
} from "../services/subscriptionService.js";
import {
  activatePointPackageOrder,
  findPointPackageOrder,
  validatePointPackagePayment,
} from "../services/pointPackageService.js";

const getContactEmail = (req) =>
  req.body?.contact_email || req.authPayload?.email || req.authPayload?.preferred_username || null;

const subscriptionPurchasesEnabled = () =>
  ["1", "true", "yes", "on"].includes(String(process.env.SUBSCRIPTION_PURCHASES_ENABLED || "false").trim().toLowerCase());

const alipayPeriodicEnabled = () =>
  ["1", "true", "yes", "on"].includes(String(process.env.ALIPAY_PERIODIC_ENABLED || "false").trim().toLowerCase());

const publicSubscriptionOrder = (order) => {
  if (!order) return null;
  const fields = [
    "id", "order_no", "order_type", "plan_key", "plan_name", "membership_tier",
    "billing_interval", "amount_cents", "included_points", "bonus_points",
    "monthly_bonus_points", "period_start", "period_end", "status", "payment_method",
    "created_at", "paid_at", "refunded_at", "updated_at",
  ];
  return Object.fromEntries(fields
    .filter((field) => order[field] !== undefined)
    .map((field) => [field, order[field]]));
};

export const getPlans = async (_req, res) => {
  try {
    res.json({ success: true, data: await listActivePlans() });
  } catch (error) {
    logger.error("subscriptions.plans.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load subscription plans" });
  }
};

export const getOverview = async (req, res) => {
  try {
    res.json({
      success: true,
      data: {
        ...await getSubscriptionOverview(req.auth.userId),
        capabilities: {
          purchases_enabled: subscriptionPurchasesEnabled(),
          periodic_enabled: alipayPeriodicEnabled(),
        },
      },
    });
  } catch (error) {
    logger.error("subscriptions.overview.error", { userId: req.auth?.userId, error: error.message });
    res.status(500).json({ success: false, message: "Unable to load subscription" });
  }
};

export const createOrder = async (req, res) => {
  const clientRequestId = req.headers["x-idempotency-key"];
  try {
    if (!subscriptionPurchasesEnabled()) {
      return res.status(503).json({
        success: false,
        code: "SUBSCRIPTION_PURCHASES_DISABLED",
        message: "Subscription purchases are not open yet.",
      });
    }
    const result = await createSubscriptionOrder({
      userId: req.auth.userId,
      planKey: String(req.body?.plan_key || "").trim(),
      clientRequestId,
      contactEmail: getContactEmail(req),
      returnUrl: process.env.ALIPAY_RETURN_URL || `${process.env.APP_BASE_URL || ""}/ai/billing`,
    });
    res.status(result.existing ? 200 : 201).json({
      success: true,
      data: {
        order: publicSubscriptionOrder(result.order),
        subscription: result.subscription || null,
        scheduled: Boolean(result.scheduled),
        payment_url: result.payment_url,
        payment_config_status: result.payment_config_status,
      },
    });
  } catch (error) {
    logger.error("subscriptions.order.error", { userId: req.auth?.userId, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
};

export const startPeriodicAgreement = async (req, res) => {
  try {
    if (!alipayPeriodicEnabled()) {
      return res.status(503).json({
        success: false,
        code: "ALIPAY_PERIODIC_DISABLED",
        message: "Alipay automatic renewal is not open yet.",
      });
    }
    const result = await createSubscriptionPeriodicAgreement({
      userId: req.auth.userId,
      returnUrl: process.env.ALIPAY_RETURN_URL || `${process.env.APP_BASE_URL || ""}/ai/billing`,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error("subscriptions.periodicAgreement.error", { userId: req.auth?.userId, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
};

export const getOrder = async (req, res) => {
  try {
    const [order] = await sql`
      SELECT * FROM subscription_orders
      WHERE order_no = ${req.params.orderNo} AND user_id = ${req.auth.userId}
    `;
    if (!order) return res.status(404).json({ success: false, message: "Subscription order not found" });
    res.json({ success: true, data: publicSubscriptionOrder(order) });
  } catch (error) {
    logger.error("subscriptions.order.get.error", { error: error.message });
    res.status(500).json({ success: false, message: "Unable to load subscription order" });
  }
};

export const cancelRenewal = async (req, res) => {
  try {
    const subscription = await cancelSubscriptionRenewal(req.auth.userId);
    if (!subscription) return res.status(404).json({ success: false, message: "Active subscription not found" });
    res.json({ success: true, data: subscription });
  } catch (error) {
    logger.error("subscriptions.cancel.error", { userId: req.auth?.userId, error: error.message });
    res.status(500).json({ success: false, message: "Unable to cancel renewal" });
  }
};

// Alipay asynchronous notifications are the only payment-success authority.
// This route is intentionally unauthenticated and relies on Alipay signature
// verification plus the order's own amount/user snapshot.
export const alipayNotify = async (req, res) => {
  try {
    if (!verifySubscriptionPaymentNotification(req.body || {})) {
      return res.status(400).send("fail");
    }

    const externalAgreementNo = req.body?.external_agreement_no || req.body?.externalAgreementNo;
    const agreementNo = req.body?.agreement_no || req.body?.agreementNo;
    if (externalAgreementNo && agreementNo) {
      await attachProviderAgreement({
        externalAgreementNo,
        agreementNo,
        providerCustomerId: req.body?.alipay_user_id || req.body?.user_id,
      });
      // Agreement-sign callbacks do not carry a trade status. They are still
      // acknowledged only after the signature has been verified.
      if (!(req.body?.out_trade_no || req.body?.outTradeNo)) return res.send("success");
    }

    const tradeStatus = String(req.body?.trade_status || req.body?.tradeStatus || "");
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(tradeStatus)) {
      return res.send("success");
    }

    const orderNo = req.body.out_trade_no || req.body.outTradeNo;
    const pointOrder = await findPointPackageOrder(orderNo);
    let result;
    if (pointOrder) {
      await validatePointPackagePayment({ orderNo, providerPayload: req.body });
      result = await activatePointPackageOrder({
        orderNo,
        paymentTxnId: req.body.trade_no || req.body.tradeNo,
        providerPayload: req.body,
      });
    } else {
      await validateAlipayPaymentNotification({ orderNo, providerPayload: req.body });
      result = await activateSubscriptionOrder({
        orderNo,
        paymentTxnId: req.body.trade_no || req.body.tradeNo,
        providerPayload: req.body,
      });
    }
    if (result.notFound || result.badStatus) return res.status(400).send("fail");
    res.send("success");
  } catch (error) {
    logger.error("alipay.notify.error", { code: error.code, error: error.message });
    res.status(500).send("fail");
  }
};
