export const resolveTrustProxyHops = (value = process.env.TRUST_PROXY_HOPS) => {
  const raw = value == null ? "2" : String(value).trim();
  const hops = raw ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 4) {
    throw Object.assign(new Error("TRUST_PROXY_HOPS must be an integer from 0 to 4"), {
      code: "INVALID_TRUST_PROXY_CONFIGURATION",
    });
  }
  return hops;
};

export const isMediaProxyReadRequest = (request = {}) => {
  const method = String(request.method || "GET").trim().toUpperCase();
  if (!["GET", "HEAD"].includes(method)) return false;
  const path = String(request.path || request.originalUrl || "").split("?", 1)[0];
  return path.startsWith("/api/proxy/oss/");
};
