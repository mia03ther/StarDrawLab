import express from "express";
import {
  createRootModelController,
  createRootModelRouteController,
  deactivateRootModelController,
  deactivateRootModelRouteController,
  listRootModelsController,
  listRootModelRoutesController,
  updateRootModelController,
  updateRootModelRouteController,
} from "../controllers/modelConfigurationController.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";

const router = express.Router();
const requireModelManagement = requirePermission(PERMISSIONS.MODEL_MANAGE);

const requireMutationContext = (req, res, next) => {
  const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return res.status(400).json({ success: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: "A valid X-Idempotency-Key header is required" });
  }
  if (!reason) {
    return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: "reason is required" });
  }
  req.modelChangeReason = reason.slice(0, 2000);
  return next();
};

router.get("/models", requireModelManagement, listRootModelsController);
router.post("/models", requireModelManagement, requireMutationContext, createRootModelController);
router.patch("/models/:modelKey", requireModelManagement, requireMutationContext, updateRootModelController);
router.delete("/models/:modelKey", requireModelManagement, requireMutationContext, deactivateRootModelController);
router.get("/model-routes", requireModelManagement, listRootModelRoutesController);
router.post("/model-routes", requireModelManagement, requireMutationContext, createRootModelRouteController);
router.patch("/model-routes/:routeId", requireModelManagement, requireMutationContext, updateRootModelRouteController);
router.delete("/model-routes/:routeId", requireModelManagement, requireMutationContext, deactivateRootModelRouteController);

export default router;
