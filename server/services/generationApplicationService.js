import { assertVideoGenerationAvailable } from "./videoMaintenance.js";
import logger from "../configs/logger.js";
import { createPostgresGenerationStore } from "../infrastructure/postgresGenerationStore.js";
import {
  appendVisualNegativePrompt,
  assertCreationIdempotencyMatch,
  assertTemplateMembership,
  composeImageProviderPrompt,
  deduplicateTemplateUserPrompt,
  hashGenerationRequest,
  inferGenerationMode,
  normalizeGenerationPrompt,
  normalizeVideoDuration,
  parseVisualParameterSelection,
  requireExpectedModelProvider,
} from "../domain/generation/generationPolicy.js";
import { VIDEO_PROVIDER_KINDS } from "../ports/mediaGenerationPort.js";
import { checkAndGrantBonus } from "./membershipService.js";
import { resolveActiveModelRoute } from "./modelConfigurationService.js";
import { cleanupUnreferencedObjects } from "./contentRecycleService.js";
import { compileConfiguredVisualPrompt } from "./visualParameterService.js";
import { resolveCharge } from "./pointsService.js";
import { getImageGenerationProvider, getVideoGenerationProvider } from "./mediaGenerationComposition.js";
import { getObjectStorage } from "./objectStorageComposition.js";

const invalid = (message, code) => Object.assign(new Error(message), { status: 400, code });

export class GenerationApplicationService {
  constructor({
    store,
    imageGeneration,
    videoGeneration,
    objectStorage,
    modelRouter,
    chargeCatalog,
    visualCompiler,
    grantMembershipBonus,
    cleanupObjects,
    isOfflineRenderEnabled = () => false,
    offlineRenderDelayMs = () => 14_000,
    offlineTaskId = (creationId, timestamp) => `offline_digital_human_${creationId}_${timestamp}`,
    publicAssetUrl = (url) => url,
    log = logger,
    now = () => Date.now(),
  } = {}) {
    const requiredFunctions = {
      modelRouter,
      chargeCatalog,
      visualCompiler,
      grantMembershipBonus,
      cleanupObjects,
      isOfflineRenderEnabled,
      offlineRenderDelayMs,
      offlineTaskId,
      publicAssetUrl,
      now,
    };
    for (const [name, dependency] of Object.entries(requiredFunctions)) {
      if (typeof dependency !== "function") throw new TypeError(`Generation application requires ${name}`);
    }
    for (const method of [
      "findTemplate",
      "getMembershipTier",
      "findDigitalHumanRole",
      "reserveImage",
      "persistImageReference",
      "persistImageTask",
      "settleImage",
      "releaseImage",
      "reserveVideo",
      "persistVideoTask",
      "releaseVideo",
    ]) {
      if (typeof store?.[method] !== "function") throw new TypeError(`Generation store requires ${method}`);
    }
    if (typeof imageGeneration?.normalizeRequest !== "function" || typeof imageGeneration?.generate !== "function") {
      throw new TypeError("Generation application requires an image generation adapter");
    }
    for (const method of ["classifyProvider", "normalizeRequest", "submit"]) {
      if (typeof videoGeneration?.[method] !== "function") {
        throw new TypeError(`Generation application requires video generation ${method}`);
      }
    }
    for (const method of ["buildObjectKey", "uploadBuffer", "uploadFromUrl", "getSignedDownloadUrl"]) {
      if (typeof objectStorage?.[method] !== "function") throw new TypeError(`Generation object storage requires ${method}`);
    }
    this.store = store;
    this.imageGeneration = imageGeneration;
    this.videoGeneration = videoGeneration;
    this.objectStorage = objectStorage;
    this.modelRouter = modelRouter;
    this.chargeCatalog = chargeCatalog;
    this.visualCompiler = visualCompiler;
    this.grantMembershipBonus = grantMembershipBonus;
    this.cleanupObjects = cleanupObjects;
    this.isOfflineRenderEnabled = isOfflineRenderEnabled;
    this.offlineRenderDelayMs = offlineRenderDelayMs;
    this.offlineTaskId = offlineTaskId;
    this.publicAssetUrl = publicAssetUrl;
    this.log = log;
    this.now = now;
  }

  async generateImage({
    userId,
    idempotencyKey,
    sceneKey,
    userPrompt,
    model,
    size,
    visualParameters,
    referenceImages = [],
  } = {}) {
    const ownerId = String(userId || "").trim();
    const requestKey = String(idempotencyKey || "").trim();
    const normalizedSceneKey = String(sceneKey || "").trim();
    if (!ownerId) throw invalid("Authenticated user is required", "USER_REQUIRED");
    if (!requestKey) throw invalid("X-Idempotency-Key header is required", "IDEMPOTENCY_KEY_REQUIRED");
    if (!normalizedSceneKey) throw invalid("scene_key is required", "SCENE_KEY_REQUIRED");
    const normalizedPrompt = normalizeGenerationPrompt(userPrompt);
    const references = Array.isArray(referenceImages) ? referenceImages : [];
    if (references.length > 4) {
      throw invalid("At most four reference images are supported.", "TOO_MANY_REFERENCE_IMAGES");
    }
    const startedAt = this.now();
    let creationId = null;
    let generatedContentObjectKey = null;
    const referenceImageUrls = [];
    const referenceImageObjectKeys = [];
    let providerTaskAccepted = false;
    let acceptedProviderTaskId = null;

    try {
      const template = await this.store.findTemplate({ userId: ownerId, sceneKey: normalizedSceneKey });
      if (!template) throw invalid("Invalid or inactive scene", "SCENE_UNAVAILABLE");
      if (template.output_type && template.output_type !== "image") {
        throw invalid("Selected scene does not generate images", "SCENE_OUTPUT_TYPE_MISMATCH");
      }
      if (String(template.required_membership_tier || "free") !== "free" && template.owner_user_id !== ownerId) {
        const membershipTier = await this.store.getMembershipTier(ownerId);
        assertTemplateMembership({ template, userId: ownerId, membershipTier });
      }

      const normalizedRequest = this.imageGeneration.normalizeRequest({
        model: model || template.default_model || "gpt-image-2",
        size,
      });
      const finalModel = normalizedRequest.model;
      const finalSize = normalizedRequest.size;
      const modelRoute = requireExpectedModelProvider(
        await this.modelRouter({ modelKey: finalModel, outputType: "image", userId: ownerId }),
        normalizedRequest.routeProviderKeys,
      );
      const upstreamModel = this.imageGeneration.normalizeRequest({
        model: modelRoute.upstream_model_id,
        size: finalSize,
      }).model;
      if (upstreamModel !== modelRoute.upstream_model_id) {
        throw Object.assign(new Error("The active image route points to an unsupported upstream model"), {
          status: 503,
          code: "MODEL_ROUTE_INVALID",
        });
      }
      if (
        references.length > 0
        && typeof this.imageGeneration.supportsReferenceImages === "function"
        && !this.imageGeneration.supportsReferenceImages(upstreamModel)
      ) {
        throw invalid(
          "The selected image model does not support reference images. Please choose a model with image-edit support.",
          "IMAGE_MODEL_REFERENCE_IMAGES_UNSUPPORTED",
        );
      }

      const deduplicatedPrompt = deduplicateTemplateUserPrompt({
        systemPrompt: template.system_prompt,
        starterPrompt: template.starter_prompt,
        userPrompt: normalizedPrompt,
      });
      const compiledVisualPrompt = await this.visualCompiler({
        basePrompt: deduplicatedPrompt.prompt,
        selection: parseVisualParameterSelection(visualParameters),
        outputType: "image",
        modelKey: finalModel,
      });
      const providerPrompt = composeImageProviderPrompt({
        systemPrompt: template.system_prompt,
        userPrompt: compiledVisualPrompt.prompt,
        negativePrompt: compiledVisualPrompt.negativePrompt,
      });
      const pointsCost = await this.chargeCatalog({
        outputType: "image",
        provider: template.target_provider,
        sceneKey: normalizedSceneKey,
        model: finalModel,
        seconds: null,
        size: finalSize,
        generationMode: inferGenerationMode({ outputType: "image", sceneKey: normalizedSceneKey }),
      });
      const requestHash = hashGenerationRequest({
        type: "image",
        sceneKey: normalizedSceneKey,
        prompt: compiledVisualPrompt.prompt,
        userPrompt: normalizedPrompt,
        visualParameters: compiledVisualPrompt.selections,
        model: finalModel,
        size: finalSize,
      }, references);

      await this.grantMembershipBonus(ownerId);
      const expiresAt = new Date(this.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const reservation = await this.store.reserveImage({
        userId: ownerId,
        template,
        sceneKey: normalizedSceneKey,
        model: finalModel,
        pointsCost,
        idempotencyKey: requestKey,
        expiresAt,
        metadata: {
          user_prompt: normalizedPrompt,
          size: finalSize,
          model: finalModel,
          model_route_id: modelRoute.id,
          reference_image_count: references.length,
          visual_parameters: compiledVisualPrompt.selections,
          prompt_deduplicated: deduplicatedPrompt.removed,
          prompt_deduplication_reason: deduplicatedPrompt.reason,
          prompt_truncated: providerPrompt.truncated,
          prompt_original_utf8_bytes: providerPrompt.originalUtf8Bytes,
          prompt_final_utf8_bytes: providerPrompt.finalUtf8Bytes,
          request_hash: requestHash,
        },
      });

      if (reservation.isExisting) {
        const existing = reservation.existing;
        assertCreationIdempotencyMatch(existing, requestHash);
        if (existing?.status === "pending" && !existing.task_id) {
          return {
            kind: "reconciliation_pending",
            creationId: existing.id,
            status: existing.status,
            pointsReserved: existing.points_reserved,
          };
        }
        if (existing?.status === "pending" && existing.task_id) {
          return {
            kind: "submitted",
            creationId: existing.id,
            status: existing.status,
            providerStatus: existing.provider_status || "queued",
            taskId: existing.task_id,
            pointsReserved: existing.points_reserved,
            expiresAt: existing.expires_at,
          };
        }
        return {
          kind: "replay",
          creationId: existing.id,
          status: existing.status,
          content: existing.content,
          thumbnailUrl: existing.thumbnail_url,
          pointsCharged: existing.points_cost,
          expiresAt: existing.expires_at,
        };
      }

      creationId = reservation.creationId;
      if (references.length > 0) {
        for (const reference of references) {
          const referenceKey = this.objectStorage.buildObjectKey(ownerId, "image_reference", "jpg");
          const uploaded = await this.objectStorage.uploadBuffer(
            reference.buffer,
            referenceKey,
            reference.mimetype || "image/jpeg",
          );
          if (!uploaded?.url || !uploaded?.objectKey) {
            throw new Error("Image reference persistence failed: missing persisted object key.");
          }
          referenceImageUrls.push(uploaded.url);
          referenceImageObjectKeys.push(uploaded.objectKey);
        }
      }
      if (referenceImageObjectKeys.length > 0) {
        await this.store.persistImageReference({
          creationId,
          referenceImageUrl: referenceImageUrls[0],
          referenceImageObjectKey: referenceImageObjectKeys[0],
          referenceImageUrls,
          referenceImageObjectKeys,
        });
      }

      const finalPrompt = providerPrompt.prompt;
      const providerReferenceImageUrls = referenceImageObjectKeys.map((objectKey) => (
        this.objectStorage.getSignedDownloadUrl(objectKey, 1800)
      ));
      const settleCompletedImage = async (providerResult) => {
        if (!providerResult?.imageUrl && !providerResult?.imageBuffer) {
          throw new Error("Image provider returned no downloadable content.");
        }

        const contentType = providerResult.imageContentType || "image/jpeg";
        const objectKey = this.objectStorage.buildObjectKey(
          ownerId,
          "image",
          contentType === "image/png" ? "png" : "jpg",
        );
        let uploaded;
        try {
          uploaded = providerResult.imageUrl
            ? await this.objectStorage.uploadFromUrl(providerResult.imageUrl, objectKey, contentType)
            : await this.objectStorage.uploadBuffer(providerResult.imageBuffer, objectKey, contentType);
        } catch (error) {
          throw new Error(`Image persistence failed: ${error.message}`);
        }
        if (!uploaded?.url || !uploaded?.objectKey) {
          throw new Error("Image persistence failed: missing persisted object key.");
        }
        generatedContentObjectKey = uploaded.objectKey;
        const generationTimeMs = this.now() - startedAt;

        await this.store.settleImage({
          userId: ownerId,
          creationId,
          pointsCost,
          contentUrl: uploaded.url,
          contentObjectKey: uploaded.objectKey,
          generationTimeMs,
          template,
          metadata: {
            providerMode: providerResult.providerMode,
            providerStatus: providerResult.providerStatus || "completed",
            model: finalModel,
            upstreamModel,
            modelRouteId: modelRoute.id,
            referenceImageCount: references.length,
            visualParameters: compiledVisualPrompt.selections,
            providerRaw: providerResult.providerRaw,
          },
        });

        this.log.info("generation.image.success", { userId: ownerId, creationId, pointsCost, generationTimeMs });
        return {
          kind: "completed",
          creationId,
          status: "completed",
          content: uploaded.url,
          thumbnailUrl: null,
          pointsCharged: pointsCost,
          expiresAt,
        };
      };

      if (typeof this.imageGeneration.submit === "function") {
        const providerResult = await this.imageGeneration.submit({
          prompt: finalPrompt,
          size: finalSize,
          referenceImages: references,
          referenceImageUrls: providerReferenceImageUrls,
          model: upstreamModel,
        });
        if (!providerResult?.success) {
          throw Object.assign(new Error(providerResult?.message || "Image task submission failed"), {
            status: Number(providerResult?.status) || 502,
            code: providerResult?.code || "IMAGE_PROVIDER_REQUEST_FAILED",
            providerCode: providerResult?.providerCode || null,
            providerDetails: providerResult?.details || null,
          });
        }
        if (providerResult.imageUrl || providerResult.imageBuffer || providerResult.status === "completed") {
          return settleCompletedImage(providerResult);
        }

        providerTaskAccepted = true;
        acceptedProviderTaskId = String(providerResult.taskId || "").trim() || null;
        if (!acceptedProviderTaskId) {
          throw Object.assign(new Error("Image provider accepted the request without returning a task ID"), {
            status: 503,
            code: "PROVIDER_TASK_ID_MISSING",
          });
        }

        let persistenceError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await this.store.persistImageTask({
              creationId,
              taskId: acceptedProviderTaskId,
              providerStatus: providerResult.providerStatus || providerResult.status || "queued",
              metadata: {
                request_hash: requestHash,
                size: finalSize,
                provider: template.target_provider,
                model: finalModel,
                upstreamModel,
                modelRouteId: modelRoute.id,
                referenceImageCount: references.length,
                referenceImageUrl: referenceImageUrls[0] || null,
                referenceImageObjectKey: referenceImageObjectKeys[0] || null,
                referenceImageUrls,
                referenceImageObjectKeys,
                visualParameters: compiledVisualPrompt.selections,
                providerRaw: providerResult.providerRaw || null,
              },
            });
            persistenceError = null;
            break;
          } catch (error) {
            persistenceError = error;
            this.log.error("generation.image.task_persistence_retry", {
              creationId,
              taskId: acceptedProviderTaskId,
              attempt,
              error: error.message,
            });
          }
        }
        if (persistenceError) {
          throw Object.assign(new Error("The provider accepted the image task, but its task ID could not be persisted"), {
            status: 503,
            code: "PROVIDER_TASK_PERSISTENCE_FAILED",
            cause: persistenceError,
          });
        }
        this.log.info("generation.image.submitted", {
          userId: ownerId,
          creationId,
          taskId: acceptedProviderTaskId,
          pointsCost,
        });
        return {
          kind: "submitted",
          creationId,
          status: "pending",
          providerStatus: providerResult.providerStatus || providerResult.status || "queued",
          taskId: acceptedProviderTaskId,
          pointsReserved: pointsCost,
          expiresAt,
        };
      }

      return settleCompletedImage(await this.imageGeneration.generate({
        prompt: finalPrompt,
        size: finalSize,
        referenceImages: references,
        referenceImageUrls: providerReferenceImageUrls,
        model: upstreamModel,
      }));
    } catch (error) {
      this.log.error("generation.image.failed", {
        userId: ownerId,
        creationId,
        providerTaskAccepted,
        acceptedProviderTaskId,
        error: error.message,
      });
      if (providerTaskAccepted || error.outcomeUnknown) {
        error.pendingReconciliation = true;
        error.creationId = creationId;
        throw error;
      }
      if (creationId) {
        try {
          const release = await this.store.releaseImage({ userId: ownerId, creationId, errorMessage: error.message });
          const cleanupObjectKeys = [...referenceImageObjectKeys, generatedContentObjectKey].filter(Boolean);
          if (release.released && cleanupObjectKeys.length > 0) {
            await this.cleanupObjects({
              ownerUserId: ownerId,
              sourceType: "failed_image_generation",
              sourceId: creationId,
              objectKeys: cleanupObjectKeys,
            }).catch((cleanupError) => {
              this.log.error("generation.image.cleanup_enqueue.failed", {
                userId: ownerId,
                creationId,
                error: cleanupError.message,
              });
            });
          }
        } catch (releaseError) {
          this.log.error("generation.image.release.failed", {
            userId: ownerId,
            creationId,
            error: releaseError.message,
          });
        }
      }
      throw error;
    }
  }

  async generateVideo({
    userId,
    idempotencyKey,
    sceneKey,
    userPrompt,
    model,
    seconds,
    size,
    visualParameters,
    referenceImages = [],
    roleId,
    requireDigitalHuman = false,
    allowOfflineRender = false,
  } = {}) {
    assertVideoGenerationAvailable();
    const ownerId = String(userId || "").trim();
    const requestKey = String(idempotencyKey || "").trim();
    const normalizedSceneKey = String(sceneKey || "").trim();
    if (!ownerId) throw invalid("Authenticated user is required", "USER_REQUIRED");
    if (!requestKey) throw invalid("X-Idempotency-Key header is required", "IDEMPOTENCY_KEY_REQUIRED");
    if (!normalizedSceneKey) throw invalid("scene_key is required", "SCENE_KEY_REQUIRED");
    const normalizedPrompt = normalizeGenerationPrompt(userPrompt);
    const references = Array.isArray(referenceImages) ? referenceImages : [];
    if (references.length > 4) {
      throw invalid("At most four reference images are supported.", "TOO_MANY_REFERENCE_IMAGES");
    }
    let creationId = null;
    let providerTaskAccepted = false;
    let acceptedProviderTaskId = null;
    const referenceImageUrls = [];
    const referenceImageObjectKeys = [];

    try {
      const template = await this.store.findTemplate({ userId: ownerId, sceneKey: normalizedSceneKey });
      if (!template) throw invalid("Invalid or inactive scene", "SCENE_UNAVAILABLE");
      if (template.output_type && template.output_type !== "video") {
        throw invalid("Selected scene does not generate videos", "SCENE_OUTPUT_TYPE_MISMATCH");
      }
      if (String(template.required_membership_tier || "free") !== "free" && template.owner_user_id !== ownerId) {
        const membershipTier = await this.store.getMembershipTier(ownerId);
        assertTemplateMembership({ template, userId: ownerId, membershipTier });
      }

      const requestedVideo = this.videoGeneration.normalizeRequest({
        provider: template.target_provider,
        model: model || template.default_model,
        size: size || template.default_size,
      });
      const isDigitalHuman = requestedVideo.kind === VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN;
      if (requireDigitalHuman && !isDigitalHuman) {
        throw invalid("Selected scene is not supported by this endpoint", "VIDEO_PROVIDER_MISMATCH");
      }
      const digitalHumanRole = isDigitalHuman && roleId
        ? await this.store.findDigitalHumanRole({ userId: ownerId, roleId })
        : null;
      const finalModel = requestedVideo.model;
      const modelRoute = requireExpectedModelProvider(
        await this.modelRouter({ modelKey: finalModel, outputType: "video", userId: ownerId }),
        requestedVideo.routeProviderKeys,
      );
      const upstreamModel = this.videoGeneration.normalizeRequest({
        provider: template.target_provider,
        model: modelRoute.upstream_model_id,
        size: requestedVideo.size,
      }).model;
      if (upstreamModel !== modelRoute.upstream_model_id) {
        throw Object.assign(new Error("The active video route points to an unsupported upstream model"), {
          status: 503,
          code: "MODEL_ROUTE_INVALID",
        });
      }
      const finalSeconds = normalizeVideoDuration({
        requestedSeconds: seconds,
        defaultSeconds: template.default_seconds,
        isDigitalHuman,
      });
      const finalSize = requestedVideo.size;
      if (template.requires_reference && references.length === 0) {
        throw invalid("This video template requires at least one reference image", "REFERENCE_IMAGE_REQUIRED");
      }

      const useOfflineRender = isDigitalHuman && allowOfflineRender && this.isOfflineRenderEnabled();
      const renderVideoUrl = digitalHumanRole?.demo_video_url || template.preview_video_url;
      const renderVideoObjectKey = digitalHumanRole?.demo_video_object_key || template.preview_video_object_key || null;
      if (useOfflineRender && !renderVideoUrl) {
        throw invalid("请先在数字人角色库或模板中心上传演示视频。", "DIGITAL_HUMAN_SOURCE_REQUIRED");
      }

      const compiledVisualPrompt = await this.visualCompiler({
        basePrompt: normalizedPrompt,
        selection: parseVisualParameterSelection(visualParameters),
        outputType: "video",
        modelKey: finalModel,
      });
      const pointsCost = await this.chargeCatalog({
        outputType: "video",
        provider: template.target_provider,
        sceneKey: normalizedSceneKey,
        model: finalModel,
        seconds: finalSeconds,
        size: finalSize,
        generationMode: inferGenerationMode({ outputType: "video", sceneKey: normalizedSceneKey }),
      });
      const requestHash = hashGenerationRequest({
        type: "video",
        sceneKey: normalizedSceneKey,
        prompt: compiledVisualPrompt.prompt,
        userPrompt: normalizedPrompt,
        model: finalModel,
        seconds: finalSeconds,
        size: finalSize,
        roleId: digitalHumanRole?.id || null,
        visualParameters: compiledVisualPrompt.selections,
      }, references);

      await this.grantMembershipBonus(ownerId);
      const expiresAt = new Date(this.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const reservation = await this.store.reserveVideo({
        userId: ownerId,
        template,
        sceneKey: normalizedSceneKey,
        model: finalModel,
        pointsCost,
        idempotencyKey: requestKey,
        expiresAt,
        metadata: {
          user_prompt: normalizedPrompt,
          seconds: finalSeconds,
          size: finalSize,
          model_route_id: modelRoute.id,
          reference_image_count: references.length,
          visual_parameters: compiledVisualPrompt.selections,
          request_hash: requestHash,
        },
      });
      if (reservation.isExisting) {
        const existing = reservation.existing;
        assertCreationIdempotencyMatch(existing, requestHash);
        if (existing?.status === "pending" && !existing.task_id) {
          return {
            kind: "reconciliation_pending",
            creationId: existing.id,
            status: existing.status,
            pointsReserved: existing.points_reserved,
          };
        }
        return {
          kind: "replay",
          creationId: existing.id,
          status: existing.status,
          taskId: existing.task_id,
          pointsReserved: existing.points_reserved,
          expiresAt: existing.expires_at,
        };
      }
      creationId = reservation.creationId;

      if (useOfflineRender) {
        const submittedAt = this.now();
        const configuredDelay = Number(this.offlineRenderDelayMs());
        const readyDelayMs = Number.isFinite(configuredDelay) ? Math.max(6_000, configuredDelay) : 14_000;
        const taskId = this.offlineTaskId(creationId, submittedAt);
        await this.store.persistVideoTask({
          creationId,
          taskId,
          providerStatus: "queued",
          metadata: {
            offlineRender: {
              enabled: true,
              source: digitalHumanRole ? "digital_human_role_video" : "template_preview_video",
              roleId: digitalHumanRole?.id || null,
              roleName: digitalHumanRole?.role_name || null,
              videoUrl: renderVideoUrl,
              videoObjectKey: renderVideoObjectKey,
              submittedAt,
              readyAt: submittedAt + readyDelayMs,
            },
            seconds: finalSeconds,
            size: finalSize,
            provider: template.target_provider,
            roleId: digitalHumanRole?.id || null,
            roleName: digitalHumanRole?.role_name || null,
            referenceImageCount: 0,
          },
        });
        this.log.info("generation.video.offline_submitted", { userId: ownerId, creationId, taskId, pointsCost });
        return {
          kind: "submitted",
          creationId,
          status: "pending",
          providerStatus: "queued",
          taskId,
          pointsReserved: pointsCost,
          expiresAt,
        };
      }

      if (!isDigitalHuman && references.length > 0) {
        for (const reference of references) {
          const objectKey = this.objectStorage.buildObjectKey(ownerId, "video_reference", "jpg");
          const uploaded = await this.objectStorage.uploadBuffer(
            reference.buffer,
            objectKey,
            reference.mimetype || "image/jpeg",
          );
          if (!uploaded?.url || !uploaded?.objectKey) {
            throw new Error("Video reference persistence failed: missing persisted object key.");
          }
          referenceImageObjectKeys.push(uploaded.objectKey);
          referenceImageUrls.push(this.publicAssetUrl(uploaded.url));
        }
      }
      // The site proxy requires a user session. Providers cannot attach that
      // session, so give the upstream short-lived OSS URLs without storing
      // signatures in creation metadata or logs.
      const providerReferenceImageUrls = referenceImageObjectKeys.map((objectKey) => (
        this.objectStorage.getSignedDownloadUrl(objectKey, 1800)
      ));

      const basePrompt = isDigitalHuman
        ? `${template.system_prompt}\n\n${compiledVisualPrompt.prompt}\n\nTarget duration: ${finalSeconds} seconds. Do not exceed this duration.`
        : `${template.system_prompt}\n\n${compiledVisualPrompt.prompt}`;
      const providerResult = await this.videoGeneration.submit({
        provider: template.target_provider,
        prompt: appendVisualNegativePrompt(basePrompt, compiledVisualPrompt.negativePrompt),
        model: upstreamModel,
        seconds: finalSeconds,
        size: finalSize,
        imageUrl: providerReferenceImageUrls[0] || null,
        imageUrls: providerReferenceImageUrls,
      });
      if (!providerResult?.success) {
        throw Object.assign(
          new Error(providerResult?.message || "Video task submission failed"),
          {
            status: Number(providerResult?.status) || 502,
            code: providerResult?.code || "VIDEO_PROVIDER_REQUEST_FAILED",
            providerCode: providerResult?.providerCode || null,
            providerStatus: providerResult?.providerStatus || null,
            providerDetails: providerResult?.details || null,
          },
        );
      }
      providerTaskAccepted = true;
      acceptedProviderTaskId = String(providerResult.taskId || "").trim() || null;
      if (!acceptedProviderTaskId) {
        throw Object.assign(new Error("Video provider accepted the request without returning a task ID"), {
          status: 503,
          code: "PROVIDER_TASK_ID_MISSING",
        });
      }

      let persistenceError = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await this.store.persistVideoTask({
            creationId,
            taskId: acceptedProviderTaskId,
            providerStatus: providerResult.providerStatus || "queued",
            metadata: {
              request_hash: requestHash,
              seconds: finalSeconds,
              size: finalSize,
              provider: template.target_provider,
              model: finalModel,
              upstreamModel,
              modelRouteId: modelRoute.id,
              referenceImageCount: isDigitalHuman ? 0 : references.length,
              referenceImageUrl: referenceImageUrls[0] || null,
              referenceImageObjectKey: referenceImageObjectKeys[0] || null,
              referenceImageUrls,
              referenceImageObjectKeys,
              visualParameters: compiledVisualPrompt.selections,
            },
          });
          persistenceError = null;
          break;
        } catch (error) {
          persistenceError = error;
          this.log.error("generation.video.task_persistence_retry", {
            creationId,
            taskId: acceptedProviderTaskId,
            attempt,
            error: error.message,
          });
        }
      }
      if (persistenceError) {
        throw Object.assign(new Error("The provider accepted the task, but its task ID could not be persisted"), {
          status: 503,
          code: "PROVIDER_TASK_PERSISTENCE_FAILED",
          cause: persistenceError,
        });
      }

      this.log.info("generation.video.submitted", {
        userId: ownerId,
        creationId,
        provider: template.target_provider,
        taskId: acceptedProviderTaskId,
        pointsCost,
      });
      return {
        kind: "submitted",
        creationId,
        status: "pending",
        providerStatus: providerResult.providerStatus || "queued",
        taskId: acceptedProviderTaskId,
        pointsReserved: pointsCost,
        expiresAt,
      };
    } catch (error) {
      this.log.error("generation.video.failed", {
        userId: ownerId,
        creationId,
        sceneKey: normalizedSceneKey,
        providerTaskAccepted,
        acceptedProviderTaskId,
        error: error.message,
      });
      if (providerTaskAccepted) {
        error.pendingReconciliation = true;
        error.creationId = creationId;
        throw error;
      }
      if (creationId) {
        try {
          const release = await this.store.releaseVideo({ userId: ownerId, creationId, errorMessage: error.message });
          if (release.released && referenceImageObjectKeys.length > 0) {
            await this.cleanupObjects({
              ownerUserId: ownerId,
              sourceType: "failed_video_generation",
              sourceId: creationId,
              objectKeys: referenceImageObjectKeys,
            }).catch((cleanupError) => {
              this.log.error("generation.video.cleanup_enqueue.failed", {
                userId: ownerId,
                creationId,
                error: cleanupError.message,
              });
            });
          }
        } catch (releaseError) {
          this.log.error("generation.video.release.failed", {
            userId: ownerId,
            creationId,
            error: releaseError.message,
          });
        }
      }
      throw error;
    }
  }
}

export const createGenerationApplicationService = (overrides = {}) => new GenerationApplicationService({
  store: createPostgresGenerationStore(),
  imageGeneration: getImageGenerationProvider(),
  videoGeneration: getVideoGenerationProvider(),
  objectStorage: getObjectStorage(),
  modelRouter: resolveActiveModelRoute,
  chargeCatalog: resolveCharge,
  visualCompiler: compileConfiguredVisualPrompt,
  grantMembershipBonus: checkAndGrantBonus,
  cleanupObjects: cleanupUnreferencedObjects,
  isOfflineRenderEnabled: () => ["1", "true", "yes", "on"].includes(
    String(process.env.DIGITAL_HUMAN_OFFLINE_RENDER || "").trim().toLowerCase(),
  ),
  offlineRenderDelayMs: () => Number(process.env.DIGITAL_HUMAN_OFFLINE_RENDER_DELAY_MS || 14_000),
  publicAssetUrl: (url) => {
    const value = String(url || "");
    if (/^https?:\/\//i.test(value)) return value;
    const base = String(process.env.APP_BASE_URL || "").replace(/\/$/, "");
    return base ? `${base}${value}` : value;
  },
  ...overrides,
});

let runtime;
export const getGenerationApplication = () => {
  if (!runtime) runtime = createGenerationApplicationService();
  return runtime;
};

export const resetGenerationApplicationForTests = () => {
  runtime = null;
};
