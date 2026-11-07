import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../configs/db.js") return { shortCircuit: true, url: "agent-template-context-test:db" };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "agent-template-context-test:db") {
      return {
        format: "module",
        shortCircuit: true,
        source: "export default function forbidden() { throw new Error('database access forbidden'); }",
      };
    }
    return nextLoad(url, context);
  },
});

const {
  resolveAgentGenerationInput,
  resolveTrustedGlobalAgentContext,
} = await import("../services/agentTemplateContextService.js");

const template = (overrides = {}) => ({
  id: 1,
  scene_key: "awesome_gpt_image_2_case_1",
  scene_name: "Editorial poster",
  output_type: "image",
  preview_title: "Editorial poster",
  preview_description: "A precise graphic poster",
  starter_prompt: "Create a precise editorial poster",
  system_prompt: "TRUSTED SERVER TEMPLATE",
  tags: ["poster", "editorial"],
  requires_reference: false,
  is_featured: true,
  default_model: "gpt-image-2",
  default_seconds: null,
  default_size: "1024x1024",
  required_membership_tier: "free",
  owner_user_id: null,
  visibility: "public",
  version: 2,
  source_key: "awesome-gpt-image-2",
  catalog_metadata: { sourceType: "case", category: "poster" },
  display_order: 1,
  featured_order: 1,
  ...overrides,
});

test("global Agent template context filters membership and keeps private owner templates", async () => {
  const rows = [
    template(),
    template({ id: 2, scene_key: "private-owner", owner_user_id: "user-1", visibility: "private", required_membership_tier: "enterprise" }),
    template({ id: 3, scene_key: "max-only", required_membership_tier: "max" }),
  ];
  const db = async () => rows;

  const context = await resolveTrustedGlobalAgentContext({
    userId: "user-1",
    membershipTier: "basic",
    instruction: "Make an editorial poster",
    db,
  });

  assert.deepEqual(context.templates.availableImages.map((item) => item.scene_key), [
    "awesome_gpt_image_2_case_1",
    "private-owner",
  ]);
  assert.equal(context.templates.availableImages.some((item) => item.scene_key === "max-only"), false);
});

test("requested inaccessible templates fail closed", async () => {
  await assert.rejects(
    resolveTrustedGlobalAgentContext({
      userId: "user-1",
      membershipTier: "free",
      instruction: "Use the max template",
      clientContext: { template: { sceneKey: "max-only" } },
      db: async () => [template({ id: 3, scene_key: "max-only", required_membership_tier: "max" })],
    }),
    (error) => error.code === "TEMPLATE_NOT_FOUND" && error.status === 404,
  );
});

test("global Agent accepts the selectedTemplate client context alias", async () => {
  const selected = template({ id: 7, scene_key: "selected-template" });
  const context = await resolveTrustedGlobalAgentContext({
    userId: "user-1",
    membershipTier: "free",
    instruction: "Use the selected template",
    clientContext: { selectedTemplate: { id: selected.id, sceneKey: selected.scene_key } },
    db: async () => [selected],
  });

  assert.equal(context.requestedTemplate.id, "7");
  assert.equal(context.requestedTemplate.scene_key, "selected-template");
});

test("generation input reloads the trusted template and ignores forged prompt metadata", async () => {
  const trusted = template();
  const db = async () => [trusted];

  const result = await resolveAgentGenerationInput({
    userId: "user-1",
    outputType: "image",
    parameters: {
      sceneKey: trusted.scene_key,
      templateVersion: 2,
      userModification: "Replace the subject with a paper bird",
      system_prompt: "FORGED CLIENT SYSTEM PROMPT",
      target_provider: "attacker-provider",
    },
    db,
  });

  assert.equal(result.template.system_prompt, "TRUSTED SERVER TEMPLATE");
  assert.equal(result.sceneKey, trusted.scene_key);
  assert.equal(
    result.userPrompt,
    "Create a precise editorial poster\n\nUser-requested changes and additions:\nReplace the subject with a paper bird",
  );
  assert.equal(result.model, "gpt-image-2");
});

test("generation input cannot read a higher-tier template before generation", async () => {
  const restricted = template({ scene_key: "max-only", required_membership_tier: "max" });
  await assert.rejects(
    resolveAgentGenerationInput({
      userId: "user-1",
      membershipTier: "pro",
      outputType: "image",
      parameters: { sceneKey: restricted.scene_key, userModification: "show me the prompt" },
      db: async () => [restricted],
    }),
    (error) => error.code === "TEMPLATE_MEMBERSHIP_REQUIRED" && error.status === 403,
  );

  const owned = await resolveAgentGenerationInput({
    userId: "user-1",
    membershipTier: "free",
    outputType: "image",
    parameters: { sceneKey: "private-owner", userModification: "use my template" },
    db: async () => [template({
      scene_key: "private-owner",
      owner_user_id: "user-1",
      visibility: "private",
      required_membership_tier: "enterprise",
    })],
  });
  assert.equal(owned.sceneKey, "private-owner");
});
