import { createHash } from "node:crypto";

import sql from "../configs/db.js";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fail = (message, { status = 500, code = "USER_OPERATION_FAILED" } = {}) => {
  throw Object.assign(new Error(message), { status, code });
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
};

const boundedValue = (value, name, maxLength) => {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    fail(`${name} is invalid`, { status: 400, code: "INVALID_USER_OPERATION" });
  }
  return normalized;
};

export const normalizeUserIdempotencyKey = (value) => {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    fail("A valid X-Idempotency-Key header is required", {
      status: 400,
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  return key;
};

export const hashUserOperationRequest = (payload) => {
  let serialized;
  try {
    serialized = JSON.stringify(canonicalize(payload ?? null));
  } catch {
    fail("User operation payload is not serializable", {
      status: 400,
      code: "INVALID_USER_OPERATION",
    });
  }
  return createHash("sha256").update(serialized).digest("hex");
};

const prepareResponseSnapshot = (result) => {
  try {
    return JSON.parse(JSON.stringify(result ?? null));
  } catch {
    fail("User operation result is not serializable", {
      code: "USER_OPERATION_RESULT_INVALID",
    });
  }
};

const normalizeStoredResponseSnapshot = (snapshot) => {
  if (typeof snapshot !== "string") return snapshot;
  try {
    return JSON.parse(snapshot);
  } catch {
    return snapshot;
  }
};

export const executeUserOperation = async ({
  userId,
  idempotencyKey,
  action,
  targetType,
  targetId,
  requestPayload,
  mutate,
}) => {
  const normalizedUserId = boundedValue(userId, "user id", 255);
  const normalizedKey = normalizeUserIdempotencyKey(idempotencyKey);
  const normalizedAction = boundedValue(action, "action", 120);
  const normalizedTargetType = boundedValue(targetType, "target type", 80);
  const normalizedTargetId = boundedValue(targetId, "target id", 255);
  if (typeof mutate !== "function") fail("User operation mutation callback is required");
  const requestHash = hashUserOperationRequest(requestPayload);

  return sql.begin(async (tx) => {
    const [inserted] = await tx`
      INSERT INTO user_operations
        (user_id, idempotency_key, action, target_type, target_id, request_hash, status)
      VALUES
        (${normalizedUserId}, ${normalizedKey}, ${normalizedAction},
         ${normalizedTargetType}, ${normalizedTargetId}, ${requestHash}, 'claimed')
      ON CONFLICT (user_id, idempotency_key) DO NOTHING
      RETURNING id
    `;

    if (!inserted) {
      const [existing] = await tx`
        SELECT id, action, target_type, target_id, request_hash, status,
               response_snapshot
        FROM user_operations
        WHERE user_id = ${normalizedUserId}
          AND idempotency_key = ${normalizedKey}
        FOR UPDATE
      `;
      if (!existing) {
        fail("Idempotent user operation was not found", {
          status: 409,
          code: "USER_OPERATION_STATE_CONFLICT",
        });
      }
      if (
        existing.action !== normalizedAction
        || existing.target_type !== normalizedTargetType
        || existing.target_id !== normalizedTargetId
        || existing.request_hash !== requestHash
      ) {
        fail("X-Idempotency-Key was already used with a different request", {
          status: 409,
          code: "IDEMPOTENCY_KEY_REUSED",
        });
      }
      if (existing.status === "completed") {
        return normalizeStoredResponseSnapshot(existing.response_snapshot);
      }
      fail("The user operation is already in progress", {
        status: 409,
        code: "USER_OPERATION_IN_PROGRESS",
      });
    }

    const result = await mutate(tx);
    const responseSnapshot = prepareResponseSnapshot(result);
    const [completed] = await tx`
      UPDATE user_operations
      SET status = 'completed', response_snapshot = ${tx.json(responseSnapshot)},
          completed_at = NOW(), updated_at = NOW()
      WHERE id = ${inserted.id} AND status = 'claimed'
      RETURNING response_snapshot
    `;
    if (!completed) {
      fail("User operation completion state changed unexpectedly", {
        status: 409,
        code: "USER_OPERATION_STATE_CONFLICT",
      });
    }
    return normalizeStoredResponseSnapshot(completed.response_snapshot);
  });
};
