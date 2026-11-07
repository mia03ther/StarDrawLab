import assert from "node:assert/strict";
import test from "node:test";

import { processCreationSettlementNotifications } from "../services/creationSettlementNotification.js";

class FakeCreationSql {
  constructor(rows) {
    this.rows = new Map(rows.map((row) => [String(row.id), { ...row }]));
  }

  async unsafe(query, values = []) {
    const marker = query.match(/creation-notification:([a-z-]+)/)?.[1];
    if (marker === "pending") {
      return [...this.rows.values()]
        .filter((row) => ["completed", "failed"].includes(row.status)
          && !row.completion_notification_sent_at
          && !row.completion_notification_skipped_at)
        .map((row) => ({ id: row.id }));
    }
    if (marker === "claim") {
      const row = this.rows.get(String(values[0]));
      if (!row || !["completed", "failed"].includes(row.status)
        || row.completion_notification_sent_at || row.completion_notification_skipped_at) return [];
      row.completion_notification_claimed_at = new Date().toISOString();
      return [{ ...row }];
    }
    if (marker === "mark-claimed") return [{ id: values[0] }];
    if (marker === "finish") {
      const row = this.rows.get(String(values[0]));
      if (!row) return [];
      if (values[1]) row.completion_notification_sent_at = new Date().toISOString();
      if (values[2]) row.completion_notification_skipped_at = new Date().toISOString();
      row.completion_notification_claimed_at = values[1] || values[2] ? null : new Date().toISOString();
      row.completion_notification_last_error = values[3];
      return [{ id: row.id }];
    }
    throw new Error(`Unexpected creation notification query: ${query}`);
  }

  async begin(operation) {
    return operation(this);
  }
}

test("sends one bounded notification per terminal creation and skips missing recipients", async () => {
  const sql = new FakeCreationSql([
    { id: 1, user_id: "u1", type: "image", status: "completed", email: "artist@example.com", display_name: "Artist" },
    { id: 2, user_id: "u2", type: "video", status: "failed", email: null, display_name: "No email" },
  ]);
  const sent = [];

  const result = await processCreationSettlementNotifications({
    sqlClient: sql,
    sendNotification: async (payload) => {
      sent.push(payload);
      return { sent: true };
    },
  });

  assert.deepEqual(result, { scanned: 2, claimed: 2, sent: 1, skipped: 1, failed: 0 });
  assert.deepEqual(sent, [{
    to: "artist@example.com",
    displayName: "Artist",
    taskId: "creation:1",
    jobType: "creation.image",
    outcome: "completed",
  }]);
  assert.ok(sql.rows.get("1").completion_notification_sent_at);
  assert.ok(sql.rows.get("2").completion_notification_skipped_at);
});

test("leaves failed delivery retryable and records only a bounded error", async () => {
  const sql = new FakeCreationSql([
    { id: 3, user_id: "u3", type: "video", status: "failed", email: "artist@example.com", display_name: "Artist" },
  ]);

  const result = await processCreationSettlementNotifications({
    sqlClient: sql,
    sendNotification: async () => {
      throw Object.assign(new Error("smtp unavailable"), { code: "SMTP_UNAVAILABLE" });
    },
  });

  assert.deepEqual(result, { scanned: 1, claimed: 1, sent: 0, skipped: 0, failed: 1 });
  assert.equal(sql.rows.get("3").completion_notification_sent_at, undefined);
  assert.equal(sql.rows.get("3").completion_notification_skipped_at, undefined);
  assert.equal(sql.rows.get("3").completion_notification_last_error, "SMTP_UNAVAILABLE");
});
