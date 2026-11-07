import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// This test replaces every external dependency of the subscription service.
// It exercises the reconciliation state machine without a PostgreSQL client,
// migration, Alipay SDK, network request, or running application process.
const stateKey = "__stardrawRefundReconciliationTest";
const state = {
  claimedQueue: [],
  refunds: new Map(),
  providerStates: new Map(),
  calls: [],
};
globalThis[stateKey] = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/subscriptionService.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/db.js", "refund-reconciliation-test:db"],
      ["../configs/logger.js", "refund-reconciliation-test:logger"],
      ["../adapters/alipayPaymentGateway.js", "refund-reconciliation-test:gateway"],
      ["./emailService.js", "refund-reconciliation-test:email"],
      ["./membershipService.js", "refund-reconciliation-test:membership"],
      ["./pointsService.js", "refund-reconciliation-test:points"],
      ["./auditService.js", "refund-reconciliation-test:audit"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stateRef = `globalThis.${stateKey}`;
    const module = (source) => ({ format: "module", shortCircuit: true, source });
    if (url === "refund-reconciliation-test:logger") {
      return module("export default { info() {}, warn() {}, error() {} };");
    }
    if (url === "refund-reconciliation-test:gateway") {
      return module(`
        export const createAlipayPaymentGateway = () => ({
          isConfigured: () => false,
          queryRefund: async ({ refundRequestNo }) => ({
            state: ${stateRef}.providerStates.get(refundRequestNo) || "uncertain",
          }),
        });
      `);
    }
    if (url === "refund-reconciliation-test:email") {
      return module(`
        export const sendOperationalAlert = async () => ({ sent: false });
        export const sendSubscriptionExpiryReminder = async () => ({ sent: false });
      `);
    }
    if (url === "refund-reconciliation-test:membership") {
      return module("export const checkAndGrantBonus = async () => null;");
    }
    if (url === "refund-reconciliation-test:points") {
      return module(`
        export const ensureAccountTx = async () => ({});
        export const getAccountInfo = async () => ({});
        export const rechargePoints = async () => null;
        export const refundReservedPoints = async ({ sourceId }) => { ${stateRef}.calls.push(["refund-points", sourceId]); };
        export const releasePoints = async ({ sourceId }) => { ${stateRef}.calls.push(["release-points", sourceId]); };
        export const reservePoints = async ({ sourceId }) => { ${stateRef}.calls.push(["reserve-points", sourceId]); };
      `);
    }
    if (url === "refund-reconciliation-test:audit") {
      return module("export const writeAuditLog = async () => null;");
    }
    if (url === "refund-reconciliation-test:db") {
      return module(`
        const state = ${stateRef};
        const compact = (strings) => strings.join("?").replace(/\\s+/g, " ").trim();
        const query = async (strings, ...values) => {
          const statement = compact(strings);
          state.calls.push(["sql", statement]);
          if (statement.includes("SET reconciliation_state = 'uncertain'")) {
            const refund = state.refunds.get(String(values[values.length - 2]));
            return refund ? [refund] : [];
          }
          return [];
        };
        const tx = async (strings, ...values) => {
          const statement = compact(strings);
          state.calls.push(["tx", statement]);
          if (statement.startsWith("WITH candidates")) {
            return state.claimedQueue.map((id) => {
              const refund = state.refunds.get(String(id));
              return { ...refund, payment_txn_id: "trade-" + id, order_no: "SO-" + id, reconciliation_attempts: Number(refund.reconciliation_attempts || 0) + 1 };
            });
          }
          const id = String(values[0]);
          if (statement.includes("SELECT * FROM subscription_refunds")) {
            const refund = state.refunds.get(id);
            state.currentRefundId = id;
            return refund ? [refund] : [];
          }
          if (statement.includes("FROM subscription_orders WHERE id")) {
            return [{ id: 1, order_no: "SO-1", user_id: "user-1", subscription_id: 1, included_points: 100, bonus_points: 0, status: "paid" }];
          }
          if (statement.includes("SELECT COALESCE(SUM(refunded_points)")) return [{ points: 0 }];
          if (statement.includes("SET status = 'completed'")) {
            const refund = state.refunds.get(state.currentRefundId);
            if (!refund) return [];
            refund.status = "completed";
            refund.reconciliation_state = "success";
            return [refund];
          }
          if (statement.includes("SET status = 'failed'")) {
            const refund = state.refunds.get(state.currentRefundId);
            if (!refund) return [];
            refund.status = "failed";
            refund.reconciliation_state = "failed";
            return [refund];
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

const { processPendingRefundReconciliations } = await import("../services/subscriptionService.js");

const makeRefund = (id) => ({
  id,
  order_id: 1,
  refund_no: "RF-" + id,
  user_id: "user-1",
  requested_points: 100,
  status: "pending",
  reason: "unused",
  reconciliation_state: "uncertain",
  reconciliation_attempts: 0,
});

test("reconciliation distinguishes success, failed, and still-uncertain without releasing unknown points", async () => {
  for (const id of ["uncertain", "success", "failed"]) state.refunds.set(id, makeRefund(id));
  state.claimedQueue = ["uncertain", "success", "failed"];
  state.providerStates.set("RF-uncertain", "uncertain");
  state.providerStates.set("RF-success", "success");
  state.providerStates.set("RF-failed", "failed");

  const first = await processPendingRefundReconciliations({ limit: 1000 });
  assert.deepEqual(first, { scanned: 3, success: 1, failed: 1, stillUncertain: 1 });
  assert.equal(state.refunds.get("uncertain").status, "pending");
  assert.equal(state.refunds.get("success").status, "completed");
  assert.equal(state.refunds.get("failed").status, "failed");
  assert.deepEqual(
    state.calls.filter(([name]) => name === "release-points"),
    [["release-points", "failed"]],
  );
  assert.deepEqual(
    state.calls.filter(([name]) => name === "refund-points"),
    [["refund-points", "success"]],
  );

  state.claimedQueue = ["uncertain"];
  state.providerStates.set("RF-uncertain", "success");
  const second = await processPendingRefundReconciliations({ limit: 1 });
  assert.deepEqual(second, { scanned: 1, success: 1, failed: 0, stillUncertain: 0 });
  assert.equal(state.refunds.get("uncertain").status, "completed");
});
