import express from "express";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import {
  createAdminCommonInvitation,
  deleteAdminCommonInvitation,
  getAdminCommonInvitations,
  getAdminInvitationSettings,
  regenerateAdminCommonInvitation,
  updateAdminInvitationSettings,
} from "../controllers/invitationController.js";

const adminInvitationRouter = express.Router();
const requireInvitationManage = requirePermission(PERMISSIONS.INVITATION_MANAGE);

adminInvitationRouter.use(requireInvitationManage);
adminInvitationRouter.get("/settings", getAdminInvitationSettings);
adminInvitationRouter.put("/settings", updateAdminInvitationSettings);
adminInvitationRouter.get("/common-links", getAdminCommonInvitations);
adminInvitationRouter.post("/common-links", createAdminCommonInvitation);
adminInvitationRouter.delete("/common-links/:id", deleteAdminCommonInvitation);
adminInvitationRouter.post("/common-links/:id/regenerate", regenerateAdminCommonInvitation);

export default adminInvitationRouter;
