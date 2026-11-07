import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = "__stardrawPaymentReconciliationTest";
const state = {
  claimedQueue: [],
  orders: new Map(),
  providerStates: new Map(),
  closeStates: new Map(),
  subscriptions: new Map(),
  calls: [],
  alerts: [],
};
globalThis[stateKey] = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/subscriptionService.js")) return nextResolve(specifier, context);
    const modules = new Map([
      ["../configs/db.js", "payment-reconciliation-test:db"],
      ["../configs/logger.js", "payment-reconciliation-test:logger"],
      ["../adapters/alipayPaymentGateway.js", "payment-reconciliation-test:gateway"],
      ["./emailService.js", "payment-reconciliation-test:email"],
      ["./membershipService.js", "payment-reconciliation-test:membership"],
      ["./pointsService.js", "payment-reconciliation-test:points"],
      ["./auditService.js", "payment-reconciliation-test:audit"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stateRef = `globalThis.${stateKey}`;
    const module = (source) => ({ format: "module", shortCircuit: true, source });
    if (url === "payment-reconciliation-test:logger") {
      return module("export default { info() {}, warn() {}, error() {} };");
    }
    if (url === "payment-reconciliation-test:gateway") {
      return module(`
        const state = ${stateRef};
        export const createAlipayPaymentGateway = () => ({
          isConfigured: () => true,
          getAccountConfig: () => ({ appId: "app-1", sellerId: "2088000000000001" }),
          verifyNotification: () => true,
          createPagePayment: async () => "https://example.test/pay",
          queryPayment: async ({ outTradeNo }) => {
            state.calls.push(["query-payment", outTradeNo]);
            const result = state.providerStates.get(outTradeNo);
            if (result instanceof Error) throw result;
            return result;
          },
          closePayment: async ({ outTradeNo }) => {
            state.calls.push(["close-payment", outTradeNo]);
            const result = state.closeStates.get(outTradeNo);
            if (result instanceof Error) throw result;
            return result;
          },
          createPeriodicAgreement: async () => null,
          createPeriodicPayment: async () => null,
          refundPayment: async () => ({ state: "success" }),
          queryRefund: async () => ({ state: "uncertain" }),
        });
      `);
    }
    if (url === "payment-reconciliation-test:email") {
      return module(`
        const state = ${stateRef};
        export const sendOperationalAlert = async (message) => { state.alerts.push(message); return { sent: true }; };
        export const sendSubscriptionExpiryReminder = async () => ({ sent: false });
      `);
    }
    if (url === "payment-reconciliation-test:membership") {
      return module(`export const checkAndGrantBonus = async (userId) => { ${stateRef}.calls.push(["grant-bonus", userId]); };`);
    }
    if (url === "payment-reconciliation-test:points") {
      return module(`
        const state = ${stateRef};
        export const ensureAccountTx = async () => ({});
        export const getAccountInfo = async () => ({});
        export const rechargePoints = async ({ idempotencyKey }) => { state.calls.push(["recharge", idempotencyKey]); };
        export const refundReservedPoints = async () => null;
        export const releasePoints = async () => null;
        export const reservePoints = async () => null;
      `);
    }
    if (url === "payment-reconciliation-test:audit") {
      return module("export const writeAuditLog = async () => null;");
    }
    if (url === "payment-reconciliation-test:db") {
      return module(`
        const state = ${stateRef};
        const compact = (strings) => strings.join("?").replace(/\\s+/g, " ").trim();
        const findOrderByNo = (orderNo) => [...state.orders.values()].find((order) => order.order_no === String(orderNo));
        const query = async (strings, ...values) => {
          const statement = compact(strings);
          state.calls.push(["sql", statement]);
          if (statement.startsWith("SELECT * FROM subscription_orders WHERE order_no")) {
            const order = findOrderByNo(values[0]);
            return order ? [order] : [];
          }
          if (statement.startsWith("SELECT order_no FROM subscription_orders")) return [];
          if (statement.includes("SET payment_reconciliation_state = ?")) {
            const order = state.orders.get(String(values[values.length - 2]));
            if (!order) return [];
            order.payment_reconciliation_state = values[0];
            order.payment_reconciliation_lease_id = null;
            order.next_payment_reconciliation_at = new Date(Date.now() + Number(values[1]) * 1000).toISOString();
            return [order];
          }
          if (statement.includes("SET payment_reconciliation_state = 'failed'")) {
            const order = state.orders.get(String(values[values.length - 2]));
            if (!order) return [];
            order.payment_reconciliation_state = "failed";
            order.payment_reconciliation_lease_id = null;
            return [order];
          }
          return [];
        };
        const tx = async (strings, ...values) => {
          const statement = compact(strings);
          state.calls.push(["tx", statement]);
          if (statement.startsWith("WITH candidates AS")) {
            const leaseId = values[3];
            return state.claimedQueue
              .map((id) => state.orders.get(String(id)))
              .filter((order) => order && order.status === "pending" && ["pending", "uncertain"].includes(order.payment_reconciliation_state))
              .map((order) => {
                order.payment_reconciliation_attempts = Number(order.payment_reconciliation_attempts || 0) + 1;
                order.payment_reconciliation_lease_id = leaseId;
                return { ...order };
              });
          }
          if (statement.startsWith("SELECT * FROM subscription_orders WHERE id")) {
            const order = state.orders.get(String(values[0]));
            return order ? [order] : [];
          }
          if (statement.startsWith("SELECT * FROM subscription_orders") && statement.includes("WHERE order_no")) {
            const order = findOrderByNo(values[0]);
            return order ? [order] : [];
          }
          if (statement.startsWith("SELECT * FROM subscriptions WHERE id")) {
            const subscription = state.subscriptions.get(String(values[0]));
            return subscription ? [subscription] : [];
          }
          if (statement.startsWith("UPDATE subscriptions") && statement.includes("SET plan_id")) {
            const subscription = state.subscriptions.get(String(values[values.length - 1]));
            if (!subscription) return [];
            subscription.status = "active";
            return [subscription];
          }
          if (statement.startsWith("UPDATE subscriptions") && statement.includes("SET status = 'cancelled'")) {
            const subscription = state.subscriptions.get(String(values[0]));
            if (subscription) subscription.status = "cancelled";
            return subscription ? [subscription] : [];
          }
          if (statement.startsWith("UPDATE subscription_orders") && statement.includes("SET status = 'paid'")) {
            const order = state.orders.get(String(values[values.length - 1]));
            if (!order) return [];
            order.status = "paid";
            order.payment_txn_id = order.payment_txn_id || values[0];
            order.payment_reconciliation_state = "succeeded";
            order.payment_reconciliation_lease_id = null;
            return [order];
          }
          if (statement.startsWith("UPDATE subscription_orders") && statement.includes("SET status = 'cancelled'")) {
            const order = state.orders.get(String(values[values.length - 1]));
            if (!order) return [];
            order.status = "cancelled";
            order.payment_reconciliation_state = "closed";
            order.payment_reconciliation_lease_id = null;
            return [order];
          }
          return [];
        };
        query.begin = async (operation) => operation(tx);
        export default query;
      `);
    }
    return nextLoad(url, context);
  },
});

const {
  activateSubscriptionOrder,
  processPendingPaymentReconciliations,
} = await import("../services/subscriptionService.js");

const createPendingOrder = (id, overrides = {}) => ({
  id,
  user_id: `user-${id}`,
  subscription_id: id,
  plan_id: id,
  order_no: `SO-${id}`,
  order_type: "initial",
  plan_key: "pro-month",
  plan_name: "Pro",
  membership_tier: "pro",
  billing_interval: "month",
  amount_cents: 9900,
  included_points: 100,
  bonus_points: 20,
  monthly_bonus_points: 10,
  period_start: new Date().toISOString(),
  period_end: new Date(Date.now() + 30 * 86400_000).toISOString(),
  status: "pending",
  payment_txn_id: null,
  provider_response: {},
  payment_reconciliation_state: "pending",
  payment_reconciliation_attempts: 0,
  payment_reconciliation_lease_id: null,
  created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
  ...overrides,
});

const addOrder = (order) => {
  state.orders.set(String(order.id), order);
  state.subscriptions.set(String(order.subscription_id), {
    id: order.subscription_id,
    user_id: order.user_id,
    status: "pending",
    billing_anchor_day: 1,
  });
  state.claimedQueue.push(String(order.id));
  return order;
};

const successfulProviderResult = (order, overrides = {}) => ({
  state: "success",
  tradeStatus: "TRADE_SUCCESS",
  providerTransactionId: `trade-${order.id}`,
  outTradeNo: order.order_no,
  totalAmount: (order.amount_cents / 100).toFixed(2),
  appId: "app-1",
  sellerId: "2088000000000001",
  ...overrides,
});

test.beforeEach(() => {
  state.claimedQueue = [];
  state.orders.clear();
  state.providerStates.clear();
  state.closeStates.clear();
  state.subscriptions.clear();
  state.calls = [];
  state.alerts = [];
});

test("a lost notification is recovered by query and a repeated scan cannot grant points twice", async () => {
  const order = addOrder(createPendingOrder("success"));
  state.providerStates.set(order.order_no, successfulProviderResult(order));

  assert.deepEqual(await processPendingPaymentReconciliations({ minAgeMs: 0 }), {
    scanned: 1, succeeded: 1, closed: 0, pending: 0, uncertain: 0, failed: 0,
  });
  assert.equal(order.status, "paid");
  assert.equal(state.calls.filter(([name]) => name === "recharge").length, 2);

  const duplicateActivation = await activateSubscriptionOrder({
    orderNo: order.order_no,
    paymentTxnId: `trade-${order.id}`,
    providerPayload: {},
  });
  assert.equal(duplicateActivation.alreadyPaid, true);
  assert.equal(state.calls.filter(([name]) => name === "recharge").length, 2);

  assert.deepEqual(await processPendingPaymentReconciliations({ minAgeMs: 0 }), {
    scanned: 0, succeeded: 0, closed: 0, pending: 0, uncertain: 0, failed: 0,
  });
  assert.equal(state.calls.filter(([name]) => name === "recharge").length, 2);
});

test("an amount mismatch never activates the subscription and raises an alert", async () => {
  const order = addOrder(createPendingOrder("mismatch"));
  state.providerStates.set(order.order_no, successfulProviderResult(order, { totalAmount: "1.00" }));

  const result = await processPendingPaymentReconciliations({ minAgeMs: 0 });
  assert.deepEqual(result, { scanned: 1, succeeded: 0, closed: 0, pending: 0, uncertain: 0, failed: 1 });
  assert.equal(order.status, "pending");
  assert.equal(order.payment_reconciliation_state, "failed");
  assert.equal(state.calls.some(([name]) => name === "recharge"), false);
  assert.equal(state.alerts.length, 1);
});

for (const [label, override] of [
  ["APPID", { appId: "another-app" }],
  ["PID", { sellerId: "2088999999999999" }],
]) {
  test(`${label} mismatch never activates the subscription`, async () => {
    const order = addOrder(createPendingOrder(`identity-${label}`));
    state.providerStates.set(order.order_no, successfulProviderResult(order, override));

    const result = await processPendingPaymentReconciliations({ minAgeMs: 0 });
    assert.equal(result.failed, 1);
    assert.equal(order.status, "pending");
    assert.equal(order.payment_reconciliation_state, "failed");
    assert.equal(state.calls.some(([name]) => name === "recharge"), false);
  });
}

test("an old unpaid order is closed remotely before it is cancelled locally", async () => {
  const order = addOrder(createPendingOrder("close"));
  state.providerStates.set(order.order_no, { state: "pending", tradeStatus: "WAIT_BUYER_PAY" });
  state.closeStates.set(order.order_no, { state: "closed", outTradeNo: order.order_no });

  const result = await processPendingPaymentReconciliations({ minAgeMs: 0, closeAfterMs: 0 });
  assert.deepEqual(result, { scanned: 1, succeeded: 0, closed: 1, pending: 0, uncertain: 0, failed: 0 });
  assert.equal(order.status, "cancelled");
  assert.deepEqual(
    state.calls.filter(([name]) => ["query-payment", "close-payment"].includes(name)),
    [["query-payment", order.order_no], ["close-payment", order.order_no]],
  );
});

test("a provider timeout leaves the order pending and schedules a retry", async () => {
  const order = addOrder(createPendingOrder("timeout"));
  state.providerStates.set(order.order_no, Object.assign(new Error("timeout"), { providerOutcome: "uncertain" }));

  const result = await processPendingPaymentReconciliations({ minAgeMs: 0 });
  assert.deepEqual(result, { scanned: 1, succeeded: 0, closed: 0, pending: 0, uncertain: 1, failed: 0 });
  assert.equal(order.status, "pending");
  assert.equal(order.payment_reconciliation_state, "uncertain");
  assert.ok(order.next_payment_reconciliation_at);
  assert.equal(state.calls.some(([name]) => name === "recharge"), false);

  state.providerStates.set(order.order_no, successfulProviderResult(order));
  order.next_payment_reconciliation_at = null;
  const recovered = await processPendingPaymentReconciliations({ minAgeMs: 0 });
  assert.deepEqual(recovered, { scanned: 1, succeeded: 1, closed: 0, pending: 0, uncertain: 0, failed: 0 });
  assert.equal(order.status, "paid");
});
