import { createHash } from "node:crypto";

import sql from "../configs/db.js";

const ADMINISTRATOR_ROLES = new Set(["root", "admin"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fail = (message, { status = 500, code = "ADMINISTRATOR_OPERATION_FAILED" } = {}) => {
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
    fail(`${name} is invalid`, { status: 400, code: "INVALID_ADMINISTRATOR_OPERATION" });
  }
  return normalized;
};

export const normalizeAdministratorIdempotencyKey = (value) => {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    fail("A valid X-Idempotency-Key header is required", {
      status: 400,
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  return key;
};

export const normalizeAdministratorReason = (value) => {
  const reason = String(value || "").trim();
  if (!reason) {
    fail("reason is required", { status: 400, code: "REASON_REQUIRED" });
  }
  if (reason.length > 2000 || CONTROL_CHARACTER_PATTERN.test(reason)) {
    fail("reason is invalid", { status: 400, code: "INVALID_REASON" });
  }
  return reason;
};

export const hashAdministratorRequest = (payload) => {
  let serialized;
  try {
    serialized = JSON.stringify(canonicalize(payload ?? null));
  } catch {
    fail("Administrator operation payload is not serializable", {
      status: 400,
      code: "INVALID_ADMINISTRATOR_OPERATION",
    });
  }
  return createHash("sha256").update(serialized).digest("hex");
};

const prepareResponseSnapshot = (result) => {
  try {
    return JSON.parse(JSON.stringify(result ?? null));
  } catch {
    fail("Administrator operation result is not serializable", {
      code: "ADMINISTRATOR_OPERATION_RESULT_INVALID",
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

export const executeAdministratorOperation = async ({
  actor,
  idempotencyKey,
  action,
  targetType,
  targetId,
  requestPayload,
  mutate,
}) => {
  const actorUserId = boundedValue(actor?.userId, "actor user id", 255);
  const actorRole = String(actor?.role || "").trim().toLowerCase();
  if (!ADMINISTRATOR_ROLES.has(actorRole)) {
    fail("Administrator privileges are required", { status: 403, code: "ADMIN_REQUIRED" });
  }
  const normalizedKey = normalizeAdministratorIdempotencyKey(idempotencyKey);
  const normalizedAction = boundedValue(action, "action", 120);
  const normalizedTargetType = boundedValue(targetType, "target type", 80);
  const normalizedTargetId = boundedValue(targetId, "target id", 255);
  if (typeof mutate !== "function") {
    fail("Administrator operation mutation callback is required");
  }

  const requestHash = hashAdministratorRequest(requestPayload);

  return sql.begin(async (tx) => {
    const [inserted] = await tx`
      INSERT INTO administrator_operations
        (actor_user_id, actor_role, idempotency_key, action, target_type,
         target_id, request_hash, status)
      VALUES
        (${actorUserId}, ${actorRole}, ${normalizedKey}, ${normalizedAction},
         ${normalizedTargetType}, ${normalizedTargetId}, ${requestHash}, 'claimed')
      ON CONFLICT (actor_user_id, idempotency_key) DO NOTHING
      RETURNING id
    `;

    if (!inserted) {
      const [existing] = await tx`
        SELECT id, action, target_type, target_id, request_hash, status,
               response_snapshot
        FROM administrator_operations
        WHERE actor_user_id = ${actorUserId}
          AND idempotency_key = ${normalizedKey}
        FOR UPDATE
      `;
      if (!existing) {
        fail("Idempotent administrator operation was not found", {
          status: 409,
          code: "ADMINISTRATOR_OPERATION_STATE_CONFLICT",
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
      fail("The administrator operation is already in progress", {
        status: 409,
        code: "ADMINISTRATOR_OPERATION_IN_PROGRESS",
      });
    }

    const result = await mutate(tx);
    const responseSnapshot = prepareResponseSnapshot(result);
    const [completed] = await tx`
      UPDATE administrator_operations
      SET status = 'completed', response_snapshot = ${tx.json(responseSnapshot)},
          completed_at = NOW(), updated_at = NOW()
      WHERE id = ${inserted.id} AND status = 'claimed'
      RETURNING response_snapshot
    `;
    if (!completed) {
      fail("Administrator operation completion state changed unexpectedly", {
        status: 409,
        code: "ADMINISTRATOR_OPERATION_STATE_CONFLICT",
      });
    }
    return normalizeStoredResponseSnapshot(completed.response_snapshot);
  });
};
