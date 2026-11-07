import express from "express";
import logger from "../configs/logger.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import { reviewPrivateContent } from "../services/privateContentReviewService.js";

const router = express.Router();

router.post("/private-content-review", requirePermission(PERMISSIONS.PRIVATE_CONTENT_REVIEW), async (req, res) => {
  try {
    const data = await reviewPrivateContent({
      actor: req.auth,
      ownerUserId: req.body?.owner_user_id,
      resourceType: req.body?.resource_type,
      resourceId: req.body?.resource_id,
      reason: req.body?.reason,
      req,
    });
    res.set("Cache-Control", "no-store");
    return res.json({ success: true, data });
  } catch (error) {
    const status = Number(error.status) || 500;
    logger[status >= 500 ? "error" : "warn"]("privateContent.review.failed", {
      actorUserId: req.auth?.userId,
      code: error.code,
      error: error.message,
    });
    return res.status(status).json({
      success: false,
      code: error.code,
      message: status >= 500 && process.env.NODE_ENV === "production" ? "Private content review failed" : error.message,
    });
  }
});

export default router;
