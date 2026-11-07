import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = "__stardrawSubscriptionReminderTest";
globalThis[stateKey] = { statements: [], messages: [] };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/subscriptionService.js")) return nextResolve(specifier, context);
    const modules = new Map([
      ["../configs/db.js", "subscription-reminder-test:db"],
      ["../configs/logger.js", "subscription-reminder-test:logger"],
      ["../adapters/alipayPaymentGateway.js", "subscription-reminder-test:gateway"],
      ["./emailService.js", "subscription-reminder-test:email"],
      ["./membershipService.js", "subscription-reminder-test:membership"],
      ["./pointsService.js", "subscription-reminder-test:points"],
      ["./auditService.js", "subscription-reminder-test:audit"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const stateRef = `globalThis.${stateKey}`;
    const module = (source) => ({ format: "module", shortCircuit: true, source });
    if (url === "subscription-reminder-test:logger") return module("export default { info() {}, warn() {}, error() {} };");
    if (url === "subscription-reminder-test:gateway") {
      return module("export const createAlipayPaymentGateway = () => ({ isConfigured: () => false });");
    }
    if (url === "subscription-reminder-test:email") {
      return module(`
        const state = ${stateRef};
        export const sendOperationalAlert = async () => ({ sent: false });
        export const sendSubscriptionExpiryReminder = async (message) => { state.messages.push(message); return { sent: true }; };
      `);
    }
    if (url === "subscription-reminder-test:membership") return module("export const checkAndGrantBonus = async () => null;");
    if (url === "subscription-reminder-test:points") {
      return module(`
        export const ensureAccountTx = async () => ({});
        export const getAccountInfo = async () => ({});
        export const rechargePoints = async () => null;
        export const refundReservedPoints = async () => null;
        export const releasePoints = async () => null;
        export const reservePoints = async () => null;
      `);
    }
    if (url === "subscription-reminder-test:audit") return module("export const writeAuditLog = async () => null;");
    if (url === "subscription-reminder-test:db") {
      return module(`
        const state = ${stateRef};
        const sql = async (strings) => {
          const statement = strings.join("?").replace(/\\s+/g, " ").trim();
          state.statements.push(statement);
          if (statement.startsWith("SELECT id, user_id, plan_name")) {
            return [{
              id: 1,
              user_id: "user-1",
              plan_name: "Pro",
              current_period_end: "2026-09-05T07:00:00.000Z",
              contact_email: "user@example.com",
              auto_renew: false,
            }];
          }
          return [];
        };
        sql.begin = async (operation) => operation(sql);
        export default sql;
      `);
    }
    return nextLoad(url, context);
  },
});

const { processSubscriptionReminders } = await import("../services/subscriptionService.js");

test("manual-renew subscriptions receive an expiry reminder without an auto-renew filter", async () => {
  const result = await processSubscriptionReminders();
  assert.deepEqual(result, { scanned: 1, sent: 1 });
  assert.equal(globalThis[stateKey].messages.length, 1);
  assert.equal(globalThis[stateKey].messages[0].expiresAt, "2026-09-05T07:00:00.000Z");
  assert.doesNotMatch(globalThis[stateKey].statements[0], /auto_renew/i);
});
