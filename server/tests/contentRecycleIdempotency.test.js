import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = {
  mode: "delete",
  operations: [],
  queries: [],
  unsafeQueries: [],
};
globalThis.__contentRecycleIdempotencyTest = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/contentRecycleService.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/db.js", "content-recycle-idempotency-test:db"],
      ["../configs/logger.js", "content-recycle-idempotency-test:logger"],
      ["./objectStorageComposition.js", "content-recycle-idempotency-test:object-storage"],
      ["./auditService.js", "content-recycle-idempotency-test:audit"],
      ["./administratorOperationService.js", "content-recycle-idempotency-test:admin-operation"],
      ["./userOperationService.js", "content-recycle-idempotency-test:user-operation"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "content-recycle-idempotency-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          const sql = () => { throw new Error("Unexpected non-transactional database access"); };
          export default sql;
        `,
      };
    }
    if (url === "content-recycle-idempotency-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    if (url === "content-recycle-idempotency-test:object-storage") {
      return { format: "module", shortCircuit: true, source: "export const getObjectStorage = () => ({ deleteObjectsStrict: async () => {} });" };
    }
    if (url === "content-recycle-idempotency-test:audit") {
      return { format: "module", shortCircuit: true, source: "export const writeAuditLog = async () => ({});" };
    }
    if (url === "content-recycle-idempotency-test:admin-operation") {
      return { format: "module", shortCircuit: true, source: "export const executeAdministratorOperation = async () => ({});" };
    }
    if (url === "content-recycle-idempotency-test:user-operation") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const executeUserOperation = async (operation) => {
            const state = globalThis.__contentRecycleIdempotencyTest;
            state.operations.push({
              userId: operation.userId,
              idempotencyKey: operation.idempotencyKey,
              action: operation.action,
              targetType: operation.targetType,
              targetId: operation.targetId,
              requestPayload: operation.requestPayload,
            });
            return operation.mutate(state.tx);
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const compactSql = (strings) => strings.join("?").replace(/\s+/g, " ").trim();

const tx = async (strings, ...values) => {
  const query = compactSql(strings);
  state.queries.push({ query, values });

  if (query.includes("SELECT COALESCE(membership_tier")) return [{ membership_tier: "pro" }];
  if (query.includes("INSERT INTO content_recycle_entries")) {
    return [{
      id: "91",
      owner_user_id: "user-1",
      resource_type: "canvas",
      resource_id: "canvas-1",
      resource_label: "Storyboard",
      deletion_origin: "user",
      visibility: "user",
      status: "active",
      deleted_at: "2026-08-06T00:00:00.000Z",
      purge_after: "2026-08-20T00:00:00.000Z",
    }];
  }
  if (query.includes("UPDATE content_recycle_notifications")) {
    return [{ id: "7", read_at: "2026-08-06T00:00:00.000Z" }];
  }
  if (query.includes("SELECT * FROM content_recycle_entries")) {
    return [{
      id: "91",
      owner_user_id: "user-1",
      resource_type: "canvas",
      resource_id: "canvas-1",
      resource_snapshot: { id: "canvas-1", user_id: "user-1", title: "Storyboard", canvas_state: { elements: [] } },
      reference_snapshot: { canvases: [] },
      purge_after: "2099-08-20T00:00:00.000Z",
    }];
  }
  if (query.includes("FROM information_schema.columns")) {
    return ["id", "user_id", "title", "canvas_state"].map((column_name) => ({ column_name }));
  }
  if (query.includes("UPDATE content_recycle_entries")) {
    return [{
      id: "91",
      owner_user_id: "user-1",
      resource_type: "canvas",
      resource_id: "canvas-1",
      resource_label: "Storyboard",
      deletion_origin: "user",
      status: "restored",
      restored_at: "2026-08-06T00:00:00.000Z",
    }];
  }
  throw new Error(`Unexpected query in ${state.mode} mode: ${query}`);
};
tx.json = (value) => value;
tx.unsafe = async (query, values) => {
  state.unsafeQueries.push({ query: query.replace(/\s+/g, " ").trim(), values });
  if (query.includes("SELECT to_jsonb(resource_row)")) {
    return [{ snapshot: { id: "canvas-1", user_id: "user-1", title: "Storyboard", canvas_state: { elements: [] } } }];
  }
  if (query.startsWith("DELETE FROM canvases")) return { count: 1 };
  if (query.startsWith("INSERT INTO canvases")) return { count: 1 };
  throw new Error(`Unexpected unsafe query in ${state.mode} mode: ${query}`);
};
state.tx = tx;

const {
  deleteOwnContent,
  markOwnContentNotificationRead,
  restoreOwnContent,
} = await import("../services/contentRecycleService.js");

const reset = (mode) => {
  state.mode = mode;
  state.operations = [];
  state.queries = [];
  state.unsafeQueries = [];
};

test("own-content deletion uses the user operation transaction", async () => {
  reset("delete");
  const result = await deleteOwnContent({
    userId: "user-1",
    resourceType: "canvas",
    resourceId: "canvas-1",
    reason: "No longer needed",
    idempotencyKey: "delete-canvas-0001",
  });

  assert.deepEqual(state.operations, [{
    userId: "user-1",
    idempotencyKey: "delete-canvas-0001",
    action: "content.deleted",
    targetType: "canvas",
    targetId: "canvas-1",
    requestPayload: { resource_type: "canvas", resource_id: "canvas-1", reason: "No longer needed" },
  }]);
  assert.equal(result.mode, "recycle_bin");
  assert.match(state.unsafeQueries[1].query, /^DELETE FROM canvases/);
});

test("own-content restoration uses the user operation transaction", async () => {
  reset("restore");
  const result = await restoreOwnContent({
    userId: "user-1",
    entryId: "91",
    idempotencyKey: "restore-entry-0091",
  });

  assert.equal(state.operations[0].action, "content.restored");
  assert.equal(state.operations[0].targetId, "91");
  assert.equal(result.status, "restored");
  assert.match(state.unsafeQueries[0].query, /^INSERT INTO canvases/);
});

test("notification read state uses the user operation transaction", async () => {
  reset("notification");
  const result = await markOwnContentNotificationRead({
    userId: "user-1",
    notificationId: "7",
    idempotencyKey: "read-notice-0007",
  });

  assert.equal(state.operations[0].action, "content_notification.read");
  assert.equal(state.operations[0].targetId, "7");
  assert.equal(result.id, "7");
});
