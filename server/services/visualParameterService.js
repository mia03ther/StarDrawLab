import sql from "../configs/db.js";
import { writeAuditLog } from "./auditService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import {
  DEFAULT_VISUAL_PARAMETER_OPTIONS,
  compileVisualPrompt,
  groupVisualParameterRows,
  normalizeVisualParameterOption,
} from "../domain/visual/visualParameterCatalog.js";

const isMissingVisualParameterTable = (error) => error?.code === "42P01";

const serializeRow = (row) => ({
  id: row.id == null ? null : String(row.id),
  parameter_key: row.parameter_key,
  option_key: row.option_key,
  display_name: row.display_name,
  display_name_en: row.display_name_en,
  description: row.description || null,
  prompt_fragment: row.prompt_fragment,
  negative_prompt_fragment: row.negative_prompt_fragment || null,
  supported_output_types: Array.isArray(row.supported_output_types) ? row.supported_output_types : [],
  model_keys: Array.isArray(row.model_keys) ? row.model_keys : [],
  display_order: Number(row.display_order || 0),
  is_active: Boolean(row.is_active),
  metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
  created_at: row.created_at || null,
  updated_at: row.updated_at || null,
});

const readRows = async ({ includeInactive = false, db = sql, allowFallback = false } = {}) => {
  try {
    const rows = await db`
      SELECT id, parameter_key, option_key, display_name, display_name_en,
             description, prompt_fragment, negative_prompt_fragment,
             supported_output_types, model_keys, display_order, is_active,
             metadata, created_at, updated_at
      FROM visual_parameter_options
      WHERE ${Boolean(includeInactive)} OR is_active = TRUE
      ORDER BY parameter_key, display_order, option_key
    `;
    return rows.map(serializeRow);
  } catch (error) {
    if (!isMissingVisualParameterTable(error) || !allowFallback) throw error;
    return DEFAULT_VISUAL_PARAMETER_OPTIONS.map(serializeRow);
  }
};

export const listVisualParameterCatalog = async ({ includeInactive = false, db = sql, allowFallback = false } = {}) => {
  const rows = await readRows({ includeInactive, db, allowFallback });
  return { groups: groupVisualParameterRows(rows), source: rows[0]?.metadata?.source === "safe_fallback" ? "fallback" : "database" };
};

export const compileConfiguredVisualPrompt = async ({ basePrompt, selection, outputType, modelKey, db = sql }) => {
  const rows = await readRows({ db, allowFallback: true });
  return compileVisualPrompt({ basePrompt, selection, rows, outputType, modelKey });
};

const normalizeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    throw Object.assign(new Error("Invalid visual parameter id"), { status: 400, code: "INVALID_VISUAL_PARAMETER_ID" });
  }
  return id;
};

const saveOption = async ({ actor, body, req, reason, id = null, action }) => {
  const targetId = id || `${String(body.parameter_key || "").trim().toLowerCase()}:${String(body.option_key || "").trim().toLowerCase()}`;
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action,
    targetType: "visual_parameter_option",
    targetId,
    requestPayload: { body, reason },
    mutate: async (tx) => {
      const [existing] = id
        ? await tx`SELECT * FROM visual_parameter_options WHERE id = ${id} FOR UPDATE`
        : [null];
      if (id && !existing) throw Object.assign(new Error("Visual parameter option not found"), { status: 404, code: "VISUAL_PARAMETER_NOT_FOUND" });
      const input = normalizeVisualParameterOption(body, existing);
      const [row] = id
        ? await tx`
            UPDATE visual_parameter_options
            SET parameter_key = ${input.parameterKey}, option_key = ${input.optionKey},
                display_name = ${input.displayName}, display_name_en = ${input.displayNameEn},
                description = ${input.description}, prompt_fragment = ${input.promptFragment},
                negative_prompt_fragment = ${input.negativePromptFragment},
                supported_output_types = ${tx.json(input.supportedOutputTypes)},
                model_keys = ${tx.json(input.modelKeys)}, display_order = ${input.displayOrder},
                is_active = ${input.isActive}, metadata = ${tx.json(input.metadata)},
                updated_by_user_id = ${actor.userId}, updated_at = NOW()
            WHERE id = ${id}
            RETURNING *
          `
        : await tx`
            INSERT INTO visual_parameter_options
              (parameter_key, option_key, display_name, display_name_en, description,
               prompt_fragment, negative_prompt_fragment, supported_output_types,
               model_keys, display_order, is_active, metadata,
               created_by_user_id, updated_by_user_id)
            VALUES
              (${input.parameterKey}, ${input.optionKey}, ${input.displayName}, ${input.displayNameEn},
               ${input.description}, ${input.promptFragment}, ${input.negativePromptFragment},
               ${tx.json(input.supportedOutputTypes)}, ${tx.json(input.modelKeys)}, ${input.displayOrder},
               ${input.isActive}, ${tx.json(input.metadata)}, ${actor.userId}, ${actor.userId})
            RETURNING *
          `;
      if (!row) throw Object.assign(new Error("Visual parameter option not found"), { status: 404, code: "VISUAL_PARAMETER_NOT_FOUND" });
      await writeAuditLog({
        req, actorUserId: actor.userId, actorRole: actor.role, action,
        targetType: "visual_parameter_option", targetId: row.id, reason,
        before: existing, after: row, tx,
      });
      return serializeRow(row);
    },
  });
};

export const createVisualParameterOption = ({ actor, body, req, reason }) => saveOption({ actor, body, req, reason, action: "visual_parameter.created" });

export const updateVisualParameterOption = async ({ actor, id, body, req, reason }) => {
  const normalizedId = normalizeId(id);
  return saveOption({
    actor, body, req, reason, id: normalizedId, action: "visual_parameter.updated",
  });
};

export const deactivateVisualParameterOption = async ({ actor, id, req, reason }) => {
  const normalizedId = normalizeId(id);
  return executeAdministratorOperation({
    actor,
    idempotencyKey: req.headers["x-idempotency-key"],
    action: "visual_parameter.deactivated",
    targetType: "visual_parameter_option",
    targetId: normalizedId,
    requestPayload: { reason },
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM visual_parameter_options WHERE id = ${normalizedId} FOR UPDATE`;
      if (!before) throw Object.assign(new Error("Visual parameter option not found"), { status: 404, code: "VISUAL_PARAMETER_NOT_FOUND" });
      const [after] = await tx`
        UPDATE visual_parameter_options
        SET is_active = FALSE, updated_by_user_id = ${actor.userId}, updated_at = NOW()
        WHERE id = ${normalizedId}
        RETURNING *
      `;
      await writeAuditLog({
        req, actorUserId: actor.userId, actorRole: actor.role,
        action: "visual_parameter.deactivated", targetType: "visual_parameter_option",
        targetId: normalizedId, reason, before, after, tx,
      });
      return serializeRow(after);
    },
  });
};
