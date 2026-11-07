import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "rbac-test:db" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "rbac-test:logger" };
    if (specifier === "./auditService.js") return { shortCircuit: true, url: "rbac-test:audit" };
    if (specifier === "../configs/oss.js") return { shortCircuit: true, url: "rbac-test:oss" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "rbac-test:db") return { format: "module", shortCircuit: true, source: "export default function sql() { throw new Error('database access forbidden'); }" };
    if (url === "rbac-test:logger") return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    if (url === "rbac-test:audit") return { format: "module", shortCircuit: true, source: "export const writeAuditLog = async () => ({});" };
    if (url === "rbac-test:oss") return { format: "module", shortCircuit: true, source: "export const deleteObjectsStrict = async () => {};" };
    return nextLoad(url, context);
  },
});

process.env.ROOT_ADMIN_USER_ID = "fixed-root";

const access = await import("../services/accessControlService.js");
const recycle = await import("../services/contentRecycleService.js");
const modelConfiguration = await import("../services/modelConfigurationService.js");
const { requireRoot } = await import("../middlewares/authorize.js");
const { requireAdmin } = await import("../middlewares/requireAdmin.js");

const assertMiddlewarePasses = (middleware, auth) => {
  let nextCalled = false;
  let responseStatus = null;
  let responseBody = null;
  middleware(
    { auth, originalUrl: "/test" },
    {
      status(status) {
        responseStatus = status;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true, JSON.stringify({ responseStatus, responseBody }));
};

test("admin and root role guards do not require MFA", () => {
  assertMiddlewarePasses(requireAdmin(), { userId: "admin-user", role: "admin", mfaVerified: false });
  assertMiddlewarePasses(requireRoot(), { userId: "root-user", role: "root" });
});

test("permission matrix keeps sensitive operations root-only", () => {
  assert.equal(access.hasPermission("root", access.PERMISSIONS.ROLE_MANAGE), true);
  assert.equal(access.hasPermission("root", access.PERMISSIONS.MODEL_MANAGE), true);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.USER_SUSPEND), true);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.TEMPLATE_MANAGE), true);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.INVITATION_MANAGE), true);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.CHARGE_RULE_MANAGE), true);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.ROLE_MANAGE), false);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.MODEL_MANAGE), false);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.POINTS_ADJUST), false);
  assert.equal(access.hasPermission("admin", access.PERMISSIONS.REFUND), false);
  assert.equal(access.hasPermission("user", access.PERMISSIONS.CHARGE_RULE_MANAGE), false);
  assert.equal(access.hasPermission("user", access.PERMISSIONS.USER_READ), false);
});

test("MFA does not accept a single email or SMS factor", () => {
  assert.equal(access.isMfaVerified({ amr: ["sms"] }), false);
  assert.equal(access.isMfaVerified({ amr: ["email"] }), false);
  assert.equal(access.isMfaVerified({ amr: ["sms", "email"] }), false);
  assert.equal(access.isMfaVerified({ amr: ["pwd", "sms"] }), true);
  assert.equal(access.isMfaVerified({ amr: ["totp"] }), true);
  assert.equal(access.isMfaVerified({ acr: "urn:authing:mfa" }), true);
});

test("recent MFA timestamps reject milliseconds, stale values, and unsafe future values", () => {
  const now = Date.UTC(2026, 7, 6, 12, 0, 0);
  const seconds = Math.floor(now / 1000);
  assert.equal(access.resolveMfaVerifiedAt({ auth_time: seconds }, true, now)?.getTime(), now);
  assert.equal(access.resolveMfaVerifiedAt({ auth_time: now }, true, now), null);
  assert.equal(access.resolveMfaVerifiedAt({ auth_time: seconds + 61 }, true, now), null);
  assert.equal(access.isRecentMfaVerification(new Date(now - 10 * 60 * 1000), now), true);
  assert.equal(access.isRecentMfaVerification(new Date(now - 10 * 60 * 1000 - 1), now), false);
  assert.equal(access.isRecentMfaVerification(new Date(now + 60_000), now), true);
  assert.equal(access.isRecentMfaVerification(new Date(now + 60_001), now), false);
});

test("session revocation fails closed without iat and rejects older tokens", () => {
  const validAfter = "2026-08-06T02:00:00.500Z";
  assert.equal(access.sessionTokenIsRevoked({}, validAfter), true);
  assert.equal(access.sessionTokenIsRevoked({ iat: 1785981599 }, validAfter), true);
  assert.equal(access.sessionTokenIsRevoked({ iat: 1785981601 }, validAfter), false);
});

test("fixed root cannot be modified", () => {
  assert.throws(() => access.assertRootTargetMutable("fixed-root"), (error) => error.code === "ROOT_IMMUTABLE" && error.status === 409);
  assert.doesNotThrow(() => access.assertRootTargetMutable("ordinary-user"));
});

test("model route ids accept only positive PostgreSQL BIGINT values", () => {
  assert.equal(modelConfiguration.normalizeModelRouteId("42"), "42");
  for (const invalid of ["", "0", "-1", "1.0", "1 OR 1=1", "9223372036854775808"]) {
    assert.throws(
      () => modelConfiguration.normalizeModelRouteId(invalid),
      (error) => error.code === "INVALID_MODEL_ROUTE_ID" && error.status === 400,
    );
  }
});

test("content deletion policy matches free, member and administrator rules", () => {
  assert.deepEqual(recycle.resolveContentDeletionPolicy({ deletionOrigin: "user", membershipTier: "free" }), {
    mode: "hard_delete", visibility: null, retention_days: 0,
  });
  assert.deepEqual(recycle.resolveContentDeletionPolicy({ deletionOrigin: "user", membershipTier: "pro" }), {
    mode: "recycle_bin", visibility: "user", retention_days: 14,
  });
  assert.deepEqual(recycle.resolveContentDeletionPolicy({ deletionOrigin: "admin", membershipTier: "free" }), {
    mode: "recycle_bin", visibility: "admin_only", retention_days: 14,
  });
});

test("administrator content management cannot target admin or root owners", () => {
  assert.equal(recycle.canManageContentOwner({ actorRole: "admin", ownerRole: "user" }), true);
  assert.equal(recycle.canManageContentOwner({ actorRole: "admin", ownerRole: "admin" }), false);
  assert.equal(recycle.canManageContentOwner({ actorRole: "admin", ownerRole: "root" }), false);
  assert.equal(recycle.canManageContentOwner({ actorRole: "root", ownerRole: "user" }), true);
  assert.equal(recycle.canManageContentOwner({ actorRole: "root", ownerRole: "admin" }), true);
  assert.equal(recycle.canManageContentOwner({ actorRole: "root", ownerRole: "root" }), true);
});
