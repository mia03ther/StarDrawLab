import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = {
  operation: null,
  release: null,
  deletion: null,
  queries: [],
};
globalThis.__failedCreationDeletionTest = state;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/controllers/userController.js")) {
      return nextResolve(specifier, context);
    }
    const modules = new Map([
      ["../configs/db.js", "failed-creation-test:db"],
      ["archiver", "failed-creation-test:archiver"],
      ["json2csv", "failed-creation-test:json2csv"],
      ["axios", "failed-creation-test:axios"],
      ["../services/objectStorageComposition.js", "failed-creation-test:object-storage"],
      ["../configs/logger.js", "failed-creation-test:logger"],
      ["../services/pointsService.js", "failed-creation-test:points"],
      ["../services/videoStatusService.js", "failed-creation-test:video-status"],
      ["../services/contentRecycleService.js", "failed-creation-test:content-recycle"],
      ["../services/userOperationService.js", "failed-creation-test:user-operation"],
    ]);
    const url = modules.get(specifier);
    return url ? { shortCircuit: true, url } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "failed-creation-test:db") {
      return { format: "module", shortCircuit: true, source: "export default () => { throw new Error('Unexpected database access'); };" };
    }
    if (url === "failed-creation-test:archiver") {
      return { format: "module", shortCircuit: true, source: "export default () => ({});" };
    }
    if (url === "failed-creation-test:json2csv") {
      return { format: "module", shortCircuit: true, source: "export class Parser { parse() { return ''; } }" };
    }
    if (url === "failed-creation-test:axios") {
      return { format: "module", shortCircuit: true, source: "export default {};" };
    }
    if (url === "failed-creation-test:object-storage") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const getObjectStorage = () => ({
            buildObjectKey: () => "test/object",
            deleteObject: async () => {},
            getSignedDownloadUrl: () => "https://assets.invalid/signed",
            uploadBuffer: async () => ({}),
          });
        `,
      };
    }
    if (url === "failed-creation-test:logger") {
      return { format: "module", shortCircuit: true, source: "export default { error() {}, warn() {}, info() {} };" };
    }
    if (url === "failed-creation-test:points") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const releasePoints = async (input) => {
            globalThis.__failedCreationDeletionTest.release = input;
            return { ledger: { held_points_change: -18 } };
          };
        `,
      };
    }
    if (url === "failed-creation-test:video-status") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const needsVideoReconciliation = () => false;
          export const syncVideoCreationStatus = async () => ({});
        `,
      };
    }
    if (url === "failed-creation-test:content-recycle") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const deleteOwnContent = async (input) => {
            globalThis.__failedCreationDeletionTest.deletion = input;
            return { mode: "recycle_bin", entry: { id: "91" } };
          };
        `,
      };
    }
    if (url === "failed-creation-test:user-operation") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const executeUserOperation = async (operation) => {
            const state = globalThis.__failedCreationDeletionTest;
            state.operation = operation;
            return operation.mutate(state.tx);
          };
        `,
      };
    }
    return nextLoad(url, context);
  },
});

const tx = async (strings, ...values) => {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  state.queries.push({ query, values });
  if (query.startsWith("SELECT id, status, charge_status")) {
    return [{
      id: "42",
      status: "failed",
      charge_status: "reserved",
      points_reserved: 18,
      content_object_key: null,
      thumbnail_object_key: null,
      meta_info: {},
    }];
  }
  if (query.startsWith("UPDATE creations")) return [{ id: "42" }];
  throw new Error(`Unexpected query: ${query}`);
};
state.tx = tx;

const { deleteFailedCreation } = await import("../controllers/userController.js");

test("failed creation deletion releases points and deletes content in one transaction", async () => {
  const req = {
    auth: { userId: "user-1" },
    params: { creationId: "42" },
    headers: { "x-idempotency-key": "delete-failed-0042" },
  };
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  await deleteFailedCreation(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.success, true);
  assert.equal(res.payload.deleted_id, "42");
  assert.equal(state.operation.action, "failed_creation.deleted");
  assert.equal(state.operation.idempotencyKey, "delete-failed-0042");
  assert.equal(state.release.tx, tx);
  assert.equal(state.release.amount, 18);
  assert.equal(state.deletion.tx, tx);
  assert.equal(state.deletion.resourceId, "42");
  assert.equal(state.queries.length, 2);
  assert.match(state.queries[0].query, /FOR UPDATE$/);
  assert.match(state.queries[1].query, /charge_status = 'reserved'/);
});
