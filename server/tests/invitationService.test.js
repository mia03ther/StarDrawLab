import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "invitation-test:db" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "invitation-test:logger" };
    if (specifier === "./pointsService.js") return { shortCircuit: true, url: "invitation-test:points" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "invitation-test:db") return { format: "module", shortCircuit: true, source: "export default function sql() { throw new Error('database access forbidden'); }" };
    if (url === "invitation-test:logger") return { format: "module", shortCircuit: true, source: "export default { info() {}, warn() {}, error() {} };" };
    if (url === "invitation-test:points") return { format: "module", shortCircuit: true, source: "export const rechargePoints = async () => { throw new Error('point access forbidden'); };" };
    return nextLoad(url, context);
  },
});

const invitations = await import("../services/invitationService.js");

test("invitation codes are normalized and reject unsafe values", () => {
  assert.equal(invitations.normalizeInvitationCode(" ab12cd34 "), "AB12CD34");
  for (const value of ["", "short", "A/B/C", "abc_1234", "a".repeat(33)]) {
    assert.throws(
      () => invitations.normalizeInvitationCode(value),
      (error) => error.code === "INVALID_INVITATION_CODE" && error.status === 400,
    );
  }
});

test("invitation settings accept bounded values and partial updates", () => {
  assert.deepEqual(invitations.normalizeInvitationSettings({
    inviter_reward_points: "80",
    invitee_reward_points: 120,
    reward_validity_days: 0,
    is_enabled: "false",
  }), {
    inviter_reward_points: 80,
    invitee_reward_points: 120,
    reward_validity_days: 0,
    is_enabled: false,
  });
  assert.deepEqual(invitations.normalizeInvitationSettings({ invitee_reward_points: 240 }, {
    inviter_reward_points: 100,
    invitee_reward_points: 100,
    reward_validity_days: 30,
    is_enabled: true,
  }), {
    inviter_reward_points: 100,
    invitee_reward_points: 240,
    reward_validity_days: 30,
    is_enabled: true,
  });
  for (const input of [
    { inviter_reward_points: -1 },
    { invitee_reward_points: 1.5 },
    { reward_validity_days: 3651 },
    { is_enabled: "maybe" },
  ]) {
    assert.throws(
      () => invitations.normalizeInvitationSettings(input),
      (error) => error.code === "INVALID_INVITATION_SETTINGS" && error.status === 400,
    );
  }
});
