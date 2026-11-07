/**
 * 会员月赠积分服务
 *
 * 触发时机（双保险）：
 *  1. 任何积分相关请求进入时，检测并补发当期应发未发的月赠（请求时补发）。
 *  2. node-cron 每日扫描 next_bonus_at <= now() 的账户，作为补偿兜底。
 *
 * 防重机制：
 *  - membership_bonus_grants(user_id, cycle_start_at) 唯一约束。
 *  - membership_bonus_grants.idempotency_key 唯一约束。
 *  - point_ledger.idempotency_key 唯一约束。
 */
import sql from "../configs/db.js";
import { ensureAccountTx, rechargePoints } from "./pointsService.js";
import logger from "../configs/logger.js";

// 各等级每月赠送积分配置
const TIER_BONUS = {
  free: 0,
  basic: 500,
  pro: 2000,
  max: 5000,
  enterprise: 10000,
};

/**
 * 在事务中尝试补发当期会员月赠积分。
 * 如果当期已发放，幂等跳过。
 * @param {object} tx  - postgres 事务对象
 * @param {object} account - 已 FOR UPDATE 锁定的账户行
 * @returns {{ granted: boolean, pointsGranted: number }}
 */
export const tryGrantBonusInTx = async (tx, account) => {
  const { user_id: userId, membership_tier, next_bonus_at } = account;

  // 非会员或尚未到发放时间，直接跳过
  if (membership_tier === "free" || !next_bonus_at) {
    return { granted: false, pointsGranted: 0 };
  }

  if (new Date(next_bonus_at) > new Date()) {
    return { granted: false, pointsGranted: 0 };
  }

  const bonusPoints = Number(account.monthly_bonus_points || TIER_BONUS[membership_tier] || 0);
  if (bonusPoints <= 0) {
    return { granted: false, pointsGranted: 0 };
  }

  // 以 next_bonus_at 作为本周期起始
  const cycleStart = new Date(next_bonus_at);
  const cycleEnd = new Date(cycleStart);
  const targetMonth = cycleStart.getUTCMonth() + 1;
  const targetYear = cycleStart.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  cycleEnd.setUTCFullYear(targetYear, normalizedMonth, Math.min(cycleStart.getUTCDate(), lastDay));

  // Bug 7 修复：幂等键格式对齐 spec
  //   grant 行：membership_bonus:user:<userId>:cycle:<cycle_start_iso>
  //   ledger 行：membership_grant:bonus:<grant.id>
  const grantIdempotencyKey = `membership_bonus:user:${userId}:cycle:${cycleStart.toISOString()}`;

  // 插入月赠发放记录（ON CONFLICT → 幂等跳过）
  const [grant] = await tx`
    INSERT INTO membership_bonus_grants
      (user_id, membership_tier, cycle_start_at, cycle_end_at,
       points_granted, expires_at, idempotency_key, triggered_by)
    VALUES
      (${userId}, ${membership_tier}, ${cycleStart.toISOString()},
       ${cycleEnd.toISOString()}, ${bonusPoints}, ${cycleEnd.toISOString()},
       ${grantIdempotencyKey}, 'system')
    ON CONFLICT (user_id, cycle_start_at) DO NOTHING
    RETURNING id
  `;

  if (!grant) {
    // 已发放过，幂等跳过
    return { granted: false, pointsGranted: 0 };
  }

  // ledger 用独立幂等键，格式：membership_grant:bonus:<grant.id>
  const ledgerIdempotencyKey = `membership_grant:bonus:${grant.id}`;

  // 发放积分，entry_type 对齐 spec: membership_grant
  const { ledger, lot } = await rechargePoints({
    userId,
    amount: bonusPoints,
    sourceType: "membership_bonus_grant",
    sourceId: String(grant.id),
    idempotencyKey: ledgerIdempotencyKey,
    note: `会员月赠积分 ${membership_tier} ${cycleStart.toISOString().slice(0, 7)}`,
    entryType: "membership_grant",
    lotCategory: "membership_bonus",
    expiresAt: cycleEnd.toISOString(),
    tx,
  });

  // 更新 grant 的 ledger id
  await tx`
    UPDATE membership_bonus_grants
    SET point_ledger_id = ${ledger.id}, lot_id = ${lot?.id || null}
    WHERE id = ${grant.id}
  `;

  // 更新账户的月赠时间
  await tx`
    UPDATE user_point_accounts
    SET last_bonus_granted_at = NOW(),
        next_bonus_at         = ${cycleEnd.toISOString()},
        updated_at            = NOW()
    WHERE user_id = ${userId}
  `;

  logger.info("membership.grant", { userId, membership_tier, bonusPoints, cycleStart, grantId: grant.id });

  return { granted: true, pointsGranted: bonusPoints };
};

/**
 * 外部调用：在请求进入时检查并补发（非事务包装，内部自启事务）
 */
export const checkAndGrantBonus = async (userId) => {
  const [account] = await sql`
    SELECT * FROM user_point_accounts WHERE user_id = ${userId}
  `;

  if (!account || account.membership_tier === "free") {
    return { granted: false, pointsGranted: 0 };
  }

  return sql.begin(async (tx) => {
    const lockedAccount = await tx`
      SELECT * FROM user_point_accounts WHERE user_id = ${userId} FOR UPDATE
    `.then((rows) => rows[0]);

    return tryGrantBonusInTx(tx, lockedAccount);
  });
};

/**
 * cron 补偿扫描：扫描所有 next_bonus_at <= now() 的会员账户并补发
 */
export const compensationScan = async () => {
  const accounts = await sql`
    SELECT user_id FROM user_point_accounts
    WHERE membership_tier != 'free'
      AND next_bonus_at IS NOT NULL
      AND next_bonus_at <= NOW()
  `;

  let granted = 0;
  for (const { user_id } of accounts) {
    try {
      const result = await checkAndGrantBonus(user_id);
      if (result.granted) granted++;
    } catch (err) {
      logger.error("membership.compensationScan.error", { userId: user_id, error: err.message });
    }
  }

  logger.info("membership.compensationScan.done", { scanned: accounts.length, granted });
};
