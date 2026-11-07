import logger from "../configs/logger.js";
import {
  getDeletionStatus,
  requestAccountDeletion,
  restoreAccount,
} from "../services/accountDeletionService.js";

export const deletionStatus = async (req, res) => {
  try {
    res.json({ success: true, data: await getDeletionStatus(req.auth.userId) });
  } catch (error) {
    logger.error("accountDeletion.status.error", { userId: req.auth?.userId, error: error.message });
    res.status(500).json({ success: false, message: "Unable to load account deletion status" });
  }
};

export const deleteAccount = async (req, res) => {
  try {
    const result = await requestAccountDeletion({
      userId: req.auth.userId,
      confirmation: req.body?.confirmation,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error("accountDeletion.request.error", { userId: req.auth?.userId, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
};

export const restoreDeletedAccount = async (req, res) => {
  try {
    res.json({ success: true, data: await restoreAccount(req.auth.userId) });
  } catch (error) {
    logger.error("accountDeletion.restore.error", { userId: req.auth?.userId, code: error.code, error: error.message });
    res.status(error.status || 500).json({ success: false, code: error.code, message: error.message });
  }
};

