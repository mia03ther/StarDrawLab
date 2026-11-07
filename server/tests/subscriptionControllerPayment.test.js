import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = "__stardrawSubscriptionControllerPaymentTest";
globalThis[stateKey] = { verify: true, validateCalls: 0, activateCalls: 0 };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/controllers/subscriptionController.js")) return nextResolve(specifier, context);
    const modules = new Map([
      ["../configs/logger.js", "subscription-controller-payment-test:logger"],
      ["../configs/db.js", "subscription-controller-payment-test:db"],
      ["../services/subscriptionService.js", "subscription-controller-payment-test:service"],
      ["../services/pointPackageService.js", "subscription-controller-payment-test:point-service"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stateRef = `globalThis.${stateKey}`;
    const module = (source) => ({ format: "module", shortCircuit: true, source });
    if (url === "subscription-controller-payment-test:logger") {
      return module("export default { info() {}, warn() {}, error() {} };");
    }
    if (url === "subscription-controller-payment-test:db") {
      return module("export default async function sql() { return []; }");
    }
    if (url === "subscription-controller-payment-test:service") {
      return module(`
        const state = ${stateRef};
        export const verifySubscriptionPaymentNotification = () => state.verify;
        export const validateAlipayPaymentNotification = async () => { state.validateCalls++; return { paymentTxnId: "trade-1" }; };
        export const activateSubscriptionOrder = async () => { state.activateCalls++; return state.activateCalls === 1 ? { order: { status: "paid" } } : { alreadyPaid: true }; };
        export const attachProviderAgreement = async () => null;
        export const cancelSubscriptionRenewal = async () => null;
        export const createSubscriptionOrder = async () => ({});
        export const createSubscriptionPeriodicAgreement = async () => ({});
        export const getCurrentSubscription = async () => null;
        export const getSubscriptionOverview = async () => ({});
        export const listActivePlans = async () => [];
      `);
    }
    if (url === "subscription-controller-payment-test:point-service") {
      return module(`
        export const findPointPackageOrder = async () => null;
        export const validatePointPackagePayment = async () => ({ paymentTxnId: "trade-1" });
        export const activatePointPackageOrder = async () => ({ alreadyPaid: true });
      `);
    }
    return nextLoad(url, context);
  },
});

const { alipayNotify } = await import("../controllers/subscriptionController.js");

const response = () => ({
  statusCode: 200,
  body: undefined,
  status(code) { this.statusCode = code; return this; },
  send(body) { this.body = body; return this; },
  json(body) { this.body = body; return this; },
});

const notification = () => ({
  body: {
    out_trade_no: "SO-1",
    trade_no: "trade-1",
    trade_status: "TRADE_SUCCESS",
    total_amount: "99.00",
    app_id: "app-1",
    seller_id: "2088000000000001",
  },
});

test.beforeEach(() => {
  globalThis[stateKey].verify = true;
  globalThis[stateKey].validateCalls = 0;
  globalThis[stateKey].activateCalls = 0;
});

test("an invalid Alipay signature is rejected before order lookup or activation", async () => {
  globalThis[stateKey].verify = false;
  const res = response();
  await alipayNotify(notification(), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body, "fail");
  assert.equal(globalThis[stateKey].validateCalls, 0);
  assert.equal(globalThis[stateKey].activateCalls, 0);
});

test("duplicate signed success notifications are acknowledged through the idempotent activation path", async () => {
  const first = response();
  const second = response();
  await alipayNotify(notification(), first);
  await alipayNotify(notification(), second);
  assert.equal(first.body, "success");
  assert.equal(second.body, "success");
  assert.equal(globalThis[stateKey].validateCalls, 2);
  assert.equal(globalThis[stateKey].activateCalls, 2);
});
