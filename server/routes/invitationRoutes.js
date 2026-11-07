import express from "express";
import {
  claimInvitation,
  getMyInvitation,
  regenerateMyInvitation,
} from "../controllers/invitationController.js";

const invitationRouter = express.Router();

invitationRouter.get("/me", getMyInvitation);
invitationRouter.post("/regenerate", regenerateMyInvitation);
invitationRouter.post("/claim", claimInvitation);

export default invitationRouter;
