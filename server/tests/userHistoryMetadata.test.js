import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { rows: [], queries: [], errors: [] };
globalThis.__historyMetadataTest = state;
state.sql = async (strings, ...values) => {
  const query = strings.join("?").replace(/\s+/g, " ").trim();
  state.queries.push({ query, values });
  if (!query.startsWith("SELECT ") || !query.includes(" FROM creations WHERE user_id = ?")) {
    throw new Error(`Unexpected or unscoped database access: ${query}`);
  }
  if (query.startsWith("SELECT COUNT(*)")) return [{ total: state.rows.length }];
  return state.rows.map((row) => ({ ...row }));
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/controllers/userController.js")) return nextResolve(specifier, context);
    const modules = new Map([
      ["../configs/db.js", "db"], ["archiver", "archiver"], ["json2csv", "json2csv"],
      ["axios", "axios"], ["../services/objectStorageComposition.js", "storage"],
      ["../configs/logger.js", "logger"], ["../services/pointsService.js", "points"],
      ["../services/videoStatusService.js", "video"], ["../services/contentRecycleService.js", "recycle"],
      ["../services/userOperationService.js", "operation"],
    ]);
    return modules.has(specifier) ? { shortCircuit: true, url: `history-metadata-test:${modules.get(specifier)}` } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("history-metadata-test:")) return nextLoad(url, context);
    const modules = {
      db: "export default globalThis.__historyMetadataTest.sql;",
      archiver: "export default () => { throw new Error('Unexpected archive access'); };",
      json2csv: "export class Parser {}",
      axios: "export default {};",
      storage: "export const getObjectStorage = () => new Proxy({}, { get() { throw new Error('History listing must not access OSS'); } });",
      logger: "export default { error(...args) { globalThis.__historyMetadataTest.errors.push(args); } };",
      points: "export const releasePoints = () => { throw new Error('History listing must not change points'); };",
      video: "export const needsVideoReconciliation = () => false; export const syncVideoCreationStatus = () => { throw new Error('Unexpected reconciliation'); };",
      recycle: "export const deleteOwnContent = () => { throw new Error('History listing must not delete content'); };",
      operation: "export const executeUserOperation = () => { throw new Error('History listing must not mutate data'); };",
    };
    return { shortCircuit: true, format: "module", source: modules[url.split(":")[1]] };
  },
});

const { getUserCreations } = await import("../controllers/userController.js");
const rowWithMeta = (meta_info, id = "42") => ({
  id, type: "image", scene_name: "Existing creation", status: "completed", content: `/oss-proxy/quickai/user-1/${id}.png`,
  thumbnail_url: null, meta_info, community_status: "public", community_hidden: false, community_visual_parameters: null,
});
async function list(rows, query = {}) {
  state.rows = rows; state.queries = []; state.errors = [];
  const req = { auth: { userId: "user-1" }, query };
  const res = { statusCode: 200, payload: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  await getUserCreations(req, res);
  return res;
}

test("legacy null and scalar metadata cannot make existing history disappear with a 500", async () => {
  for (const metadata of [null, "null", '"null"', "false", "0", "[]", '"plain text"', "{broken", [], true]) {
    const res = await list([rowWithMeta(metadata)]);
    assert.equal(res.statusCode, 200, `metadata ${JSON.stringify(metadata)} must not reject history`);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.total, 1);
    assert.equal(res.payload.creations[0].id, "42");
    assert.equal(res.payload.creations[0].preview_image_url, "/oss-proxy/quickai/user-1/42.png");
    assert.deepEqual(res.payload.creations[0].visual_parameters, {});
    assert.equal(state.errors.length, 0);
  }
});

test("object and historically encoded object metadata preserve valid previews and visual parameters", async () => {
  const metadata = {
    reference_image_object_key: "quickai/user-1/reference.png",
    providerRaw: { result: { preview_video_url: "/oss-proxy/quickai/user-1/preview.mp4" } },
    visual_parameters: { style: "ink" },
  };
  for (const value of [metadata, JSON.stringify(metadata), JSON.stringify(JSON.stringify(metadata))]) {
    const res = await list([rowWithMeta(value)]);
    assert.equal(res.statusCode, 200);
    const row = res.payload.creations[0];
    assert.equal(row.reference_preview_url, "/oss-proxy/quickai/user-1/reference.png");
    assert.equal(row.preview_video_url, "/oss-proxy/quickai/user-1/preview.mp4");
    assert.deepEqual(row.visual_parameters, { style: "ink" });
    assert.equal(row.published, true);
    assert.ok(!Object.hasOwn(row, "meta_info"));
  }
});

test("one bad metadata row does not hide other creations or alter ownership and pagination", async () => {
  const res = await list([rowWithMeta("null"), rowWithMeta({ visualParameters: { ratio: "16:9" } }, "43")], { page: "2", page_size: "12", type: "image", status: "completed" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.creations.map((row) => row.id), ["42", "43"]);
  assert.deepEqual(res.payload.creations[1].visual_parameters, { ratio: "16:9" });
  assert.equal(res.payload.page, 2);
  assert.equal(res.payload.page_size, 12);
  assert.equal(state.queries.length, 2);
  for (const { query, values } of state.queries) {
    assert.match(query, /WHERE user_id = \?/);
    assert.equal(values[0], "user-1");
    assert.deepEqual(values.slice(1, 5), ["image", "image", "completed", "completed"]);
    assert.doesNotMatch(query, /\b(?:UPDATE|DELETE|INSERT)\b/);
  }
  assert.deepEqual(state.queries[0].values.slice(-2), [12, 12]);
});

test("excessive encoding depth is safely ignored without recursive parsing or lost history", async () => {
  let metadata = { visual_parameters: { hidden: true } };
  for (let index = 0; index < 12; index++) metadata = JSON.stringify(metadata);
  const res = await list([rowWithMeta(metadata)]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.total, 1);
  assert.deepEqual(res.payload.creations[0].visual_parameters, {});
});
