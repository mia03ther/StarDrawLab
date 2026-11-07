import sql from "../configs/db.js";
import { createPostgresJobQueue } from "../services/postgresJobQueue.js";
import { getWorkflowRuntime } from "../services/workflowRuntimeComposition.js";
import { getAgentPlanExecution } from "../services/agentPlanExecutionComposition.js";
import { createTaskCenterService } from "../services/taskCenterService.js";
import { createTaskSseService } from "../services/taskSseService.js";

let taskCenter;
let taskEventStream;

const getTaskCenter = () => {
  if (!taskCenter) {
    taskCenter = createTaskCenterService({
      sqlClient: sql,
      jobQueue: createPostgresJobQueue({ sqlClient: sql }),
      workflowRuntime: getWorkflowRuntime(),
      agentPlanExecution: getAgentPlanExecution(),
    });
  }
  return taskCenter;
};

const getTaskEventStream = () => {
  if (!taskEventStream) {
    taskEventStream = createTaskSseService({ taskCenter: getTaskCenter() });
  }
  return taskEventStream;
};

const sendError = (res, error, fallback) => res.status(error.status || 500).json({
  success: false,
  code: error.code || "TASK_CENTER_FAILED",
  message: error.status || process.env.NODE_ENV !== "production" ? error.message : fallback,
});

export const listTasks = async (req, res) => {
  try {
    const result = await getTaskCenter().listForUser({
      userId: req.auth.userId,
      page: req.query.page,
      pageSize: req.query.page_size || req.query.pageSize,
      status: req.query.status,
      type: req.query.type,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, "Unable to load tasks");
  }
};

export const cancelTask = async (req, res) => {
  try {
    const result = await getTaskCenter().cancelForUser({
      userId: req.auth.userId,
      taskId: req.params.taskId,
      reason: req.body?.reason,
      idempotencyKey: req.headers["x-idempotency-key"],
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, "Unable to cancel task");
  }
};

export const streamTasks = async (req, res) => {
  try {
    await getTaskEventStream().streamForUser({
      req,
      res,
      userId: req.auth.userId,
      page: req.query.page,
      pageSize: req.query.page_size || req.query.pageSize,
      status: req.query.status,
      type: req.query.type,
      lastEventId: req.headers["last-event-id"] || req.query.last_event_id,
    });
  } catch (error) {
    if (!res.headersSent) return sendError(res, error, "Unable to stream tasks");
    if (!res.writableEnded) res.end();
  }
  return undefined;
};

export const resetTaskCenterForTests = () => {
  taskCenter = null;
  taskEventStream = null;
};
