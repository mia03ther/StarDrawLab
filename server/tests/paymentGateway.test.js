import assert from "node:assert/strict";
import test from "node:test";

import { AlipayPaymentGateway } from "../adapters/alipayPaymentGateway.js";

test("Alipay payment adapter delegates through the provider-neutral seam", async () => {
  const calls = [];
  const provider = {
    isAlipayConfigured: () => true,
    getAlipayAccountConfig: () => ({ appId: "app", sellerId: "seller" }),
    verifyNotify: (payload) => payload?.sign === "ok",
    createPagePayment: async (params) => { calls.push(["page", params]); return "page-url"; },
    queryPayment: async (params) => { calls.push(["payment-query", params]); return { state: "pending" }; },
    closePayment: async (params) => { calls.push(["payment-close", params]); return { state: "closed" }; },
    createPeriodicAgreement: async (params) => { calls.push(["agreement", params]); return "agreement-url"; },
    createPeriodicPayment: async (params) => { calls.push(["periodic", params]); return { code: "10000" }; },
    refundPayment: async (params) => { calls.push(["refund", params]); return { refund_fee: "1.00" }; },
    queryRefund: async (params) => { calls.push(["refund-query", params]); return { state: "success" }; },
  };
  const gateway = new AlipayPaymentGateway({ provider });

  assert.equal(gateway.isConfigured(), true);
  assert.deepEqual(gateway.getAccountConfig(), { appId: "app", sellerId: "seller" });
  assert.equal(gateway.verifyNotification({ sign: "ok" }), true);
  assert.equal(await gateway.createPagePayment({ orderNo: "SO1" }), "page-url");
  assert.deepEqual(await gateway.queryPayment({ outTradeNo: "SO1" }), { state: "pending" });
  assert.deepEqual(await gateway.closePayment({ outTradeNo: "SO1" }), { state: "closed" });
  assert.equal(await gateway.createPeriodicAgreement({ externalAgreementNo: "AG1" }), "agreement-url");
  assert.deepEqual(await gateway.createPeriodicPayment({ orderNo: "RN1" }), { code: "10000" });
  assert.deepEqual(await gateway.refundPayment({ refundRequestNo: "RF1" }), { refund_fee: "1.00" });
  assert.deepEqual(await gateway.queryRefund({ refundRequestNo: "RF1" }), { state: "success" });
  assert.deepEqual(calls.map(([name]) => name), [
    "page", "payment-query", "payment-close", "agreement", "periodic", "refund", "refund-query",
  ]);
});

test("Alipay payment adapter rejects an incomplete provider adapter", () => {
  assert.throws(
    () => new AlipayPaymentGateway({ provider: {} }),
    /requires isAlipayConfigured/,
  );
});
