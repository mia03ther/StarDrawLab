import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const createFakeDatabase = () => {
  const rows = new Map();
  const events = [];
  let nextId = 1;

  const tx = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();

    if (query.startsWith("INSERT INTO administrator_operations")) {
      const [actorUserId, actorRole, idempotencyKey, action, targetType, targetId, requestHash] = values;
      const uniqueKey = `${actorUserId}\u0000${idempotencyKey}`;
      events.push("claim");
      if (rows.has(uniqueKey)) return [];
      const row = {
        id: nextId,
        actor_user_id: actorUserId,
        actor_role: actorRole,
        idempotency_key: idempotencyKey,
        action,
        target_type: targetType,
        target_id: targetId,
        request_hash: requestHash,
        status: "claimed",
        response_snapshot: null,
      };
      nextId += 1;
      rows.set(uniqueKey, row);
      return [{ id: row.id }];
    }

    if (query.startsWith("SELECT id, action, target_type")) {
      const [actorUserId, idempotencyKey] = values;
      events.push("load");
      const row = rows.get(`${actorUserId}\u0000${idempotencyKey}`);
      return row ? [{ ...row }] : [];
    }

    if (query.startsWith("UPDATE administrator_operations")) {
      const [snapshot, operationId] = values;
      events.push("complete");
      const row = [...rows.values()].find((candidate) => candidate.id === operationId);
      if (!row || row.status !== "claimed") return [];
      row.status = "completed";
      row.response_snapshot = structuredClone(snapshot);
      return [{ response_snapshot: structuredClone(row.response_snapshot) }];
    }

    throw new Error(`Unexpected test query: ${query}`);
  };
  tx.json = (value) => structuredClone(value);

  const database = () => {
    throw new Error("Queries must run inside a transaction");
  };
  database.begin = async (callback) => {
    const beforeRows = structuredClone([...rows.entries()]);
    const beforeNextId = nextId;
    events.push("begin");
    try {
      const result = await callback(tx);
      events.push("commit");
      return result;
    } catch (error) {
      rows.clear();
      for (const [key, row] of beforeRows) rows.set(key, row);
      nextId = beforeNextId;
      events.push("rollback");
      throw error;
    }
  };
  database.events = events;
  database.rows = rows;
  return database;
};

globalThis.__administratorOperationTestDb = createFakeDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "../configs/db.js"
      && context.parentURL?.endsWith("/services/administratorOperationService.js")
    ) {
      return { shortCircuit: true, url: "administrator-operation-test:db" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "administrator-operation-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default globalThis.__administratorOperationTestDb;",
      };
    }
    return nextLoad(url, context);
  },
});

const {
  executeAdministratorOperation,
  hashAdministratorRequest,
  normalizeAdministratorIdempotencyKey,
  normalizeAdministratorReason,
} = await import("../services/administratorOperationService.js");

const actor = { userId: "root-user", role: "root" };
const operation = (overrides = {}) => ({
  actor,
  idempotencyKey: "admin-op-00000001",
  action: "user.role_changed",
  targetType: "user",
  targetId: "target-user",
  requestPayload: { role: "admin", reason: "Operational need" },
  mutate: async () => ({ user_id: "target-user", app_role: "admin" }),
  ...overrides,
});

test("validates administrator idempotency keys and reasons strictly", () => {
  assert.equal(normalizeAdministratorIdempotencyKey("request-1234"), "request-1234");
  for (const invalid of ["", "short", "spaces are invalid", "bad/key", `x${"a".repeat(128)}`]) {
    assert.throws(
      () => normalizeAdministratorIdempotencyKey(invalid),
      (error) => error.status === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
    );
  }

  assert.equal(normalizeAdministratorReason("  approved by support  "), "approved by support");
  assert.throws(
    () => normalizeAdministratorReason("  "),
    (error) => error.status === 400 && error.code === "REASON_REQUIRED",
  );
  assert.throws(
    () => normalizeAdministratorReason(`unsafe\u0000reason`),
    (error) => error.status === 400 && error.code === "INVALID_REASON",
  );
  assert.throws(
    () => normalizeAdministratorReason("x".repeat(2001)),
    (error) => error.status === 400 && error.code === "INVALID_REASON",
  );
});

test("request hashes are stable across object key order and change with payload", () => {
  const first = hashAdministratorRequest({ reason: "approved", role: "admin", nested: { b: 2, a: 1 } });
  const reordered = hashAdministratorRequest({ nested: { a: 1, b: 2 }, role: "admin", reason: "approved" });
  const changed = hashAdministratorRequest({ reason: "different", role: "admin", nested: { a: 1, b: 2 } });
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("completed operations replay the original snapshot without repeating mutation or audit", async () => {
  let mutationCount = 0;
  let auditCount = 0;
  const request = operation({
    mutate: async () => {
      globalThis.__administratorOperationTestDb.events.push("state-change");
      mutationCount += 1;
      globalThis.__administratorOperationTestDb.events.push("audit");
      auditCount += 1;
      return { user_id: "target-user", app_role: "admin", version: 2 };
    },
  });

  const first = await executeAdministratorOperation(request);
  const replay = await executeAdministratorOperation({
    ...request,
    mutate: async () => {
      throw new Error("replay must not invoke mutation");
    },
  });

  assert.deepEqual(first, { user_id: "target-user", app_role: "admin", version: 2 });
  assert.deepEqual(replay, first);
  assert.equal(mutationCount, 1);
  assert.equal(auditCount, 1);
  assert.deepEqual(globalThis.__administratorOperationTestDb.events.slice(0, 6), [
    "begin",
    "claim",
    "state-change",
    "audit",
    "complete",
    "commit",
  ]);
});

test("the same actor and key with a different payload fails with 409", async () => {
  const key = "admin-op-conflict-01";
  await executeAdministratorOperation(operation({ idempotencyKey: key }));

  await assert.rejects(
    executeAdministratorOperation(operation({
      idempotencyKey: key,
      requestPayload: { role: "user", reason: "Different request" },
    })),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("action and target are part of idempotency conflict detection", async () => {
  const key = "admin-op-target-0001";
  await executeAdministratorOperation(operation({ idempotencyKey: key }));

  await assert.rejects(
    executeAdministratorOperation(operation({ idempotencyKey: key, targetId: "another-user" })),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("a failed mutation rolls back the claim and permits a safe retry", async () => {
  const key = "admin-op-rollback-01";
  await assert.rejects(
    executeAdministratorOperation(operation({
      idempotencyKey: key,
      mutate: async () => {
        throw Object.assign(new Error("permission state changed concurrently"), { status: 409 });
      },
    })),
    /permission state changed concurrently/,
  );

  const result = await executeAdministratorOperation(operation({ idempotencyKey: key }));
  assert.equal(result.app_role, "admin");
  assert.ok(globalThis.__administratorOperationTestDb.events.includes("rollback"));
});

test("idempotency keys are isolated by actor user id", async () => {
  const key = "admin-op-actor-00001";
  const first = await executeAdministratorOperation(operation({ idempotencyKey: key }));
  const second = await executeAdministratorOperation(operation({
    actor: { userId: "another-root", role: "root" },
    idempotencyKey: key,
    mutate: async () => ({ user_id: "target-user", app_role: "user" }),
  }));
  assert.equal(first.app_role, "admin");
  assert.equal(second.app_role, "user");
});
