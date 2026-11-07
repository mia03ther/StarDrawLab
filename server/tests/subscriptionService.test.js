import assert from "node:assert/strict";
import test from "node:test";

import {
  addBillingPeriod,
  normalizeProviderPaymentState,
  normalizeProviderRefundState,
  paymentReconciliationDelaySeconds,
  reconciliationDelaySeconds,
  refundRequestFingerprint,
  safeProviderRefundSnapshot,
  safeProviderPaymentSnapshot,
} from "../services/subscriptionService.js";

test("subscription billing aligns monthly dates and preserves time of day", () => {
  assert.equal(
    addBillingPeriod("2026-08-05T15:00:00.000Z", "month").toISOString(),
    "2026-09-05T15:00:00.000Z",
  );
  assert.equal(
    addBillingPeriod("2026-01-31T15:00:00.000Z", "month").toISOString(),
    "2026-02-28T15:00:00.000Z",
  );
  assert.equal(
    addBillingPeriod("2028-02-29T15:00:00.000Z", "year", 29).toISOString(),
    "2029-02-28T15:00:00.000Z",
  );
});

test("refund reconciliation has explicit three-state normalization and bounded backoff", () => {
  assert.equal(normalizeProviderRefundState({ state: "success" }), "success");
  assert.equal(normalizeProviderRefundState({ state: "failed" }), "failed");
  assert.equal(normalizeProviderRefundState({ state: "processing" }), "uncertain");
  assert.equal(reconciliationDelaySeconds(1), 30);
  assert.equal(reconciliationDelaySeconds(20), 6 * 60 * 60);
});

test("payment reconciliation normalizes provider states and bounds retries", () => {
  assert.equal(normalizeProviderPaymentState({ state: "success" }), "success");
  assert.equal(normalizeProviderPaymentState({ tradeStatus: "WAIT_BUYER_PAY" }), "pending");
  assert.equal(normalizeProviderPaymentState({ state: "not_found" }), "not_found");
  assert.equal(normalizeProviderPaymentState({ state: "processing" }), "uncertain");
  assert.equal(paymentReconciliationDelaySeconds(1), 30);
  assert.equal(paymentReconciliationDelaySeconds(20), 15 * 60);
});

test("refund idempotency fingerprints distinguish order and request parameters", () => {
  const original = refundRequestFingerprint({ orderNo: "SO-1", reason: "unused" });
  assert.equal(original, refundRequestFingerprint({ orderNo: "SO-1", reason: "unused" }));
  assert.notEqual(original, refundRequestFingerprint({ orderNo: "SO-2", reason: "unused" }));
  assert.notEqual(original, refundRequestFingerprint({ orderNo: "SO-1", reason: "other" }));
});

test("provider snapshots never carry a complete provider payload", () => {
  const snapshot = safeProviderRefundSnapshot({
    state: "success",
    providerCode: "10000",
    providerSubCode: "ACQ.OK",
    providerRefundId: "refund-1",
    sensitivePayload: { private_key: "must-not-cross-boundary" },
  }, "success");
  assert.deepEqual(snapshot, {
    state: "success",
    providerCode: "10000",
    providerSubCode: "ACQ.OK",
    providerRefundId: "refund-1",
  });
  assert.equal(Object.hasOwn(snapshot, "sensitivePayload"), false);

  const paymentSnapshot = safeProviderPaymentSnapshot({
    state: "success",
    outTradeNo: "SO-1",
    providerTransactionId: "trade-1",
    totalAmount: "99.00",
    appId: "app-1",
    sellerId: "2088000000000001",
    privateKey: "must-not-cross-boundary",
  });
  assert.deepEqual(paymentSnapshot, {
    state: "success",
    outTradeNo: "SO-1",
    totalAmount: "99.00",
    providerTransactionId: "trade-1",
    appId: "app-1",
    sellerId: "2088000000000001",
  });
  assert.equal(Object.hasOwn(paymentSnapshot, "privateKey"), false);
});
