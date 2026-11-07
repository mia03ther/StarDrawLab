import sql from "../configs/db.js";
import { writeAuditLog } from "./auditService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";

const OUTPUT_TYPES = new Set(["image", "video", "agent"]);
const MEMBERSHIP_TIERS = ["free", "basic", "pro", "max", "enterprise"];
const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,49}$/;
const SECRET_KEY_PATTERN = /(secret|password|private.?key|api.?key|authorization|headers?|token|cookie|credential|smtp|alipay)/i;
const SECRET_VALUE_PATTERN = /(-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|\bsk-[A-Za-z0-9_-]{16,})/i;

export class ModelConfigurationError extends Error {
  constructor(message, { status = 400, code = "MODEL_CONFIGURATION_ERROR" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (message, options) => { throw new ModelConfigurationError(message, options); };
const cleanString = (value, max = 255) => String(value ?? "").trim().slice(0, max);
const parseBoolean = (value, fallback = false) => typeof value === "boolean" ? value : fallback;

export const normalizeModelRouteId = (value) => {
  const routeId = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(routeId) || BigInt(routeId) > 9223372036854775807n) {
    fail("Invalid model route id", { code: "INVALID_MODEL_ROUTE_ID" });
  }
  return routeId;
};

const assertNoSecrets = (value, depth = 0) => {
  if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) {
    fail("Secrets cannot be stored in model configuration", { code: "SECRET_VALUE_FORBIDDEN" });
  }
  if (depth > 12 || value == null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      fail("Secrets cannot be stored in model configuration", { code: "SECRET_FIELD_FORBIDDEN" });
    }
    assertNoSecrets(child, depth + 1);
  }
};

const normalizeObject = (value, field) => {
  const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  assertNoSecrets(normalized);
  const encoded = JSON.stringify(normalized);
  if (encoded.length > 20_000) fail(`${field} is too large`, { code: "MODEL_CONFIG_TOO_LARGE" });
  return normalized;
};

const normalizeStringArray = (value, field, maxItems = 30) => {
  if (!Array.isArray(value)) return [];
  const rows = [...new Set(value.map((item) => cleanString(item, 80)).filter(Boolean))].slice(0, maxItems);
  if (JSON.stringify(rows).length > 5000) fail(`${field} is too large`, { code: "MODEL_CONFIG_TOO_LARGE" });
  return rows;
};

const normalizeModelInput = (body = {}, existing = null) => {
  const modelKey = cleanString(existing?.model_key || body.model_key, 100).toLowerCase();
  const outputType = cleanString(body.output_type ?? existing?.output_type, 20).toLowerCase();
  const tier = cleanString(body.minimum_membership_tier ?? existing?.minimum_membership_tier ?? "free", 20).toLowerCase();
  if (!MODEL_KEY_PATTERN.test(modelKey)) fail("Invalid model_key", { code: "INVALID_MODEL_KEY" });
  if (!OUTPUT_TYPES.has(outputType)) fail("Invalid output_type", { code: "INVALID_OUTPUT_TYPE" });
  if (!MEMBERSHIP_TIERS.includes(tier)) fail("Invalid minimum_membership_tier", { code: "INVALID_MEMBERSHIP_TIER" });
  const displayName = cleanString(body.display_name ?? existing?.display_name, 160);
  if (!displayName) fail("display_name is required", { code: "DISPLAY_NAME_REQUIRED" });
  return {
    modelKey,
    displayName,
    outputType,
    description: cleanString(body.description ?? existing?.description, 4000) || null,
    capabilities: normalizeObject(body.capabilities ?? existing?.capabilities, "capabilities"),
    resolutions: normalizeStringArray(body.resolutions ?? existing?.resolutions, "resolutions"),
    aspectRatios: normalizeStringArray(body.aspect_ratios ?? existing?.aspect_ratios, "aspect_ratios"),
    minimumMembershipTier: tier,
    isActive: parseBoolean(body.is_active, Boolean(existing?.is_active)),
    displayOrder: Number.isInteger(Number(body.display_order ?? existing?.display_order)) ? Number(body.display_order ?? existing?.display_order) : 0,
    metadata: normalizeObject(body.metadata ?? existing?.metadata, "metadata"),
  };
};

const normalizeRouteInput = (body = {}, existing = null) => {
  const modelKey = cleanString(body.model_key ?? existing?.model_key, 100).toLowerCase();
  const providerKey = cleanString(body.provider_key ?? existing?.provider_key, 80).toLowerCase();
  const upstreamModelId = cleanString(body.upstream_model_id ?? existing?.upstream_model_id, 160);
  if (!MODEL_KEY_PATTERN.test(modelKey)) fail("Invalid model_key", { code: "INVALID_MODEL_KEY" });
  if (!PROVIDER_KEY_PATTERN.test(providerKey)) fail("Invalid provider_key", { code: "INVALID_PROVIDER_KEY" });
  if (!upstreamModelId) fail("upstream_model_id is required", { code: "UPSTREAM_MODEL_REQUIRED" });
  return {
    modelKey,
    providerKey,
    upstreamModelId,
    priority: Number.isInteger(Number(body.priority ?? existing?.priority)) ? Number(body.priority ?? existing?.priority) : 100,
    isActive: parseBoolean(body.is_active, Boolean(existing?.is_active)),
    routeConfig: normalizeObject(body.route_config ?? existing?.route_config, "route_config"),
  };
};

const assertRouteProviderCompatible = (providerKey, model) => {
  const capabilities = model?.capabilities && typeof model.capabilities === "object"
    ? model.capabilities
    : {};
  const allowedProviders = model?.output_type === "image"
    ? new Set(["image_provider"])
    : model?.output_type === "agent"
      ? new Set(["canvas_agent"])
      : capabilities.digital_human === true
        ? new Set(["heygen_video_agent"])
        : new Set(["sora"]);
  if (!allowedProviders.has(providerKey)) {
    fail("The provider adapter is not available for this model output type", {
      status: 409,
      code: "MODEL_PROVIDER_UNSUPPORTED",
    });
  }
};

export const listModelCatalog = async ({ includeInactive = false } = {}) => sql`
  SELECT model_key, display_name, output_type, description, capabilities,
         resolutions, aspect_ratios, minimum_membership_tier, is_active,
         display_order, metadata, created_at, updated_at
  FROM model_catalog
  WHERE (${Boolean(includeInactive)} OR is_active = TRUE)
  ORDER BY output_type, display_order, model_key
`;

export const listModelRoutes = async ({ includeInactive = true } = {}) => sql`
  SELECT r.id, r.model_key, m.display_name, m.output_type, r.provider_key,
         r.upstream_model_id, r.priority, r.is_active, r.route_config,
         r.created_at, r.updated_at
  FROM model_routes r
  JOIN model_catalog m ON m.model_key = r.model_key
  WHERE (${Boolean(includeInactive)} OR r.is_active = TRUE)
  ORDER BY r.model_key, r.priority, r.id
`;

export const listAvailableModels = async ({ userId, outputType = null, db = sql }) => {
  const normalizedType = cleanString(outputType, 20).toLowerCase() || null;
  if (normalizedType && !OUTPUT_TYPES.has(normalizedType)) fail("Invalid output_type", { code: "INVALID_OUTPUT_TYPE" });
  const [account] = await db`
    SELECT COALESCE(membership_tier, 'free') AS membership_tier
    FROM user_point_accounts WHERE user_id = ${userId}
  `;
  const userRank = Math.max(0, MEMBERSHIP_TIERS.indexOf(String(account?.membership_tier || "free")));
  const rows = await db`
    SELECT model_key, display_name, output_type, description, capabilities,
           resolutions, aspect_ratios, minimum_membership_tier, display_order
    FROM model_catalog
    WHERE is_active = TRUE
      AND (${normalizedType}::text IS NULL OR output_type = ${normalizedType})
      AND EXISTS (
        SELECT 1 FROM model_routes r
        WHERE r.model_key = model_catalog.model_key AND r.is_active = TRUE
      )
    ORDER BY output_type, display_order, model_key
  `;
  return rows.filter((row) => MEMBERSHIP_TIERS.indexOf(row.minimum_membership_tier) <= userRank);
};

export const resolveActiveModelRoute = async ({ modelKey, outputType, userId = null, db = sql }) => {
  const key = cleanString(modelKey, 100).toLowerCase();
  const type = cleanString(outputType, 20).toLowerCase();
  const [route] = await db`
    SELECT r.id, r.model_key, r.provider_key, r.upstream_model_id,
           r.priority, r.route_config, m.output_type, m.minimum_membership_tier
    FROM model_routes r
    JOIN model_catalog m ON m.model_key = r.model_key
    WHERE r.model_key = ${key} AND m.output_type = ${type}
      AND r.is_active = TRUE AND m.is_active = TRUE
    ORDER BY r.priority, r.id
    LIMIT 1
  `;
  if (!route) fail("The selected model is unavailable", { status: 400, code: "MODEL_UNAVAILABLE" });
  if (userId) {
    const [account] = await db`
      SELECT COALESCE(membership_tier, 'free') AS membership_tier
      FROM user_point_accounts
      WHERE user_id = ${userId}
    `;
    const actualRank = Math.max(0, MEMBERSHIP_TIERS.indexOf(String(account?.membership_tier || "free")));
    const requiredRank = MEMBERSHIP_TIERS.indexOf(String(route.minimum_membership_tier || "free"));
    if (requiredRank > actualRank) {
      fail(`The selected model requires ${route.minimum_membership_tier} membership or above`, {
        status: 403,
        code: "MODEL_MEMBERSHIP_REQUIRED",
      });
    }
  }
  return route;
};

export const resolveTemplateModelSelection = async ({ modelKey = null, outputType, userId = null, db = sql }) => {
  const type = cleanString(outputType, 20).toLowerCase();
  if (!["image", "video"].includes(type)) fail("Templates must use an image or video model", { code: "INVALID_OUTPUT_TYPE" });
  let key = cleanString(modelKey, 100).toLowerCase();
  if (userId) {
    const available = await listAvailableModels({ userId, outputType: type, db });
    if (!key) key = available[0]?.model_key || "";
    if (!available.some((model) => model.model_key === key)) {
      fail("The selected model is not available for this account", { status: 403, code: "MODEL_MEMBERSHIP_REQUIRED" });
    }
  }
  if (!key) {
    const [defaultRoute] = await db`
      SELECT r.id, r.model_key, r.provider_key, r.upstream_model_id,
             r.priority, r.route_config, m.output_type
      FROM model_routes r
      JOIN model_catalog m ON m.model_key = r.model_key
      WHERE m.output_type = ${type} AND r.is_active = TRUE AND m.is_active = TRUE
      ORDER BY m.display_order, r.priority, r.id
      LIMIT 1
    `;
    if (!defaultRoute) fail("No active model route is configured", { status: 409, code: "MODEL_ROUTE_MISSING" });
    return { modelKey: defaultRoute.model_key, targetProvider: defaultRoute.provider_key, route: defaultRoute };
  }
  const route = await resolveActiveModelRoute({ modelKey: key, outputType: type, userId, db });
  return { modelKey: route.model_key, targetProvider: route.provider_key, route };
};

const syncTemplateRouting = async (tx, modelKey) => {
  const [selectedRoute] = await tx`
    SELECT provider_key FROM model_routes
    WHERE model_key = ${modelKey} AND is_active = TRUE
    ORDER BY priority, id
    LIMIT 1
  `;
  if (!selectedRoute) return;
  const templates = await tx`
    SELECT scene_key, output_type, target_provider
    FROM prompt_templates
    WHERE default_model = ${modelKey}
    FOR UPDATE
  `;
  for (const template of templates) {
    if (template.target_provider === selectedRoute.provider_key) continue;
    await tx`
      UPDATE generation_charge_rules
      SET provider = ${selectedRoute.provider_key}, updated_at = NOW()
      WHERE output_type = ${template.output_type}
        AND scene_key = ${template.scene_key}
        AND provider = ${template.target_provider}
    `;
  }
  const [unpricedTemplate] = await tx`
    SELECT templates.scene_key
    FROM prompt_templates templates
    WHERE templates.default_model = ${modelKey}
      AND NOT EXISTS (
        SELECT 1
        FROM generation_charge_rules rules
        WHERE rules.output_type = templates.output_type
          AND rules.provider = ${selectedRoute.provider_key}
          AND rules.is_active = TRUE
          AND (rules.scene_key = templates.scene_key OR rules.scene_key IS NULL)
      )
    LIMIT 1
  `;
  if (unpricedTemplate) {
    fail("The selected provider has no active pricing rule for an affected template", {
      status: 409,
      code: "MODEL_ROUTE_PRICING_MISSING",
    });
  }
  await tx`
    UPDATE prompt_templates
    SET target_provider = ${selectedRoute.provider_key}, updated_at = NOW()
    WHERE default_model = ${modelKey}
      AND target_provider <> ${selectedRoute.provider_key}
  `;
};

const assertActiveTemplatesHaveRoute = async (tx, modelKey) => {
  const [blocked] = await tx`
    SELECT EXISTS (
      SELECT 1 FROM prompt_templates
      WHERE default_model = ${modelKey} AND is_active = TRUE
    ) AS has_active_templates,
    EXISTS (
      SELECT 1 FROM model_routes
      WHERE model_key = ${modelKey} AND is_active = TRUE
    ) AS has_active_routes
  `;
  if (blocked?.has_active_templates && !blocked?.has_active_routes) {
    fail("An active template still depends on this model route", {
      status: 409,
      code: "MODEL_ROUTE_IN_USE",
    });
  }
};

const assertModelHasNoActiveTemplates = async (tx, modelKey) => {
  const [template] = await tx`
    SELECT id FROM prompt_templates
    WHERE default_model = ${modelKey} AND is_active = TRUE
    LIMIT 1
  `;
  if (template) {
    fail("Active templates must be reassigned or deactivated before this model can be disabled", {
      status: 409,
      code: "MODEL_IN_USE",
    });
  }
};

export const createModel = async ({ actor, body, req, reason }) => {
  const input = normalizeModelInput(body);
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "model.created",
    targetType: "model",
    targetId: input.modelKey,
    requestPayload: { body, reason },
    mutate: async (tx) => {
    const [row] = await tx`
      INSERT INTO model_catalog
        (model_key, display_name, output_type, description, capabilities,
         resolutions, aspect_ratios, minimum_membership_tier, is_active,
         display_order, metadata, created_by_user_id, updated_by_user_id)
      VALUES
        (${input.modelKey}, ${input.displayName}, ${input.outputType}, ${input.description},
         ${tx.json(input.capabilities)}, ${tx.json(input.resolutions)}, ${tx.json(input.aspectRatios)},
         ${input.minimumMembershipTier}, ${input.isActive}, ${input.displayOrder},
         ${tx.json(input.metadata)}, ${actor.userId}, ${actor.userId})
      RETURNING *
    `;
    await syncTemplateRouting(tx, row.model_key);
    await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model.created", targetType: "model", targetId: row.model_key, reason, after: row, tx });
    return row;
    },
  });
};

export const updateModel = async ({ actor, modelKey, body, req, reason }) => executeAdministratorOperation({
  actor,
  idempotencyKey: req.headers["x-idempotency-key"],
  action: "model.updated",
  targetType: "model",
  targetId: cleanString(modelKey, 100).toLowerCase(),
  requestPayload: { body, reason },
  mutate: async (tx) => {
  const [before] = await tx`SELECT * FROM model_catalog WHERE model_key = ${cleanString(modelKey, 100).toLowerCase()} FOR UPDATE`;
  if (!before) fail("Model not found", { status: 404, code: "MODEL_NOT_FOUND" });
  const input = normalizeModelInput(body, before);
  const outputTypeChanged = input.outputType !== before.output_type;
  const providerClassChanged = before.output_type === "video"
    && Boolean(before.capabilities?.digital_human) !== Boolean(input.capabilities?.digital_human);
  if (outputTypeChanged || providerClassChanged) {
    const [dependencies] = await tx`
      SELECT
        EXISTS(SELECT 1 FROM model_routes WHERE model_key = ${before.model_key}) AS has_routes,
        EXISTS(SELECT 1 FROM prompt_templates WHERE default_model = ${before.model_key}) AS has_templates
    `;
    if (dependencies?.has_routes || dependencies?.has_templates) {
      fail("Routing-related model fields cannot be changed while routes or templates use this model", {
        status: 409,
        code: outputTypeChanged ? "MODEL_OUTPUT_TYPE_IN_USE" : "MODEL_PROVIDER_CLASS_IN_USE",
      });
    }
  }
  if (before.is_active && !input.isActive) {
    await assertModelHasNoActiveTemplates(tx, before.model_key);
  }
  const [after] = await tx`
    UPDATE model_catalog
    SET display_name = ${input.displayName}, output_type = ${input.outputType},
        description = ${input.description}, capabilities = ${tx.json(input.capabilities)},
        resolutions = ${tx.json(input.resolutions)}, aspect_ratios = ${tx.json(input.aspectRatios)},
        minimum_membership_tier = ${input.minimumMembershipTier}, is_active = ${input.isActive},
        display_order = ${input.displayOrder}, metadata = ${tx.json(input.metadata)},
        updated_by_user_id = ${actor.userId}, updated_at = NOW()
    WHERE model_key = ${before.model_key}
    RETURNING *
  `;
  await syncTemplateRouting(tx, after.model_key);
  await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model.updated", targetType: "model", targetId: after.model_key, reason, before, after, tx });
  return after;
  },
});

export const deactivateModel = async ({ actor, modelKey, req, reason }) => executeAdministratorOperation({
  actor,
  idempotencyKey: req.headers["x-idempotency-key"],
  action: "model.deactivated",
  targetType: "model",
  targetId: cleanString(modelKey, 100).toLowerCase(),
  requestPayload: { reason },
  mutate: async (tx) => {
  const [before] = await tx`SELECT * FROM model_catalog WHERE model_key = ${cleanString(modelKey, 100).toLowerCase()} FOR UPDATE`;
  if (!before) fail("Model not found", { status: 404, code: "MODEL_NOT_FOUND" });
  await assertModelHasNoActiveTemplates(tx, before.model_key);
  const [after] = await tx`
    UPDATE model_catalog SET is_active = FALSE, updated_by_user_id = ${actor.userId}, updated_at = NOW()
    WHERE model_key = ${before.model_key} RETURNING *
  `;
  await tx`UPDATE model_routes SET is_active = FALSE, updated_by_user_id = ${actor.userId}, updated_at = NOW() WHERE model_key = ${before.model_key}`;
  await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model.deactivated", targetType: "model", targetId: after.model_key, reason, before, after, tx });
  return after;
  },
});

export const createModelRoute = async ({ actor, body, req, reason }) => {
  const input = normalizeRouteInput(body);
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "model_route.created",
    targetType: "model_route",
    targetId: `${input.modelKey}:${input.providerKey}`,
    requestPayload: { body, reason },
    mutate: async (tx) => {
    const [model] = await tx`SELECT model_key, output_type, capabilities FROM model_catalog WHERE model_key = ${input.modelKey} FOR SHARE`;
    if (!model) fail("Model not found", { status: 404, code: "MODEL_NOT_FOUND" });
    assertRouteProviderCompatible(input.providerKey, model);
    const [row] = await tx`
      INSERT INTO model_routes
        (model_key, provider_key, upstream_model_id, priority, is_active,
         route_config, created_by_user_id, updated_by_user_id)
      VALUES
        (${input.modelKey}, ${input.providerKey}, ${input.upstreamModelId}, ${input.priority},
         ${input.isActive}, ${tx.json(input.routeConfig)}, ${actor.userId}, ${actor.userId})
      RETURNING *
    `;
    await syncTemplateRouting(tx, row.model_key);
    await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model_route.created", targetType: "model_route", targetId: row.id, reason, after: row, tx });
    return row;
    },
  });
};

export const updateModelRoute = async ({ actor, routeId, body, req, reason }) => {
  const normalizedRouteId = normalizeModelRouteId(routeId);
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "model_route.updated",
    targetType: "model_route",
    targetId: String(normalizedRouteId),
    requestPayload: { body, reason },
    mutate: async (tx) => {
    const [before] = await tx`SELECT * FROM model_routes WHERE id = ${normalizedRouteId} FOR UPDATE`;
    if (!before) fail("Model route not found", { status: 404, code: "MODEL_ROUTE_NOT_FOUND" });
    const input = normalizeRouteInput(body, before);
    const [model] = await tx`SELECT model_key, output_type, capabilities FROM model_catalog WHERE model_key = ${input.modelKey} FOR SHARE`;
    if (!model) fail("Model not found", { status: 404, code: "MODEL_NOT_FOUND" });
    assertRouteProviderCompatible(input.providerKey, model);
    const [after] = await tx`
      UPDATE model_routes
      SET model_key = ${input.modelKey}, provider_key = ${input.providerKey},
          upstream_model_id = ${input.upstreamModelId}, priority = ${input.priority},
          is_active = ${input.isActive}, route_config = ${tx.json(input.routeConfig)},
          updated_by_user_id = ${actor.userId}, updated_at = NOW()
    WHERE id = ${before.id}
    RETURNING *
  `;
    await assertActiveTemplatesHaveRoute(tx, before.model_key);
    if (after.model_key !== before.model_key) await assertActiveTemplatesHaveRoute(tx, after.model_key);
    await syncTemplateRouting(tx, before.model_key);
    if (after.model_key !== before.model_key) await syncTemplateRouting(tx, after.model_key);
    await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model_route.updated", targetType: "model_route", targetId: after.id, reason, before, after, tx });
    return after;
    },
  });
};

export const deactivateModelRoute = async ({ actor, routeId, req, reason }) => {
  const normalizedRouteId = normalizeModelRouteId(routeId);
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "model_route.deactivated",
    targetType: "model_route",
    targetId: String(normalizedRouteId),
    requestPayload: { reason },
    mutate: async (tx) => {
    const [before] = await tx`SELECT * FROM model_routes WHERE id = ${normalizedRouteId} FOR UPDATE`;
    if (!before) fail("Model route not found", { status: 404, code: "MODEL_ROUTE_NOT_FOUND" });
    const [after] = await tx`
    UPDATE model_routes SET is_active = FALSE, updated_by_user_id = ${actor.userId}, updated_at = NOW()
    WHERE id = ${before.id} RETURNING *
    `;
    await assertActiveTemplatesHaveRoute(tx, after.model_key);
    await syncTemplateRouting(tx, after.model_key);
    await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "model_route.deactivated", targetType: "model_route", targetId: after.id, reason, before, after, tx });
    return after;
    },
  });
};
