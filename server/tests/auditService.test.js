import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Keep these unit tests independent from installed packages and guarantee that
// importing the service cannot initialize a database client or file logger.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js" && context.parentURL?.endsWith("/services/auditService.js")) {
      return { shortCircuit: true, url: "audit-test:db" };
    }
    if (specifier === "../configs/logger.js" && context.parentURL?.endsWith("/services/auditService.js")) {
      return { shortCircuit: true, url: "audit-test:logger" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "audit-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default function sql() { throw new Error('database access is forbidden in audit unit tests'); }",
      };
    }
    if (url === "audit-test:logger") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default { error() {}, warn() {}, debug() {} };",
      };
    }
    return nextLoad(url, context);
  },
});

const {
  buildAuditCsv,
  escapeCsvCell,
  normalizeAuditFilters,
  redactAuditValue,
  sanitizeAuditLogRow,
} = await import("../services/auditService.js");

test("normalizes only supported audit filters and keeps compatibility aliases", () => {
  const filters = normalizeAuditFilters({
    page: "2",
    page_size: "500",
    actor_user_id: "authing-user-1",
    action: "access.role.change",
    target_type: "user",
    target_id: "authing-user-2",
    target: "authing",
    query: "request-123",
    from: "2026-08-01",
    to: "2026-08-06",
    arbitrary_sql_column: "ignored",
  });

  assert.deepEqual(filters, {
    page: 2,
    pageSize: 100,
    actorUserId: "authing-user-1",
    action: "access.role.change",
    targetType: "user",
    targetId: "authing-user-2",
    targetQuery: "authing",
    query: "request-123",
    dateFrom: "2026-08-01T00:00:00.000Z",
    dateToInclusive: null,
    dateToExclusive: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(Object.hasOwn(filters, "arbitrary_sql_column"), false);
});

test("validates scalar filters and date ranges before a database query", () => {
  assert.throws(
    () => normalizeAuditFilters({ actor: ["one", "two"] }),
    (error) => error.status === 400 && error.code === "INVALID_AUDIT_FILTER",
  );
  assert.throws(
    () => normalizeAuditFilters({ from: "2026-02-30" }),
    (error) => error.status === 400 && error.code === "INVALID_AUDIT_FILTER",
  );
  assert.throws(
    () => normalizeAuditFilters({ from: "2026-08-07", to: "2026-08-06" }),
    (error) => error.status === 400 && error.code === "INVALID_AUDIT_FILTER",
  );
});

test("redacts secret keys and common credential formats in legacy rows", () => {
  const row = sanitizeAuditLogRow({
    id: "1",
    actor_user_id: "root-user",
    actor_role: "root",
    action: "provider.update",
    reason: "Authorization: Bearer abc.def-123",
    before_value: {
      apiKey: "plain-secret",
      nested: { note: "password=hunter2" },
    },
    after_value: { note: "sk-abcdefghijklmnopqrstuvwxyz" },
    metadata: { refresh_token: "jwt-value" },
    internal_secret_column: "must not be selected",
    created_at: new Date("2026-08-06T00:00:00.000Z"),
  });

  assert.equal(row.reason, "Authorization: [REDACTED]");
  assert.equal(row.before_value.apiKey, "[REDACTED]");
  assert.equal(row.before_value.nested.note, "password=[REDACTED]");
  assert.equal(row.after_value.note, "[REDACTED]");
  assert.equal(row.metadata.refresh_token, "[REDACTED]");
  assert.equal(Object.hasOwn(row, "internal_secret_column"), false);
});

test("redaction truncates deep structures instead of returning them unfiltered", () => {
  const deeplyNested = { one: { two: { three: { four: { five: { six: { seven: { api_key: "leak" } } } } } } } };
  const redacted = redactAuditValue(deeplyNested);
  assert.equal(redacted.one.two.three.four.five.six.seven, "[TRUNCATED]");
});

test("CSV cells neutralize spreadsheet formulas and quote content", () => {
  assert.equal(escapeCsvCell("=HYPERLINK(\"https://example.invalid\")"), '"\'=HYPERLINK(""https://example.invalid"")"');
  assert.equal(escapeCsvCell("  +1+1"), '"\'  +1+1"');
  assert.equal(escapeCsvCell("\t@SUM(1,1)"), '"\'\t@SUM(1,1)"');
  assert.equal(escapeCsvCell("normal, value"), '"normal, value"');
});

test("CSV export contains only the fixed public column set", () => {
  const csv = buildAuditCsv([{
    id: "=1+1",
    created_at: new Date("2026-08-06T00:00:00.000Z"),
    actor_user_id: "root-user",
    actor_role: "root",
    action: "audit.export",
    target_type: "audit",
    target_id: "all",
    reason: "approved",
    request_id: "request-1",
    ip_address: "127.0.0.1",
    before_value: { api_key: "must-not-export" },
  }]);

  assert.match(csv, /^id,created_at,actor_user_id,actor_role,action,target_type,target_id,reason,request_id,ip_address\r\n/);
  assert.match(csv, /"'=1\+1"/);
  assert.doesNotMatch(csv, /must-not-export|before_value|api_key/);
});
