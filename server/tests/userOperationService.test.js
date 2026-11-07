import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const createFakeDatabase = () => {
  const rows = new Map();
  let nextId = 1;

  const tx = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.startsWith("INSERT INTO user_operations")) {
      const [userId, idempotencyKey, action, targetType, targetId, requestHash] = values;
      const uniqueKey = `${userId}\u0000${idempotencyKey}`;
      if (rows.has(uniqueKey)) return [];
      const row = {
        id: nextId++,
        user_id: userId,
        idempotency_key: idempotencyKey,
        action,
        target_type: targetType,
        target_id: targetId,
        request_hash: requestHash,
        status: "claimed",
        response_snapshot: null,
      };
      rows.set(uniqueKey, row);
      return [{ id: row.id }];
    }
    if (query.startsWith("SELECT id, action, target_type")) {
      const [userId, idempotencyKey] = values;
      const row = rows.get(`${userId}\u0000${idempotencyKey}`);
      return row ? [{ ...row }] : [];
    }
    if (query.startsWith("UPDATE user_operations")) {
      const [snapshot, id] = values;
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (!row || row.status !== "claimed") return [];
      row.status = "completed";
      row.response_snapshot = structuredClone(snapshot);
      return [{ response_snapshot: structuredClone(row.response_snapshot) }];
    }
    throw new Error(`Unexpected query: ${query}`);
  };
  tx.json = (value) => structuredClone(value);

  const db = () => { throw new Error("Queries must run in a transaction"); };
  db.begin = async (callback) => {
    const snapshot = structuredClone([...rows.entries()]);
    const previousNextId = nextId;
    try {
      return await callback(tx);
    } catch (error) {
      rows.clear();
      for (const [key, row] of snapshot) rows.set(key, row);
      nextId = previousNextId;
      throw error;
    }
  };
  db.rows = rows;
  return db;
};

globalThis.__userOperationTestDb = createFakeDatabase();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js" && context.parentURL?.endsWith("/services/userOperationService.js")) {
      return { shortCircuit: true, url: "user-operation-test:db" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "user-operation-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default globalThis.__userOperationTestDb;",
      };
    }
    return nextLoad(url, context);
  },
});

const {
  executeUserOperation,
  hashUserOperationRequest,
  normalizeUserIdempotencyKey,
} = await import("../services/userOperationService.js");

const operation = (overrides = {}) => ({
  userId: "user-1",
  idempotencyKey: "user-operation-0001",
  action: "template.updated",
  targetType: "prompt_template",
  targetId: "42",
  requestPayload: { title: "Storyboard" },
  mutate: async () => ({ id: 42, title: "Storyboard" }),
  ...overrides,
});

test("user operation keys and request hashes are strict and canonical", () => {
  assert.equal(normalizeUserIdempotencyKey("request-1234"), "request-1234");
  assert.throws(
    () => normalizeUserIdempotencyKey("short"),
    (error) => error.status === 400 && error.code === "INVALID_IDEMPOTENCY_KEY",
  );
  assert.equal(
    hashUserOperationRequest({ nested: { b: 2, a: 1 } }),
    hashUserOperationRequest({ nested: { a: 1, b: 2 } }),
  );
});

test("completed user operations replay without repeating the mutation", async () => {
  let mutations = 0;
  const request = operation({
    mutate: async () => {
      mutations += 1;
      return { id: 42, title: "Storyboard" };
    },
  });
  const first = await executeUserOperation(request);
  const replay = await executeUserOperation({
    ...request,
    mutate: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(replay, first);
  assert.equal(mutations, 1);
});

test("user operation snapshots remain objects and legacy JSON strings replay as objects", async () => {
  const key = "user-operation-json-snapshot";
  const first = await executeUserOperation(operation({ idempotencyKey: key }));
  const row = globalThis.__userOperationTestDb.rows.get(`user-1\u0000${key}`);

  assert.equal(typeof row.response_snapshot, "object");
  row.response_snapshot = JSON.stringify(row.response_snapshot);

  const replay = await executeUserOperation(operation({
    idempotencyKey: key,
    mutate: async () => { throw new Error("must not run"); },
  }));
  assert.deepEqual(replay, first);
});

test("reusing a user operation key with another payload fails", async () => {
  const key = "user-operation-conflict";
  await executeUserOperation(operation({ idempotencyKey: key }));
  await assert.rejects(
    executeUserOperation(operation({ idempotencyKey: key, requestPayload: { title: "Other" } })),
    (error) => error.status === 409 && error.code === "IDEMPOTENCY_KEY_REUSED",
  );
});

test("failed user operations roll back their claim and can be retried", async () => {
  const key = "user-operation-retry";
  await assert.rejects(executeUserOperation(operation({
    idempotencyKey: key,
    mutate: async () => { throw new Error("temporary failure"); },
  })), /temporary failure/);
  const retried = await executeUserOperation(operation({ idempotencyKey: key }));
  assert.equal(retried.id, 42);
});
