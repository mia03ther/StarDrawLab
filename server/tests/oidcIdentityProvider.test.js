import assert from "node:assert/strict";
import test from "node:test";
import { OidcIdentityProviderAdapter } from "../infrastructure/oidcIdentityProviderAdapter.js";
import {
  assertEmailPolicy,
  emailDomain,
  hasVerifiedEmailClaim,
} from "../infrastructure/identityEmailPolicy.js";

const fakeJwks = (calls) => () => ({
  getSigningKey(kid, callback) {
    calls.push(kid);
    callback(null, { getPublicKey: () => "public-key" });
  },
});

test("OIDC adapter validates production configuration", () => {
  assert.deepEqual(
    new OidcIdentityProviderAdapter({ issuer: "", audience: "", jwksUri: "", production: false }).assertConfiguration(),
    { configured: false },
  );
  assert.throws(
    () => new OidcIdentityProviderAdapter({ issuer: "https://issuer.example.com", audience: "client", jwksUri: "", production: true }).assertConfiguration(),
    (error) => error.code === "AUTH_CONFIGURATION_MISSING",
  );
  assert.throws(
    () => new OidcIdentityProviderAdapter({ issuer: "http://issuer.example.com", audience: "client", jwksUri: "https://issuer.example.com/jwks", production: true }).assertConfiguration(),
    (error) => error.code === "AUTH_CONFIGURATION_INVALID",
  );
  assert.throws(
    () => new OidcIdentityProviderAdapter({ issuer: "https://issuer.example.com", audience: "client", jwksUri: "https://issuer.example.com/jwks?x=1", production: false }).assertConfiguration(),
    (error) => error.code === "AUTH_CONFIGURATION_INVALID",
  );
});

test("OIDC adapter verifies issuer, audience and configured email policy", async () => {
  const keyCalls = [];
  const verifyCalls = [];
  const adapter = new OidcIdentityProviderAdapter({
    issuer: "https://login.example.com/oidc",
    audience: "stardraw-web",
    jwksUri: "https://login.example.com/oidc/jwks",
    production: true,
    emailAllowlist: "example.com,*.trusted.example",
    requireVerifiedEmail: true,
    jwtLibrary: {
      decode: () => ({ header: { kid: "key-1" } }),
      verify: (token, key, options) => {
        verifyCalls.push({ token, key, options });
        return { sub: "oidc-user", email: "User@Example.com", email_verified: true };
      },
    },
    jwksClientFactory: fakeJwks(keyCalls),
  });

  assert.deepEqual(await adapter.verifyAccessToken("signed-token"), {
    sub: "oidc-user",
    email: "User@Example.com",
    email_verified: true,
  });
  assert.deepEqual(adapter.getIdentityMetadata(), {
    provider: "oidc",
    issuer: "https://login.example.com/oidc",
  });
  assert.deepEqual(keyCalls, ["key-1"]);
  assert.deepEqual(verifyCalls[0], {
    token: "signed-token",
    key: "public-key",
    options: {
      algorithms: ["RS256"],
      audience: "stardraw-web",
      issuer: "https://login.example.com/oidc",
    },
  });
});

test("email policy handles exact and subdomain rules and fails closed", () => {
  assert.equal(hasVerifiedEmailClaim({ email: "user@example.com", email_verified: true }), true);
  assert.equal(emailDomain("User@Sub.Trusted.Example"), "sub.trusted.example");
  assert.doesNotThrow(() => assertEmailPolicy(
    { email: "user@example.com", email_verified: true },
    { requireVerifiedEmail: true, allowlist: ["example.com"] },
  ));
  assert.doesNotThrow(() => assertEmailPolicy(
    { email: "user@sub.trusted.example", email_verified: true },
    { allowlist: ["*.trusted.example"] },
  ));
  assert.throws(
    () => assertEmailPolicy({ email: "user@other.example", email_verified: true }, { allowlist: ["example.com"] }),
    (error) => error.code === "EMAIL_DOMAIN_NOT_ALLOWED" && error.status === 403,
  );
  assert.throws(
    () => assertEmailPolicy({ email: "user@example.com", email_verified: false }, { requireVerifiedEmail: true }),
    (error) => error.code === "EMAIL_VERIFICATION_REQUIRED" && error.status === 403,
  );
});

