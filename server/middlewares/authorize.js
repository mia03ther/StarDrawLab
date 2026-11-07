import logger from "../configs/logger.js";
import { hasPermission, ROLES } from "../services/accessControlService.js";

const deny = (res, code, message, status = 403) => res.status(status).json({ success: false, code, message });

export const requireRole = (...allowedRoles) => (req, res, next) => {
  const role = req.auth?.role || ROLES.USER;
  if (allowedRoles.includes(role)) return next();
  logger.warn("access.role.denied", { userId: req.auth?.userId, role, path: req.originalUrl });
  return deny(res, "FORBIDDEN", "Insufficient role.");
};

export const requirePermission = (permission) => (req, res, next) => {
  const role = req.auth?.role || ROLES.USER;
  if (hasPermission(role, permission)) return next();
  logger.warn("access.permission.denied", { userId: req.auth?.userId, role, permission, path: req.originalUrl });
  return deny(res, "FORBIDDEN", "Insufficient permission.");
};

export const requireMfa = () => (req, res, next) => {
  if (req.auth?.mfaVerified) return next();
  logger.warn("access.mfa.required", { userId: req.auth?.userId, role: req.auth?.role, path: req.originalUrl });
  return deny(res, "MFA_REQUIRED", "Multi-factor authentication is required for this operation.");
};

export const requireRoot = () => requireRole(ROLES.ROOT);
export const requireAdminOrRoot = () => requireRole(ROLES.ROOT, ROLES.ADMIN);
