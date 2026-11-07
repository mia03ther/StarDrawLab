import sql from "../configs/db.js";
import { isAdministratorEditableTemplate } from "../domain/templates/templateEditingPolicy.js";
import { normalizeTemplateRow } from "../utils/templateData.js";
import { hasPermission, PERMISSIONS } from "./accessControlService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { writeAuditLog } from "./auditService.js";
import { deleteContentAsAdministrator } from "./contentRecycleService.js";

const MEMBERSHIP_TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);

const fail = (message, status = 400, code = "ADMIN_TEMPLATE_INVALID") => {
  throw Object.assign(new Error(message), { status, code });
};

const assertTemplatePermission = (actor) => {
  if (!hasPermission(actor?.role, PERMISSIONS.TEMPLATE_MANAGE)) {
    fail("Template management permission is required", 403, "USER_RBAC_DENIED");
  }
};

const normalizeTemplateId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    fail("templateId is invalid", 400, "INVALID_TEMPLATE_ID");
  }
  return id;
};

const templateSelect = (db) => db`
  SELECT pt.*,
         gcr.points_cost
  FROM prompt_templates pt
  LEFT JOIN LATERAL (
    SELECT points_cost
    FROM generation_charge_rules
    WHERE output_type = pt.output_type
      AND provider = pt.target_provider
      AND (
        generation_mode = CASE
          WHEN pt.output_type IN ('image', 'video') AND pt.scene_key = 'freeform_' || pt.output_type THEN 'freeform'
          WHEN pt.output_type IN ('image', 'video') THEN 'template'
          ELSE 'all'
        END
        OR generation_mode = 'all'
      )
      AND scene_key = pt.scene_key
      AND model IS NULL
      AND seconds IS NULL
      AND size IS NULL
      AND is_active = TRUE
    ORDER BY priority ASC, id ASC
    LIMIT 1
  ) gcr ON TRUE
`;

export const listAdministratorTemplates = async ({ actor, publicationRequests = false, db = sql } = {}) => {
  assertTemplatePermission(actor);
  const rows = publicationRequests
    ? await db`
        ${templateSelect(db)}
        WHERE pt.owner_user_id IS NOT NULL
          AND pt.visibility = 'private'
          AND pt.approval_status = 'pending'
          AND pt.publication_requested_at IS NOT NULL
        ORDER BY pt.publication_requested_at ASC NULLS LAST, pt.id ASC
      `
    : await db`
        ${templateSelect(db)}
        WHERE (pt.owner_user_id IS NULL OR pt.visibility = 'public' OR (pt.visibility = 'private' AND pt.approval_status = 'pending' AND pt.publication_requested_at IS NOT NULL))
        ORDER BY pt.is_featured DESC, pt.featured_order ASC, pt.display_order ASC, pt.id ASC
      `;
  return rows.map(normalizeTemplateRow);
};

export const reviewTemplatePublication = async ({
  actor,
  templateId,
  decision,
  requiredMembershipTier = "free",
  note,
  idempotencyKey,
  req,
} = {}) => {
  assertTemplatePermission(actor);
  const id = normalizeTemplateId(templateId);
  const normalizedDecision = String(decision || "").trim().toLowerCase();
  if (!["approve", "reject"].includes(normalizedDecision)) {
    fail("decision must be approve or reject", 400, "INVALID_TEMPLATE_REVIEW_DECISION");
  }
  const tier = String(requiredMembershipTier || "free").trim().toLowerCase();
  if (!MEMBERSHIP_TIERS.has(tier)) fail("Invalid required membership tier", 400, "INVALID_MEMBERSHIP_TIER");
  const reviewNote = String(note || (normalizedDecision === "approve" ? "Template publication approved" : "Template publication rejected"))
    .trim().slice(0, 2000);
  if (!reviewNote) fail("Review note is required", 400, "REASON_REQUIRED");
  const approved = normalizedDecision === "approve";
  const action = approved ? "template.publication_approved" : "template.publication_rejected";
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action,
    targetType: "prompt_template",
    targetId: id,
    requestPayload: { decision: normalizedDecision, required_membership_tier: tier, note: reviewNote },
    mutate: async (tx) => {
      const [before] = await tx`
        SELECT * FROM prompt_templates
        WHERE id = ${id} AND owner_user_id IS NOT NULL
        FOR UPDATE
      `;
      if (!before || before.visibility !== "private" || before.approval_status !== "pending" || !before.publication_requested_at) {
        fail("Pending template request not found", 404, "TEMPLATE_PUBLICATION_REQUEST_NOT_FOUND");
      }
      const [after] = approved
        ? await tx`
            UPDATE prompt_templates
            SET visibility = 'public', approval_status = 'approved', is_active = TRUE,
                required_membership_tier = ${tier}, publication_reviewed_at = NOW(),
                publication_review_note = ${reviewNote}, updated_at = NOW()
            WHERE id = ${before.id} AND owner_user_id IS NOT NULL AND approval_status = 'pending'
            RETURNING *
          `
        : await tx`
            UPDATE prompt_templates
            SET visibility = 'private', approval_status = 'rejected',
                publication_reviewed_at = NOW(), publication_review_note = ${reviewNote}, updated_at = NOW()
            WHERE id = ${before.id} AND owner_user_id IS NOT NULL AND approval_status = 'pending'
            RETURNING *
          `;
      if (!after) fail("Template review state changed", 409, "TEMPLATE_REVIEW_CONFLICT");
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "prompt_template",
        targetId: id,
        reason: reviewNote,
        before,
        after,
        tx,
      });
      return normalizeTemplateRow(after);
    },
  });
};

export const deactivateTemplateAsAdministrator = async ({
  actor,
  templateId,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertTemplatePermission(actor);
  const id = normalizeTemplateId(templateId);
  const cleanReason = String(reason || "").trim().slice(0, 2000);
  if (!cleanReason) fail("reason is required", 400, "REASON_REQUIRED");
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action: "template.deleted",
    targetType: "prompt_template",
    targetId: id,
    requestPayload: { reason: cleanReason },
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM prompt_templates WHERE id = ${id} FOR UPDATE`;
      if (!before) fail("Template not found", 404, "TEMPLATE_NOT_FOUND");
      if (before.owner_user_id && isAdministratorEditableTemplate(before)) {
        const [after] = await tx`UPDATE prompt_templates SET visibility = 'public', is_active = FALSE, approval_status = 'rejected', publication_review_note = ${cleanReason}, updated_at = NOW() WHERE id = ${before.id} RETURNING *`;
        await writeAuditLog({ req, actorUserId: actor.userId, actorRole: actor.role, action: "template.deactivated", targetType: "prompt_template", targetId: id, reason: cleanReason, before, after, tx });
        return after;
      }
      if (before.owner_user_id) {
        return deleteContentAsAdministrator({
          actorUserId: actor.userId,
          actorRole: actor.role,
          ownerUserId: before.owner_user_id,
          resourceType: "private_template",
          resourceId: before.id,
          reason: cleanReason,
          req,
          tx,
        });
      }
      const [after] = await tx`
        UPDATE prompt_templates
        SET is_active = FALSE, updated_at = NOW()
        WHERE id = ${before.id} AND owner_user_id IS NULL
        RETURNING id, scene_key, is_active
      `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "template.deactivated",
        targetType: "prompt_template",
        targetId: before.id,
        reason: cleanReason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};
