import { createHash } from "node:crypto";
import { TEMPLATE_GENERATION_POINTS } from "../domain/pricing/templatePricingPolicy.js";
import { applyTemplateModelDefaults, userTemplatePublication } from "../domain/templates/templateEditingPolicy.js";

import { exportTemplateDocument, normalizeTemplateDocument } from "../domain/templates/templateDocument.js";
import { normalizeTemplateRow, normalizeTemplateTags } from "../utils/templateData.js";
import { resolveTemplateModelSelection } from "./modelConfigurationService.js";

const fail = (message, code, status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

const text = (value, label, max, { required = true } = {}) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) fail(`${label} is required`, "INVALID_PRIVATE_TEMPLATE");
  if (normalized.length > max) fail(`${label} is too long`, "INVALID_PRIVATE_TEMPLATE");
  return normalized;
};

const booleanValue = (value, fallback = false) => typeof value === "boolean" ? value : fallback;
const pointsCost = () => TEMPLATE_GENERATION_POINTS;

const deterministicSceneKey = ({ userId, idempotencyKey }) => {
  const digest = createHash("sha256").update(`${userId}\0${idempotencyKey}`).digest("hex").slice(0, 24);
  return `user_agent_${digest}`;
};

const upsertChargeRule = async ({ tx, template }) => {
  const cost = pointsCost(template.output_type);
  if (!Number.isSafeInteger(cost) || cost <= 0) fail("Private template pricing is invalid", "PRIVATE_TEMPLATE_PRICING_INVALID", 503);
  const [existing] = await tx`
    SELECT id FROM generation_charge_rules
    WHERE output_type = ${template.output_type} AND provider = ${template.target_provider}
      AND scene_key = ${template.scene_key} AND model IS NULL AND seconds IS NULL
      AND size IS NULL
      AND generation_mode = 'template'
    ORDER BY priority ASC, id ASC LIMIT 1
  `;
  if (existing) {
    await tx`
      UPDATE generation_charge_rules
      SET points_cost = ${cost}, priority = 20, generation_mode = 'template', is_active = TRUE, updated_at = NOW()
      WHERE id = ${existing.id}
    `;
    return;
  }
  await tx`
    INSERT INTO generation_charge_rules
      (output_type, provider, scene_key, model, seconds, size, points_cost, priority, generation_mode, meta_rule)
    VALUES
      (${template.output_type}, ${template.target_provider}, ${template.scene_key},
       NULL, NULL, NULL, ${cost}, 20, 'template', '{}'::jsonb)
  `;
};

const normalizeCreateInput = (input = {}) => {
  const outputType = text(input.outputType || input.output_type, "outputType", 20).toLowerCase();
  if (!new Set(["image", "video"]).has(outputType)) fail("outputType must be image or video", "INVALID_PRIVATE_TEMPLATE_OUTPUT_TYPE");
  return {
    sceneName: text(input.sceneName || input.scene_name, "sceneName", 160),
    outputType,
    defaultModel: text(input.defaultModel || input.default_model || "", "defaultModel", 120, { required: false }),
    defaultSeconds: outputType === "video" && (input.defaultSeconds ?? input.default_seconds) != null ? Number(input.defaultSeconds ?? input.default_seconds) : null,
    defaultSize: text(input.defaultSize || input.default_size || "", "defaultSize", 80, { required: false }),
    systemPrompt: text(input.systemPrompt || input.system_prompt, "systemPrompt", 12000),
    previewTitle: text(input.previewTitle || input.preview_title || "", "previewTitle", 160, { required: false }),
    previewDescription: text(input.previewDescription || input.preview_description || "", "previewDescription", 1000, { required: false }),
    starterPrompt: text(input.starterPrompt || input.starter_prompt || "", "starterPrompt", 4000, { required: false }),
    placeholderText: text(input.placeholderText || input.placeholder_text || "", "placeholderText", 500, { required: false }),
    requiresReference: booleanValue(input.requiresReference ?? input.requires_reference),
    tags: normalizeTemplateTags(input.tags),
  };
};

export class UserTemplateAgentService {
  constructor({ sqlClient, operationExecutor, deleteContent, modelResolver = resolveTemplateModelSelection } = {}) {
    if (!sqlClient) throw new TypeError("sqlClient is required");
    if (typeof operationExecutor !== "function") throw new TypeError("operationExecutor is required");
    if (typeof deleteContent !== "function") throw new TypeError("deleteContent is required");
    this.sql = sqlClient;
    this.operationExecutor = operationExecutor;
    this.deleteContent = deleteContent;
    this.resolveModel = modelResolver;
  }

  async create({ userId, input, idempotencyKey }) {
    let template = normalizeCreateInput(input);
    const sceneKey = deterministicSceneKey({ userId, idempotencyKey });
    const row = await this.operationExecutor({
      userId,
      idempotencyKey,
      action: "template.created",
      targetType: "prompt_template",
      targetId: sceneKey,
      requestPayload: template,
      mutate: async (tx) => {
        const model = await this.resolveModel({
          modelKey: template.defaultModel,
          outputType: template.outputType,
          userId,
          db: tx,
        });
        let catalog;
        if (!template.defaultSize || (template.outputType === "video" && template.defaultSeconds == null)) {
          [catalog] = await tx`SELECT capabilities, resolutions FROM model_catalog WHERE model_key = ${model.modelKey} AND output_type = ${template.outputType} LIMIT 1`;
        }
        template = applyTemplateModelDefaults(template, catalog);
        const [created] = await tx`
          INSERT INTO prompt_templates
            (scene_key, scene_name, output_type, target_provider, default_model,
             default_seconds, default_size, system_prompt, display_order, is_featured,
             featured_order, preview_title, preview_description, starter_prompt,
             placeholder_text, requires_reference, tags, owner_user_id, visibility,
             approval_status, required_membership_tier, version)
          VALUES
            (${sceneKey}, ${template.sceneName}, ${template.outputType}, ${model.targetProvider},
             ${model.modelKey}, ${template.defaultSeconds}, ${template.defaultSize || null},
             ${template.systemPrompt}, 0, FALSE, 0, ${template.previewTitle || null},
             ${template.previewDescription || null}, ${template.starterPrompt || null},
             ${template.placeholderText || null}, ${template.requiresReference}, ${tx.json(template.tags)},
             ${userId}, 'public', 'approved', 'free', 1)
          RETURNING *
        `;
        await upsertChargeRule({ tx, template: created });
        return created;
      },
    });
    return normalizeTemplateRow(row);
  }

  async import({ userId, document, idempotencyKey }) {
    const normalized = normalizeTemplateDocument(document);
    return this.create({
      userId,
      idempotencyKey,
      input: {
        sceneName: normalized.template.sceneName,
        outputType: normalized.template.outputType,
        defaultModel: normalized.template.defaultModel,
        defaultSeconds: normalized.template.defaultSeconds,
        defaultSize: normalized.template.defaultSize,
        systemPrompt: normalized.template.systemPrompt,
        previewTitle: normalized.template.previewTitle,
        previewDescription: normalized.template.previewDescription,
        starterPrompt: normalized.template.starterPrompt,
        placeholderText: normalized.template.placeholderText,
        requiresReference: normalized.template.requiresReference,
        tags: normalized.template.tags,
      },
    });
  }

  async update({ userId, templateId, patch, idempotencyKey }) {
    const id = text(templateId, "templateId", 255);
    const requestPatch = patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {};
    const row = await this.operationExecutor({
      userId,
      idempotencyKey,
      action: "template.updated",
      targetType: "prompt_template",
      targetId: id,
      requestPayload: requestPatch,
      mutate: async (tx) => {
        const [existing] = await tx`
          SELECT * FROM prompt_templates
          WHERE id::text = ${id} AND owner_user_id = ${userId} AND is_active = TRUE
          FOR UPDATE
        `;
        if (!existing) fail("Private template not found", "PRIVATE_TEMPLATE_NOT_FOUND", 404);
        const sameOutput = (requestPatch.outputType ?? existing.output_type) === existing.output_type;
        let merged = normalizeCreateInput({
          sceneName: requestPatch.sceneName ?? existing.scene_name,
          outputType: requestPatch.outputType ?? existing.output_type,
          defaultModel: requestPatch.defaultModel ?? (sameOutput ? existing.default_model : ""),
          defaultSeconds: requestPatch.defaultSeconds ?? (sameOutput ? existing.default_seconds : null),
          defaultSize: requestPatch.defaultSize ?? (sameOutput ? existing.default_size : ""),
          systemPrompt: requestPatch.systemPrompt ?? existing.system_prompt,
          previewTitle: requestPatch.previewTitle ?? existing.preview_title,
          previewDescription: requestPatch.previewDescription ?? existing.preview_description,
          starterPrompt: requestPatch.starterPrompt ?? existing.starter_prompt,
          placeholderText: requestPatch.placeholderText ?? existing.placeholder_text,
          requiresReference: requestPatch.requiresReference ?? existing.requires_reference,
          tags: requestPatch.tags ?? existing.tags,
        });
        const model = await this.resolveModel({
          modelKey: merged.defaultModel,
          outputType: merged.outputType,
          userId,
          db: tx,
        });
        let catalog;
        if (!merged.defaultSize || (merged.outputType === "video" && merged.defaultSeconds == null)) {
          [catalog] = await tx`SELECT capabilities, resolutions FROM model_catalog WHERE model_key = ${model.modelKey} AND output_type = ${merged.outputType} LIMIT 1`;
        }
        merged = applyTemplateModelDefaults(merged, catalog);
        const publication = userTemplatePublication(existing, existing.is_active);
        const [updated] = await tx`
          UPDATE prompt_templates
          SET scene_name = ${merged.sceneName}, output_type = ${merged.outputType},
              target_provider = ${model.targetProvider}, default_model = ${model.modelKey},
              default_seconds = ${merged.defaultSeconds}, default_size = ${merged.defaultSize || null},
              system_prompt = ${merged.systemPrompt}, preview_title = ${merged.previewTitle || null},
              preview_description = ${merged.previewDescription || null},
              starter_prompt = ${merged.starterPrompt || null}, placeholder_text = ${merged.placeholderText || null},
              requires_reference = ${merged.requiresReference}, tags = ${tx.json(merged.tags)},
              visibility = ${publication.visibility}, approval_status = ${publication.approvalStatus}, is_active = ${publication.isActive},
              version = COALESCE(version, 1) + 1, updated_at = NOW()
          WHERE id::text = ${id} AND owner_user_id = ${userId}
          RETURNING *
        `;
        await upsertChargeRule({ tx, template: updated });
        return updated;
      },
    });
    return normalizeTemplateRow(row);
  }

  async export({ userId, templateId }) {
    const id = text(templateId, "templateId", 255);
    const [row] = await this.sql`
      SELECT * FROM prompt_templates
      WHERE id::text = ${id} AND is_active = TRUE
        AND (owner_user_id = ${userId} OR (visibility = 'public' AND approval_status = 'approved'))
      LIMIT 1
    `;
    if (!row) fail("Template not found", "TEMPLATE_NOT_FOUND", 404);
    return exportTemplateDocument(normalizeTemplateRow(row));
  }

  async remove({ userId, templateId, idempotencyKey }) {
    return this.deleteContent({
      userId,
      resourceType: "private_template",
      resourceId: text(templateId, "templateId", 255),
      idempotencyKey,
    });
  }
}
