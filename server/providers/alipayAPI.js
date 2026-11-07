import { AlipaySdk } from "alipay-sdk";
import logger from "../configs/logger.js";

const normalizePem = (value) => String(value || "").trim().replace(/\\n/g, "\n");
const unwrapResponse = (result, name) => result?.[name] || result?.[name.replace(/_([a-z])/g, (_, char) => char.toUpperCase())] || result;
const providerField = (response, snake, camel) => response?.[snake] ?? response?.[camel];

const safeProviderError = (response, fallback) => Object.assign(new Error(
  String(providerField(response, "sub_msg", "subMsg") || response?.msg || fallback).slice(0, 500),
), {
  code: providerField(response, "sub_code", "subCode") || `ALIPAY_PROVIDER_${response?.code || "FAILED"}`,
  status: 502,
  providerCode: response?.code ? String(response.code).slice(0, 32) : null,
  providerSubCode: providerField(response, "sub_code", "subCode")
    ? String(providerField(response, "sub_code", "subCode")).slice(0, 128)
    : null,
});

const providerOutcomeForCode = (code) => {
  if (String(code) === "20000" || String(code) === "60000") return "uncertain";
  return "failed";
};

const normalizeRefundState = (value) => {
  const state = String(value || "").trim().toUpperCase();
  if (["REFUND_SUCCESS", "SUCCESS", "SUCCEED", "REFUNDED", "REFUND_FINISHED"].includes(state)) return "success";
  if (["REFUND_FAILED", "FAILED", "FAIL", "REFUND_CLOSED", "CLOSED"].includes(state)) return "failed";
  return "uncertain";
};

const normalizePaymentState = (value) => {
  const state = String(value || "").trim().toUpperCase();
  if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(state)) return "success";
  if (state === "WAIT_BUYER_PAY") return "pending";
  if (state === "TRADE_CLOSED") return "closed";
  return "uncertain";
};

const compactRefundResponse = (response, state) => ({
  state,
  providerCode: response?.code ? String(response.code).slice(0, 32) : null,
  providerSubCode: providerField(response, "sub_code", "subCode")
    ? String(providerField(response, "sub_code", "subCode")).slice(0, 128)
    : null,
  providerRefundId: providerField(response, "refund_trade_no", "refundTradeNo") || null,
});

const compactPaymentResponse = (response, state, current) => ({
  state,
  providerCode: response?.code ? String(response.code).slice(0, 32) : null,
  providerSubCode: providerField(response, "sub_code", "subCode")
    ? String(providerField(response, "sub_code", "subCode")).slice(0, 128)
    : null,
  tradeStatus: providerField(response, "trade_status", "tradeStatus")
    ? String(providerField(response, "trade_status", "tradeStatus")).slice(0, 32)
    : null,
  providerTransactionId: providerField(response, "trade_no", "tradeNo")
    ? String(providerField(response, "trade_no", "tradeNo")).slice(0, 255)
    : null,
  outTradeNo: providerField(response, "out_trade_no", "outTradeNo")
    ? String(providerField(response, "out_trade_no", "outTradeNo")).slice(0, 80)
    : null,
  totalAmount: providerField(response, "total_amount", "totalAmount") ?? null,
  // Some Alipay query responses omit app_id. In that case the signed query
  // itself is bound to the configured application; when Alipay does return
  // identity fields, preserve them so the application layer can reject an
  // explicit APPID/PID mismatch instead of masking it with local config.
  appId: providerField(response, "app_id", "appId")
    ? String(providerField(response, "app_id", "appId")).slice(0, 255)
    : current.appId || null,
  sellerId: providerField(response, "seller_id", "sellerId")
    ? String(providerField(response, "seller_id", "sellerId")).slice(0, 255)
    : current.sellerId || null,
});

const config = () => ({
  appId: String(process.env.ALIPAY_APP_ID || "").trim(),
  sellerId: String(process.env.ALIPAY_SELLER_ID || "").trim(),
  privateKey: normalizePem(process.env.ALIPAY_PRIVATE_KEY),
  alipayPublicKey: normalizePem(process.env.ALIPAY_PUBLIC_KEY),
  gateway: String(process.env.ALIPAY_GATEWAY || "https://openapi-sandbox.dl.alipaydev.com/gateway.do").trim(),
  notifyUrl: String(process.env.ALIPAY_NOTIFY_URL || "").trim(),
  returnUrl: String(process.env.ALIPAY_RETURN_URL || "").trim(),
  periodicEnabled: String(process.env.ALIPAY_PERIODIC_ENABLED || "false").toLowerCase() === "true",
  periodicProductCode: String(process.env.ALIPAY_PERIODIC_PRODUCT_CODE || "").trim(),
});

const requirePeriodicProductCode = (current) => {
  if (!current.periodicProductCode) {
    throw Object.assign(new Error("Alipay periodic product code is not configured"), {
      code: "ALIPAY_PERIODIC_PRODUCT_CODE_MISSING",
      status: 503,
    });
  }
  return current.periodicProductCode;
};

export const isAlipayConfigured = () => {
  const current = config();
  return Boolean(current.appId && current.sellerId && current.privateKey && current.alipayPublicKey);
};

const getSdk = () => {
  const current = config();
  if (!isAlipayConfigured()) {
    throw Object.assign(new Error("Alipay is not configured"), {
      code: "ALIPAY_NOT_CONFIGURED",
      status: 503,
    });
  }

  return new AlipaySdk({
    appId: current.appId,
    privateKey: current.privateKey,
    alipayPublicKey: current.alipayPublicKey,
    gateway: current.gateway,
    timeout: 5000,
    camelcase: true,
  });
};

export const createPagePayment = async ({ orderNo, subject, amountCents, returnUrl }) => {
  const current = config();
  const effectiveReturnUrl = returnUrl || current.returnUrl;
  if (!current.notifyUrl || !effectiveReturnUrl) {
    throw Object.assign(new Error("Alipay notify and return URLs are not configured"), {
      code: "ALIPAY_CALLBACK_NOT_CONFIGURED",
      status: 503,
    });
  }

  const sdk = getSdk();
  return sdk.pageExecute("alipay.trade.page.pay", "GET", {
    notifyUrl: current.notifyUrl,
    returnUrl: effectiveReturnUrl,
    bizContent: {
      outTradeNo: orderNo,
      productCode: "FAST_INSTANT_TRADE_PAY",
      totalAmount: (Number(amountCents || 0) / 100).toFixed(2),
      subject: String(subject || "StarDraw subscription").slice(0, 256),
    },
  });
};

export const queryPayment = async ({ outTradeNo }) => {
  const current = config();
  const result = await getSdk().exec("alipay.trade.query", {
    bizContent: { outTradeNo: String(outTradeNo || "").slice(0, 80) },
  });
  const response = unwrapResponse(result, "alipay_trade_query_response");
  const code = String(response?.code || "");
  const subCode = String(providerField(response, "sub_code", "subCode") || "");
  if (code !== "10000") {
    if (subCode === "ACQ.TRADE_NOT_EXIST") {
      return compactPaymentResponse(response, "not_found", current);
    }
    const error = safeProviderError(response, "Alipay payment query failed");
    error.providerOutcome = providerOutcomeForCode(code);
    throw error;
  }
  return compactPaymentResponse(
    response,
    normalizePaymentState(providerField(response, "trade_status", "tradeStatus")),
    current,
  );
};

export const closePayment = async ({ outTradeNo }) => {
  const current = config();
  const result = await getSdk().exec("alipay.trade.close", {
    bizContent: { outTradeNo: String(outTradeNo || "").slice(0, 80) },
  });
  const response = unwrapResponse(result, "alipay_trade_close_response");
  const code = String(response?.code || "");
  const subCode = String(providerField(response, "sub_code", "subCode") || "");
  if (code === "10000") return compactPaymentResponse(response, "closed", current);
  if (subCode === "ACQ.TRADE_NOT_EXIST") return compactPaymentResponse(response, "not_found", current);

  const error = safeProviderError(response, "Alipay payment close failed");
  // A status error can mean the buyer paid while the close request was in
  // flight. Only a later query may decide the order's terminal state.
  error.providerOutcome = subCode === "ACQ.TRADE_STATUS_ERROR"
    ? "uncertain"
    : providerOutcomeForCode(code);
  throw error;
};

export const verifyNotify = (params) => {
  const sdk = getSdk();
  return sdk.checkNotifySign(params);
};

export const refundPayment = async ({ transactionId, outTradeNo, refundRequestNo, refundAmountCents, reason }) => {
  const sdk = getSdk();
  const result = await sdk.exec("alipay.trade.refund", {
    bizContent: {
      tradeNo: transactionId || undefined,
      outTradeNo: transactionId ? undefined : outTradeNo,
      refundAmount: (Number(refundAmountCents || 0) / 100).toFixed(2),
      refundReason: String(reason || "StarDraw subscription refund").slice(0, 256),
      outRequestNo: String(refundRequestNo || "").slice(0, 64) || undefined,
    },
  });

  const response = unwrapResponse(result, "alipay_trade_refund_response");
  if (String(response?.code || "") !== "10000") {
    const error = safeProviderError(response, "Alipay refund failed");
    error.providerOutcome = providerOutcomeForCode(response?.code);
    throw error;
  }
  return compactRefundResponse(response, "success");
};

// Query by the merchant refund request number.  Only stable, non-sensitive
// fields cross the adapter boundary; the SDK response is never persisted.
export const queryRefund = async ({ transactionId, outTradeNo, refundRequestNo }) => {
  const result = await getSdk().exec("alipay.trade.fastpay.refund.query", {
    bizContent: {
      tradeNo: transactionId || undefined,
      outTradeNo: transactionId ? undefined : outTradeNo,
      outRequestNo: String(refundRequestNo || "").slice(0, 64) || undefined,
    },
  });
  const response = unwrapResponse(result, "alipay_trade_fastpay_refund_query_response");
  const code = String(response?.code || "");
  if (code !== "10000") {
    const error = safeProviderError(response, "Alipay refund query failed");
    error.providerOutcome = providerOutcomeForCode(code);
    throw error;
  }
  return compactRefundResponse(response, normalizeRefundState(
    providerField(response, "refund_status", "refundStatus") || response?.status,
  ));
};

export const createPeriodicPayment = async ({ orderNo, subject, amountCents, agreementNo }) => {
  const current = config();
  if (!agreementNo) {
    throw Object.assign(new Error("Alipay periodic agreement is missing"), {
      code: "ALIPAY_AGREEMENT_MISSING",
      status: 409,
    });
  }
  if (!current.periodicEnabled) {
    throw Object.assign(new Error("Alipay periodic payment is not enabled"), {
      code: "ALIPAY_PERIODIC_NOT_ENABLED",
      status: 503,
    });
  }
  const periodicProductCode = requirePeriodicProductCode(current);
  if (!current.notifyUrl || !current.returnUrl) {
    throw Object.assign(new Error("Alipay periodic callback URLs are not configured"), {
      code: "ALIPAY_CALLBACK_NOT_CONFIGURED",
      status: 503,
    });
  }

  const result = await getSdk().exec("alipay.trade.pay", {
    notifyUrl: current.notifyUrl,
    bizContent: {
      outTradeNo: orderNo,
      productCode: periodicProductCode,
      totalAmount: (Number(amountCents || 0) / 100).toFixed(2),
      subject: String(subject || "StarDraw subscription renewal").slice(0, 256),
      agreementNo,
    },
  });
  const response = unwrapResponse(result, "alipay_trade_pay_response");
  if (!['10000', '10003'].includes(String(response?.code || ""))) {
    const error = safeProviderError(response, "Alipay periodic payment failed");
    error.providerOutcome = providerOutcomeForCode(response?.code);
    error.code = providerField(response, "sub_code", "subCode")
      || `ALIPAY_PAYMENT_${response?.code || "FAILED"}`;
    throw Object.assign(error, {
      status: 502,
    });
  }
  return response;
};

export const getAlipayAccountConfig = () => {
  const current = config();
  return { appId: current.appId, sellerId: current.sellerId };
};

// Periodic deductions are only enabled after the merchant has opened the
// corresponding Alipay product.  We intentionally do not silently emulate
// auto-renewal with a second charge, because that would violate the user's
// explicit confirmation rule and could create an unauthorized debit.
export const createPeriodicAgreement = async ({ externalAgreementNo, userId, returnUrl }) => {
  const current = config();
  if (!current.periodicEnabled) {
    throw Object.assign(new Error("Alipay periodic payment is not enabled"), {
      code: "ALIPAY_PERIODIC_NOT_ENABLED",
      status: 503,
    });
  }
  const periodicProductCode = requirePeriodicProductCode(current);
  if (!current.notifyUrl || !(returnUrl || current.returnUrl)) {
    throw Object.assign(new Error("Alipay periodic callback URLs are not configured"), {
      code: "ALIPAY_CALLBACK_NOT_CONFIGURED",
      status: 503,
    });
  }

  const sdk = getSdk();
  logger.info("alipay.periodic_agreement.start", { externalAgreementNo, userId });
  return sdk.exec("alipay.user.agreement.page.sign", {
    notifyUrl: current.notifyUrl,
    returnUrl: returnUrl || current.returnUrl,
    bizContent: {
      personalProductCode: periodicProductCode,
      signScene: "INDUSTRY|DIGITAL_CONTENT",
      externalAgreementNo,
      externalLogonId: String(userId).slice(0, 100),
    },
  });
};
