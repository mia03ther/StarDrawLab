import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = {};
globalThis.__videoPersistenceTest = state;

const compile = (strings) => strings.reduce((text, part, index) => text + (index ? `$${index - 1}` : "") + part, "").replace(/\s+/g, " ").trim();
const sql = (strings, ...values) => {
  const query = compile(strings);
  if (query.startsWith("( CASE")) return { meta: values[0] };
  state.queries.push(query);
  if (query.startsWith("SELECT *")) {
    if (query.includes("FOR UPDATE")) state.beforeLock?.();
    return Promise.resolve(state.row ? [{ ...state.row }] : []);
  }
  if (!query.startsWith("UPDATE creations")) throw new Error(`Unexpected query: ${query}`);
  if (query.includes("AND charge_status = 'reserved'") && state.row.charge_status !== "reserved") return Promise.resolve([]);
  const assignments = query.slice(query.indexOf(" SET ") + 5, query.indexOf(" WHERE "));
  for (const column of ["status", "provider_status", "content", "content_object_key", "thumbnail_url", "thumbnail_object_key", "charge_status", "points_cost", "points_reserved", "error_message", "meta_info"]) {
    const valueMatch = assignments.match(new RegExp(`\\b${column} = (COALESCE\\()?\\$(\\d+)`));
    if (valueMatch) {
      const value = values[Number(valueMatch[2])];
      if (!valueMatch[1] || value != null) state.row[column] = column === "meta_info" ? value.meta : value;
      continue;
    }
    const literalMatch = assignments.match(new RegExp(`\\b${column} = ('[^']*'|NULL|0)(?:,|$)`));
    if (literalMatch) {
      const literal = literalMatch[1];
      state.row[column] = literal === "NULL" ? null : literal === "0" ? 0 : literal.slice(1, -1);
    }
  }
  return Promise.resolve([{ ...state.row }]);
};
sql.json = value => value;
sql.begin = async operation => {
  const before = { ...state.row };
  try { return await operation(sql); } catch (error) { state.row = before; throw error; }
};
state.sql = sql;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/services/videoStatusService.js")) return nextResolve(specifier, context);
    const names = new Map([
      ["../configs/db.js", "db"], ["./objectStorageComposition.js", "storage"],
      ["./pointsService.js", "points"], ["../configs/logger.js", "logger"],
      ["./contentRecycleService.js", "cleanup"], ["./mediaGenerationComposition.js", "provider"],
    ]);
    return names.has(specifier) ? { shortCircuit: true, url: `video-persistence-test:${names.get(specifier)}` } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("video-persistence-test:")) return nextLoad(url, context);
    const sources = {
      db: "export default globalThis.__videoPersistenceTest.sql;",
      storage: `export const getObjectStorage = () => ({
        buildObjectKey: () => 'quickai/user-1/new-video.mp4',
        uploadFromUrl: async (...args) => { const s = globalThis.__videoPersistenceTest; s.uploads.push(args); if(s.uploadError) throw s.uploadError; return {objectKey:args[1],url:'/oss-proxy/'+args[1]}; },
        getObjectMetadata: async key => { const s=globalThis.__videoPersistenceTest; s.checks.push(key); const plan=s.metadata.get(key); const result=Array.isArray(plan)?plan.shift():plan; if(result instanceof Error) throw result; return result || {exists:true,sizeBytes:1024,contentType:'video/mp4'}; }
      });`,
      points: `export const chargePoints = async input => { const s=globalThis.__videoPersistenceTest; if(s.chargeError) throw s.chargeError; s.charges.push(input); };
        export const releasePoints = async input => { globalThis.__videoPersistenceTest.releases.push(input); };`,
      logger: "export default {warn(){},error(){}};",
      cleanup: "export const cleanupUnreferencedObjects=async input=>{globalThis.__videoPersistenceTest.cleanups.push(input)};",
      provider: "export const getVideoGenerationProvider=()=>({check:async()=>globalThis.__videoPersistenceTest.provider});",
    };
    return { format: "module", shortCircuit: true, source: sources[url.split(":")[1]] };
  },
});

const { syncVideoCreationStatus } = await import("../services/videoStatusService.js");
const valid = { exists: true, sizeBytes: 1024, contentType: "video/mp4" };
function reset(overrides = {}) {
  state.row = { id: "42", user_id: "user-1", type: "video", task_id: "task-42", status: "running", charge_status: "reserved", points_reserved: 18, scene_name: "Video", content: null, content_object_key: null, thumbnail_url: null, thumbnail_object_key: null, ...overrides };
  state.provider = { success: true, status: "completed", url: "https://provider.invalid/video.mp4", raw: {} };
  state.metadata = new Map();
  state.queries = []; state.checks = []; state.uploads = []; state.charges = []; state.releases = []; state.cleanups = [];
  state.beforeLock = null; state.uploadError = null; state.chargeError = null;
}
const run = () => syncVideoCreationStatus({ ...state.row });

test("video completion verifies stored bytes before charging, and repeated sync does not charge twice", async () => {
  reset();
  const result = await run();
  assert.equal(result.creation.status, "completed");
  assert.equal(result.creation.charge_status, "charged");
  assert.equal(result.creation.points_reserved, 0);
  assert.equal(result.progress, 100);
  assert.deepEqual(state.checks, ["quickai/user-1/new-video.mp4"]);
  assert.equal(state.charges.length, 1);
  assert.equal(state.charges[0].amount, 18);
  assert.equal(state.charges[0].idempotencyKey, "charge:creation:42");
  await run();
  assert.equal(state.charges.length, 1);
  assert.equal(state.uploads.length, 1);
});

test("an empty or unverified uploaded video stays running without charge or refund", async () => {
  for (const metadata of [{ ...valid, sizeBytes: 0 }, { ...valid, sizeBytes: null }, { ...valid, contentType: "text/html" }]) {
    reset();
    state.metadata.set("quickai/user-1/new-video.mp4", metadata);
    const result = await run();
    assert.equal(result.creation.status, "running");
    assert.equal(result.creation.charge_status, "reserved");
    assert.equal(result.creation.points_reserved, 18);
    assert.equal(result.progress, 90);
    assert.equal(state.charges.length, 0);
    assert.equal(state.releases.length, 0);
    assert.equal(result.creation.meta_info.syncError.stage, "oss_verify");
  }
});

test("a metadata timeout after upload retains its candidate for retry without uploading again", async () => {
  reset();
  state.metadata.set("quickai/user-1/new-video.mp4", [Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), valid]);
  assert.equal((await run()).creation.status, "running");
  assert.equal(state.row.content_object_key, "quickai/user-1/new-video.mp4");
  assert.equal(state.charges.length, 0);
  assert.equal(state.releases.length, 0);
  assert.equal((await run()).creation.status, "completed");
  assert.equal(state.uploads.length, 1);
  assert.equal(state.charges.length, 1);
});

test("a confirmed missing or empty existing video is repaired from the provider URL before charging", async () => {
  for (const metadata of [{ exists: false, sizeBytes: null }, { ...valid, sizeBytes: 0 }]) {
    reset({ content_object_key: "old.mp4", content: "/oss-proxy/old.mp4" });
    state.metadata.set("old.mp4", metadata);
    const result = await run();
    assert.equal(result.creation.status, "completed");
    assert.equal(result.creation.content_object_key, "quickai/user-1/new-video.mp4");
    assert.deepEqual(state.checks, ["old.mp4", "quickai/user-1/new-video.mp4"]);
    assert.equal(state.uploads.length, 1);
    assert.equal(state.charges.length, 1);
  }
});

test("permission and temporary metadata errors on an existing object do not cause upload, charge or refund", async () => {
  for (const status of [403, 503]) {
    reset({ content_object_key: "old.mp4", content: "/oss-proxy/old.mp4" });
    state.metadata.set("old.mp4", Object.assign(new Error("metadata unavailable"), { status }));
    const result = await run();
    assert.equal(result.creation.status, "running");
    assert.equal(result.creation.charge_status, "reserved");
    assert.equal(state.uploads.length, 0);
    assert.equal(state.charges.length, 0);
    assert.equal(state.releases.length, 0);
  }
});

test("an unknown size on an existing object stays retryable without replacing it", async () => {
  reset({ content_object_key: "old.mp4", content: "/oss-proxy/old.mp4" });
  state.metadata.set("old.mp4", { ...valid, sizeBytes: null });
  const result = await run();
  assert.equal(result.creation.status, "running");
  assert.equal(result.creation.content_object_key, "old.mp4");
  assert.equal(state.uploads.length, 0);
  assert.equal(state.charges.length, 0);
  assert.equal(state.releases.length, 0);
});

test("a provider proxy path must resolve to a nonempty video, not merely look durable", async () => {
  reset();
  state.provider.url = "/oss-proxy/provider-video.mp4";
  state.metadata.set("provider-video.mp4", { exists: false, sizeBytes: null });
  const missing = await run();
  assert.equal(missing.creation.status, "running");
  assert.equal(state.uploads.length, 0);
  assert.equal(state.charges.length, 0);
  state.metadata.set("provider-video.mp4", valid);
  assert.equal((await run()).creation.status, "completed");
  assert.equal(state.charges.length, 1);
});

test("a late provider completion preserves a concurrent point release and never charges it", async () => {
  reset();
  state.beforeLock = () => Object.assign(state.row, { status: "failed", charge_status: "released", points_reserved: 0 });
  const result = await run();
  assert.equal(result.creation.status, "failed");
  assert.equal(result.creation.charge_status, "released");
  assert.equal(result.progress, 0);
  assert.equal(state.charges.length, 0);
  assert.equal(state.releases.length, 0);
  assert.equal(state.cleanups.length, 1);
});

test("a concurrent completed settlement keeps its verified object and cleans up the duplicate", async () => {
  reset();
  state.beforeLock = () => Object.assign(state.row, {
    status: "completed", charge_status: "charged", points_reserved: 0,
    content_object_key: "other.mp4", content: "/oss-proxy/other.mp4",
  });
  const result = await run();
  assert.equal(result.creation.content_object_key, "other.mp4");
  assert.equal(result.progress, 100);
  assert.equal(state.charges.length, 0);
  assert.equal(state.cleanups.length, 1);
  assert.deepEqual(state.cleanups[0].objectKeys, ["quickai/user-1/new-video.mp4"]);
});

test("repairing an already charged creation replaces its missing object without charging again", async () => {
  reset({ status: "completed", charge_status: "charged", points_reserved: 0, content_object_key: "old.mp4", content: "/oss-proxy/old.mp4" });
  state.metadata.set("old.mp4", { exists: false, sizeBytes: null });
  const result = await run();
  assert.equal(result.creation.status, "completed");
  assert.equal(result.creation.content_object_key, "quickai/user-1/new-video.mp4");
  assert.equal(state.charges.length, 0);
});

test("an unrepairable already charged object returns an error without altering the financial record", async () => {
  reset({ status: "completed", charge_status: "charged", points_reserved: 0, content_object_key: "old.mp4", content: "/oss-proxy/old.mp4" });
  state.provider.url = "/oss-proxy/old.mp4";
  state.metadata.set("old.mp4", { exists: false, sizeBytes: null });
  const result = await run();
  assert.equal(result.success, false);
  assert.match(result.message, /does not exist/);
  assert.equal(state.row.charge_status, "charged");
  assert.equal(state.row.status, "completed");
  assert.equal(state.charges.length, 0);
  assert.equal(state.releases.length, 0);
});

test("settlement retry after point charge failure reuses the verified object", async () => {
  reset();
  state.chargeError = new Error("database busy");
  assert.equal((await run()).creation.status, "running");
  assert.equal(state.row.charge_status, "reserved");
  state.chargeError = null;
  assert.equal((await run()).creation.status, "completed");
  assert.equal(state.uploads.length, 1);
  assert.equal(state.charges.length, 1);
});
