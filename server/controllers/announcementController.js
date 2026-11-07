import logger from "../configs/logger.js";
import { writeAuditLog } from "../services/auditService.js";
import { executeAdministratorOperation } from "../services/administratorOperationService.js";
import {
  createAnnouncementTx,
  deleteAnnouncementTx,
  listAnnouncements,
  listPublishedAnnouncements,
  updateAnnouncementTx,
} from "../services/announcementService.js";

const sendError = (res, error, event = "announcement.request.failed") => {
  logger[Number(error?.status) >= 500 ? "error" : "warn"](event, {
    code: error?.code,
    error: error?.message,
  });
  return res.status(Number(error?.status) || 500).json({
    success: false,
    code: error?.code || "ANNOUNCEMENT_REQUEST_FAILED",
    message: error?.message || "Announcement request failed",
  });
};

export const getAnnouncements = async (req, res) => {
  try {
    const data = await listPublishedAnnouncements({ limit: req.query.limit, offset: req.query.offset });
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "announcement.public.list.failed");
  }
};

export const getAdminAnnouncements = async (_req, res) => {
  try {
    return res.json({ success: true, data: await listAnnouncements() });
  } catch (error) {
    return sendError(res, error, "announcement.admin.list.failed");
  }
};

export const createAdminAnnouncement = async (req, res) => {
  try {
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "announcement.created",
      targetType: "announcement",
      targetId: "new",
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const after = await createAnnouncementTx(tx, { actorUserId: req.auth.userId, input: req.body || {} });
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "announcement.created",
          targetType: "announcement",
          targetId: String(after.id),
          reason: String(req.body?.reason || "发布公告").slice(0, 2000),
          after,
          tx,
        });
        return after;
      },
    });
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, "announcement.admin.create.failed");
  }
};

export const updateAdminAnnouncement = async (req, res) => {
  try {
    const id = String(req.params.id);
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "announcement.updated",
      targetType: "announcement",
      targetId: id,
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const { before, after } = await updateAnnouncementTx(tx, { id, input: req.body || {} });
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "announcement.updated",
          targetType: "announcement",
          targetId: String(after.id),
          reason: String(req.body?.reason || "修改公告").slice(0, 2000),
          before,
          after,
          tx,
        });
        return after;
      },
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, "announcement.admin.update.failed");
  }
};

export const deleteAdminAnnouncement = async (req, res) => {
  try {
    const id = String(req.params.id);
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "announcement.deleted",
      targetType: "announcement",
      targetId: id,
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const { before, after } = await deleteAnnouncementTx(tx, { id, actorUserId: req.auth.userId });
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "announcement.deleted",
          targetType: "announcement",
          targetId: String(after.id),
          reason: String(req.body?.reason || "删除公告").slice(0, 2000),
          before,
          after,
          tx,
        });
        return after;
      },
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    return sendError(res, error, "announcement.admin.delete.failed");
  }
};
