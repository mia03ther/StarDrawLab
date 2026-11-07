import assert from "node:assert/strict";
import test from "node:test";

import {
  resetEmailSender,
  setEmailSender,
} from "../services/emailComposition.js";
import {
  sendJobSettlementNotification,
  sendOperationalAlert,
  sendSubscriptionExpiryReminder,
} from "../services/emailService.js";

const originalEnv = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_FROM: process.env.SMTP_FROM,
  SMTP_USER: process.env.SMTP_USER,
  OPERATIONAL_ALERT_EMAILS: process.env.OPERATIONAL_ALERT_EMAILS,
};

const restoreEnvironment = () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEmailSender();
};

test.afterEach(restoreEnvironment);

test("operational alerts remain fail-safe when SMTP is not configured", async () => {
  delete process.env.SMTP_HOST;
  process.env.OPERATIONAL_ALERT_EMAILS = "root@example.com";
  resetEmailSender();

  assert.deepEqual(
    await sendOperationalAlert({ subject: "test", message: "message" }),
    { sent: false, skipped: true, reason: "smtp_not_configured" },
  );
});

test("operational alert keeps recipients, bounded details, and return semantics", async () => {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_FROM = "StarDraw <no-reply@example.com>";
  process.env.OPERATIONAL_ALERT_EMAILS = "root@example.com, root@example.com, admin@example.com";
  const messages = [];
  setEmailSender({ send: async (message) => { messages.push(message); } });

  const result = await sendOperationalAlert({
    subject: "  alert  ",
    message: "  details  ",
    details: { source: "worker", oversized: "x".repeat(2_000) },
  });

  assert.deepEqual(result, { sent: true, recipientCount: 2 });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].to, ["root@example.com", "admin@example.com"]);
  assert.equal(messages[0].subject, "alert");
  assert.match(messages[0].text, /details\n\nsource: worker/);
  assert.equal(messages[0].text.length < 2_100, true);
});

test("expiry reminder asks the user to renew manually and propagates SMTP errors", async () => {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_FROM = "no-reply@example.com";
  const expected = new Error("smtp unavailable");
  setEmailSender({ send: async (message) => {
    assert.equal(message.subject, "StarDraw 会员即将到期，请及时续费");
    assert.match(message.text, /Pro/);
    assert.match(message.text, /不会自动续费/);
    assert.match(message.text, /主动续费/);
    assert.doesNotMatch(message.text, /自动续订/);
    assert.match(message.html, /strong/);
    throw expected;
  } });

  await assert.rejects(
    () => sendSubscriptionExpiryReminder({
      to: "user@example.com",
      planName: "Pro",
      expiresAt: "2026-09-05T07:00:00.000Z",
    }),
    (error) => error === expected,
  );
});

test("expiry reminder skips a missing recipient before resolving SMTP", async () => {
  delete process.env.SMTP_HOST;
  resetEmailSender();
  assert.deepEqual(
    await sendSubscriptionExpiryReminder({ planName: "Pro", expiresAt: Date.now() }),
    { sent: false, skipped: true, reason: "missing_recipient" },
  );
});

test("job settlement mail contains only bounded settlement metadata", async () => {
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_FROM = "no-reply@example.com";
  const messages = [];
  setEmailSender({ send: async (message) => { messages.push(message); } });

  assert.deepEqual(await sendJobSettlementNotification({
    to: "database-owner@example.com",
    displayName: "Owner <script>",
    taskId: "run-7",
    jobType: "workflow.run",
    outcome: "failed",
    payload: { email: "attacker@example.com", token: "must-not-leak" },
    errorMessage: "Bearer must-not-leak",
  }), { sent: true });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, "database-owner@example.com");
  assert.match(messages[0].subject, /任务失败/);
  assert.match(messages[0].text, /run-7/);
  assert.match(messages[0].html, /Owner &lt;script&gt;/);
  assert.doesNotMatch(JSON.stringify(messages[0]), /attacker@example\.com|must-not-leak|Bearer/);
});
