import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplatePayload, changeTemplateOutputType, createTemplateDraft, normalizeStudioTags, suggestTemplateTags, toTemplateDraft } from "./templateStudioDraft.js";

test("a simple new template needs only a name and a prompt while server routing stays automatic", () => {
  const draft = { ...createTemplateDraft("fixed-test-id"), scene_name: "  电商贺卡  ", system_prompt: "  保持商品原有形状  " };
  const payload = buildTemplatePayload(draft);
  assert.equal(payload.scene_key, "user_fixed-test-id");
  assert.equal(payload.scene_name, "电商贺卡");
  assert.equal(payload.system_prompt, "保持商品原有形状");
  assert.equal(payload.default_model, "");
  assert.equal(payload.target_provider, "");
  assert.equal(payload.default_seconds, null);
  assert.equal(payload.preview_description, "");
  assert.equal(payload.is_featured, false);
  assert.equal(payload.points_cost, 18);
});

test("editing visible copy preserves existing routing, prompt defaults and ordering", () => {
  const draft = toTemplateDraft({ id: 41, scene_key: "old_video", scene_name: "旧视频", output_type: "video", target_provider: "sora", default_model: "veo-3-1", default_size: "720x1280", default_seconds: 8, system_prompt: "旧提示词", preview_title: "展示标题", starter_prompt: "用户初始输入", placeholder_text: "填写你的主题", is_active: true, is_featured: true, display_order: 20, featured_order: 9, tags: ["旧标签"], points_cost: 150 });
  const payload = buildTemplatePayload({ ...draft, preview_description: "补充简介", system_prompt: "更新提示词" });
  for (const key of ["scene_key", "target_provider", "default_model", "default_size", "default_seconds", "starter_prompt", "placeholder_text", "display_order", "featured_order", "is_featured"]) assert.equal(payload[key], draft[key]);
  assert.equal(payload.preview_title, "展示标题");
  assert.equal(payload.points_cost, 18);
  assert.equal(buildTemplatePayload({ ...draft, scene_name: "新名称" }).preview_title, "新名称");
});

test("switching output type discards incompatible hidden routing without losing the creative brief", () => {
  const draft = { ...createTemplateDraft("switch"), scene_name: "海报", system_prompt: "画一张海报", target_provider: "image_provider", default_model: "gpt-image-2", default_size: "1024x1024", tags: ["海报"] };
  const switched = changeTemplateOutputType(draft, "video");
  assert.equal(switched.default_model, "");
  assert.equal(switched.default_size, "");
  assert.equal(switched.scene_name, draft.scene_name);
  assert.equal(switched.system_prompt, draft.system_prompt);
  assert.deepEqual(switched.tags, ["海报"]);
  assert.equal(changeTemplateOutputType(draft, "image"), draft);
});

test("tag entry supports Chinese separators and suggestions stay editable, local and relevant", () => {
  assert.deepEqual(normalizeStudioTags("贺卡，电商; 贺卡、插画"), ["贺卡", "电商", "插画"]);
  assert.deepEqual(suggestTemplateTags({ scene_name: "像素动漫头像", system_prompt: "二次元像素风", output_type: "image" }), ["二次元", "头像", "像素"]);
  assert.deepEqual(suggestTemplateTags({ system_prompt: "拍摄商品展示视频", output_type: "video" }), ["电商", "视频"]);
  assert.deepEqual(suggestTemplateTags({ system_prompt: "没有分类线索的短句" }), []);
});

test("missing content and invalid technical values never become a save payload", () => {
  assert.throws(() => buildTemplatePayload(createTemplateDraft("empty")), error => error.field === "scene_name");
  assert.throws(() => buildTemplatePayload({ ...createTemplateDraft("empty"), scene_name: "测试" }), error => error.field === "system_prompt");
  assert.throws(() => buildTemplatePayload({ ...createTemplateDraft("empty"), scene_name: "测试", system_prompt: "提示", default_seconds: "NaN" }), error => error.field === "default_seconds");
});
