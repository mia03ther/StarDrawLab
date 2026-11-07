/** Database-authoritative admin/root operations. */
import express from "express";
import path from "path";
import { createHash } from "node:crypto";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { rechargePoints } from "../services/pointsService.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import { normalizeTemplateRow, normalizeTemplateTags } from "../utils/templateData.js";
import { normalizeUploadedImage } from "../utils/imageUpload.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import { writeAuditLog } from "../services/auditService.js";
import { executeAdministratorOperation } from "../services/administratorOperationService.js";
import {
  deactivateGenerationChargeRule,
  listGenerationChargeRules,
  saveGenerationChargeRule,
} from "../services/generationChargeRuleService.js";
import { resolveTemplateModelSelection } from "../services/modelConfigurationService.js";
import { cleanupUnreferencedObjects, deleteContentAsAdministrator } from "../services/contentRecycleService.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_VIDEO_MAX_BYTES,
  attachTemporaryUploadCleanup,
  createSafeMediaUpload,
} from "../infrastructure/safeMultipartUpload.js";
import { uploadStagedMedia } from "../infrastructure/stagedObjectUpload.js";
import { imageQualityFromSizeSql } from "../domain/pricing/imageQuality.js";

import { TEMPLATE_GENERATION_POINTS } from "../domain/pricing/templatePricingPolicy.js";
import { normalizeTemplateEdit, applyTemplateModelDefaults, templateManagementRow, isTemplateAdministrator, isAdministratorEditableTemplate } from "../domain/templates/templateEditingPolicy.js";

const adminRouter = express.Router();
const objectStorage = getObjectStorage();

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

const adminTemplateImageQuality = imageQualityFromSizeSql(sql, sql`pt.default_size`);
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

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".heic", ".heif"]);
const MEMBERSHIP_TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);

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
  return `quickai/admin/templates/${safeTemplateId}/${safeKind}_${contentHash}.${ext}`;
};

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

const enqueueTemplatePreviewCleanup = async (tx, { ownerUserId, templateId, objectKey }) => {
  if (!objectKey) return;
  await tx`
    INSERT INTO content_object_cleanup_jobs
      (owner_user_id, source_type, source_id, object_keys)
    VALUES
      (${String(ownerUserId)}, 'template_preview_replaced', ${String(templateId)}, ${tx.json([objectKey])})
  `;
};

// ── Prompt Templates CRUD ──────────────────────
adminRouter.get("/prompt-templates", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), async (req, res) => {
  const rows = await sql`
    SELECT pt.*,
           gcr.points_cost
    FROM prompt_templates pt
    LEFT JOIN LATERAL (
      SELECT points_cost
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
        AND model IS NULL
        AND seconds IS NULL
        AND size IS NULL
        AND (
          pt.output_type <> 'image'
          OR meta_rule->>'image_quality' IS NULL
          OR meta_rule->>'image_quality' = ${adminTemplateImageQuality}
        )
        AND is_active = true
      ORDER BY
        CASE WHEN generation_mode = CASE
          WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
          WHEN pt.output_type IN ('image', 'video') THEN 'template'
          ELSE 'all'
        END THEN 0 ELSE 1 END,
        priority ASC, id ASC
      LIMIT 1
    ) gcr ON true
    WHERE (pt.owner_user_id IS NULL OR pt.visibility = 'public'
      OR (pt.visibility = 'private' AND pt.approval_status = 'pending' AND pt.publication_requested_at IS NOT NULL))
    ORDER BY pt.is_featured DESC, pt.featured_order ASC, pt.display_order ASC
  `;
  res.json({ success: true, data: rows.map((row) => templateManagementRow(normalizeTemplateRow(row), req.auth)) });
});

adminRouter.get("/prompt-templates/publication-requests", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), async (req, res) => {
  const rows = await sql`
    SELECT pt.*,
           gcr.points_cost
    FROM prompt_templates pt
    LEFT JOIN LATERAL (
      SELECT points_cost
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
        AND model IS NULL
        AND seconds IS NULL
        AND size IS NULL
        AND (
          pt.output_type <> 'image'
          OR meta_rule->>'image_quality' IS NULL
          OR meta_rule->>'image_quality' = ${adminTemplateImageQuality}
        )
        AND is_active = true
      ORDER BY
        CASE WHEN generation_mode = CASE
          WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
          WHEN pt.output_type IN ('image', 'video') THEN 'template'
          ELSE 'all'
        END THEN 0 ELSE 1 END,
        priority ASC, id ASC
      LIMIT 1
    ) gcr ON true
    WHERE pt.owner_user_id IS NOT NULL
      AND pt.visibility = 'private'
      AND pt.approval_status = 'pending'
      AND pt.publication_requested_at IS NOT NULL
    ORDER BY pt.publication_requested_at ASC NULLS LAST, pt.id ASC
  `;
  res.json({ success: true, data: rows.map(normalizeTemplateRow) });
});

// 公共幂等 header 检查中间件（所有写接口）
const requireIdempotencyKey = (req, res, next) => {
  if (!req.headers["x-idempotency-key"]) {
    return res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
  }
  next();
};

adminRouter.post("/prompt-templates", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, async (req, res) => {
  const row = await executeAdministratorOperation({
    actor: req.auth, idempotencyKey: req.headers["x-idempotency-key"], action: "template.created", targetType: "prompt_template", targetId: req.body?.scene_key || "new-template", requestPayload: req.body || {},
    mutate: async (tx) => {
      const input = await prepareTemplateInput(req.body, null, req.auth, req.headers["x-idempotency-key"], tx);
      if (!MEMBERSHIP_TIERS.has(input.requiredMembershipTier)) throw Object.assign(new Error("Invalid required membership tier"), { status: 400 });
      const [created] = await tx`
        INSERT INTO prompt_templates
          (scene_key, scene_name, output_type, target_provider, default_model, default_seconds, default_size,
           system_prompt, display_order, is_featured, featured_order, preview_title, preview_description,
           starter_prompt, placeholder_text, requires_reference, tags, owner_user_id, visibility, approval_status, required_membership_tier)
        VALUES (${input.sceneKey}, ${input.sceneName}, ${input.outputType}, ${input.targetProvider}, ${input.defaultModel}, ${input.defaultSeconds}, ${input.defaultSize},
          ${input.systemPrompt}, ${input.displayOrder}, ${input.isFeatured}, ${input.featuredOrder}, ${input.previewTitle || null}, ${input.previewDescription || null},
          ${input.starterPrompt || null}, ${input.placeholderText || null}, ${input.requiresReference}, ${tx.json(input.tags)}, NULL, 'public', 'approved', ${input.requiredMembershipTier})
        RETURNING *
      `;
      await writeAuditLog({ req, actorUserId: req.auth.userId, actorRole: req.auth.role, action: "template.created", targetType: "prompt_template", targetId: created.id, reason: req.body?.reason || "Template created", after: created, tx });
      return created;
    },
  });
  res.json({ success: true, data: templateManagementRow(normalizeTemplateRow(row), req.auth) });
});

adminRouter.put("/prompt-templates/:id", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, async (req, res) => {
  const row = await executeAdministratorOperation({
    actor: req.auth, idempotencyKey: req.headers["x-idempotency-key"], action: "template.updated", targetType: "prompt_template", targetId: req.params.id, requestPayload: req.body || {},
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} AND (owner_user_id IS NULL OR visibility = 'public' OR (visibility = 'private' AND approval_status = 'pending' AND publication_requested_at IS NOT NULL)) FOR UPDATE`;
      if (!isAdministratorEditableTemplate(before)) throw Object.assign(new Error("Template not found"), { status: 404 });
      const input = await prepareTemplateInput(req.body, before, req.auth, req.headers["x-idempotency-key"], tx);
      if (!MEMBERSHIP_TIERS.has(input.requiredMembershipTier)) throw Object.assign(new Error("Invalid required membership tier"), { status: 400 });
      const approval = before.owner_user_id && !input.isActive ? "rejected" : "approved";
      const [updated] = await tx`
        UPDATE prompt_templates SET scene_key = ${before.scene_key}, scene_name = ${input.sceneName}, version = COALESCE(version, 1) + 1,
          output_type = ${input.outputType}, target_provider = ${input.targetProvider}, default_model = ${input.defaultModel},
          default_seconds = ${input.defaultSeconds}, default_size = ${input.defaultSize}, system_prompt = ${input.systemPrompt},
          is_active = ${input.isActive}, display_order = ${input.displayOrder}, is_featured = ${input.isFeatured}, featured_order = ${input.featuredOrder},
          preview_title = ${input.previewTitle || null}, preview_description = ${input.previewDescription || null},
          starter_prompt = ${input.starterPrompt || null}, placeholder_text = ${input.placeholderText || null}, requires_reference = ${input.requiresReference}, tags = ${tx.json(input.tags)},
          visibility = 'public', approval_status = ${approval}, publication_requested_at = NULL, required_membership_tier = ${input.requiredMembershipTier}, updated_at = NOW()
        WHERE id = ${req.params.id} AND (owner_user_id IS NULL OR visibility = 'public' OR (visibility = 'private' AND approval_status = 'pending' AND publication_requested_at IS NOT NULL)) RETURNING *
      `;
      await writeAuditLog({ req, actorUserId: req.auth.userId, actorRole: req.auth.role, action: "template.updated", targetType: "prompt_template", targetId: before.id, reason: req.body?.reason || "Template updated", before, after: updated, tx });
      return updated;
    },
  });
  res.json({ success: true, data: templateManagementRow(normalizeTemplateRow(row), req.auth) });
});

adminRouter.post("/prompt-templates/:id/preview", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, uploadTemplatePreview.single("preview"), attachTemporaryUploadCleanup, async (req, res) => {
  const { id } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, message: "preview file is required" });
  }

  const hintedKind = String(req.headers["x-preview-asset-kind"] || "").toLowerCase();
  const previewKind = inferPreviewKind(req.file, hintedKind);
  if (!previewKind) {
    return res.status(400).json({ success: false, message: "Unsupported preview file type." });
  }

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
    ? sha256Hex(Buffer.from(`${previewKind}\0${uploadMimeType}\0${req.file.sha256}`, "utf8"))
    : sha256Hex(Buffer.concat([
        Buffer.from(`${previewKind}\0${uploadMimeType}\0`, "utf8"),
        stagedFile.buffer,
      ]));
  const objectKey = buildTemplatePreviewKey(id, previewKind, contentHash, uploadMimeType);
  let uploaded;
  try {
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "template.preview_updated",
      targetType: "prompt_template",
      targetId: id,
      requestPayload: {
        body: req.body || {},
        template_id: id,
        preview_kind: previewKind,
        content_hash: contentHash,
        content_type: uploadMimeType,
      },
      mutate: async (tx) => {
        const [before] = await tx`
          SELECT *
          FROM prompt_templates
          WHERE id = ${id} AND (owner_user_id IS NULL OR visibility = 'public' OR (visibility = 'private' AND approval_status = 'pending' AND publication_requested_at IS NOT NULL))
          FOR UPDATE
        `;
        if (!isAdministratorEditableTemplate(before)) throw Object.assign(new Error("Template not found"), { status: 404 });

        // The upload happens only after this idempotency key is claimed. The
        // content-addressed key also bounds orphan creation after DB failures.
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
              WHERE id = ${id} AND (owner_user_id IS NULL OR visibility = 'public' OR (visibility = 'private' AND approval_status = 'pending' AND publication_requested_at IS NOT NULL))
              RETURNING *
            `
          : await tx`
              UPDATE prompt_templates
              SET preview_image_url = ${uploaded.url},
                  preview_object_key = ${uploaded.objectKey},
                  version = COALESCE(version, 1) + 1,
                  updated_at = NOW()
              WHERE id = ${id} AND (owner_user_id IS NULL OR visibility = 'public' OR (visibility = 'private' AND approval_status = 'pending' AND publication_requested_at IS NOT NULL))
              RETURNING *
            `;

        if (previousObjectKey && previousObjectKey !== uploaded.objectKey) {
          // Do not delete OSS data in the DB transaction. The durable worker
          // re-checks references immediately before deletion.
          await enqueueTemplatePreviewCleanup(tx, {
            ownerUserId: before.owner_user_id || req.auth.userId,
            templateId: id,
            objectKey: previousObjectKey,
          });
        }

        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "template.preview_updated",
          targetType: "prompt_template",
          targetId: id,
          reason: req.body?.reason || "Template preview updated",
          before,
          after: updated,
          metadata: { preview_kind: previewKind, content_hash: contentHash },
          tx,
        });
        return { preview_kind: previewKind, data: normalizeTemplateRow(updated) };
      },
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    if (uploaded?.objectKey) {
      // The DB transaction may fail after the upload. Enqueue only the object
      // written by this attempt; the worker performs the final reference check.
      await cleanupUnreferencedObjects({
        ownerUserId: req.auth?.userId || "admin-preview",
        sourceType: "template_preview_orphan",
        sourceId: id,
        objectKeys: [uploaded.objectKey],
      }).catch((cleanupError) => {
        logger.error("admin.templatePreview.orphan_cleanup_enqueue_failed", {
          templateId: id,
          objectKey,
          error: cleanupError.message,
        });
      });
    }
    throw error;
  }
});

adminRouter.delete("/prompt-templates/:id", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, async (req, res) => {
  const data = await executeAdministratorOperation({
    actor: req.auth,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "template.deleted",
    targetType: "prompt_template",
    targetId: req.params.id,
    requestPayload: req.body || {},
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} FOR UPDATE`;
      if (!before) throw Object.assign(new Error("Template not found"), { status: 404 });
      if (before.owner_user_id && isAdministratorEditableTemplate(before)) {
        const reason = String(req.body?.reason || "Template taken down").trim();
        const [after] = await tx`UPDATE prompt_templates SET visibility = 'public', is_active = FALSE, approval_status = 'rejected', publication_review_note = ${reason}, updated_at = NOW() WHERE id = ${before.id} RETURNING *`;
        await writeAuditLog({ req, actorUserId: req.auth.userId, actorRole: req.auth.role, action: "template.deactivated", targetType: "prompt_template", targetId: before.id, reason, before, after, tx });
        return after;
      }
      if (before.owner_user_id) {
        const reason = String(req.body?.reason || "").trim();
        if (!reason) {
          throw Object.assign(new Error("reason is required"), { status: 400, code: "REASON_REQUIRED" });
        }
        return deleteContentAsAdministrator({
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          ownerUserId: before.owner_user_id,
          resourceType: "private_template",
          resourceId: before.id,
          reason,
          req,
          tx,
        });
      }
      const [after] = await tx`
        UPDATE prompt_templates SET is_active = FALSE, updated_at = NOW()
        WHERE id = ${before.id} AND owner_user_id IS NULL
        RETURNING id, scene_key, is_active
      `;
      await writeAuditLog({
        req, actorUserId: req.auth.userId, actorRole: req.auth.role,
        action: "template.deactivated", targetType: "prompt_template", targetId: before.id,
        reason: req.body?.reason || "Template deactivated", before, after, tx,
      });
      return after;
    },
  });
  return res.json({ success: true, data });
});

adminRouter.post("/prompt-templates/:id/approve-public", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, async (req, res) => {
  const requiredTier = String(req.body?.required_membership_tier || "free").trim().toLowerCase();
  if (!MEMBERSHIP_TIERS.has(requiredTier)) {
    return res.status(400).json({ success: false, message: "Invalid required membership tier" });
  }
  const note = String(req.body?.note || "").trim().slice(0, 2000) || null;
  const row = await executeAdministratorOperation({
    actor: req.auth,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "template.publication_approved",
    targetType: "prompt_template",
    targetId: req.params.id,
    requestPayload: req.body || {},
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} AND owner_user_id IS NOT NULL FOR UPDATE`;
      if (!before || before.visibility !== "private" || before.approval_status !== "pending" || !before.publication_requested_at) {
        throw Object.assign(new Error("Pending template request not found"), { status: 404 });
      }
      const [approved] = await tx`
        UPDATE prompt_templates
        SET visibility = 'public', approval_status = 'approved', is_active = true,
            required_membership_tier = ${requiredTier}, publication_reviewed_at = NOW(),
            publication_review_note = ${note}, updated_at = NOW()
        WHERE id = ${before.id} AND owner_user_id IS NOT NULL AND approval_status = 'pending'
        RETURNING *
      `;
      await writeAuditLog({
        req, actorUserId: req.auth.userId, actorRole: req.auth.role,
        action: "template.publication_approved", targetType: "prompt_template", targetId: before.id,
        reason: note || "Template publication approved", before, after: approved, tx,
      });
      return approved;
    },
  });
  res.json({ success: true, data: normalizeTemplateRow(row) });
});

adminRouter.post("/prompt-templates/:id/reject-public", requirePermission(PERMISSIONS.TEMPLATE_MANAGE), requireIdempotencyKey, async (req, res) => {
  const note = String(req.body?.note || "管理员拒绝公开").trim().slice(0, 2000) || "管理员拒绝公开";
  const row = await executeAdministratorOperation({
    actor: req.auth,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "template.publication_rejected",
    targetType: "prompt_template",
    targetId: req.params.id,
    requestPayload: req.body || {},
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM prompt_templates WHERE id = ${req.params.id} AND owner_user_id IS NOT NULL FOR UPDATE`;
      if (!before || before.visibility !== "private" || before.approval_status !== "pending" || !before.publication_requested_at) {
        throw Object.assign(new Error("Pending template request not found"), { status: 404 });
      }
      const [rejected] = await tx`
        UPDATE prompt_templates
        SET visibility = 'private', approval_status = 'rejected',
            publication_reviewed_at = NOW(), publication_review_note = ${note}, updated_at = NOW()
        WHERE id = ${before.id} AND owner_user_id IS NOT NULL AND approval_status = 'pending'
        RETURNING *
      `;
      await writeAuditLog({
        req, actorUserId: req.auth.userId, actorRole: req.auth.role,
        action: "template.publication_rejected", targetType: "prompt_template", targetId: before.id,
        reason: note, before, after: rejected, tx,
      });
      return rejected;
    },
  });
  res.json({ success: true, data: normalizeTemplateRow(row) });
});

// ── Generation Charge Rules CRUD ───────────────
adminRouter.get("/generation-charge-rules", requirePermission(PERMISSIONS.CHARGE_RULE_MANAGE), async (req, res) => {
  try {
    res.json({ success: true, data: await listGenerationChargeRules({ actor: req.auth }) });
  } catch (error) {
    logger.error("generation.charge_rules.list.failed", { error: error.message, code: error.code });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

adminRouter.post("/generation-charge-rules", requirePermission(PERMISSIONS.CHARGE_RULE_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await saveGenerationChargeRule({
      actor: req.auth,
      input: req.body,
      idempotencyKey: req.headers["x-idempotency-key"],
      reason: req.body?.reason || "Charge rule created",
      req,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error) {
    logger.error("generation.charge_rules.create.failed", { error: error.message, code: error.code });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

adminRouter.put("/generation-charge-rules/:id", requirePermission(PERMISSIONS.CHARGE_RULE_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await saveGenerationChargeRule({
      actor: req.auth,
      ruleId: req.params.id,
      input: req.body,
      idempotencyKey: req.headers["x-idempotency-key"],
      reason: req.body?.reason || "Charge rule updated",
      req,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("generation.charge_rules.update.failed", { error: error.message, code: error.code });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

adminRouter.delete("/generation-charge-rules/:id", requirePermission(PERMISSIONS.CHARGE_RULE_MANAGE), requireIdempotencyKey, async (req, res) => {
  try {
    const row = await deactivateGenerationChargeRule({
      actor: req.auth,
      ruleId: req.params.id,
      reason: req.body?.reason || "Charge rule deactivated",
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    res.json({ success: true, data: row });
  } catch (error) {
    logger.error("generation.charge_rules.deactivate.failed", { error: error.message, code: error.code });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
});

// ── Orders ─────────────────────────────────────
adminRouter.get("/orders", requirePermission(PERMISSIONS.ORDER_READ), async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || "1", 10));
  const page_size = Math.min(100, parseInt(req.query.page_size || "20", 10));
  const offset = (page - 1) * page_size;
  const rows = await sql`
    SELECT id, user_id, order_no, package_key, package_name, amount_cents,
           points, bonus_points, total_points, status, payment_method,
           created_at, paid_at, confirmed_at
    FROM point_orders
    ORDER BY created_at DESC LIMIT ${page_size} OFFSET ${offset}
  `;
  res.json({ success: true, data: rows, page, page_size });
});

// ── Manual Points Adjustment ───────────────────
adminRouter.post("/users/:userId/points/adjust", requirePermission(PERMISSIONS.POINTS_ADJUST), requireIdempotencyKey, async (req, res) => {
  const { userId } = req.params;
  const { amount, note } = req.body;
  const idempotencyKey = req.headers["x-idempotency-key"];

  const normalizedAmount = Number(amount);
  const normalizedNote = String(note || "").trim().slice(0, 2000);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount <= 0) {
    return res.status(400).json({ success: false, code: "INVALID_POINT_AMOUNT", message: "amount must be a positive safe integer" });
  }
  if (!normalizedNote) {
    return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: "note is required" });
  }

  try {
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey,
      action: "user.points_adjusted",
      targetType: "user",
      targetId: userId,
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const [before] = await tx`
          SELECT user_id, balance_points, held_points, membership_tier
          FROM user_point_accounts
          WHERE user_id = ${userId}
          FOR UPDATE
        `;
        const ledgerIdempotencyKey = `admin:adjust:${sha256Hex(Buffer.from(`${req.auth.userId}\0${userId}\0${idempotencyKey}`, "utf8"))}`;
        const adjustment = await rechargePoints({
          userId,
          amount: normalizedAmount,
          sourceType: "admin",
          sourceId: sha256Hex(Buffer.from(`${userId}\0${idempotencyKey}`, "utf8")),
          idempotencyKey: ledgerIdempotencyKey,
          note: normalizedNote,
          entryType: "manual_adjustment",
          tx,
        });
        const [after] = await tx`
          SELECT user_id, balance_points, held_points,
                 (balance_points - held_points) AS available_points,
                 membership_tier
          FROM user_point_accounts
          WHERE user_id = ${userId}
        `;
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "user.points_adjusted",
          targetType: "user",
          targetId: userId,
          reason: normalizedNote,
          before,
          after,
          metadata: { amount: normalizedAmount, ledger_id: adjustment.ledger?.id || null },
          tx,
        });
        return {
          user_id: userId,
          amount: normalizedAmount,
          ledger_id: adjustment.ledger?.id || null,
          account: after,
        };
      },
    });
    res.json({ success: true, data: result });
  } catch (err) {
    logger.error("admin.adjust.error", { userId, amount, error: err.message });
    res.status(err.status || 500).json({ success: false, code: err.code, message: err.message });
  }
});

export default adminRouter;
