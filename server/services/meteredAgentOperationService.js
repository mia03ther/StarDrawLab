import { createHash } from "node:crypto";

import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { checkAndGrantBonus } from "./membershipService.js";
import { resolveActiveModelRoute } from "./modelConfigurationService.js";
import * as pointsService from "./pointsService.js";
import { getExecutionGovernor } from "./executionGovernorComposition.js";
import { sendOperationalAlert } from "./emailService.js";
import {
  CREATIVE_LLM_PROVIDER_KEY,
  getCreativeLlmModelKey,
} from "./creativeLlmConfiguration.js";
import {
  calculateAgentTokenCharge,
  hasAgentTokenUsage,
  normalizeAgentTokenPricing,
  normalizeAgentTokenUsage,
} from "../domain/pricing/agentTokenPricing.js";

const {
  chargePoints,
  releasePoints,
  reservePoints,
  resolveCharge,
} = pointsService;
const resolveAgentChargeRule = pointsService.resolveChargeRule || (async (args) => ({
  points_cost: await resolveCharge(args),
  meta_rule: { billing_type: "fixed" },
}));

const POINT_SOURCE_TYPE = "metered_agent_operation";
const OPERATION_TYPES = new Set([
  "canvas_agent_plan",
  "digital_human_script_optimizer",
  "generation_prompt_optimizer",
  "global_agent_plan",
]);

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
};

export const hashMeteredAgentRequest = (payload) => createHash("sha256")
  .update(JSON.stringify(canonicalize(payload ?? null)))
  .digest("hex");

export const normalizeMeteredAgentIdempotencyKey = (value) => {
  const key = String(value || "").trim();
  if (key.length < 8 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw Object.assign(new Error("A valid X-Idempotency-Key header is required"), {
      status: 400,
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  return key;
};

const fail = (message, { status = 500, code = "METERED_AGENT_OPERATION_FAILED", ...extra } = {}) => {
  throw Object.assign(new Error(message), { status, code, ...extra });
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const boundedInteger = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};

const jsonObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return object(parsed);
  } catch {
    return {};
  }
};

const providerUsageFromResult = (result) => {
  const source = object(result);
  return source.usage || source.tokenUsage || source.token_usage || null;
};

const billingMeta = (rule) => object(rule?.meta_rule || rule?.metaRule);

const reservationPointsForRule = (rule) => {
  const meta = billingMeta(rule);
  if (meta.billing_type === "token_usage") {
    return Math.max(1, Number(meta.minimum_points || rule?.points_cost || 1));
  }
  return Number(rule?.points_cost || 0);
};

const actualPointsForResult = ({ result, rule }) => {
  if (object(result).billing === "none") {
    return { pointsCost: 0, usage: null, pricing: null };
  }
  const meta = billingMeta(rule);
  if (meta.billing_type !== "token_usage") {
    return {
      pointsCost: Math.max(1, Number(rule?.points_cost || 1)),
      usage: null,
      pricing: null,
    };
  }
  const rawUsage = providerUsageFromResult(result);
  if (!hasAgentTokenUsage(rawUsage)) {
    fail("The Agent provider did not return token usage; the result cannot be billed safely", {
      status: 502,
      code: "AGENT_PROVIDER_USAGE_MISSING",
    });
  }
  const pricing = normalizeAgentTokenPricing(meta);
  return calculateAgentTokenCharge({ usage: rawUsage, pricing });
};

const pricingSnapshotForRule = (rule) => ({
  id: rule?.id || null,
  output_type: rule?.output_type || "agent",
  provider: rule?.provider || CREATIVE_LLM_PROVIDER_KEY,
  model: rule?.model || null,
  points_cost: Number(rule?.points_cost || 1),
  priority: Number(rule?.priority || 100),
  meta_rule: billingMeta(rule),
});

const settleReservedAmountTx = async ({
  tx,
  userId,
  operationId,
  reservedPoints,
  chargedPoints,
  charge = chargePoints,
  note = "结算：Agent 模型调用",
}) => {
  const reserved = Math.max(0, Number(reservedPoints || 0));
  const charged = Math.max(0, Number(chargedPoints || 0));
  if (charged > reserved) {
      await reservePoints({
        userId,
        amount: charged - reserved,
      sourceType: POINT_SOURCE_TYPE,
        sourceId: String(operationId),
        idempotencyKey: `reserve:agent-operation:${operationId}:adjust:${charged}`,
        note: "追加预占：Agent token 用量结算",
        additionalAmount: true,
        tx,
      });
  } else if (charged < reserved) {
    await releasePoints({
      userId,
      amount: reserved - charged,
      sourceType: POINT_SOURCE_TYPE,
      sourceId: String(operationId),
      idempotencyKey: `release:agent-operation:${operationId}:adjust:${charged}`,
      note: "释放预占：Agent token 用量结算",
      tx,
    });
  }
  if (charged === 0) return;
  await charge({
    userId,
    amount: charged,
    sourceType: POINT_SOURCE_TYPE,
    sourceId: String(operationId),
    idempotencyKey: `charge:agent-operation:${operationId}`,
    note,
    tx,
  });
};

const replayCompletedMeteredOperation = ({ operation, operationType, requestHash }) => {
  if (!operation) return null;
  if (operation.operation_type !== operationType || operation.request_hash !== requestHash) {
    fail("X-Idempotency-Key was already used with a different request", {
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  }
  if (operation.status === "completed") {
    return {
      replayed: true,
      operationId: operation.id,
      pointsCost: operation.points_cost,
      result: operation.response_snapshot,
    };
  }
  if (operation.status === "failed") {
    fail(operation.error_message || "The previous Agent operation failed", {
      status: 409,
      code: operation.error_code || "IDEMPOTENT_OPERATION_FAILED",
      operation_id: operation.id,
    });
  }
  return null;
};

const waitForMeteredOperationReplay = async ({
  userId,
  operationType,
  idempotencyKey,
  requestHash,
  sqlClient = sql,
}) => {
  const timeoutMs = boundedInteger(process.env.AGENT_IDEMPOTENCY_WAIT_MS, 180_000, 100, 240_000);
  const pollMs = boundedInteger(process.env.AGENT_IDEMPOTENCY_POLL_MS, 250, 5, 2_000);
  const deadline = Date.now() + timeoutMs;
  let operationId = null;

  while (Date.now() <= deadline) {
    const [operation] = await sqlClient`
      SELECT id, operation_type, request_hash, status, points_cost, response_snapshot,
             error_code, error_message
      FROM metered_agent_operations
      WHERE user_id = ${userId} AND request_idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    operationId = operation?.id || operationId;
    const replay = replayCompletedMeteredOperation({ operation, operationType, requestHash });
    if (replay) return replay;
    await wait(pollMs);
  }

  fail("The Agent operation is still in progress", {
    status: 409,
    code: "AGENT_OPERATION_IN_PROGRESS",
    operation_id: operationId,
    retryAfterSeconds: Math.max(1, Math.ceil(pollMs / 1000)),
  });
};

const persistProviderResult = async ({
  operationId,
  userId,
  result,
  usage = null,
  pricing = null,
  sqlClient = sql,
}) => sqlClient.begin(async (tx) => {
  const [operation] = await tx`
    SELECT id, status, response_snapshot
    FROM metered_agent_operations
    WHERE id = ${operationId} AND user_id = ${userId}
    FOR UPDATE
  `;
  if (!operation) fail("Metered Agent operation was not found", { status: 409, code: "OPERATION_STATE_CONFLICT" });
  if (operation.status === "completed") return operation.response_snapshot;
  if (!["reserved", "settlement_pending"].includes(operation.status)) {
    fail("Metered Agent operation cannot persist a provider result", { status: 409, code: "OPERATION_STATE_CONFLICT" });
  }
  const [updated] = await tx`
    UPDATE metered_agent_operations
    SET status = 'settlement_pending', response_snapshot = ${tx.json(result ?? null)},
        usage_snapshot = ${usage ? tx.json(normalizeAgentTokenUsage(usage)) : null},
        pricing_snapshot = ${pricing ? tx.json(pricing) : null},
        provider_completed_at = COALESCE(provider_completed_at, NOW()), updated_at = NOW(),
        error_code = NULL, error_message = NULL
    WHERE id = ${operationId} AND user_id = ${userId}
      AND status IN ('reserved', 'settlement_pending')
    RETURNING response_snapshot
  `;
  if (!updated) fail("Metered Agent provider result state changed unexpectedly", {
    status: 409,
    code: "OPERATION_STATE_CONFLICT",
  });
  return updated.response_snapshot;
});

const markProviderResultPersistenceFailure = async ({ operationId, userId, error, sqlClient = sql }) => {
  try {
    await sqlClient.begin(async (tx) => {
      await tx`
        UPDATE metered_agent_operations
        SET status = 'settlement_pending',
            error_code = 'AGENT_RESULT_PERSISTENCE_FAILED',
            error_message = ${String(error?.message || error).slice(0, 2000)},
            updated_at = NOW()
        WHERE id = ${operationId} AND user_id = ${userId} AND status = 'reserved'
      `;
    });
  } catch (stateError) {
    logger.error("meteredAgent.provider_result_state_failed", {
      operationId,
      userId,
      error: stateError.message,
    });
  }
};

const settleCompletedOperation = async ({
  operationId,
  userId,
  reservedPoints,
  chargeRule,
  result,
  sqlClient = sql,
  charge = chargePoints,
}) => {
  const billing = actualPointsForResult({ result, rule: chargeRule });
  await persistProviderResult({
    operationId,
    userId,
    result,
    usage: billing.usage,
    pricing: pricingSnapshotForRule(chargeRule),
    sqlClient,
  });
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await sqlClient.begin(async (tx) => {
        const [operation] = await tx`
          SELECT id, status, response_snapshot, reserved_points, points_cost
          FROM metered_agent_operations
          WHERE id = ${operationId} AND user_id = ${userId}
          FOR UPDATE
        `;
        if (!operation) fail("Metered Agent operation was not found", { status: 409, code: "OPERATION_STATE_CONFLICT" });
        if (operation.status === "completed") {
          return operation.response_snapshot;
        }
        if (operation.status !== "settlement_pending") {
          fail("Metered Agent operation is not awaiting settlement", { status: 409, code: "OPERATION_STATE_CONFLICT" });
        }

        await settleReservedAmountTx({
          tx,
          userId,
          operationId,
          reservedPoints: operation.reserved_points ?? reservedPoints,
          chargedPoints: billing.pointsCost,
          charge,
        });

        const [updated] = await tx`
          UPDATE metered_agent_operations
          SET status = 'completed', response_snapshot = ${tx.json(result ?? null)},
              points_cost = ${billing.pointsCost}, charged_points = ${billing.pointsCost},
              completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL,
              last_reconciliation_error = NULL
          WHERE id = ${operationId} AND status = 'settlement_pending'
          RETURNING response_snapshot
        `;
        if (!updated) fail("Metered Agent settlement state changed unexpectedly", {
          status: 409,
          code: "OPERATION_STATE_CONFLICT",
        });
        return updated.response_snapshot;
      });
    } catch (error) {
      lastError = error;
      logger.error("meteredAgent.settlement.retry", {
        operationId,
        userId,
        attempt,
        error: error.message,
      });
    }
  }

  throw Object.assign(new Error("Agent result is awaiting billing reconciliation"), {
    status: 503,
    code: "AGENT_SETTLEMENT_PENDING",
    cause: lastError,
  });
};

const normalizeReconciliationLimit = (value) => {
  const limit = Number(value ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("reconciliation limit must be an integer between 1 and 500");
  }
  return limit;
};

const normalizeReconciliationAge = (value) => {
  const milliseconds = Number(value ?? 60_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 24 * 60 * 60 * 1_000) {
    throw new TypeError("reconciliation age must be between 1000 and 86400000 milliseconds");
  }
  return milliseconds;
};

/**
 * Retries only operations with a durable provider result. Unknown provider
 * outcomes remain reserved for manual investigation and are never charged by
 * this scanner.
 */
export const reconcileMeteredAgentOperations = async ({
  sqlClient = sql,
  charge = chargePoints,
  alert = sendOperationalAlert,
  limit: rawLimit = 50,
  olderThanMs: rawOlderThanMs = 60_000,
  alertAfterAttempts = 3,
} = {}) => {
  const limit = normalizeReconciliationLimit(rawLimit);
  const olderThanMs = normalizeReconciliationAge(rawOlderThanMs);
  if (!Number.isSafeInteger(alertAfterAttempts) || alertAfterAttempts < 1 || alertAfterAttempts > 100) {
    throw new TypeError("alertAfterAttempts must be an integer between 1 and 100");
  }
  const candidates = await sqlClient`
    SELECT id, user_id, points_cost, reserved_points, charged_points,
           response_snapshot, usage_snapshot, pricing_snapshot, reconciliation_attempts
    FROM metered_agent_operations
    WHERE status = 'settlement_pending'
      AND provider_completed_at IS NOT NULL
      AND updated_at <= NOW() - (${olderThanMs} * INTERVAL '1 millisecond')
    ORDER BY updated_at ASC, id ASC
    LIMIT ${limit}
  `;

  const summary = { scanned: candidates.length, reconciled: 0, skipped: 0, failed: 0, alerted: 0 };
  for (const candidate of candidates) {
    try {
      const outcome = await sqlClient.begin(async (tx) => {
        const [operation] = await tx`
          SELECT id, user_id, status, points_cost, reserved_points, charged_points,
                 response_snapshot, usage_snapshot, pricing_snapshot, provider_completed_at
          FROM metered_agent_operations
          WHERE id = ${candidate.id}
          FOR UPDATE SKIP LOCKED
        `;
        if (!operation || operation.status !== "settlement_pending" || !operation.provider_completed_at) {
          return { skipped: true };
        }
        const pricingSnapshot = jsonObject(operation.pricing_snapshot);
        const usageSnapshot = jsonObject(operation.usage_snapshot);
        const pricingRule = {
          points_cost: operation.points_cost,
          meta_rule: pricingSnapshot.meta_rule || { billing_type: "fixed" },
          id: pricingSnapshot.id,
          provider: pricingSnapshot.provider,
          model: pricingSnapshot.model,
        };
        const billing = pricingSnapshot.meta_rule?.billing_type === "token_usage"
          ? calculateAgentTokenCharge({
            usage: usageSnapshot,
            pricing: normalizeAgentTokenPricing(pricingRule.meta_rule),
          })
          : { pointsCost: Math.max(1, Number(operation.points_cost || 1)) };
        await settleReservedAmountTx({
          tx,
          userId: operation.user_id,
          operationId: operation.id,
          reservedPoints: operation.reserved_points ?? operation.points_cost,
          chargedPoints: billing.pointsCost,
          note: "补偿结算：Agent 模型调用",
          charge,
        });
        const [updated] = await tx`
          UPDATE metered_agent_operations
          SET status = 'completed', points_cost = ${billing.pointsCost}, charged_points = ${billing.pointsCost},
              completed_at = COALESCE(completed_at, NOW()),
              updated_at = NOW(), error_code = NULL, error_message = NULL,
              last_reconciliation_at = NOW(), last_reconciliation_error = NULL
          WHERE id = ${operation.id} AND status = 'settlement_pending'
          RETURNING id
        `;
        return updated ? { reconciled: true } : { skipped: true };
      });
      if (outcome.reconciled) summary.reconciled += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      logger.error("meteredAgent.reconciliation.failed", {
        operationId: String(candidate.id),
        userId: candidate.user_id,
        error: error.message,
      });
      let failureState = null;
      try {
        [failureState] = await sqlClient`
          UPDATE metered_agent_operations
          SET reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciliation_at = NOW(),
              last_reconciliation_error = ${String(error.message || error).slice(0, 2000)},
              reconciliation_alerted_at = CASE
                WHEN reconciliation_attempts + 1 >= ${alertAfterAttempts}
                  AND reconciliation_alerted_at IS NULL THEN NOW()
                ELSE reconciliation_alerted_at
              END,
              updated_at = NOW()
          WHERE id = ${candidate.id} AND status = 'settlement_pending'
          RETURNING reconciliation_attempts, reconciliation_alerted_at
        `;
      } catch (stateError) {
        logger.error("meteredAgent.reconciliation.state_update_failed", {
          operationId: String(candidate.id),
          error: stateError.message,
        });
      }
      const attempts = Number(failureState?.reconciliation_attempts || 0);
      const firstAlert = attempts === alertAfterAttempts && failureState?.reconciliation_alerted_at;
      if (firstAlert && typeof alert === "function") {
        try {
          await alert({
            subject: "StarDraw Agent 计费结算需要处理",
            message: "Agent 供应商调用已成功，但积分结算连续失败。积分仍保持预占，请检查数据库和积分账本。",
            details: {
              operationId: String(candidate.id),
              userId: candidate.user_id,
              attempts,
              error: error.message,
            },
          });
          summary.alerted += 1;
        } catch (alertError) {
          logger.error("meteredAgent.reconciliation.alert_failed", {
            operationId: String(candidate.id),
            error: alertError.message,
          });
        }
      }
    }
  }
  return summary;
};

const releaseFailedOperation = async ({ operationId, userId, pointsCost, error }) => {
  await sql.begin(async (tx) => {
    const [operation] = await tx`
      SELECT id, status
      FROM metered_agent_operations
      WHERE id = ${operationId} AND user_id = ${userId}
      FOR UPDATE
    `;
    if (!operation || operation.status !== "reserved") return;

    await releasePoints({
      userId,
      amount: pointsCost,
      sourceType: POINT_SOURCE_TYPE,
      sourceId: String(operationId),
      idempotencyKey: `release:agent-operation:${operationId}`,
      note: "返还：Agent 模型调用失败",
      tx,
    });

    const [updated] = await tx`
      UPDATE metered_agent_operations
      SET status = 'failed', error_code = ${String(error.code || "AGENT_PROVIDER_FAILED").slice(0, 100)},
          error_message = ${String(error.message || error).slice(0, 2000)}, updated_at = NOW()
      WHERE id = ${operationId} AND status = 'reserved'
      RETURNING id
    `;
    if (!updated) fail("Metered Agent release state changed unexpectedly", {
      status: 409,
      code: "OPERATION_STATE_CONFLICT",
    });
  });
};

export const executeMeteredAgentOperation = async ({
  userId,
  membershipTier = "free",
  operationType,
  idempotencyKey,
  requestPayload,
  invoke,
  beforeInvoke = null,
  modelKey: requestedModelKey = null,
  governor = getExecutionGovernor(),
}) => {
  if (!OPERATION_TYPES.has(operationType)) {
    fail("Unsupported metered Agent operation", { status: 500, code: "INVALID_AGENT_OPERATION" });
  }
  if (typeof invoke !== "function") {
    fail("Metered Agent operation requires an invocation callback", { status: 500, code: "INVALID_AGENT_OPERATION" });
  }

  const normalizedKey = normalizeMeteredAgentIdempotencyKey(idempotencyKey);
  const requestHash = hashMeteredAgentRequest(requestPayload);
  const agentModelKey = String(requestedModelKey || getCreativeLlmModelKey()).trim().toLowerCase();
  const route = await resolveActiveModelRoute({ modelKey: agentModelKey, outputType: "agent", userId });
  if (route.provider_key !== CREATIVE_LLM_PROVIDER_KEY) {
    fail("The active Agent route uses an unsupported provider adapter", {
      status: 503,
      code: "MODEL_ROUTE_INVALID",
    });
  }

  const chargeRule = await resolveAgentChargeRule({
    outputType: "agent",
    provider: CREATIVE_LLM_PROVIDER_KEY,
    sceneKey: operationType,
    model: agentModelKey,
    seconds: null,
    size: null,
  });
  const pointsCost = reservationPointsForRule(chargeRule);

  // Admission happens before point reservation and provider invocation. The
  // same idempotency key is used by the governor, so a replay of a completed
  // metered operation does not consume another rate/daily/concurrency slot.
  let admission = null;
  if (governor) {
    try {
      admission = await governor.admit({
        userId,
        membershipTier,
        operationKey: operationType,
        queueName: "agent",
        idempotencyKey: normalizedKey,
        leaseDurationMs: 30 * 60 * 1000,
        metadata: { source: "metered_agent_operation" },
      });
    } catch (error) {
      if (error?.code !== "EXECUTION_IN_PROGRESS") throw error;
      logger.warn("meteredAgent.idempotent_replay.wait", {
        userId,
        operationType,
        leaseId: error.leaseId || null,
      });
      return waitForMeteredOperationReplay({
        userId,
        operationType,
        idempotencyKey: normalizedKey,
        requestHash,
      });
    }
  }
  await checkAndGrantBonus(userId);

  let initialized;
  try {
    initialized = await sql.begin(async (tx) => {
    const [inserted] = await tx`
      INSERT INTO metered_agent_operations
        (user_id, operation_type, request_idempotency_key, request_hash, status,
         points_cost, reserved_points, model_key, model_route_id)
      VALUES
        (${userId}, ${operationType}, ${normalizedKey}, ${requestHash}, 'initializing',
         ${pointsCost}, ${pointsCost}, ${agentModelKey}, ${route.id})
      ON CONFLICT (user_id, request_idempotency_key) DO NOTHING
      RETURNING id
    `;

    if (!inserted) {
      const [existing] = await tx`
        SELECT id, operation_type, request_hash, status, points_cost, response_snapshot,
               error_code, error_message
        FROM metered_agent_operations
        WHERE user_id = ${userId} AND request_idempotency_key = ${normalizedKey}
        FOR UPDATE
      `;
      if (!existing) fail("Idempotent Agent operation was not found", {
        status: 409,
        code: "OPERATION_STATE_CONFLICT",
      });
      if (existing.operation_type !== operationType || existing.request_hash !== requestHash) {
        fail("X-Idempotency-Key was already used with a different request", {
          status: 409,
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }
      if (existing.status === "completed") {
        return {
          replayed: true,
          operationId: existing.id,
          pointsCost: existing.points_cost,
          result: existing.response_snapshot,
        };
      }
      if (existing.status === "failed") {
        fail(existing.error_message || "The previous Agent operation failed", {
          status: 409,
          code: existing.error_code || "IDEMPOTENT_OPERATION_FAILED",
          operation_id: existing.id,
        });
      }
      fail("The Agent operation is already in progress or awaiting reconciliation", {
        status: 409,
        code: "AGENT_OPERATION_IN_PROGRESS",
        operation_id: existing.id,
      });
    }

    await reservePoints({
      userId,
      amount: pointsCost,
      sourceType: POINT_SOURCE_TYPE,
      sourceId: String(inserted.id),
      idempotencyKey: `reserve:agent-operation:${inserted.id}`,
      note: `预占：${operationType}`,
      tx,
    });

    const [reserved] = await tx`
      UPDATE metered_agent_operations
      SET status = 'reserved', updated_at = NOW()
      WHERE id = ${inserted.id} AND status = 'initializing'
      RETURNING id
    `;
    if (!reserved) fail("Agent operation reservation state changed unexpectedly", {
      status: 409,
      code: "OPERATION_STATE_CONFLICT",
    });

    return {
      replayed: false,
      operationId: inserted.id,
      pointsCost,
      chargeRule,
      route,
    };
    });
  } catch (error) {
    if (admission && !admission.replayed) {
      try {
        await governor.release({ leaseId: admission.leaseId, outcome: "failed", error });
      } catch (releaseError) {
        logger.error("executionGovernor.release.after_initialization_failure", {
          userId,
          operationType,
          error: releaseError.message,
        });
      }
    }
    throw error;
  }

  if (initialized.replayed) return initialized;
  if (admission?.replayed) {
    // The governor intentionally stores no provider response. A terminal
    // governor lease without its matching billing row is an inconsistent
    // state and must never trigger a second provider call.
    fail("Execution idempotency state has no matching Agent result", {
      status: 409,
      code: "EXECUTION_IDEMPOTENCY_STATE_CONFLICT",
    });
  }

  let providerSucceeded = false;
  try {
    if (typeof beforeInvoke === "function") await beforeInvoke({ route: initialized.route, operationId: initialized.operationId });
    const result = await invoke({ route: initialized.route });
    providerSucceeded = true;
    const persistedResult = await settleCompletedOperation({
      operationId: initialized.operationId,
      userId,
      reservedPoints: initialized.pointsCost,
      chargeRule: initialized.chargeRule,
      result,
    });
    if (admission) {
      try {
        await governor.complete({ leaseId: admission.leaseId });
      } catch (settlementError) {
        logger.error("executionGovernor.complete.failed", {
          userId,
          operationId: initialized.operationId,
          error: settlementError.message,
        });
      }
    }
    return {
      replayed: false,
      operationId: initialized.operationId,
      pointsCost,
      result: persistedResult,
    };
  } catch (error) {
    if (admission && !admission.replayed) {
      try {
        await governor.release({ leaseId: admission.leaseId, outcome: "failed", error });
      } catch (releaseError) {
        logger.error("executionGovernor.release.failed", {
          userId,
          operationId: initialized.operationId,
          error: releaseError.message,
        });
      }
    }
    if (providerSucceeded && error?.code === "AGENT_PROVIDER_USAGE_MISSING") {
      try {
        await releaseFailedOperation({
          operationId: initialized.operationId,
          userId,
          pointsCost: initialized.pointsCost,
          error,
        });
      } catch (releaseError) {
        logger.error("meteredAgent.release.missing_usage_failed", {
          userId,
          operationId: initialized.operationId,
          error: releaseError.message,
        });
      }
      throw error;
    }
    if (providerSucceeded) {
      // A provider result that could not even be persisted is not safe to
      // charge automatically. Mark it for root investigation and surface the
      // same retry-safe response as a normal pending settlement.
      if (error?.code !== "AGENT_SETTLEMENT_PENDING") {
        await markProviderResultPersistenceFailure({
          operationId: initialized.operationId,
          userId,
          error,
        });
        await sendOperationalAlert({
          subject: "StarDraw Agent 结果持久化失败",
          message: "Agent 供应商已经返回结果，但结果快照未能持久化；积分仍保持预占，禁止自动扣费。",
          details: { operationId: initialized.operationId, userId, error: error.message },
        }).catch((alertError) => logger.error("meteredAgent.provider_result_alert_failed", {
          operationId: initialized.operationId,
          error: alertError.message,
        }));
        throw Object.assign(new Error("Agent result is awaiting billing reconciliation"), {
          status: 503,
          code: "AGENT_SETTLEMENT_PENDING",
          cause: error,
        });
      }
      throw error;
    }
    try {
      await releaseFailedOperation({
        operationId: initialized.operationId,
        userId,
        pointsCost,
        error,
      });
    } catch (releaseError) {
      logger.error("meteredAgent.release.failed", {
        operationId: initialized.operationId,
        userId,
        error: releaseError.message,
      });
    }
    throw error;
  }
};
