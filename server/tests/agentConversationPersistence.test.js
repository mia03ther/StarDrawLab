import assert from "node:assert/strict";
import test from "node:test";

import { agentConversationPersistenceValues } from "../infrastructure/postgresAgentConversationStore.js";

test("Agent conversation JSON values stay structured for postgres.js", () => {
  const messages = [{ role: "user", content: "hello" }];
  const runtimeState = { mode: "approve_safe", calls: [] };

  const values = agentConversationPersistenceValues({ messages, runtimeState });

  assert.equal(values.messages, messages);
  assert.equal(values.runtimeState, runtimeState);
  assert.ok(Array.isArray(values.messages));
  assert.equal(typeof values.runtimeState, "object");
});
