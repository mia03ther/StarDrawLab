import sql from "../configs/db.js";
import { resolveCharge } from "../services/pointsService.js";
import logger from "../configs/logger.js";
import { normalizeTemplateRow } from "../utils/templateData.js";
import { normalizeUploadedImages } from "../utils/imageUpload.js";
import { needsVideoReconciliation, syncVideoCreationStatus } from "../services/videoStatusService.js";
import { resolveActiveModelRoute } from "../services/modelConfigurationService.js";
import { executeMeteredAgentOperation } from "../services/meteredAgentOperationService.js";
import {
  getImageGenerationProvider,
  getVideoGenerationProvider,
} from "../services/mediaGenerationComposition.js";
import { VIDEO_PROVIDER_KINDS } from "../ports/mediaGenerationPort.js";
import { getCreativeAgent } from "../services/creativeAgentComposition.js";
import {
  assertTemplateMembership,
  inferGenerationMode,
  normalizeGenerationMetadata as normalizeMetaRule,
  normalizeVideoDuration,
  requireExpectedModelProvider,
} from "../domain/generation/generationPolicy.js";
import { getGenerationExecution } from "../services/generationExecutionService.js";
import { imageQualityFromSizeSql } from "../domain/pricing/imageQuality.js";

const imageGeneration = getImageGenerationProvider();
const videoGeneration = getVideoGenerationProvider();
const creativeAgent = getCreativeAgent();
const generationExecution = getGenerationExecution();
const templateImageQuality = imageQualityFromSizeSql(sql, sql`pt.default_size`);

const assertTemplateAccess = async (userId, template) => {
  if (String(template?.required_membership_tier || "free") === "free" || template?.owner_user_id === userId) return;
  const [account] = await sql`
    SELECT membership_tier FROM user_point_accounts WHERE user_id = ${userId}
  `;
  assertTemplateMembership({ template, userId, membershipTier: account?.membership_tier });
};

const resolvePromptOptimizationTemplate = async ({ userId, sceneKey, outputType }) => {
  const [template] = await sql`
    SELECT id, scene_key, scene_name, output_type, default_model, default_seconds,
           default_size, system_prompt, starter_prompt, requires_reference,
           owner_user_id, visibility, approval_status, required_membership_tier
    FROM prompt_templates
    WHERE scene_key = ${sceneKey} AND output_type = ${outputType} AND is_active = TRUE
      AND (
        (visibility = 'public' AND approval_status = 'approved')
        OR owner_user_id = ${userId}
      )
    LIMIT 1
  `;
  if (!template) {
    throw Object.assign(new Error("Template not found or unavailable"), {
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  }
  await assertTemplateAccess(userId, template);
  return template;
};


// ─────────────────────────────────────────────
// GET /api/ai/scenes
// ─────────────────────────────────────────────
export const getScenes = async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const outputType = (req.query.output_type || "").trim();
    const featuredOnly = String(req.query.featured_only || "").toLowerCase() === "true";
    const includeFreeform = String(req.query.include_freeform || "").toLowerCase() === "true";
    const requestedLimit = Number.parseInt(req.query.limit || "", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : null;
    const limitClause = limit ? sql`LIMIT ${limit}` : sql``;

    const templates = await sql`
      SELECT pt.scene_key, pt.scene_name, pt.output_type,
             pt.target_provider AS provider,
             pt.default_model, pt.default_seconds, pt.default_size,
             pt.is_featured, pt.featured_order,
             pt.preview_title, pt.preview_description,
             pt.preview_image_url, pt.preview_video_url, pt.starter_prompt,
             pt.placeholder_text, pt.requires_reference, pt.tags,
             pt.owner_user_id, pt.visibility, pt.approval_status, pt.required_membership_tier,
             gcr.points_cost AS charge_points_cost,
             gcr.meta_rule AS charge_meta_rule
      FROM prompt_templates pt
      LEFT JOIN LATERAL (
        SELECT id, points_cost, meta_rule, generation_mode FROM generation_charge_rules
        WHERE output_type  = pt.output_type
          AND provider     = pt.target_provider
          AND is_active    = true
          AND (
            generation_mode = CASE
              WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
              WHEN pt.output_type IN ('image', 'video') THEN 'template'
              ELSE 'all'
            END
            OR generation_mode = 'all'
          )
          AND (scene_key   = pt.scene_key OR scene_key IS NULL)
          AND (model       = pt.default_model OR model IS NULL)
          AND (seconds     = pt.default_seconds OR seconds IS NULL)
          AND (size        = pt.default_size OR size IS NULL)
          AND (
            pt.output_type <> 'image'
            OR meta_rule->>'image_quality' IS NULL
            OR meta_rule->>'image_quality' = ${templateImageQuality}
          )
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
          OR (${req.auth?.userId || null}::varchar IS NOT NULL AND pt.owner_user_id = ${req.auth?.userId || null})
        )
        AND (${outputType || null}::varchar IS NULL OR pt.output_type = ${outputType || null})
        AND (${featuredOnly} = false OR pt.is_featured = true OR (
          ${includeFreeform} = true
          AND pt.scene_key IN ('freeform_image', 'freeform_video')
        ))
      ORDER BY pt.is_featured DESC, pt.featured_order ASC, pt.display_order ASC
      ${limitClause}
    `;

    res.set("Cache-Control", "private, max-age=30, stale-while-revalidate=120");
    res.json({
      success: true,
      data: templates.map((template) => {
        const metaRule = normalizeMetaRule(template.charge_meta_rule);
        const billingType = metaRule.billing_type || "fixed";
        const pointsPerMinute = Number(metaRule.points_per_minute || template.charge_points_cost || 0);
        const minimumPoints = Math.max(0, Number(metaRule.minimum_points || 0));
        const defaultSeconds = Number(template.default_seconds || 0);
        const estimatedPoints = billingType === "per_minute"
          ? Math.max(1, minimumPoints, Math.ceil((pointsPerMinute * defaultSeconds) / 60))
          : template.charge_points_cost;

        return normalizeTemplateRow({
          ...template,
          estimated_points: estimatedPoints,
          billing_type: billingType,
          points_per_minute: billingType === "per_minute" ? pointsPerMinute : null,
          role_creation_points: metaRule.role_creation_points ?? null,
        });
      }),
    });
  } catch (err) {
    logger.error("getScenes.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/ai/estimate-points
// ─────────────────────────────────────────────
export const estimatePoints = async (req, res) => {
  try {
    const { scene_key, output_type, model, seconds, size } = req.body;

    if (!scene_key || !output_type) {
      return res.status(400).json({ success: false, message: "scene_key and output_type are required" });
    }
    if (!["image", "video"].includes(output_type)) {
      return res.status(400).json({ success: false, message: "output_type must be image or video" });
    }

    const [template] = await sql`
      SELECT * FROM prompt_templates
      WHERE scene_key = ${scene_key} AND is_active = true
        AND (
          (visibility = 'public' AND approval_status = 'approved')
          OR owner_user_id = ${req.auth.userId}
        )
    `;

    if (!template) {
      return res.status(400).json({ success: false, message: "Scene not found" });
    }
    if (template.output_type !== output_type) {
      return res.status(400).json({ success: false, message: "output_type does not match the selected scene" });
    }
    await assertTemplateAccess(req.auth.userId, template);

    const normalizedMediaRequest = output_type === "video"
      ? videoGeneration.normalizeRequest({
          provider: template.target_provider,
          model: model || template.default_model,
          size: size || template.default_size,
        })
      : imageGeneration.normalizeRequest({
          model: model || template.default_model || "gpt-image-2",
          size: size || null,
        });
    const isDigitalHumanVideo = normalizedMediaRequest.kind === VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN;
    const chargeModel = normalizedMediaRequest.model;
    const modelRoute = requireExpectedModelProvider(
      await resolveActiveModelRoute({ modelKey: chargeModel, outputType: output_type, userId: req.auth.userId }),
      normalizedMediaRequest.routeProviderKeys,
    );
    const chargeSeconds = output_type === "video"
      ? normalizeVideoDuration({
          requestedSeconds: seconds,
          defaultSeconds: template.default_seconds,
          isHeyGen: isDigitalHumanVideo,
        })
      : null;
    const chargeSize = normalizedMediaRequest.size;

    const estimated_points = await resolveCharge({
      outputType: output_type,
      provider: template.target_provider,
      sceneKey: scene_key,
      model: chargeModel,
      seconds: chargeSeconds,
      size: chargeSize,
      generationMode: inferGenerationMode({ outputType: output_type, sceneKey: scene_key }),
    });

    // Bug 6 修复：target_provider → provider，对齐 spec
    res.json({
      success: true,
      data: {
        scene_key,
        output_type,
        estimated_points,
        currency_unit: "points",
        rule_snapshot: {
          provider: template.target_provider,
          scene_key,
          model:   chargeModel,
          route_id: modelRoute.id,
          seconds: chargeSeconds,
          size:    chargeSize,
          generation_mode: inferGenerationMode({ outputType: output_type, sceneKey: scene_key }),
        },
      },
    });
  } catch (err) {
    logger.error("estimatePoints.error", { error: err.message });
    const status = err.status || 500;
    res.status(status).json({
      success: false,
      code: err.code,
      message: status >= 500 && process.env.NODE_ENV === "production" ? "Unable to estimate generation cost" : err.message,
    });
  }
};

// ─────────────────────────────────────────────
// POST /api/ai/generate-scene-image
// ─────────────────────────────────────────────
// HTTP adapter for the application-layer image generation use case.
export const generateSceneImage = async (req, res) => {
  const userId = req.auth?.userId;
  try {
    const referenceImages = await normalizeUploadedImages(
      Array.isArray(req.files)
        ? req.files.map((file) => ({
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalname: file.originalname,
          }))
        : [],
    );
    const result = await generationExecution.generateImage({
      userId,
      membershipTier: req.auth?.membershipTier || "free",
      idempotencyKey: req.headers["x-idempotency-key"],
      sceneKey: req.body?.scene_key,
      userPrompt: req.body?.user_prompt,
      model: req.body?.model,
      size: req.body?.size,
      visualParameters: req.body?.visual_parameters,
      referenceImages,
    });

    if (result.kind === "reconciliation_pending") {
      return res.status(409).json({
        success: false,
        code: "PROVIDER_TASK_PERSISTENCE_UNCERTAIN",
        creation_id: result.creationId,
        status: result.status,
        points_reserved: result.pointsReserved,
        message: "This request is awaiting provider-task reconciliation and was not submitted again.",
      });
    }
    return res.json({
      success: true,
      creation_id: result.creationId,
      status: result.status,
      provider_status: result.providerStatus,
      task_id: result.taskId,
      points_reserved: result.pointsReserved,
      content: result.content,
      thumbnail_url: result.thumbnailUrl,
      points_charged: result.pointsCharged,
      expires_at: result.expiresAt,
      message: result.kind === "submitted"
        ? "Image task submitted. It will appear here when processing completes."
        : result.kind === "replay"
          ? "Task already submitted."
          : undefined,
    });
  } catch (error) {
    logger.error("generateSceneImage.error", { userId, error: error.message });
    if (error.code === "INSUFFICIENT_POINTS") {
      return res.status(402).json({
        success: false,
        code: "INSUFFICIENT_POINTS",
        message: "Available points are insufficient for this request.",
        available_points: error.available_points,
        required_points: error.required_points,
      });
    }
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: status >= 500 && process.env.NODE_ENV === "production" ? "Image generation failed" : error.message,
    });
  }
};

const handleGenerateVideo = async (req, res, options = {}) => {
  const userId = req.auth?.userId;
  try {
    const referenceImages = await normalizeUploadedImages(
      Array.isArray(req.files)
        ? req.files.map((file) => ({
            buffer: file.buffer,
            mimetype: file.mimetype,
            originalname: file.originalname,
          }))
        : [],
    );
    const result = await generationExecution.generateVideo({
      userId,
      membershipTier: req.auth?.membershipTier || "free",
      idempotencyKey: req.headers["x-idempotency-key"],
      sceneKey: options.sceneKey || req.body?.scene_key,
      userPrompt: req.body?.user_prompt,
      model: req.body?.model,
      seconds: req.body?.seconds,
      size: req.body?.size,
      roleId: req.body?.role_id,
      visualParameters: req.body?.visual_parameters,
      referenceImages,
      requireDigitalHuman: Boolean(options.requireDigitalHuman),
      allowOfflineRender: Boolean(options.allowOfflineRender),
    });

    return res.json({
      success: true,
      creation_id: result.creationId,
      status: result.status,
      provider_status: result.providerStatus,
      task_id: result.taskId,
      points_reserved: result.pointsReserved,
      expires_at: result.expiresAt,
      message: result.kind === "replay"
        ? "Task already submitted."
        : "Video task submitted. Poll the status endpoint for updates.",
    });
  } catch (error) {
    logger.error("generateVideo.error", {
      userId,
      sceneKey: options.sceneKey || req.body?.scene_key,
      error: error.message,
    });
    if (error.pendingReconciliation) {
      return res.status(error.status || 503).json({
        success: false,
        code: error.code || "PROVIDER_TASK_PERSISTENCE_FAILED",
        creation_id: error.creationId,
        status: "pending_reconciliation",
        message: process.env.NODE_ENV === "production"
          ? "The provider accepted the task, but reconciliation is required. Points remain reserved."
          : error.message,
      });
    }
    if (error.code === "INSUFFICIENT_POINTS") {
      return res.status(402).json({
        success: false,
        code: "INSUFFICIENT_POINTS",
        message: "Available points are insufficient.",
        available_points: error.available_points,
        required_points: error.required_points,
      });
    }
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      code: error.code,
      message: status >= 500 && process.env.NODE_ENV === "production" ? "Video generation failed" : error.message,
    });
  }
};

// ─────────────────────────────────────────────
// POST /api/ai/generate-sora-video
// ─────────────────────────────────────────────
export const generateSoraVideo = async (req, res) => {
  return handleGenerateVideo(req, res);
};

// ─────────────────────────────────────────────
// POST /api/ai/generate-digital-human
// ─────────────────────────────────────────────
export const generateDigitalHumanVideo = async (req, res) => {
  return handleGenerateVideo(req, res, {
    sceneKey: req.body?.scene_key || "heygen_digital_human_video",
    requireDigitalHuman: true,
    allowOfflineRender: true,
  });
};

// ─────────────────────────────────────────────
// POST /api/ai/optimize-digital-human-script
// ─────────────────────────────────────────────
export const optimizeDigitalHumanBrief = async (req, res) => {
  const { userId } = req.auth;
  const { brief, language, duration_seconds } = req.body || {};
  const idempotencyKey = req.headers["x-idempotency-key"];

  if (!String(brief || "").trim()) {
    return res.status(400).json({ success: false, message: "brief is required" });
  }

  try {
    const optimizerRequest = {
      userId,
      brief,
      language,
      durationSeconds: duration_seconds || 30,
    };
    const operation = await executeMeteredAgentOperation({
      userId,
      operationType: "digital_human_script_optimizer",
      idempotencyKey,
      requestPayload: optimizerRequest,
      invoke: ({ route }) => creativeAgent.optimizeDigitalHumanScript({ ...optimizerRequest, modelRoute: route }),
    });
    const result = operation.result;

    logger.info("optimizeDigitalHumanBrief.success", {
      userId,
      model: result.model,
      inputLength: String(brief || "").length,
      outputLength: result.optimized.length,
    });

    res.json({
      success: true,
      data: {
        optimized: result.optimized,
        model: result.model,
        model_key: result.model_key,
        model_route_id: result.model_route_id,
        provider: result.provider,
      },
      operation_id: operation.operationId,
      points_charged: operation.pointsCost,
      idempotent_replay: operation.replayed,
    });
  } catch (err) {
    logger.error("optimizeDigitalHumanBrief.error", { userId, error: err.message });
    const status = err.code === "INSUFFICIENT_POINTS" ? 402 : (Number(err.status) || 500);
    res.status(status).json({
      success: false,
      code: err.code,
      available_points: err.available_points,
      required_points: err.required_points,
      message: status >= 500 && process.env.NODE_ENV === "production"
        ? "Script optimizer is unavailable"
        : err.message,
    });
  }
};

// ─────────────────────────────────────────────
// POST /api/ai/optimize-generation-prompt
// ─────────────────────────────────────────────
export const optimizeGenerationPrompt = async (req, res) => {
  const userId = req.auth?.userId;
  const prompt = String(req.body?.prompt || "").trim().slice(0, 4000);
  const outputType = req.body?.output_type === "video" ? "video" : "image";
  const sceneKey = String(req.body?.scene_key || "").trim().slice(0, 80);
  const language = req.body?.language === "en" ? "en" : "zh";
  if (!prompt) {
    return res.status(400).json({ success: false, code: "PROMPT_REQUIRED", message: "prompt is required" });
  }
  if (!sceneKey) {
    return res.status(400).json({ success: false, code: "SCENE_KEY_REQUIRED", message: "scene_key is required" });
  }

  try {
    const template = await resolvePromptOptimizationTemplate({ userId, sceneKey, outputType });
    const optimizerRequest = {
      userId,
      prompt,
      outputType,
      language,
      model: String(req.body?.model || template.default_model || "").trim().slice(0, 100),
      size: String(req.body?.size || template.default_size || "").trim().slice(0, 60),
      seconds: outputType === "video"
        ? Math.max(1, Math.min(300, Number(req.body?.seconds || template.default_seconds || 8)))
        : null,
      template: {
        id: template.id,
        sceneKey: template.scene_key,
        sceneName: template.scene_name,
        systemPrompt: template.system_prompt,
        starterPrompt: template.starter_prompt,
        requiresReference: template.requires_reference,
      },
    };
    const operation = await executeMeteredAgentOperation({
      userId,
      membershipTier: req.auth?.membershipTier || "free",
      operationType: "generation_prompt_optimizer",
      idempotencyKey: req.headers["x-idempotency-key"],
      requestPayload: {
        prompt,
        outputType,
        language,
        sceneKey: template.scene_key,
        templateId: template.id,
        model: optimizerRequest.model,
        size: optimizerRequest.size,
        seconds: optimizerRequest.seconds,
      },
      invoke: ({ route }) => creativeAgent.optimizeGenerationPrompt({
        ...optimizerRequest,
        modelRoute: route,
      }),
    });

    return res.json({
      success: true,
      data: operation.result,
      operation_id: operation.operationId,
      points_charged: operation.pointsCost,
      idempotent_replay: operation.replayed,
    });
  } catch (error) {
    logger.error("optimizeGenerationPrompt.error", {
      userId,
      outputType,
      sceneKey,
      code: error.code,
      error: error.message,
    });
    const status = error.code === "INSUFFICIENT_POINTS" ? 402 : (Number(error.status) || 500);
    return res.status(status).json({
      success: false,
      code: error.code || "PROMPT_OPTIMIZATION_FAILED",
      available_points: error.available_points,
      required_points: error.required_points,
      message: status >= 500 && process.env.NODE_ENV === "production"
        ? "Prompt optimizer is unavailable"
        : error.message,
    });
  }
};

// ─────────────────────────────────────────────
// GET /api/ai/video-status/:creationId
// ─────────────────────────────────────────────
export const checkVideoStatus = async (req, res) => {
  const { userId } = req.auth;
  const { creationId } = req.params;

  try {
    const [creation] = await sql`
      SELECT * FROM creations WHERE id = ${creationId} AND user_id = ${userId}
    `;

    if (!creation) return res.status(404).json({ success: false, message: "Creation not found" });

    const shouldReconcile = needsVideoReconciliation(creation);

    // 终态且资产/计费一致时直接返回
    if (!shouldReconcile && (creation.status === "completed" || creation.status === "failed")) {
      return res.json({
        success: true, creation_id: creation.id,
        status: creation.status, provider_status: creation.provider_status,
        progress: creation.status === "completed" ? 100 : 0,
        content: creation.content, thumbnail_url: creation.thumbnail_url,
        points_reserved: creation.points_reserved, points_charged: creation.points_cost,
        error_message: creation.error_message, expires_at: creation.expires_at,
      });
    }

    if (!creation.task_id) {
      return res.status(400).json({ success: false, message: "No task_id for this creation" });
    }

    const syncResult = await syncVideoCreationStatus(creation);
    if (!syncResult.success) {
      return res.status(500).json({ success: false, message: syncResult.message });
    }

    const current = syncResult.creation;

    res.json({
      success: true,
      creation_id: current.id,
      status: current.status,
      provider_status: current.provider_status,
      progress: syncResult.progress,
      content: current.status === "completed" ? current.content : null,
      thumbnail_url: current.status === "completed" ? current.thumbnail_url : null,
      points_reserved: current.points_reserved,
      points_charged: current.status === "completed" ? current.points_cost : 0,
      error_message: current.status === "failed" ? current.error_message : null,
      expires_at: current.expires_at,
    });

  } catch (err) {
    logger.error("checkVideoStatus.error", { userId, creationId, error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/ai/image-status/:creationId
// The worker owns provider polling. This endpoint is deliberately read-only
// so a browser refresh cannot create competing provider status requests.
// ─────────────────────────────────────────────
export const checkImageStatus = async (req, res) => {
  const { userId } = req.auth;
  const { creationId } = req.params;

  try {
    const [creation] = await sql`
      SELECT id, type, status, provider_status, task_id, content, thumbnail_url,
             points_reserved, points_cost, error_message, expires_at
      FROM creations
      WHERE id = ${creationId} AND user_id = ${userId} AND type = 'image'
      LIMIT 1
    `;
    if (!creation) return res.status(404).json({ success: false, message: "Creation not found" });

    return res.json({
      success: true,
      creation_id: creation.id,
      status: creation.status,
      provider_status: creation.provider_status,
      task_id: creation.task_id,
      progress: creation.status === "completed" ? 100 : creation.status === "failed" ? 0 : 50,
      content: creation.status === "completed" ? creation.content : null,
      thumbnail_url: creation.status === "completed" ? creation.thumbnail_url : null,
      points_reserved: creation.points_reserved,
      points_charged: creation.status === "completed" ? creation.points_cost : 0,
      error_message: creation.status === "failed" ? creation.error_message : null,
      expires_at: creation.expires_at,
    });
  } catch (error) {
    logger.error("checkImageStatus.error", { userId, creationId, error: error.message });
    return res.status(500).json({ success: false, message: "Unable to read image task status" });
  }
};
