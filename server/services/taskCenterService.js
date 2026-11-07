import sql from "../configs/db.js";
import { executeUserOperation } from "./userOperationService.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;
const MAX_PAGE = 10_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CANCELABLE_SOURCES = new Set(["persistent_job", "workflow_run", "agent_plan_run"]);
const TASK_SOURCES = new Set(["persistent_job", "workflow_run", "agent_plan_run", "creation"]);

export class TaskCenterError extends Error {
  constructor(message, { status = 500, code = "TASK_CENTER_FAILED", ...details } = {}) {
    super(message);
    this.name = "TaskCenterError";
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (message, details) => {
  throw new TaskCenterError(message, details);
};

const rows = async (client, query, values) => {
  if (typeof client?.unsafe === "function") {
    const result = await client.unsafe(query, values);
    return Array.isArray(result) ? result : result?.rows || [];
  }
  if (typeof client?.query === "function") {
    const result = await client.query(query, values);
    return result?.rows || result || [];
  }
  fail("A postgres-compatible SQL client is required", {
    code: "TASK_CENTER_DATABASE_UNAVAILABLE",
  });
};

const normalizeUserId = (value) => {
  const userId = String(value ?? "").trim();
  if (!userId || userId.length > 255) {
    fail("A valid userId is required", { status: 400, code: "INVALID_TASK_CENTER_USER" });
  }
  return userId;
};

const normalizePage = (value) => {
  const page = value == null || value === "" ? 1 : Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) {
    fail(`page must be an integer between 1 and ${MAX_PAGE}`, {
      status: 400,
      code: "INVALID_TASK_CENTER_PAGINATION",
    });
  }
  return page;
};

const normalizePageSize = (value) => {
  const pageSize = value == null || value === "" ? DEFAULT_PAGE_SIZE : Number(value);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    fail(`pageSize must be an integer between 1 and ${MAX_PAGE_SIZE}`, {
      status: 400,
      code: "INVALID_TASK_CENTER_PAGINATION",
    });
  }
  return pageSize;
};

const optionalFilter = (value, label, allowed = null) => {
  if (value == null || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized || normalized.length > 80 || allowed && !allowed.has(normalized)) {
    fail(`Unsupported task center ${label}`, { status: 400, code: "INVALID_TASK_CENTER_FILTER" });
  }
  return normalized;
};

const normalizeProgress = (value, status) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.min(100, Math.max(0, Math.round(numeric)));
  if (status === "completed") return 100;
  if (["running", "paused", "waiting_approval", "waiting_client"].includes(status)) return 50;
  return 0;
};

const mapError = (row) => {
  const code = row.error_code == null ? null : String(row.error_code);
  const message = row.error_message == null ? null : String(row.error_message);
  return code || message ? { code, message } : null;
};

const mapTask = (row, userId) => {
  const source = String(row.source_type || "").trim();
  const sourceId = String(row.source_id ?? "").trim();
  const status = String(row.status || "unknown").trim().toLowerCase();
  const isOwned = String(row.user_id ?? "") === userId;
  if (!TASK_SOURCES.has(source) || !sourceId || !isOwned) return null;

  const supported = CANCELABLE_SOURCES.has(source) && !TERMINAL_STATUSES.has(status);
  return {
    id: `${source}:${sourceId}`,
    source,
    sourceId,
    status,
    progress: normalizeProgress(row.progress, status),
    type: String(row.type || source),
    title: String(row.title || "Untitled task").trim() || "Untitled task",
    timestamps: {
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? row.created_at ?? null,
      startedAt: row.started_at ?? null,
      completedAt: row.completed_at ?? null,
      failedAt: row.failed_at ?? null,
      cancelledAt: row.cancelled_at ?? null,
    },
    error: mapError(row),
    cancellation: {
      supported,
      reason: supported
        ? null
        : source === "creation"
          ? "No supported cancellation interface exists for generated creations"
          : "Task is already in a terminal state",
    },
  };
};

const TASK_CTE = `
  WITH unified_tasks AS (
    SELECT
      'persistent_job'::text AS source_type,
      jobs.id::text AS source_id,
      jobs.user_id,
      jobs.status,
      CASE jobs.status
        WHEN 'completed' THEN 100
        WHEN 'running' THEN 50
        ELSE 0
      END::int AS progress,
      jobs.job_type AS type,
      COALESCE(NULLIF(jobs.metadata->>'title', ''), jobs.job_type) AS title,
      jobs.created_at,
      jobs.updated_at,
      jobs.started_at,
      jobs.completed_at,
      jobs.failed_at,
      jobs.cancelled_at,
      jobs.error_code,
      jobs.error_message
    FROM persistent_jobs jobs
    WHERE jobs.user_id = $1

    UNION ALL

    SELECT
      'workflow_run'::text AS source_type,
      runs.id::text AS source_id,
      runs.user_id,
      runs.status,
      CASE runs.status
        WHEN 'completed' THEN 100
        WHEN 'running' THEN 50
        WHEN 'paused' THEN 50
        ELSE 0
      END::int AS progress,
      'workflow'::text AS type,
      runs.title,
      runs.created_at,
      runs.updated_at,
      runs.started_at,
      runs.completed_at,
      runs.failed_at,
      runs.cancelled_at,
      runs.error_code,
      runs.error_message
    FROM workflow_runs runs
    WHERE runs.user_id = $1

    UNION ALL

    SELECT
      'agent_plan_run'::text AS source_type,
      runs.id::text AS source_id,
      runs.user_id,
      runs.status,
      runs.progress,
      'agent_plan'::text AS type,
      runs.summary AS title,
      runs.created_at,
      runs.updated_at,
      runs.started_at,
      runs.completed_at,
      runs.failed_at,
      runs.cancelled_at,
      runs.error_code,
      runs.error_message
    FROM agent_plan_runs runs
    WHERE runs.user_id = $1

    UNION ALL

    SELECT
      'creation'::text AS source_type,
      creations.id::text AS source_id,
      creations.user_id,
      creations.status,
      CASE creations.status
        WHEN 'completed' THEN 100
        WHEN 'running' THEN 50
        WHEN 'processing' THEN 50
        ELSE 0
      END::int AS progress,
      creations.type,
      COALESCE(NULLIF(creations.scene_name, ''), NULLIF(creations.scene_key, ''), creations.type) AS title,
      creations.created_at,
      creations.created_at AS updated_at,
      NULL::timestamptz AS started_at,
      NULL::timestamptz AS completed_at,
      NULL::timestamptz AS failed_at,
      NULL::timestamptz AS cancelled_at,
      NULL::text AS error_code,
      creations.error_message
    FROM creations
    WHERE creations.user_id = $1
  )
`;

const LIST_QUERY = `${TASK_CTE}
  SELECT source_type, source_id, user_id, status, progress, type, title,
         created_at, updated_at, started_at, completed_at, failed_at, cancelled_at,
         error_code, error_message
  FROM unified_tasks
  WHERE ($2::text IS NULL OR status = $2)
    AND ($3::text IS NULL OR type = $3 OR source_type = $3)
  ORDER BY created_at DESC NULLS LAST, source_type ASC, source_id DESC
  LIMIT $4 OFFSET $5
  /* task-center:list */`;

const COUNT_QUERY = `${TASK_CTE}
  SELECT COUNT(*)::int AS total
  FROM unified_tasks
  WHERE ($2::text IS NULL OR status = $2)
    AND ($3::text IS NULL OR type = $3 OR source_type = $3)
  /* task-center:count */`;

const GET_QUERY = `${TASK_CTE}
  SELECT source_type, source_id, user_id, status, progress, type, title,
         created_at, updated_at, started_at, completed_at, failed_at, cancelled_at,
         error_code, error_message
  FROM unified_tasks
  WHERE source_type = $2 AND source_id = $3
  LIMIT 1
  /* task-center:get */`;

const parseTaskId = (taskId) => {
  const normalized = String(taskId ?? "").trim();
  const match = normalized.match(/^(persistent_job|workflow_run|agent_plan_run|creation):([A-Za-z0-9._:-]+)$/);
  if (!match) {
    fail("taskId must include a supported task source", {
      status: 400,
      code: "INVALID_TASK_CENTER_TASK_ID",
    });
  }
  return { taskId: normalized, source: match[1], sourceId: match[2] };
};

const mapCancellation = ({ taskId, source, sourceId, result }) => ({
  taskId,
  source,
  sourceId,
  status: String(result?.status || "cancelled"),
  cancelled: String(result?.status || "cancelled") === "cancelled",
});

export const createTaskCenterService = ({
  sqlClient = sql,
  jobQueue = null,
  workflowRuntime = null,
  agentPlanExecution = null,
  operationExecutor = executeUserOperation,
} = {}) => {
  const listForUser = async ({ userId: rawUserId, page: rawPage = 1, pageSize: rawPageSize = DEFAULT_PAGE_SIZE, status: rawStatus, type: rawType } = {}) => {
    const userId = normalizeUserId(rawUserId);
    const page = normalizePage(rawPage);
    const pageSize = normalizePageSize(rawPageSize);
    const status = optionalFilter(rawStatus, "status", new Set(["queued", "pending", "running", "processing", "paused", "waiting_approval", "waiting_client", "completed", "failed", "cancelled"]));
    const type = optionalFilter(rawType, "type");
    const offset = (page - 1) * pageSize;
    const [taskRows, countRows] = await Promise.all([
      rows(sqlClient, LIST_QUERY, [userId, status, type, pageSize, offset]),
      rows(sqlClient, COUNT_QUERY, [userId, status, type]),
    ]);
    const tasks = taskRows.map((row) => mapTask(row, userId)).filter(Boolean);
    const total = Math.max(0, Number(countRows[0]?.total || 0));
    return {
      tasks,
      page,
      pageSize,
      total,
      hasNextPage: offset + tasks.length < total,
    };
  };

  const cancelWithoutIdempotency = async ({ userId: rawUserId, taskId: rawTaskId, reason } = {}) => {
    const userId = normalizeUserId(rawUserId);
    const { taskId, source, sourceId } = parseTaskId(rawTaskId);
    if (source === "creation") {
      fail("Generated creations cannot be cancelled because no supported cancellation interface exists", {
        status: 409,
        code: "TASK_CANCELLATION_UNSUPPORTED",
        taskId,
        source,
      });
    }
    if (source === "persistent_job") {
      if (!jobQueue || typeof jobQueue.cancel !== "function") {
        fail("Persistent job cancellation is unavailable", { code: "TASK_CANCELLATION_UNAVAILABLE" });
      }
      const result = await jobQueue.cancel({ jobId: sourceId, userId, reason });
      return mapCancellation({ taskId, source, sourceId, result });
    }
    if (source === "agent_plan_run") {
      if (!agentPlanExecution || typeof agentPlanExecution.cancel !== "function") {
        fail("Agent plan cancellation is unavailable", { code: "TASK_CANCELLATION_UNAVAILABLE" });
      }
      const result = await agentPlanExecution.cancel({ userId, runId: sourceId, reason });
      return mapCancellation({ taskId, source, sourceId, result });
    }
    if (!workflowRuntime || typeof workflowRuntime.cancel !== "function") {
      fail("Workflow cancellation is unavailable", { code: "TASK_CANCELLATION_UNAVAILABLE" });
    }
    const result = await workflowRuntime.cancel({ userId, runId: sourceId, reason });
    return mapCancellation({ taskId, source, sourceId, result });
  };

  const getForUser = async ({ userId: rawUserId, taskId: rawTaskId } = {}) => {
    const userId = normalizeUserId(rawUserId);
    const { source, sourceId } = parseTaskId(rawTaskId);
    const result = await rows(sqlClient, GET_QUERY, [userId, source, sourceId]);
    const task = mapTask(result[0], userId);
    if (!task) fail("Task was not found", { status: 404, code: "TASK_NOT_FOUND" });
    return task;
  };

  const cancelForUser = async ({
    userId: rawUserId,
    taskId: rawTaskId,
    reason,
    idempotencyKey = null,
  } = {}) => {
    if (!idempotencyKey) return cancelWithoutIdempotency({ userId: rawUserId, taskId: rawTaskId, reason });

    const userId = normalizeUserId(rawUserId);
    const { source, sourceId } = parseTaskId(rawTaskId);
    return operationExecutor({
      userId,
      idempotencyKey,
      action: "task.cancelled",
      targetType: source,
      targetId: sourceId,
      requestPayload: { reason: reason == null ? null : String(reason) },
      mutate: () => cancelWithoutIdempotency({ userId, taskId: rawTaskId, reason }),
    });
  };

  return Object.freeze({ listForUser, getForUser, cancelForUser });
};

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
