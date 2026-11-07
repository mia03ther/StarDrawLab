import express from "express";
import path from "path";
import { createHash } from "node:crypto";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import { normalizeTemplateRow, normalizeTemplateTags } from "../utils/templateData.js";
import { normalizeUploadedImage } from "../utils/imageUpload.js";
import { getScenes } from "../controllers/aiController.js";
import { cleanupUnreferencedObjects, deleteOwnContent } from "../services/contentRecycleService.js";
import { resolveTemplateModelSelection } from "../services/modelConfigurationService.js";
import { executeUserOperation } from "../services/userOperationService.js";
import {
  TEMPLATE_DOCUMENT_JSON_SCHEMA,
  exportTemplateDocument,
  normalizeTemplateDocument,
} from "../domain/templates/templateDocument.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_VIDEO_MAX_BYTES,
  attachTemporaryUploadCleanup,
  createSafeMediaUpload,
} from "../infrastructure/safeMultipartUpload.js";
import { uploadStagedMedia } from "../infrastructure/stagedObjectUpload.js";
import { imageQualityFromSizeSql } from "../domain/pricing/imageQuality.js";

import { TEMPLATE_GENERATION_POINTS } from "../domain/pricing/templatePricingPolicy.js";
import { normalizeTemplateEdit, applyTemplateModelDefaults, userTemplatePublication, templateManagementRow, isTemplateAdministrator } from "../domain/templates/templateEditingPolicy.js";

const templateStudioRouter = express.Router();
const objectStorage = getObjectStorage();
const templateImageQuality = imageQualityFromSizeSql(sql, sql`pt.default_size`);
const uploadTemplatePreview = createSafeMediaUpload({
  allowedKinds: ["image", "video"],
  files: 1,
  imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
  videoMaxBytes: DEFAULT_VIDEO_MAX_BYTES,
});

const VIDEO_EXTENSION_TO_MIME = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mkv": "video/x-matroska",
};

// Authenticated catalog: public approved templates plus the current user's
// private templates, so Canvas Agent can call both kinds safely.
templateStudioRouter.get("/catalog", getScenes);

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif"]);

const inferPreviewKind = (file, hintedKind = "") => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.startsWith("image/")) return "image";

  const ext = path.extname(file?.originalname || "").toLowerCase();
  if (VIDEO_EXTENSION_TO_MIME[ext]) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";

  if (hintedKind === "video" || hintedKind === "image") {
    return hintedKind;
  }

  return null;
};

const resolveVideoMimeType = (file) => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  if (mimetype.startsWith("video/")) return mimetype;
  const ext = path.extname(file?.originalname || "").toLowerCase();
  return VIDEO_EXTENSION_TO_MIME[ext] || "video/mp4";
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
};

const privateTemplatePointsCost = () => TEMPLATE_GENERATION_POINTS;
const prepareTemplateInput = async (body, existing, actor, key, db) => {
  let draft = normalizeTemplateEdit(body, existing, { userId: actor.userId, idempotencyKey: key });
  const selection = await resolveTemplateModelSelection({ modelKey: draft.defaultModel, outputType: draft.outputType, userId: isTemplateAdministrator(actor) ? null : actor.userId, db });
  let catalog;
  if (!draft.defaultSize || (draft.outputType === "video" && draft.defaultSeconds == null)) {
    [catalog] = await db`SELECT capabilities, resolutions FROM model_catalog WHERE model_key = ${selection.modelKey} AND output_type = ${draft.outputType} LIMIT 1`;
  }
  draft = applyTemplateModelDefaults(draft, catalog);
  return { ...draft, defaultModel: selection.modelKey, targetProvider: selection.targetProvider };
};


const requireIdempotencyKey = (req, res, next) => {
  if (!req.headers["x-idempotency-key"]) {
    return res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
  }
  next();
};

const upsertSceneChargeRule = async ({
  outputType,
  provider,
  sceneKey,
  pointsCost,
  priority,
  db = sql,
}) => {
  if (!Number.isSafeInteger(pointsCost) || pointsCost <= 0) {
    throw Object.assign(new Error("Private template pricing must be a positive safe integer"), {
      status: 503,
      code: "PRIVATE_TEMPLATE_PRICING_INVALID",
    });
  }
  const isDigitalHuman = String(provider || "").trim().toLowerCase() === "heygen_video_agent";
  const generationMode = isDigitalHuman ? "all" : "template";
  const metaRule = isDigitalHuman
    ? { billing_type: "per_minute", points_per_minute: pointsCost, role_creation_points: 0 }
    : {};

  const [existingRule] = await db`
    SELECT id
    FROM generation_charge_rules
    WHERE output_type = ${outputType}
      AND provider = ${provider}
      AND scene_key = ${sceneKey}
      AND model IS NULL
      AND seconds IS NULL
      AND size IS NULL
      AND generation_mode = ${generationMode}
    ORDER BY priority ASC, id ASC
    LIMIT 1
  `;

  if (existingRule) {
    await db`
      UPDATE generation_charge_rules
      SET points_cost = ${pointsCost},
          priority = ${priority ?? 20},
          generation_mode = ${generationMode},
          is_active = true,
          meta_rule = ${db.json(metaRule)},
          updated_at = NOW()
      WHERE id = ${existingRule.id}
    `;
    return;
  }

  await db`
    INSERT INTO generation_charge_rules
      (output_type, provider, scene_key, model, seconds, size, points_cost, priority, generation_mode, meta_rule)
    VALUES
      (${outputType}, ${provider}, ${sceneKey}, NULL, NULL, NULL, ${pointsCost}, ${priority ?? 20}, ${generationMode}, ${db.json(metaRule)})
  `;
};

const buildTemplatePreviewKey = (templateId, previewKind, contentHash, mimetype = "image/jpeg") => {
  const extMap = {
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-m4v": "m4v",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "video/mpeg": "mpeg",
  };
  const ext = extMap[mimetype] || (mimetype?.startsWith("video/") ? "mp4" : "jpg");
  const safeTemplateId = String(templateId).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeKind = previewKind === "video" ? "video" : "image";
  return `quickai/user-templates/${safeTemplateId}/${safeKind}_${contentHash}.${ext}`;
};

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

const enqueueTemplatePreviewCleanup = async (tx, { ownerUserId, templateId, objectKey }) => {
  if (!objectKey) return;
  await tx`
    INSERT INTO content_object_cleanup_jobs
      (owner_user_id, source_type, source_id, object_keys)
    VALUES
      (${String(ownerUserId)}, 'user_template_preview_replaced', ${String(templateId)}, ${tx.json([objectKey])})
  `;
};

templateStudioRouter.get("/prompt-templates", async (req, res) => {
  const manage = String(req.query.manage || "").trim();
  if (manage === "mine" || manage === "all") {
    const administrator = isTemplateAdministrator(req.auth);
    if (manage === "all" && !administrator) return res.status(403).json({ success: false, code: "USER_RBAC_DENIED", message: "Template management permission is required" });
    const rows = await sql`
      SELECT pt.* FROM prompt_templates pt
      WHERE (${manage === "mine"} AND pt.owner_user_id = ${req.auth.userId})
        OR (${manage === "all"} AND (pt.owner_user_id IS NULL OR pt.visibility = 'public'
          OR (pt.visibility = 'private' AND pt.approval_status = 'pending' AND pt.publication_requested_at IS NOT NULL)))
      ORDER BY pt.is_featured DESC, pt.featured_order ASC, pt.display_order ASC, pt.id ASC
    `;
    return res.json({ success: true, data: rows.map((row) => templateManagementRow(normalizeTemplateRow(row), req.auth)), meta: { can_manage_marketplace: administrator, publication_mode: "direct", template_points: TEMPLATE_GENERATION_POINTS } });
  }
  const marketplaceCatalog = String(req.query.catalog || "").trim().toLowerCase() === "marketplace";
  const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page || "1", 10) || 1));
  const pageSize = Math.max(12, Math.min(60, Number.parseInt(req.query.page_size || "48", 10) || 48));
  const search = String(req.query.search || "").trim().slice(0, 160);
  const outputType = ["image", "video"].includes(String(req.query.output_type || "").trim())
    ? String(req.query.output_type).trim()
    : null;
  const requestedTag = String(req.query.tag || "").trim().slice(0, 120);
  const requestedCategory = String(req.query.category || "").trim().slice(0, 120);
  const requestedModel = String(req.query.model || "").trim().slice(0, 100).toLowerCase();
  const sourceKey = marketplaceCatalog ? String(req.query.source_key || "").trim().slice(0, 120) : "";
  const visibility = marketplaceCatalog && req.query.visibility === "private" ? "private" : null;
  const offset = (page - 1) * pageSize;
  const searchDocument = sql`LOWER(CONCAT_WS(' ', pt.scene_key, pt.scene_name,
    pt.preview_title, pt.preview_description, pt.starter_prompt, pt.source_key,
    pt.catalog_metadata->>'category'))`;
  const selectedColumns = marketplaceCatalog
    ? sql`pt.id, pt.scene_key, pt.scene_name, pt.output_type, pt.target_provider,
           pt.default_model, pt.default_seconds, pt.default_size,
           pt.is_featured, pt.featured_order, pt.preview_title,
           pt.preview_description, pt.preview_image_url, pt.preview_video_url,
           pt.starter_prompt, pt.placeholder_text, pt.requires_reference, pt.tags,
           pt.owner_user_id, pt.visibility, pt.approval_status,
           pt.required_membership_tier, pt.version, pt.source_key,
           pt.source_item_id, pt.source_url, pt.catalog_metadata`
    : sql`pt.*`;
  const catalogSearch = marketplaceCatalog
    ? sql`AND (
        ${search}::text IS NULL
        OR ${searchDocument} % LOWER(${search})
        OR POSITION(LOWER(${search}) IN ${searchDocument}) > 0
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(pt.tags) = 'array' THEN pt.tags ELSE '[]'::jsonb END) tag
          WHERE POSITION(LOWER(${search}) IN LOWER(tag)) > 0
        )
      )
      AND (${outputType}::text IS NULL OR pt.output_type = ${outputType})
      AND (${requestedTag}::text = '' OR pt.tags @> jsonb_build_array(${requestedTag}::text))
      AND (${requestedCategory}::text = ''
        OR LOWER(COALESCE(pt.catalog_metadata->>'category', '')) = LOWER(${requestedCategory})
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(pt.tags) = 'array' THEN pt.tags ELSE '[]'::jsonb END) category_tag
          WHERE LOWER(category_tag) = LOWER(${requestedCategory})
        )
      )
      AND (${requestedModel}::text = '' OR LOWER(pt.default_model) = ${requestedModel})
      AND (${sourceKey}::text = '' OR pt.source_key = ${sourceKey})
      AND (${visibility}::text IS NULL OR pt.visibility = ${visibility})`
    : sql``;
  const limitClause = marketplaceCatalog ? sql`LIMIT ${pageSize} OFFSET ${offset}` : sql``;
  const relevanceColumn = marketplaceCatalog
    ? sql`, CASE WHEN ${search} = '' THEN 1 ELSE GREATEST(
        similarity(${searchDocument}, LOWER(${search})),
        CASE WHEN POSITION(LOWER(${search}) IN ${searchDocument}) > 0 THEN 0.75 ELSE 0 END
      ) END AS relevance`
    : sql``;
  const rows = await sql`
    SELECT ${selectedColumns}${relevanceColumn},
           gcr.points_cost
    FROM prompt_templates pt
    LEFT JOIN LATERAL (
      SELECT points_cost, meta_rule
      FROM generation_charge_rules
      WHERE output_type = pt.output_type
        AND provider = pt.target_provider
        AND (
          generation_mode = CASE
            WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
            WHEN pt.output_type IN ('image', 'video') THEN 'template'
            ELSE 'all'
          END
          OR generation_mode = 'all'
        )
        AND (scene_key = pt.scene_key OR scene_key IS NULL)
        AND (model = pt.default_model OR model IS NULL)
        AND (seconds = pt.default_seconds OR seconds IS NULL)
        AND (size = pt.default_size OR size IS NULL)
        AND (
          pt.output_type <> 'image'
          OR meta_rule->>'image_quality' IS NULL
          OR meta_rule->>'image_quality' = ${templateImageQuality}
        )
        AND is_active = true
      ORDER BY
        CASE WHEN generation_mode = CASE
          WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
          WHEN pt.output_type IN ('image', 'video') THEN 'template'
          ELSE 'all'
        END THEN 0 ELSE 1 END,
        priority ASC,
        ((scene_key IS NOT NULL)::int + (model IS NOT NULL)::int
         + (seconds IS NOT NULL)::int + (size IS NOT NULL)::int
         + CASE WHEN pt.output_type = 'image'
                AND meta_rule->>'image_quality' IS NOT NULL THEN 1 ELSE 0 END) DESC,
        id ASC
      LIMIT 1
    ) gcr ON true
      WHERE pt.is_active = true
      AND (
        (pt.visibility = 'public' AND pt.approval_status = 'approved')
        OR pt.owner_user_id = ${req.auth.userId}
      )
      ${catalogSearch}
    ORDER BY ${marketplaceCatalog ? sql`relevance DESC,` : sql``} pt.is_featured DESC, pt.featured_order ASC, pt.display_order ASC
    ${limitClause}
  `;
  if (!marketplaceCatalog) return res.json({ success: true, data: rows.map(normalizeTemplateRow) });
  const [countRow] = await sql`
    SELECT COUNT(*)::integer AS total
    FROM prompt_templates pt
    WHERE pt.is_active = true
      AND (
        (pt.visibility = 'public' AND pt.approval_status = 'approved')
        OR pt.owner_user_id = ${req.auth.userId}
      )
      ${catalogSearch}
  `;
  const includeFacets = String(req.query.include_facets || "").toLowerCase() === "true";
  const [categoryRows, tagRows] = includeFacets ? await Promise.all([
    sql`
      SELECT DISTINCT COALESCE(NULLIF(TRIM(pt.catalog_metadata->>'category'), ''), NULLIF(TRIM(pt.source_key), '')) AS value
      FROM prompt_templates pt
      WHERE pt.is_active = TRUE
        AND (
          (pt.visibility = 'public' AND pt.approval_status = 'approved')
          OR pt.owner_user_id = ${req.auth.userId}
        )
        AND COALESCE(NULLIF(TRIM(pt.catalog_metadata->>'category'), ''), NULLIF(TRIM(pt.source_key), '')) IS NOT NULL
      ORDER BY value ASC
      LIMIT 120
    `,
    sql`
      SELECT DISTINCT tag.value
      FROM prompt_templates pt
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(pt.tags) = 'array' THEN pt.tags ELSE '[]'::jsonb END
      ) tag(value)
      WHERE pt.is_active = TRUE
        AND (
          (pt.visibility = 'public' AND pt.approval_status = 'approved')
          OR pt.owner_user_id = ${req.auth.userId}
        )
        AND TRIM(tag.value) <> ''
      ORDER BY tag.value ASC
      LIMIT 200
    `,
  ]) : [[], []];
  const total = Number(countRow?.total || 0);
  return res.json({
    success: true,
    data: rows.map(normalizeTemplateRow),
    meta: {
      page,
      page_size: pageSize,
      total,
      has_more: offset + rows.length < total,
      ...(includeFacets ? { facets: {
        categories: categoryRows.map((row) => row.value).filter(Boolean),
        tags: tagRows.map((row) => row.value).filter(Boolean),
      } } : {}),
    },
  });
});

templateStudioRouter.get("/prompt-templates/schema", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  return res.json({ success: true, data: TEMPLATE_DOCUMENT_JSON_SCHEMA });
});

templateStudioRouter.get("/prompt-templates/:id/export", async (req, res) => {
  const [row] = await sql`
    SELECT *
    FROM prompt_templates
    WHERE id = ${req.params.id}
      AND is_active = TRUE
      AND (
        owner_user_id = ${req.auth.userId}
        OR (visibility = 'public' AND approval_status = 'approved')
      )
    LIMIT 1
  `;
  if (!row) return res.status(404).json({ success: false, message: "Template not found" });
  const document = exportTemplateDocument(normalizeTemplateRow(row));
  const filename = `${String(row.scene_key || "stardraw-template").replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
  res.set("Cache-Control", "no-store");
  res.set("Content-Disposition", `attachment; filename="${filename}"`);
  return res.json(document);
});

templateStudioRouter.get("/prompt-templates/:id", async (req, res) => {
  const identifier = String(req.params.id || "").trim();
  const [row] = await sql`
    SELECT pt.*, gcr.points_cost
    FROM prompt_templates pt
    LEFT JOIN LATERAL (
      SELECT points_cost, meta_rule
      FROM generation_charge_rules
      WHERE output_type = pt.output_type AND provider = pt.target_provider
        AND (
          generation_mode = CASE
            WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
            WHEN pt.output_type IN ('image', 'video') THEN 'template'
            ELSE 'all'
          END
          OR generation_mode = 'all'
        )
        AND (scene_key = pt.scene_key OR scene_key IS NULL)
        AND (model = pt.default_model OR model IS NULL)
        AND (seconds = pt.default_seconds OR seconds IS NULL)
        AND (size = pt.default_size OR size IS NULL)
        AND (
          pt.output_type <> 'image'
          OR meta_rule->>'image_quality' IS NULL
          OR meta_rule->>'image_quality' = ${templateImageQuality}
        )
        AND is_active = TRUE
      ORDER BY
        CASE WHEN generation_mode = CASE
          WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
          WHEN pt.output_type IN ('image', 'video') THEN 'template'
          ELSE 'all'
        END THEN 0 ELSE 1 END,
        priority ASC,
        ((scene_key IS NOT NULL)::int + (model IS NOT NULL)::int
         + (seconds IS NOT NULL)::int + (size IS NOT NULL)::int
         + CASE WHEN pt.output_type = 'image'
                AND meta_rule->>'image_quality' IS NOT NULL THEN 1 ELSE 0 END) DESC,
        id ASC LIMIT 1
    ) gcr ON TRUE
    WHERE (pt.id::text = ${identifier} OR pt.scene_key = ${identifier})
      AND pt.is_active = TRUE
      AND (pt.owner_user_id = ${req.auth.userId}
        OR (pt.visibility = 'public' AND pt.approval_status = 'approved'))
    LIMIT 1
  `;
  if (!row) return res.status(404).json({ success: false, message: "Template not found" });
  return res.json({ success: true, data: normalizeTemplateRow(row) });
});

templateStudioRouter.post("/prompt-templates/import", requireIdempotencyKey, async (req, res) => {
  const document = normalizeTemplateDocument(req.body);
  const operationKey = String(req.headers["x-idempotency-key"]);
  const ownerHash = createHash("sha256").update(String(req.auth.userId)).digest("hex").slice(0, 10);
  const importHash = createHash("sha256").update(`${req.auth.userId}\0${operationKey}`).digest("hex").slice(0, 20);
  const sceneKey = `user_import_${ownerHash}_${importHash}`;
  const template = document.template;

  const row = await executeUserOperation({
    userId: req.auth.userId,
    idempotencyKey: operationKey,
    action: "template.imported",
    targetType: "prompt_template",
    targetId: sceneKey,
    requestPayload: document,
    mutate: async (tx) => {
      const modelSelection = await resolveTemplateModelSelection({
        modelKey: template.defaultModel,
        outputType: template.outputType,
        userId: req.auth.userId,
        db: tx,
      });
      const [created] = await tx`
        INSERT INTO prompt_templates
          (scene_key, scene_name, output_type, target_provider, default_model,
           default_seconds, default_size, system_prompt, display_order, is_featured,
           featured_order, preview_title, preview_description, starter_prompt,
           placeholder_text, requires_reference, tags, owner_user_id, visibility,
           approval_status, required_membership_tier, version)
        VALUES
          (${sceneKey}, ${template.sceneName}, ${template.outputType}, ${modelSelection.targetProvider},
           ${modelSelection.modelKey}, ${template.defaultSeconds}, ${template.defaultSize || null},
           ${template.systemPrompt}, 0, FALSE, 0, ${template.previewTitle || null},
           ${template.previewDescription || null}, ${template.starterPrompt || null},
           ${template.placeholderText || null}, ${template.requiresReference}, ${tx.json(template.tags)},
           ${req.auth.userId}, 'public', 'approved', 'free', 1)
        RETURNING *
      `;
      await upsertSceneChargeRule({
        outputType: created.output_type,
        provider: created.target_provider,
        sceneKey: created.scene_key,
        pointsCost: privateTemplatePointsCost(created.output_type),
        priority: 20,
        db: tx,
      });
      return created;
    },
  });

  return res.status(201).json({ success: true, data: normalizeTemplateRow(row) });
});

templateStudioRouter.post("/prompt-templates", requireIdempotencyKey, async (req, res) => {
  const row = await executeUserOperation({
    userId: req.auth.userId, idempotencyKey: req.headers["x-idempotency-key"], action: "template.created", targetType: "prompt_template",
    targetId: req.body?.scene_key || "new-template", requestPayload: req.body || {},
    mutate: async (tx) => {
      const input = await prepareTemplateInput(req.body, null, req.auth, req.headers["x-idempotency-key"], tx);
      const [created] = await tx`
        INSERT INTO prompt_templates
          (scene_key, scene_name, output_type, target_provider, default_model, default_seconds, default_size,
           system_prompt, display_order, is_featured, featured_order, preview_title, preview_description,
           starter_prompt, placeholder_text, requires_reference, tags, owner_user_id, visibility, approval_status)
        VALUES
          (${input.sceneKey}, ${input.sceneName}, ${input.outputType}, ${input.targetProvider}, ${input.defaultModel}, ${input.defaultSeconds}, ${input.defaultSize},
           ${input.systemPrompt}, 0, FALSE, 0, ${input.previewTitle || null}, ${input.previewDescription || null},
           ${input.starterPrompt || null}, ${input.placeholderText || null}, ${input.requiresReference}, ${tx.json(input.tags)},
           ${req.auth.userId}, 'public', 'approved')
        RETURNING *
      `;
      await upsertSceneChargeRule({ outputType: created.output_type, provider: created.target_provider, sceneKey: created.scene_key, pointsCost: TEMPLATE_GENERATION_POINTS, priority: 20, db: tx });
      return created;
    },
  });
  res.json({ success: true, data: templateManagementRow(normalizeTemplateRow(row), req.auth) });
});

templateStudioRouter.put("/prompt-templates/:id", requireIdempotencyKey, async (req, res) => {
  const row = await executeUserOperation({
    userId: req.auth.userId, idempotencyKey: req.headers["x-idempotency-key"], action: "template.updated", targetType: "prompt_template", targetId: req.params.id, requestPayload: req.body || {},
    mutate: async (tx) => {
      const [existing] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} AND owner_user_id = ${req.auth.userId} FOR UPDATE`;
      if (!existing) throw Object.assign(new Error("Template not found"), { status: 404 });
      const input = await prepareTemplateInput(req.body, existing, req.auth, req.headers["x-idempotency-key"], tx);
      const publication = userTemplatePublication(existing, req.body?.is_active);
      const [updated] = await tx`
        UPDATE prompt_templates SET
          scene_key = ${existing.scene_key}, scene_name = ${input.sceneName}, version = COALESCE(version, 1) + 1,
          output_type = ${input.outputType}, target_provider = ${input.targetProvider}, default_model = ${input.defaultModel},
          default_seconds = ${input.defaultSeconds}, default_size = ${input.defaultSize}, system_prompt = ${input.systemPrompt},
          is_active = ${publication.isActive},
          preview_title = ${input.previewTitle || null}, preview_description = ${input.previewDescription || null},
          starter_prompt = ${input.starterPrompt || null}, placeholder_text = ${input.placeholderText || null},
          requires_reference = ${input.requiresReference}, tags = ${tx.json(input.tags)},
          visibility = ${publication.visibility}, approval_status = ${publication.approvalStatus},
          updated_at = NOW()
        WHERE id = ${req.params.id} AND owner_user_id = ${req.auth.userId} RETURNING *
      `;
      await upsertSceneChargeRule({ outputType: updated.output_type, provider: updated.target_provider, sceneKey: updated.scene_key, pointsCost: TEMPLATE_GENERATION_POINTS, priority: 20, db: tx });
      return updated;
    },
  });
  res.json({ success: true, data: templateManagementRow(normalizeTemplateRow(row), req.auth) });
});

// Compatibility with older clients: publishing is immediate, not a review queue.
templateStudioRouter.post("/prompt-templates/:id/request-public", requireIdempotencyKey, async (req, res) => {
  const row = await executeUserOperation({
    userId: req.auth.userId, idempotencyKey: req.headers["x-idempotency-key"], action: "template.publication_requested", targetType: "prompt_template", targetId: req.params.id, requestPayload: { template_id: req.params.id },
    mutate: async (tx) => {
      const [existing] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} AND owner_user_id = ${req.auth.userId} FOR UPDATE`;
      if (!existing) throw Object.assign(new Error("Template not found"), { status: 404 });
      const publication = userTemplatePublication(existing, true);
      if (publication.approvalStatus === "rejected") throw Object.assign(new Error("This template was taken down by an administrator"), { status: 409, code: "TEMPLATE_ADMINISTRATOR_HIDDEN" });
      const [updated] = await tx`UPDATE prompt_templates SET visibility = 'public', approval_status = 'approved', is_active = TRUE, publication_requested_at = NULL, updated_at = NOW() WHERE id = ${req.params.id} AND owner_user_id = ${req.auth.userId} RETURNING *`;
      return updated;
    },
  });
  res.json({ success: true, data: templateManagementRow(normalizeTemplateRow(row), req.auth) });
});

templateStudioRouter.post("/prompt-templates/:id/preview", requireIdempotencyKey, uploadTemplatePreview.single("preview"), attachTemporaryUploadCleanup, async (req, res) => {
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, message: "preview file is required" });
  }

  const hintedKind = String(req.headers["x-preview-asset-kind"] || "").toLowerCase();
  const previewKind = inferPreviewKind(req.file, hintedKind);
  if (!previewKind) {
    return res.status(400).json({ success: false, message: "Unsupported preview file type." });
  }

  const rawContentHash = req.file.sha256 || sha256Hex(req.file.buffer);
  let uploaded;
  let objectKey;
  try {
    const result = await executeUserOperation({
      userId: req.auth.userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "template.preview_updated",
      targetType: "prompt_template",
      targetId: id,
      requestPayload: {
        template_id: id,
        preview_kind: previewKind,
        content_sha256: rawContentHash,
      },
      mutate: async (tx) => {
      const [before] = await tx`
        SELECT * FROM prompt_templates
        WHERE id = ${id} AND owner_user_id = ${req.auth.userId}
        FOR UPDATE
      `;
      if (!before) throw Object.assign(new Error("Private template not found"), { status: 404 });
      const isVideo = previewKind === "video";
      let stagedFile = req.file;
      let uploadMimeType = req.file.mimetype;
      if (isVideo) {
        uploadMimeType = resolveVideoMimeType(req.file);
      } else {
        const normalizedPreview = await normalizeUploadedImage({
          buffer: req.file.buffer,
          mimetype: req.file.mimetype,
          originalname: req.file.originalname,
        });
        stagedFile = {
          ...req.file,
          buffer: normalizedPreview.buffer,
          size: normalizedPreview.buffer.length,
          storage: "memory",
        };
        uploadMimeType = normalizedPreview.mimetype;
      }
      const contentHash = isVideo
        ? sha256Hex(Buffer.from(`${previewKind}\0${uploadMimeType}\0${rawContentHash}`, "utf8"))
        : sha256Hex(Buffer.concat([
            Buffer.from(`${previewKind}\0${uploadMimeType}\0`, "utf8"),
            stagedFile.buffer,
          ]));
      objectKey = buildTemplatePreviewKey(id, previewKind, contentHash, uploadMimeType);
      uploaded = await uploadStagedMedia({
        file: stagedFile,
        objectKey,
        contentType: uploadMimeType,
        objectStorage,
      });
      const previousObjectKey = isVideo
        ? before.preview_video_object_key
        : before.preview_object_key;
      const [updated] = isVideo
        ? await tx`
            UPDATE prompt_templates
            SET preview_video_url = ${uploaded.url},
                preview_video_object_key = ${uploaded.objectKey},
                version = COALESCE(version, 1) + 1,
                updated_at = NOW()
            WHERE id = ${id} AND owner_user_id = ${req.auth.userId}
            RETURNING *
          `
        : await tx`
            UPDATE prompt_templates
            SET preview_image_url = ${uploaded.url},
                preview_object_key = ${uploaded.objectKey},
                version = COALESCE(version, 1) + 1,
                updated_at = NOW()
            WHERE id = ${id} AND owner_user_id = ${req.auth.userId}
            RETURNING *
          `;
      if (previousObjectKey && previousObjectKey !== uploaded.objectKey) {
        await enqueueTemplatePreviewCleanup(tx, {
          ownerUserId: req.auth.userId,
          templateId: id,
          objectKey: previousObjectKey,
        });
      }
      return { preview_kind: previewKind, data: normalizeTemplateRow(updated) };
      },
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (uploaded?.objectKey) {
      await cleanupUnreferencedObjects({
        ownerUserId: req.auth?.userId || "user-template-preview",
        sourceType: "user_template_preview_orphan",
        sourceId: id,
        objectKeys: [uploaded.objectKey],
      }).catch((cleanupError) => {
        logger.error("templateStudio.preview.orphan_cleanup_enqueue_failed", {
          templateId: id,
          objectKey,
          error: cleanupError.message,
        });
      });
    }
    throw error;
  }
});

templateStudioRouter.delete("/prompt-templates/:id", requireIdempotencyKey, async (req, res) => {
  const data = await deleteOwnContent({
    userId: req.auth.userId,
    resourceType: "private_template",
    resourceId: req.params.id,
    idempotencyKey: req.headers["x-idempotency-key"],
  });
  res.json({ success: true, data });
});

export default templateStudioRouter;
