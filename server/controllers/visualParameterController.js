import logger from "../configs/logger.js";
import {
  createVisualParameterOption,
  deactivateVisualParameterOption,
  listVisualParameterCatalog,
  updateVisualParameterOption,
} from "../services/visualParameterService.js";

const sendError = (res, error, event, req) => {
  const status = Number(error.status) || (error.code === "23505" ? 409 : 500);
  logger[status >= 500 ? "error" : "warn"](event, {
    userId: req.auth?.userId,
    code: error.code,
    error: error.message,
  });
  return res.status(status).json({
    success: false,
    code: error.code || "VISUAL_PARAMETER_REQUEST_FAILED",
    message: status >= 500 && process.env.NODE_ENV === "production" ? "Visual parameter operation failed" : error.message,
  });
};

export const listPublicVisualParametersController = async (req, res) => {
  try {
    const data = await listVisualParameterCatalog({ allowFallback: true });
    res.set("Cache-Control", "private, max-age=60");
    return res.json({ success: true, data });
  } catch (error) {
    return sendError(res, error, "visualParameters.public.list.failed", req);
  }
};

export const listAdminVisualParametersController = async (req, res) => {
  try { return res.json({ success: true, data: await listVisualParameterCatalog({ includeInactive: true }) }); }
  catch (error) { return sendError(res, error, "visualParameters.admin.list.failed", req); }
};

export const createAdminVisualParameterController = async (req, res) => {
  try {
    return res.status(201).json({
      success: true,
      data: await createVisualParameterOption({ actor: req.auth, body: req.body, req, reason: req.visualParameterReason }),
    });
  } catch (error) { return sendError(res, error, "visualParameters.admin.create.failed", req); }
};

export const updateAdminVisualParameterController = async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await updateVisualParameterOption({ actor: req.auth, id: req.params.id, body: req.body, req, reason: req.visualParameterReason }),
    });
  } catch (error) { return sendError(res, error, "visualParameters.admin.update.failed", req); }
};

export const deactivateAdminVisualParameterController = async (req, res) => {
  try {
    return res.json({
      success: true,
      data: await deactivateVisualParameterOption({ actor: req.auth, id: req.params.id, req, reason: req.visualParameterReason }),
    });
  } catch (error) { return sendError(res, error, "visualParameters.admin.deactivate.failed", req); }
};
