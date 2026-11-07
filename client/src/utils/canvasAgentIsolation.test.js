import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readSource = (relativePath) => fs.readFileSync(path.join(clientRoot, relativePath), "utf8");

test("the canvas Agent has no client-side dependency on the global Agent runtime", () => {
  const studio = readSource("pages/CanvasStudio.jsx");
  const layout = readSource("pages/Layout.jsx");
  const panel = readSource("components/canvas/CanvasAgentPanel.jsx");
  const runtime = readSource("hooks/useCanvasAgentRuntime.js");

  assert.doesNotMatch(studio, /useAgentConversationHistory/);
  assert.doesNotMatch(studio, /\/api\/agent(?:\/|")/);
  assert.doesNotMatch(studio, /\/api\/canvases\/agent\/plan/);
  assert.doesNotMatch(studio, /全局 Agent|Global Agent/);
  assert.doesNotMatch(studio, /isLegacyAgentPanelEnabled/);

  assert.match(panel, /useCanvasAgentRuntime/);
  assert.match(runtime, /\/api\/canvas-agent\//);
  assert.doesNotMatch(runtime, /\/api\/agent(?:\/|")/);

  const canvasLayoutStart = layout.indexOf('if (location.pathname === "/ai/canvas")');
  const canvasLayoutEnd = layout.indexOf('<div className="flex min-h-screen"', canvasLayoutStart);
  assert.ok(canvasLayoutStart >= 0 && canvasLayoutEnd > canvasLayoutStart);
  assert.doesNotMatch(layout.slice(canvasLayoutStart, canvasLayoutEnd), /GlobalAgentDock/);
});

test("compact canvas toolbar icon buttons expose stable names and hover labels", () => {
  const studio = readSource("pages/CanvasStudio.jsx");
  const iconButton = readSource("components/canvas/CanvasIconButton.jsx");
  for (const label of [
    "返回总览",
    "切换左侧面板",
    "切换右侧面板",
    "打开画布 Agent",
    "抓手工具",
    "缩放工具",
  ]) {
    assert.match(studio, new RegExp(`(?:aria-label|label)=\\{t\\(\\"${label}\\"`));
  }
  assert.match(studio, /import CanvasIconButton from/);
  assert.match(studio, /<CanvasIconButton label=\{t\("打开画布 Agent"/);
  assert.match(iconButton, /createPortal/);
  assert.match(iconButton, /getBoundingClientRect/);
});
