import assert from "node:assert/strict";
import test from "node:test";
import {
  inferGenerationMode,
  normalizeGenerationChargeRule,
  normalizeGenerationMode,
} from "../domain/pricing/generationChargeRule.js";
import { inferImageQuality, normalizeImageQuality } from "../domain/pricing/imageQuality.js";

test("image quality is normalized and inferred from model or output size", () => {
  assert.equal(normalizeImageQuality(" 2K "), "2k");
  assert.equal(normalizeImageQuality("8k"), null);
  assert.equal(inferImageQuality({ model: "gpt-image-2-4k", size: "1024x1024" }), "4k");
  assert.equal(inferImageQuality({ model: "gpt-image-2", size: "1024x1536" }), "2k");
  assert.equal(inferImageQuality({ model: "gpt-image-2", size: "2048x2048" }), "2k");
  assert.equal(inferImageQuality({ model: "gpt-image-2", size: "4096x2160" }), "4k");
});

test("generation mode is inferred from the trusted freeform scene key", () => {
  assert.equal(inferGenerationMode({ outputType: "image", sceneKey: "freeform_image" }), "freeform");
  assert.equal(inferGenerationMode({ outputType: "video", sceneKey: "freeform_video" }), "freeform");
  assert.equal(inferGenerationMode({ outputType: "image", sceneKey: "product_poster" }), "template");
  assert.equal(inferGenerationMode({ outputType: "image", sceneKey: null }), "all");
  assert.equal(inferGenerationMode({ outputType: "agent", sceneKey: "global_agent_plan" }), "all");
});

test("charge rule normalization accepts model/size/duration-specific template prices", () => {
  assert.deepEqual(normalizeGenerationChargeRule({
    output_type: "video",
    provider: "sora",
    generation_mode: "template",
    scene_key: "product_video",
    model: "veo-3-1",
    seconds: "8",
    size: "1280x720",
    points_cost: "160",
    priority: "10",
  }), {
    outputType: "video",
    provider: "sora",
    sceneKey: "product_video",
    model: "veo-3-1",
    seconds: 8,
    size: "1280x720",
    pointsCost: 160,
    priority: 10,
    generationMode: "template",
    isActive: true,
    metaRule: { billing_type: "fixed" },
  });
});

test("freeform and per-minute rules are validated independently", () => {
  const rule = normalizeGenerationChargeRule({
    output_type: "video",
    provider: "sora",
    generation_mode: "freeform",
    points_cost: 150,
    meta_rule: { billing_type: "per_minute", points_per_minute: 200, minimum_points: 20 },
  });
  assert.equal(rule.generationMode, "freeform");
  assert.deepEqual(rule.metaRule, {
    billing_type: "per_minute",
    points_per_minute: 200,
    minimum_points: 20,
  });

  assert.throws(
    () => normalizeGenerationChargeRule({ output_type: "image", provider: "image_provider", points_cost: 10, meta_rule: { billing_type: "per_minute", points_per_minute: 10 } }),
    (error) => error.code === "INVALID_GENERATION_CHARGE_RULE",
  );
  assert.throws(
    () => normalizeGenerationMode("freeform", "agent"),
    (error) => error.code === "INVALID_GENERATION_CHARGE_RULE",
  );
});

test("nullable matching fields can be cleared while editing a rule", () => {
  const rule = normalizeGenerationChargeRule({
    output_type: "video",
    provider: "sora",
    scene_key: null,
    model: null,
    seconds: null,
    size: null,
    points_cost: 160,
    generation_mode: "template",
  }, {
    output_type: "video",
    provider: "sora",
    scene_key: "product_video",
    model: "veo-3-1",
    seconds: 8,
    size: "1280x720",
    points_cost: 120,
    generation_mode: "template",
    meta_rule: { billing_type: "fixed" },
    is_active: true,
  });

  assert.equal(rule.sceneKey, null);
  assert.equal(rule.model, null);
  assert.equal(rule.seconds, null);
  assert.equal(rule.size, null);
  assert.equal(rule.pointsCost, 160);
});

test("quality pricing rows retain independent template and freeform prices", () => {
  const template2k = normalizeGenerationChargeRule({
    output_type: "image",
    provider: "image_provider",
    generation_mode: "template",
    points_cost: 22,
    priority: 1,
    meta_rule: { billing_type: "fixed", image_quality: "2K" },
  });
  const freeform4k = normalizeGenerationChargeRule({
    output_type: "image",
    provider: "image_provider",
    generation_mode: "freeform",
    points_cost: 32,
    priority: 1,
    meta_rule: { billing_type: "fixed", image_quality: "4k" },
  });

  assert.equal(template2k.metaRule.image_quality, "2k");
  assert.equal(template2k.pointsCost, 22);
  assert.equal(freeform4k.metaRule.image_quality, "4k");
  assert.equal(freeform4k.pointsCost, 32);
});

test("charge rule inputs may omit non-image fields without sending undefined to PostgreSQL", () => {
  assert.equal(inferImageQuality({ model: "gpt-image-2", size: "1024x1024" }), "1k");
  assert.equal(inferImageQuality({ model: null, size: null }), null);
});
