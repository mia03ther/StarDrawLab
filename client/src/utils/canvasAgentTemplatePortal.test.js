import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const picker = fs.readFileSync(path.join(clientRoot, "components/canvas/AgentTemplatePicker.jsx"), "utf8");

test("canvas Agent template center escapes the panel stacking context", () => {
  assert.match(picker, /createPortal/);
  assert.match(picker, /document\.body/);
  assert.match(picker, /fixed inset-0 z-\[205\]/);
});
