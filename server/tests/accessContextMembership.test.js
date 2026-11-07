import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const queries = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "access-membership-test:db" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "access-membership-test:logger" };
    if (specifier === "./auditService.js") return { shortCircuit: true, url: "access-membership-test:audit" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "access-membership-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const queries = globalThis.__accessMembershipQueries;
          const sql = async (strings, ...values) => {
            const query = strings.join("?").replace(/\\s+/g, " ").trim();
            queries.push({ query, values });
            if (query.startsWith("INSERT INTO user_profiles")) return [];
            if (query.includes("FROM user_profiles")) {
              return [{
                user_id: "paid-user",
                app_role: "user",
                account_status: "active",
                auth_valid_after: new Date(0),
                suspended_at: null,
                suspension_reason: null,
                last_seen_at: new Date(),
                membership_tier: globalThis.__accessMembershipTier,
              }];
            }
            throw new Error("Unexpected SQL in access membership test: " + query);
          };
          export default sql;
        `,
      };
    }
    if (url === "access-membership-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    if (url === "access-membership-test:audit") {
      return { format: "module", shortCircuit: true, source: "export const writeAuditLog = async () => ({});" };
    }
    return nextLoad(url, context);
  },
});

globalThis.__accessMembershipQueries = queries;
globalThis.__accessMembershipTier = "free";
process.env.ROOT_ADMIN_USER_ID = "fixed-root";

const { resolveAccessContext } = await import("../services/accessControlService.js");

test("access context carries paid membership tiers into Agent routes", async (t) => {
  for (const tier of ["pro", "max"]) {
    await t.test(tier, async () => {
      globalThis.__accessMembershipTier = tier;
      const context = await resolveAccessContext({
        userId: "paid-user",
        payload: { iat: Math.floor(Date.now() / 1000) },
      });
      assert.equal(context.membershipTier, tier);
    });
  }

  const profileQuery = queries.find(({ query }) => query.includes("FROM user_profiles"));
  assert.match(profileQuery?.query || "", /user_point_accounts/);
  assert.match(profileQuery?.query || "", /membership_tier/);
});
