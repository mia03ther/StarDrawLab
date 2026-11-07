import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeGlobalAgentPreferences,
  saveGlobalAgentPreferences,
} from "../services/globalAgentPreferencesService.js";

const fakeSql = () => {
  const calls = [];
  const db = (strings, ...values) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve([{
      access_mode: "approve_for_me",
      preferences: values[2]?.value || values[2],
      updated_at: "2026-08-18T00:00:00.000Z",
    }]);
  };
  db.json = (value) => ({ value });
  db.calls = calls;
  return db;
};

test("Global Agent preferences are bound as a JSON object, not a JSON string", async () => {
  const db = fakeSql();
  const preferences = normalizeGlobalAgentPreferences({ agentModel: "gpt-5.6-sol" });
  const saved = await saveGlobalAgentPreferences({
    userId: "user-preferences-test",
    mode: "approve_for_me",
    preferences,
    db,
  });

  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].values[2], { value: preferences });
  assert.equal(saved.agentPreferences.agentModel, "gpt-5.6-sol");
});
