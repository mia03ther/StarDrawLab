import express from "express";
import {
  getBalance,
  getPackages,
  createOrder,
  getOrder,
  confirmOrder,
  getLedger,
} from "../controllers/pointsController.js";

const pointsRouter = express.Router();

pointsRouter.get("/balance", getBalance);
pointsRouter.get("/packages", getPackages);
pointsRouter.post("/orders", createOrder);
pointsRouter.get("/orders/:orderNo", getOrder);
pointsRouter.post("/orders/:orderNo/confirm", confirmOrder);
pointsRouter.get("/ledger", getLedger);

export default pointsRouter;
