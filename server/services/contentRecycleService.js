import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { getObjectStorage } from "./objectStorageComposition.js";
import { writeAuditLog } from "./auditService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { executeUserOperation } from "./userOperationService.js";

const objectStorage = getObjectStorage();

const RECYCLE_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const ACTIVE_GENERATION_STATUSES = new Set(["pending", "queued", "processing", "running"]);

const RESOURCE_ALIASES = new Map([
  ["creation", "creation"],
  ["creations", "creation"],
  ["canvas", "canvas"],
  ["canvases", "canvas"],
  ["private_template", "private_template"],
  ["private-template", "private_template"],
  ["template", "private_template"],
  ["digital_human", "digital_human"],
  ["digital-human", "digital_human"],
  ["digital_human_role", "digital_human"],
  ["upload", "upload"],
  ["uploaded_asset", "upload"],
]);

const RESOURCE_ADAPTERS = Object.freeze({
  creation: { table: "creations", idColumn: "id", ownerColumn: "user_id" },
  canvas: { table: "canvases", idColumn: "id", ownerColumn: "user_id" },
  private_template: { table: "prompt_templates", idColumn: "id", ownerColumn: "owner_user_id" },
  digital_human: { table: "digital_human_roles", idColumn: "id", ownerColumn: "user_id" },
  upload: { table: "user_content_uploads", idColumn: "id", ownerColumn: "user_id" },
});

export class ContentRecycleError extends Error {
  constructor(message, { status = 400, code = "CONTENT_RECYCLE_ERROR", details } = {}) {
    super(message);
    this.name = "ContentRecycleError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const fail = (message, options) => {
  throw new ContentRecycleError(message, options);
};

const normalizeResourceType = (value) => {
  const normalized = RESOURCE_ALIASES.get(String(value || "").trim().toLowerCase());
  if (!normalized) {
    fail("Unsupported content resource type", {
      status: 400,
      code: "UNSUPPORTED_CONTENT_RESOURCE",
      details: { supported: [...new Set(RESOURCE_ALIASES.values())] },
    });
  }
  return normalized;
};

const normalizeId = (value, field = "resourceId") => {
  const id = String(value ?? "").trim();
  if (!id || id.length > 255) {
    fail(`${field} is invalid`, { status: 400, code: "INVALID_RESOURCE_ID" });
  }
  return id;
};

const normalizeRecordId = (value, field) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    fail(`${field} is invalid`, { status: 400, code: "INVALID_RECORD_ID" });
  }
  return BigInt(id).toString();
};

const normalizeRole = (value) => String(value || "").trim().toLowerCase();

export const canManageContentOwner = ({ actorRole, ownerRole }) => {
  const actor = normalizeRole(actorRole);
  const owner = normalizeRole(ownerRole);
  return actor === "root" || (actor === "admin" && owner === "user");
};

const requireRole = (role, allowed) => {
  const normalized = normalizeRole(role);
  if (!allowed.includes(normalized)) {
    fail("Insufficient content-management permission", { status: 403, code: "FORBIDDEN" });
  }
  return normalized;
};

const parseJson = (value, fallback = {}) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const uniqueStrings = (values) => [...new Set(values
  .filter((value) => typeof value === "string")
  .map((value) => value.trim())
  .filter(Boolean))];

const collectNamedObjectKeys = (value, parentKey = "", output = []) => {
  if (Array.isArray(value)) {
    if (/object_?keys?$/i.test(parentKey) || /objectkeys?$/i.test(parentKey)) {
      output.push(...value.filter((item) => typeof item === "string"));
    } else {
      value.forEach((item) => collectNamedObjectKeys(item, parentKey, output));
    }
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && (/object_?key$/i.test(key) || /objectkey$/i.test(key))) {
      output.push(child);
    } else {
      collectNamedObjectKeys(child, key, output);
    }
  }
  return output;
};

const objectKeysForResource = (resourceType, snapshot) => {
  if (resourceType === "canvas") return [];
  return uniqueStrings(collectNamedObjectKeys(snapshot));
};

const labelForResource = (resourceType, snapshot) => {
  const candidates = {
    creation: [snapshot.scene_name, snapshot.type, `Creation ${snapshot.id}`],
    canvas: [snapshot.title, `Canvas ${snapshot.id}`],
    private_template: [snapshot.scene_name, snapshot.preview_title, `Template ${snapshot.id}`],
    digital_human: [snapshot.role_name, `Digital human ${snapshot.id}`],
    upload: [snapshot.original_name, snapshot.media_type, `Upload ${snapshot.id}`],
  }[resourceType] || [];
  return String(candidates.find((value) => String(value || "").trim()) || resourceType).slice(0, 255);
};

const membershipTierForUser = async (executor, userId) => {
  const [row] = await executor`
    SELECT COALESCE(membership_tier, 'free') AS membership_tier
    FROM user_point_accounts
    WHERE user_id = ${userId}
  `;
  return String(row?.membership_tier || "free").toLowerCase();
};

export const resolveContentDeletionPolicy = ({ deletionOrigin, membershipTier }) => {
  const origin = String(deletionOrigin || "").toLowerCase();
  const tier = String(membershipTier || "free").toLowerCase();
  if (origin === "admin") {
    return { mode: "recycle_bin", visibility: "admin_only", retention_days: RECYCLE_DAYS };
  }
  if (origin === "user" && tier === "free") {
    return { mode: "hard_delete", visibility: null, retention_days: 0 };
  }
  if (origin === "user") {
    return { mode: "recycle_bin", visibility: "user", retention_days: RECYCLE_DAYS };
  }
  fail("Invalid deletion origin", { status: 400, code: "INVALID_DELETION_ORIGIN" });
};

const loadResourceForUpdate = async (tx, resourceType, resourceId, ownerUserId) => {
  const adapter = RESOURCE_ADAPTERS[resourceType];
  let query = `
    SELECT to_jsonb(resource_row) AS snapshot
    FROM ${adapter.table} AS resource_row
    WHERE resource_row.${adapter.ownerColumn} = $2
      AND resource_row.${adapter.idColumn}::text = $1`;

  if (resourceType === "private_template") {
    query += " AND resource_row.owner_user_id IS NOT NULL";
  }
  if (resourceType === "upload") {
    query = `
      SELECT to_jsonb(resource_row) AS snapshot
      FROM ${adapter.table} AS resource_row
      WHERE resource_row.${adapter.ownerColumn} = $2
        AND (resource_row.${adapter.idColumn}::text = $1 OR resource_row.object_key = $1)`;
  }
  query += " FOR UPDATE";

  const [row] = await tx.unsafe(query, [resourceId, ownerUserId]);
  if (!row?.snapshot) {
    fail("Content resource not found", { status: 404, code: "CONTENT_RESOURCE_NOT_FOUND" });
  }

  const snapshot = parseJson(row.snapshot);
  const canonicalId = normalizeId(snapshot[adapter.idColumn]);
  return { adapter, snapshot, canonicalId };
};

const validateResourceCanBeDeleted = async (tx, resourceType, snapshot, ownerUserId) => {
  if (resourceType === "creation") {
    const status = String(snapshot.status || "").toLowerCase();
    if (ACTIVE_GENERATION_STATUSES.has(status)) {
      fail("An active generation cannot be deleted", { status: 409, code: "GENERATION_STILL_ACTIVE" });
    }
    if (snapshot.charge_status === "reserved" && Number(snapshot.points_reserved || 0) > 0) {
      fail("Release reserved points before deleting this creation", {
        status: 409,
        code: "CREATION_HAS_RESERVED_POINTS",
      });
    }
  }

  if (resourceType === "digital_human") {
    const roleId = String(snapshot.id);
    const [activeUse] = await tx`
      SELECT id
      FROM creations
      WHERE user_id = ${ownerUserId}
        AND status IN ('pending', 'queued', 'processing', 'running')
        AND (
          meta_info->>'roleId' = ${roleId}
          OR meta_info->>'role_id' = ${roleId}
        )
      LIMIT 1
    `;
    if (activeUse) {
      fail("Digital-human role is used by an active generation", {
        status: 409,
        code: "DIGITAL_HUMAN_IN_ACTIVE_USE",
      });
    }
  }
};

const elementReferencesResource = (element, context) => {
  if (!element || typeof element !== "object") return false;
  const same = (left, right) => String(left ?? "") !== "" && String(left) === String(right);

  if (context.resourceType === "creation") {
    return same(element.creationId ?? element.creation_id, context.resourceId)
      || (element.objectKey && context.objectKeys.includes(String(element.objectKey)));
  }
  if (context.resourceType === "upload") {
    return same(element.uploadId ?? element.upload_id, context.resourceId)
      || same(element.objectKey, context.snapshot.object_key);
  }
  if (context.resourceType === "private_template") {
    return same(element.templateId ?? element.template_id, context.resourceId)
      || same(element.sceneKey ?? element.scene_key, context.snapshot.scene_key);
  }
  if (context.resourceType === "digital_human") {
    return same(element.roleId ?? element.role_id, context.resourceId);
  }
  return false;
};

const detachCanvasReferences = async (tx, context) => {
  if (context.resourceType === "canvas") return [];
  const rows = await tx`
    SELECT id, canvas_state, updated_at
    FROM canvases
    WHERE user_id = ${context.ownerUserId}
    ORDER BY id
    FOR UPDATE
  `;
  const snapshots = [];

  for (const row of rows) {
    const state = parseJson(row.canvas_state, {});
    const elements = Array.isArray(state.elements) ? state.elements : [];
    const removed = [];
    const kept = [];
    elements.forEach((element, index) => {
      if (elementReferencesResource(element, context)) removed.push({ index, element });
      else kept.push(element);
    });
    if (!removed.length) continue;

    snapshots.push({
      canvas_id: row.id,
      canvas_updated_at: row.updated_at,
      removed_elements: removed,
    });
    await tx`
      UPDATE canvases
      SET canvas_state = ${tx.json({ ...state, elements: kept })}, updated_at = NOW()
      WHERE id = ${row.id} AND user_id = ${context.ownerUserId}
    `;
  }
  return snapshots;
};

const retainedCreationReferences = async (tx, resourceType, snapshot, ownerUserId) => {
  if (resourceType === "private_template") {
    return tx`
      SELECT id, status FROM creations
      WHERE user_id = ${ownerUserId} AND scene_key = ${snapshot.scene_key}
      ORDER BY id
    `;
  }
  if (resourceType === "digital_human") {
    const roleId = String(snapshot.id);
    return tx`
      SELECT id, status FROM creations
      WHERE user_id = ${ownerUserId}
        AND (meta_info->>'roleId' = ${roleId} OR meta_info->>'role_id' = ${roleId})
      ORDER BY id
    `;
  }
  return [];
};

const deleteResourceRow = async (tx, adapter, canonicalId, ownerUserId) => {
  const result = await tx.unsafe(
    `DELETE FROM ${adapter.table} WHERE ${adapter.idColumn}::text = $1 AND ${adapter.ownerColumn} = $2`,
    [canonicalId, ownerUserId],
  );
  if (result.count !== 1) {
    fail("Content changed while it was being deleted", { status: 409, code: "CONTENT_DELETE_CONFLICT" });
  }
};

const restoreResourceRow = async (tx, resourceType, snapshot) => {
  const { table } = RESOURCE_ADAPTERS[resourceType];
  try {
    const availableColumns = await tx`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${table}
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position
    `;
    const snapshotColumns = availableColumns
      .map((row) => row.column_name)
      .filter((column) => Object.prototype.hasOwnProperty.call(snapshot, column));
    if (!snapshotColumns.length) {
      fail("The recycle snapshot is incompatible with the current schema", {
        status: 409,
        code: "CONTENT_SNAPSHOT_INCOMPATIBLE",
      });
    }
    const quotedColumns = snapshotColumns
      .map((column) => `"${String(column).replace(/"/g, '""')}"`)
      .join(", ");
    await tx.unsafe(
      `INSERT INTO ${table} (${quotedColumns}) SELECT ${quotedColumns} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(snapshot)],
    );
  } catch (error) {
    if (error?.code === "23505") {
      fail("The original identifier is now in use; restoration requires root review", {
        status: 409,
        code: "CONTENT_RESTORE_CONFLICT",
      });
    }
    throw error;
  }
};

const restoreCanvasReferences = async (tx, ownerUserId, referenceSnapshot) => {
  const canvasSnapshots = Array.isArray(referenceSnapshot?.canvases) ? referenceSnapshot.canvases : [];
  let restoredElements = 0;
  let skippedElements = 0;

  for (const canvasSnapshot of canvasSnapshots) {
    const [row] = await tx`
      SELECT id, canvas_state FROM canvases
      WHERE id = ${canvasSnapshot.canvas_id} AND user_id = ${ownerUserId}
      FOR UPDATE
    `;
    if (!row) {
      skippedElements += canvasSnapshot.removed_elements?.length || 0;
      continue;
    }
    const state = parseJson(row.canvas_state, {});
    const elements = Array.isArray(state.elements) ? [...state.elements] : [];
    const existingIds = new Set(elements.map((item) => String(item?.id || "")).filter(Boolean));
    const additions = [...(canvasSnapshot.removed_elements || [])].sort((a, b) => a.index - b.index);

    for (const addition of additions) {
      const elementId = String(addition?.element?.id || "");
      if (elementId && existingIds.has(elementId)) {
        skippedElements++;
        continue;
      }
      const index = Math.max(0, Math.min(Number(addition.index) || 0, elements.length));
      elements.splice(index, 0, addition.element);
      if (elementId) existingIds.add(elementId);
      restoredElements++;
    }
    await tx`
      UPDATE canvases
      SET canvas_state = ${tx.json({ ...state, elements })}, updated_at = NOW()
      WHERE id = ${row.id} AND user_id = ${ownerUserId}
    `;
  }
  return { restored_elements: restoredElements, skipped_elements: skippedElements };
};

const objectKeyStillReferenced = async (tx, objectKey, excludedRecycleEntryId = null) => {
  const [row] = await tx`
    SELECT (
      EXISTS (
        SELECT 1 FROM creations
        WHERE content_object_key = ${objectKey}
           OR thumbnail_object_key = ${objectKey}
           OR STRPOS(meta_info::text, ${objectKey}) > 0
      ) OR EXISTS (
        SELECT 1 FROM canvases WHERE STRPOS(canvas_state::text, ${objectKey}) > 0
      ) OR EXISTS (
        SELECT 1 FROM prompt_templates
        WHERE preview_object_key = ${objectKey} OR preview_video_object_key = ${objectKey}
      ) OR EXISTS (
        SELECT 1 FROM digital_human_roles
        WHERE avatar_object_key = ${objectKey} OR demo_video_object_key = ${objectKey}
      ) OR EXISTS (
        SELECT 1 FROM user_content_uploads WHERE object_key = ${objectKey}
      ) OR EXISTS (
        SELECT 1 FROM content_recycle_entries
        WHERE status = 'active'
          AND (${excludedRecycleEntryId}::bigint IS NULL OR id <> ${excludedRecycleEntryId})
          AND object_keys ? ${objectKey}
      )
    ) AS referenced
  `;
  return Boolean(row?.referenced);
};

const enqueueObjectCleanup = async (tx, {
  ownerUserId,
  sourceType,
  sourceId,
  objectKeys,
  excludedRecycleEntryId = null,
}) => {
  const safeKeys = [];
  for (const objectKey of uniqueStrings(objectKeys)) {
    if (!await objectKeyStillReferenced(tx, objectKey, excludedRecycleEntryId)) safeKeys.push(objectKey);
  }
  if (!safeKeys.length) return null;
  const [job] = await tx`
    INSERT INTO content_object_cleanup_jobs
      (owner_user_id, source_type, source_id, object_keys)
    VALUES (${ownerUserId}, ${sourceType}, ${sourceId}, ${tx.json(safeKeys)})
    RETURNING id, object_keys
  `;
  return job;
};

const runCleanupJob = async (job, { alreadyClaimed = false } = {}) => {
  if (!job?.id) return { cleanup_status: "not_required" };
  const keys = parseJson(job.object_keys, []);
  try {
    if (!alreadyClaimed) {
      await sql`
        UPDATE content_object_cleanup_jobs
        SET status = 'processing', attempts = attempts + 1, last_error = NULL,
            processing_started_at = NOW()
        WHERE id = ${job.id}
      `;
    }

    // References may have changed after the deletion transaction committed.
    // Re-check immediately before touching OSS and skip keys that are now live.
    const safeKeys = await sql.begin(async (tx) => {
      const rows = [];
      for (const objectKey of uniqueStrings(keys)) {
        if (!await objectKeyStillReferenced(tx, objectKey)) rows.push(objectKey);
      }
      return rows;
    });
    await objectStorage.deleteObjectsStrict(safeKeys);
    await sql`
      UPDATE content_object_cleanup_jobs
      SET status = 'completed', completed_at = NOW(), processing_started_at = NULL,
          last_error = ${safeKeys.length < keys.length ? "Some objects were retained because they are referenced" : null}
      WHERE id = ${job.id}
    `;
    return { cleanup_status: "completed", deleted_objects: safeKeys.length, retained_objects: keys.length - safeKeys.length };
  } catch (error) {
    await sql`
      UPDATE content_object_cleanup_jobs
      SET status = 'failed', last_error = ${String(error.message || error).slice(0, 2000)},
          next_attempt_at = NOW() + INTERVAL '15 minutes', processing_started_at = NULL
      WHERE id = ${job.id}
    `.catch(() => {});
    logger.error("contentRecycle.objectCleanup.failed", { jobId: job.id, error: error.message });
    return { cleanup_status: "pending_retry" };
  }
};

export const cleanupUnreferencedObjects = async ({ ownerUserId, sourceType, sourceId, objectKeys }) => {
  const cleanupJob = await sql.begin((tx) => enqueueObjectCleanup(tx, {
    ownerUserId: normalizeId(ownerUserId, "ownerUserId"),
    sourceType: String(sourceType || "orphaned_upload").slice(0, 32),
    sourceId: String(sourceId || "unknown").slice(0, 255),
    objectKeys,
  }));
  return runCleanupJob(cleanupJob);
};

const createRecycleEntry = async (tx, payload) => {
  const [entry] = await tx`
    INSERT INTO content_recycle_entries
      (owner_user_id, resource_type, resource_id, resource_label,
       deletion_origin, visibility, deleted_by_user_id, deleted_by_role,
       deletion_reason, membership_tier_at_deletion, resource_snapshot,
       reference_snapshot, object_keys, purge_after)
    VALUES
      (${payload.ownerUserId}, ${payload.resourceType}, ${payload.resourceId}, ${payload.resourceLabel},
       ${payload.deletionOrigin}, ${payload.visibility}, ${payload.actorUserId}, ${payload.actorRole},
       ${payload.reason || null}, ${payload.membershipTier}, ${tx.json(payload.snapshot)},
       ${tx.json(payload.referenceSnapshot)}, ${tx.json(payload.objectKeys)}, ${payload.purgeAfter})
    RETURNING id, owner_user_id, resource_type, resource_id, resource_label,
              deletion_origin, visibility, status, deleted_at, purge_after
  `;
  return entry;
};

const performDelete = async ({
  ownerUserId,
  actorUserId,
  actorRole,
  resourceType: rawResourceType,
  resourceId: rawResourceId,
  deletionOrigin,
  reason,
  req,
  tx: externalTx = null,
}) => {
  const resourceType = normalizeResourceType(rawResourceType);
  const requestedId = normalizeId(rawResourceId);
  const purgeAfter = new Date(Date.now() + RECYCLE_DAYS * MS_PER_DAY);

  const run = async (tx) => {
    if (deletionOrigin === "admin") {
      const [ownerProfile] = await tx`
        SELECT app_role FROM user_profiles
        WHERE user_id = ${ownerUserId}
        FOR UPDATE
      `;
      if (!ownerProfile) {
        fail("Content owner was not found", { status: 404, code: "CONTENT_OWNER_NOT_FOUND" });
      }
      if (!canManageContentOwner({ actorRole, ownerRole: ownerProfile.app_role })) {
        fail("Administrators cannot moderate another administrator's content", {
          status: 403,
          code: "ROOT_REQUIRED",
        });
      }
    }
    const membershipTier = await membershipTierForUser(tx, ownerUserId);
    const { adapter, snapshot, canonicalId } = await loadResourceForUpdate(
      tx,
      resourceType,
      requestedId,
      ownerUserId,
    );
    await validateResourceCanBeDeleted(tx, resourceType, snapshot, ownerUserId);
    const objectKeys = objectKeysForResource(resourceType, snapshot);
    const canvasReferences = await detachCanvasReferences(tx, {
      ownerUserId,
      resourceType,
      resourceId: canonicalId,
      snapshot,
      objectKeys,
    });
    const retainedCreations = await retainedCreationReferences(tx, resourceType, snapshot, ownerUserId);
    const referenceSnapshot = { canvases: canvasReferences, retained_creations: retainedCreations };

    await deleteResourceRow(tx, adapter, canonicalId, ownerUserId);

    const deletionPolicy = resolveContentDeletionPolicy({ deletionOrigin, membershipTier });
    if (deletionPolicy.mode === "hard_delete") {
      const cleanupJob = await enqueueObjectCleanup(tx, {
        ownerUserId,
        sourceType: resourceType,
        sourceId: canonicalId,
        objectKeys,
      });
      return {
        mode: "hard_delete",
        resource_type: resourceType,
        resource_id: canonicalId,
        cleanupJob,
      };
    }

    const entry = await createRecycleEntry(tx, {
      ownerUserId,
      actorUserId,
      actorRole,
      resourceType,
      resourceId: canonicalId,
      resourceLabel: labelForResource(resourceType, snapshot),
      deletionOrigin,
      visibility: deletionPolicy.visibility,
      reason,
      membershipTier,
      snapshot,
      referenceSnapshot,
      objectKeys,
      purgeAfter,
    });

    if (deletionOrigin === "admin") {
      await tx`
        INSERT INTO content_recycle_notifications
          (user_id, notification_type, title, message, metadata)
        VALUES
          (${ownerUserId}, 'content_removed', 'Content removed by an administrator',
           ${String(reason || "The content violated platform requirements.").slice(0, 2000)},
           ${tx.json({ resource_type: resourceType, resource_id: canonicalId })})
      `;
      await writeAuditLog({
        req,
        actorUserId,
        actorRole,
        action: "content.admin_deleted",
        targetType: resourceType,
        targetId: canonicalId,
        reason,
        before: {
          owner_user_id: ownerUserId,
          resource_type: resourceType,
          resource_id: canonicalId,
          resource_label: labelForResource(resourceType, snapshot),
        },
        after: {
          mode: "recycle_bin",
          recycle_entry_id: entry.id,
          visibility: entry.visibility,
          purge_after: entry.purge_after,
        },
        tx,
      });
    }
    return { mode: "recycle_bin", entry };
  };
  const result = externalTx ? await run(externalTx) : await sql.begin(run);

  if (result.cleanupJob && externalTx) {
    const { cleanupJob, ...publicResult } = result;
    return {
      ...publicResult,
      cleanup_job_id: cleanupJob.id,
      cleanup_status: "pending",
    };
  }
  if (result.cleanupJob && !externalTx) {
    const cleanup = await runCleanupJob(result.cleanupJob);
    delete result.cleanupJob;
    return { ...result, ...cleanup };
  }
  return result;
};

export const deleteOwnContent = async ({
  userId,
  resourceType,
  resourceId,
  reason = null,
  idempotencyKey,
  tx: externalTx = null,
}) => {
  const normalizedUserId = normalizeId(userId, "userId");
  const normalizedResourceType = normalizeResourceType(resourceType);
  const normalizedResourceId = normalizeId(resourceId, "resourceId");
  const normalizedReason = reason ? String(reason).slice(0, 2000) : null;
  const mutate = (tx) => performDelete({
    ownerUserId: normalizedUserId,
    actorUserId: normalizedUserId,
    actorRole: "user",
    resourceType: normalizedResourceType,
    resourceId: normalizedResourceId,
    deletionOrigin: "user",
    reason: normalizedReason,
    tx,
  });

  if (externalTx) return mutate(externalTx);
  return executeUserOperation({
    userId: normalizedUserId,
    idempotencyKey,
    action: "content.deleted",
    targetType: normalizedResourceType,
    targetId: normalizedResourceId,
    requestPayload: {
      resource_type: normalizedResourceType,
      resource_id: normalizedResourceId,
      reason: normalizedReason,
    },
    mutate,
  });
};

export const expireUserContent = async ({ userId, resourceType, resourceId }) => performDelete({
  ownerUserId: normalizeId(userId, "userId"),
  actorUserId: "system",
  actorRole: "system",
  resourceType,
  resourceId,
  deletionOrigin: "user",
  reason: "Content retention period expired",
});

export const deleteContentAsAdministrator = async ({
  actorUserId,
  actorRole,
  ownerUserId,
  resourceType,
  resourceId,
  reason,
  idempotencyKey,
  req,
  tx: externalTx = null,
}) => {
  const role = requireRole(actorRole, ["admin", "root"]);
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) {
    fail("Administrator deletion requires a reason", {
      status: 400,
      code: "DELETION_REASON_REQUIRED",
    });
  }
  const normalizedOwnerUserId = normalizeId(ownerUserId, "ownerUserId");
  const normalizedActorUserId = normalizeId(actorUserId, "actorUserId");
  const normalizedResourceType = normalizeResourceType(resourceType);
  const normalizedResourceId = normalizeId(resourceId, "resourceId");
  const mutate = (tx) => performDelete({
    ownerUserId: normalizedOwnerUserId,
    actorUserId: normalizedActorUserId,
    actorRole: role,
    resourceType: normalizedResourceType,
    resourceId: normalizedResourceId,
    deletionOrigin: "admin",
    reason: normalizedReason.slice(0, 2000),
    req,
    tx,
  });
  if (externalTx) return mutate(externalTx);
  return executeAdministratorOperation({
    actor: { userId: normalizedActorUserId, role },
    idempotencyKey,
    action: "content.admin_deleted",
    targetType: normalizedResourceType,
    targetId: normalizedResourceId,
    requestPayload: {
      owner_user_id: normalizedOwnerUserId,
      resource_type: normalizedResourceType,
      resource_id: normalizedResourceId,
      reason: normalizedReason,
    },
    mutate,
  });
};

const publicEntryFields = (row) => ({
  id: row.id,
  owner_user_id: row.owner_user_id,
  resource_type: row.resource_type,
  resource_id: row.resource_id,
  resource_label: row.resource_label,
  deletion_origin: row.deletion_origin,
  deletion_reason: row.deletion_reason,
  status: row.status,
  deleted_at: row.deleted_at,
  purge_after: row.purge_after,
  restore_requested: Boolean(row.restore_requested),
  restore_request_id: row.restore_request_id || null,
  restore_requested_by_user_id: row.restore_requested_by_user_id || null,
  restore_request_reason: row.restore_request_reason || null,
  restore_requested_at: row.restore_requested_at || null,
});

export const listOwnRecycleBin = async ({ userId, limit = 50, offset = 0 }) => {
  const rows = await sql`
    SELECT id, owner_user_id, resource_type, resource_id, resource_label,
           deletion_origin, NULL::text AS deletion_reason, status, deleted_at, purge_after,
           FALSE AS restore_requested, NULL::bigint AS restore_request_id,
           NULL::varchar AS restore_requested_by_user_id,
           NULL::text AS restore_request_reason, NULL::timestamptz AS restore_requested_at
    FROM content_recycle_entries
    WHERE owner_user_id = ${userId}
      AND visibility = 'user'
      AND deletion_origin = 'user'
      AND status = 'active'
      AND purge_after > NOW()
    ORDER BY deleted_at DESC
    LIMIT ${Math.min(100, Math.max(1, Number(limit) || 50))}
    OFFSET ${Math.max(0, Number(offset) || 0)}
  `;
  return rows.map(publicEntryFields);
};

export const listOwnContentNotifications = async ({ userId, limit = 50, offset = 0 }) => sql`
  SELECT id, notification_type, title, message, metadata, read_at, created_at
  FROM content_recycle_notifications
  WHERE user_id = ${userId}
  ORDER BY created_at DESC
  LIMIT ${Math.min(100, Math.max(1, Number(limit) || 50))}
  OFFSET ${Math.max(0, Number(offset) || 0)}
`;

export const markOwnContentNotificationRead = async ({ userId, notificationId, idempotencyKey }) => {
  const normalizedUserId = normalizeId(userId, "userId");
  const normalizedNotificationId = normalizeRecordId(notificationId, "notificationId");
  return executeUserOperation({
    userId: normalizedUserId,
    idempotencyKey,
    action: "content_notification.read",
    targetType: "content_notification",
    targetId: normalizedNotificationId,
    requestPayload: { notification_id: normalizedNotificationId },
    mutate: async (tx) => {
      const [notification] = await tx`
        UPDATE content_recycle_notifications
        SET read_at = COALESCE(read_at, NOW())
        WHERE id = ${normalizedNotificationId} AND user_id = ${normalizedUserId}
        RETURNING id, read_at
      `;
      if (!notification) {
        fail("Content notification not found", { status: 404, code: "NOTIFICATION_NOT_FOUND" });
      }
      return notification;
    },
  });
};

export const listAdministrativeRecycleBin = async ({ actorRole, limit = 50, offset = 0 }) => {
  const role = requireRole(actorRole, ["admin", "root"]);
  const rows = await sql`
    SELECT e.id, e.owner_user_id, e.resource_type, e.resource_id, e.resource_label,
           e.deletion_origin, e.deletion_reason, e.status, e.deleted_at, e.purge_after,
           (pending.id IS NOT NULL) AS restore_requested,
           pending.id AS restore_request_id,
           pending.requested_by_user_id AS restore_requested_by_user_id,
           pending.request_reason AS restore_request_reason,
           pending.created_at AS restore_requested_at
    FROM content_recycle_entries e
    LEFT JOIN LATERAL (
      SELECT id, requested_by_user_id, request_reason, created_at
      FROM content_restore_requests
      WHERE recycle_entry_id = e.id AND status = 'pending'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) pending ON TRUE
    JOIN user_profiles owner_profile ON owner_profile.user_id = e.owner_user_id
    WHERE e.visibility = 'admin_only' AND e.status = 'active'
      AND (${role} = 'root' OR owner_profile.app_role = 'user')
    ORDER BY e.deleted_at DESC
    LIMIT ${Math.min(100, Math.max(1, Number(limit) || 50))}
    OFFSET ${Math.max(0, Number(offset) || 0)}
  `;
  return rows.map(publicEntryFields);
};

const restoreEntryInTransaction = async (tx, entry, restoredByUserId) => {
  if (new Date(entry.purge_after).getTime() <= Date.now()) {
    fail("The recycle-bin retention period has expired", {
      status: 410,
      code: "RECYCLE_ENTRY_EXPIRED",
    });
  }
  const snapshot = parseJson(entry.resource_snapshot);
  const referenceSnapshot = parseJson(entry.reference_snapshot, {});
  await restoreResourceRow(tx, entry.resource_type, snapshot);
  const referenceResult = await restoreCanvasReferences(tx, entry.owner_user_id, referenceSnapshot);
  const [restored] = await tx`
    UPDATE content_recycle_entries
    SET status = 'restored', restored_at = NOW(), restored_by_user_id = ${restoredByUserId},
        resource_snapshot = '{}'::jsonb, reference_snapshot = '{}'::jsonb,
        object_keys = '[]'::jsonb, updated_at = NOW()
    WHERE id = ${entry.id} AND status = 'active'
    RETURNING id, owner_user_id, resource_type, resource_id, resource_label,
              deletion_origin, status, restored_at
  `;
  if (!restored) fail("Recycle entry changed during restore", { status: 409, code: "RESTORE_CONFLICT" });
  return { ...restored, references: referenceResult };
};

export const restoreOwnContent = async ({ userId, entryId, idempotencyKey }) => {
  const normalizedUserId = normalizeId(userId, "userId");
  const normalizedEntryId = normalizeRecordId(entryId, "entryId");
  return executeUserOperation({
    userId: normalizedUserId,
    idempotencyKey,
    action: "content.restored",
    targetType: "content_recycle_entry",
    targetId: normalizedEntryId,
    requestPayload: { entry_id: normalizedEntryId },
    mutate: async (tx) => {
      const [entry] = await tx`
        SELECT * FROM content_recycle_entries
        WHERE id = ${normalizedEntryId}
          AND owner_user_id = ${normalizedUserId}
          AND deletion_origin = 'user'
          AND visibility = 'user'
          AND status = 'active'
        FOR UPDATE
      `;
      if (!entry) fail("Restorable content was not found", { status: 404, code: "RECYCLE_ENTRY_NOT_FOUND" });
      return restoreEntryInTransaction(tx, entry, normalizedUserId);
    },
  });
};

export const requestAdministrativeRestore = async ({
  actorUserId,
  actorRole,
  entryId,
  reason,
  idempotencyKey,
  req,
}) => {
  requireRole(actorRole, ["admin"]);
  const requestReason = String(reason || "").trim();
  const operationKey = String(idempotencyKey || "").trim();
  if (!requestReason) fail("Restore request reason is required", { status: 400, code: "RESTORE_REASON_REQUIRED" });
  if (!/^[\x21-\x7e]{1,128}$/.test(operationKey)) {
    fail("A valid idempotency key is required", { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  const normalizedEntryId = normalizeRecordId(entryId, "entryId");
  return sql.begin(async (tx) => {
    // Serialize first use of the same requester/key pair. This closes the
    // window where two concurrent requests both observe no existing row.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([actorUserId, operationKey])}, 0))`;
    const [existing] = await tx`
      SELECT * FROM content_restore_requests
      WHERE requested_by_user_id = ${actorUserId}
        AND idempotency_key = ${operationKey}
      FOR UPDATE
    `;
    if (existing) {
      if (String(existing.recycle_entry_id) !== normalizedEntryId
          || existing.request_reason !== requestReason.slice(0, 2000)) {
        fail("The idempotency key was already used for another restore request", {
          status: 409,
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }
      return existing;
    }
    const [entry] = await tx`
      SELECT entries.id, entries.purge_after, owner_profile.app_role AS owner_role
      FROM content_recycle_entries entries
      JOIN user_profiles owner_profile ON owner_profile.user_id = entries.owner_user_id
      WHERE entries.id = ${normalizedEntryId}
        AND entries.deletion_origin = 'admin'
        AND entries.visibility = 'admin_only'
        AND entries.status = 'active'
      FOR UPDATE
    `;
    if (!entry) fail("Administrative recycle entry not found", { status: 404, code: "RECYCLE_ENTRY_NOT_FOUND" });
    if (!canManageContentOwner({ actorRole, ownerRole: entry.owner_role })) {
      fail("Administrators cannot manage another administrator's content", {
        status: 403,
        code: "ROOT_REQUIRED",
      });
    }
    if (new Date(entry.purge_after).getTime() <= Date.now()) {
      fail("The restore-request period has expired", { status: 410, code: "RECYCLE_ENTRY_EXPIRED" });
    }
    const [request] = await tx`
      INSERT INTO content_restore_requests
        (recycle_entry_id, requested_by_user_id, request_reason, idempotency_key)
      VALUES (${entry.id}, ${actorUserId}, ${requestReason.slice(0, 2000)}, ${operationKey})
      ON CONFLICT (recycle_entry_id) WHERE status = 'pending' DO NOTHING
      RETURNING *
    `;
    if (!request) fail("A restore request is already pending", { status: 409, code: "RESTORE_ALREADY_REQUESTED" });
    await writeAuditLog({
      req,
      actorUserId,
      actorRole: "admin",
      action: "content.restore_requested",
      targetType: "content_restore_request",
      targetId: request.id,
      reason: requestReason,
      after: {
        recycle_entry_id: entry.id,
        status: request.status,
      },
      tx,
    });
    return request;
  });
};

export const approveAdministrativeRestore = async ({
  rootUserId,
  actorRole,
  requestId,
  note = null,
  idempotencyKey,
  req,
}) => {
  requireRole(actorRole, ["root"]);
  const normalizedRequestId = normalizeRecordId(requestId, "requestId");
  return executeAdministratorOperation({
    actor: { userId: normalizeId(rootUserId, "rootUserId"), role: "root" },
    idempotencyKey,
    action: "content.restore_approved",
    targetType: "content_restore_request",
    targetId: normalizedRequestId,
    requestPayload: { request_id: normalizedRequestId, note: note ? String(note).slice(0, 2000) : null },
    mutate: async (tx) => {
    const [request] = await tx`
      SELECT * FROM content_restore_requests
      WHERE id = ${normalizedRequestId} AND status = 'pending'
      FOR UPDATE
    `;
    if (!request) fail("Pending restore request not found", { status: 404, code: "RESTORE_REQUEST_NOT_FOUND" });
    const [entry] = await tx`
      SELECT * FROM content_recycle_entries
      WHERE id = ${request.recycle_entry_id}
        AND deletion_origin = 'admin' AND visibility = 'admin_only' AND status = 'active'
      FOR UPDATE
    `;
    if (!entry) fail("Administrative recycle entry not found", { status: 404, code: "RECYCLE_ENTRY_NOT_FOUND" });
    const restored = await restoreEntryInTransaction(tx, entry, rootUserId);
    await tx`
      UPDATE content_restore_requests
      SET status = 'approved', reviewed_by_user_id = ${rootUserId},
          review_note = ${note ? String(note).slice(0, 2000) : null}, reviewed_at = NOW()
      WHERE id = ${request.id}
    `;
    await tx`
      INSERT INTO content_recycle_notifications
        (user_id, notification_type, title, message, metadata)
      VALUES
        (${entry.owner_user_id}, 'content_restored', 'Content restored by an administrator',
         'Your previously moderated content has been restored.',
         ${tx.json({ resource_type: entry.resource_type, resource_id: entry.resource_id })})
    `;
    await writeAuditLog({
      req,
      actorUserId: rootUserId,
      actorRole: "root",
      action: "content.restore_approved",
      targetType: "content_restore_request",
      targetId: request.id,
      reason: note,
      before: { status: request.status, recycle_entry_id: request.recycle_entry_id },
      after: { status: "approved", restored_resource_id: restored.resource_id },
      tx,
    });
    return restored;
    },
  });
};

export const rejectAdministrativeRestore = async ({
  rootUserId,
  actorRole,
  requestId,
  note,
  idempotencyKey,
  req,
}) => {
  requireRole(actorRole, ["root"]);
  const reviewNote = String(note || "").trim();
  if (!reviewNote) fail("A rejection note is required", { status: 400, code: "REVIEW_NOTE_REQUIRED" });
  const normalizedRequestId = normalizeRecordId(requestId, "requestId");
  return executeAdministratorOperation({
    actor: { userId: normalizeId(rootUserId, "rootUserId"), role: "root" },
    idempotencyKey,
    action: "content.restore_rejected",
    targetType: "content_restore_request",
    targetId: normalizedRequestId,
    requestPayload: { request_id: normalizedRequestId, note: reviewNote },
    mutate: async (tx) => {
    const [before] = await tx`
      SELECT * FROM content_restore_requests
      WHERE id = ${normalizedRequestId} AND status = 'pending'
      FOR UPDATE
    `;
    if (!before) fail("Pending restore request not found", { status: 404, code: "RESTORE_REQUEST_NOT_FOUND" });
    const [request] = await tx`
      UPDATE content_restore_requests
      SET status = 'rejected', reviewed_by_user_id = ${rootUserId},
          review_note = ${reviewNote.slice(0, 2000)}, reviewed_at = NOW()
      WHERE id = ${before.id} AND status = 'pending'
      RETURNING *
    `;
    await writeAuditLog({
      req,
      actorUserId: rootUserId,
      actorRole: "root",
      action: "content.restore_rejected",
      targetType: "content_restore_request",
      targetId: request.id,
      reason: reviewNote,
      before: { status: before.status, recycle_entry_id: before.recycle_entry_id },
      after: { status: request.status },
      tx,
    });
    return request;
    },
  });
};

const purgeRecycleEntry = async ({
  entryId,
  actorUserId,
  actorRole = "system",
  allowedOrigin,
  req,
  tx: externalTx = null,
}) => {
  const run = async (tx) => {
    const [entry] = await tx`
      SELECT * FROM content_recycle_entries
      WHERE id = ${entryId} AND deletion_origin = ${allowedOrigin} AND status = 'active'
      FOR UPDATE
    `;
    if (!entry) fail("Recycle entry not found", { status: 404, code: "RECYCLE_ENTRY_NOT_FOUND" });
    if (new Date(entry.purge_after).getTime() > Date.now()) {
      fail("Content must remain in the recycle bin for 14 days", {
        status: 409,
        code: "RETENTION_PERIOD_ACTIVE",
      });
    }
    const objectKeys = parseJson(entry.object_keys, []);
    const cleanupJob = await enqueueObjectCleanup(tx, {
      ownerUserId: entry.owner_user_id,
      sourceType: entry.resource_type,
      sourceId: entry.resource_id,
      objectKeys,
      excludedRecycleEntryId: entry.id,
    });
    await tx`
      UPDATE content_recycle_entries
      SET status = 'purged', purged_at = NOW(), purged_by_user_id = ${actorUserId},
          resource_snapshot = '{}'::jsonb, reference_snapshot = '{}'::jsonb,
          object_keys = '[]'::jsonb, updated_at = NOW()
      WHERE id = ${entry.id}
    `;
    await tx`
      UPDATE content_restore_requests
      SET status = 'cancelled', reviewed_by_user_id = ${actorUserId},
          review_note = 'Content was permanently deleted after retention expiry.', reviewed_at = NOW()
      WHERE recycle_entry_id = ${entry.id} AND status = 'pending'
    `;
    if (allowedOrigin === "admin") {
      await writeAuditLog({
        req,
        actorUserId,
        actorRole,
        action: "content.permanently_deleted",
        targetType: entry.resource_type,
        targetId: entry.resource_id,
        reason: "Permanent deletion after the mandatory retention period",
        before: {
          recycle_entry_id: entry.id,
          owner_user_id: entry.owner_user_id,
          status: entry.status,
          purge_after: entry.purge_after,
        },
        after: { status: "purged" },
        tx,
      });
    }
    return { entry_id: entry.id, cleanupJob };
  };
  const result = externalTx ? await run(externalTx) : await sql.begin(run);
  if (externalTx) return result;
  const cleanup = await runCleanupJob(result.cleanupJob);
  return { entry_id: result.entry_id, status: "purged", ...cleanup };
};

export const permanentlyDeleteAdministrativeContent = async ({
  rootUserId,
  actorRole,
  entryId,
  idempotencyKey,
  req,
}) => {
  requireRole(actorRole, ["root"]);
  const normalizedEntryId = normalizeRecordId(entryId, "entryId");
  const normalizedRootUserId = normalizeId(rootUserId, "rootUserId");
  const result = await executeAdministratorOperation({
    actor: { userId: normalizedRootUserId, role: "root" },
    idempotencyKey,
    action: "content.permanently_deleted",
    targetType: "content_recycle_entry",
    targetId: normalizedEntryId,
    requestPayload: { entry_id: normalizedEntryId, confirmation: "PERMANENT_DELETE" },
    mutate: async (tx) => {
      const purgeResult = await purgeRecycleEntry({
        entryId: normalizedEntryId,
        actorUserId: normalizedRootUserId,
        actorRole: "root",
        allowedOrigin: "admin",
        req,
        tx,
      });
      return {
        entry_id: purgeResult.entry_id,
        status: "purged",
        cleanup_job_id: purgeResult.cleanupJob?.id || null,
        cleanup_status: purgeResult.cleanupJob ? "pending" : "not_required",
      };
    },
  });
  return result;
};

// Intended for a later cron integration. It only purges expired member-owned
// entries; administrator-deleted entries always wait for an explicit root action.
export const purgeExpiredMemberContent = async ({ limit = 1000, batchSize = 100 } = {}) => {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 1000));
  const safeBatchSize = Math.min(100, Math.max(1, Number(batchSize) || 100));
  let purged = 0;
  let failed = 0;
  let scanned = 0;
  let cursorId = "0";
  while (scanned < safeLimit) {
    const rows = await sql`
      SELECT id FROM content_recycle_entries
      WHERE deletion_origin = 'user' AND visibility = 'user'
        AND status = 'active' AND purge_after <= NOW() AND id > ${cursorId}
      ORDER BY id ASC
      LIMIT ${Math.min(safeBatchSize, safeLimit - scanned)}
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      cursorId = String(row.id);
      scanned++;
      try {
        await purgeRecycleEntry({ entryId: row.id, actorUserId: "system", allowedOrigin: "user" });
        purged++;
      } catch (error) {
        failed++;
        logger.error("contentRecycle.expiredPurge.failed", { entryId: row.id, error: error.message });
      }
    }
  }
  return { scanned, purged, failed };
};

export const retryContentObjectCleanupJobs = async ({ limit = 50 } = {}) => {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const jobs = await sql.begin(async (tx) => tx`
    WITH candidates AS (
      SELECT id
      FROM content_object_cleanup_jobs
      WHERE (
          status IN ('pending', 'failed') AND next_attempt_at <= NOW()
        ) OR (
          status = 'processing' AND processing_started_at < NOW() - INTERVAL '20 minutes'
        )
      ORDER BY next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE content_object_cleanup_jobs jobs
    SET status = 'processing', attempts = jobs.attempts + 1,
        processing_started_at = NOW(), last_error = NULL
    FROM candidates
    WHERE jobs.id = candidates.id
    RETURNING jobs.id, jobs.object_keys
  `);

  let completed = 0;
  let pendingRetry = 0;
  for (const job of jobs) {
    const result = await runCleanupJob(job, { alreadyClaimed: true });
    if (result.cleanup_status === "completed") completed++;
    else pendingRetry++;
  }
  return { claimed: jobs.length, completed, pending_retry: pendingRetry };
};

export const SUPPORTED_CONTENT_RESOURCE_TYPES = Object.freeze(Object.keys(RESOURCE_ADAPTERS));
