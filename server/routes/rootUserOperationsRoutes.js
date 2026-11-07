import express from "express";
import logger from "../configs/logger.js";
import { requirePermission } from "../middlewares/authorize.js";
import { assertRootTargetMutable, PERMISSIONS } from "../services/accessControlService.js";
import {
  executeAdministratorOperation,
  normalizeAdministratorIdempotencyKey,
  normalizeAdministratorReason,
} from "../services/administratorOperationService.js";
import { writeAuditLog } from "../services/auditService.js";

const router = express.Router();
const TIERS = new Set(["free", "basic", "pro", "max", "enterprise"]);
const MONTHLY_BONUS = { free: 0, basic: 500, pro: 2000, max: 5000, enterprise: 10000 };

const requireMutationContext = (req, res, next) => {
  try {
    req.rootMutationIdempotencyKey = normalizeAdministratorIdempotencyKey(req.headers["x-idempotency-key"]);
    req.rootMutationReason = normalizeAdministratorReason(req.body?.reason);
    return next();
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, code: error.code, message: error.message });
  }
};

router.patch("/users/:userId/membership", requirePermission(PERMISSIONS.MEMBERSHIP_ADJUST), requireMutationContext, async (req, res) => {
  const tier = String(req.body?.membership_tier || "").trim().toLowerCase();
  if (!TIERS.has(tier)) return res.status(400).json({ success: false, code: "INVALID_MEMBERSHIP_TIER", message: "Invalid membership_tier" });
  try {
    assertRootTargetMutable(req.params.userId);
    const data = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.rootMutationIdempotencyKey,
      action: "user.membership_adjusted",
      targetType: "user",
      targetId: req.params.userId,
      requestPayload: req.body,
      mutate: async (tx) => {
        const [profile] = await tx`SELECT user_id FROM user_profiles WHERE user_id = ${req.params.userId} FOR UPDATE`;
        if (!profile) throw Object.assign(new Error("User not found"), { status: 404, code: "USER_NOT_FOUND" });
        const [before] = await tx`SELECT * FROM user_point_accounts WHERE user_id = ${req.params.userId} FOR UPDATE`;
        if (!before) {
          await tx`
            INSERT INTO user_point_accounts
              (user_id, balance_points, held_points, membership_tier, monthly_bonus_points,
               bonus_cycle_anchor, next_bonus_at)
            VALUES
              (${req.params.userId}, 0, 0, ${tier}, ${MONTHLY_BONUS[tier]},
               CASE WHEN ${tier} = 'free' THEN NULL ELSE NOW() END,
               CASE WHEN ${tier} = 'free' THEN NULL ELSE NOW() + INTERVAL '1 month' END)
          `;
        } else if (before.membership_tier !== tier) {
          await tx`
            UPDATE user_point_accounts
            SET membership_tier = ${tier}, monthly_bonus_points = ${MONTHLY_BONUS[tier]},
                bonus_cycle_anchor = CASE WHEN ${tier} = 'free' THEN NULL ELSE NOW() END,
                next_bonus_at = CASE WHEN ${tier} = 'free' THEN NULL ELSE NOW() + INTERVAL '1 month' END,
                version = version + 1, updated_at = NOW()
            WHERE user_id = ${req.params.userId}
          `;
        }
        const [after] = await tx`
          SELECT user_id, membership_tier, monthly_bonus_points, bonus_cycle_anchor, next_bonus_at, version
          FROM user_point_accounts WHERE user_id = ${req.params.userId}
        `;
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "user.membership_adjusted",
          targetType: "user",
          targetId: req.params.userId,
          reason: req.rootMutationReason,
          before,
          after,
          metadata: { changed: before?.membership_tier !== tier },
          tx,
        });
        return after;
      },
    });
    return res.json({ success: true, data });
  } catch (error) {
    const status = Number(error.status) || 500;
    logger[status >= 500 ? "error" : "warn"]("root.membership.adjust.failed", { actorUserId: req.auth.userId, targetUserId: req.params.userId, error: error.message });
    return res.status(status).json({ success: false, code: error.code, message: status >= 500 && process.env.NODE_ENV === "production" ? "Unable to adjust membership" : error.message });
  }
});

export default router;
