import assert from "node:assert/strict";
import test from "node:test";
import { mergeAgentConversationSaveAcknowledgment } from "./agentConversationSave.js";

const runtime = () => ({
  instruction: "Create an illustration",
  plan: { summary: "Generate image" },
  calls: [{ id: "step-1", status: "running" }],
  run: { id: "run-1", status: "running", progress: 30 },
});

test("serialized save acknowledgments update history without triggering runtime hydration again", () => {
  const current = { id: "conversation-1", title: "Draft", messages: [], runtime_state: runtime(), updated_at: "2026-11-02T12:00:00Z" };
  // A real HTTP response always has fresh object identities after JSON parsing.
  const saved = JSON.parse(JSON.stringify({ ...current, title: "Saved title", messages: [{ role: "user", content: "Create an illustration" }], updated_at: "2026-11-02T12:00:01Z" }));
  assert.notStrictEqual(saved.runtime_state, current.runtime_state);
  const merged = mergeAgentConversationSaveAcknowledgment(current, saved);
  assert.equal(merged.title, "Saved title");
  assert.equal(merged.updated_at, "2026-11-02T12:00:01Z");
  assert.deepEqual(merged.messages, saved.messages);
  assert.strictEqual(merged.runtime_state, current.runtime_state);
  assert.strictEqual(merged.runtime_state.run, current.runtime_state.run);
  assert.strictEqual(merged.runtime_state.calls, current.runtime_state.calls);
});

test("repeated save echoes keep the hydration dependency stable and do not restore stale runs", () => {
  const initialRuntime = runtime();
  let current = { id: "conversation-1", runtime_state: initialRuntime };
  let hydrationChanges = 0;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const saved = JSON.parse(JSON.stringify({ ...current, updated_at: `2026-11-02T12:00:0${attempt}Z` }));
    saved.runtime_state.run.progress = 0;
    const merged = mergeAgentConversationSaveAcknowledgment(current, saved);
    if (merged.runtime_state !== current.runtime_state) hydrationChanges += 1;
    current = merged;
  }
  assert.equal(hydrationChanges, 0);
  assert.equal(current.runtime_state.run.progress, 30);
});

test("an in-flight save cannot switch back to a conversation the user has left", () => {
  const current = { id: "conversation-2", title: "New task", runtime_state: runtime() };
  const lateAcknowledgment = { id: "conversation-1", title: "Previous task", runtime_state: runtime() };
  assert.strictEqual(mergeAgentConversationSaveAcknowledgment(current, lateAcknowledgment), current);
  assert.equal(mergeAgentConversationSaveAcknowledgment(null, lateAcknowledgment), null);
  assert.strictEqual(mergeAgentConversationSaveAcknowledgment(current, null), current);
});

test("a fresh explicitly opened runtime remains authoritative for subsequent save acknowledgments", () => {
  const previous = { id: "conversation-1", runtime_state: runtime() };
  // The open/reload path installs the fetched server record directly.
  const opened = JSON.parse(JSON.stringify(previous));
  opened.runtime_state.run = { id: "run-2", status: "completed", progress: 100 };
  assert.notStrictEqual(opened.runtime_state, previous.runtime_state);
  const lateAcknowledgment = JSON.parse(JSON.stringify(previous));
  const merged = mergeAgentConversationSaveAcknowledgment(opened, lateAcknowledgment);
  assert.strictEqual(merged.runtime_state, opened.runtime_state);
  assert.equal(merged.runtime_state.run.id, "run-2");
  assert.equal(merged.runtime_state.run.status, "completed");
});
