import express from "express";
import {
  adminDeleteUserContentController,
  deleteOwnContentController,
  listAdminRecycleBinController,
  listOwnContentNotificationsController,
  listOwnRecycleBinController,
  markOwnContentNotificationReadController,
  requestAdminRestoreController,
  restoreOwnContentController,
  rootApproveRestoreController,
  rootPermanentlyDeleteController,
  rootRejectRestoreController,
} from "../controllers/contentRecycleController.js";

const roleFromDatabaseAuthorization = (req) => String(
  req.authz?.role
  || req.authorizationContext?.role
  || req.auth?.role
  || "user",
).trim().toLowerCase();

const requireDatabaseRole = (...allowedRoles) => (req, res, next) => {
  const role = roleFromDatabaseAuthorization(req);
  if (!allowedRoles.includes(role)) {
    return res.status(403).json({
      success: false,
      code: "FORBIDDEN",
      message: "Insufficient content-management permission",
    });
  }
  return next();
};

const requireIdempotencyKey = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) {
    return res.status(400).json({
      success: false,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid X-Idempotency-Key header is required",
    });
  }
  return next();
};

// Mount after authentication and the database-backed authorization-context
// middleware. Suggested mount point: /api/content.
export const userContentRecycleRouter = express.Router();
userContentRecycleRouter.get("/recycle-bin", listOwnRecycleBinController);
userContentRecycleRouter.post(
  "/recycle-bin/:entryId/restore",
  requireIdempotencyKey,
  restoreOwnContentController,
);
userContentRecycleRouter.get("/notifications", listOwnContentNotificationsController);
userContentRecycleRouter.post(
  "/notifications/:notificationId/read",
  requireIdempotencyKey,
  markOwnContentNotificationReadController,
);
userContentRecycleRouter.delete(
  "/:resourceType/:resourceId",
  requireIdempotencyKey,
  deleteOwnContentController,
);

// Suggested mount point: /api/admin/content. The middleware intentionally
// ignores JWT role claims and static admin keys; a preceding database-backed
// authorization middleware must populate req.authz.role (or the documented
// compatibility property req.authorizationContext.role / req.auth.role).
export const adminContentRecycleRouter = express.Router();
adminContentRecycleRouter.use(requireDatabaseRole("admin", "root"));
adminContentRecycleRouter.get("/recycle-bin", listAdminRecycleBinController);
adminContentRecycleRouter.post(
  "/recycle-bin/:entryId/restore-requests",
  requireIdempotencyKey,
  requestAdminRestoreController,
);
adminContentRecycleRouter.delete(
  "/users/:ownerUserId/:resourceType/:resourceId",
  requireIdempotencyKey,
  adminDeleteUserContentController,
);

// Suggested mount point: /api/root/content. Authentication and database-backed
// root authorization are applied upstream. Permanent deletion still requires
// the explicit PERMANENT_DELETE confirmation checked by the controller.
export const rootContentRecycleRouter = express.Router();
rootContentRecycleRouter.use(requireDatabaseRole("root"));
rootContentRecycleRouter.get("/recycle-bin", listAdminRecycleBinController);
rootContentRecycleRouter.post(
  "/restore-requests/:requestId/approve",
  requireIdempotencyKey,
  rootApproveRestoreController,
);
rootContentRecycleRouter.post(
  "/restore-requests/:requestId/reject",
  requireIdempotencyKey,
  rootRejectRestoreController,
);
rootContentRecycleRouter.delete(
  "/recycle-bin/:entryId/permanent",
  requireIdempotencyKey,
  rootPermanentlyDeleteController,
);

export default userContentRecycleRouter;
