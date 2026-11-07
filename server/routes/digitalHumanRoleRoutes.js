import express from "express";
import path from "node:path";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import {
  listDigitalHumanRoles,
  createDigitalHumanRole,
  uploadDigitalHumanRoleAsset,
  getDigitalHumanRoleByToken,
  completeDigitalHumanRoleCapture,
} from "../controllers/digitalHumanRoleController.js";
import { deleteOwnContentController } from "../controllers/contentRecycleController.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import { executeUserOperation } from "../services/userOperationService.js";
import { buildGrantedProxyUrl } from "../services/resourceAccessService.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_VIDEO_MAX_BYTES,
  attachTemporaryUploadCleanup,
  createSafeMediaUpload,
} from "../infrastructure/safeMultipartUpload.js";
import { uploadStagedMedia } from "../infrastructure/stagedObjectUpload.js";

const roleRouter = express.Router();
export const publicDigitalHumanRoleRouter = express.Router();
const objectStorage = getObjectStorage();
const uploadRoleAsset = createSafeMediaUpload({
  allowedKinds: ["image", "video"],
  files: 1,
  imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
  videoMaxBytes: DEFAULT_VIDEO_MAX_BYTES,
});

const CAPTURE_TOKEN_PATTERN = /^dh_[A-Za-z0-9_-]{43}$/;
const PRIVATE_ASSET_GRANT_TTL_SECONDS = 900;

const parseMetaInfo = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const getPublicBase = () => String(process.env.APP_BASE_URL || "").replace(/\/$/, "");

const isCaptureTokenActive = (role) => Boolean(
  role?.qr_token
  && CAPTURE_TOKEN_PATTERN.test(role.qr_token)
  && role.qr_token_expires_at
  && new Date(role.qr_token_expires_at).getTime() > Date.now()
  && !role.qr_token_claimed_at
  && !role.qr_token_consumed_at
  && !role.qr_token_revoked_at
);

const ownerAssetUrl = (objectKey, fallbackUrl, userId) => {
  if (!objectKey) return fallbackUrl || null;
  const url = buildGrantedProxyUrl({
    objectKey,
    userId,
    ttlSeconds: PRIVATE_ASSET_GRANT_TTL_SECONDS,
  });
  const base = getPublicBase();
  return base ? `${base}${url}` : url;
};

const serializeOwnerRole = (role) => {
  const captureActive = isCaptureTokenActive(role);
  const base = getPublicBase();
  return {
    id: role.id,
    role_name: role.role_name || "",
    role_description: role.role_description || "",
    prompt_text: role.prompt_text || "",
    status: role.status,
    avatar_url: ownerAssetUrl(role.avatar_object_key, role.avatar_url, role.user_id),
    demo_video_url: ownerAssetUrl(role.demo_video_object_key, role.demo_video_url, role.user_id),
    ready_at: role.ready_at || null,
    meta_info: parseMetaInfo(role.meta_info),
    capture_url: captureActive ? `${base || ""}/capture/digital-human/${role.qr_token}` : null,
    capture_expires_at: captureActive ? role.qr_token_expires_at : null,
    created_at: role.created_at,
    updated_at: role.updated_at,
  };
};

const publicAssetUrl = (uploaded) => {
  const base = getPublicBase();
  return base ? `${base}${uploaded.url}` : uploaded.url;
};

const uploadTemporaryRoleAsset = async (req, res) => {
  if (req.file?.storage !== "temporary") return uploadDigitalHumanRoleAsset(req, res);
  const { userId } = req.auth;
  const { id } = req.params;
  let uploadedObjectKey = null;
  try {
    const extension = String(req.file.validatedExtension || path.extname(req.file.originalname || ".mp4"))
      .replace(/^\./, "")
      .toLowerCase() || "mp4";
    const contentType = String(req.file.mimetype || "video/mp4");
    const data = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "digital_human.asset_uploaded",
      targetType: "digital_human_role",
      targetId: id,
      requestPayload: {
        role_id: id,
        asset_kind: "video",
        content_sha256: req.file.sha256,
        mime_type: contentType,
      },
      mutate: async (tx) => {
        const [role] = await tx`
          SELECT * FROM digital_human_roles
          WHERE id = ${id} AND user_id = ${userId}
          FOR UPDATE
        `;
        if (!role) throw Object.assign(new Error("Role not found"), { status: 404, code: "DIGITAL_HUMAN_ROLE_NOT_FOUND" });
        const objectKey = objectStorage.buildObjectKey(userId, `digital-human-role-${id}`, extension);
        const uploaded = await uploadStagedMedia({
          file: req.file,
          objectKey,
          contentType,
          objectStorage,
        });
        uploadedObjectKey = uploaded.objectKey;
        const [updated] = await tx`
          UPDATE digital_human_roles
          SET demo_video_url = ${publicAssetUrl(uploaded)},
              demo_video_object_key = ${uploaded.objectKey},
              status = 'training',
              ready_at = NOW() + INTERVAL '14 seconds',
              qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()),
              updated_at = NOW()
          WHERE id = ${id} AND user_id = ${userId}
          RETURNING *
        `;
        return serializeOwnerRole(updated);
      },
    });
    logger.info("digitalHumanRole.asset.uploaded", { userId, roleId: id, assetKind: "video" });
    return res.json({ success: true, data });
  } catch (error) {
    if (uploadedObjectKey) {
      await objectStorage.deleteObject(uploadedObjectKey).catch((cleanupError) => {
        logger.error("digitalHumanRole.asset.orphanCleanup.error", { roleId: id, error: cleanupError.message });
      });
    }
    logger.error("digitalHumanRole.asset.error", { userId, roleId: id, error: error.message });
    return res.status(error.status || 500).json({
      success: false,
      code: error.code,
      message: process.env.NODE_ENV === "production" && !error.status ? "Unable to update digital-human role" : error.message,
    });
  }
};

const completeTemporaryRoleCapture = async (req, res) => {
  if (req.file?.storage !== "temporary") return completeDigitalHumanRoleCapture(req, res);
  const token = String(req.params.token || "").trim();
  if (!CAPTURE_TOKEN_PATTERN.test(token)) {
    return res.status(404).json({ success: false, message: "Capture link is invalid or expired" });
  }

  const [existingRole] = await sql`
    UPDATE digital_human_roles
    SET qr_token_claimed_at = NOW(), updated_at = NOW()
    WHERE qr_token = ${token}
      AND qr_token_expires_at > NOW()
      AND qr_token_claimed_at IS NULL
      AND qr_token_consumed_at IS NULL
      AND qr_token_revoked_at IS NULL
    RETURNING *
  `;
  if (!existingRole) {
    return res.status(404).json({ success: false, message: "Capture link is invalid or expired" });
  }

  let uploaded = null;
  try {
    const extension = String(req.file.validatedExtension || path.extname(req.file.originalname || ".mp4"))
      .replace(/^\./, "")
      .toLowerCase() || "mp4";
    const contentType = String(req.file.mimetype || "video/mp4");
    const objectKey = objectStorage.buildObjectKey(
      existingRole.user_id,
      `digital-human-role-${existingRole.id}`,
      extension,
    );
    uploaded = await uploadStagedMedia({
      file: req.file,
      objectKey,
      contentType,
      objectStorage,
    });
    const [role] = await sql`
      UPDATE digital_human_roles
      SET demo_video_url = ${publicAssetUrl(uploaded)},
          demo_video_object_key = ${uploaded.objectKey},
          status = 'training',
          ready_at = NOW() + INTERVAL '14 seconds',
          qr_token_consumed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${existingRole.id}
        AND qr_token = ${token}
        AND qr_token_claimed_at IS NOT NULL
        AND qr_token_consumed_at IS NULL
        AND qr_token_revoked_at IS NULL
      RETURNING role_name, status, updated_at
    `;
    if (!role) {
      await objectStorage.deleteObject(uploaded.objectKey);
      return res.status(409).json({ success: false, message: "Capture link is no longer active" });
    }

    logger.info("digitalHumanRole.capture.complete", { roleId: existingRole.id, assetKind: "video" });
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      data: { role_name: role.role_name, status: role.status, submitted_at: role.updated_at },
    });
  } catch (error) {
    if (uploaded?.objectKey) {
      await objectStorage.deleteObject(uploaded.objectKey).catch(() => {});
    }
    await sql`
      UPDATE digital_human_roles
      SET qr_token_claimed_at = NULL, updated_at = NOW()
      WHERE id = ${existingRole.id}
        AND qr_token = ${token}
        AND qr_token_consumed_at IS NULL
        AND qr_token_revoked_at IS NULL
    `.catch(() => {});
    throw error;
  }
};

const requireIdempotencyKey = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid X-Idempotency-Key header is required" });
  }
  return next();
};

roleRouter.get("/roles", listDigitalHumanRoles);
roleRouter.post("/roles", createDigitalHumanRole);
roleRouter.post("/roles/:id/assets", requireIdempotencyKey, uploadRoleAsset.single("asset"), attachTemporaryUploadCleanup, uploadTemporaryRoleAsset);
roleRouter.delete("/roles/:resourceId", requireIdempotencyKey, (req, res) => {
  req.params.resourceType = "digital_human";
  return deleteOwnContentController(req, res);
});

// Public capture flow for phone upload.
publicDigitalHumanRoleRouter.get("/capture/:token", getDigitalHumanRoleByToken);
publicDigitalHumanRoleRouter.post("/capture/:token", uploadRoleAsset.single("asset"), attachTemporaryUploadCleanup, completeTemporaryRoleCapture);

export default roleRouter;
