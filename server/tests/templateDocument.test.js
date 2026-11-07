import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPLATE_DOCUMENT_JSON_SCHEMA,
  TEMPLATE_DOCUMENT_SCHEMA_ID,
  exportTemplateDocument,
  normalizeTemplateDocument,
} from "../domain/templates/templateDocument.js";

const row = {
  version: 3,
  scene_key: "cinematic.opening",
  scene_name: "Cinematic Opening",
  output_type: "video",
  default_model: "veo-3-1",
  default_seconds: 8,
  default_size: "1280x720",
  system_prompt: "Create a cinematic opening shot.",
  preview_title: "Opening",
  preview_description: "A controlled opening shot",
  starter_prompt: "A city wakes at dawn",
  placeholder_text: "Describe the location",
  requires_reference: false,
  tags: ["cinematic", "opening"],
  required_membership_tier: "pro",
  preview_object_key: "private/secret-preview.png",
  preview_image_url: "/oss-proxy/private/secret-preview.png",
};

test("template documents export a versioned safe definition without media credentials", () => {
  const document = exportTemplateDocument(row);
  assert.equal(document.$schema, TEMPLATE_DOCUMENT_SCHEMA_ID);
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.templateVersion, 3);
  assert.equal(document.template.sceneKey, "cinematic.opening");
  assert.equal(Object.hasOwn(document.template, "preview_object_key"), false);
  assert.equal(Object.hasOwn(document.template, "previewImageUrl"), false);
  assert.equal(TEMPLATE_DOCUMENT_JSON_SCHEMA.$id, TEMPLATE_DOCUMENT_SCHEMA_ID);
});

test("template document import rejects unknown properties and unsafe dimensions", () => {
  const valid = exportTemplateDocument(row);
  assert.deepEqual(normalizeTemplateDocument(JSON.stringify(valid)), valid);
  assert.throws(
    () => normalizeTemplateDocument({ ...valid, secret: "must-not-pass" }),
    (error) => error.code === "INVALID_TEMPLATE_DOCUMENT",
  );
  assert.throws(
    () => normalizeTemplateDocument({
      ...valid,
      template: { ...valid.template, defaultSize: "<script>" },
    }),
    (error) => error.code === "INVALID_TEMPLATE_DOCUMENT",
  );
});
