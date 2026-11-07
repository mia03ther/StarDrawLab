import assert from "node:assert/strict";
import test from "node:test";

import { MAX_GLOBAL_AGENT_CONTEXT_CHARS, serializeGlobalAgentContext } from "../services/globalAgentContextSerialization.js";

test("global Agent context stays valid JSON and bounded when template metadata is large", () => {
  const longPrompt = "A detailed template prompt. ".repeat(90);
  const template = (index) => ({
    id: String(index),
    scene_key: `scene_${index}`,
    scene_name: `Scene ${index}`,
    output_type: index % 2 ? "video" : "image",
    preview_title: `Preview ${index}`,
    preview_description: longPrompt,
    starter_prompt: longPrompt,
    tags: ["product", "commercial", "cinematic", "editorial"],
    requires_reference: false,
    is_featured: index === 1,
    default_model: "gpt-image-2",
    default_seconds: null,
    default_size: "1024x1024",
    required_membership_tier: "free",
    version: 1,
  });

  const serialized = serializeGlobalAgentContext({
    source: "global_agent",
    currentPath: "/ai",
    requestedTemplate: template("requested"),
    templates: {
      availableImages: Array.from({ length: 48 }, (_, index) => template(index)),
      availableVideos: Array.from({ length: 48 }, (_, index) => template(index + 100)),
    },
    membershipTier: "free",
  });

  assert.ok(serialized.length <= MAX_GLOBAL_AGENT_CONTEXT_CHARS);
  const restored = JSON.parse(serialized);
  assert.equal(restored.requestedTemplate.id, "requested");
  assert.ok(restored.templates.availableImages.length > 0);
  assert.ok(restored.templates.availableVideos.length > 0);
  assert.equal(Object.hasOwn(restored.templates.availableImages[0], "starter_prompt"), false);
  assert.equal(Object.hasOwn(restored.templates.availableImages[0], "system_prompt"), false);
});

test("global Agent context preserves the fact that a reference image is attached", () => {
  const restored = JSON.parse(serializeGlobalAgentContext({
    source: "global_agent",
    attachedReferenceImages: [{ type: "image", title: "image_123.png", source: "upload" }],
  }));

  assert.deepEqual(restored.attachedReferenceImages, [{
    type: "image",
    title: "image_123.png",
    source: "upload",
  }]);
});
