import express from "express";
import { getAnnouncements } from "../controllers/announcementController.js";

const announcementRouter = express.Router();

announcementRouter.get("/", getAnnouncements);

export default announcementRouter;
