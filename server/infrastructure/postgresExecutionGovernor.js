import { ExecutionGovernorPort } from "../ports/executionGovernorPort.js";

const MAX_METADATA_BYTES = 64 * 1024;
const VALID_TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);
// Daily quotas only protect direct generation API endpoints. Canvas and Agent
// workflows already reserve points for each real media task; applying a second
// daily counter there makes normal iterative creation fail before a provider
// request is even made. Minute, queue and concurrency controls still apply to
// every operation.
const DAILY_QUOTA_OPERATION_KEYS = new Set([
  "generation.image",
  "generation.video",
]);

const fail = (message, { status = 429, code = "EXECUTION_ADMISSION_DENIED", ...extra } = {}) => Object.assign(
  new Error(message),
  { status, code, ...extra },
);

const safeJson = (value) => {
  const normalized = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw fail("Execution admission metadata is too large", { status: 400, code: "EXECUTION_METADATA_TOO_LARGE" });
  }
  return serialized;
};

const mapLease = (row) => row ? ({
  leaseId: String(row.id),
  userId: row.user_id,
  membershipTier: row.membership_tier,
  operationKey: row.operation_key,
  queueName: row.queue_name,
  state: row.state,
  idempotencyKey: row.idempotency_key,
  admittedAt: row.created_at,
  expiresAt: row.expires_at,
  completedAt: row.completed_at,
}) : null;

const normalizeTier = (value) => {
  const tier = String(value || "free").trim().toLowerCase();
  return VALID_TIERS.has(tier) ? tier : "free";
};

const mapPolicy = (row) => row ? ({
  membershipTier: row.membership_tier,
  operationKey: row.operation_key,
  maxPerMinute: Number(row.max_per_minute),
  maxConcurrent: Number(row.max_concurrent),
  maxQueueDepth: Number(row.max_queue_depth),
  dailyQuota: Number(row.daily_quota),
  leaseDurationMs: Number(row.lease_duration_ms),
}) : null;

/** PostgreSQL adapter for the ExecutionGovernorPort. */
export class PostgresExecutionGovernor extends ExecutionGovernorPort {
  #sql;
  #clock;

  constructor({ sqlClient, clock = () => new Date() } = {}) {
    super();
    if (!sqlClient || typeof sqlClient.begin !== "function") {
      throw new TypeError("PostgresExecutionGovernor requires a transactional SQL client");
    }
    this.#sql = sqlClient;
    this.#clock = clock;
  }

  async #resolveTier(tx, userId, requestedTier) {
    const [account] = await tx`
      SELECT membership_tier
      FROM user_point_accounts
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    return normalizeTier(account?.membership_tier || requestedTier);
  }

  async #resolvePolicy(tx, membershipTier, operationKey) {
    const [row] = await tx`
      SELECT membership_tier, operation_key, max_per_minute, max_concurrent,
             max_queue_depth, daily_quota, lease_duration_ms
      FROM execution_governor_policies
      WHERE membership_tier = ${membershipTier}
        AND operation_key IN (${operationKey}, '*')
        AND enabled = TRUE
      ORDER BY CASE WHEN operation_key = ${operationKey} THEN 0 ELSE 1 END, id ASC
      LIMIT 1
    `;
    return mapPolicy(row);
  }

  async admit(request) {
    return this.#sql.begin(async (tx) => {
      const membershipTier = await this.#resolveTier(tx, request.userId, request.membershipTier);
      const policy = await this.#resolvePolicy(tx, membershipTier, request.operationKey);
      if (!policy) throw fail("No execution policy is configured for this operation", {
        status: 503,
        code: "EXECUTION_POLICY_MISSING",
      });

      // Reclaim abandoned capacity before counting. The lease is only an
      // admission slot; the durable job/provider state remains authoritative
      // for whether work should be retried.
      await tx`
        UPDATE execution_governor_leases
        SET state = 'failed', error_message = 'EXECUTION_LEASE_EXPIRED',
            completed_at = NOW(), updated_at = NOW()
        WHERE state IN ('queued', 'running')
          AND expires_at IS NOT NULL AND expires_at <= NOW()
      `;

      // Serialize decisions for one user and capability. This keeps the
      // counters correct across API instances without a process-local lock.
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${request.userId}:${request.operationKey}`}, 0)
        )
      `;

      if (request.idempotencyKey) {
        const [existing] = await tx`
          SELECT *
          FROM execution_governor_leases
          WHERE user_id = ${request.userId}
            AND operation_key = ${request.operationKey}
            AND idempotency_key = ${request.idempotencyKey}
          FOR UPDATE
        `;
        if (existing) {
          if (["queued", "running"].includes(existing.state)) {
            throw fail("This execution is already in progress", {
              status: 409,
              code: "EXECUTION_IN_PROGRESS",
              leaseId: String(existing.id),
            });
          }
          return {
            admitted: true,
            replayed: true,
            leaseId: String(existing.id),
            lease: mapLease(existing),
            policy,
          };
        }
      }

      const dailyQuotaApplies = DAILY_QUOTA_OPERATION_KEYS.has(request.operationKey);
      const [counts] = await tx`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute')::int AS minute_count,
          COUNT(*) FILTER (
            WHERE created_at >= (date_trunc('day', NOW() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')
              AND state = 'completed'
          )::int AS daily_count,
          COUNT(*) FILTER (WHERE state = 'running' AND (expires_at IS NULL OR expires_at > NOW()))::int AS concurrent_count,
          COUNT(*) FILTER (WHERE state IN ('queued', 'running'))::int AS queue_count
        FROM execution_governor_leases
        WHERE user_id = ${request.userId}
          AND operation_key = ${request.operationKey}
          AND state NOT IN ('cancelled')
      `;
      const minuteCount = Number(counts?.minute_count || 0);
      const dailyCount = Number(counts?.daily_count || 0);
      const concurrentCount = Number(counts?.concurrent_count || 0);
      const queueCount = Number(counts?.queue_count || 0);

      if (dailyQuotaApplies && policy.dailyQuota > 0 && dailyCount >= policy.dailyQuota) {
        throw fail("Daily execution quota has been reached", {
          code: "DAILY_QUOTA_EXCEEDED",
          retryAfterSeconds: Math.max(1, Math.ceil((24 * 60 * 60 * 1000 - (Date.now() % (24 * 60 * 60 * 1000))) / 1000)),
          policy,
        });
      }
      if (policy.maxPerMinute > 0 && minuteCount >= policy.maxPerMinute) {
        throw fail("Execution rate limit has been reached", {
          code: "EXECUTION_RATE_LIMITED",
          retryAfterSeconds: 60,
          policy,
        });
      }
      if (request.state === "running" && policy.maxConcurrent > 0 && concurrentCount >= policy.maxConcurrent) {
        throw fail("Concurrent execution limit has been reached", {
          status: 409,
          code: "EXECUTION_CONCURRENCY_LIMITED",
          retryAfterSeconds: 5,
          policy,
        });
      }
      if (request.state === "queued" && policy.maxQueueDepth > 0 && queueCount >= policy.maxQueueDepth) {
        throw fail("Execution queue is full", {
          code: "EXECUTION_QUEUE_FULL",
          retryAfterSeconds: 5,
          policy,
        });
      }

      const leaseDurationMs = Math.max(10_000, policy.leaseDurationMs || request.leaseDurationMs);
      const [row] = await tx`
        INSERT INTO execution_governor_leases
          (user_id, membership_tier, operation_key, queue_name, idempotency_key,
           state, metadata, expires_at, started_at)
        VALUES
          (${request.userId}, ${membershipTier}, ${request.operationKey}, ${request.queueName},
           ${request.idempotencyKey}, ${request.state}, ${safeJson(request.metadata)}::jsonb,
           NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'),
           CASE WHEN ${request.state} = 'running' THEN NOW() ELSE NULL END)
        RETURNING *
      `;
      return {
        admitted: true,
        replayed: false,
        leaseId: String(row.id),
        lease: mapLease(row),
        policy,
      };
    });
  }

  async heartbeat({ leaseId, leaseDurationMs }) {
    const [row] = await this.#sql`
      UPDATE execution_governor_leases
      SET expires_at = NOW() + (${leaseDurationMs} * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE id = ${leaseId} AND state IN ('queued', 'running')
      RETURNING *
    `;
    if (!row) throw fail("Execution lease is no longer active", { status: 409, code: "EXECUTION_LEASE_EXPIRED" });
    return mapLease(row);
  }

  async complete({ leaseId, metadata = {} }) {
    const [row] = await this.#sql`
      UPDATE execution_governor_leases
      SET state = 'completed', expires_at = NULL, completed_at = NOW(),
          updated_at = NOW(), metadata = metadata || ${safeJson(metadata)}::jsonb
      WHERE id = ${leaseId} AND state IN ('queued', 'running')
      RETURNING *
    `;
    if (!row) throw fail("Execution lease is no longer active", { status: 409, code: "EXECUTION_LEASE_EXPIRED" });
    return mapLease(row);
  }

  async release({ leaseId, outcome = "failed", error = null, metadata = {} }) {
    const state = ["cancelled", "failed"].includes(outcome) ? outcome : "failed";
    const [row] = await this.#sql`
      UPDATE execution_governor_leases
      SET state = ${state}, expires_at = NULL, completed_at = NOW(),
          updated_at = NOW(), error_message = ${error}, metadata = metadata || ${safeJson(metadata)}::jsonb
      WHERE id = ${leaseId} AND state IN ('queued', 'running')
      RETURNING *
    `;
    if (!row) throw fail("Execution lease is no longer active", { status: 409, code: "EXECUTION_LEASE_EXPIRED" });
    return mapLease(row);
  }
}
