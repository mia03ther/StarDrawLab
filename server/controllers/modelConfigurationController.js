import logger from "../configs/logger.js";
import {
  createModel,
  createModelRoute,
  deactivateModel,
  deactivateModelRoute,
  listAvailableModels,
  listModelCatalog,
  listModelRoutes,
  updateModel,
  updateModelRoute,
} from "../services/modelConfigurationService.js";

const sendError = (res, error, event, req) => {
  const databaseConflict = error.code === "23505";
  const status = Number(error.status) || (databaseConflict ? 409 : 500);
  const code = databaseConflict ? "MODEL_CONFIGURATION_CONFLICT" : error.code;
  logger[status >= 500 ? "error" : "warn"](event, { userId: req.auth?.userId, code, error: error.message });
  return res.status(status).json({
    success: false,
    code,
    message: databaseConflict
      ? "A model or route with the same identifier already exists"
      : status >= 500 && process.env.NODE_ENV === "production" ? "Model configuration operation failed" : error.message,
  });
};

export const listAvailableModelsController = async (req, res) => {
  try {
    const rows = await listAvailableModels({ userId: req.auth.userId, outputType: req.query.output_type });
    res.set("Cache-Control", "private, max-age=60");
    return res.json({ success: true, data: rows });
  } catch (error) {
    return sendError(res, error, "models.available.failed", req);
  }
};

export const listRootModelsController = async (req, res) => {
  try { return res.json({ success: true, data: await listModelCatalog({ includeInactive: true }) }); }
  catch (error) { return sendError(res, error, "models.root.list.failed", req); }
};

export const createRootModelController = async (req, res) => {
  try { return res.status(201).json({ success: true, data: await createModel({ actor: req.auth, body: req.body, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "models.root.create.failed", req); }
};

export const updateRootModelController = async (req, res) => {
  try { return res.json({ success: true, data: await updateModel({ actor: req.auth, modelKey: req.params.modelKey, body: req.body, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "models.root.update.failed", req); }
};

export const deactivateRootModelController = async (req, res) => {
  try { return res.json({ success: true, data: await deactivateModel({ actor: req.auth, modelKey: req.params.modelKey, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "models.root.deactivate.failed", req); }
};

export const listRootModelRoutesController = async (req, res) => {
  try { return res.json({ success: true, data: await listModelRoutes({ includeInactive: true }) }); }
  catch (error) { return sendError(res, error, "modelRoutes.root.list.failed", req); }
};

export const createRootModelRouteController = async (req, res) => {
  try { return res.status(201).json({ success: true, data: await createModelRoute({ actor: req.auth, body: req.body, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "modelRoutes.root.create.failed", req); }
};

export const updateRootModelRouteController = async (req, res) => {
  try { return res.json({ success: true, data: await updateModelRoute({ actor: req.auth, routeId: req.params.routeId, body: req.body, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "modelRoutes.root.update.failed", req); }
};

export const deactivateRootModelRouteController = async (req, res) => {
  try { return res.json({ success: true, data: await deactivateModelRoute({ actor: req.auth, routeId: req.params.routeId, req, reason: req.modelChangeReason }) }); }
  catch (error) { return sendError(res, error, "modelRoutes.root.deactivate.failed", req); }
};
