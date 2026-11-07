import sql from "../configs/db.js";
import { hasPermission, PERMISSIONS } from "./accessControlService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { writeAuditLog } from "./auditService.js";
import { normalizeGenerationChargeRule } from "../domain/pricing/generationChargeRule.js";

const fail = (message, status = 400, code = "GENERATION_CHARGE_RULE_INVALID") => {
  throw Object.assign(new Error(message), { status, code });
};

const assertPermission = (actor) => {
  if (!hasPermission(actor?.role, PERMISSIONS.CHARGE_RULE_MANAGE)) {
    fail("Generation charge rule management permission is required", 403, "USER_RBAC_DENIED");
  }
};

const normalizeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    fail("ruleId is invalid", 400, "INVALID_GENERATION_CHARGE_RULE_ID");
  }
  return id;
};

const orderBy = (db) => db`
  ORDER BY priority ASC, id ASC
`;

export const listGenerationChargeRules = async ({ actor, db = sql } = {}) => {
  assertPermission(actor);
  return db`
    SELECT id, output_type, provider, scene_key, model, seconds, size,
           points_cost, priority, generation_mode, is_active, meta_rule,
           created_at, updated_at
    FROM generation_charge_rules
    ${orderBy(db)}
  `;
};

export const saveGenerationChargeRule = async ({
  actor,
  ruleId = null,
  input = {},
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPermission(actor);
  const id = ruleId == null ? null : normalizeId(ruleId);
  const action = id ? "generation_charge_rule.updated" : "generation_charge_rule.created";
  const targetId = id || `${input.output_type || input.outputType}:${input.provider}:${input.generation_mode || input.generationMode || "all"}:${input.scene_key || input.sceneKey || "*"}`;
  if (!String(targetId).trim()) fail("output_type and provider are required");

  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action,
    targetType: "generation_charge_rule",
    targetId,
    requestPayload: { input, reason },
    mutate: async (tx) => {
      const [before] = id
        ? await tx`SELECT * FROM generation_charge_rules WHERE id = ${id} FOR UPDATE`
        : [null];
      if (id && !before) fail("Charge rule not found", 404, "GENERATION_CHARGE_RULE_NOT_FOUND");
      const normalized = normalizeGenerationChargeRule(input, before);
      const [after] = id
        ? await tx`
            UPDATE generation_charge_rules
            SET output_type = ${normalized.outputType}, provider = ${normalized.provider},
                scene_key = ${normalized.sceneKey}, model = ${normalized.model},
                seconds = ${normalized.seconds}, size = ${normalized.size},
                points_cost = ${normalized.pointsCost}, priority = ${normalized.priority},
                generation_mode = ${normalized.generationMode}, is_active = ${normalized.isActive},
                meta_rule = ${tx.json(normalized.metaRule)}, updated_at = NOW()
            WHERE id = ${before.id}
            RETURNING *
          `
        : await tx`
            INSERT INTO generation_charge_rules
              (output_type, provider, scene_key, model, seconds, size, points_cost,
               priority, generation_mode, is_active, meta_rule)
            VALUES
              (${normalized.outputType}, ${normalized.provider}, ${normalized.sceneKey},
               ${normalized.model}, ${normalized.seconds}, ${normalized.size},
               ${normalized.pointsCost}, ${normalized.priority}, ${normalized.generationMode},
               ${normalized.isActive}, ${tx.json(normalized.metaRule)})
            RETURNING *
          `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "generation_charge_rule",
        targetId: after.id,
        reason: reason || (id ? "Charge rule updated" : "Charge rule created"),
        before,
        after,
        tx,
      });
      return after;
    },
  });
};

export const deactivateGenerationChargeRule = async ({
  actor,
  ruleId,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPermission(actor);
  const id = normalizeId(ruleId);
  const cleanReason = String(reason || "").trim().slice(0, 2000);
  if (!cleanReason) fail("reason is required", 400, "REASON_REQUIRED");
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action: "generation_charge_rule.deactivated",
    targetType: "generation_charge_rule",
    targetId: id,
    requestPayload: { reason: cleanReason },
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM generation_charge_rules WHERE id = ${id} FOR UPDATE`;
      if (!before) fail("Charge rule not found", 404, "GENERATION_CHARGE_RULE_NOT_FOUND");
      const [after] = await tx`
        UPDATE generation_charge_rules
        SET is_active = FALSE, updated_at = NOW()
        WHERE id = ${before.id}
        RETURNING *
      `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "generation_charge_rule.deactivated",
        targetType: "generation_charge_rule",
        targetId: id,
        reason: cleanReason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};
