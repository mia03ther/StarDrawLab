import sql from "../configs/db.js";
import { hasPermission, PERMISSIONS } from "./accessControlService.js";
import { executeAdministratorOperation } from "./administratorOperationService.js";
import { writeAuditLog } from "./auditService.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

const fail = (message, status = 400, code = "POINT_PACKAGE_INVALID") => {
  throw Object.assign(new Error(message), { status, code });
};

const assertPermission = (actor) => {
  if (!hasPermission(actor?.role, PERMISSIONS.SUBSCRIPTION_PLAN_MANAGE)) {
    fail("Point package management permission is required", 403, "USER_RBAC_DENIED");
  }
};

const normalizeId = (value) => {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
    fail("packageId is invalid", 400, "INVALID_POINT_PACKAGE_ID");
  }
  return id;
};

const normalizePackage = (input = {}, existing = null) => {
  const packageKey = String(input.packageKey ?? input.package_key ?? existing?.package_key ?? "").trim();
  const packageName = String(input.packageName ?? input.package_name ?? existing?.package_name ?? "").trim();
  const descriptionValue = input.description ?? existing?.description ?? null;
  const description = descriptionValue == null ? null : String(descriptionValue).trim().slice(0, 2000) || null;
  const priceCents = Number(input.priceCents ?? input.price_cents ?? existing?.price_cents);
  const points = Number(input.points ?? existing?.points);
  const bonusPoints = Number(input.bonusPoints ?? input.bonus_points ?? existing?.bonus_points ?? 0);
  const displayOrder = Number(input.displayOrder ?? input.display_order ?? existing?.display_order ?? 0);
  const isActiveInput = input.isActive ?? input.is_active;
  const metadata = input.metadata ?? existing?.metadata ?? {};

  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/i.test(packageKey) || !packageName || packageName.length > 100) {
    fail("packageKey and packageName are required; packageKey may contain letters, numbers, _ and -");
  }
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0 || priceCents > POSTGRES_INTEGER_MAX
      || !Number.isSafeInteger(points) || points <= 0 || points > POSTGRES_INTEGER_MAX
      || !Number.isSafeInteger(bonusPoints) || bonusPoints < 0 || bonusPoints > POSTGRES_INTEGER_MAX
      || points + bonusPoints > POSTGRES_INTEGER_MAX) {
    fail("priceCents, points, bonusPoints and total points must fit positive PostgreSQL integer values");
  }
  if (!Number.isSafeInteger(displayOrder)) fail("displayOrder must be an integer");
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || JSON.stringify(metadata).length > 20_000) {
    fail("metadata must be a bounded JSON object");
  }

  return {
    packageKey,
    packageName,
    description,
    priceCents,
    points,
    bonusPoints,
    isActive: isActiveInput == null ? Boolean(existing?.is_active) : Boolean(isActiveInput),
    displayOrder,
    metadata,
  };
};

export const listConfiguredPointPackages = async ({ actor, db = sql } = {}) => {
  assertPermission(actor);
  return db`
    SELECT id, package_key, package_name, description, price_cents, points,
           bonus_points, (points + bonus_points)::integer AS total_points,
           is_active, display_order, metadata, created_at, updated_at
    FROM point_packages
    ORDER BY display_order ASC, price_cents ASC, id ASC
  `;
};

export const saveConfiguredPointPackage = async ({
  actor,
  packageId = null,
  input,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPermission(actor);
  const id = packageId == null ? null : normalizeId(packageId);
  const action = id ? "point_package.updated" : "point_package.created";
  const targetId = id || String(input?.packageKey ?? input?.package_key ?? "").trim();
  if (!targetId) fail("packageKey is required");

  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action,
    targetType: "point_package",
    targetId,
    requestPayload: { input, reason },
    mutate: async (tx) => {
      const [before] = id ? await tx`SELECT * FROM point_packages WHERE id = ${id} FOR UPDATE` : [null];
      if (id && !before) fail("Point package not found", 404, "POINT_PACKAGE_NOT_FOUND");
      const normalized = normalizePackage(input, before);
      const [after] = id
        ? await tx`
            UPDATE point_packages
            SET package_key = ${normalized.packageKey}, package_name = ${normalized.packageName},
                description = ${normalized.description}, price_cents = ${normalized.priceCents},
                points = ${normalized.points}, bonus_points = ${normalized.bonusPoints},
                is_active = ${normalized.isActive}, display_order = ${normalized.displayOrder},
                metadata = ${tx.json(normalized.metadata)}, updated_at = NOW()
            WHERE id = ${before.id}
            RETURNING *
          `
        : await tx`
            INSERT INTO point_packages
              (package_key, package_name, description, price_cents, points,
               bonus_points, is_active, display_order, metadata, updated_at)
            VALUES
              (${normalized.packageKey}, ${normalized.packageName}, ${normalized.description},
               ${normalized.priceCents}, ${normalized.points}, ${normalized.bonusPoints},
               ${normalized.isActive}, ${normalized.displayOrder}, ${tx.json(normalized.metadata)}, NOW())
            RETURNING *
          `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: "point_package",
        targetId: after.id,
        reason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};

export const deactivateConfiguredPointPackage = async ({
  actor,
  packageId,
  reason,
  idempotencyKey,
  req,
} = {}) => {
  assertPermission(actor);
  const id = normalizeId(packageId);
  return executeAdministratorOperation({
    actor,
    idempotencyKey,
    action: "point_package.deactivated",
    targetType: "point_package",
    targetId: id,
    requestPayload: { reason },
    mutate: async (tx) => {
      const [before] = await tx`SELECT * FROM point_packages WHERE id = ${id} FOR UPDATE`;
      if (!before) fail("Point package not found", 404, "POINT_PACKAGE_NOT_FOUND");
      const [after] = await tx`
        UPDATE point_packages SET is_active = FALSE, updated_at = NOW()
        WHERE id = ${before.id}
        RETURNING id, package_key, is_active
      `;
      await writeAuditLog({
        req,
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: "point_package.deactivated",
        targetType: "point_package",
        targetId: id,
        reason,
        before,
        after,
        tx,
      });
      return after;
    },
  });
};
