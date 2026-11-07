const OSS_PROXY_PREFIXES = ["/oss-proxy/", "/api/proxy/oss/", "/api/proxy/"];
const CACHE_REFRESH_SKEW_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;
const DEFAULT_ASSUMED_TTL_MS = 60_000;

const grantCache = new Map();
const inFlightGrants = new Map();
const cacheVersions = new Map();

const getBaseOrigin = () => {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "https://stardraw.invalid";
};

export const parseOssProxyUrl = (source) => {
  if (typeof source !== "string" || !source.trim()) return null;
  try {
    const parsed = new URL(source.trim(), getBaseOrigin());
    const prefix = OSS_PROXY_PREFIXES.find((candidate) => parsed.pathname.startsWith(candidate));
    if (!prefix) return null;
    let objectKey;
    try { objectKey = decodeURIComponent(parsed.pathname.slice(prefix.length)); } catch { return null; }
    if (!objectKey) return null;
    return { objectKey, process: parsed.searchParams.get("x-oss-process") || null };
  } catch {
    return null;
  }
};

export const isOssProxyUrl = (source) => Boolean(parseOssProxyUrl(source));

const getCacheKey = (source, ownerKey) => {
  const descriptor = parseOssProxyUrl(source);
  if (!descriptor) return null;
  return `${String(ownerKey || "anonymous")}\0${descriptor.objectKey}\0${descriptor.process || ""}`;
};

const bumpCacheVersion = (cacheKey) => {
  const nextVersion = (cacheVersions.get(cacheKey) || 0) + 1;
  cacheVersions.set(cacheKey, nextVersion);
  return nextVersion;
};

const pruneGrantCache = () => {
  const now = Date.now();
  for (const [key, entry] of grantCache) {
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt <= now) grantCache.delete(key);
  }
  while (grantCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = grantCache.keys().next().value;
    if (!oldestKey) break;
    grantCache.delete(oldestKey);
  }
};

export const invalidateOssGrant = (source, ownerKey) => {
  const cacheKey = getCacheKey(source, ownerKey);
  if (!cacheKey) return;
  bumpCacheVersion(cacheKey);
  grantCache.delete(cacheKey);
  inFlightGrants.delete(cacheKey);
};

export const clearOssGrantCache = (ownerKey = null) => {
  if (ownerKey === null || ownerKey === undefined) {
    for (const key of new Set([...grantCache.keys(), ...inFlightGrants.keys()])) bumpCacheVersion(key);
    grantCache.clear();
    inFlightGrants.clear();
    return;
  }
  const prefix = `${String(ownerKey)}\0`;
  for (const key of new Set([...grantCache.keys(), ...inFlightGrants.keys()])) {
    if (!key.startsWith(prefix)) continue;
    bumpCacheVersion(key);
    grantCache.delete(key);
    inFlightGrants.delete(key);
  }
};

export const resolveOssGrant = async ({ source, ownerKey, requestGrant, force = false }) => {
  const descriptor = parseOssProxyUrl(source);
  if (!descriptor) return { url: source || "", expiresAt: Number.POSITIVE_INFINITY, granted: false };
  if (typeof requestGrant !== "function") throw new Error("OSS grant requester is unavailable");

  const cacheKey = getCacheKey(source, ownerKey);
  if (force) invalidateOssGrant(source, ownerKey);
  const now = Date.now();
  const cached = grantCache.get(cacheKey);
  if (cached && (!Number.isFinite(cached.expiresAt) || cached.expiresAt - CACHE_REFRESH_SKEW_MS > now)) return cached;
  const inFlight = inFlightGrants.get(cacheKey);
  if (inFlight) return inFlight;

  const version = cacheVersions.get(cacheKey) || 0;
  const request = Promise.resolve(requestGrant({
    object_key: descriptor.objectKey,
    ...(descriptor.process ? { "x-oss-process": descriptor.process } : {}),
  })).then((payload) => {
    const data = payload?.data ?? payload ?? {};
    const url = typeof data.url === "string" ? data.url.trim() : "";
    if (!url) throw new Error("OSS grant response did not include a URL");
    const ttlSeconds = Number(data.expires_in_seconds);
    const expiresAt = data.expires_in_seconds === null
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(ttlSeconds)
        ? Date.now() + Math.max(1, ttlSeconds) * 1000
        : Date.now() + DEFAULT_ASSUMED_TTL_MS;
    const result = { url, expiresAt, granted: Number.isFinite(expiresAt) };
    if ((cacheVersions.get(cacheKey) || 0) === version) {
      grantCache.delete(cacheKey);
      grantCache.set(cacheKey, result);
      pruneGrantCache();
    }
    return result;
  }).finally(() => {
    if (inFlightGrants.get(cacheKey) === request) inFlightGrants.delete(cacheKey);
  });
  inFlightGrants.set(cacheKey, request);
  return request;
};
