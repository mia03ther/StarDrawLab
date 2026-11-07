import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryLoadState, parseHistoryResponse, historyLoadReducer as reduce, isHistoryRequestCancelled, getHistoryLoadErrorMessage } from "./historyLoadState.js";

const start = (state, requestId = 1, page = 1, scope = "all") => reduce(state, { type: "start", requestId, page, scope });
const success = (state, payload) => reduce(state, { type: "success", requestId: state.requestId, ...parseHistoryResponse(payload) });

test("a failed initial history read is an error, while a successful empty result is genuinely empty", () => {
  const pending = start(createHistoryLoadState());
  const failed = reduce(pending, { type: "failure", requestId: 1, error: { response: { status: 500 } } });
  assert.equal(failed.hasLoaded, false);
  assert.equal(failed.items.length, 0);
  assert.equal(failed.error.response.status, 500);
  const recovered = success(start(failed, 2), { success: true, creations: [], total: 0 });
  assert.equal(recovered.hasLoaded, true);
  assert.equal(recovered.error, null);
  assert.equal(recovered.total, 0);
});

test("refresh and pagination failure preserve loaded assets and do not skip a page on retry", () => {
  const asset = { id: 42, status: "completed", content: "/oss-proxy/example.png" };
  const loaded = success(start(createHistoryLoadState()), { success: true, creations: [asset], total: 2 });
  const failed = reduce(start(loaded, 2, 2), { type: "failure", requestId: 2, error: new Error("offline") });
  assert.deepEqual(failed.items, [asset]);
  assert.equal(failed.page, 1);
  assert.equal(failed.requestedPage, 2);
  assert.equal(failed.total, 2);
  const retried = success(start(failed, 3, failed.requestedPage), { success: true, creations: [{ id: 43 }], total: 2 });
  assert.deepEqual(retried.items.map((item) => item.id), [42, 43]);
  assert.equal(retried.page, 2);
  const refreshFailed = reduce(start(retried, 4), { type: "failure", requestId: 4, error: new Error("server") });
  assert.deepEqual(refreshFailed.items, retried.items);
});

test("malformed or unsuccessful history responses never silently become an empty success", () => {
  for (const payload of [null, "<html>login</html>", {}, { success: false, creations: [], total: 0 },
    { success: true, total: 0 }, { success: true, creations: {}, total: 0 },
    { success: true, creations: [], total: -1 }, { success: true, creations: [], total: "0" },
    { success: true, creations: [null], total: 1 }, { success: true, creations: [{}], total: 1 }]) {
    assert.throws(() => parseHistoryResponse(payload), { code: "INVALID_HISTORY_RESPONSE" });
  }
});

test("a late response from an old tab or request cannot replace the current history", () => {
  const initial = start(createHistoryLoadState(), 1, 1, "all");
  const nextTab = start(initial, 2, 1, "video");
  assert.equal(nextTab.hasLoaded, false);
  assert.deepEqual(reduce(nextTab, { type: "success", requestId: 1, items: [{ id: "old-image" }], total: 1 }), nextTab);
  assert.deepEqual(reduce(nextTab, { type: "failure", requestId: 1, error: new Error("late") }), nextTab);
  const current = success(nextTab, { success: true, creations: [{ id: "video" }], total: 1 });
  assert.deepEqual(reduce(current, { type: "patch", scope: "all", updates: new Map([["video", { status: "failed" }]]) }), current);
});

test("cancellation is silent and never fabricates a successfully loaded empty history", () => {
  for (const error of [{ code: "ERR_CANCELED" }, { name: "CanceledError" }, { name: "AbortError" }]) assert.equal(isHistoryRequestCancelled(error), true);
  assert.equal(isHistoryRequestCancelled({ response: { status: 500 } }), false);
  const cancelled = reduce(start(createHistoryLoadState()), { type: "cancel", requestId: 1 });
  assert.equal(cancelled.hasLoaded, false);
  assert.equal(cancelled.error, null);
});

test("load errors distinguish access, malformed data and temporary failures without exposing server details", () => {
  const t = (zh) => zh;
  assert.match(getHistoryLoadErrorMessage({ response: { status: 401 } }, t), /重新登录/);
  assert.match(getHistoryLoadErrorMessage({ response: { status: 403 } }, t), /访问权限/);
  assert.match(getHistoryLoadErrorMessage({ code: "INVALID_HISTORY_RESPONSE" }, t), /格式异常/);
  assert.match(getHistoryLoadErrorMessage({ message: "private SQL connection string" }, t), /不表示作品已被删除/);
  assert.doesNotMatch(getHistoryLoadErrorMessage({ message: "private SQL connection string" }, t), /SQL/);
});
