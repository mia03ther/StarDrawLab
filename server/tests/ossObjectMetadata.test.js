import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { result: { res: { headers: { "content-length": "4096", "content-type": "video/mp4" } } }, error: null, keys: [] };
globalThis.__ossMetadataTest = state;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!context.parentURL?.endsWith("/configs/oss.js")) return nextResolve(specifier, context);
    if (specifier === "ali-oss") return { shortCircuit: true, url: "oss-metadata-test:oss" };
    if (specifier === "./logger.js") return { shortCircuit: true, url: "oss-metadata-test:logger" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "oss-metadata-test:oss") return { format: "module", shortCircuit: true, source: `export default class OSS {
      async head(key) { const s=globalThis.__ossMetadataTest; s.keys.push(key); if(s.error)throw s.error; return s.result; }
    }` };
    if (url === "oss-metadata-test:logger") return { format: "module", shortCircuit: true, source: "export default {info(){},warn(){}};" };
    return nextLoad(url, context);
  },
});
const { getObjectMetadata } = await import("../configs/oss.js");

test("OSS metadata uses a HEAD request and reports the actual byte length", async () => {
  assert.deepEqual(await getObjectMetadata("quickai/u1/video.mp4"), { exists: true, sizeBytes: 4096, contentType: "video/mp4" });
  assert.equal(state.keys.at(-1), "quickai/u1/video.mp4");
});
test("only confirmed missing objects are represented as absent; access failures and outages propagate", async () => {
  state.error = Object.assign(new Error("missing"), { status: 404 });
  assert.deepEqual(await getObjectMetadata("missing.mp4"), { exists: false, sizeBytes: null, contentType: null });
  for (const status of [403, 500, 503]) {
    state.error = Object.assign(new Error("storage unavailable"), { status });
    await assert.rejects(getObjectMetadata("video.mp4"), error => error.status === status);
  }
  state.error = null;
});
test("unknown metadata sizes stay unknown rather than being mistaken for valid content", async () => {
  for (const rawSize of [undefined, "", "invalid", "-1"]) {
    state.result = { res: { headers: { "content-length": rawSize } } };
    assert.deepEqual(await getObjectMetadata("video.mp4"), { exists: true, sizeBytes: null, contentType: "application/octet-stream" });
  }
  state.result = { res: { headers: { "content-length": "0" } } };
  assert.equal((await getObjectMetadata("empty.mp4")).sizeBytes, 0);
});
test("metadata access rejects paths outside the object namespace before making a request", async () => {
  const calls = state.keys.length;
  for (const key of ["", "/absolute", "../outside", "a/../outside", "a\\outside"]) {
    await assert.rejects(getObjectMetadata(key), /Invalid OSS object key/);
  }
  assert.equal(state.keys.length, calls);
});
