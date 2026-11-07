import assert from "node:assert/strict";
import test from "node:test";

const { getRootUsageAnalytics, normalizeRootUsageFilters } = await import("../services/rootUsageAnalyticsService.js");

test("root usage filters normalize supported dimensions and reject malformed dates", () => {
  const filters = normalizeRootUsageFilters({
    page: "2",
    page_size: "80",
    record_type: "agent",
    output_type: "agent",
    date_from: "2026-09-01",
    date_to: "2026-09-09",
  });
  assert.equal(filters.page, 2);
  assert.equal(filters.pageSize, 80);
  assert.equal(filters.recordType, "agent");
  assert.equal(filters.outputType, "agent");
  assert.equal(filters.dateFrom, "2026-09-01T00:00:00.000Z");
  assert.equal(filters.dateTo, "2026-09-09T23:59:59.999Z");
  assert.throws(() => normalizeRootUsageFilters({ date_from: "09/01/2026" }), (error) => error.code === "INVALID_DATE_FILTER");
});

test("root usage analytics returns immutable activity, summary, and daily trend", async () => {
  const calls = [];
  const db = async (strings, ...values) => {
    calls.push({ query: strings.join(" ").replace(/\s+/g, " "), values });
    return [{
      total: 2,
      summary: { total_events: 2, active_users: 1, points_charged: 7, agent_calls: 1 },
      records: [{ record_type: "points", record_id: "10", user_id: "user-1", charged_points: 7 }],
      trend: [{ day: "2026-09-09", events: 2 }],
    }];
  };

  const result = await getRootUsageAnalytics({
    query: "alice",
    user_id: "user-1",
    model: "gpt-5.6-sol",
    date_from: "2026-09-09",
  }, { db });

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /FROM point_ledger/);
  assert.match(calls[0].query, /held_points_change/);
  assert.match(calls[0].query, /released_points/);
  assert.match(calls[0].query, /FROM creations/);
  assert.match(calls[0].query, /FROM metered_agent_operations/);
  assert.match(calls[0].query, /COUNT\(DISTINCT user_id\)/);
  assert.equal(result.total, 2);
  assert.equal(result.records[0].charged_points, 7);
  assert.equal(result.trend[0].events, 2);
  assert.equal(result.filters.userId, "user-1");
});
