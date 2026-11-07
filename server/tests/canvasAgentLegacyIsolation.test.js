import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

test("legacy Canvas Agent endpoint is isolated from global Agent services", () => {
  const controller = readSource("../controllers/canvasController.js");
  const routes = readSource("../routes/canvasRoutes.js");
  const toolRegistry = readSource("../services/agentToolRegistry.js");
  const runtimeComposition = readSource("../services/agentRuntimeComposition.js");

  for (const legacyReference of [
    "planCanvasAgent",
    "getAgentRuntime",
    "canvas.agent.plan",
    "canvas_agent_plan",
  ]) {
    assert.doesNotMatch(controller, new RegExp(legacyReference.replaceAll(".", "\\.")));
  }

  for (const legacyReference of ["/agent/plan", "planCanvasAgent", "agentLimiter"]) {
    assert.doesNotMatch(routes, new RegExp(legacyReference.replaceAll(".", "\\.")));
  }

  assert.doesNotMatch(toolRegistry, /canvas\.agent\.plan/);
  assert.doesNotMatch(runtimeComposition, /createCanvasAgentPlanHandler|canvas\.agent\.plan/);
});

test("new Canvas Agent module remains intact", () => {
  const routes = readSource("../modules/canvas-agent/routes.js");
  const composition = readSource("../modules/canvas-agent/composition.js");

  assert.match(routes, /router\.post\("\/runs"/);
  assert.match(composition, /getCanvasAgentRuntime/);
});
