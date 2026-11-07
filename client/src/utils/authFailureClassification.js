const IDENTITY_ACCOUNT_AUTHORIZATION_CODES = new Set([
  "IDENTITY_ACCOUNT_UNAUTHORIZED",
  "IDENTITY_ACCOUNT_FORBIDDEN",
  "IDENTITY_ACCOUNT_TOKEN_MISSING",
]);

export const shouldInvalidateSession = ({ status, code } = {}) => {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (normalizedCode === "SESSION_REVOKED") return true;
  if (IDENTITY_ACCOUNT_AUTHORIZATION_CODES.has(normalizedCode)) return false;
  return Number(status) === 401;
};
