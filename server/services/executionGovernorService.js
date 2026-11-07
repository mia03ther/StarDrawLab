import {
  ExecutionGovernorPort,
} from "../ports/executionGovernorPort.js";

const MEMBERSHIP_TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const fail = (message, { status = 429, code = "EXECUTION_ADMISSION_DENIED", ...extra } = {}) => Object.assign(
  new Error(message),
  { status, code, ...extra },
);

const text = (value, name, { max = 255, pattern = IDENTIFIER } = {}) => {
  const result = String(value || "").trim();
  if (!result || result.length > max || (pattern && !pattern.test(result))) {
    const codeName = name.replaceAll(" ", "_").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase();
    throw fail(`${name} is invalid`, { status: 400, code: `INVALID_${codeName}` });
  }
  return result;
};

const normalizeTier = (value) => {
  const tier = String(value || "free").trim().toLowerCase();
  if (!MEMBERSHIP_TIERS.has(tier)) throw fail("membershipTier is invalid", {
    status: 400,
    code: "INVALID_MEMBERSHIP_TIER",
  });
  return tier;
};

const normalizeDuration = (value) => {
  const duration = value == null ? 30 * 60 * 1000 : Number(value);
  if (!Number.isSafeInteger(duration) || duration < 10_000 || duration > 24 * 60 * 60 * 1000) {
    throw fail("leaseDurationMs is invalid", { status: 400, code: "INVALID_EXECUTION_LEASE" });
  }
  return duration;
};

/**
 * Deep application module for rate, concurrency, queue and daily admission.
 * Callers learn one small interface; the adapter owns atomic counters,
 * database locks, lease expiry and policy lookup.
 */
export class ExecutionGovernorService {
  #store;
  #clock;

  constructor({ store, clock = () => Date.now() } = {}) {
    if (!store || !(store instanceof ExecutionGovernorPort)
      && typeof store.admit !== "function"
      || typeof store.heartbeat !== "function"
      || typeof store.complete !== "function"
      || typeof store.release !== "function") {
      throw new TypeError("ExecutionGovernorService requires an ExecutionGovernorPort");
    }
    this.#store = store;
    this.#clock = clock;
  }

  async admit({
    userId,
    membershipTier = "free",
    operationKey,
    queueName = "default",
    idempotencyKey = null,
    queued = false,
    leaseDurationMs,
    metadata = {},
  } = {}) {
    const request = {
      userId: text(userId, "userId"),
      membershipTier: normalizeTier(membershipTier),
      operationKey: text(operationKey, "operationKey"),
      queueName: text(queueName, "queueName", { max: 80 }),
      idempotencyKey: idempotencyKey == null ? null : text(idempotencyKey, "idempotencyKey", { max: 128 }),
      state: queued ? "queued" : "running",
      leaseDurationMs: normalizeDuration(leaseDurationMs),
      metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
      now: new Date(this.#clock()),
    };
    if (Number.isNaN(request.now.getTime())) throw fail("Clock returned an invalid time", {
      status: 500,
      code: "EXECUTION_CLOCK_INVALID",
    });
    const result = await this.#store.admit(request);
    if (!result?.admitted) {
      throw fail(result?.message || "Execution limits do not allow this operation", {
        status: Number(result?.status) || 429,
        code: result?.code || "EXECUTION_ADMISSION_DENIED",
        retryAfterSeconds: result?.retryAfterSeconds,
        policy: result?.policy,
      });
    }
    return {
      ...result,
      admittedAt: result.admittedAt || request.now.toISOString(),
      replayed: Boolean(result.replayed),
    };
  }

  async heartbeat({ leaseId, leaseDurationMs } = {}) {
    return this.#store.heartbeat({ leaseId: text(leaseId, "leaseId"), leaseDurationMs: normalizeDuration(leaseDurationMs) });
  }

  async complete({ leaseId, metadata = {} } = {}) {
    return this.#store.complete({ leaseId: text(leaseId, "leaseId"), metadata });
  }

  async release({ leaseId, outcome = "failed", error = null, metadata = {} } = {}) {
    const normalizedOutcome = ["failed", "cancelled"].includes(String(outcome)) ? String(outcome) : "failed";
    return this.#store.release({
      leaseId: text(leaseId, "leaseId"),
      outcome: normalizedOutcome,
      error: error ? String(error.message || error).slice(0, 2000) : null,
      metadata,
    });
  }

  async run(admission, task) {
    if (typeof task !== "function") throw new TypeError("ExecutionGovernorService.run requires a task");
    const lease = await this.admit(admission);
    try {
      const result = await task({ lease });
      await this.complete({ leaseId: lease.leaseId });
      return { result, lease };
    } catch (error) {
      await this.release({ leaseId: lease.leaseId, outcome: "failed", error });
      throw error;
    }
  }
}
