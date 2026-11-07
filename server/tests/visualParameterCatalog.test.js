import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VISUAL_PARAMETER_OPTIONS,
  compileVisualPrompt,
  groupVisualParameterRows,
  normalizeVisualParameterOption,
  normalizeVisualParameterSelection,
} from "../domain/visual/visualParameterCatalog.js";
import { compileConfiguredVisualPrompt, listVisualParameterCatalog } from "../services/visualParameterService.js";

test("visual parameter selections compile through the catalog in stable group order", () => {
  const result = compileVisualPrompt({
    basePrompt: "a ceramic mug on a table",
    selection: { motion: "orbit-reveal", style: "commercial", shot: "close-up" },
    rows: DEFAULT_VISUAL_PARAMETER_OPTIONS,
    outputType: "image",
  });

  assert.equal(result.selections.style, "commercial");
  assert.match(result.prompt, /commercial product photography/);
  assert.match(result.prompt, /close-up framing/);
  assert.match(result.prompt, /smooth orbit that reveals/);
  assert.ok(result.prompt.indexOf("commercial product photography") < result.prompt.indexOf("close-up framing"));
  assert.match(result.negativePrompt, /watermark/);
});

test("visual prompt accepts normal multiline Agent text while rejecting unsafe controls", () => {
  const result = compileVisualPrompt({
    basePrompt: "主提示词\n\n【构图】\t主体居中",
    selection: {},
    rows: DEFAULT_VISUAL_PARAMETER_OPTIONS,
    outputType: "image",
  });

  assert.equal(result.prompt, "主提示词\n\n【构图】\t主体居中");
  assert.throws(
    () => compileVisualPrompt({ basePrompt: "unsafe\u0000prompt", selection: {}, rows: DEFAULT_VISUAL_PARAMETER_OPTIONS }),
    (error) => error.code === "INVALID_VISUAL_PARAMETER_TEXT",
  );
});

test("visual parameter compilation rejects options unavailable for the requested output", () => {
  const rows = DEFAULT_VISUAL_PARAMETER_OPTIONS.map((row) => row.option_key === "orbit" && row.parameter_key === "camera"
    ? { ...row, supported_output_types: ["video"] }
    : row);

  assert.throws(
    () => compileVisualPrompt({ basePrompt: "product", selection: { camera: "orbit" }, rows, outputType: "image" }),
    (error) => error.code === "VISUAL_PARAMETER_UNAVAILABLE" && error.status === 400,
  );
});

test("visual parameter normalization keeps administrator input bounded", () => {
  assert.deepEqual(normalizeVisualParameterSelection({ style: "CINEMATIC", unknown: "ignored" }), { style: "cinematic" });
  assert.deepEqual(normalizeVisualParameterSelection({ style: "3D-RENDER" }), { style: "3d-render" });
  assert.throws(
    () => normalizeVisualParameterOption({ parameter_key: "unknown", option_key: "x", display_name: "x", prompt_fragment: "x" }),
    (error) => error.code === "INVALID_VISUAL_PARAMETER_GROUP",
  );
});

test("public visual catalog has a safe fallback when migration 030 is not present", async () => {
  const missingTableDb = async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); };
  const catalog = await listVisualParameterCatalog({ db: missingTableDb, allowFallback: true });
  assert.equal(catalog.source, "fallback");
  assert.equal(catalog.groups.length, 6);
  assert.ok(catalog.groups.every((group) => group.options.length > 0));

  const compiled = await compileConfiguredVisualPrompt({
    db: missingTableDb,
    basePrompt: "a product hero image",
    selection: { style: "cinematic" },
    outputType: "image",
  });
  assert.match(compiled.prompt, /cinematic visual language/);
});

test("catalog rows are grouped without exposing disabled options to public callers", () => {
  const groups = groupVisualParameterRows([
    { ...DEFAULT_VISUAL_PARAMETER_OPTIONS[0], is_active: false },
    DEFAULT_VISUAL_PARAMETER_OPTIONS[1],
  ]);
  assert.equal(groups.find((group) => group.parameter_key === "style").options.length, 2);
});
