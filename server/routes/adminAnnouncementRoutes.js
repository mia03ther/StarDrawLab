import express from "express";
import { requirePermission } from "../middlewares/authorize.js";
import { PERMISSIONS } from "../services/accessControlService.js";
import {
  createAdminAnnouncement,
  deleteAdminAnnouncement,
  getAdminAnnouncements,
  updateAdminAnnouncement,
} from "../controllers/announcementController.js";

const adminAnnouncementRouter = express.Router();
const requireAnnouncementManage = requirePermission(PERMISSIONS.ANNOUNCEMENT_MANAGE);

adminAnnouncementRouter.use(requireAnnouncementManage);
adminAnnouncementRouter.get("/", getAdminAnnouncements);
adminAnnouncementRouter.post("/", createAdminAnnouncement);
adminAnnouncementRouter.put("/:id", updateAdminAnnouncement);
adminAnnouncementRouter.delete("/:id", deleteAdminAnnouncement);

export default adminAnnouncementRouter;
