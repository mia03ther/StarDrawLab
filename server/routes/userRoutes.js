import express from "express";
import {
  getUserProfile,
  updateUserProfile,
  uploadUserAvatar,
  getUserCreations,
  downloadSingle,
  batchDownload,
  exportCSV,
  deleteFailedCreation,
} from "../controllers/userController.js";
import {
  changeIdentityPasswordController,
  getIdentityAccountController,
  updateIdentityAccountController,
} from "../controllers/identityAccountController.js";
import { upload } from "../configs/multer.js";

const userRouter = express.Router();

const requireIdempotencyKey = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) {
    return res.status(400).json({
      success: false,
      code: "IDEMPOTENCY_KEY_REQUIRED",
      message: "A valid X-Idempotency-Key header is required",
    });
  }
  return next();
};

userRouter.get("/profile", getUserProfile);
userRouter.patch("/profile", updateUserProfile);
userRouter.get("/identity/account", getIdentityAccountController);
userRouter.patch("/identity/account", updateIdentityAccountController);
userRouter.post("/identity/password", changeIdentityPasswordController);
userRouter.post("/profile/avatar", requireIdempotencyKey, upload.single("avatar"), uploadUserAvatar);
userRouter.get("/get-user-creations", getUserCreations);
userRouter.get("/creations/:creationId/download", downloadSingle);
userRouter.delete("/creations/:creationId/failed", requireIdempotencyKey, deleteFailedCreation);
userRouter.post("/creations/download/batch", batchDownload);
userRouter.get("/creations/export/csv", exportCSV);

export default userRouter;
