import assert from "node:assert/strict";
import test from "node:test";

process.env.AUTH_PROVIDER = "logto";
process.env.OIDC_ACCOUNT_API_URL = "https://auth.example.test/api";

const account = await import("../services/identityAccountService.js");

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test("Logto account adapter reads profile and optional security state with the Account API token", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/my-account")) return response({ username: "alice", name: "Alice", primaryEmail: "alice@example.com", primaryPhone: "+8613800000000" });
    if (url.endsWith("/my-account/mfa-verifications")) return response([{ id: "mfa-1" }]);
    return response([{ id: "session-1" }]);
  };

  const result = await account.getIdentityAccount({ accessToken: "business-token", accountAccessToken: "account-token", fetchImpl });
  assert.equal(result.available, true);
  assert.equal(result.profile.username, "alice");
  assert.equal(result.security.mfa_count, 1);
  assert.equal(result.security.active_session_count, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://auth.example.test/api/my-account",
    "https://auth.example.test/api/my-account/mfa-verifications",
    "https://auth.example.test/api/my-account/sessions",
  ]);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer account-token");
});

test("Logto account adapter can hydrate identity profile without loading security endpoints", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ username: "alice", name: "Alice Example", primaryEmail: "alice@example.com", profile: { gender: "female", birthdate: "1990-01-01" } });
  };

  const profile = await account.getIdentityProfile({ accessToken: "business-token", accountAccessToken: "account-token", fetchImpl });

  assert.deepEqual(profile, {
    username: "alice",
    name: "Alice Example",
    primaryEmail: "alice@example.com",
    profile: { gender: "female", birthdate: "1990-01-01" },
    email: "alice@example.com",
    full_name: "Alice Example",
    gender: "female",
    birthdate: "1990-01-01",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.example.test/api/my-account");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.Authorization, "Bearer account-token");
});

test("Logto account adapter never sends the business token to Account API", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ username: "should-not-be-read-from-business-token" });
  };

  await assert.rejects(
    () => account.getIdentityProfile({ accessToken: "business-token", fetchImpl }),
    (error) => error.code === "IDENTITY_ACCOUNT_TOKEN_MISSING" && error.status === 401,
  );
  assert.equal(calls.length, 0);
});

test("Logto account adapter maps basic and extended profile updates", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/my-account")) return response({ name: "Updated" });
    return response({ gender: "female" });
  };

  const profile = await account.updateIdentityAccount({ accessToken: "business-token", accountAccessToken: "account-token", profile: { name: "Updated", gender: "female", ignored: "nope" }, fetchImpl });
  assert.equal(profile.name, "Updated");
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: "Updated" });
  assert.deepEqual(JSON.parse(calls[1].options.body), { gender: "female" });
  assert.equal(calls[2].url, "https://auth.example.test/api/my-account");
  assert.equal(calls[0].options.headers.Authorization, "Bearer account-token");
});

test("Logto account adapter verifies the current password before changing it", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/verifications/password")) return response({ verificationRecordId: "verify-1" });
    return response({});
  };

  await account.changeIdentityPassword({ accessToken: "business-token", accountAccessToken: "account-token", currentPassword: "old-password", newPassword: "new-password", fetchImpl });
  assert.equal(calls[0].url, "https://auth.example.test/api/verifications/password");
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: "old-password" });
  assert.equal(calls[1].url, "https://auth.example.test/api/my-account/password");
  assert.deepEqual(JSON.parse(calls[1].options.body), { password: "new-password" });
  assert.equal(calls[1].options.headers.Authorization, "Bearer account-token");
  assert.equal(calls[1].options.headers["logto-verification-id"], "verify-1");
  await assert.rejects(
    () => account.changeIdentityPassword({ accessToken: "business-token", accountAccessToken: "account-token", currentPassword: "old", newPassword: "short", fetchImpl }),
    (error) => error.code === "IDENTITY_PASSWORD_INVALID" && error.status === 400,
  );
});
