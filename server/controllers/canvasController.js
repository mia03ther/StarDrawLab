import { createHash, randomUUID } from "crypto";
import path from "path";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import { normalizeUploadedImage } from "../utils/imageUpload.js";
import { deleteOwnContent } from "../services/contentRecycleService.js";
import {
  mergeConcurrentGeneratedCanvasMedia,
  normalizeCanvasState,
} from "../domain/canvas/canvasState.js";
import { executeUserOperation } from "../services/userOperationService.js";
import {
  appendCanvasRevision,
  listCanvasRevisions,
  restoreCanvasRevision,
} from "../services/canvasRevisionService.js";

const objectStorage = getObjectStorage();
const dbJson = (db, value) => (typeof db?.json === "function" ? db.json(value) : JSON.stringify(value));

export { normalizeCanvasState } from "../domain/canvas/canvasState.js";

const MAX_TITLE_LENGTH = 120;
const DEFAULT_TITLE = "Untitled Canvas";
const IMAGE_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
const VIDEO_MIME_TO_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-m4v": "m4v",
  "video/x-msvideo": "avi",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
};
const AUDIO_MIME_TO_EXT = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
};

const normalizeTitle = (value) => {
  const title = String(value || "").trim();
  return (title || DEFAULT_TITLE).slice(0, MAX_TITLE_LENGTH);
};

const decodeUploadOriginalName = (value, fallback = "canvas") => {
  const raw = String(value || "").trim();
  if (!raw) return fallback;

  // Multer can expose UTF-8 filenames as latin1 mojibake depending on client/proxy.
  // Decode only when it improves the string; keep ASCII names unchanged.
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    if (decoded && decoded !== raw && !decoded.includes("\uFFFD")) return decoded;
  } catch {
    // Keep original value below.
  }

  return raw;
};

const titleFromOriginalName = (value, fallback = "canvas") => {
  const decoded = decodeUploadOriginalName(value, fallback);
  const ext = path.extname(decoded);
  return path.basename(decoded, ext) || fallback;
};

const mapCanvasRow = (row) => {
  const state = normalizeCanvasState(row?.canvas_state || row?.state || {});
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    element_count: state.elements.length,
    state,
  };
};

const extensionFromFile = (file, type) => {
  const mimetype = String(file?.mimetype || "").toLowerCase();
  const extByMime = type === "video"
    ? VIDEO_MIME_TO_EXT[mimetype]
    : type === "audio"
      ? AUDIO_MIME_TO_EXT[mimetype]
      : IMAGE_MIME_TO_EXT[mimetype];
  if (extByMime) return extByMime;

  const ext = path.extname(file?.originalname || "").replace(".", "").toLowerCase();
  return ext || (type === "video" ? "mp4" : type === "audio" ? "mp3" : "jpg");
};

const requireIdempotencyKey = (req, res) => {
  if (req.headers["x-idempotency-key"]) return true;
  res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
  return false;
};

export const listCanvases = async (req, res) => {
  try {
    const { userId } = req.auth;
    const rows = await sql`
      SELECT id, title, canvas_state, created_at, updated_at
      FROM canvases
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC, created_at DESC
    `;

    res.json({
      success: true,
      data: rows.map(mapCanvasRow).map(({ state, ...meta }) => meta),
    });
  } catch (err) {
    logger.error("listCanvases.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

export const createCanvas = async (req, res) => {
  if (!requireIdempotencyKey(req, res)) return;

  try {
    const { userId } = req.auth;
    const title = normalizeTitle(req.body?.title || "");
    const canvasId = `canvas_${randomUUID().replace(/-/g, "")}`;
    const initialState = normalizeCanvasState(req.body?.state || {});

    const [row] = await sql`
      INSERT INTO canvases (id, user_id, title, canvas_state)
      VALUES (${canvasId}, ${userId}, ${title}, ${dbJson(sql, initialState)})
      RETURNING id, title, canvas_state, created_at, updated_at
    `;

    res.json({
      success: true,
      data: mapCanvasRow(row),
    });
  } catch (err) {
    logger.error("createCanvas.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getCanvas = async (req, res) => {
  try {
    const { userId } = req.auth;
    const { canvasId } = req.params;

    const [row] = await sql`
      SELECT id, title, canvas_state, created_at, updated_at
      FROM canvases
      WHERE id = ${canvasId} AND user_id = ${userId}
      LIMIT 1
    `;

    if (!row) {
      return res.status(404).json({ success: false, message: "Canvas not found" });
    }

    res.json({
      success: true,
      data: mapCanvasRow(row),
    });
  } catch (err) {
    logger.error("getCanvas.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

export const updateCanvas = async (req, res) => {
  if (!requireIdempotencyKey(req, res)) return;

  try {
    const { userId } = req.auth;
    const { canvasId } = req.params;
    const title = normalizeTitle(req.body?.title || "");
    const incomingState = normalizeCanvasState(req.body?.state || {});
    const baseUpdatedAt = req.body?.baseUpdatedAt || req.body?.base_updated_at || null;
    const deletedElementIds = (Array.isArray(req.body?.deletedElementIds)
      ? req.body.deletedElementIds
      : Array.isArray(req.body?.deleted_element_ids) ? req.body.deleted_element_ids : [])
      .map((id) => String(id || "").trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 500);

    const serializedState = JSON.stringify(incomingState);
    if (serializedState.length > 1_500_000) {
      return res.status(400).json({ success: false, message: "Canvas state is too large" });
    }

    const result = await sql.begin(async (tx) => {
      const [current] = await tx`
        SELECT id, title, canvas_state, created_at, updated_at
        FROM canvases
        WHERE id = ${canvasId} AND user_id = ${userId}
        FOR UPDATE
      `;
      if (!current) return null;
      const merged = mergeConcurrentGeneratedCanvasMedia({
        currentState: current.canvas_state,
        incomingState,
        baseUpdatedAt,
        currentUpdatedAt: current.updated_at,
        deletedElementIds,
      });
      const state = merged.state;
      if (JSON.stringify(state).length > 1_500_000) {
        throw Object.assign(new Error("Canvas state is too large"), { status: 400 });
      }
      const [row] = await tx`
        UPDATE canvases
        SET title = ${title},
            canvas_state = ${dbJson(tx, state)},
            updated_at = NOW()
        WHERE id = ${canvasId} AND user_id = ${userId}
        RETURNING id, title, canvas_state, created_at, updated_at
      `;
      const revision = await appendCanvasRevision({
        db: tx,
        userId,
        canvasId,
        title: row.title,
        canvasState: row.canvas_state,
        reason: "canvas.updated",
      });
      return { row, revision, merge: merged };
    });

    if (!result) return res.status(404).json({ success: false, message: "Canvas not found" });

    res.json({
      success: true,
      data: {
        ...mapCanvasRow(result.row),
        revision: result.revision,
        concurrency: {
          merged: result.merge.concurrent,
          preservedElementIds: result.merge.preservedElementIds,
        },
      },
    });
  } catch (err) {
    logger.error("updateCanvas.error", { error: err.message });
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

export const getCanvasRevisions = async (req, res) => {
  try {
    const data = await listCanvasRevisions({
      userId: req.auth.userId,
      canvasId: req.params.canvasId,
      limit: req.query.limit,
    });
    res.set("Cache-Control", "private, no-store");
    return res.json({ success: true, data });
  } catch (err) {
    logger.error("getCanvasRevisions.error", { error: err.message });
    return res.status(err.status || 500).json({ success: false, code: err.code, message: err.message });
  }
};

export const restoreCanvasRevisionController = async (req, res) => {
  if (!requireIdempotencyKey(req, res)) return;
  try {
    const { userId } = req.auth;
    const canvasId = req.params.canvasId;
    const revisionId = req.params.revisionId;
    const data = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "canvas.revision_restored",
      targetType: "canvas_revision",
      targetId: revisionId,
      requestPayload: { canvas_id: canvasId, revision_id: revisionId },
      mutate: (tx) => restoreCanvasRevision({ db: tx, userId, canvasId, revisionId }),
    });
    return res.json({ success: true, data });
  } catch (err) {
    logger.error("restoreCanvasRevision.error", { error: err.message });
    return res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: process.env.NODE_ENV === "production" && !err.status ? "Unable to restore canvas revision" : err.message,
    });
  }
};

export const deleteCanvas = async (req, res) => {
  if (!requireIdempotencyKey(req, res)) return;

  try {
    const { userId } = req.auth;
    const { canvasId } = req.params;

    const result = await deleteOwnContent({
      userId,
      resourceType: "canvas",
      resourceId: canvasId,
      idempotencyKey: req.headers["x-idempotency-key"],
    });

    res.json({
      success: true,
      data: { id: canvasId, ...result },
    });
  } catch (err) {
    logger.error("deleteCanvas.error", { error: err.message });
    res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: process.env.NODE_ENV === "production" && !err.status ? "Unable to delete canvas" : err.message,
    });
  }
};

export const uploadCanvasAsset = async (req, res) => {
  if (!requireIdempotencyKey(req, res)) return;

  let uploadedObjectKey = null;
  try {
    const { userId } = req.auth;
    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ success: false, message: "asset file is required" });
    }

    const hintedType = String(req.body?.type || "").trim().toLowerCase();
    const detectedType = file.mimetype?.startsWith("video/")
      ? "video"
      : file.mimetype?.startsWith("audio/")
        ? "audio"
      : file.mimetype?.startsWith("image/")
        ? "image"
        : hintedType;

    if (!["image", "video", "audio"].includes(detectedType)) {
      return res.status(400).json({ success: false, message: "Unsupported asset type" });
    }

    const preparedFile = detectedType === "image"
      ? await normalizeUploadedImage(file)
      : file;
    const displayTitle = titleFromOriginalName(
      file.originalname,
      detectedType === "video" ? "canvas_video" : detectedType === "audio" ? "canvas_audio" : "canvas_image",
    );
    const ext = extensionFromFile(preparedFile, detectedType);
    const contentSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const data = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "canvas.asset_uploaded",
      targetType: "canvas_asset",
      targetId: contentSha256,
      requestPayload: {
        content_sha256: contentSha256,
        media_type: detectedType,
        mime_type: preparedFile.mimetype || file.mimetype || null,
      },
      mutate: async (tx) => {
        const objectKey = objectStorage.buildObjectKey(
          userId,
          detectedType === "video" ? "canvas_video" : detectedType === "audio" ? "canvas_audio" : "canvas_image",
          ext,
        );
        const uploaded = await objectStorage.uploadBuffer(
          preparedFile.buffer,
          objectKey,
          preparedFile.mimetype || (detectedType === "video" ? "video/mp4" : detectedType === "audio" ? "audio/mpeg" : "image/jpeg"),
        );
        uploadedObjectKey = uploaded.objectKey;
        const [uploadRecord] = await tx`
          INSERT INTO user_content_uploads
            (user_id, object_key, asset_url, media_type, mime_type, original_name,
             source_type, metadata)
          VALUES
            (${userId}, ${uploaded.objectKey}, ${uploaded.url}, ${detectedType},
             ${preparedFile.mimetype || file.mimetype || null}, ${displayTitle},
             'canvas_upload', ${JSON.stringify({ source: "canvas" })}::jsonb)
          ON CONFLICT (object_key) DO NOTHING
          RETURNING id
        `;

        const resourceId = uploadRecord?.id || (await tx`
          SELECT id FROM user_content_uploads
          WHERE user_id = ${userId} AND object_key = ${uploaded.objectKey}
          LIMIT 1
        `)[0]?.id;
        const elementId = `upload_${randomUUID().replace(/-/g, "")}`;
        return {
          id: elementId,
          element_id: elementId,
          resource_id: resourceId,
          type: detectedType,
          title: displayTitle,
          src: uploaded.url,
          url: uploaded.url,
          content: detectedType === "image" || detectedType === "audio" ? uploaded.url : "",
          poster: detectedType === "image" ? uploaded.url : "",
          preview_image_url: detectedType === "image" ? uploaded.url : "",
          thumbnail_url: detectedType === "image" ? uploaded.url : "",
          reference_preview_url: detectedType === "image" ? uploaded.url : "",
          objectKey: uploaded.objectKey,
          source: "canvas_upload",
        };
      },
    });

    res.json({
      success: true,
      data,
    });
  } catch (err) {
    if (uploadedObjectKey) {
      await objectStorage.deleteObject(uploadedObjectKey).catch((cleanupError) => {
        logger.error("uploadCanvasAsset.orphanCleanup.error", { error: cleanupError.message });
      });
    }
    logger.error("uploadCanvasAsset.error", { error: err.message });
    res.status(err.status || 500).json({
      success: false,
      code: err.code,
      message: process.env.NODE_ENV === "production" && !err.status ? "Unable to upload canvas asset" : err.message,
    });
  }
};
