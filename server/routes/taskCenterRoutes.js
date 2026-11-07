import express from "express";
import { cancelTask, listTasks, streamTasks } from "../controllers/taskCenterController.js";

const requireIdempotencyKey = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!key || key.length > 128) {
    return res.status(400).json({
      success: false,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "X-Idempotency-Key header is required",
    });
  }
  return next();
};

const router = express.Router();

router.get("/", listTasks);
router.get("/events", streamTasks);
router.post("/:taskId/cancel", requireIdempotencyKey, cancelTask);

export default router;
