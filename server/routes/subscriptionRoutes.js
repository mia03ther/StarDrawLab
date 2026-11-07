import express from "express";
import {
  alipayNotify,
  cancelRenewal,
  createOrder,
  getOrder,
  getOverview,
  getPlans,
  startPeriodicAgreement,
} from "../controllers/subscriptionController.js";

const subscriptionRouter = express.Router();

subscriptionRouter.get("/plans", getPlans);
subscriptionRouter.get("/overview", getOverview);
subscriptionRouter.post("/orders", createOrder);
subscriptionRouter.get("/orders/:orderNo", getOrder);
subscriptionRouter.post("/cancel-renewal", cancelRenewal);
subscriptionRouter.post("/periodic-agreement", startPeriodicAgreement);

export const publicSubscriptionRouter = express.Router();
publicSubscriptionRouter.post("/alipay/notify", express.urlencoded({ extended: false }), alipayNotify);

export default subscriptionRouter;
