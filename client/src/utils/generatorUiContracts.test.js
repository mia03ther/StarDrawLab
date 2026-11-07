import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as modelCapabilities from "./modelCapabilities.js";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readPage = (name) => fs.readFileSync(path.join(clientRoot, "pages", name), "utf8");

test("template launch preserves the exact template identity", () => {
  const source = readPage("TemplateMarketplace.jsx");
  assert.match(source, /template_id/);
  assert.match(source, /URLSearchParams/);
});

test("generator controls put model before output size and load the requested template", () => {
  const image = readPage("SceneImage.jsx");
  const video = readPage("AIVideo.jsx");
  assert.match(image, /requestedTemplateId/);
  assert.match(video, /requestedTemplateId/);
  assert.ok(image.indexOf('t("图片模型", "Image Model")') < image.indexOf('t("输出尺寸", "Output Size")'));
  assert.ok(video.indexOf('t("视频模型", "Video Model")') < video.indexOf('t("视频尺寸", "Video Format")'));
  assert.match(video, /formData\.append\("seconds",/);
});

test("video duration options follow the selected model capability catalog", () => {
  assert.equal(typeof modelCapabilities.getModelDurationOptions, "function");
  const { getModelDurationOptions } = modelCapabilities;
  assert.deepEqual(
    getModelDurationOptions({
      durations: [4, 8, 12],
      capabilities: { durations: [6] },
    }),
    [4, 8, 12],
  );
  assert.deepEqual(getModelDurationOptions({ capabilities: { duration_seconds: [5, 10] } }, 8), [5, 10]);
  assert.deepEqual(getModelDurationOptions({ capabilities: { supported_seconds: "6,12" } }, 8), [6, 12]);
  assert.deepEqual(getModelDurationOptions({}, 8), [8]);
});

test("template lists are bounded and collapsible on both generators", () => {
  for (const page of ["SceneImage.jsx", "AIVideo.jsx"]) {
    const source = readPage(page);
    assert.match(source, /templateListOpen/);
    assert.match(source, /max-h-\[/);
    assert.match(source, /overflow-y-auto/);
  }
});

test("template deep links focus the generator once after the template is ready", () => {
  for (const page of ["SceneImage.jsx", "AIVideo.jsx"]) {
    const source = readPage(page);
    assert.match(source, /templateLaunchKey/);
    assert.match(source, /autoFocusedTemplateRef/);
    assert.match(source, /if \(!templateLaunchKey \|\| !selectedScene/);
    assert.match(source, /autoFocusedTemplateRef\.current = templateLaunchKey/);
    assert.match(source, /t\("已应用模板", "Template applied"\)/);
  }
});

test("image and video prompt optimization use the authenticated LLM endpoint", () => {
  for (const page of ["SceneImage.jsx", "AIVideo.jsx"]) {
    const source = readPage(page);
    assert.match(source, /\/api\/ai\/optimize-generation-prompt/);
    assert.match(source, /X-Idempotency-Key/);
    assert.doesNotMatch(source, /画面主体清晰，构图干净，商业摄影质感/);
    assert.doesNotMatch(source, /镜头运动自然稳定，主体始终清晰/);
  }
});
