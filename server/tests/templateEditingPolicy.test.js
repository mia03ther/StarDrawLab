import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTemplateEdit, applyTemplateModelDefaults, userTemplatePublication, templateManagementRow, isAdministratorEditableTemplate } from "../domain/templates/templateEditingPolicy.js";
import { UserTemplateAgentService } from "../services/userTemplateAgentService.js";

const existing = { scene_key: "user_original", scene_name: "Name", output_type: "video", target_provider: "sora", default_model: "old-video", default_size: "720x1280", default_seconds: 6, system_prompt: "Prompt", starter_prompt: "Starter", placeholder_text: "Placeholder", tags: ["old"], requires_reference: true, owner_user_id: "owner", is_active: true, visibility: "public", approval_status: "approved" };

test("a title-only edit retains hidden route, output settings, prompt and optional help", () => {
  const edited = normalizeTemplateEdit({ scene_name: "Renamed", scene_key: "try-to-change" }, existing);
  assert.equal(edited.sceneKey, existing.scene_key);
  assert.equal(edited.sceneName, "Renamed");
  assert.equal(edited.defaultModel, existing.default_model);
  assert.equal(edited.defaultSize, existing.default_size);
  assert.equal(edited.defaultSeconds, existing.default_seconds);
  assert.equal(edited.systemPrompt, existing.system_prompt);
  assert.equal(edited.starterPrompt, existing.starter_prompt);
  assert.equal(edited.placeholderText, existing.placeholder_text);
  assert.equal(edited.requiresReference, true);
});

test("new templates get a stable non-freeform identity and optional descriptions stay optional", () => {
  const body = { scene_name: "New", system_prompt: "Prompt", output_type: "image" };
  const a = normalizeTemplateEdit(body, null, { userId: "owner", idempotencyKey: "one" });
  const b = normalizeTemplateEdit(body, null, { userId: "owner", idempotencyKey: "one" });
  assert.equal(a.sceneKey, b.sceneKey);
  assert.equal(a.previewDescription, "");
  assert.throws(() => normalizeTemplateEdit({ ...body, scene_key: "freeform_image" }), error => error.status === 400);
});

test("changing output type derives fresh trusted catalog defaults", () => {
  const draft = normalizeTemplateEdit({ output_type: "image", default_model: "", default_size: "", default_seconds: null }, existing);
  const selected = applyTemplateModelDefaults(draft, { resolutions: ["1536x1024"] });
  assert.equal(selected.defaultModel, "");
  assert.equal(selected.defaultSize, "1536x1024");
  assert.equal(selected.defaultSeconds, null);
  const video = applyTemplateModelDefaults({ outputType: "video" }, { capabilities: { durations: [4, 8] }, resolutions: ["1280x720"] });
  assert.equal(video.defaultSeconds, 4);
  assert.equal(video.defaultSize, "1280x720");
});

test("direct publication never lets an owner undo an administrator takedown", () => {
  assert.deepEqual(userTemplatePublication(null), { visibility: "public", approvalStatus: "approved", isActive: true });
  assert.deepEqual(userTemplatePublication({ ...existing, is_active: false, approval_status: "rejected" }, true), { visibility: "public", approvalStatus: "rejected", isActive: false });
  assert.deepEqual(userTemplatePublication({ ...existing, visibility: "private", approval_status: "rejected" }, true), { visibility: "private", approvalStatus: "rejected", isActive: false });
  assert.equal(isAdministratorEditableTemplate({ owner_user_id: "other", visibility: "private", approval_status: "private" }), false);
  assert.equal(isAdministratorEditableTemplate({ owner_user_id: "other", visibility: "private", approval_status: "pending", publication_requested_at: "2026-11-05" }), true);
  assert.equal(templateManagementRow(existing, { userId: "other", role: "user" }).can_edit, false);
});

const serviceFixture = () => {
  const state = { queries: [], existing: null, modelCalls: [] };
  const db = async (strings, ...values) => {
    const sql = strings.join("?"); state.queries.push({ sql, values });
    if (sql.includes("SELECT capabilities")) return [{ capabilities: { durations: [4, 8] }, resolutions: ["1280x720"] }];
    if (sql.includes("SELECT * FROM prompt_templates")) return state.existing?.owner_user_id === values[1] && state.existing.is_active ? [state.existing] : [];
    if (sql.includes("INSERT INTO prompt_templates")) return [{ id: "91", scene_key: values[0], scene_name: values[1], output_type: values[2], target_provider: values[3], default_model: values[4], default_seconds: values[5], default_size: values[6], owner_user_id: "owner" }];
    if (sql.includes("UPDATE prompt_templates")) return [{ ...state.existing, scene_name: values[0], output_type: values[1], default_model: values[3], default_seconds: values[4], default_size: values[5] }];
    return [];
  };
  db.json = value => value;
  const service = new UserTemplateAgentService({ sqlClient: db, operationExecutor: ({ mutate }) => mutate(db), deleteContent: async () => {}, modelResolver: async input => { state.modelCalls.push(input); return { modelKey: input.modelKey || "trusted-video", targetProvider: "sora" }; } });
  return { state, service };
};

test("Agent creation uses trusted defaults, publishes directly, and locks the price at eighteen", async () => {
  const { state, service } = serviceFixture();
  const result = await service.create({ userId: "owner", input: { sceneName: "New", outputType: "video", systemPrompt: "Prompt", points_cost: 1 }, idempotencyKey: "agent-new" });
  assert.equal(result.default_model, "trusted-video");
  assert.equal(result.default_seconds, 4);
  assert.equal(result.default_size, "1280x720");
  assert.equal(result.points_cost, 18);
  assert.match(state.queries.find(q => q.sql.includes("INSERT INTO prompt_templates")).sql, /'public', 'approved'/);
  assert.ok(state.queries.find(q => q.sql.includes("INSERT INTO generation_charge_rules")).values.includes(18));
});

test("Agent edit cannot access other owners or revive an inactive moderated template", async () => {
  const { state, service } = serviceFixture();
  state.existing = { ...existing, id: "91" };
  await assert.rejects(service.update({ userId: "other", templateId: "91", patch: { sceneName: "Attempt" }, idempotencyKey: "cross" }), error => error.status === 404);
  state.existing = { ...existing, id: "91", is_active: false, approval_status: "rejected" };
  await assert.rejects(service.update({ userId: "owner", templateId: "91", patch: { is_active: true }, idempotencyKey: "revive" }), error => error.status === 404);
  assert.ok(!state.queries.some(q => q.sql.includes("UPDATE prompt_templates")));
});


test("Agent edits preserve legacy private publication state and reject owner publication overrides", async () => {
  const { state, service } = serviceFixture();
  state.existing = { ...existing, id: "91", visibility: "private", approval_status: "pending", publication_requested_at: "2026-10-01" };
  await service.update({ userId: "owner", templateId: "91", patch: { sceneName: "Renamed", visibility: "public", approvalStatus: "approved" }, idempotencyKey: "preserve-private" });
  const update = state.queries.find(query => query.sql.includes("UPDATE prompt_templates"));
  assert.ok(update.values.includes("private"));
  assert.ok(update.values.includes("pending"));
  assert.doesNotMatch(update.sql, /visibility = 'public'|publication_requested_at\s*=/);
});
