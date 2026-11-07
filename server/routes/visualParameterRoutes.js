import express from "express";
import {
  createAdminVisualParameterController,
  deactivateAdminVisualParameterController,
  listAdminVisualParametersController,
  listPublicVisualParametersController,
  updateAdminVisualParameterController,
} from "../controllers/visualParameterController.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";

export const publicVisualParameterRouter = express.Router();
publicVisualParameterRouter.get("/", listPublicVisualParametersController);

export const adminVisualParameterRouter = express.Router();
const requireVisualParameterManagement = requirePermission(PERMISSIONS.VISUAL_PARAMETER_MANAGE);

const requireMutationContext = (req, res, next) => {
  const idempotencyKey = String(req.headers["x-idempotency-key"] || "").trim();
  const reason = String(req.body?.reason || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
    return res.status(400).json({ success: false, code: "INVALID_IDEMPOTENCY_KEY", message: "A valid X-Idempotency-Key header is required" });
  }
  if (!reason || reason.length > 2000) {
    return res.status(400).json({ success: false, code: "REASON_REQUIRED", message: "reason is required" });
  }
  req.visualParameterReason = reason;
  return next();
};

adminVisualParameterRouter.get("/", requireVisualParameterManagement, listAdminVisualParametersController);
adminVisualParameterRouter.post("/", requireVisualParameterManagement, requireMutationContext, createAdminVisualParameterController);
adminVisualParameterRouter.patch("/:id", requireVisualParameterManagement, requireMutationContext, updateAdminVisualParameterController);
adminVisualParameterRouter.delete("/:id", requireVisualParameterManagement, requireMutationContext, deactivateAdminVisualParameterController);
