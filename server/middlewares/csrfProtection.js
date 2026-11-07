const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const normalizeOrigins = (origins) => new Set((Array.isArray(origins) ? origins : [])
  .map((origin) => String(origin || "").trim())
  .filter(Boolean));

const deny = (res, reason) => res.status(403).json({
  success: false,
  code: "CSRF_REQUEST_REJECTED",
  message: "Cross-site state-changing request rejected.",
  reason,
});

/**
 * Origin guard for browser requests authenticated with a bearer token.
 *
 * StarDraw does not authenticate API requests with ambient cookies, so a
 * classic synchronizer token would add no protection. This guard blocks a
 * browser from sending an authenticated mutation from another origin while
 * retaining support for non-browser API clients (which do not send Origin or
 * Sec-Fetch-Site). Public OAuth and payment callbacks have no Authorization
 * header and are protected by state/signature validation instead.
 */
export const createCsrfProtection = ({ allowedOrigins = [], production = process.env.NODE_ENV === "production" } = {}) => {
  const allowed = normalizeOrigins(allowedOrigins);

  return (req, res, next) => {
    if (SAFE_METHODS.has(String(req.method || "GET").toUpperCase())) return next();
    if (!/^Bearer\s+\S+/i.test(String(req.headers?.authorization || ""))) return next();

    const fetchSite = String(req.headers?.["sec-fetch-site"] || "").trim().toLowerCase();
    if (fetchSite === "cross-site") return deny(res, "cross_site_fetch");

    const origin = String(req.headers?.origin || "").trim();
    if (origin && !allowed.has(origin)) return deny(res, "origin_not_allowed");

    // Production browser navigations normally provide at least Origin or
    // Sec-Fetch-Site. Headerless requests remain valid for CLI/server clients.
    if (production && fetchSite && !new Set(["same-origin", "same-site", "none"]).has(fetchSite)) {
      return deny(res, "fetch_metadata_not_allowed");
    }
    return next();
  };
};

