const TERMINAL_JOB_STATUSES = new Set(["completed", "failed"]);
const TERMINAL_WORKFLOW_STATUSES = new Set(["completed", "failed"]);
const WORKFLOW_JOB_PREFIX = "workflow.";
const DEFAULT_RETRY_AFTER_MS = 5 * 60 * 1_000;

const bounded = (value, max) => String(value ?? "").trim().slice(0, max);

const safeCode = (value, fallback = "JOB_EXECUTION_FAILED") => {
  const candidate = bounded(value, 120);
  const looksSensitive = /authorization|bearer|credential|password|payload|secret|token|api[_-]?key|^(?:sk|pk)-/i.test(candidate);
  return !looksSensitive && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(candidate) ? candidate : fallback;
};

const validEmail = (value) => {
  const candidate = bounded(value, 320).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
};

const integerText = (value) => String(Number.isSafeInteger(Number(value)) ? Number(value) : 0);

const rows = async (client, query, values = []) => {
  if (typeof client?.unsafe === "function") {
    const result = await client.unsafe(query, values);
    return Array.isArray(result) ? result : result?.rows || [];
  }
  if (typeof client?.query === "function") {
    const result = await client.query(query, values);
    return result?.rows || result || [];
  }
  throw new TypeError("A postgres-compatible SQL client is required");
};

const inTransaction = async (sqlClient, operation) => {
  if (typeof sqlClient?.begin !== "function") throw new TypeError("Settlement notifications require transactions");
  return sqlClient.begin((tx) => operation(tx));
};

const jsonValue = (value) => {
  if (typeof value !== "string") return value || {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const mapJob = (row) => row && ({
  id: String(row.id),
  queueName: bounded(row.queue_name, 80),
  jobType: bounded(row.job_type, 120),
  userId: bounded(row.user_id, 255) || null,
  payload: jsonValue(row.payload),
  status: row.status,
  attempts: Number(row.attempts || 0),
  maxAttempts: Number(row.max_attempts || 0),
  errorCode: safeCode(row.error_code),
});

const profileFor = async (client, userId) => {
  if (!userId) return null;
  const [profile] = await rows(client, `/* job-settlement:profile */
    SELECT email, display_name
    FROM user_profiles
    WHERE user_id = $1`, [userId]);
  return profile ? {
    email: validEmail(profile.email),
    displayName: bounded(profile.display_name, 80),
  } : null;
};

const workflowRunId = (job) => bounded(job.payload?.runId ?? job.payload?.run_id, 255);

/**
 * PostgreSQL adapter for durable notification claims. All identity, recipient,
 * status, and error metadata is reloaded from canonical database rows.
 */
export class PostgresJobSettlementStore {
  constructor({ sqlClient, retryAfterMs = DEFAULT_RETRY_AFTER_MS } = {}) {
    if (!sqlClient) throw new TypeError("sqlClient is required");
    if (!Number.isSafeInteger(Number(retryAfterMs)) || Number(retryAfterMs) < 1_000) {
      throw new TypeError("retryAfterMs must be at least 1000");
    }
    this.sql = sqlClient;
    this.retryAfterMs = Number(retryAfterMs);
  }

  async pendingJobIds({ queueName = "default", limit = 50 } = {}) {
    const safeQueueName = bounded(queueName, 80) || "default";
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const result = await rows(this.sql, `/* job-settlement:pending */
      WITH pending AS (
        SELECT jobs.id, jobs.updated_at
        FROM persistent_jobs jobs
        WHERE jobs.queue_name = $1 AND jobs.status IN ('completed', 'failed')
          AND (
            (jobs.status = 'failed' AND jobs.dead_letter_alerted_at IS NULL
              AND (jobs.dead_letter_alert_claimed_at IS NULL
                OR jobs.dead_letter_alert_claimed_at <= NOW() - ($3 * INTERVAL '1 millisecond')))
            OR
            (jobs.job_type NOT LIKE 'workflow.%'
              AND jobs.user_notification_sent_at IS NULL
              AND jobs.user_notification_skipped_at IS NULL
              AND (jobs.user_notification_claimed_at IS NULL
                OR jobs.user_notification_claimed_at <= NOW() - ($3 * INTERVAL '1 millisecond')))
          )
        UNION ALL
        SELECT MIN(jobs.id) AS id, MIN(jobs.updated_at) AS updated_at
        FROM workflow_runs runs
        JOIN persistent_jobs jobs
          ON jobs.queue_name = $1
          AND jobs.job_type LIKE 'workflow.%'
          AND jobs.user_id = runs.user_id
          AND COALESCE(jobs.payload->>'runId', jobs.payload->>'run_id') = runs.id::text
        WHERE runs.status IN ('completed', 'failed')
          AND runs.terminal_notification_sent_at IS NULL
          AND runs.terminal_notification_skipped_at IS NULL
          AND (runs.terminal_notification_claimed_at IS NULL
            OR runs.terminal_notification_claimed_at <= NOW() - ($3 * INTERVAL '1 millisecond'))
        GROUP BY runs.id
      )
      SELECT id FROM pending ORDER BY updated_at ASC, id ASC LIMIT $2`,
    [safeQueueName, safeLimit, this.retryAfterMs]);
    return result.map((row) => String(row.id));
  }

  async claim(jobId) {
    const id = bounded(jobId, 255);
    if (!id) return [];
    return inTransaction(this.sql, async (tx) => {
      const [canonicalRow] = await rows(tx, `/* job-settlement:load-job */
        SELECT id, queue_name, job_type, user_id, payload, status,
               attempts, max_attempts, error_code
        FROM persistent_jobs WHERE id = $1`, [id]);
      const job = mapJob(canonicalRow);
      if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return [];

      const deliveries = [];
      if (job.status === "failed") {
        const [claimedAlert] = await rows(tx, `/* job-settlement:claim-dead-letter */
          UPDATE persistent_jobs
          SET dead_letter_alert_claimed_at = NOW(), updated_at = updated_at
          WHERE id = $1 AND status = 'failed' AND dead_letter_alerted_at IS NULL
            AND (dead_letter_alert_claimed_at IS NULL
              OR dead_letter_alert_claimed_at <= NOW() - ($2 * INTERVAL '1 millisecond'))
          RETURNING id`, [job.id, this.retryAfterMs]);
        if (claimedAlert) {
          deliveries.push({
            key: `dead-letter:${job.id}`,
            target: "dead-letter",
            kind: "dead-letter",
            jobId: job.id,
            queueName: job.queueName,
            jobType: job.jobType,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            errorCode: job.errorCode,
          });
        }
      }

      if (job.jobType.startsWith(WORKFLOW_JOB_PREFIX)) {
        const runId = workflowRunId(job);
        if (!runId || !job.userId) return deliveries;
        if (job.status === "failed") {
          const nodeKey = bounded(job.payload?.nodeKey ?? job.payload?.node_key, 160);
          if (nodeKey) {
            await rows(tx, `/* job-settlement:fail-workflow-node */
              UPDATE workflow_nodes nodes
              SET status = 'failed', error_code = 'DURABLE_JOB_EXHAUSTED',
                  error_message = 'A durable workflow job exhausted its retry budget', updated_at = NOW()
              WHERE nodes.run_id::text = $1 AND nodes.node_key = $2
                AND nodes.status NOT IN ('completed', 'failed', 'cancelled', 'skipped')
                AND EXISTS (
                  SELECT 1 FROM workflow_runs owner_run
                  WHERE owner_run.id = nodes.run_id AND owner_run.user_id = $3
                )`, [runId, nodeKey, job.userId]);
          }
          await rows(tx, `/* job-settlement:fail-workflow-run */
            UPDATE workflow_runs
            SET status = 'failed', error_code = 'DURABLE_JOB_EXHAUSTED',
                error_message = 'A durable workflow job exhausted its retry budget',
                failed_at = COALESCE(failed_at, NOW()), updated_at = NOW()
            WHERE id::text = $1 AND user_id = $2
              AND status NOT IN ('completed', 'failed', 'cancelled')`, [runId, job.userId]);
        }
        const [run] = await rows(tx, `/* job-settlement:claim-workflow-user */
          UPDATE workflow_runs
          SET terminal_notification_claimed_at = NOW()
          WHERE id::text = $1 AND user_id = $2 AND status IN ('completed', 'failed')
            AND terminal_notification_sent_at IS NULL
            AND terminal_notification_skipped_at IS NULL
            AND (terminal_notification_claimed_at IS NULL
              OR terminal_notification_claimed_at <= NOW() - ($3 * INTERVAL '1 millisecond'))
          RETURNING id, user_id, status`, [runId, job.userId, this.retryAfterMs]);
        if (run && TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
          deliveries.push({
            key: `workflow:${run.id}`,
            target: "workflow-user",
            kind: "user",
            jobId: job.id,
            taskId: String(run.id),
            jobType: "workflow.run",
            outcome: run.status,
            profile: await profileFor(tx, run.user_id),
          });
        }
        return deliveries;
      }

      if (!job.userId) return deliveries;
      const [claimedUser] = await rows(tx, `/* job-settlement:claim-job-user */
        UPDATE persistent_jobs
        SET user_notification_claimed_at = NOW(), updated_at = updated_at
        WHERE id = $1 AND status IN ('completed', 'failed')
          AND user_notification_sent_at IS NULL AND user_notification_skipped_at IS NULL
          AND (user_notification_claimed_at IS NULL
            OR user_notification_claimed_at <= NOW() - ($2 * INTERVAL '1 millisecond'))
        RETURNING id`, [job.id, this.retryAfterMs]);
      if (claimedUser) {
        deliveries.push({
          key: `job:${job.id}`,
          target: "job-user",
          kind: "user",
          jobId: job.id,
          taskId: job.id,
          jobType: job.jobType,
          outcome: job.status,
          profile: await profileFor(tx, job.userId),
        });
      }
      return deliveries;
    });
  }

  async finish(delivery, result) {
    const status = ["sent", "skipped", "failed"].includes(result?.status) ? result.status : "failed";
    const reason = bounded(result?.reason || "delivery_failed", 120) || "delivery_failed";
    const target = delivery?.target;
    const id = target === "workflow-user" ? delivery.taskId : delivery.jobId;
    if (!id) return;
    const columns = {
      "dead-letter": {
        sent: "dead_letter_alerted_at = NOW(), dead_letter_alert_claimed_at = NULL, dead_letter_alert_last_error = NULL",
        skipped: "dead_letter_alert_claimed_at = NOW(), dead_letter_alert_last_error = $2",
        failed: "dead_letter_alert_claimed_at = NOW(), dead_letter_alert_last_error = $2",
      },
      "job-user": {
        sent: "user_notification_sent_at = NOW(), user_notification_claimed_at = NULL, user_notification_last_error = NULL",
        skipped: "user_notification_skipped_at = NOW(), user_notification_claimed_at = NULL, user_notification_last_error = $2",
        failed: "user_notification_claimed_at = NOW(), user_notification_last_error = $2",
      },
      "workflow-user": {
        sent: "terminal_notification_sent_at = NOW(), terminal_notification_claimed_at = NULL, terminal_notification_last_error = NULL",
        skipped: "terminal_notification_skipped_at = NOW(), terminal_notification_claimed_at = NULL, terminal_notification_last_error = $2",
        failed: "terminal_notification_claimed_at = NOW(), terminal_notification_last_error = $2",
      },
    };
    const assignment = columns[target]?.[status];
    if (!assignment) throw new TypeError("Unknown settlement notification target");
    const table = target === "workflow-user" ? "workflow_runs" : "persistent_jobs";
    const values = assignment.includes("$2") ? [String(id), reason] : [String(id)];
    await rows(this.sql, `/* job-settlement:finish-${target} */
      UPDATE ${table} SET ${assignment} WHERE id::text = $1`, values);
  }
}

const emptySummary = () => ({ claimed: 0, sent: 0, skipped: 0, failed: 0 });

/**
 * Injectable job-settlement notification seam. Mail delivery is supplied by
 * adapters; queue and worker callers never depend on SMTP.
 */
export const createJobSettlementNotifier = ({
  store,
  sendUserNotification,
  sendOperationalAlert,
  logger = console,
} = {}) => {
  if (!store || typeof store.claim !== "function" || typeof store.finish !== "function") {
    throw new TypeError("A job settlement store is required");
  }
  if (typeof sendUserNotification !== "function" || typeof sendOperationalAlert !== "function") {
    throw new TypeError("User and operational notification functions are required");
  }

  const deliver = async (delivery) => {
    try {
      let result;
      if (delivery.kind === "dead-letter") {
        result = await sendOperationalAlert({
          subject: "StarDraw worker dead letter",
          message: "A durable job reached a terminal failure and requires attention.",
          details: {
            jobId: bounded(delivery.jobId, 128),
            queueName: bounded(delivery.queueName, 80),
            jobType: bounded(delivery.jobType, 120),
            attempts: `${integerText(delivery.attempts)}/${integerText(delivery.maxAttempts)}`,
            errorCode: safeCode(delivery.errorCode),
          },
        });
      } else {
        const recipient = validEmail(delivery.profile?.email);
        if (!recipient) {
          await store.finish(delivery, { status: "skipped", reason: "missing_database_recipient" });
          return "skipped";
        }
        result = await sendUserNotification({
          to: recipient,
          displayName: bounded(delivery.profile?.displayName, 80),
          taskId: bounded(delivery.taskId, 128),
          jobType: bounded(delivery.jobType, 120),
          outcome: delivery.outcome === "completed" ? "completed" : "failed",
        });
      }
      if (result?.sent) {
        await store.finish(delivery, { status: "sent" });
        return "sent";
      }
      await store.finish(delivery, { status: "failed", reason: "delivery_unavailable" });
      return "failed";
    } catch {
      await store.finish(delivery, { status: "failed", reason: "delivery_failed" });
      logger.warn?.("job-settlement.notification-failed", {
        jobId: bounded(delivery.jobId, 128),
        kind: delivery.kind,
      });
      return "failed";
    }
  };

  const notify = async ({ jobId } = {}) => {
    const summary = emptySummary();
    const deliveries = await store.claim(bounded(jobId, 255));
    summary.claimed = deliveries.length;
    for (const delivery of deliveries) {
      const outcome = await deliver(delivery);
      summary[outcome] += 1;
    }
    return summary;
  };

  return {
    notify,
    async flush({ queueName = "default", limit = 50 } = {}) {
      if (typeof store.pendingJobIds !== "function") return emptySummary();
      const total = emptySummary();
      const jobIds = await store.pendingJobIds({ queueName, limit });
      for (const jobId of jobIds) {
        const summary = await notify({ jobId });
        for (const key of Object.keys(total)) total[key] += summary[key];
      }
      return total;
    },
  };
};

export const createPostgresJobSettlementNotifier = ({ sqlClient, retryAfterMs, ...dependencies } = {}) => (
  createJobSettlementNotifier({
    ...dependencies,
    store: new PostgresJobSettlementStore({ sqlClient, retryAfterMs }),
  })
);
