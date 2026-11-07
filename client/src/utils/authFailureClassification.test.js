import assert from "node:assert/strict";
import test from "node:test";
import { shouldInvalidateSession } from "./authFailureClassification.js";

test("identity account permission failure does not invalidate the StarDraw session", () => {
  assert.equal(shouldInvalidateSession({ status: 401, code: "IDENTITY_ACCOUNT_UNAUTHORIZED" }), false);
  assert.equal(shouldInvalidateSession({ status: 401, code: "IDENTITY_ACCOUNT_TOKEN_MISSING" }), false);
  assert.equal(shouldInvalidateSession({ status: 403, code: "IDENTITY_ACCOUNT_FORBIDDEN" }), false);
});

test("authentication failures still invalidate the StarDraw session", () => {
  assert.equal(shouldInvalidateSession({ status: 401, code: "TOKEN_EXPIRED" }), true);
  assert.equal(shouldInvalidateSession({ status: 401, code: "INVALID_TOKEN" }), true);
  assert.equal(shouldInvalidateSession({ status: 403, code: "SESSION_REVOKED" }), true);
});
