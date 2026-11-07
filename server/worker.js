import { randomUUID } from "node:crypto";

import { createPostgresJobQueue } from "./services/postgresJobQueue.js";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const loggableError = (error) => ({
  code: /authorization|bearer|credential|password|payload|secret|token|api[_-]?key|^(?:sk|pk)-/i.test(String(error?.code || ""))
    ? "WORKER_OPERATION_FAILED"
    : String(error?.code || "WORKER_OPERATION_FAILED").slice(0, 120),
  name: String(error?.name || "Error").slice(0, 80),
});

/**
 * Runs durable jobs using an injected application executor. The executor is
 * intentionally a port: registering Agent/workflow/MCP handlers belongs to a
 * composition root, not to the queue implementation.
 */
export const createJobWorker = ({
  queue,
  execute,
  queueName = "default",
  workerId = `worker-${randomUUID()}`,
  pollIntervalMs = 1_000,
  leaseDurationMs = 60_000,
  retryDelayMs = 1_000,
  settlementNotifier = null,
  settlementBatchLimit = 50,
  logger = console,
} = {}) => {
  if (!queue || typeof queue.lease !== "function") throw new TypeError("A JobQueuePort implementation is required");
  if (typeof execute !== "function") throw new TypeError("A job execute function is required");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50) throw new TypeError("pollIntervalMs must be >= 50");
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1_000) throw new TypeError("leaseDurationMs must be >= 1000");
  if (settlementNotifier && typeof settlementNotifier.notify !== "function") {
    throw new TypeError("settlementNotifier.notify must be a function");
  }
  if (!Number.isSafeInteger(settlementBatchLimit) || settlementBatchLimit < 1 || settlementBatchLimit > 200) {
    throw new TypeError("settlementBatchLimit must be between 1 and 200");
  }

  let stopped = true;
  let loopPromise = null;
  let activeRun = null;

  const flushSettlements = async () => {
    if (typeof settlementNotifier?.flush !== "function") return;
    try {
      await settlementNotifier.flush({ queueName, limit: settlementBatchLimit });
    } catch (error) {
      logger.error?.("job-worker.notification-flush-failed", loggableError(error));
    }
  };

  const notifySettlement = async (job) => {
    if (!settlementNotifier || !["completed", "failed"].includes(job?.status)) return;
    try {
      await settlementNotifier.notify({ jobId: job.id });
    } catch (error) {
      logger.error?.("job-worker.notification-failed", { jobId: job.id, ...loggableError(error) });
    }
  };

  const runOnce = async () => {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      await flushSettlements();
      const jobs = await queue.lease({ queueName, workerId, leaseDurationMs });
      const job = jobs[0];
      if (!job) {
        // lease() can terminalize exhausted leases. A second pass makes those
        // dead letters visible without waiting for another polling interval.
        await flushSettlements();
        return null;
      }

      let heartbeatTimer;
      const heartbeat = async () => {
        try {
          await queue.heartbeat({ jobId: job.id, workerId, leaseDurationMs });
        } catch (error) {
          logger.warn?.("job-worker.heartbeat-failed", { jobId: job.id, ...loggableError(error) });
        }
      };
      heartbeatTimer = setInterval(heartbeat, Math.max(1_000, Math.floor(leaseDurationMs / 3)));
      try {
        const result = await execute(job, { workerId, heartbeat });
        const completed = await queue.complete({ jobId: job.id, workerId, result });
        await notifySettlement(completed);
        return { job: completed, result, status: "completed" };
      } catch (error) {
        try {
          const requestedRetryDelay = Number(error?.retryAfterMs);
          const effectiveRetryDelay = Number.isFinite(requestedRetryDelay)
            ? Math.min(60_000, Math.max(0, Math.floor(requestedRetryDelay)))
            : retryDelayMs;
          const failed = await queue.fail({ jobId: job.id, workerId, error, retryDelayMs: effectiveRetryDelay });
          await notifySettlement(failed);
          return { job: failed, error, status: failed.status };
        } catch (settlementError) {
          logger.error?.("job-worker.settlement-failed", {
            jobId: job.id,
            ...loggableError(settlementError),
          });
          throw settlementError;
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    })();
    try {
      return await activeRun;
    } finally {
      activeRun = null;
    }
  };

  const runLoop = async () => {
    while (!stopped) {
      try {
        const processed = await runOnce();
        if (!processed) await sleep(pollIntervalMs);
      } catch (error) {
        logger.error?.("job-worker.loop-error", loggableError(error));
        await sleep(pollIntervalMs);
      }
    }
  };

  return {
    workerId,
    queueName,
    runOnce,
    start() {
      if (!stopped) return loopPromise;
      stopped = false;
      loopPromise = runLoop();
      return loopPromise;
    },
    async stop() {
      stopped = true;
      if (loopPromise) await loopPromise;
      loopPromise = null;
    },
    get isRunning() {
      return !stopped;
    },
  };
};

/** Composition-root helper. It imports the existing SQL module only when called. */
export const createProductionWorker = async ({ execute, settlementNotifier = null, ...options } = {}) => {
  const [{ default: sql }] = await Promise.all([import("./configs/db.js")]);
  let notifier = settlementNotifier;
  if (!notifier) {
    const [{ createPostgresJobSettlementNotifier }, emailService] = await Promise.all([
      import("./services/jobSettlementNotification.js"),
      import("./services/emailService.js"),
    ]);
    notifier = createPostgresJobSettlementNotifier({
      sqlClient: sql,
      retryAfterMs: Number(process.env.JOB_NOTIFICATION_RETRY_MS || 300_000),
      sendUserNotification: emailService.sendJobSettlementNotification,
      sendOperationalAlert: emailService.sendOperationalAlert,
      logger: options.logger || console,
    });
  }
  return createJobWorker({
    ...options,
    execute,
    queue: createPostgresJobQueue({ sqlClient: sql }),
    settlementNotifier: notifier,
  });
};
