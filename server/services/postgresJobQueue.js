import { createHash, randomUUID } from "node:crypto";

import { JobQueuePort } from "../ports/jobQueuePort.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const MAX_JOB_ATTEMPTS = 1000;

export class JobQueueError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "JobQueueError";
    this.code = code;
    Object.assign(this, details);
  }
}

const fail = (message, code, details) => {
  throw new JobQueueError(message, code, details);
};

const isPlainObject = (value) => (
  value !== null
  && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const assertJsonValue = (value, path = "$", seen = new Set()) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} must contain finite JSON numbers`, "INVALID_JOB_JSON");
    return;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "bigint" || typeof value === "symbol") {
    fail(`${path} contains a non-JSON value`, "INVALID_JOB_JSON");
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    fail(`${path} must contain a storage reference, not media bytes`, "MEDIA_BYTES_NOT_ALLOWED");
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail(`${path} must contain a storage reference, not binary data`, "MEDIA_BYTES_NOT_ALLOWED");
  }
  if (value instanceof Date || !isPlainObject(value) && !Array.isArray(value)) {
    fail(`${path} must contain plain JSON data`, "INVALID_JOB_JSON");
  }
  if (seen.has(value)) fail(`${path} contains a circular reference`, "INVALID_JOB_JSON");
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
  } else {
    Object.entries(value).forEach(([key, item]) => assertJsonValue(item, `${path}.${key}`, seen));
  }
  seen.delete(value);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

export const hashJobRequest = ({ payload = {}, inputRefs = [], metadata = {} } = {}) => createHash("sha256")
  .update(JSON.stringify(canonicalize({ payload, inputRefs, metadata })))
  .digest("hex");

const serializeJson = (value, label, maxBytes = MAX_PAYLOAD_BYTES) => {
  assertJsonValue(value, label);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    fail(`${label} exceeds ${maxBytes} bytes`, "JOB_PAYLOAD_TOO_LARGE");
  }
  return serialized;
};

const databaseJsonValue = (serialized) => JSON.parse(serialized);

const stringValue = (value, label, { max = 255, required = true } = {}) => {
  const normalized = String(value ?? "").trim();
  if (required && !normalized) fail(`${label} is required`, "INVALID_JOB_ARGUMENT");
  if (normalized.length > max) fail(`${label} is too long`, "INVALID_JOB_ARGUMENT");
  return normalized || null;
};

const safeName = (value, label, max) => {
  const normalized = stringValue(value, label, { max });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    fail(`${label} contains unsupported characters`, "INVALID_JOB_ARGUMENT");
  }
  return normalized;
};

const idempotencyKey = (value) => {
  if (value == null || value === "") return null;
  const key = stringValue(value, "idempotencyKey", { max: 128 });
  if (key.length < 8 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    fail("idempotencyKey must be 8-128 safe ASCII characters", "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
};

const integer = (value, label, { min, max, defaultValue } = {}) => {
  const candidate = value == null ? defaultValue : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    fail(`${label} must be an integer between ${min} and ${max}`, "INVALID_JOB_ARGUMENT");
  }
  return candidate;
};

const leaseMs = (value) => integer(value, "leaseDurationMs", {
  min: MIN_LEASE_MS,
  max: MAX_LEASE_MS,
  defaultValue: 60_000,
});

const delayMs = (value) => integer(value, "delayMs", { min: 0, max: MAX_LEASE_MS, defaultValue: 0 });

const executionErrorCode = (value) => {
  const normalized = String(value || "JOB_EXECUTION_FAILED").trim().slice(0, 120);
  const looksSensitive = /authorization|bearer|credential|password|payload|secret|token|api[_-]?key|^(?:sk|pk)-/i.test(normalized);
  return !looksSensitive && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(normalized)
    ? normalized
    : "JOB_EXECUTION_FAILED";
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
  fail("A postgres-compatible SQL client is required", "JOB_QUEUE_DATABASE_UNAVAILABLE");
};

const inTransaction = async (sqlClient, operation) => {
  if (typeof sqlClient?.begin !== "function") {
    fail("The job queue requires a transactional SQL client", "JOB_QUEUE_DATABASE_UNAVAILABLE");
  }
  return sqlClient.begin(async (tx) => operation(tx));
};

const jsonValue = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const mapJob = (row) => {
  if (!row) return null;
  return {
    id: String(row.id),
    queueName: row.queue_name,
    jobType: row.job_type,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    payload: jsonValue(row.payload),
    inputRefs: jsonValue(row.input_refs),
    metadata: jsonValue(row.metadata),
    status: row.status,
    priority: Number(row.priority),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    result: jsonValue(row.result_snapshot),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    deadLetteredAt: row.dead_lettered_at ?? null,
    cancelledAt: row.cancelled_at,
  };
};

const requireRow = (result, message, code = "JOB_STATE_CONFLICT") => {
  const row = result[0];
  if (!row) fail(message, code);
  return mapJob(row);
};

const userScope = (userId) => (userId == null ? null : stringValue(userId, "userId"));

export class PostgresJobQueue extends JobQueuePort {
  constructor({ sqlClient, maxPayloadBytes = MAX_PAYLOAD_BYTES } = {}) {
    super();
    if (!sqlClient) fail("sqlClient is required", "JOB_QUEUE_DATABASE_UNAVAILABLE");
    this.sql = sqlClient;
    this.maxPayloadBytes = maxPayloadBytes;
  }

  async enqueue({
    queueName = "default",
    jobType,
    userId = null,
    idempotencyKey: rawKey = null,
    payload = {},
    inputRefs = [],
    metadata = {},
    priority = 0,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    availableAt = new Date(),
  } = {}) {
    const queue = safeName(queueName, "queueName", 80);
    const type = safeName(jobType, "jobType", 120);
    const owner = userScope(userId);
    const key = idempotencyKey(rawKey);
    const normalizedPriority = integer(priority, "priority", { min: -100000, max: 100000, defaultValue: 0 });
    const normalizedMaxAttempts = integer(maxAttempts, "maxAttempts", { min: 1, max: MAX_JOB_ATTEMPTS, defaultValue: 3 });
    const payloadJson = serializeJson(payload, "payload", this.maxPayloadBytes);
    const refsJson = serializeJson(inputRefs, "inputRefs", this.maxPayloadBytes);
    const metadataJson = serializeJson(metadata, "metadata", this.maxPayloadBytes);
    const payloadValue = databaseJsonValue(payloadJson);
    const inputRefsValue = databaseJsonValue(refsJson);
    const metadataValue = databaseJsonValue(metadataJson);
    const requestHash = hashJobRequest({ payload, inputRefs, metadata });
    const runAt = availableAt instanceof Date ? availableAt : new Date(availableAt);
    if (Number.isNaN(runAt.getTime())) fail("availableAt must be a valid date", "INVALID_JOB_ARGUMENT");

    const inserted = await rows(this.sql, `/* persistent-jobs:enqueue */
      INSERT INTO persistent_jobs
        (queue_name, job_type, user_id, idempotency_key, request_hash,
         payload, input_refs, metadata, priority, max_attempts, available_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
      ON CONFLICT DO NOTHING
      RETURNING *`, [queue, type, owner, key, requestHash, payloadValue, inputRefsValue, metadataValue,
      normalizedPriority, normalizedMaxAttempts, runAt]);
    if (inserted[0]) return mapJob(inserted[0]);
    if (!key) fail("Job could not be inserted", "JOB_QUEUE_CONFLICT");

    const existing = await rows(this.sql, `/* persistent-jobs:enqueue-existing */
      SELECT * FROM persistent_jobs
      WHERE queue_name = $1 AND user_id IS NOT DISTINCT FROM $2
        AND idempotency_key = $3`, [queue, owner, key]);
    if (!existing[0]) fail("Idempotent job was not found after conflict", "JOB_QUEUE_CONFLICT");
    if (existing[0].request_hash !== requestHash) {
      fail("idempotencyKey was already used with different job parameters", "JOB_IDEMPOTENCY_CONFLICT", {
        jobId: String(existing[0].id),
      });
    }
    return mapJob(existing[0]);
  }

  async lease({ queueName = "default", workerId = randomUUID(), limit = 1, leaseDurationMs = 60_000 } = {}) {
    const queue = safeName(queueName, "queueName", 80);
    const owner = stringValue(workerId, "workerId", { max: 180 });
    const take = integer(limit, "limit", { min: 1, max: 100, defaultValue: 1 });
    const duration = leaseMs(leaseDurationMs);
    return inTransaction(this.sql, async (tx) => {
      await rows(tx, `/* persistent-jobs:expire-exhausted */
        UPDATE persistent_jobs
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            last_heartbeat_at = NULL, error_code = 'LEASE_EXPIRED_MAX_ATTEMPTS',
            error_message = 'Job lease expired after the maximum number of attempts',
            failed_at = NOW(), dead_lettered_at = COALESCE(dead_lettered_at, NOW()), updated_at = NOW()
        WHERE queue_name = $1 AND status = 'running'
          AND lease_expires_at <= NOW() AND attempts >= max_attempts`, [queue]);
      const result = await rows(tx, `/* persistent-jobs:lease */
        WITH candidate AS (
          SELECT id
          FROM persistent_jobs
          WHERE queue_name = $1 AND attempts < max_attempts
            AND available_at <= NOW()
            AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= NOW()))
          ORDER BY priority DESC, available_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2
        )
        UPDATE persistent_jobs AS jobs
        SET status = 'running', attempts = jobs.attempts + 1,
            lease_owner = $3, lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'),
            last_heartbeat_at = NOW(), started_at = COALESCE(jobs.started_at, NOW()),
            updated_at = NOW(), error_code = NULL, error_message = NULL
        FROM candidate
        WHERE jobs.id = candidate.id
        RETURNING jobs.*`, [queue, take, owner, duration]);
      return result.map(mapJob);
    });
  }

  async heartbeat({ jobId, workerId, leaseDurationMs = 60_000 } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = stringValue(workerId, "workerId", { max: 180 });
    const duration = leaseMs(leaseDurationMs);
    const result = await rows(this.sql, `/* persistent-jobs:heartbeat */
      UPDATE persistent_jobs
      SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          last_heartbeat_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        AND lease_expires_at > NOW()
      RETURNING *`, [id, owner, duration]);
    return requireRow(result, "Job is not actively leased by this worker", "JOB_LEASE_LOST");
  }

  async complete({ jobId, workerId, result: output = null } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = stringValue(workerId, "workerId", { max: 180 });
    const outputJson = serializeJson(output, "result");
    const updated = await rows(this.sql, `/* persistent-jobs:complete */
      UPDATE persistent_jobs
      SET status = 'completed', result_snapshot = $3::jsonb,
          lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
          completed_at = NOW(), updated_at = NOW(), error_code = NULL, error_message = NULL
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        AND lease_expires_at > NOW()
      RETURNING *`, [id, owner, databaseJsonValue(outputJson)]);
    return requireRow(updated, "Job is not actively leased by this worker", "JOB_LEASE_LOST");
  }

  async fail({ jobId, workerId, error, retryDelayMs = 0 } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = stringValue(workerId, "workerId", { max: 180 });
    const delay = delayMs(retryDelayMs);
    const errorCode = executionErrorCode(error?.code);
    // Raw provider errors can contain credentials, request payloads, or signed
    // URLs. Persist the safe code and a generic message only.
    const errorMessage = "Job execution failed";
    const updated = await rows(this.sql, `/* persistent-jobs:fail */
      UPDATE persistent_jobs
      SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
          available_at = CASE WHEN attempts < max_attempts
            THEN NOW() + ($3 * INTERVAL '1 millisecond') ELSE available_at END,
          lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
          error_code = $4, error_message = $5,
          failed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE NOW() END,
          dead_lettered_at = CASE WHEN attempts < max_attempts THEN NULL
            ELSE COALESCE(dead_lettered_at, NOW()) END,
          updated_at = NOW()
      WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        AND lease_expires_at > NOW()
      RETURNING *`, [id, owner, delay, errorCode, errorMessage]);
    return requireRow(updated, "Job is not actively leased by this worker", "JOB_LEASE_LOST");
  }

  async cancel({ jobId, userId = null, reason = "Cancelled by user" } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = userScope(userId);
    const message = stringValue(reason, "reason", { max: 500 });
    const updated = await rows(this.sql, `/* persistent-jobs:cancel */
      UPDATE persistent_jobs
      SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_heartbeat_at = NULL, cancel_reason = $3, cancelled_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND ($2::varchar IS NULL OR user_id = $2)
        AND status IN ('queued', 'running')
      RETURNING *`, [id, owner, message]);
    if (updated[0]) return mapJob(updated[0]);
    const existing = await this.inspect({ jobId: id, userId: owner });
    if (!existing) fail("Job was not found", "JOB_NOT_FOUND");
    if (existing.status === "cancelled") return existing;
    fail("Job cannot be cancelled in its current state", "JOB_STATE_CONFLICT", { status: existing.status });
  }

  async retry({ jobId, userId = null, delayMs: rawDelay = 0 } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = userScope(userId);
    const delay = delayMs(rawDelay);
    const updated = await rows(this.sql, `/* persistent-jobs:retry */
      UPDATE persistent_jobs
      SET status = 'queued', available_at = NOW() + ($3 * INTERVAL '1 millisecond'),
          lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL,
          failed_at = NULL, dead_lettered_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = NOW()
      WHERE id = $1 AND ($2::varchar IS NULL OR user_id = $2)
        AND status = 'failed' AND attempts < max_attempts
      RETURNING *`, [id, owner, delay]);
    return requireRow(updated, "Job cannot be retried; it may be missing or exhausted", "JOB_RETRY_NOT_ALLOWED");
  }

  async inspect({ jobId, userId = null } = {}) {
    const id = stringValue(jobId, "jobId");
    const owner = userScope(userId);
    const result = await rows(this.sql, `/* persistent-jobs:inspect */
      SELECT * FROM persistent_jobs
      WHERE id = $1 AND ($2::varchar IS NULL OR user_id = $2)`, [id, owner]);
    return mapJob(result[0]);
  }
}

export const createPostgresJobQueue = (options) => new PostgresJobQueue(options);
