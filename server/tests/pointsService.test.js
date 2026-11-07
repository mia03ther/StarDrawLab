import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "points-test:db" };
    if (specifier === "../configs/logger.js") return { shortCircuit: true, url: "points-test:logger" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "points-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default function sql() { throw new Error('database access must not occur for invalid amounts'); }",
      };
    }
    if (url === "points-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    return nextLoad(url, context);
  },
});

const points = await import("../services/pointsService.js");

test("additional reservations extend an existing source allocation by the delta", () => {
  assert.equal(points.getReservationTargetAmount({ existingAmount: 1, requestedAmount: 2, additionalAmount: true }), 3);
  assert.equal(points.getReservationTargetAmount({ existingAmount: 1, requestedAmount: 2, additionalAmount: false }), 2);
});

test("point reservation rejects zero, negative, fractional and unsafe amounts before database access", async () => {
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0"]) {
    await assert.rejects(
      points.reservePoints({ userId: "user-1", amount, creationId: 1, idempotencyKey: "reserve:test" }),
      (error) => error.code === "INVALID_POINT_AMOUNT" && error.status === 503,
    );
  }
});

test("point charge rejects non-positive amounts before database access", async () => {
  for (const amount of [0, -10, "-1"]) {
    await assert.rejects(
      points.chargePoints({ userId: "user-1", amount, creationId: 1, idempotencyKey: "charge:test" }),
      (error) => error.code === "INVALID_POINT_AMOUNT" && error.status === 503,
    );
  }
});

test("point release rejects negative, fractional and unsafe amounts before database access", async () => {
  for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    await assert.rejects(
      points.releasePoints({ userId: "user-1", amount, creationId: 1, idempotencyKey: "release:test" }),
      (error) => error.code === "INVALID_POINT_AMOUNT" && error.status === 503,
    );
  }
});

test("point operations reject an invalid generic source before database access", async () => {
  await assert.rejects(
    points.reservePoints({
      userId: "user-1",
      amount: 1,
      sourceType: "Invalid Source",
      sourceId: "operation-1",
      idempotencyKey: "reserve:agent:test",
    }),
    (error) => error.code === "INVALID_POINT_SOURCE" && error.status === 503,
  );
});
