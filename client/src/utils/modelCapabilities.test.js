import assert from "node:assert/strict";
import test from "node:test";
import {
  getModelSizeOptions,
  modelSupportsReferenceImages,
  normalizeModelCatalogResponse,
  resolveSupportedValue,
} from "./modelCapabilities.js";

test("normalizes wrapped, aliased and empty capability responses", () => {
  const models = normalizeModelCatalogResponse({ data: { models: [{ modelKey: "demo", displayName: "Demo", capabilities: { resolutions: ["2K"], aspectRatios: ["16 / 9"] } }] } });
  assert.equal(models[0].model_key, "demo");
  assert.deepEqual(models[0].resolutions, ["2K"]);
  assert.deepEqual(models[0].aspect_ratios, ["16 / 9"]);
  assert.deepEqual(normalizeModelCatalogResponse({ data: [] }, [{ model_key: "fallback" }])[0].model_key, "fallback");
});

test("filters image sizes by both declared dimensions and ratios", () => {
  const options = getModelSizeOptions({
    model: { resolutions: ["1K", "2K"], aspect_ratios: ["1:1", "9:16"] },
    outputType: "image",
  });
  assert.deepEqual(options.map((item) => item.value), ["1024x1024", "576x1024", "2048x2048", "1152x2048"]);
});

test("uses safe fallback for empty capabilities and supports direct dimensions", () => {
  const fallback = getModelSizeOptions({ model: { resolutions: [], aspect_ratios: [] }, outputType: "video" });
  assert.deepEqual(fallback.map((item) => item.value), ["720x1280", "1280x720"]);
  const direct = getModelSizeOptions({ model: { resolutions: ["1920x1080"], aspect_ratios: ["16:9"] }, outputType: "video" });
  assert.deepEqual(direct.map((item) => item.value), ["1920x1080"]);
  assert.equal(resolveSupportedValue("missing", direct, "1920x1080"), "1920x1080");
});

test("treats reference images as unsupported only when the catalog explicitly disables them", () => {
  assert.equal(modelSupportsReferenceImages({ capabilities: { reference_images: false } }), false);
  assert.equal(modelSupportsReferenceImages({ capabilities: { reference_images: true } }), true);
  assert.equal(modelSupportsReferenceImages({ capabilities: {} }), true);
});
