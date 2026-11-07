import sql from "../configs/db.js";
import { getObjectStorage } from "./objectStorageComposition.js";
import { chargePoints, releasePoints } from "./pointsService.js";
import logger from "../configs/logger.js";
import { cleanupUnreferencedObjects } from "./contentRecycleService.js";
import { getVideoGenerationProvider } from "./mediaGenerationComposition.js";

const objectStorage = getObjectStorage();
const videoGeneration = getVideoGenerationProvider();

const providerStatusMap = {
  queued: "pending",
  pending: "pending",
  in_progress: "running",
  processing: "running",
  completed: "completed",
  success: "completed",
  failed: "failed",
  cancelled: "failed",
  expired: "failed",
  error: "failed",
};

const normalizeErrorMessage = (message, fallback) => {
  if (!message) return fallback;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(message);
  } catch {
    return fallback;
  }
};

const parseMetaInfo = (metaInfo) => {
  if (!metaInfo) return {};

  if (Array.isArray(metaInfo)) {
    return metaInfo.reduce((merged, item) => ({
      ...merged,
      ...parseMetaInfo(item),
    }), {});
  }

  if (typeof metaInfo === "object") return metaInfo;
  if (typeof metaInfo !== "string") return {};

  try {
    return parseMetaInfo(JSON.parse(metaInfo));
  } catch {
    return {};
  }
};

const extractObjectKeyFromProxyUrl = (url) => {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  let pathname = raw;

  try {
    pathname = /^https?:\/\//i.test(raw)
      ? new URL(raw).pathname
      : new URL(raw, "http://localhost").pathname;
  } catch {
    [pathname] = raw.split("?");
  }

  const prefixes = ["/oss-proxy/", "/api/proxy/oss/", "/api/proxy/"];
  for (const prefix of prefixes) {
    if (!pathname.startsWith(prefix)) continue;
    const objectKey = pathname.slice(prefix.length).replace(/^\/+/, "");
    if (!objectKey) return null;
    try {
      return decodeURIComponent(objectKey);
    } catch {
      return objectKey;
    }
  }

  return null;
};

const buildSyncErrorMeta = (stage, message, providerRaw) =>
  ({
    providerRaw: providerRaw || {},
    syncError: {
      stage,
      message,
      at: new Date().toISOString(),
    },
  });

const mergeMetaInfo = (meta) => sql`
  (
    CASE
      WHEN jsonb_typeof(COALESCE(meta_info, '{}'::jsonb)) = 'object' THEN meta_info
      ELSE '{}'::jsonb
    END || ${sql.json(meta)}
  )
`;

const isProxyAssetUrl = (url) =>
  typeof url === "string" && (url.startsWith("/oss-proxy/") || url.startsWith("/api/proxy/oss/"));

const verifyStoredVideo = async (objectKey) => {
  if (!objectKey) throw Object.assign(new Error("Video object key is missing"), { code: "VIDEO_ASSET_MISSING" });
  const metadata = await objectStorage.getObjectMetadata(objectKey);
  if (metadata?.exists === false) {
    throw Object.assign(new Error("Stored video object does not exist"), { code: "VIDEO_ASSET_MISSING" });
  }
  if (metadata?.exists !== true || !Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0) {
    throw Object.assign(new Error("Stored video object size cannot be verified"), { code: "VIDEO_ASSET_UNVERIFIED" });
  }
  if (metadata.sizeBytes === 0) {
    throw Object.assign(new Error("Stored video object is empty"), { code: "VIDEO_ASSET_EMPTY" });
  }
  const type = String(metadata.contentType || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  if (!type.startsWith("video/") && type !== "application/octet-stream" && type !== "application/mp4") {
    throw Object.assign(new Error("Stored video object has an incompatible content type"), { code: "VIDEO_ASSET_TYPE_INVALID" });
  }
};

const isInvalidStoredVideo = (error) =>
  ["VIDEO_ASSET_MISSING", "VIDEO_ASSET_EMPTY", "VIDEO_ASSET_TYPE_INVALID"].includes(error?.code);

export const needsVideoReconciliation = (creation) => {
  if (!creation || creation.type !== "video" || !creation.task_id) return false;

  const status = String(creation.status || "").toLowerCase();
  const hasDurableContent = Boolean(
    creation.content_object_key ||
    extractObjectKeyFromProxyUrl(creation.content) ||
    isProxyAssetUrl(creation.content)
  );
  const hasDurableThumbnail = Boolean(
    creation.thumbnail_object_key ||
    extractObjectKeyFromProxyUrl(creation.thumbnail_url) ||
    isProxyAssetUrl(creation.thumbnail_url)
  );
  const reservedPoints = Number(creation.points_reserved || 0);
  const chargeStatus = String(creation.charge_status || "").toLowerCase();

  if (status === "pending" || status === "running") return true;
  if (status !== "completed") return false;

  return !hasDurableContent || !hasDurableThumbnail || chargeStatus !== "charged" || reservedPoints > 0;
};

const isProviderTaskNotFound = (result) => {
  const errorCode = String(result?.details?.error?.code || result?.details?.code || "").toLowerCase();
  return errorCode === "task_not_found";
};

const checkVideoProviderStatus = async (creation) => {
  if (String(creation?.task_id || "").startsWith("offline_digital_human_")) {
    const metaInfo = parseMetaInfo(creation?.meta_info);
    const offlineRender = metaInfo.offlineRender || {};
    const submittedAt = Number(offlineRender.submittedAt || Date.now());
    const readyAt = Number(offlineRender.readyAt || submittedAt + 14_000);
    const now = Date.now();
    const duration = Math.max(1, readyAt - submittedAt);

    if (now >= readyAt) {
      return {
        success: true,
        status: "completed",
        url: offlineRender.videoUrl || creation.content || null,
        thumbUrl: null,
        progress: 100,
        raw: {
          provider: "offline_render",
          source: offlineRender.source || "template_preview_video",
          task_id: creation.task_id,
          videoObjectKey: offlineRender.videoObjectKey || null,
        },
      };
    }

    return {
      success: true,
      status: now - submittedAt < 2500 ? "queued" : "in_progress",
      url: null,
      thumbUrl: null,
      progress: Math.max(8, Math.min(92, Math.floor(((now - submittedAt) / duration) * 100))),
      raw: {
        provider: "offline_render",
        source: offlineRender.source || "template_preview_video",
        task_id: creation.task_id,
        videoObjectKey: offlineRender.videoObjectKey || null,
      },
    };
  }

  return videoGeneration.check({
    provider: creation?.provider,
    taskId: creation.task_id,
  });
};

export const syncVideoCreationStatus = async (creation) => {
  if (!creation?.task_id) {
    return {
      success: false,
      message: "No task_id for this creation",
    };
  }

  const [latestCreation] = await sql`
    SELECT *
    FROM creations
    WHERE id = ${creation.id}
    LIMIT 1
  `;

  if (!latestCreation) {
    return {
      success: false,
      message: `Creation ${creation.id} not found`,
    };
  }

  const currentCreation = { ...creation, ...latestCreation };
  const resolvedUserId = currentCreation.user_id ?? creation.user_id ?? null;

  if (!resolvedUserId) {
    return {
      success: false,
      message: `Creation ${currentCreation.id} has no user_id`,
    };
  }

  const result = await checkVideoProviderStatus(currentCreation);
  if (!result.success) {
    if (
      isProviderTaskNotFound(result) &&
      String(currentCreation.charge_status || "").toLowerCase() === "reserved" &&
      Number(currentCreation.points_reserved || 0) > 0
    ) {
      const errorMessage = "Provider task not found. Reserved points have been released.";

      let releasedCreation;
      try {
        releasedCreation = await sql.begin(async (tx) => {
          const [locked] = await tx`
            SELECT * FROM creations WHERE id = ${currentCreation.id} FOR UPDATE
          `;
          if (!locked || locked.charge_status !== "reserved") return locked;
          await releasePoints({
            userId: resolvedUserId,
            amount: Number(locked.points_reserved || 0),
            creationId: locked.id,
            idempotencyKey: `release:creation:${locked.id}`,
            note: "返还：供应商任务不存在",
            tx,
          });
          const [updated] = await tx`
            UPDATE creations
            SET status = 'failed',
                provider_status = 'task_not_found',
                charge_status = 'released',
                points_reserved = 0,
                error_message = ${errorMessage},
                meta_info = ${mergeMetaInfo(buildSyncErrorMeta("provider_missing", errorMessage, result.details || null))}
            WHERE id = ${locked.id} AND charge_status = 'reserved'
            RETURNING *
          `;
          if (!updated) throw new Error("Video release state changed unexpectedly");
          return updated;
        });
      } catch (releaseErr) {
        return {
          success: false,
          message: `Provider task missing and point release failed: ${releaseErr.message}`,
        };
      }

      if (releasedCreation?.charge_status !== "released") {
        return {
          success: true,
          creation: releasedCreation,
          progress: releasedCreation?.status === "completed" ? 100 : 50,
        };
      }

      return {
        success: true,
        creation: {
          ...currentCreation,
          ...releasedCreation,
        },
        progress: 0,
        errorMessage,
      };
    }

    return {
      success: false,
      message: result.message,
    };
  }

  const rawStatus = String(result.status || "").toLowerCase();
  const internalStatus = providerStatusMap[rawStatus] || "running";

  if (internalStatus === "completed") {
    if (!result.url) {
      const message = "Provider marked task completed but returned no downloadable video URL.";
      const latestAfterPayloadError = await sql.begin(async (tx) => {
        const [locked] = await tx`
          SELECT * FROM creations WHERE id = ${currentCreation.id} FOR UPDATE
        `;
        if (!locked || locked.charge_status !== "reserved") return locked;
        const [updated] = await tx`
          UPDATE creations
          SET status = 'running',
              provider_status = ${rawStatus},
              error_message = ${message},
              meta_info = ${mergeMetaInfo(buildSyncErrorMeta("provider_payload", message, result.raw))}
          WHERE id = ${locked.id} AND charge_status = 'reserved'
          RETURNING *
        `;
        return updated || locked;
      });
      return {
        success: true,
        creation: latestAfterPayloadError || currentCreation,
        progress: latestAfterPayloadError?.status === "completed"
          ? 100
          : latestAfterPayloadError?.status === "failed" ? 0 : 90,
      };
    }

    let contentUrl = null;
    let contentObjectKey = null;
    let thumbnailUrl = null;
    let thumbnailObjectKey = null;
    const existingObjectKey =
      currentCreation.content_object_key ||
      extractObjectKeyFromProxyUrl(currentCreation.content);
    const existingThumbnailObjectKey =
      currentCreation.thumbnail_object_key ||
      extractObjectKeyFromProxyUrl(currentCreation.thumbnail_url);
    const resultObjectKey =
      result.raw?.videoObjectKey ||
      extractObjectKeyFromProxyUrl(result.url);

    let persistenceStage = "oss_verify";
    try {
      let invalidExistingAsset;
      if (existingObjectKey && isProxyAssetUrl(currentCreation.content)) {
        try {
          await verifyStoredVideo(existingObjectKey);
          contentUrl = currentCreation.content;
          contentObjectKey = existingObjectKey;
          thumbnailUrl = isProxyAssetUrl(currentCreation.thumbnail_url)
            ? currentCreation.thumbnail_url
            : `/oss-proxy/${existingObjectKey}?x-oss-process=video/snapshot,t_0,f_jpg,w_640,m_fast`;
          thumbnailObjectKey = existingThumbnailObjectKey || existingObjectKey;
        } catch (error) {
          // Repair a confirmed missing/empty asset from the provider URL. A
          // timeout or permission error must not trigger a replacement upload.
          if (!isInvalidStoredVideo(error)) throw error;
          invalidExistingAsset = error;
        }
      }

      if (!contentObjectKey) {
        if (resultObjectKey && isProxyAssetUrl(result.url)) {
          if (invalidExistingAsset && resultObjectKey === existingObjectKey) throw invalidExistingAsset;
          await verifyStoredVideo(resultObjectKey);
          contentUrl = result.url;
          contentObjectKey = resultObjectKey;
        } else {
          persistenceStage = "oss_upload";
          const videoKey = objectStorage.buildObjectKey(resolvedUserId, "video", "mp4");
          const uploaded = await objectStorage.uploadFromUrl(result.url, videoKey, "video/mp4");
          contentUrl = uploaded.url;
          contentObjectKey = uploaded.objectKey;
          persistenceStage = "oss_verify";
          await verifyStoredVideo(contentObjectKey);
        }

        // Provider completion alone is not enough: the durable object above
        // must exist and contain bytes before billing and completion happen.
        thumbnailUrl = `/oss-proxy/${contentObjectKey}?x-oss-process=video/snapshot,t_0,f_jpg,w_640,m_fast`;
        thumbnailObjectKey = contentObjectKey;
      }
    } catch (persistenceError) {
      const message = `Video completed but OSS persistence verification failed: ${persistenceError.message}`;
      logger.warn("videoStatus.sync.persistence.failed", {
        creationId: currentCreation.id,
        stage: persistenceStage,
        error: persistenceError.message,
      });

      const latestAfterOssError = await sql.begin(async (tx) => {
        const [locked] = await tx`
          SELECT * FROM creations WHERE id = ${currentCreation.id} FOR UPDATE
        `;
        if (!locked || locked.charge_status !== "reserved") return locked;
        const [updated] = await tx`
          UPDATE creations
          SET status = 'running',
              provider_status = ${rawStatus},
              content = COALESCE(${contentUrl}, content),
              content_object_key = COALESCE(${contentObjectKey}, content_object_key),
              error_message = ${message},
              meta_info = ${mergeMetaInfo(buildSyncErrorMeta(persistenceStage, message, result.raw))}
          WHERE id = ${locked.id} AND charge_status = 'reserved'
          RETURNING *
        `;
        return updated || locked;
      });

      if (latestAfterOssError?.charge_status === "charged") {
        // Preserve financial history, but do not report an unverified asset
        // as a successful completion to the status/download caller.
        return { success: false, message };
      }

      return {
        success: true,
        creation: latestAfterOssError || currentCreation,
        progress: latestAfterOssError?.status === "completed"
          ? 100
          : latestAfterOssError?.status === "failed" ? 0 : 90,
      };
    }

    let settledCreation;
    try {
      settledCreation = await sql.begin(async (tx) => {
        const [locked] = await tx`
          SELECT * FROM creations WHERE id = ${currentCreation.id} FOR UPDATE
        `;
        if (!locked) throw new Error(`Creation ${currentCreation.id} not found during settlement`);

        // A concurrent reconciliation may already have completed settlement.
        // Keep its durable object instead of replacing it with a second upload.
        if (locked.charge_status === "charged") {
          // Another reconciler may have chosen a different, verified object.
          // Otherwise use this call's verified asset, including repairs to an
          // old missing object, without charging the creation a second time.
          if (locked.content_object_key && locked.content_object_key !== existingObjectKey
              && locked.content_object_key !== contentObjectKey) return locked;
          const finalContentUrl = contentUrl;
          const finalContentObjectKey = contentObjectKey;
          const finalThumbnailUrl = thumbnailUrl;
          const finalThumbnailObjectKey = thumbnailObjectKey;
          const [updated] = await tx`
            UPDATE creations
            SET status = 'completed', provider_status = ${rawStatus},
                content = ${finalContentUrl}, content_object_key = ${finalContentObjectKey},
                thumbnail_url = ${finalThumbnailUrl}, thumbnail_object_key = ${finalThumbnailObjectKey},
                error_message = NULL,
                meta_info = ${mergeMetaInfo({ providerRaw: result.raw || {}, syncError: null })}
            WHERE id = ${locked.id}
            RETURNING *
          `;
          return updated;
        }
        // A concurrent failure/timeout release wins over a late completed
        // provider response. Preserve that terminal state and let the caller
        // clean up the duplicate upload, instead of converting it to a
        // misleading running/charge error.
        if (locked.charge_status !== "reserved" || Number(locked.points_reserved || 0) <= 0) return locked;

        const pointsToCharge = Number(locked.points_reserved);
        await chargePoints({
          userId: resolvedUserId,
          amount: pointsToCharge,
          creationId: locked.id,
          idempotencyKey: `charge:creation:${locked.id}`,
          note: `结算：${locked.scene_name}`,
          tx,
        });

        const [updated] = await tx`
          UPDATE creations
          SET status = 'completed',
              provider_status = ${rawStatus},
              content = ${contentUrl},
              content_object_key = ${contentObjectKey},
              thumbnail_url = ${thumbnailUrl},
              thumbnail_object_key = ${thumbnailObjectKey},
              charge_status = 'charged',
              points_cost = ${pointsToCharge},
              points_reserved = 0,
              error_message = NULL,
              meta_info = ${mergeMetaInfo({
                providerRaw: result.raw || {},
                syncError: null,
              })}
          WHERE id = ${locked.id} AND charge_status = 'reserved'
          RETURNING *
        `;
        if (!updated) throw new Error("Video settlement state changed unexpectedly");
        return updated;
      });
    } catch (chargeErr) {
      const message = `Video settled asset persisted but point charge failed: ${chargeErr.message}`;
      logger.error("videoStatus.sync.charge.error", {
        creationId: currentCreation.id,
        error: chargeErr.message,
      });

      await sql`
        UPDATE creations
        SET status = 'running',
            provider_status = ${rawStatus},
            content = ${contentUrl},
            content_object_key = ${contentObjectKey},
            thumbnail_url = ${thumbnailUrl},
            thumbnail_object_key = ${thumbnailObjectKey},
            error_message = ${message},
            meta_info = ${mergeMetaInfo(buildSyncErrorMeta("points_charge", message, result.raw))}
        WHERE id = ${currentCreation.id} AND charge_status = 'reserved'
      `;

      return {
        success: true,
        creation: {
          ...currentCreation,
          status: "running",
          provider_status: rawStatus,
          content: contentUrl,
          thumbnail_url: thumbnailUrl,
          content_object_key: contentObjectKey,
          thumbnail_object_key: thumbnailObjectKey,
          error_message: message,
        },
        progress: 95,
      };
    }

    if (contentObjectKey && settledCreation.content_object_key !== contentObjectKey) {
      await cleanupUnreferencedObjects({
        ownerUserId: resolvedUserId,
        sourceType: "duplicate_video_upload",
        sourceId: currentCreation.id,
        objectKeys: [contentObjectKey],
      }).catch((cleanupError) => {
        logger.error("videoStatus.sync.duplicateCleanup.failed", {
          creationId: currentCreation.id,
          error: cleanupError.message,
        });
      });
    }

    return {
      success: true,
      creation: {
        ...currentCreation,
        ...settledCreation,
      },
      progress: settledCreation.status === "completed" ? 100 : settledCreation.status === "failed" ? 0 : 90,
    };
  }

  if (internalStatus === "failed") {
    const errorMessage = normalizeErrorMessage(
      result.message || result.raw?.error,
      "Generation failed or timed out."
    );

    let releasedCreation;
    try {
      releasedCreation = await sql.begin(async (tx) => {
        const [locked] = await tx`
          SELECT * FROM creations WHERE id = ${currentCreation.id} FOR UPDATE
        `;
        if (!locked) throw new Error(`Creation ${currentCreation.id} not found during release`);
        if (locked.charge_status !== "reserved") return locked;

        await releasePoints({
          userId: resolvedUserId,
          amount: Number(locked.points_reserved || 0),
          creationId: locked.id,
          idempotencyKey: `release:creation:${locked.id}`,
          note: "返还：视频生成失败",
          tx,
        });
        const [updated] = await tx`
          UPDATE creations
          SET status = 'failed',
              provider_status = ${rawStatus},
              charge_status = 'released',
              points_reserved = 0,
              error_message = ${errorMessage},
              meta_info = ${mergeMetaInfo({ providerRaw: result.raw || {}, syncError: null })}
          WHERE id = ${locked.id} AND charge_status = 'reserved'
          RETURNING *
        `;
        if (!updated) throw new Error("Video release state changed unexpectedly");
        return updated;
      });
    } catch (releaseErr) {
      const message = `Provider failed but point release failed: ${releaseErr.message}`;
      logger.error("videoStatus.sync.release.error", {
        creationId: currentCreation.id,
        error: releaseErr.message,
      });

      await sql`
        UPDATE creations
        SET status = 'running',
            provider_status = ${rawStatus},
            error_message = ${message},
            meta_info = ${mergeMetaInfo(buildSyncErrorMeta("points_release", message, result.raw))}
        WHERE id = ${currentCreation.id} AND charge_status = 'reserved'
      `;

      return {
        success: true,
        creation: {
          ...currentCreation,
          status: "running",
          provider_status: rawStatus,
          error_message: message,
        },
        progress: 5,
      };
    }

    if (releasedCreation?.charge_status !== "released") {
      return {
        success: true,
        creation: releasedCreation,
        progress: releasedCreation?.status === "completed" ? 100 : 50,
      };
    }

    return {
      success: true,
      creation: {
        ...currentCreation,
        ...releasedCreation,
      },
      progress: 0,
      errorMessage,
    };
  }

  await sql`
    UPDATE creations
    SET provider_status = ${rawStatus},
        status = ${internalStatus}
    WHERE id = ${currentCreation.id}
  `;

  return {
    success: true,
    creation: {
      ...currentCreation,
      status: internalStatus,
      provider_status: rawStatus,
    },
    progress: result.progress || (internalStatus === "running" ? 50 : 10),
  };
};
