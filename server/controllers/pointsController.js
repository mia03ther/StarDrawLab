import sql from "../configs/db.js";
import { getAccountInfo } from "../services/pointsService.js";
import { checkAndGrantBonus } from "../services/membershipService.js";
import logger from "../configs/logger.js";
import {
  createPointPackageOrder,
  findPointPackageOrder,
  listActivePointPackages,
} from "../services/pointPackageService.js";

const purchasesEnabled = () =>
  ["1", "true", "yes", "on"].includes(String(process.env.SUBSCRIPTION_PURCHASES_ENABLED || "false").trim().toLowerCase());

const publicPointOrder = (order) => {
  if (!order) return null;
  const fields = [
    "id", "order_no", "package_key", "package_name", "amount_cents", "points",
    "bonus_points", "total_points", "status", "payment_method", "created_at",
    "paid_at", "confirmed_at", "refunded_at", "updated_at",
  ];
  return Object.fromEntries(fields
    .filter((field) => order[field] !== undefined)
    .map((field) => [field, order[field]]));
};

// ─────────────────────────────────────────────
// GET /api/points/balance
// ─────────────────────────────────────────────
export const getBalance = async (req, res) => {
  try {
    const { userId } = req.auth;

    // 确保账户存在
    await sql`
      INSERT INTO user_point_accounts (user_id, balance_points, held_points)
      VALUES (${userId}, 0, 0)
      ON CONFLICT (user_id) DO NOTHING
    `;

    // 补发会员月赠（请求时触发）
    await checkAndGrantBonus(userId);

    const account = await getAccountInfo(userId);

    res.json({
      success: true,
      data: {
        balance_points:        account.balance_points,
        held_points:           account.held_points,
        available_points:      Number(account.available_points),
        membership_tier:       account.membership_tier,
        monthly_bonus_points:  account.monthly_bonus_points,
        bonus_cycle_anchor:    account.bonus_cycle_anchor,
        last_bonus_granted_at: account.last_bonus_granted_at,
        next_bonus_at:         account.next_bonus_at,
      },
    });
  } catch (err) {
    logger.error("getBalance.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/points/packages
// ─────────────────────────────────────────────
export const getPackages = async (_req, res) => {
  try {
    return res.json({ success: true, data: await listActivePointPackages() });
  } catch (err) {
    logger.error("getPackages.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/points/orders
// ─────────────────────────────────────────────
export const createOrder = async (req, res) => {
  try {
    if (!purchasesEnabled()) {
      return res.status(503).json({
        success: false,
        code: "POINT_PACKAGE_PURCHASES_DISABLED",
        message: "Point package purchases are not open yet.",
      });
    }
    const result = await createPointPackageOrder({
      userId: req.auth.userId,
      packageKey: String(req.body?.package_key || "").trim(),
      clientRequestId: req.headers["x-idempotency-key"],
      returnUrl: process.env.ALIPAY_RETURN_URL || `${process.env.APP_BASE_URL || ""}/ai/billing`,
    });
    return res.status(result.existing ? 200 : 201).json({
      success: true,
      data: {
        order: publicPointOrder(result.order),
        payment_url: result.payment_url,
        payment_config_status: result.payment_config_status,
      },
    });
  } catch (err) {
    logger.error("createOrder.error", { code: err.code, error: err.message });
    res.status(err.status || 500).json({ success: false, code: err.code, message: err.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/points/orders/:orderNo
// ─────────────────────────────────────────────
export const getOrder = async (req, res) => {
  try {
    const order = await findPointPackageOrder(req.params.orderNo);
    if (!order || String(order.user_id) !== String(req.auth.userId)) {
      return res.status(404).json({ success: false, message: "Point package order not found" });
    }
    return res.json({ success: true, data: publicPointOrder(order) });
  } catch (err) {
    logger.error("getOrder.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// POST /api/points/orders/:orderNo/confirm
// ─────────────────────────────────────────────
export const confirmOrder = async (req, res) => {
  try {
    return res.status(410).json({
      success: false,
      code: "CLIENT_PAYMENT_CONFIRMATION_DISABLED",
      message: "Payment confirmation is accepted only from verified Alipay notifications or server reconciliation.",
    });
  } catch (err) {
    logger.error("confirmOrder.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────
// GET /api/points/ledger
// ─────────────────────────────────────────────
export const getLedger = async (req, res) => {
  try {
    const { userId } = req.auth;
    const page      = Math.max(1, parseInt(req.query.page      || "1", 10));
    const page_size = Math.min(50, Math.max(1, parseInt(req.query.page_size || "20", 10)));
    const entry_type = req.query.entry_type || null;
    const offset = (page - 1) * page_size;

    // spec 要求：items + total 分页结构；包含 metadata 字段
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM point_ledger
      WHERE user_id = ${userId}
        AND (${entry_type}::text IS NULL OR entry_type = ${entry_type})
    `;

    const items = await sql`
      SELECT id, entry_type, source_type, source_id, change_points,
             held_points_change, balance_after, held_after, note, metadata, created_at
      FROM point_ledger
      WHERE user_id = ${userId}
        AND (${entry_type}::text IS NULL OR entry_type = ${entry_type})
      ORDER BY created_at DESC
      LIMIT ${page_size} OFFSET ${offset}
    `;

    // spec 响应结构：{ success, data: { items, page, page_size, total } }
    res.json({ success: true, data: { items, page, page_size, total: count } });
  } catch (err) {
    logger.error("getLedger.error", { error: err.message });
    res.status(500).json({ success: false, message: err.message });
  }
};
