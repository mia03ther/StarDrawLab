import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

globalThis.__identityHydrationCalls = { profiles: [], syncs: [] };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "hydration-test:logger" };
    if (specifier === "../services/accessControlService.js") return { shortCircuit: true, url: "hydration-test:access" };
    if (specifier === "../services/identityLinkService.js") return { shortCircuit: true, url: "hydration-test:links" };
    if (specifier === "../services/identityAccountService.js") return { shortCircuit: true, url: "hydration-test:account" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "hydration-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { warn() {}, error() {}, info() {} };" };
    }
    if (url === "hydration-test:access") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const ACCOUNT_STATUSES = Object.freeze({ SUSPENDED: "suspended" });
          export const resolveAccessContext = async ({ userId }) => ({
            userId, role: "user", accountStatus: "active", mfaVerified: false,
          });
        `,
      };
    }
    if (url === "hydration-test:links") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const identityLinksEnabled = () => true;
          export const resolveIdentityUserId = async () => "stable-user";
          export const shouldHydrateIdentityProfile = () => true;
          export const syncUserIdentityProfile = async (input) => {
            globalThis.__identityHydrationCalls.syncs.push(input);
          };
        `,
      };
    }
    if (url === "hydration-test:account") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const identityAccountSupported = () => true;
          export const getIdentityProfile = async (input) => {
            globalThis.__identityHydrationCalls.profiles.push(input);
            return { username: "alice", name: "Alice Example", email: "alice@example.com" };
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const composition = await import("../services/identityProviderComposition.js");
const { requireAuth } = await import("../middlewares/auth.js");

const invokeAuth = async () => {
  composition.setIdentityProviderForTests({
    assertConfiguration: () => ({ configured: true }),
    verifyAccessToken: async () => ({ sub: "external-subject", iss: "https://auth.example.test/oidc" }),
    getIdentityMetadata: () => ({ provider: "logto", issuer: "https://auth.example.test/oidc" }),
  });
  let nextCalls = 0;
  const req = { headers: { authorization: "Bearer signed-token" }, ip: "127.0.0.1" };
  const res = {
    status() { return this; },
    json() { return this; },
  };
  await requireAuth()(req, res, () => { nextCalls += 1; });
  return { req, nextCalls };
};

test("auth hydrates the local directory from Logto when JWT omits username", async () => {
  globalThis.__identityHydrationCalls.profiles.length = 0;
  globalThis.__identityHydrationCalls.syncs.length = 0;

  const result = await invokeAuth();

  assert.equal(result.nextCalls, 1);
  assert.deepEqual(globalThis.__identityHydrationCalls.profiles, [{ accessToken: "signed-token" }]);
  assert.equal(globalThis.__identityHydrationCalls.syncs.length, 2);
  assert.equal(globalThis.__identityHydrationCalls.syncs[1].userId, "stable-user");
  assert.equal(globalThis.__identityHydrationCalls.syncs[1].username, "alice");
  assert.equal(globalThis.__identityHydrationCalls.syncs[1].fullName, "Alice Example");
});
