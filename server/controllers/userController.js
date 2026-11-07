import { createHash } from "node:crypto";
import sql from "../configs/db.js";
import archiver from "archiver";
import { Parser } from "json2csv";
import axios from "axios";
import path from "path";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import logger from "../configs/logger.js";
import { releasePoints } from "../services/pointsService.js";
import { needsVideoReconciliation, syncVideoCreationStatus } from "../services/videoStatusService.js";
import { deleteOwnContent } from "../services/contentRecycleService.js";
import { executeUserOperation } from "../services/userOperationService.js";

const objectStorage = getObjectStorage();

const MAX_DISPLAY_NAME_LENGTH = 40;

const mimeToExtension = (file) => {
  const mime = String(file?.mimetype || "").toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";

  const originalExt = path.extname(file?.originalname || "").toLowerCase().replace(/^\./, "");
  return originalExt || "png";
};

const normalizeDisplayName = (value) => {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
};

const formatUserProfile = (profile, userId = null) => ({
  user_id: userId || profile?.user_id || null,
  display_name: profile?.display_name || null,
  avatar_url: profile?.avatar_url || null,
  email: profile?.email || null,
  username: profile?.username || null,
  phone: profile?.phone_number || null,
  full_name: profile?.full_name || null,
  gender: profile?.gender || null,
  birthdate: profile?.birthdate || null,
});

const parseMetaInfo = (metaInfo) => {
  // Old rows may hold JSON inside a JSON string. Unwrap a bounded number of
  // layers, then accept only an object so one malformed row cannot fail a list.
  let value = metaInfo;
  for (let depth = 0; depth < 4 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
};

const pickFirstString = (...candidates) => {
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) return item.trim();
        if (item && typeof item === "object" && typeof item.url === "string" && item.url.trim()) {
          return item.url.trim();
        }
      }
    }
  }
  return null;
};

const objectKeyToProxyUrl = (objectKey) => {
  if (typeof objectKey !== "string" || !objectKey.trim()) return null;
  const normalized = objectKey.trim().replace(/^\/+/, "");
  return `/oss-proxy/${normalized}`;
};

const isInternalAssetUrl = (value) =>
  typeof value === "string" &&
  (value.startsWith("/oss-proxy/") || value.startsWith("/api/proxy/oss/") || value.startsWith("/api/proxy/"));

const isDirectDataUrl = (value) => typeof value === "string" && value.startsWith("data:");

const isUnsafeExternalAssetUrl = (value) =>
  typeof value === "string" && /^https?:\/\//i.test(value) && !isInternalAssetUrl(value);

const extractObjectKeyFromProxyUrl = (value) => {
  if (typeof value !== "string" || !value.trim()) return null;

  const raw = value.trim();
  let pathname = raw;

  try {
    pathname = /^https?:\/\//i.test(raw)
      ? new URL(raw).pathname
      : new URL(raw, "http://localhost").pathname;
  } catch {
    pathname = raw.split("?", 1)[0];
  }

  const normalizedPath = pathname.replace(/\/{2,}/g, "/");
  const prefixes = ["/oss-proxy/", "/api/proxy/oss/", "/api/proxy/"];

  for (const prefix of prefixes) {
    if (!normalizedPath.startsWith(prefix)) continue;
    const encodedKey = normalizedPath.slice(prefix.length).replace(/^\/+/, "");
    if (!encodedKey) return null;
    try {
      return decodeURIComponent(encodedKey);
    } catch {
      return encodedKey;
    }
  }

  return null;
};

const getDerivedPreviewFields = (row) => {
  const meta = parseMetaInfo(row.meta_info);
  const providerRaw = meta.providerRaw || {};
  const providerResult = providerRaw.result || {};

  const referencePreviewUrl = pickFirstString(
    meta.reference_preview_url,
    meta.referencePreviewUrl,
    meta.reference_image_url,
    meta.referenceImageUrl,
    meta.reference_image_urls,
    meta.referenceImageUrls,
    meta.reference_images,
    meta.referenceImages,
    objectKeyToProxyUrl(meta.reference_image_object_key),
    objectKeyToProxyUrl(meta.referenceImageObjectKey)
  );

  const previewVideoUrl = pickFirstString(
    meta.preview_video_url,
    meta.previewVideoUrl,
    providerResult.preview_video_url,
    providerRaw.preview_video_url,
    row.type === "video" && row.status === "completed" ? row.content : null
  );

  const previewImageUrl = pickFirstString(
    row.thumbnail_url,
    meta.preview_image_url,
    meta.previewImageUrl,
    providerResult.preview_image_url,
    providerResult.thumb_url,
    providerRaw.preview_image_url,
    providerRaw.image_url,
    row.type === "image" ? row.content : null
  );

  return {
    reference_preview_url: referencePreviewUrl,
    preview_video_url: previewVideoUrl,
    preview_image_url: previewImageUrl,
  };
};

// ─────────────────────────────────────────────
// GET /api/user/profile
// ─────────────────────────────────────────────
export const getUserProfile = async (req, res) => {
  try {
    const { userId, role = "user", accountStatus = "active", mfaVerified = false } = req.auth;
    const [profile] = await sql`
      SELECT up.display_name, up.avatar_url, up.full_name, up.gender, up.birthdate,
             COALESCE(up.email, identity.email) AS email,
             identity.username, identity.phone_number
      FROM user_profiles up
      LEFT JOIN LATERAL (
        SELECT il.email, il.username, il.phone_number
        FROM identity_links il
        WHERE il.stardraw_user_id = up.user_id
        ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
        LIMIT 1
      ) identity ON TRUE
      WHERE up.user_id = ${userId}
      LIMIT 1
    `;

    res.json({
      success: true,
      data: {
        ...formatUserProfile(profile, userId),
        role,
        account_status: accountStatus,
        mfa_verified: Boolean(mfaVerified),
        identity: {
          provider: req.auth.identityProvider,
          issuer: req.auth.identityIssuer,
          subject: req.auth.externalSubject,
        },
      },
    });
  } catch (err) {
    logger.error("getUserProfile.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// PATCH /api/user/profile
// ─────────────────────────────────────────────
export const updateUserProfile = async (req, res) => {
  try {
    const { userId } = req.auth;
    const displayName = normalizeDisplayName(req.body?.display_name);

    if (!displayName) {
      return res.status(400).json({ success: false, message: "display_name is required" });
    }
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return res.status(400).json({
        success: false,
        message: `display_name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`,
      });
    }

    const [profile] = await sql`
      INSERT INTO user_profiles (user_id, display_name)
      VALUES (${userId}, ${displayName})
      ON CONFLICT (user_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          updated_at = CURRENT_TIMESTAMP
      RETURNING display_name, avatar_url, full_name, gender, birthdate
    `;

    const [identity] = await sql`
      SELECT il.email, il.username, il.phone_number
      FROM identity_links il
      WHERE il.stardraw_user_id = ${userId}
      ORDER BY il.last_seen_at DESC NULLS LAST, il.id DESC
      LIMIT 1
    `;

    res.json({
      success: true,
      data: formatUserProfile({
        ...profile,
        email: profile?.email || identity?.email,
        username: identity?.username,
        phone_number: identity?.phone_number,
      }, userId),
    });
  } catch (err) {
    logger.error("updateUserProfile.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/user/profile/avatar
// ─────────────────────────────────────────────
export const uploadUserAvatar = async (req, res) => {
  let uploadedObjectKey = null;
  try {
    const { userId } = req.auth;
    const file = req.file;

    if (!file?.buffer?.length) {
      return res.status(400).json({ success: false, message: "avatar file is required" });
    }

    const contentSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const profile = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "profile.avatar_uploaded",
      targetType: "user_profile",
      targetId: userId,
      requestPayload: {
        content_sha256: contentSha256,
        mime_type: file.mimetype || null,
      },
      mutate: async (tx) => {
        const [existingProfile] = await tx`
          SELECT avatar_object_key
          FROM user_profiles
          WHERE user_id = ${userId}
          FOR UPDATE
        `;
        const ext = mimeToExtension(file);
        const objectKey = objectStorage.buildObjectKey(userId, "avatar", ext);
        const uploaded = await objectStorage.uploadBuffer(file.buffer, objectKey, file.mimetype || "image/png");
        uploadedObjectKey = uploaded.objectKey;
        const [updated] = await tx`
          INSERT INTO user_profiles (user_id, avatar_url, avatar_object_key)
          VALUES (${userId}, ${uploaded.url}, ${uploaded.objectKey})
          ON CONFLICT (user_id) DO UPDATE
          SET avatar_url = EXCLUDED.avatar_url,
              avatar_object_key = EXCLUDED.avatar_object_key,
              updated_at = CURRENT_TIMESTAMP
          RETURNING display_name, avatar_url, avatar_object_key
        `;
        const previousObjectKey = existingProfile?.avatar_object_key;
        if (previousObjectKey && previousObjectKey !== updated.avatar_object_key) {
          await objectStorage.deleteObject(previousObjectKey).catch((cleanupError) => {
            logger.warn("uploadUserAvatar.previousCleanup.error", { userId, error: cleanupError.message });
          });
        }
        return formatUserProfile(updated, userId);
      },
    });

    res.json({
      success: true,
      data: profile,
    });
  } catch (err) {
    if (uploadedObjectKey) {
      await objectStorage.deleteObject(uploadedObjectKey).catch((cleanupError) => {
        logger.error("uploadUserAvatar.orphanCleanup.error", { error: cleanupError.message });
      });
    }
    logger.error("uploadUserAvatar.error", { error: err.message });
    res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: process.env.NODE_ENV === "production" && !err.status ? "Unable to upload avatar" : err.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /api/user/get-user-creations
// ─────────────────────────────────────────────
export const getUserCreations = async (req, res) => {
  try {
    const { userId } = req.auth;
    const page      = Math.max(1, parseInt(req.query.page      || "1", 10));
    const page_size = Math.min(100, Math.max(1, parseInt(req.query.page_size || "20", 10)));
    const type      = req.query.type   || null;
    const status    = req.query.status || null;
    const offset    = (page - 1) * page_size;

    const [rows, [countRow]] = await Promise.all([
      sql`
        SELECT id, type, scene_key, scene_name, provider, model,
               status, provider_status, task_id,
               content, thumbnail_url,
               points_reserved, points_cost,
               prompt, error_message, meta_info,
               community_status, community_hidden, community_visual_parameters,
               created_at, expires_at
        FROM creations
        WHERE user_id = ${userId}
          AND (${type}::text   IS NULL OR type   = ${type})
          AND (${status}::text IS NULL OR status = ${status})
        ORDER BY created_at DESC
        LIMIT ${page_size} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM creations
        WHERE user_id = ${userId}
          AND (${type}::text   IS NULL OR type   = ${type})
          AND (${status}::text IS NULL OR status = ${status})
      `,
    ]);

    const creations = rows.map((row) => {
      const derived = getDerivedPreviewFields(row);
      const meta = parseMetaInfo(row.meta_info);
      const {
        meta_info: _unusedMetaInfo,
        community_status: communityStatus,
        community_hidden: communityHidden,
        community_visual_parameters: communityVisualParameters,
        ...rest
      } = row;
      return {
        ...rest,
        ...derived,
        published: communityStatus === "public" && !communityHidden,
        visual_parameters: communityVisualParameters || meta.visual_parameters || meta.visualParameters || {},
      };
    });

    res.json({
      success: true,
      creations,
      page,
      page_size,
      total: Number(countRow?.total || 0),
    });
  } catch (err) {
    logger.error("getUserCreations.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// DELETE /api/user/creations/:creationId/failed
// ─────────────────────────────────────────────
export const deleteFailedCreation = async (req, res) => {
  try {
    const { userId } = req.auth;
    const { creationId } = req.params;
    const normalizedCreationId = String(creationId || "").trim();
    if (!/^[1-9]\d{0,18}$/.test(normalizedCreationId)
        || BigInt(normalizedCreationId) > 9223372036854775807n) {
      return res.status(400).json({ success: false, code: "INVALID_CREATION_ID", message: "Invalid creation id" });
    }

    const result = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "failed_creation.deleted",
      targetType: "creation",
      targetId: normalizedCreationId,
      requestPayload: { creation_id: normalizedCreationId },
      mutate: async (tx) => {
        const [creation] = await tx`
          SELECT id, status, charge_status, points_reserved,
                 content_object_key, thumbnail_object_key, meta_info
          FROM creations
          WHERE id = ${normalizedCreationId} AND user_id = ${userId}
          FOR UPDATE
        `;

        if (!creation) {
          throw Object.assign(new Error("Creation not found"), { status: 404, code: "CREATION_NOT_FOUND" });
        }
        if (creation.status !== "failed") {
          throw Object.assign(new Error("Only failed creations can be deleted"), {
            status: 400,
            code: "CREATION_NOT_FAILED",
          });
        }

        const pointsReserved = Number(creation.points_reserved || 0);
        if (creation.charge_status === "reserved" && pointsReserved > 0) {
          const release = await releasePoints({
            userId,
            amount: pointsReserved,
            creationId: creation.id,
            idempotencyKey: `release:delete_failed_creation:${creation.id}`,
            note: "返还：删除失败记录",
            tx,
          });
          const releasedAmount = Math.abs(Number(release.ledger?.held_points_change || 0));
          if (releasedAmount !== pointsReserved) {
            throw Object.assign(new Error("Creation point reservation could not be released in full"), {
              status: 409,
              code: "CREATION_RESERVATION_INCONSISTENT",
            });
          }
          const [releasedCreation] = await tx`
            UPDATE creations
            SET charge_status = 'released', points_reserved = 0
            WHERE id = ${creation.id} AND user_id = ${userId}
              AND charge_status = 'reserved'
            RETURNING id
          `;
          if (!releasedCreation) {
            throw Object.assign(new Error("Creation charge state changed while releasing points"), {
              status: 409,
              code: "CREATION_CHARGE_STATE_CONFLICT",
            });
          }
        }

        const data = await deleteOwnContent({
          userId,
          resourceType: "creation",
          resourceId: creation.id,
          tx,
        });
        return { deleted_id: String(creation.id), data };
      },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error("deleteFailedCreation.error", { error: err.message });
    res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: process.env.NODE_ENV === "production" && !err.status ? "Unable to delete creation" : err.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /api/user/creations/:creationId/download
// ─────────────────────────────────────────────
export const downloadSingle = async (req, res) => {
  try {
    const { userId } = req.auth;
    const { creationId } = req.params;

    const [creation] = await sql`
      SELECT id, type, task_id, provider_status, charge_status,
             points_reserved, points_cost,
             content, content_object_key,
             thumbnail_url, thumbnail_object_key,
             status, expires_at
      FROM creations
      WHERE id = ${creationId} AND user_id = ${userId}
    `;

    if (!creation) return res.status(404).json({ success: false, message: "Creation not found" });
    if (creation.status !== "completed") {
      return res.status(400).json({ success: false, message: "Creation is not completed" });
    }
    if (creation.expires_at && new Date(creation.expires_at) < new Date()) {
      return res.status(410).json({ success: false, message: "Creation has expired" });
    }

    if (needsVideoReconciliation(creation)) {
      const syncResult = await syncVideoCreationStatus(creation);
      if (!syncResult.success) {
        return res.status(503).json({ success: false, message: syncResult.message });
      }

      const current = syncResult.creation;
      const downloadUrl = current.content_object_key
        ? objectKeyToProxyUrl(current.content_object_key)
        : isInternalAssetUrl(current.content) || isDirectDataUrl(current.content)
          ? current.content
          : null;

      if (!downloadUrl) {
        return res.status(409).json({
          success: false,
          message: "Video asset is still being archived. Please retry in a few minutes.",
        });
      }

      return res.json({
        success: true,
        data: {
          download_url: downloadUrl,
          expires_in_seconds: current.content_object_key ? 3600 : 3600,
        },
      });
    }

    if (!creation.content) {
      return res.status(400).json({ success: false, message: "No content available" });
    }

    // 如果内容已是代理路径，直接返回（避免 HTTPS 签名 URL 导致 mixed-content）
    if (creation.content && creation.content.startsWith('/api/proxy/')) {
      return res.json({
        success: true,
        data: { download_url: creation.content, expires_in_seconds: 3600 },
      });
    }

    // 优先返回同源 OSS 代理路径，避免跨域下载和 mixed-content 问题。
    if (creation.content_object_key) {
      return res.json({
        success: true,
        data: { download_url: objectKeyToProxyUrl(creation.content_object_key), expires_in_seconds: 3600 },
      });
    }

    if (isDirectDataUrl(creation.content)) {
      return res.json({
        success: true,
        data: { download_url: creation.content, expires_in_seconds: 3600 },
      });
    }

    if (isUnsafeExternalAssetUrl(creation.content)) {
      return res.status(409).json({
        success: false,
        message: "Asset is not archived to OSS yet. Please retry later.",
      });
    }

    // fallback：直接返回内容 URL
    res.json({
      success: true,
      data: { download_url: creation.content, expires_in_seconds: 3600 },
    });
  } catch (err) {
    logger.error("downloadSingle.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/user/creations/download/batch
// ─────────────────────────────────────────────
export const batchDownload = async (req, res) => {
  try {
    const { userId } = req.auth;
    const idempotencyKey = req.headers["x-idempotency-key"];
    const { creation_ids } = req.body;

    if (!idempotencyKey) {
      return res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
    }
    if (!creation_ids || !Array.isArray(creation_ids) || creation_ids.length === 0) {
      return res.status(400).json({ success: false, message: "creation_ids must be a non-empty array" });
    }
    if (creation_ids.length > 20) {
      return res.status(400).json({ success: false, message: "Maximum 20 items per batch" });
    }

    const now = new Date();
    const creations = await sql`
      SELECT id, content, content_object_key, type
      FROM creations
      WHERE id = ANY(${creation_ids}::bigint[])
        AND user_id   = ${userId}
        AND status    = 'completed'
        AND (expires_at IS NULL OR expires_at > ${now.toISOString()})
    `;

    if (creations.length === 0) {
      return res.status(404).json({ success: false, message: "No valid creations found" });
    }

    const downloadItems = [];
    for (const item of creations) {
      let downloadUrl = null;
      const proxyObjectKey = extractObjectKeyFromProxyUrl(item.content);
      if (proxyObjectKey) {
        // 代理路径（/oss-proxy 或 /api/proxy/oss）统一提取 objectKey 后生成签名 URL
        downloadUrl = objectStorage.getSignedDownloadUrl(proxyObjectKey, 300);
      } else if (item.content_object_key) {
        downloadUrl = objectStorage.getSignedDownloadUrl(item.content_object_key, 300);
      } else if (isDirectDataUrl(item.content)) {
        downloadUrl = item.content;
      } else if (isUnsafeExternalAssetUrl(item.content)) {
        return res.status(409).json({
          success: false,
          message: `Creation ${item.id} is not archived to OSS yet and cannot be batch-downloaded safely.`,
        });
      } else {
        downloadUrl = item.content;
      }

      if (!downloadUrl) continue;
      downloadItems.push({ ...item, downloadUrl });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="creations_batch.zip"');

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.pipe(res);

    for (const item of downloadItems) {

      try {
        if (isDirectDataUrl(item.downloadUrl)) {
          const base64Payload = item.downloadUrl.split(",", 2)[1] || "";
          const ext = item.type === "video" ? "mp4" : "jpg";
          archive.append(Buffer.from(base64Payload, "base64"), { name: `${item.id}.${ext}` });
          continue;
        }

        const response = await axios.get(item.downloadUrl, { responseType: "arraybuffer", timeout: 60_000 });
        const ext = item.type === "video" ? "mp4" : "jpg";
        archive.append(Buffer.from(response.data), { name: `${item.id}.${ext}` });
      } catch (e) {
        logger.warn("batchDownload.item.failed", { id: item.id, error: e.message });
      }
    }

    archive.on("error", (err) => logger.error("batchDownload.archive.error", { error: err.message }));
    await archive.finalize();
  } catch (err) {
    logger.error("batchDownload.error", { error: err.message });
    if (!res.headersSent) res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/user/creations/export/csv
// ─────────────────────────────────────────────
export const exportCSV = async (req, res) => {
  try {
    const { userId } = req.auth;
    const now = new Date();

    const creations = await sql`
      SELECT id, type, scene_key, scene_name, provider, model,
             status, points_cost, prompt, content, thumbnail_url,
             created_at, expires_at
      FROM creations
      WHERE user_id  = ${userId}
        AND (expires_at IS NULL OR expires_at > ${now.toISOString()})
      ORDER BY created_at DESC
    `;

    if (creations.length === 0) {
      return res.status(404).json({ success: false, message: "No valid creations to export" });
    }

    const fields = [
      "id", "type", "scene_key", "scene_name", "provider", "model",
      "status", "points_cost", "prompt", "content", "thumbnail_url",
      "created_at", "expires_at",
    ];

    const parser = new Parser({ fields });
    const csv = parser.parse(creations);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="creations_history.csv"');
    res.status(200).send("\uFEFF" + csv);
  } catch (err) {
    logger.error("exportCSV.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};
