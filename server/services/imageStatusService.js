import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { createPostgresGenerationStore } from "../infrastructure/postgresGenerationStore.js";
import { getImageGenerationProvider } from "./mediaGenerationComposition.js";
import { getObjectStorage } from "./objectStorageComposition.js";

const imageGeneration = getImageGenerationProvider();
const objectStorage = getObjectStorage();
const generationStore = createPostgresGenerationStore();

const ACTIVE_STATUSES = new Set(["pending", "running", "processing", "in_progress"]);
const FAILED_PROVIDER_STATUSES = new Set(["failed", "error", "cancelled", "canceled", "expired"]);

const normalizeProviderStatus = (status) => String(status || "queued").trim().toLowerCase();

const extractObjectKeyFromProxyUrl = (url) => {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  const prefixes = ["/oss-proxy/", "/api/proxy/oss/", "/api/proxy/"];
  const pathname = raw.split("?")[0];
  for (const prefix of prefixes) {
    if (!pathname.startsWith(prefix)) continue;
    return decodeURIComponent(pathname.slice(prefix.length).replace(/^\/+/, ""));
  }
  return null;
};

const isProviderTaskNotFound = (error) => {
  const details = error?.details || error?.providerDetails || {};
  const code = String(details?.error?.code || details?.code || error?.providerCode || "").toLowerCase();
  return code === "task_not_found" || /task\s+not\s+found/i.test(String(error?.message || ""));
};

const updateProviderProgress = async ({ creationId, status, providerStatus, errorMessage = null }) => {
  const internalStatus = status === "queued" || status === "pending" ? "pending" : "running";
  const [updated] = await sql`
    UPDATE creations
    SET status = ${internalStatus},
        provider_status = ${providerStatus},
        error_message = ${errorMessage}
    WHERE id = ${creationId} AND charge_status = 'reserved'
    RETURNING *
  `;
  return updated;
};

const releaseFailedCreation = async ({ creation, providerStatus, message }) => {
  const result = await generationStore.releaseImage({
    userId: creation.user_id,
    creationId: creation.id,
    providerStatus,
    errorMessage: message,
  });
  return result;
};

export const needsImageReconciliation = (creation) => Boolean(
  creation
  && creation.type === "image"
  && creation.task_id
  && creation.charge_status === "reserved"
  && ACTIVE_STATUSES.has(String(creation.status || "").toLowerCase()),
);

export const syncImageCreationStatus = async (creation) => {
  if (!creation?.task_id) return { success: false, message: "No task_id for this creation" };

  const [latest] = await sql`
    SELECT *
    FROM creations
    WHERE id = ${creation.id}
    LIMIT 1
  `;
  if (!latest) return { success: false, message: `Creation ${creation.id} not found` };
  if (latest.charge_status === "charged" || latest.charge_status === "released") {
    return { success: true, creation: latest, progress: latest.status === "completed" ? 100 : 0 };
  }

  let result;
  try {
    result = await imageGeneration.check({ taskId: latest.task_id });
  } catch (error) {
    if (isProviderTaskNotFound(error)) {
      const message = "Image provider task was not found. Reserved points have been released.";
      const released = await releaseFailedCreation({
        creation: latest,
        providerStatus: "task_not_found",
        message,
      });
      return { success: true, creation: { ...latest, ...released }, progress: 0, errorMessage: message };
    }
    throw error;
  }

  if (!result?.success) return { success: false, message: result?.message || "Image status check failed" };
  const providerStatus = normalizeProviderStatus(result.status);

  if (FAILED_PROVIDER_STATUSES.has(providerStatus)) {
    const message = String(result.message || result.raw?.error?.message || "Image generation failed");
    const released = await releaseFailedCreation({
      creation: latest,
      providerStatus,
      message,
    });
    return { success: true, creation: { ...latest, ...released }, progress: 0, errorMessage: message };
  }

  if (providerStatus !== "completed" && providerStatus !== "success") {
    const updated = await updateProviderProgress({
      creationId: latest.id,
      status: providerStatus,
      providerStatus,
    });
    return {
      success: true,
      creation: updated || { ...latest, status: providerStatus === "queued" ? "pending" : "running", provider_status: providerStatus },
      progress: Number.isFinite(Number(result.progress)) ? Number(result.progress) : providerStatus === "queued" ? 10 : 50,
    };
  }

  if (!result.url && !result.imageBuffer) {
    const message = "Image provider marked the task completed without returning an image.";
    const updated = await updateProviderProgress({
      creationId: latest.id,
      status: "running",
      providerStatus,
      errorMessage: message,
    });
    return { success: true, creation: updated || latest, progress: 90 };
  }

  let contentUrl = null;
  let contentObjectKey = null;
  const existingObjectKey = latest.content_object_key || extractObjectKeyFromProxyUrl(latest.content);
  if (existingObjectKey && latest.content) {
    contentUrl = latest.content;
    contentObjectKey = existingObjectKey;
  } else {
    try {
      const contentType = result.imageContentType || "image/jpeg";
      const extension = contentType === "image/png" ? "png" : "jpg";
      const objectKey = objectStorage.buildObjectKey(latest.user_id, "image", extension);
      const uploaded = result.url
        ? await objectStorage.uploadFromUrl(result.url, objectKey, contentType)
        : await objectStorage.uploadBuffer(result.imageBuffer, objectKey, contentType);
      if (!uploaded?.url || !uploaded?.objectKey) throw new Error("missing persisted object key");
      contentUrl = uploaded.url;
      contentObjectKey = uploaded.objectKey;
    } catch (error) {
      const message = `Image completed but OSS persistence failed: ${error.message}`;
      const updated = await updateProviderProgress({
        creationId: latest.id,
        status: "running",
        providerStatus,
        errorMessage: message,
      });
      logger.warn("imageStatus.sync.ossUpload.failed", { creationId: latest.id, error: error.message });
      return { success: true, creation: updated || latest, progress: 90 };
    }
  }

  let settled;
  try {
    settled = await generationStore.settleImage({
      userId: latest.user_id,
      creationId: latest.id,
      pointsCost: Number(latest.points_reserved || latest.points_cost || 0),
      contentUrl,
      contentObjectKey,
      generationTimeMs: Math.max(0, Date.now() - new Date(latest.created_at || Date.now()).getTime()),
      template: { scene_name: latest.scene_name || "Image generation" },
      metadata: {
        providerStatus,
        providerRaw: result.raw || {},
        syncedBy: "image_worker",
      },
    });
  } catch (error) {
    const [current] = await sql`SELECT * FROM creations WHERE id = ${latest.id} LIMIT 1`;
    if (current?.charge_status === "charged") {
      settled = current;
    } else {
      const message = `Image asset persisted but point settlement failed: ${error.message}`;
      const updated = await updateProviderProgress({
        creationId: latest.id,
        status: "running",
        providerStatus,
        errorMessage: message,
      });
      logger.error("imageStatus.sync.charge.failed", { creationId: latest.id, error: error.message });
      return { success: true, creation: updated || latest, progress: 95 };
    }
  }

  return {
    success: true,
    creation: { ...latest, ...settled, content: contentUrl, content_object_key: contentObjectKey, status: "completed" },
    progress: 100,
  };
};

export const processPendingImageCreations = async ({ limit = 50 } = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const candidates = await sql`
    SELECT *
    FROM creations
    WHERE type = 'image'
      AND task_id IS NOT NULL
      AND charge_status = 'reserved'
      AND status IN ('pending', 'running', 'processing', 'in_progress')
    ORDER BY created_at ASC
    LIMIT ${safeLimit}
  `;
  const summary = { scanned: candidates.length, synced: 0, completed: 0, failed: 0 };
  for (const creation of candidates) {
    try {
      const result = await syncImageCreationStatus(creation);
      if (!result.success) continue;
      summary.synced += 1;
      if (result.creation?.status === "completed") summary.completed += 1;
      if (result.creation?.status === "failed") summary.failed += 1;
    } catch (error) {
      logger.warn("imageStatus.sync.item.failed", { creationId: creation.id, error: error.message });
    }
  }
  return summary;
};
