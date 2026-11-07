import assert from "node:assert/strict";
import test from "node:test";

import {
  SmtpEmailAdapter,
  createSmtpEmailAdapter,
  isSmtpConfigured,
  smtpConfigFromEnv,
} from "../infrastructure/smtpEmailAdapter.js";

test("SMTP adapter forwards normalized messages through the transport seam", async () => {
  const calls = [];
  const adapter = new SmtpEmailAdapter({
    transporter: {
      sendMail: async (message) => {
        calls.push(message);
        return { messageId: "test-message" };
      },
    },
  });

  const result = await adapter.send({ from: "from@example.com", to: "to@example.com", subject: "test" });
  assert.deepEqual(result, { messageId: "test-message" });
  assert.deepEqual(calls, [{ from: "from@example.com", to: "to@example.com", subject: "test" }]);
});

test("SMTP configuration is parsed without creating a transport until requested", () => {
  const env = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "user@example.com",
    SMTP_PASSWORD: "secret",
    SMTP_FROM: "StarDraw <user@example.com>",
  };
  assert.equal(isSmtpConfigured(env), true);
  assert.deepEqual(smtpConfigFromEnv(env), {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    auth: { user: "user@example.com", pass: "secret" },
  });

  const calls = [];
  const adapter = createSmtpEmailAdapter({
    env,
    transportFactory: (config) => {
      calls.push(config);
      return { sendMail: async () => ({}) };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(adapter instanceof SmtpEmailAdapter, true);
});

test("SMTP adapter rejects missing host when it must create a transport", () => {
  assert.throws(
    () => createSmtpEmailAdapter({ env: {} }),
    /SMTP configuration is incomplete/,
  );
});

test("SMTP runtime is disabled for partial or invalid credentials", () => {
  assert.equal(isSmtpConfigured({ SMTP_HOST: "smtp.example.com" }), false);
  assert.equal(isSmtpConfigured({
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "70000",
    SMTP_USER: "user@example.com",
    SMTP_PASSWORD: "secret",
    SMTP_FROM: "user@example.com",
  }), false);
});

test("SMTP adapter preserves transport errors", async () => {
  const expected = new Error("smtp unavailable");
  const adapter = new SmtpEmailAdapter({
    transporter: { sendMail: async () => { throw expected; } },
  });
  await assert.rejects(() => adapter.send({ subject: "test" }), (error) => error === expected);
});
