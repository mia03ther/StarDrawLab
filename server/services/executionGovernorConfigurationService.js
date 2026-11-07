const TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);
const OPERATION_KEY = /^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;

const fail = (message, code = "INVALID_EXECUTION_POLICY", status = 400) => {
  throw Object.assign(new Error(message), { code, status });
};

const positiveInteger = (value, name, max, min = 1) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${name} must be a positive bounded integer`);
  return number;
};

const normalizeTarget = (membershipTier, operationKey) => {
  const tier = String(membershipTier || "").trim().toLowerCase();
  const key = String(operationKey || "").trim();
  if (!TIERS.has(tier)) fail("membershipTier is invalid");
  if (!OPERATION_KEY.test(key)) fail("operationKey is invalid");
  return { tier, key };
};

const mapPolicy = (row) => ({
  id: String(row.id),
  membershipTier: row.membership_tier,
  operationKey: row.operation_key,
  maxPerMinute: Number(row.max_per_minute),
  maxConcurrent: Number(row.max_concurrent),
  maxQueueDepth: Number(row.max_queue_depth),
  dailyQuota: Number(row.daily_quota),
  leaseDurationMs: Number(row.lease_duration_ms),
  enabled: Boolean(row.enabled),
  metadata: row.metadata || {},
  updatedAt: row.updated_at,
});

export const listExecutionPolicies = async ({ db }) => {
  if (!db) throw new TypeError("listExecutionPolicies requires a database adapter");
  const rows = await db`
    SELECT id, membership_tier, operation_key, max_per_minute, max_concurrent,
           max_queue_depth, daily_quota, lease_duration_ms, enabled, metadata, updated_at
    FROM execution_governor_policies
    ORDER BY CASE membership_tier
      WHEN 'free' THEN 0 WHEN 'basic' THEN 1 WHEN 'pro' THEN 2
      WHEN 'max' THEN 3 ELSE 4 END, operation_key ASC
  `;
  return rows.map(mapPolicy);
};

export const updateExecutionPolicy = async ({ tx, membershipTier, operationKey, changes = {} }) => {
  if (!tx) throw new TypeError("updateExecutionPolicy requires a transaction adapter");
  const target = normalizeTarget(membershipTier, operationKey);
  const [before] = await tx`
    SELECT id, membership_tier, operation_key, max_per_minute, max_concurrent,
           max_queue_depth, daily_quota, lease_duration_ms, enabled, metadata, updated_at
    FROM execution_governor_policies
    WHERE membership_tier = ${target.tier} AND operation_key = ${target.key}
    FOR UPDATE
  `;
  if (!before) fail("Execution policy was not found", "EXECUTION_POLICY_NOT_FOUND", 404);

  const maxPerMinute = changes.maxPerMinute ?? changes.max_per_minute ?? before.max_per_minute;
  const maxConcurrent = changes.maxConcurrent ?? changes.max_concurrent ?? before.max_concurrent;
  const maxQueueDepth = changes.maxQueueDepth ?? changes.max_queue_depth ?? before.max_queue_depth;
  const dailyQuota = changes.dailyQuota ?? changes.daily_quota ?? before.daily_quota;
  const leaseDurationMs = changes.leaseDurationMs ?? changes.lease_duration_ms ?? before.lease_duration_ms;
  const enabled = changes.enabled == null ? Boolean(before.enabled) : Boolean(changes.enabled);
  const [after] = await tx`
    UPDATE execution_governor_policies
    SET max_per_minute = ${positiveInteger(maxPerMinute, "maxPerMinute", 1_000_000)},
        max_concurrent = ${positiveInteger(maxConcurrent, "maxConcurrent", 10_000)},
        max_queue_depth = ${positiveInteger(maxQueueDepth, "maxQueueDepth", 100_000)},
        daily_quota = ${positiveInteger(dailyQuota, "dailyQuota", 1_000_000_000)},
        lease_duration_ms = ${positiveInteger(leaseDurationMs, "leaseDurationMs", 86_400_000, 10_000)},
        enabled = ${enabled}, updated_at = NOW()
    WHERE id = ${before.id}
    RETURNING id, membership_tier, operation_key, max_per_minute, max_concurrent,
              max_queue_depth, daily_quota, lease_duration_ms, enabled, metadata, updated_at
  `;
  return { before: mapPolicy(before), after: mapPolicy(after) };
};
