import express from "express";
import sql from "../configs/db.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import {
  executeAdministratorOperation,
  normalizeAdministratorIdempotencyKey,
  normalizeAdministratorReason,
} from "../services/administratorOperationService.js";
import {
  listExecutionPolicies,
  updateExecutionPolicy,
} from "../services/executionGovernorConfigurationService.js";

const router = express.Router();

router.get("/execution-policies", requirePermission(PERMISSIONS.EXECUTION_POLICY_MANAGE), async (_req, res) => {
  try {
    return res.json({ success: true, data: await listExecutionPolicies({ db: sql }) });
  } catch (error) {
    return res.status(Number(error.status) || 500).json({ success: false, code: error.code || "EXECUTION_POLICY_LIST_FAILED", message: error.message });
  }
});

router.patch("/execution-policies/:membershipTier/:operationKey", requirePermission(PERMISSIONS.EXECUTION_POLICY_MANAGE), async (req, res) => {
  try {
    const idempotencyKey = normalizeAdministratorIdempotencyKey(req.headers["x-idempotency-key"]);
    const reason = normalizeAdministratorReason(req.body?.reason);
    const targetId = `${req.params.membershipTier}:${req.params.operationKey}`;
    const data = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey,
      action: "execution_policy.updated",
      targetType: "execution_policy",
      targetId,
      requestPayload: req.body,
      mutate: async (tx) => updateExecutionPolicy({
        tx,
        membershipTier: req.params.membershipTier,
        operationKey: req.params.operationKey,
        changes: req.body,
      }),
    });
    return res.json({ success: true, data, reason });
  } catch (error) {
    return res.status(Number(error.status) || 500).json({ success: false, code: error.code || "EXECUTION_POLICY_UPDATE_FAILED", message: error.message });
  }
});

export default router;
