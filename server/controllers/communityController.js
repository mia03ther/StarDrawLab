import logger from "../configs/logger.js";
import {
  getCommunityBootstrap,
  getOwnedCommunityState,
  getPublicCreation,
  hideCreationAsAdministrator,
  listCommunityReports,
  listPublicCreations,
  publishCreation,
  reportCreation,
  restoreCreationAsAdministrator,
  resolveCommunityReport,
  setCreationFeaturedAsAdministrator,
  setCreationFavorite,
  setCreationLike,
  unpublishCreation,
} from "../services/communityService.js";

const sendError = (res, error, event, req) => {
  const status = Number(error?.status) || 500;
  logger[status >= 500 ? "error" : "warn"](event, { userId: req.auth?.userId || null, code: error?.code, error: error?.message });
  return res.status(status).json({ success: false, code: error?.code || "COMMUNITY_REQUEST_FAILED", message: status >= 500 && process.env.NODE_ENV === "production" ? "Community request failed" : error?.message });
};

const idempotency = (req, res, next) => {
  const key = String(req.headers["x-idempotency-key"] || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(key)) return res.status(400).json({ success: false, code: "INVALID_IDEMPOTENCY_KEY", message: "A valid X-Idempotency-Key header is required" });
  next();
};

export const listFeed = async (req, res) => {
  try {
    const data = await listPublicCreations({ userId: req.auth?.userId || null, cursor: req.query.cursor, limit: req.query.limit, type: req.query.type, sort: req.query.sort, query: req.query.query });
    res.set("Cache-Control", "public, max-age=15, stale-while-revalidate=30");
    return res.json({ success: true, data });
  } catch (error) { return sendError(res, error, "community.feed.failed", req); }
};

export const getCreation = async (req, res) => {
  try {
    const creation = await getPublicCreation({ creationId: req.params.creationId, userId: req.auth?.userId || null });
    if (!creation) return res.status(404).json({ success: false, code: "CREATION_NOT_FOUND", message: "Public creation not found" });
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    return res.json({ success: true, data: creation });
  } catch (error) { return sendError(res, error, "community.creation.failed", req); }
};

export const bootstrap = async (req, res) => {
  try { return res.json({ success: true, data: await getCommunityBootstrap() }); }
  catch (error) { return sendError(res, error, "community.bootstrap.failed", req); }
};

export const publish = async (req, res) => {
  try { return res.json({ success: true, data: await publishCreation({ userId: req.auth.userId, creationId: req.params.creationId, body: req.body, idempotencyKey: req.headers["x-idempotency-key"] }) }); }
  catch (error) { return sendError(res, error, "community.publish.failed", req); }
};

export const unpublish = async (req, res) => {
  try { return res.json({ success: true, data: await unpublishCreation({ userId: req.auth.userId, creationId: req.params.creationId, idempotencyKey: req.headers["x-idempotency-key"] }) }); }
  catch (error) { return sendError(res, error, "community.unpublish.failed", req); }
};

export const ownedState = async (req, res) => {
  try { return res.json({ success: true, data: await getOwnedCommunityState({ userId: req.auth.userId, creationId: req.params.creationId }) }); }
  catch (error) { return sendError(res, error, "community.ownedState.failed", req); }
};

export const like = async (req, res) => {
  try { return res.json({ success: true, data: await setCreationLike({ userId: req.auth.userId, creationId: req.params.creationId, enabled: req.body?.enabled !== false, idempotencyKey: req.headers["x-idempotency-key"] }) }); }
  catch (error) { return sendError(res, error, "community.like.failed", req); }
};

export const favorite = async (req, res) => {
  try { return res.json({ success: true, data: await setCreationFavorite({ userId: req.auth.userId, creationId: req.params.creationId, enabled: req.body?.enabled !== false, idempotencyKey: req.headers["x-idempotency-key"] }) }); }
  catch (error) { return sendError(res, error, "community.favorite.failed", req); }
};

export const report = async (req, res) => {
  try { return res.json({ success: true, data: await reportCreation({ userId: req.auth.userId, creationId: req.params.creationId, reason: req.body?.reason, details: req.body?.details, idempotencyKey: req.headers["x-idempotency-key"] }) }); }
  catch (error) { return sendError(res, error, "community.report.failed", req); }
};

export const hide = async (req, res) => {
  try { return res.json({ success: true, data: await hideCreationAsAdministrator({ actor: req.auth, creationId: req.params.creationId, reason: req.body?.reason, idempotencyKey: req.headers["x-idempotency-key"], req }) }); }
  catch (error) { return sendError(res, error, "community.hide.failed", req); }
};

export const restore = async (req, res) => {
  try { return res.json({ success: true, data: await restoreCreationAsAdministrator({ actor: req.auth, creationId: req.params.creationId, reason: req.body?.reason, idempotencyKey: req.headers["x-idempotency-key"], req }) }); }
  catch (error) { return sendError(res, error, "community.restore.failed", req); }
};

export const featured = async (req, res) => {
  try { return res.json({ success: true, data: await setCreationFeaturedAsAdministrator({ actor: req.auth, creationId: req.params.creationId, featured: req.body?.featured !== false, idempotencyKey: req.headers["x-idempotency-key"], req }) }); }
  catch (error) { return sendError(res, error, "community.featured.failed", req); }
};

export const resolveReport = async (req, res) => {
  try { return res.json({ success: true, data: await resolveCommunityReport({ actor: req.auth, reportId: req.params.reportId, status: req.body?.status, note: req.body?.note, idempotencyKey: req.headers["x-idempotency-key"], req }) }); }
  catch (error) { return sendError(res, error, "community.report.resolve.failed", req); }
};

export const reports = async (req, res) => {
  try { return res.json({ success: true, data: await listCommunityReports({ status: req.query.status, limit: req.query.limit }) }); }
  catch (error) { return sendError(res, error, "community.reports.failed", req); }
};
