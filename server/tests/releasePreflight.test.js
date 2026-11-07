import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "stardraw-release-preflight-"));
const fixtureServer = path.join(fixture, "server");
fs.mkdirSync(path.join(fixtureServer, "scripts"), { recursive: true });
fs.cpSync(path.join(serverRoot, "scripts", "releasePreflight.js"), path.join(fixtureServer, "scripts", "releasePreflight.js"));
fs.cpSync(path.join(serverRoot, "migrations"), path.join(fixtureServer, "migrations"), { recursive: true });
fs.cpSync(path.join(serverRoot, "node_modules", "dotenv"), path.join(fixtureServer, "node_modules", "dotenv"), { recursive: true });
fs.writeFileSync(path.join(fixtureServer, "package.json"), '{"type":"module"}');
fs.mkdirSync(path.join(fixture, "skills", "release-fixture"), { recursive: true });
fs.writeFileSync(path.join(fixture, "skills", "release-fixture", "SKILL.md"), "Release fixture, never executed.\n");

const fixtureEnvironment = {
  NODE_ENV: "production", AUTH_PROVIDER: "oidc", OIDC_ISSUER: "https://identity.invalid/oidc",
  OIDC_AUDIENCE: "release-fixture", OIDC_JWKS_URI: "https://identity.invalid/jwks",
  ROOT_ADMIN_USER_ID: "release-fixture-root", DATABASE_URL: "postgres://fixture:fixture@postgres:5432/release_fixture",
  OSS_REGION: "oss-cn-guangzhou", OSS_ENDPOINT: "oss-cn-guangzhou.aliyuncs.com", OSS_BUCKET: "release-fixture",
  OSS_ACCESS_KEY_ID: "release-fixture", OSS_ACCESS_KEY_SECRET: "never-publish-fixture-secret",
  RESOURCE_ACCESS_SECRET: "never-publish-fixture-secret-with-more-than-32-bytes",
  IMAGE_PROVIDER_KEY: "release-fixture", IMAGE_PROVIDER_BASE_URL: "https://provider.invalid/v1",
  SORA_API_KEY: "release-fixture", SORA_BASE_URL: "https://provider.invalid/v1",
  SMTP_HOST: "smtp.invalid", SMTP_PORT: "465", SMTP_USER: "release-fixture", SMTP_PASSWORD: "never-publish-fixture-password",
  SMTP_FROM: "release-fixture@stardraw.invalid", OPERATIONAL_ALERT_EMAILS: "release-fixture@stardraw.invalid",
  MCP_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  MCP_OAUTH_REDIRECT_URI: "https://app.invalid/api/public/mcp/oauth/callback",
  MCP_OAUTH_SUCCESS_REDIRECT: "https://app.invalid/ai/account", MCP_OAUTH_ERROR_REDIRECT: "https://app.invalid/ai/account",
  ALLOWED_ORIGINS: "https://app.invalid", APP_BASE_URL: "https://app.invalid",
  EXECUTION_GOVERNOR_ENABLED: "true", METERED_SETTLEMENT_RECONCILIATION_ENABLED: "true",
  AUTH_REQUIRE_VERIFIED_EMAIL: "true", DB_SSL: "false", DIGITAL_HUMAN_OFFLINE_RENDER: "true",
  SUBSCRIPTION_PURCHASES_ENABLED: "false", JOB_WORKER_ENABLED: "false",
  LOCAL_DEVELOPMENT_MODE: "false", PROVIDER_MOCKS_ENABLED: "false", ALLOW_DEV_AUTH_HEADERS: "false", VITE_LOCAL_DEVELOPMENT: "false",
};
fs.writeFileSync(path.join(fixtureServer, ".env"), Object.entries(fixtureEnvironment).map(([name, value]) => `${name}=${value}`).join("\n"), { mode: 0o600 });
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

const runPreflight = (overrides = {}) => {
  const result = spawnSync(process.execPath, [path.join(fixtureServer, "scripts", "releasePreflight.js")], {
    cwd: fixtureServer, encoding: "utf8", windowsHide: true,
    env: { ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...overrides },
  });
  assert.ifError(result.error);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.includes("发布前检查结束"));
  // The command must never expose config values, including when rejecting one.
  for (const secret of [fixtureEnvironment.SMTP_PASSWORD, fixtureEnvironment.DATABASE_URL, fixtureEnvironment.MCP_CREDENTIAL_MASTER_KEY]) {
    assert.equal(result.stdout.includes(secret), false);
  }
  return result;
};

test("release preflight accepts the production policy without reading workstation env", () => {
  const result = runPreflight();
  const failures = result.stdout.split("\n").filter(line => line.includes("FAIL "));
  // Windows stat mode bits do not represent NTFS ACLs. The existing Unix-only
  // .env permission check is the only unrelated failure tolerated on Windows.
  assert.deepEqual(failures.filter(line => !(process.platform === "win32" && line.includes("server/.env 权限"))), []);
  assert.ok(result.stdout.includes("PASS NODE_ENV"));
  assert.ok(result.stdout.includes("PASS LOCAL_DEVELOPMENT_MODE"));
});

for (const nodeEnv of ["development", "test", "", "PRODUCTION", " production "]) {
  test(`release preflight rejects NODE_ENV ${nodeEnv || "unset"}`, () => {
    const result = runPreflight({ NODE_ENV: nodeEnv });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes("FAIL NODE_ENV"));
  });
}
for (const [name, enabled] of [
  ["LOCAL_DEVELOPMENT_MODE", "true"], ["PROVIDER_MOCKS_ENABLED", "1"],
  ["ALLOW_DEV_AUTH_HEADERS", "YES"], ["VITE_LOCAL_DEVELOPMENT", "on"],
]) {
  test(`release preflight blocks ${name} even when NODE_ENV is production`, () => {
    const result = runPreflight({ [name]: enabled });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes(`FAIL ${name}`));
    assert.ok(result.stdout.includes("PASS NODE_ENV"));
  });
}