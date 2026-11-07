import sql from "../configs/db.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import logger from "../configs/logger.js";
import path from "path";
import { createHash, randomBytes } from "crypto";
import { buildGrantedProxyUrl } from "../services/resourceAccessService.js";
import { executeUserOperation } from "../services/userOperationService.js";

const objectStorage = getObjectStorage();

const CAPTURE_TOKEN_TTL_HOURS = 24;
const PRIVATE_ASSET_GRANT_TTL_SECONDS = 900;
const CAPTURE_TOKEN_PATTERN = /^dh_[A-Za-z0-9_-]{43}$/;

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

const IMAGE_EXTENSION_TO_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const parseMetaInfo = (value) => {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const normalizeRoleRow = (row) => ({
  ...row,
  meta_info: parseMetaInfo(row?.meta_info),
  role_name: row?.role_name || "",
  role_description: row?.role_description || "",
  prompt_text: row?.prompt_text || "",
  avatar_url: row?.avatar_url || null,
  demo_video_url: row?.demo_video_url || null,
});

export const createCaptureToken = () => `dh_${randomBytes(32).toString("base64url")}`;

export const isCaptureTokenActive = (role) => Boolean(
  role?.qr_token
  && CAPTURE_TOKEN_PATTERN.test(role.qr_token)
  && role.qr_token_expires_at
  && new Date(role.qr_token_expires_at).getTime() > Date.now()
  && !role.qr_token_claimed_at
  && !role.qr_token_consumed_at
  && !role.qr_token_revoked_at
);

const resolveUploadFormat = (file, assetKind) => {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  const mimetype = String(file?.mimetype || "").toLowerCase();

  if (assetKind === "video") {
    if (VIDEO_EXTENSION_TO_MIME[ext]) {
      return { ext: ext.slice(1), mimetype: mimetype.startsWith("video/") ? mimetype : VIDEO_EXTENSION_TO_MIME[ext] };
    }
    return { ext: "mp4", mimetype: mimetype.startsWith("video/") ? mimetype : "video/mp4" };
  }

  if (IMAGE_EXTENSION_TO_MIME[ext]) {
    return { ext: ext.slice(1), mimetype: mimetype.startsWith("image/") ? mimetype : IMAGE_EXTENSION_TO_MIME[ext] };
  }
  return { ext: "jpg", mimetype: mimetype.startsWith("image/") ? mimetype : "image/jpeg" };
};

const isVideoUpload = (file) => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  if (mimetype.startsWith("video/")) return true;
  const ext = path.extname(file?.originalname || "").toLowerCase();
  return Boolean(VIDEO_EXTENSION_TO_MIME[ext]);
};

const getPublicBase = () => (process.env.APP_BASE_URL || "").replace(/\/$/, "");

const buildPublicAssetUrl = (uploaded) => {
  const base = getPublicBase();
  return base ? `${base}${uploaded.url}` : uploaded.url;
};

const makeCaptureUrl = (token) => {
  const base = getPublicBase();
  return `${base || ""}/capture/digital-human/${token}`;
};

const makeOwnerAssetUrl = (objectKey, fallbackUrl, userId) => {
  if (!objectKey) return fallbackUrl || null;
  const url = buildGrantedProxyUrl({
    objectKey,
    userId,
    ttlSeconds: PRIVATE_ASSET_GRANT_TTL_SECONDS,
  });
  const base = getPublicBase();
  return base ? `${base}${url}` : url;
};

const serializeOwnerRole = (inputRole) => {
  const role = normalizeRoleRow(inputRole);
  return {
    id: role.id,
    role_name: role.role_name,
    role_description: role.role_description,
    prompt_text: role.prompt_text,
    status: role.status,
    avatar_url: makeOwnerAssetUrl(role.avatar_object_key, role.avatar_url, role.user_id),
    demo_video_url: makeOwnerAssetUrl(role.demo_video_object_key, role.demo_video_url, role.user_id),
    ready_at: role.ready_at || null,
    meta_info: role.meta_info,
    capture_url: isCaptureTokenActive(role) ? makeCaptureUrl(role.qr_token) : null,
    capture_expires_at: isCaptureTokenActive(role) ? role.qr_token_expires_at : null,
    created_at: role.created_at,
    updated_at: role.updated_at,
  };
};

const serializePublicCaptureRole = (role) => ({
  role_name: role.role_name || "",
  capture_expires_at: role.qr_token_expires_at,
  accepted_asset_kinds: ["image", "video"],
  max_file_size_bytes: 200 * 1024 * 1024,
});

const isSupportedUpload = (file) => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();
  return mimetype.startsWith("image/")
    ? Boolean(IMAGE_EXTENSION_TO_MIME[ext])
    : mimetype.startsWith("video/") && Boolean(VIDEO_EXTENSION_TO_MIME[ext]);
};

const buildRoleStatus = (role) => {
  const status = String(role?.status || "collecting");
  if (status === "training" && role?.ready_at && new Date(role.ready_at).getTime() <= Date.now()) {
    return "ready";
  }
  return status;
};

const normalizeRoleWithStatus = async (role) => {
  const computedStatus = buildRoleStatus(role);
  if (computedStatus === "ready" && role.status === "training") {
    const [updated] = await sql`
      UPDATE digital_human_roles
      SET status = 'ready',
          updated_at = NOW()
      WHERE id = ${role.id}
      RETURNING *
    `;
    return normalizeRoleRow(updated);
  }
  return normalizeRoleRow({ ...role, status: computedStatus });
};

export const listDigitalHumanRoles = async (req, res) => {
  const { userId } = req.auth;
  const roles = await sql`
    SELECT *
    FROM digital_human_roles
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `;

  const data = [];
  for (const role of roles) {
    const normalized = await normalizeRoleWithStatus(role);
    data.push(serializeOwnerRole(normalized));
  }

  res.json({
    success: true,
    data,
  });
};

export const createDigitalHumanRole = async (req, res) => {
  const { userId } = req.auth;
  const roleName = String(req.body?.role_name || "").trim();
  const roleDescription = String(req.body?.role_description || "").trim();
  const promptText = String(req.body?.prompt_text || "").trim();

  if (!roleName) {
    return res.status(400).json({ success: false, message: "role_name is required" });
  }

  const qrToken = createCaptureToken();

  const [role] = await sql`
    INSERT INTO digital_human_roles
      (user_id, role_name, role_description, prompt_text, status, qr_token,
       qr_token_issued_at, qr_token_expires_at)
    VALUES
      (${userId}, ${roleName}, ${roleDescription || null}, ${promptText || null}, 'collecting', ${qrToken},
       NOW(), NOW() + (${CAPTURE_TOKEN_TTL_HOURS} * INTERVAL '1 hour'))
    RETURNING *
  `;

  logger.info("digitalHumanRole.create", { userId, roleId: role.id });

  res.json({
    success: true,
    data: serializeOwnerRole(role),
  });
};

export const uploadDigitalHumanRoleAsset = async (req, res) => {
  const { userId } = req.auth;
  const { id } = req.params;
  const kind = String(req.headers["x-role-asset-kind"] || "").toLowerCase();
  const captureAction = String(req.headers["x-role-capture-action"] || req.body?.capture_action || "").toLowerCase();
  const file = req.file;
  let uploadedObjectKey = null;

  try {
    if (captureAction) {
      if (!new Set(["revoke", "rotate"]).has(captureAction)) {
        return res.status(400).json({ success: false, message: "capture action must be revoke or rotate" });
      }
      const data = await executeUserOperation({
        userId,
        idempotencyKey: req.headers["x-idempotency-key"],
        action: `digital_human.capture_${captureAction}`,
        targetType: "digital_human_role",
        targetId: id,
        requestPayload: { role_id: id, capture_action: captureAction },
        mutate: async (tx) => {
          const [role] = await tx`
            SELECT * FROM digital_human_roles
            WHERE id = ${id} AND user_id = ${userId}
            FOR UPDATE
          `;
          if (!role) throw Object.assign(new Error("Role not found"), { status: 404, code: "DIGITAL_HUMAN_ROLE_NOT_FOUND" });
          if (role.qr_token_claimed_at && !role.qr_token_consumed_at && !role.qr_token_revoked_at) {
            throw Object.assign(new Error("Capture upload is already in progress"), { status: 409, code: "DIGITAL_HUMAN_CAPTURE_IN_PROGRESS" });
          }
          const nextToken = captureAction === "rotate" ? createCaptureToken() : role.qr_token;
          const [updated] = captureAction === "rotate"
            ? await tx`
                UPDATE digital_human_roles
                SET qr_token = ${nextToken},
                    qr_token_issued_at = NOW(),
                    qr_token_expires_at = NOW() + (${CAPTURE_TOKEN_TTL_HOURS} * INTERVAL '1 hour'),
                    qr_token_claimed_at = NULL,
                    qr_token_consumed_at = NULL,
                    qr_token_revoked_at = NULL,
                    updated_at = NOW()
                WHERE id = ${id} AND user_id = ${userId}
                RETURNING *
              `
            : await tx`
                UPDATE digital_human_roles
                SET qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()),
                    updated_at = NOW()
                WHERE id = ${id} AND user_id = ${userId}
                RETURNING *
              `;
          return serializeOwnerRole(updated);
        },
      });
      logger.info(`digitalHumanRole.capture.${captureAction}`, { userId, roleId: id });
      return res.json({ success: true, data });
    }

    if (!file) {
      return res.status(400).json({ success: false, message: "asset file is required" });
    }
    if (!isSupportedUpload(file)) {
      return res.status(415).json({ success: false, message: "Unsupported image or video format" });
    }

    const assetKind = kind === "video" || isVideoUpload(file) ? "video" : "image";
    const { ext, mimetype } = resolveUploadFormat(file, assetKind);
    const contentSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const data = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "digital_human.asset_uploaded",
      targetType: "digital_human_role",
      targetId: id,
      requestPayload: {
        role_id: id,
        asset_kind: assetKind,
        content_sha256: contentSha256,
        mime_type: mimetype,
      },
      mutate: async (tx) => {
        const [role] = await tx`
          SELECT * FROM digital_human_roles
          WHERE id = ${id} AND user_id = ${userId}
          FOR UPDATE
        `;
        if (!role) throw Object.assign(new Error("Role not found"), { status: 404, code: "DIGITAL_HUMAN_ROLE_NOT_FOUND" });
        const objectKey = objectStorage.buildObjectKey(userId, `digital-human-role-${id}`, ext);
        const uploaded = await objectStorage.uploadBuffer(file.buffer, objectKey, mimetype);
        uploadedObjectKey = uploaded.objectKey;
        const assetUrl = buildPublicAssetUrl(uploaded);
        const [updated] = assetKind === "video"
          ? await tx`
              UPDATE digital_human_roles
              SET demo_video_url = ${assetUrl},
                  demo_video_object_key = ${uploaded.objectKey},
                  status = 'training',
                  ready_at = NOW() + INTERVAL '14 seconds',
                  qr_token_revoked_at = COALESCE(qr_token_revoked_at, NOW()),
                  updated_at = NOW()
              WHERE id = ${id} AND user_id = ${userId}
              RETURNING *
            `
          : await tx`
              UPDATE digital_human_roles
              SET avatar_url = ${assetUrl},
                  avatar_object_key = ${uploaded.objectKey},
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

export const getDigitalHumanRoleByToken = async (req, res) => {
  const token = String(req.params.token || "").trim();
  if (!CAPTURE_TOKEN_PATTERN.test(token)) {
    return res.status(404).json({ success: false, message: "Capture link is invalid or expired" });
  }
  const [role] = await sql`
    SELECT role_name, qr_token_expires_at
    FROM digital_human_roles
    WHERE qr_token = ${token}
      AND qr_token_expires_at > NOW()
      AND qr_token_claimed_at IS NULL
      AND qr_token_consumed_at IS NULL
      AND qr_token_revoked_at IS NULL
    LIMIT 1
  `;

  if (!role) {
    return res.status(404).json({ success: false, message: "Capture link is invalid or expired" });
  }

  res.set("Cache-Control", "no-store");
  res.json({ success: true, data: serializePublicCaptureRole(role) });
};

export const completeDigitalHumanRoleCapture = async (req, res) => {
  const token = String(req.params.token || "").trim();
  const file = req.file || null;

  if (!CAPTURE_TOKEN_PATTERN.test(token) || !file || !isSupportedUpload(file)) {
    return res.status(!file ? 400 : 404).json({
      success: false,
      message: !file ? "asset file is required" : "Capture link is invalid or expired",
    });
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
    const isVideo = isVideoUpload(file);
    const { ext, mimetype } = resolveUploadFormat(file, isVideo ? "video" : "image");
    const objectKey = objectStorage.buildObjectKey(existingRole.user_id, `digital-human-role-${existingRole.id}`, ext);
    uploaded = await objectStorage.uploadBuffer(file.buffer, objectKey, mimetype);

    const [role] = isVideo
      ? await sql`
          UPDATE digital_human_roles
          SET demo_video_url = ${buildPublicAssetUrl(uploaded)},
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
        `
      : await sql`
          UPDATE digital_human_roles
          SET avatar_url = ${buildPublicAssetUrl(uploaded)},
              avatar_object_key = ${uploaded.objectKey},
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

    logger.info("digitalHumanRole.capture.complete", { roleId: existingRole.id, assetKind: isVideo ? "video" : "image" });
    res.set("Cache-Control", "no-store");
    return res.json({
      success: true,
      data: { role_name: role.role_name, status: role.status, submitted_at: role.updated_at },
    });
  } catch (err) {
    await sql`
      UPDATE digital_human_roles
      SET qr_token_claimed_at = NULL, updated_at = NOW()
      WHERE id = ${existingRole.id}
        AND qr_token = ${token}
        AND qr_token_consumed_at IS NULL
        AND qr_token_revoked_at IS NULL
    `.catch(() => {});
    throw err;
  }
};
