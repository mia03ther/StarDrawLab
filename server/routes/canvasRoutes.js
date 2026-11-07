import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import * as canvasController from "../controllers/canvasController.js";
import { uploadPreview } from "../configs/multer.js";
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { getObjectStorage } from "../services/objectStorageComposition.js";
import { executeUserOperation } from "../services/userOperationService.js";
import { attachTemporaryUploadCleanup } from "../infrastructure/safeMultipartUpload.js";
import { uploadStagedMedia } from "../infrastructure/stagedObjectUpload.js";

const canvasRouter = express.Router();
const objectStorage = getObjectStorage();

// Keep the route module loadable for integrations that provide a legacy
// controller adapter. Revision endpoints were added later and are optional
// at that seam; the production controller exports both handlers.
const unavailableRevisionHandler = (_req, res) => res.status(404).json({
  success: false,
  code: "CANVAS_REVISIONS_UNAVAILABLE",
  message: "Canvas revision history is unavailable",
});
const {
  listCanvases,
  createCanvas,
  getCanvas,
  updateCanvas,
  deleteCanvas,
  uploadCanvasAsset,
} = canvasController;
const getCanvasRevisions = canvasController.getCanvasRevisions || unavailableRevisionHandler;
const restoreCanvasRevisionController = canvasController.restoreCanvasRevisionController || unavailableRevisionHandler;

const titleFromOriginalName = (value, fallback) => {
  let decoded = String(value || "").trim();
  try {
    const utf8 = Buffer.from(decoded, "latin1").toString("utf8");
    if (utf8 && utf8 !== decoded && !utf8.includes("\uFFFD")) decoded = utf8;
  } catch {
    // Keep the original Multer filename.
  }
  const extension = path.extname(decoded);
  return path.basename(decoded, extension) || fallback;
};

const uploadTemporaryCanvasAsset = async (req, res) => {
  let uploadedObjectKey = null;
  try {
    if (!req.headers["x-idempotency-key"]) {
      return res.status(400).json({ success: false, message: "X-Idempotency-Key header is required" });
    }
    const file = req.file;
    if (file?.storage !== "temporary" || !file.path || !file.sha256) {
      return uploadCanvasAsset(req, res);
    }

    const { userId } = req.auth;
    const detectedType = file.mediaKind;
    if (!["video", "audio"].includes(detectedType)) {
      return res.status(400).json({ success: false, message: "Unsupported asset type" });
    }

    const displayTitle = titleFromOriginalName(
      file.originalname,
      detectedType === "video" ? "canvas_video" : "canvas_audio",
    );
    const extension = String(file.validatedExtension || path.extname(file.originalname || ""))
      .replace(/^\./, "")
      .toLowerCase() || (detectedType === "video" ? "mp4" : "mp3");
    const contentType = String(file.mimetype || (detectedType === "video" ? "video/mp4" : "audio/mpeg"));
    const data = await executeUserOperation({
      userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "canvas.asset_uploaded",
      targetType: "canvas_asset",
      targetId: file.sha256,
      requestPayload: {
        content_sha256: file.sha256,
        media_type: detectedType,
        mime_type: contentType,
      },
      mutate: async (tx) => {
        const objectKey = objectStorage.buildObjectKey(
          userId,
          detectedType === "video" ? "canvas_video" : "canvas_audio",
          extension,
        );
        const uploaded = await uploadStagedMedia({
          file,
          objectKey,
          contentType,
          objectStorage,
        });
        uploadedObjectKey = uploaded.objectKey;
        const [uploadRecord] = await tx`
          INSERT INTO user_content_uploads
            (user_id, object_key, asset_url, media_type, mime_type, original_name,
             source_type, metadata)
          VALUES
            (${userId}, ${uploaded.objectKey}, ${uploaded.url}, ${detectedType},
             ${contentType}, ${displayTitle}, 'canvas_upload',
             ${JSON.stringify({ source: "canvas" })}::jsonb)
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
          content: detectedType === "audio" ? uploaded.url : "",
          poster: "",
          preview_image_url: "",
          thumbnail_url: "",
          reference_preview_url: "",
          objectKey: uploaded.objectKey,
          source: "canvas_upload",
        };
      },
    });

    return res.json({ success: true, data });
  } catch (error) {
    if (uploadedObjectKey) {
      await objectStorage.deleteObject(uploadedObjectKey).catch((cleanupError) => {
        logger.error("uploadCanvasAsset.orphanCleanup.error", { error: cleanupError.message });
      });
    }
    logger.error("uploadCanvasAsset.error", { error: error.message });
    return res.status(error.status || 500).json({
      success: false,
      code: error.code,
      message: process.env.NODE_ENV === "production" && !error.status ? "Unable to upload canvas asset" : error.message,
    });
  }
};

canvasRouter.get("/", listCanvases);
canvasRouter.post("/", createCanvas);
canvasRouter.post("/assets", uploadPreview.single("asset"), attachTemporaryUploadCleanup, uploadTemporaryCanvasAsset);
canvasRouter.get("/:canvasId/revisions", getCanvasRevisions);
canvasRouter.post("/:canvasId/revisions/:revisionId/restore", restoreCanvasRevisionController);
canvasRouter.get("/:canvasId", getCanvas);
canvasRouter.put("/:canvasId", updateCanvas);
canvasRouter.delete("/:canvasId", deleteCanvas);

export default canvasRouter;
