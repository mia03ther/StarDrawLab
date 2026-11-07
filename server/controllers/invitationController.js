import logger from "../configs/logger.js";
import { writeAuditLog } from "../services/auditService.js";
import { executeAdministratorOperation } from "../services/administratorOperationService.js";
import { executeUserOperation } from "../services/userOperationService.js";
import {
  claimInvitationTx,
  createCommonInvitationTx,
  getInvitationOverview,
  getInvitationSettings,
  listCommonInvitations,
  regenerateCommonInvitationTx,
  regeneratePersonalInvitationTx,
  revokeCommonInvitationTx,
  updateInvitationSettingsTx,
} from "../services/invitationService.js";

const appBaseUrl = () => process.env.APP_BASE_URL || "";
const sendError = (res, error, fallbackCode = "INVITATION_REQUEST_FAILED") => {
  logger.error("invitation.request.failed", { code: error.code, error: error.message });
  return res.status(Number(error.status) || 500).json({
    success: false,
    code: error.code || fallbackCode,
    message: error.message,
  });
};

export const getMyInvitation = async (req, res) => {
  try {
    res.json({ success: true, data: await getInvitationOverview(req.auth.userId, appBaseUrl()) });
  } catch (error) {
    sendError(res, error);
  }
};

export const regenerateMyInvitation = async (req, res) => {
  try {
    const result = await executeUserOperation({
      userId: req.auth.userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.personal_regenerated",
      targetType: "invitation_code",
      targetId: req.auth.userId,
      requestPayload: {},
      mutate: async (tx) => ({
        code: (await regeneratePersonalInvitationTx(tx, req.auth.userId)),
      }),
    });
    res.json({ success: true, data: { ...result, code: { ...result.code, link: `${appBaseUrl().replace(/\/+$/, "")}/invite?code=${encodeURIComponent(result.code.code)}` } } });
  } catch (error) {
    sendError(res, error);
  }
};

export const claimInvitation = async (req, res) => {
  try {
    const code = req.body?.code;
    const result = await executeUserOperation({
      userId: req.auth.userId,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.claimed",
      targetType: "invitation_code",
      targetId: String(code || "").trim().slice(0, 255) || "unknown",
      requestPayload: { code },
      mutate: (tx) => claimInvitationTx(tx, { userId: req.auth.userId, rawCode: code }),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

export const getAdminInvitationSettings = async (_req, res) => {
  try {
    res.json({ success: true, data: await getInvitationSettings() });
  } catch (error) {
    sendError(res, error);
  }
};

export const updateAdminInvitationSettings = async (req, res) => {
  try {
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.settings_updated",
      targetType: "invitation_settings",
      targetId: "1",
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const [before] = await tx`
          SELECT id, inviter_reward_points, invitee_reward_points,
                 reward_validity_days, is_enabled
          FROM invitation_settings WHERE id = 1 FOR UPDATE
        `;
        const after = await updateInvitationSettingsTx(tx, req.body || {});
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "invitation.settings_updated",
          targetType: "invitation_settings",
          targetId: "1",
          reason: String(req.body?.reason || "邀请系统配置更新").slice(0, 2000),
          before,
          after,
          tx,
        });
        return after;
      },
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

export const getAdminCommonInvitations = async (_req, res) => {
  try {
    res.json({ success: true, data: await listCommonInvitations(appBaseUrl()) });
  } catch (error) {
    sendError(res, error);
  }
};

export const createAdminCommonInvitation = async (req, res) => {
  try {
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.common_created",
      targetType: "invitation_code",
      targetId: "common",
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const code = await createCommonInvitationTx(tx, req.auth.userId);
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "invitation.common_created",
          targetType: "invitation_code",
          targetId: String(code.id),
          reason: String(req.body?.reason || "生成通用邀请链接").slice(0, 2000),
          after: code,
          tx,
        });
        return code;
      },
    });
    res.json({ success: true, data: { ...result, link: `${appBaseUrl().replace(/\/+$/, "")}/invite?code=${encodeURIComponent(result.code)}` } });
  } catch (error) {
    sendError(res, error);
  }
};

export const deleteAdminCommonInvitation = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, Object.assign(new Error("Invitation link id is invalid"), { status: 400, code: "INVALID_INVITATION_LINK_ID" }));
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.common_revoked",
      targetType: "invitation_code",
      targetId: String(id),
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const after = await revokeCommonInvitationTx(tx, id);
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "invitation.common_revoked",
          targetType: "invitation_code",
          targetId: String(id),
          reason: String(req.body?.reason || "撤销通用邀请链接").slice(0, 2000),
          after,
          tx,
        });
        return after;
      },
    });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
};

export const regenerateAdminCommonInvitation = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, Object.assign(new Error("Invitation link id is invalid"), { status: 400, code: "INVALID_INVITATION_LINK_ID" }));
    const result = await executeAdministratorOperation({
      actor: req.auth,
      idempotencyKey: req.headers["x-idempotency-key"],
      action: "invitation.common_regenerated",
      targetType: "invitation_code",
      targetId: String(id),
      requestPayload: req.body || {},
      mutate: async (tx) => {
        const code = await regenerateCommonInvitationTx(tx, id, req.auth.userId);
        await writeAuditLog({
          req,
          actorUserId: req.auth.userId,
          actorRole: req.auth.role,
          action: "invitation.common_regenerated",
          targetType: "invitation_code",
          targetId: String(code.id),
          reason: String(req.body?.reason || "重新生成通用邀请链接").slice(0, 2000),
          after: code,
          tx,
        });
        return code;
      },
    });
    res.json({ success: true, data: { ...result, link: `${appBaseUrl().replace(/\/+$/, "")}/invite?code=${encodeURIComponent(result.code)}` } });
  } catch (error) {
    sendError(res, error);
  }
};
