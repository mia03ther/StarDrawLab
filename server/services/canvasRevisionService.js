import sql from "../configs/db.js";
import { normalizeCanvasState } from "../domain/canvas/canvasState.js";

const MAX_REVISIONS = 100;

const fail = (message, code = "CANVAS_REVISION_FAILED", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

const parseJson = (value) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
};

const dbJson = (db, value) => (
  typeof db?.json === "function" ? db.json(value) : JSON.stringify(value)
);

const clean = (value, max, fallback = "") => String(value || fallback).trim().slice(0, max);

const mapRevision = (row) => row ? ({
  id: String(row.id),
  userId: row.user_id,
  canvasId: row.canvas_id,
  version: Number(row.version),
  title: row.title,
  canvasState: parseJson(row.canvas_state) || {},
  workflows: parseJson(row.workflows_snapshot) || [],
  reason: row.reason,
  createdAt: row.created_at,
}) : null;

const runInTransaction = (db, operation) => (
  typeof db?.begin === "function" ? db.begin(operation) : operation(db)
);

const restoreWorkflowSnapshots = async ({ tx, userId, canvasId, snapshots }) => {
  const [activeRun] = await tx`
    SELECT id
    FROM workflow_runs
    WHERE user_id = ${userId} AND canvas_id = ${canvasId}
      AND (
        status IN ('queued', 'running')
        OR (status = 'paused' AND EXISTS (
          SELECT 1 FROM workflow_nodes node
          WHERE node.run_id = workflow_runs.id AND node.status = 'waiting_approval'
        ))
      )
    ORDER BY id DESC
    LIMIT 1
  `;
  if (activeRun) fail("Canvas cannot be restored while a workflow is active", "CANVAS_REVISION_WORKFLOW_ACTIVE", 409);

  const normalizedSnapshots = (Array.isArray(snapshots) ? snapshots : []).map((snapshot) => {
    const id = clean(snapshot?.id, 80);
    const definition = parseJson(snapshot?.definition);
    if (!/^cwf_[0-9a-f]{32}$/.test(id) || !definition || typeof definition !== "object" || Array.isArray(definition)) {
      fail("Canvas revision contains an invalid workflow snapshot", "CANVAS_REVISION_WORKFLOW_INVALID", 409);
    }
    return {
      id,
      name: clean(snapshot?.name, 160, "Untitled workflow") || "Untitled workflow",
      definition: JSON.parse(JSON.stringify(definition)),
    };
  });

  await tx`
    UPDATE canvas_workflows
    SET archived_at = NOW(), updated_at = NOW()
    WHERE user_id = ${userId} AND canvas_id = ${canvasId} AND archived_at IS NULL
  `;

  const restored = [];
  for (const snapshot of normalizedSnapshots) {
    const [existing] = await tx`
      SELECT id, current_version
      FROM canvas_workflows
      WHERE id = ${snapshot.id} AND user_id = ${userId} AND canvas_id = ${canvasId}
      FOR UPDATE
    `;
    if (existing) {
      const nextVersion = Number(existing.current_version || 0) + 1;
      await tx`
        INSERT INTO canvas_workflow_versions (workflow_id, version, definition, created_by_user_id)
        VALUES (${snapshot.id}, ${nextVersion}, ${dbJson(tx, snapshot.definition)}, ${userId})
      `;
      await tx`
        UPDATE canvas_workflows
        SET name = ${snapshot.name}, current_version = ${nextVersion}, archived_at = NULL, updated_at = NOW()
        WHERE id = ${snapshot.id} AND user_id = ${userId} AND canvas_id = ${canvasId}
      `;
      restored.push({ id: snapshot.id, name: snapshot.name, version: nextVersion, definition: snapshot.definition });
      continue;
    }
    await tx`
      INSERT INTO canvas_workflows (id, user_id, canvas_id, name, current_version)
      VALUES (${snapshot.id}, ${userId}, ${canvasId}, ${snapshot.name}, 1)
    `;
    await tx`
      INSERT INTO canvas_workflow_versions (workflow_id, version, definition, created_by_user_id)
      VALUES (${snapshot.id}, 1, ${dbJson(tx, snapshot.definition)}, ${userId})
    `;
    restored.push({ id: snapshot.id, name: snapshot.name, version: 1, definition: snapshot.definition });
  }
  return restored;
};

/**
 * Append one immutable canvas revision.
 *
 * Interface invariant: callers must already lock the owning canvas row in the
 * same transaction. That gives the monotonically increasing version a small,
 * explicit concurrency seam and keeps this module independent of the caller's
 * mutation (HTTP, Agent, workflow, or restore).
 */
export const appendCanvasRevision = async ({
  db = sql,
  userId,
  canvasId,
  title,
  canvasState,
  reason = "canvas.updated",
} = {}) => {
  const owner = clean(userId, 255);
  const canvas = clean(canvasId, 64);
  if (!owner || !canvas) fail("userId and canvasId are required", "CANVAS_REVISION_INPUT_REQUIRED");
  const state = normalizeCanvasState(canvasState || {});
  const workflows = await db`
    SELECT workflow.id, workflow.name, workflow.current_version AS version,
           version_row.definition
    FROM canvas_workflows workflow
    JOIN canvas_workflow_versions version_row
      ON version_row.workflow_id = workflow.id
     AND version_row.version = workflow.current_version
    WHERE workflow.user_id = ${owner}
      AND workflow.canvas_id = ${canvas}
      AND workflow.archived_at IS NULL
    ORDER BY workflow.id ASC
  `;
  const [next] = await db`
    SELECT COALESCE(MAX(version), 0) + 1 AS version
    FROM canvas_revisions
    WHERE canvas_id = ${canvas}
  `;
  const version = Math.max(1, Number(next?.version || 1));
  const [row] = await db`
    INSERT INTO canvas_revisions
      (user_id, canvas_id, version, title, canvas_state, workflows_snapshot, reason)
    VALUES
      (${owner}, ${canvas}, ${version}, ${clean(title, 120, "Untitled Canvas") || "Untitled Canvas"},
       ${dbJson(db, state)}, ${dbJson(db, workflows)}, ${clean(reason, 120, "canvas.updated") || "canvas.updated"})
    RETURNING id, user_id, canvas_id, version, title, canvas_state,
              workflows_snapshot, reason, created_at
  `;
  return mapRevision(row);
};

export const listCanvasRevisions = async ({ db = sql, userId, canvasId, limit = 50 } = {}) => {
  const owner = clean(userId, 255);
  const canvas = clean(canvasId, 64);
  if (!owner || !canvas) fail("userId and canvasId are required", "CANVAS_REVISION_INPUT_REQUIRED");
  const [owned] = await db`
    SELECT id FROM canvases WHERE id = ${canvas} AND user_id = ${owner} LIMIT 1
  `;
  if (!owned) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
  const safeLimit = Math.min(MAX_REVISIONS, Math.max(1, Number(limit) || 50));
  const rows = await db`
    SELECT id, user_id, canvas_id, version, title, canvas_state,
           workflows_snapshot, reason, created_at
    FROM canvas_revisions
    WHERE canvas_id = ${canvas} AND user_id = ${owner}
    ORDER BY version DESC, id DESC
    LIMIT ${safeLimit}
  `;
  return rows.map(mapRevision);
};

export const restoreCanvasRevision = async ({ db = sql, userId, canvasId, revisionId } = {}) => {
  const owner = clean(userId, 255);
  const canvas = clean(canvasId, 64);
  const id = Number(revisionId);
  if (!owner || !canvas || !Number.isSafeInteger(id) || id < 1) {
    fail("A valid canvas revision is required", "CANVAS_REVISION_INPUT_REQUIRED");
  }
  return runInTransaction(db, async (tx) => {
    const [current] = await tx`
      SELECT id, title, canvas_state
      FROM canvases
      WHERE id = ${canvas} AND user_id = ${owner}
      FOR UPDATE
    `;
    if (!current) fail("Canvas not found", "CANVAS_NOT_FOUND", 404);
    const [revision] = await tx`
      SELECT id, user_id, canvas_id, version, title, canvas_state,
             workflows_snapshot, reason, created_at
      FROM canvas_revisions
      WHERE id = ${id} AND canvas_id = ${canvas} AND user_id = ${owner}
      LIMIT 1
    `;
    if (!revision) fail("Canvas revision not found", "CANVAS_REVISION_NOT_FOUND", 404);
    const state = normalizeCanvasState(parseJson(revision.canvas_state) || {});
    const workflows = await restoreWorkflowSnapshots({
      tx,
      userId: owner,
      canvasId: canvas,
      snapshots: parseJson(revision.workflows_snapshot) || [],
    });
    const title = clean(revision.title, 120, "Untitled Canvas") || "Untitled Canvas";
    const [updated] = await tx`
      UPDATE canvases
      SET title = ${title}, canvas_state = ${dbJson(tx, state)}, updated_at = NOW()
      WHERE id = ${canvas} AND user_id = ${owner}
      RETURNING id, title, canvas_state, updated_at
    `;
    const newRevision = await appendCanvasRevision({
      db: tx,
      userId: owner,
      canvasId: canvas,
      title,
      canvasState: state,
      reason: `canvas.restored:${revision.version}`,
    });
    return {
      canvas: { id: updated.id, title: updated.title, state: parseJson(updated.canvas_state) || state, updatedAt: updated.updated_at },
      restoredRevision: mapRevision(revision),
      workflows,
      revision: newRevision,
    };
  });
};

export const mapCanvasRevision = mapRevision;
