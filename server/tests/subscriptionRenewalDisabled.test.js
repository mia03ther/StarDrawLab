import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = "__stardrawSubscriptionRenewalDisabledTest";
globalThis[stateKey] = { statements: [], expired: false };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL
        || !new URL(context.parentURL).pathname.endsWith("/services/subscriptionService.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/db.js", "subscription-renewal-disabled-test:db"],
      ["../configs/logger.js", "subscription-renewal-disabled-test:logger"],
      ["../adapters/alipayPaymentGateway.js", "subscription-renewal-disabled-test:gateway"],
      ["./emailService.js", "subscription-renewal-disabled-test:email"],
      ["./membershipService.js", "subscription-renewal-disabled-test:membership"],
      ["./pointsService.js", "subscription-renewal-disabled-test:points"],
      ["./auditService.js", "subscription-renewal-disabled-test:audit"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stateRef = `globalThis.${stateKey}`;
    const module = (source) => ({ format: "module", shortCircuit: true, source });
    if (url === "subscription-renewal-disabled-test:logger") {
      return module("export default { info() {}, warn() {}, error() {} };");
    }
    if (url === "subscription-renewal-disabled-test:gateway") {
      return module("export const createAlipayPaymentGateway = () => ({ isConfigured: () => false });");
    }
    if (url === "subscription-renewal-disabled-test:email") {
      return module("export const sendOperationalAlert = async () => ({ sent: false }); export const sendSubscriptionExpiryReminder = async () => ({ sent: false });");
    }
    if (url === "subscription-renewal-disabled-test:membership") return module("export const checkAndGrantBonus = async () => null;");
    if (url === "subscription-renewal-disabled-test:points") {
      return module(`
        export const ensureAccountTx = async () => ({});
        export const getAccountInfo = async () => ({});
        export const rechargePoints = async () => null;
        export const refundReservedPoints = async () => null;
        export const releasePoints = async () => null;
        export const reservePoints = async () => null;
      `);
    }
    if (url === "subscription-renewal-disabled-test:audit") return module("export const writeAuditLog = async () => null;");
    if (url === "subscription-renewal-disabled-test:db") {
      return module(`
        const state = ${stateRef};
        const subscription = {
          id: 7,
          user_id: "user-1",
          status: "active",
          auto_renew: true,
          cancel_at_period_end: false,
          provider_agreement_id: "agreement-1",
          current_period_end: new Date(Date.now() - 60_000).toISOString(),
        };
        const statement = (strings) => strings.join("?").replace(/\\s+/g, " ").trim();
        const sql = async (strings) => {
          const text = statement(strings);
          state.statements.push(text);
          if (text.startsWith("SELECT * FROM subscriptions WHERE status IN")) return [subscription];
          return [];
        };
        sql.begin = async (operation) => operation(async (strings) => {
          const text = statement(strings);
          state.statements.push(text);
          if (text.startsWith("SELECT * FROM subscriptions WHERE id")) return [subscription];
          if (text.startsWith("UPDATE subscriptions SET status = 'expired'")) {
            state.expired = true;
            subscription.status = "expired";
          }
          return [];
        });
        export default sql;
      `);
    }
    return nextLoad(url, context);
  },
});

const { processSubscriptionRenewals } = await import("../services/subscriptionService.js?renewal-disabled-test");

test("disabled periodic billing expires due subscriptions instead of leaving them past_due", async () => {
  const previous = process.env.ALIPAY_PERIODIC_ENABLED;
  process.env.ALIPAY_PERIODIC_ENABLED = "false";
  try {
    const result = await processSubscriptionRenewals();
    assert.deepEqual(result, { scanned: 1, renewed: 0, submitted: 0, expired: 1 });
    assert.equal(globalThis[stateKey].expired, true);
    assert.doesNotMatch(globalThis[stateKey].statements.join(" "), /createPeriodicPayment/);
  } finally {
    if (previous === undefined) delete process.env.ALIPAY_PERIODIC_ENABLED;
    else process.env.ALIPAY_PERIODIC_ENABLED = previous;
  }
});
