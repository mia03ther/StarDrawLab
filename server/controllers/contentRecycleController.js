import logger from "../configs/logger.js";
import {
  approveAdministrativeRestore,
  deleteContentAsAdministrator,
  deleteOwnContent,
  listAdministrativeRecycleBin,
  listOwnContentNotifications,
  listOwnRecycleBin,
  markOwnContentNotificationRead,
  permanentlyDeleteAdministrativeContent,
  rejectAdministrativeRestore,
  requestAdministrativeRestore,
  restoreOwnContent,
} from "../services/contentRecycleService.js";

const requestRole = (req) => String(
  req.authz?.role
  || req.authorizationContext?.role
  || req.auth?.role
  || "user",
).trim().toLowerCase();

const pagination = (req) => ({
  limit: Math.min(100, Math.max(1, Number.parseInt(req.query.limit || "50", 10) || 50)),
  offset: Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0),
});

const sendError = (res, error, event, req) => {
  const status = Number(error?.status) || 500;
  logger[status >= 500 ? "error" : "warn"](event, {
    userId: req.auth?.userId,
    code: error?.code,
    error: error?.message,
  });
  return res.status(status).json({
    success: false,
    code: error?.code || "CONTENT_RECYCLE_FAILED",
    message: status >= 500 && process.env.NODE_ENV === "production"
      ? "Content recycle operation failed"
      : error?.message || "Content recycle operation failed",
    ...(error?.details ? { details: error.details } : {}),
  });
};

export const deleteOwnContentController = async (req, res) => {
  try {
    const data = await deleteOwnContent({
      userId: req.auth.userId,
      resourceType: req.params.resourceType,
      resourceId: req.params.resourceId,
      reason: req.body?.reason,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.deleteOwn.failed", req);
  }
};

export const listOwnRecycleBinController = async (req, res) => {
  try {
    const data = await listOwnRecycleBin({ userId: req.auth.userId, ...pagination(req) });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.listOwn.failed", req);
  }
};

export const restoreOwnContentController = async (req, res) => {
  try {
    const data = await restoreOwnContent({
      userId: req.auth.userId,
      entryId: req.params.entryId,
      idempotencyKey: req.headers["x-idempotency-key"],
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.restoreOwn.failed", req);
  }
};

export const listOwnContentNotificationsController = async (req, res) => {
  try {
    const data = await listOwnContentNotifications({ userId: req.auth.userId, ...pagination(req) });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.notifications.list.failed", req);
  }
};

export const markOwnContentNotificationReadController = async (req, res) => {
  try {
    const data = await markOwnContentNotificationRead({
      userId: req.auth.userId,
      notificationId: req.params.notificationId,
      idempotencyKey: req.headers["x-idempotency-key"],
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.notifications.read.failed", req);
  }
};

export const adminDeleteUserContentController = async (req, res) => {
  try {
    const data = await deleteContentAsAdministrator({
      actorUserId: req.auth.userId,
      actorRole: requestRole(req),
      ownerUserId: req.params.ownerUserId,
      resourceType: req.params.resourceType,
      resourceId: req.params.resourceId,
      reason: req.body?.reason,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.adminDelete.failed", req);
  }
};

export const listAdminRecycleBinController = async (req, res) => {
  try {
    const data = await listAdministrativeRecycleBin({
      actorRole: requestRole(req),
      ...pagination(req),
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.adminList.failed", req);
  }
};

export const requestAdminRestoreController = async (req, res) => {
  try {
    const data = await requestAdministrativeRestore({
      actorUserId: req.auth.userId,
      actorRole: requestRole(req),
      entryId: req.params.entryId,
      reason: req.body?.reason,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.restoreRequest.failed", req);
  }
};

export const rootApproveRestoreController = async (req, res) => {
  try {
    const data = await approveAdministrativeRestore({
      rootUserId: req.auth.userId,
      actorRole: requestRole(req),
      requestId: req.params.requestId,
      note: req.body?.note,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.rootApproveRestore.failed", req);
  }
};

export const rootRejectRestoreController = async (req, res) => {
  try {
    const data = await rejectAdministrativeRestore({
      rootUserId: req.auth.userId,
      actorRole: requestRole(req),
      requestId: req.params.requestId,
      note: req.body?.note,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.rootRejectRestore.failed", req);
  }
};

export const rootPermanentlyDeleteController = async (req, res) => {
  try {
    if (String(req.body?.confirmation || "") !== "PERMANENT_DELETE") {
      return res.status(400).json({
        success: false,
        code: "PERMANENT_DELETE_CONFIRMATION_REQUIRED",
        message: "Type PERMANENT_DELETE to confirm",
      });
    }
    const data = await permanentlyDeleteAdministrativeContent({
      rootUserId: req.auth.userId,
      actorRole: requestRole(req),
      entryId: req.params.entryId,
      idempotencyKey: req.headers["x-idempotency-key"],
      req,
    });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "contentRecycle.rootPermanentDelete.failed", req);
  }
};
