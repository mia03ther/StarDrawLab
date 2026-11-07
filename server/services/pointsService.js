/**
 * 积分事务服务
 *
 * 幂等保证策略（修复 Bug 1）：
 *   事务内先查 point_ledger 是否已存在该 idempotency_key，
 *   存在则直接返回（账户不再变动）；
 *   不存在则先写流水、再改账户，保证"账本一条 ↔ 账户改一次"。
 *
 * 账本语义：
 *   reserve : change_points = 0,  held_points_change = +N  （预占）
 *   charge  : change_points = -N, held_points_change = -N  （结算扣减）
 *   release : change_points = 0,  held_points_change = -N  （返还预占）
 *   recharge: change_points = +N, held_points_change = 0   （充值 / 赠送）
 */
import sql from "../configs/db.js";
import logger from "../configs/logger.js";
import { inferGenerationMode, normalizeGenerationMode } from "../domain/pricing/generationChargeRule.js";
import { inferImageQuality } from "../domain/pricing/imageQuality.js";
import { isFixedPriceTemplate, TEMPLATE_GENERATION_POINTS } from "../domain/pricing/templatePricingPolicy.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

const normalizeMetaRule = (metaRule) => {
  if (!metaRule) return {};
  if (typeof metaRule === "string") {
    try {
      const parsed = JSON.parse(metaRule);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof metaRule === "object" && !Array.isArray(metaRule) ? metaRule : {};
};

const requirePositivePointAmount = (amount, operation = "point operation") => {
  const normalized = Number(amount);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > POSTGRES_INTEGER_MAX) {
    throw Object.assign(new Error(`${operation} amount must be a positive PostgreSQL integer`), {
      status: 503,
      code: "INVALID_POINT_AMOUNT",
    });
  }
  return normalized;
};

const normalizePointSource = ({ creationId, sourceType = "creation", sourceId }) => {
  const normalizedType = String(sourceType || "").trim();
  const normalizedId = String(sourceId ?? creationId ?? "").trim();
  if (!/^[a-z][a-z0-9_]{0,49}$/.test(normalizedType) || !normalizedId || normalizedId.length > 255) {
    throw Object.assign(new Error("Point operation source is invalid"), {
      status: 503,
      code: "INVALID_POINT_SOURCE",
    });
  }

  const allocationCreationId = normalizedType === "creation" ? creationId : null;
  if (normalizedType === "creation"
      && (!Number.isSafeInteger(Number(allocationCreationId)) || Number(allocationCreationId) <= 0)) {
    throw Object.assign(new Error("Creation point source must use a positive safe integer ID"), {
      status: 503,
      code: "INVALID_POINT_SOURCE",
    });
  }

  return {
    sourceType: normalizedType,
    sourceId: normalizedId,
    allocationCreationId: normalizedType === "creation" ? Number(allocationCreationId) : null,
  };
};

/**
 * 确保用户积分账户存在并加行锁（必须在事务中调用）。
 */
export const ensureAccountTx = async (tx, userId) => {
  // UPSERT 保证账户存在
  await tx`
    INSERT INTO user_point_accounts (user_id, balance_points, held_points)
    VALUES (${userId}, 0, 0)
    ON CONFLICT (user_id) DO NOTHING
  `;

  const [account] = await tx`
    SELECT * FROM user_point_accounts
    WHERE user_id = ${userId}
    FOR UPDATE
  `;

  return account;
};

// ─── 幂等门卫：在事务锁内检查 idempotency_key ───────────────────────
const checkLedgerIdempotency = async (tx, idempotencyKey) => {
  const [existing] = await tx`
    SELECT id, balance_after, held_after, change_points, held_points_change
    FROM point_ledger
    WHERE idempotency_key = ${idempotencyKey}
  `;
  return existing || null;
};

// Monthly bonus lots expire independently from purchased points.  Expiration
// is handled while the account row is locked so the account balance and lot
// balance can never drift apart.
const expireAvailableLotsTx = async (tx, userId, account) => {
  const expiredLots = await tx`
    SELECT id, available_points, expires_at
    FROM point_lots
    WHERE user_id = ${userId}
      AND available_points > 0
      AND expires_at IS NOT NULL
      AND expires_at <= NOW()
    ORDER BY expires_at ASC, id ASC
    FOR UPDATE
  `;

  if (expiredLots.length === 0) return account;

  let nextBalance = Number(account.balance_points || 0);
  for (const lot of expiredLots) {
    const amount = Number(lot.available_points || 0);
    if (amount <= 0) continue;

    nextBalance -= amount;
    await tx`
      UPDATE point_lots
      SET available_points = 0,
          expired_points = expired_points + ${amount},
          updated_at = NOW()
      WHERE id = ${lot.id}
    `;

    await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, lot_id, note)
      VALUES
        (${userId}, 'expire', 'point_lot', ${String(lot.id)}, ${`expire:lot:${lot.id}`},
         ${-amount}, 0, ${nextBalance}, ${account.held_points}, ${lot.id},
         '月赠积分到期')
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
  }

  if (nextBalance !== Number(account.balance_points || 0)) {
    await tx`
      UPDATE user_point_accounts
      SET balance_points = ${nextBalance}, version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;
    return { ...account, balance_points: nextBalance };
  }

  return account;
};

export const getReservationTargetAmount = ({ existingAmount = 0, requestedAmount = 0, additionalAmount = false } = {}) => {
  const existing = Math.max(0, Number(existingAmount) || 0);
  const requested = Math.max(0, Number(requestedAmount) || 0);
  return additionalAmount ? existing + requested : requested;
};

const reserveFromLotsTx = async (tx, {
  userId,
  amount,
  sourceType,
  sourceId,
  allocationCreationId,
  lotOrderId = null,
  lotProductOrderType = null,
  lotProductOrderId = null,
  additionalAmount = false,
}) => {
  const existing = await tx`
    SELECT lot_id, amount_points
    FROM point_lot_allocations
    WHERE user_id = ${userId}
      AND source_type = ${sourceType}
      AND source_id = ${sourceId}
      AND status = 'held'
    FOR UPDATE
  `;
  const existingTotal = existing.reduce((sum, row) => sum + Number(row.amount_points || 0), 0);
  const targetAmount = getReservationTargetAmount({
    existingAmount: existingTotal,
    requestedAmount: amount,
    additionalAmount,
  });
  if (existingTotal >= targetAmount) return existing;

  const lots = await tx`
    SELECT id, available_points, expires_at
    FROM point_lots
    WHERE user_id = ${userId}
      AND available_points > 0
      AND (expires_at IS NULL OR expires_at > NOW())
      AND (${lotOrderId}::bigint IS NULL OR order_id = ${lotOrderId})
      AND (${lotProductOrderType}::text IS NULL OR product_order_type = ${lotProductOrderType})
      AND (${lotProductOrderId}::bigint IS NULL OR product_order_id = ${lotProductOrderId})
    ORDER BY expires_at ASC NULLS LAST, created_at ASC, id ASC
    FOR UPDATE
  `;

  let remaining = targetAmount - existingTotal;
  const allocations = [...existing];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const slice = Math.min(remaining, Number(lot.available_points || 0));
    if (slice <= 0) continue;

    await tx`
      UPDATE point_lots
      SET available_points = available_points - ${slice},
          held_points = held_points + ${slice},
          updated_at = NOW()
      WHERE id = ${lot.id}
    `;

    const [allocation] = await tx`
      INSERT INTO point_lot_allocations
        (user_id, creation_id, source_type, source_id, lot_id, amount_points, status)
      VALUES
        (${userId}, ${allocationCreationId}, ${sourceType}, ${sourceId}, ${lot.id}, ${slice}, 'held')
      ON CONFLICT (source_type, source_id, lot_id) DO UPDATE
      SET amount_points = point_lot_allocations.amount_points + EXCLUDED.amount_points,
          status = 'held',
          updated_at = NOW()
      RETURNING lot_id, amount_points
    `;

    allocations.push(allocation);
    remaining -= slice;
  }

  if (remaining > 0) {
    throw Object.assign(new Error("Point lots do not cover the requested amount"), {
      code: "POINT_LOT_INCONSISTENCY",
      available_points: amount - remaining,
      required_points: amount,
    });
  }

  return allocations;
};

const getHeldAllocationsTx = async (tx, userId, sourceType, sourceId) => tx`
  SELECT id, lot_id, amount_points
  FROM point_lot_allocations
  WHERE user_id = ${userId}
    AND source_type = ${sourceType}
    AND source_id = ${sourceId}
    AND status = 'held'
  ORDER BY id ASC
  FOR UPDATE
`;

// ─────────────────────────────────────────────
// reservePoints — 预占积分
// 支持外部事务 tx，供 aiController 原子封装使用
// ─────────────────────────────────────────────
export const reservePoints = async ({
  userId,
  amount,
  creationId,
  sourceType,
  sourceId,
  lotOrderId = null,
  lotProductOrderType = null,
  lotProductOrderId = null,
  additionalAmount = false,
  idempotencyKey,
  note,
  tx: externalTx,
}) => {
  const normalizedAmount = requirePositivePointAmount(amount, "Reserve");
  const source = normalizePointSource({ creationId, sourceType, sourceId });
  const normalizedLotOrderId = lotOrderId == null ? null : Number(lotOrderId);
  const normalizedProductOrderType = lotProductOrderType == null
    ? null
    : String(lotProductOrderType).trim();
  const normalizedProductOrderId = lotProductOrderId == null ? null : Number(lotProductOrderId);
  if (normalizedLotOrderId != null
      && (!Number.isSafeInteger(normalizedLotOrderId) || normalizedLotOrderId <= 0)) {
    throw Object.assign(new Error("Point lot order filter is invalid"), {
      status: 503,
      code: "INVALID_POINT_SOURCE",
    });
  }
  if ((normalizedProductOrderType == null) !== (normalizedProductOrderId == null)
      || (normalizedProductOrderType != null
        && !["subscription", "point_package"].includes(normalizedProductOrderType))
      || (normalizedProductOrderId != null
        && (!Number.isSafeInteger(normalizedProductOrderId) || normalizedProductOrderId <= 0))) {
    throw Object.assign(new Error("Point lot product order filter is invalid"), {
      status: 503,
      code: "INVALID_POINT_SOURCE",
    });
  }
  const run = async (tx) => {
    // 1. 锁定账户
    let account = await ensureAccountTx(tx, userId);

    // Expire only currently available lots.  Held lots stay attached to the
    // in-flight generation and are either charged or released atomically.
    account = await expireAvailableLotsTx(tx, userId, account);

    // 2. 幂等检查（在锁内）— 已存在直接返回，账户不动
    const existing = await checkLedgerIdempotency(tx, idempotencyKey);
    if (existing) {
      logger.info("points.reserve.idempotent", { userId, idempotencyKey });
      return { success: true, ledger: existing };
    }

    // 3. 校验可用积分
    const available = account.balance_points - account.held_points;
    if (available < normalizedAmount) {
      throw Object.assign(new Error("Insufficient points"), {
        code: "INSUFFICIENT_POINTS",
        available_points: available,
        required_points: normalizedAmount,
      });
    }

    const newHeld = account.held_points + normalizedAmount;

    const allocations = await reserveFromLotsTx(tx, {
      userId,
      amount: normalizedAmount,
      lotOrderId: normalizedLotOrderId,
      lotProductOrderType: normalizedProductOrderType,
      lotProductOrderId: normalizedProductOrderId,
      additionalAmount: Boolean(additionalAmount),
      ...source,
    });

    // 4. 先写流水
    const [ledger] = await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, lot_id, metadata, note)
      VALUES
        (${userId}, 'reserve', ${source.sourceType}, ${source.sourceId}, ${idempotencyKey},
         0, ${normalizedAmount}, ${account.balance_points}, ${newHeld}, NULL,
         ${JSON.stringify({ allocations })}::jsonb, ${note || null})
      RETURNING *
    `;

    // 5. 再改账户
    await tx`
      UPDATE user_point_accounts
      SET held_points = ${newHeld}, version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;

    logger.info("points.reserve", {
      userId,
      amount: normalizedAmount,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      ledgerId: ledger.id,
    });
    return { success: true, ledger };
  };

  return externalTx ? run(externalTx) : sql.begin(run);
};

// ─────────────────────────────────────────────
// refundReservedPoints — 将退款预占转换为已退款积分
// ─────────────────────────────────────────────
export const refundReservedPoints = async ({
  userId,
  amount,
  sourceType,
  sourceId,
  idempotencyKey,
  note,
  tx: externalTx,
}) => {
  const normalizedAmount = requirePositivePointAmount(amount, "Refund");
  const source = normalizePointSource({ sourceType, sourceId });
  const run = async (tx) => {
    const account = await ensureAccountTx(tx, userId);
    const existing = await checkLedgerIdempotency(tx, idempotencyKey);
    if (existing) return { success: true, ledger: existing };

    const newBalance = Number(account.balance_points) - normalizedAmount;
    const newHeld = Number(account.held_points) - normalizedAmount;
    if (newBalance < 0 || newHeld < 0) {
      throw Object.assign(new Error("Account balance inconsistency on refund"), {
        code: "POINT_LOT_INCONSISTENCY",
      });
    }

    const allocations = await getHeldAllocationsTx(tx, userId, source.sourceType, source.sourceId);
    const allocationTotal = allocations.reduce((sum, row) => sum + Number(row.amount_points || 0), 0);
    if (allocationTotal !== normalizedAmount) {
      throw Object.assign(new Error("Refund point allocation is incomplete"), {
        code: "POINT_LOT_INCONSISTENCY",
      });
    }

    for (const allocation of allocations) {
      const slice = Number(allocation.amount_points || 0);
      await tx`
        UPDATE point_lots
        SET held_points = held_points - ${slice},
            refunded_points = refunded_points + ${slice},
            updated_at = NOW()
        WHERE id = ${allocation.lot_id}
      `;
      await tx`
        UPDATE point_lot_allocations
        SET status = 'refunded', updated_at = NOW()
        WHERE id = ${allocation.id}
      `;
    }

    const [ledger] = await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, metadata, note)
      VALUES
        (${userId}, 'refund', ${source.sourceType}, ${source.sourceId}, ${idempotencyKey},
         ${-normalizedAmount}, ${-normalizedAmount}, ${newBalance}, ${newHeld},
         ${JSON.stringify({ allocations })}::jsonb, ${note || null})
      RETURNING *
    `;

    await tx`
      UPDATE user_point_accounts
      SET balance_points = ${newBalance}, held_points = ${newHeld},
          version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;
    return { success: true, ledger };
  };

  return externalTx ? run(externalTx) : sql.begin(run);
};

// ─────────────────────────────────────────────
// chargePoints — 结算扣减
// ─────────────────────────────────────────────
export const chargePoints = async ({
  userId,
  amount,
  creationId,
  sourceType,
  sourceId,
  idempotencyKey,
  note,
  tx: externalTx,
}) => {
  const normalizedAmount = requirePositivePointAmount(amount, "Charge");
  const source = normalizePointSource({ creationId, sourceType, sourceId });
  const run = async (tx) => {
    const account = await ensureAccountTx(tx, userId);

    const existing = await checkLedgerIdempotency(tx, idempotencyKey);
    if (existing) {
      logger.info("points.charge.idempotent", { userId, idempotencyKey });
      return { success: true, ledger: existing };
    }

    const newBalance = account.balance_points - normalizedAmount;
    const newHeld    = account.held_points    - normalizedAmount;

    if (newBalance < 0 || newHeld < 0) {
      throw new Error("Account balance inconsistency on charge");
    }

    const allocations = await getHeldAllocationsTx(tx, userId, source.sourceType, source.sourceId);
    const allocationTotal = allocations.reduce((sum, row) => sum + Number(row.amount_points || 0), 0);
    if (allocationTotal !== normalizedAmount) {
      throw new Error("Reserved point allocation is incomplete");
    }

    for (const allocation of allocations) {
      const slice = Number(allocation.amount_points || 0);
      await tx`
        UPDATE point_lots
        SET held_points = held_points - ${slice},
            consumed_points = consumed_points + ${slice},
            updated_at = NOW()
        WHERE id = ${allocation.lot_id}
      `;
      await tx`
        UPDATE point_lot_allocations
        SET status = 'charged', updated_at = NOW()
        WHERE id = ${allocation.id}
      `;
    }

    const [ledger] = await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, metadata, note)
      VALUES
        (${userId}, 'charge', ${source.sourceType}, ${source.sourceId}, ${idempotencyKey},
         ${-normalizedAmount}, ${-normalizedAmount}, ${newBalance}, ${newHeld},
         ${JSON.stringify({ allocations })}::jsonb, ${note || null})
      RETURNING *
    `;

    await tx`
      UPDATE user_point_accounts
      SET balance_points = ${newBalance}, held_points = ${newHeld},
          version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;

    logger.info("points.charge", {
      userId,
      amount: normalizedAmount,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      ledgerId: ledger.id,
    });
    return { success: true, ledger };
  };

  return externalTx ? run(externalTx) : sql.begin(run);
};

// ─────────────────────────────────────────────
// releasePoints — 返还预占
// ─────────────────────────────────────────────
export const releasePoints = async ({
  userId,
  amount,
  creationId,
  sourceType,
  sourceId,
  idempotencyKey,
  note,
  tx: externalTx,
}) => {
  const normalizedAmount = Number(amount);
  if (!Number.isSafeInteger(normalizedAmount) || normalizedAmount < 0) {
    throw Object.assign(new Error("Release amount must be a non-negative safe integer"), {
      status: 503,
      code: "INVALID_POINT_AMOUNT",
    });
  }
  const source = normalizePointSource({ creationId, sourceType, sourceId });
  const run = async (tx) => {
    const account = await ensureAccountTx(tx, userId);

    const existing = await checkLedgerIdempotency(tx, idempotencyKey);
    if (existing) {
      logger.info("points.release.idempotent", { userId, idempotencyKey });
      return { success: true, ledger: existing };
    }

    // amount = 0 时不写流水（无预占可释放），直接幂等返回
    if (normalizedAmount === 0) {
      logger.info("points.release.skip", { userId, reason: "amount=0" });
      return { success: true, ledger: null };
    }

    const actualRelease = Math.min(normalizedAmount, Math.max(0, Number(account.held_points || 0)));
    if (actualRelease <= 0) {
      logger.info("points.release.skip", { userId, reason: "held_points=0" });
      return { success: true, ledger: null };
    }

    const newHeld = account.held_points - actualRelease;

    const allocations = await getHeldAllocationsTx(tx, userId, source.sourceType, source.sourceId);
    const allocationTotal = allocations.reduce((sum, row) => sum + Number(row.amount_points || 0), 0);
    if (allocationTotal < actualRelease) {
      throw new Error("Reserved point allocation is incomplete");
    }
    let remainingRelease = actualRelease;
    for (const allocation of allocations) {
      if (remainingRelease <= 0) break;
      const slice = Math.min(remainingRelease, Number(allocation.amount_points || 0));
      await tx`
        UPDATE point_lots
        SET available_points = available_points + ${slice},
            held_points = held_points - ${slice},
            updated_at = NOW()
        WHERE id = ${allocation.lot_id}
      `;
      if (slice === Number(allocation.amount_points || 0)) {
        await tx`
          UPDATE point_lot_allocations
          SET status = 'released', updated_at = NOW()
          WHERE id = ${allocation.id}
        `;
      } else {
        await tx`
          UPDATE point_lot_allocations
          SET amount_points = amount_points - ${slice}, updated_at = NOW()
          WHERE id = ${allocation.id}
        `;
      }
      remainingRelease -= slice;
    }

    const [ledger] = await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, metadata, note)
      VALUES
        (${userId}, 'release', ${source.sourceType}, ${source.sourceId}, ${idempotencyKey},
         0, ${-actualRelease}, ${account.balance_points}, ${newHeld},
         ${JSON.stringify({ allocations })}::jsonb, ${note || null})
      RETURNING *
    `;

    await tx`
      UPDATE user_point_accounts
      SET held_points = ${newHeld}, version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;

    logger.info("points.release", {
      userId,
      amount: actualRelease,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      ledgerId: ledger.id,
    });
    return { success: true, ledger };
  };

  return externalTx ? run(externalTx) : sql.begin(run);
};

// ─────────────────────────────────────────────
// rechargePoints — 充值 / 月赠 / 手工调账（统一入账方法）
// entryType 可选，默认 'recharge'；月赠传 'membership_grant'；手工调账传 'manual_adjustment'
// ─────────────────────────────────────────────
export const rechargePoints = async ({
  userId, amount, sourceType, sourceId, idempotencyKey, note, tx: externalTx,
  entryType = "recharge", lotCategory, expiresAt, orderId,
  productOrderType = orderId ? "subscription" : null,
  productOrderId = orderId || null,
}) => {
  const normalizedAmount = requirePositivePointAmount(amount, "Recharge");
  const run = async (tx) => {
    const account = await ensureAccountTx(tx, userId);

    const existing = await checkLedgerIdempotency(tx, idempotencyKey);
    if (existing) {
      logger.info("points.recharge.idempotent", { userId, idempotencyKey });
      const [existingLot] = await tx`
        SELECT id FROM point_lots WHERE idempotency_key = ${idempotencyKey}
      `;
      return { success: true, ledger: existing, lot: existingLot || null, newBalance: existing.balance_after };
    }

    const newBalance = Number(account.balance_points) + normalizedAmount;
    if (newBalance > POSTGRES_INTEGER_MAX) {
      throw Object.assign(new Error("Point account balance limit would be exceeded"), {
        status: 409,
        code: "POINT_BALANCE_LIMIT_EXCEEDED",
      });
    }

    const [lot] = await tx`
      INSERT INTO point_lots
        (user_id, source_type, source_id, order_id, category, total_points,
         available_points, held_points, consumed_points, expires_at,
         idempotency_key, metadata, product_order_type, product_order_id)
      VALUES
        (${userId}, ${sourceType}, ${String(sourceId)}, ${orderId || null},
         ${lotCategory || (entryType === "membership_grant" ? "membership_bonus" : "purchased")},
         ${normalizedAmount}, ${normalizedAmount}, 0, 0, ${expiresAt || null},
         ${idempotencyKey}, ${JSON.stringify({ entryType })}::jsonb,
         ${productOrderType || null}, ${productOrderId || null})
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
    `;

    const resolvedLot = lot || (await tx`
      SELECT * FROM point_lots WHERE idempotency_key = ${idempotencyKey}
    `)[0];

    const [ledger] = await tx`
      INSERT INTO point_ledger
        (user_id, entry_type, source_type, source_id, idempotency_key,
         change_points, held_points_change, balance_after, held_after, lot_id, metadata, note)
      VALUES
        (${userId}, ${entryType}, ${sourceType}, ${String(sourceId)}, ${idempotencyKey},
         ${normalizedAmount}, 0, ${newBalance}, ${account.held_points}, ${resolvedLot?.id || null},
         ${JSON.stringify({ lot_id: resolvedLot?.id || null, lot_category: lotCategory || null })}::jsonb,
         ${note || null})
      RETURNING *
    `;

    await tx`
      UPDATE user_point_accounts
      SET balance_points = ${newBalance}, version = version + 1, updated_at = NOW()
      WHERE user_id = ${userId}
    `;

    logger.info("points.recharge", {
      userId,
      amount: normalizedAmount,
      entryType,
      sourceId,
      ledgerId: ledger.id,
    });
    return { success: true, ledger, lot: resolvedLot, newBalance };
  };

  return externalTx ? run(externalTx) : sql.begin(run);
};

// ─────────────────────────────────────────────
// resolveCharge — 查询计费规则
// ─────────────────────────────────────────────
export const resolveChargeRule = async ({ outputType, provider, sceneKey, model, seconds, size, generationMode }) => {
  const normalizedOutputType = String(outputType || "").trim().toLowerCase();
  const normalizedProvider = provider == null ? null : String(provider).trim().toLowerCase();
  const normalizedSceneKey = sceneKey == null || sceneKey === "" ? null : sceneKey;
  const normalizedModel = model == null || model === "" ? null : model;
  const normalizedSeconds = seconds == null || seconds === "" ? null : seconds;
  const normalizedSize = size == null || size === "" ? null : size;
  const requestedMode = generationMode
    ? normalizeGenerationMode(generationMode, normalizedOutputType)
    : "all";
  // A media scene is server-resolved before pricing. Its canonical key decides
  // whether it is a template; caller-provided modes cannot discount freeform.
  const mode = normalizedSceneKey && ["image", "video"].includes(normalizedOutputType)
    ? inferGenerationMode({ outputType: normalizedOutputType, sceneKey: normalizedSceneKey })
    : requestedMode;
  if (isFixedPriceTemplate({ outputType: normalizedOutputType, sceneKey: normalizedSceneKey })) {
    return {
      id: "policy:template-flat-18", output_type: normalizedOutputType,
      provider: normalizedProvider, scene_key: normalizedSceneKey,
      model: normalizedModel, seconds: normalizedSeconds, size: normalizedSize,
      points_cost: TEMPLATE_GENERATION_POINTS, generation_mode: "template",
      meta_rule: { billing_type: "fixed", policy: "template-flat-18" },
    };
  }
  const imageQuality = normalizedOutputType === "image"
    ? inferImageQuality({ model: normalizedModel, size: normalizedSize })
    : null;
  const rules = await sql`
    SELECT id, output_type, provider, scene_key, model, seconds, size,
           points_cost, priority, meta_rule, generation_mode FROM generation_charge_rules
    WHERE output_type = ${normalizedOutputType}
      AND provider    = ${normalizedProvider}
      AND is_active   = true
      AND (generation_mode = ${mode} OR generation_mode = 'all')
      AND (scene_key = ${normalizedSceneKey} OR scene_key IS NULL)
      AND (model     = ${normalizedModel}    OR model     IS NULL)
      AND (seconds   = ${normalizedSeconds}  OR seconds   IS NULL)
      AND (size      = ${normalizedSize}     OR size      IS NULL)
      AND (
        ${normalizedOutputType} <> 'image'
        OR meta_rule->>'image_quality' IS NULL
        OR meta_rule->>'image_quality' = ${imageQuality || ""}
      )
    ORDER BY
      CASE WHEN generation_mode = ${mode} THEN 0 ELSE 1 END,
      priority ASC,
      ((scene_key IS NOT NULL)::int
       + (model IS NOT NULL)::int
       + (seconds IS NOT NULL)::int
       + (size IS NOT NULL)::int
       + CASE WHEN ${normalizedOutputType} = 'image'
              AND meta_rule->>'image_quality' IS NOT NULL THEN 1 ELSE 0 END) DESC,
      id ASC
    LIMIT 1
  `;

  if (rules.length === 0) {
    throw new Error(`No active charge rule found for ${normalizedOutputType}/${normalizedProvider}/${normalizedSceneKey}`);
  }

  const rule = rules[0];
  const metaRule = normalizeMetaRule(rule.meta_rule);
  return { ...rule, meta_rule: metaRule };
};

export const resolveCharge = async (args) => {
  const rule = await resolveChargeRule(args);
  const metaRule = normalizeMetaRule(rule.meta_rule);
  if (metaRule.billing_type === "per_minute") {
    const pointsPerMinute = Number(metaRule.points_per_minute || rule.points_cost || 0);
    const billableSeconds = Number(args.seconds);
    if (!Number.isFinite(pointsPerMinute) || pointsPerMinute <= 0
        || !Number.isSafeInteger(billableSeconds) || billableSeconds <= 0) {
      throw Object.assign(new Error("The active per-minute charge rule is invalid"), {
        status: 503,
        code: "INVALID_CHARGE_RULE",
      });
    }
    const minimumPoints = Math.max(0, Number(metaRule.minimum_points || 0));
    const computed = Math.ceil((pointsPerMinute * billableSeconds) / 60);
    return requirePositivePointAmount(Math.max(1, minimumPoints, computed), "Resolved charge");
  }

  if (metaRule.billing_type === "token_usage") {
    return requirePositivePointAmount(Math.max(1, Number(metaRule.minimum_points || rule.points_cost || 1)), "Resolved charge");
  }

  return requirePositivePointAmount(rule.points_cost, "Resolved charge");
};

// ─────────────────────────────────────────────
// getAccountInfo — 只读展示
// ─────────────────────────────────────────────
export const getAccountInfo = async (userId) => {
  const [account] = await sql`
    SELECT balance_points, held_points,
           (balance_points - held_points) AS available_points,
           membership_tier, monthly_bonus_points,
           bonus_cycle_anchor, last_bonus_granted_at, next_bonus_at
    FROM user_point_accounts
    WHERE user_id = ${userId}
  `;
  return account || null;
};
