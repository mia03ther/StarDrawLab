const flag = (value, fallback) => {
  if (value == null || String(value).trim() === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw Object.assign(new Error("Database TLS flag is invalid"), { code: "INVALID_DATABASE_TLS_CONFIGURATION" });
};

export const resolveDatabaseSsl = (env = process.env) => {
  if (!flag(env.DB_SSL, true)) return false;
  const rejectUnauthorized = flag(env.DB_SSL_VERIFY, true);
  const ca = String(env.DB_SSL_CA || "").trim();
  return {
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
  };
};
