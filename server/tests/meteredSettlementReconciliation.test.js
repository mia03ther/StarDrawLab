import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stubbedSpecifiers = new Map([
  ["../configs/db.js", "settlement-reconciliation-test:db"],
  ["../configs/logger.js", "settlement-reconciliation-test:logger"],
  ["./membershipService.js", "settlement-reconciliation-test:membership"],
  ["./modelConfigurationService.js", "settlement-reconciliation-test:model"],
  ["./pointsService.js", "settlement-reconciliation-test:points"],
  ["./executionGovernorComposition.js", "settlement-reconciliation-test:governor"],
  ["./emailService.js", "settlement-reconciliation-test:email"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubbedSpecifiers.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const sources = {
      "settlement-reconciliation-test:db": "export default function sql() { throw new Error('default db must not be used'); }",
      "settlement-reconciliation-test:logger": "export default { error() {}, warn() {}, info() {} };",
      "settlement-reconciliation-test:membership": "export const checkAndGrantBonus = async () => {};",
      "settlement-reconciliation-test:model": "export const resolveActiveModelRoute = async () => ({ provider_key: 'canvas_agent', id: '1' });",
      "settlement-reconciliation-test:points": "export const chargePoints = async () => {}; export const releasePoints = async () => {}; export const reservePoints = async () => {}; export const resolveCharge = async () => 1;",
      "settlement-reconciliation-test:governor": "export const getExecutionGovernor = () => null;",
      "settlement-reconciliation-test:email": "export const sendOperationalAlert = async () => ({ sent: true });",
    };
    return sources[url] ? { format: "module", shortCircuit: true, source: sources[url] } : nextLoad(url, context);
  },
});

const { reconcileMeteredAgentOperations } = await import("../services/meteredAgentOperationService.js");

const createSql = ({ failCharge = false } = {}) => {
  const calls = [];
  const candidate = {
    id: "17", user_id: "user-1", points_cost: 3, response_snapshot: { ok: true },
    reconciliation_attempts: 0,
  };
  const operation = { ...candidate, status: "settlement_pending", provider_completed_at: new Date(0) };
  const sql = async (strings, ...values) => {
    const query = strings.join(" ");
    calls.push({ query, values });
    if (query.includes("SELECT id, user_id, points_cost")) return [candidate];
    if (query.includes("SELECT id, user_id, status, points_cost")) return [operation];
    if (query.includes("SET status = 'completed'")) return [{ id: candidate.id }];
    if (query.includes("SET reconciliation_attempts")) return [{ reconciliation_attempts: 3, reconciliation_alerted_at: new Date() }];
    return [];
  };
  sql.begin = async (callback) => callback(sql);
  sql.calls = calls;
  sql.failCharge = failCharge;
  return sql;
};

test("reconciliation charges only a persisted provider result and is idempotent at the ledger seam", async () => {
  const sql = createSql();
  const charges = [];
  const summary = await reconcileMeteredAgentOperations({
    sqlClient: sql,
    olderThanMs: 1_000,
    charge: async (input) => { charges.push(input); },
  });
  assert.deepEqual(summary, { scanned: 1, reconciled: 1, skipped: 0, failed: 0, alerted: 0 });
  assert.equal(charges.length, 1);
  assert.deepEqual(charges[0], {
    userId: "user-1",
    amount: 3,
    sourceType: "metered_agent_operation",
    sourceId: "17",
    idempotencyKey: "charge:agent-operation:17",
    note: "补偿结算：Agent 模型调用",
    tx: sql,
  });
});

test("reconciliation records failure and sends one threshold alert", async () => {
  const sql = createSql();
  const alerts = [];
  const summary = await reconcileMeteredAgentOperations({
    sqlClient: sql,
    olderThanMs: 1_000,
    alertAfterAttempts: 3,
    charge: async () => { throw Object.assign(new Error("ledger unavailable"), { code: "DB_DOWN" }); },
    alert: async (input) => { alerts.push(input); },
  });
  assert.deepEqual(summary, { scanned: 1, reconciled: 0, skipped: 0, failed: 1, alerted: 1 });
  assert.equal(alerts[0].details.operationId, "17");
  assert.equal(alerts[0].details.attempts, 3);
});

