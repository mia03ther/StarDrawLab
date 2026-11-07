import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "identity-test:db" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "identity-test:logger" };
    if (specifier === "../services/accessControlService.js") {
      return { shortCircuit: true, url: "identity-test:access-control" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "identity-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default function sql() { throw new Error('database access forbidden'); }",
      };
    }
    if (url === "identity-test:logger") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default { error() {}, warn() {}, info() {} };",
      };
    }
    if (url === "identity-test:access-control") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const ACCOUNT_STATUSES = Object.freeze({ ACTIVE: "active", SUSPENDED: "suspended" });
          export const resolveAccessContext = async ({ userId, payload }) => ({
            userId,
            role: "user",
            accountStatus: payload.account_status || "active",
            mfaVerified: false,
          });
        `,
      };
    }
    return nextLoad(url, context);
  },
});

process.env.NODE_ENV = "test";
delete process.env.ALLOW_DEV_AUTH_HEADERS;

const { AuthingIdentityProviderAdapter, hasVerifiedEmailClaim } = await import("../infrastructure/authingIdentityProviderAdapter.js");
const composition = await import("../services/identityProviderComposition.js");
const { assertAuthConfiguration, requireAuth } = await import("../middlewares/auth.js");

const throwsCode = (code) => (error) => error.code === code;

test("Authing adapter validates configuration and fails closed", () => {
  assert.deepEqual(
    new AuthingIdentityProviderAdapter({ appHost: "", appId: "", production: false }).assertConfiguration(),
    { configured: false },
  );
  assert.throws(
    () => new AuthingIdentityProviderAdapter({ appHost: "", appId: "", production: true }).assertConfiguration(),
    throwsCode("AUTH_CONFIGURATION_MISSING"),
  );
  assert.throws(
    () => new AuthingIdentityProviderAdapter({ appHost: "https://tenant.authing.cn", appId: "" }).assertConfiguration(),
    throwsCode("AUTH_CONFIGURATION_INCOMPLETE"),
  );
  assert.throws(
    () => new AuthingIdentityProviderAdapter({
      appHost: "http://tenant.authing.cn",
      appId: "app-id",
      production: true,
    }).assertConfiguration(),
    throwsCode("AUTH_CONFIGURATION_INVALID"),
  );
  assert.throws(
    () => new AuthingIdentityProviderAdapter({
      appHost: "https://user:password@tenant.authing.cn",
      appId: "app-id",
    }).assertConfiguration(),
    throwsCode("AUTH_CONFIGURATION_INVALID"),
  );
});

test("Authing adapter verifies RS256 audience and issuer through cached JWKS", async () => {
  const calls = { factory: [], keys: [], verify: [] };
  const jwtLibrary = {
    decode(token, options) {
      assert.equal(token, "signed-token");
      assert.deepEqual(options, { complete: true });
      return { header: { kid: "signing-key-1" } };
    },
    verify(token, signingKey, options) {
      calls.verify.push({ token, signingKey, options });
      return { sub: "authing-user" };
    },
  };
  const jwksClientFactory = (options) => {
    calls.factory.push(options);
    return {
      getSigningKey(kid, callback) {
        calls.keys.push(kid);
        callback(null, { getPublicKey: () => "public-key" });
      },
    };
  };
  const adapter = new AuthingIdentityProviderAdapter({
    appHost: "https://tenant.authing.cn/",
    appId: "app-id",
    production: true,
    jwtLibrary,
    jwksClientFactory,
  });

  assert.deepEqual(await adapter.verifyAccessToken("signed-token"), { sub: "authing-user" });
  assert.deepEqual(await adapter.verifyAccessToken("signed-token"), { sub: "authing-user" });
  assert.equal(calls.factory.length, 1);
  assert.deepEqual(calls.factory[0], {
    jwksUri: "https://tenant.authing.cn/oidc/.well-known/jwks.json",
    cache: true,
    cacheMaxEntries: 5,
    cacheMaxAge: 300000,
    rateLimit: true,
    jwksRequestsPerMinute: 10,
  });
  assert.deepEqual(calls.keys, ["signing-key-1", "signing-key-1"]);
  assert.deepEqual(calls.verify[0], {
    token: "signed-token",
    signingKey: "public-key",
    options: {
      algorithms: ["RS256"],
      audience: "app-id",
      issuer: "https://tenant.authing.cn/oidc",
    },
  });
});

test("Authing adapter rejects malformed tokens without requesting JWKS", async () => {
  let jwksCreated = false;
  const adapter = new AuthingIdentityProviderAdapter({
    appHost: "https://tenant.authing.cn",
    appId: "app-id",
    jwtLibrary: { decode: () => null, verify: () => assert.fail("verify must not run") },
    jwksClientFactory: () => {
      jwksCreated = true;
      return {};
    },
  });

  await assert.rejects(
    () => adapter.verifyAccessToken("malformed"),
    (error) => error.status === 401 && error.message === "Invalid token format",
  );
  assert.equal(jwksCreated, false);
});

test("Authing adapter can require a verified email claim without trusting an unverified address", async () => {
  assert.equal(hasVerifiedEmailClaim({ email: "user@example.com", email_verified: true }), true);
  assert.equal(hasVerifiedEmailClaim({ email: "user@example.com", emailVerified: "true" }), true);
  assert.equal(hasVerifiedEmailClaim({ email: "user@example.com", email_verified: false }), false);
  assert.equal(hasVerifiedEmailClaim({ email_verified: true }), false);

  let verifiedPayload = { sub: "authing-user", email: "user@example.com", email_verified: false };
  const adapter = new AuthingIdentityProviderAdapter({
    appHost: "https://tenant.authing.cn",
    appId: "app-id",
    requireVerifiedEmail: true,
    jwtLibrary: {
      decode: () => ({ header: { kid: "key-1" } }),
      verify: () => verifiedPayload,
    },
    jwksClientFactory: () => ({
      getSigningKey(_kid, callback) {
        callback(null, { getPublicKey: () => "public-key" });
      },
    }),
  });

  await assert.rejects(
    adapter.verifyAccessToken("signed-token"),
    (error) => error.status === 403 && error.code === "EMAIL_VERIFICATION_REQUIRED",
  );
  verifiedPayload = { ...verifiedPayload, email_verified: true };
  assert.deepEqual(await adapter.verifyAccessToken("signed-token"), verifiedPayload);
});

test("identity composition keeps a stable runtime and validates test adapters", async () => {
  const runtime = composition.getIdentityProvider();
  composition.setIdentityProviderForTests({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => ({ sub: "first" }),
  });
  assert.equal(composition.getIdentityProvider(), runtime);
  assert.deepEqual(await runtime.verifyAccessToken("token"), { sub: "first" });

  composition.setIdentityProviderForTests({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => ({ sub: "second" }),
  });
  assert.deepEqual(await runtime.verifyAccessToken("token"), { sub: "second" });
  assert.throws(
    () => composition.setIdentityProviderForTests({ assertConfiguration() {} }),
    /requires verifyAccessToken/,
  );
});

const invokeAuth = async (provider, headers = {}) => {
  composition.setIdentityProviderForTests(provider);
  const req = { headers, ip: "127.0.0.1" };
  let statusCode = 200;
  let body;
  let nextCalls = 0;
  const res = {
    status(value) {
      statusCode = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };
  await requireAuth()(req, res, () => {
    nextCalls += 1;
  });
  return { req, statusCode, body, nextCalls };
};

test("auth middleware consumes verified claims through the identity seam", async () => {
  const result = await invokeAuth({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async (token) => {
      assert.equal(token, "signed-token");
      return { sub: "  authing-user  ", iat: 123 };
    },
  }, { authorization: "Bearer signed-token" });

  assert.equal(result.nextCalls, 1);
  assert.equal(result.req.auth.userId, "authing-user");
  assert.equal(result.req.authPayload.sub, "  authing-user  ");
});

test("auth middleware preserves missing configuration and suspended account responses", async () => {
  const missing = await invokeAuth({
    assertConfiguration: () => ({ configured: false }),
    verifyAccessToken: async () => assert.fail("verification must not run"),
  });
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, "AUTH_CONFIGURATION_MISSING");
  assert.equal(missing.nextCalls, 0);

  const suspended = await invokeAuth({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => ({ sub: "suspended-user", account_status: "suspended" }),
  }, { authorization: "Bearer signed-token" });
  assert.equal(suspended.statusCode, 403);
  assert.equal(suspended.body.code, "ACCOUNT_SUSPENDED");
  assert.equal(suspended.nextCalls, 0);
});

test("auth middleware preserves token error mapping and fail-closed provider errors", async () => {
  const expired = new Error("expired");
  expired.name = "TokenExpiredError";
  const expiredResult = await invokeAuth({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => { throw expired; },
  }, { authorization: "Bearer expired-token" });
  assert.equal(expiredResult.statusCode, 401);
  assert.equal(expiredResult.body.code, "TOKEN_EXPIRED");

  const providerError = Object.assign(new Error("private provider detail"), {
    status: 503,
    code: "IDENTITY_PROVIDER_UNAVAILABLE",
  });
  const unavailable = await invokeAuth({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => { throw providerError; },
  }, { authorization: "Bearer signed-token" });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.code, "IDENTITY_PROVIDER_UNAVAILABLE");
  assert.equal(unavailable.body.message, "Authorization service is unavailable");
});

test("auth middleware preserves Bearer and verified subject validation", async () => {
  const provider = {
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => ({ sub: "" }),
  };
  const missingBearer = await invokeAuth(provider);
  assert.equal(missingBearer.statusCode, 401);
  assert.equal(missingBearer.body.message, "Authorization header required");

  const invalidSubject = await invokeAuth(provider, { authorization: "Bearer signed-token" });
  assert.equal(invalidSubject.statusCode, 401);
  assert.equal(invalidSubject.body.code, "INVALID_TOKEN_SUBJECT");

  const invalidToken = new Error("invalid signature");
  invalidToken.name = "JsonWebTokenError";
  const invalidTokenResult = await invokeAuth({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => { throw invalidToken; },
  }, { authorization: "Bearer invalid-token" });
  assert.equal(invalidTokenResult.statusCode, 401);
  assert.equal(invalidTokenResult.body.code, "INVALID_TOKEN");
});

test("auth configuration assertion delegates to the selected adapter", () => {
  let calls = 0;
  composition.setIdentityProviderForTests({
    assertConfiguration() {
      calls += 1;
      return { configured: true };
    },
    async verifyAccessToken() {
      return { sub: "unused" };
    },
  });
  assert.deepEqual(assertAuthConfiguration(), { configured: true });
  assert.equal(calls, 1);
});
