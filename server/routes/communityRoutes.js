import express from "express";
import {
  bootstrap, favorite, featured, getCreation, hide, like, listFeed, ownedState, publish, report, reports, resolveReport, restore, unpublish,
} from "../controllers/communityController.js";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import { communityReadLimiter, communityWriteLimiter } from "../middlewares/rateLimiter.js";

const requireIdempotencyKey = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) return res.status(400).json({ success: false, code: "INVALID_IDEMPOTENCY_KEY", message: "A valid X-Idempotency-Key header is required" });
  return next();
};

export const publicCommunityRouter = express.Router();
publicCommunityRouter.use(communityReadLimiter);
publicCommunityRouter.get("/feed", listFeed);
publicCommunityRouter.get("/bootstrap", bootstrap);
publicCommunityRouter.get("/creations/:creationId", getCreation);

export const communityRouter = express.Router();
communityRouter.get("/feed", communityReadLimiter, listFeed);
communityRouter.get("/creations/:creationId", communityReadLimiter, getCreation);
communityRouter.use(communityWriteLimiter);
communityRouter.post("/creations/:creationId/publish", requireIdempotencyKey, publish);
communityRouter.post("/creations/:creationId/unpublish", requireIdempotencyKey, unpublish);
communityRouter.get("/creations/:creationId/publication", ownedState);
communityRouter.post("/creations/:creationId/like", requireIdempotencyKey, like);
communityRouter.post("/creations/:creationId/favorite", requireIdempotencyKey, favorite);
communityRouter.post("/creations/:creationId/report", requireIdempotencyKey, report);

export const adminCommunityRouter = express.Router();
adminCommunityRouter.use(requirePermission(PERMISSIONS.CONTENT_MODERATE));
adminCommunityRouter.get("/reports", reports);
adminCommunityRouter.post("/reports/:reportId/resolve", requireIdempotencyKey, resolveReport);
adminCommunityRouter.post("/creations/:creationId/hide", requireIdempotencyKey, hide);
adminCommunityRouter.post("/creations/:creationId/restore", requireIdempotencyKey, restore);
adminCommunityRouter.post("/creations/:creationId/featured", requireIdempotencyKey, featured);

export default publicCommunityRouter;
