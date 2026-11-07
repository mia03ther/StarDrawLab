import "dotenv/config";

import logger from "./configs/logger.js";
import { createProductionWorker } from "./worker.js";
import { createWorkerHeartbeat } from "./workerHealth.js";
import { createApplicationJobExecutorRegistry } from "./services/jobExecutorRegistry.js";
import { reconcileMeteredAgentOperations } from "./services/meteredAgentOperationService.js";
import {
  processPendingPaymentReconciliations,
  processPendingRefundReconciliations,
} from "./services/subscriptionService.js";
import {
  processPendingPointPackagePayments,
  processPendingPointPackageRefunds,
} from "./services/pointPackageService.js";
import { processPendingImageCreations } from "./services/imageStatusService.js";

if (process.env.JOB_WORKER_ENABLED !== "true") {
  logger.info("job-worker.disabled", { reason: "JOB_WORKER_ENABLED is not true" });
  process.exit(0);
}

const executorRegistry = createApplicationJobExecutorRegistry();
const worker = await createProductionWorker({
  queueName: process.env.JOB_QUEUE_NAME || "workflow",
  pollIntervalMs: Number(process.env.JOB_WORKER_POLL_MS || 1000),
  leaseDurationMs: Number(process.env.JOB_WORKER_LEASE_MS || 60000),
  retryDelayMs: Number(process.env.JOB_WORKER_RETRY_MS || 1000),
  settlementBatchLimit: Number(process.env.JOB_NOTIFICATION_BATCH_LIMIT || 50),
  execute: (job, context) => executorRegistry.execute(job, context),
  logger,
});
const canvasAgentWorker = await createProductionWorker({
  queueName: process.env.CANVAS_AGENT_JOB_QUEUE_NAME || "canvas_agent",
  pollIntervalMs: Number(process.env.CANVAS_AGENT_WORKER_POLL_MS || process.env.JOB_WORKER_POLL_MS || 1000),
  leaseDurationMs: Number(process.env.CANVAS_AGENT_WORKER_LEASE_MS || process.env.JOB_WORKER_LEASE_MS || 60000),
  retryDelayMs: Number(process.env.CANVAS_AGENT_WORKER_RETRY_MS || process.env.JOB_WORKER_RETRY_MS || 1000),
  settlementBatchLimit: Number(process.env.JOB_NOTIFICATION_BATCH_LIMIT || 50),
  execute: (job, context) => executorRegistry.execute(job, context),
  logger,
});

const workerHeartbeat = createWorkerHeartbeat({
  filePath: process.env.WORKER_HEALTH_FILE || "/app/tmp/worker-health.json",
  intervalMs: Number(process.env.WORKER_HEALTH_INTERVAL_MS || 15_000),
  logger,
  snapshot: () => ({
    status: worker.isRunning ? "running" : "stopping",
    workerId: worker.workerId,
    queueName: worker.queueName,
    canvasAgentQueueName: canvasAgentWorker.queueName,
    canvasAgentWorkerId: canvasAgentWorker.workerId,
    release: process.env.RELEASE_VERSION || "development",
  }),
});

let reconciliationTimer = null;
const reconciliationEnabled = process.env.METERED_SETTLEMENT_RECONCILIATION_ENABLED === "true";
if (reconciliationEnabled) {
  const intervalMs = Number(process.env.METERED_SETTLEMENT_RECONCILIATION_INTERVAL_MS || 60_000);
  const reconcile = async () => {
    try {
      const summary = await reconcileMeteredAgentOperations({
        limit: Number(process.env.METERED_SETTLEMENT_RECONCILIATION_LIMIT || 50),
        olderThanMs: Number(process.env.METERED_SETTLEMENT_RECONCILIATION_AGE_MS || 60_000),
        alertAfterAttempts: Number(process.env.METERED_SETTLEMENT_ALERT_AFTER_ATTEMPTS || 3),
      });
      if (summary.scanned > 0) logger.info("meteredAgent.reconciliation.completed", summary);
    } catch (error) {
      logger.error("meteredAgent.reconciliation.loop_failed", { error: error.message });
    }
  };
  reconciliationTimer = setInterval(() => void reconcile(), Math.max(10_000, intervalMs));
  void reconcile();
}

let refundReconciliationTimer = null;
const refundReconciliationEnabled = process.env.SUBSCRIPTION_REFUND_RECONCILIATION_ENABLED === "true";
if (refundReconciliationEnabled) {
  const intervalMs = Number(process.env.SUBSCRIPTION_REFUND_RECONCILIATION_INTERVAL_MS || 60_000);
  const reconcileRefunds = async () => {
    try {
      const summary = await processPendingRefundReconciliations({
        limit: Number(process.env.SUBSCRIPTION_REFUND_RECONCILIATION_LIMIT || 50),
      });
      if (summary.scanned > 0) logger.info("subscription.refund.reconciliation.completed", summary);
      const pointPackageSummary = await processPendingPointPackageRefunds({
        limit: Number(process.env.SUBSCRIPTION_REFUND_RECONCILIATION_LIMIT || 50),
      });
      if (pointPackageSummary.scanned > 0) logger.info("pointPackage.refund.reconciliation.completed", pointPackageSummary);
    } catch (error) {
      logger.error("subscription.refund.reconciliation.loop_failed", { error: error.message });
    }
  };
  refundReconciliationTimer = setInterval(() => void reconcileRefunds(), Math.max(10_000, intervalMs));
  void reconcileRefunds();
}

let paymentReconciliationTimer = null;
const paymentReconciliationEnabled = process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_ENABLED === "true";
if (paymentReconciliationEnabled) {
  const intervalMs = Number(process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_INTERVAL_MS || 60_000);
  const reconcilePayments = async () => {
    try {
      const summary = await processPendingPaymentReconciliations({
        limit: Number(process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_LIMIT || 50),
        minAgeMs: Number(process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_MIN_AGE_MS || 120_000),
        closeAfterMs: Number(process.env.SUBSCRIPTION_PAYMENT_CLOSE_AFTER_MS || 2_100_000),
      });
      if (summary.scanned > 0) logger.info("subscription.payment.reconciliation.completed", summary);
      const pointPackageSummary = await processPendingPointPackagePayments({
        limit: Number(process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_LIMIT || 50),
        minAgeMs: Number(process.env.SUBSCRIPTION_PAYMENT_RECONCILIATION_MIN_AGE_MS || 120_000),
        closeAfterMs: Number(process.env.SUBSCRIPTION_PAYMENT_CLOSE_AFTER_MS || 2_100_000),
      });
      if (pointPackageSummary.scanned > 0) logger.info("pointPackage.payment.reconciliation.completed", pointPackageSummary);
    } catch (error) {
      logger.error("subscription.payment.reconciliation.loop_failed", { error: error.message });
    }
  };
  paymentReconciliationTimer = setInterval(() => void reconcilePayments(), Math.max(10_000, intervalMs));
  void reconcilePayments();
}

let imageReconciliationTimer = null;
const imageReconciliationEnabled = process.env.IMAGE_STATUS_RECONCILIATION_ENABLED !== "false";
if (imageReconciliationEnabled) {
  const intervalMs = Number(process.env.IMAGE_STATUS_RECONCILIATION_INTERVAL_MS || 5_000);
  let imageReconciliationRunning = false;
  const reconcileImages = async () => {
    if (imageReconciliationRunning) return;
    imageReconciliationRunning = true;
    try {
      const summary = await processPendingImageCreations({
        limit: Number(process.env.IMAGE_STATUS_RECONCILIATION_LIMIT || 25),
      });
      if (summary.scanned > 0) logger.info("image.status.reconciliation.completed", summary);
    } catch (error) {
      logger.error("image.status.reconciliation.loop_failed", { error: error.message });
    } finally {
      imageReconciliationRunning = false;
    }
  };
  imageReconciliationTimer = setInterval(() => void reconcileImages(), Math.max(2_000, intervalMs));
  void reconcileImages();
}

const shutdown = async (signal) => {
  logger.info("job-worker.stopping", { signal, workerId: worker.workerId });
  await worker.stop();
  await canvasAgentWorker.stop();
  await workerHeartbeat.stop();
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  if (refundReconciliationTimer) clearInterval(refundReconciliationTimer);
  if (paymentReconciliationTimer) clearInterval(paymentReconciliationTimer);
  if (imageReconciliationTimer) clearInterval(imageReconciliationTimer);
  process.exit(0);
};

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
worker.start();
canvasAgentWorker.start();
await workerHeartbeat.start();
logger.info("job-worker.started", {
  workerId: worker.workerId,
  queueName: worker.queueName,
  canvasAgentQueueName: canvasAgentWorker.queueName,
  canvasAgentWorkerId: canvasAgentWorker.workerId,
  release: process.env.RELEASE_VERSION || "development",
});
