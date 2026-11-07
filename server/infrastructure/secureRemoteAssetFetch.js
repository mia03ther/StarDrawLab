import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";

import { classifyIp } from "../services/mcpSecurityService.js";

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });
const normalizeHost = (value) => String(value || "").trim().toLowerCase().replace(/\.$/, "");

const parsePositiveInteger = (value, fallback, maximum) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
};

const configuredProviderHosts = (env) => [
  env.IMAGE_PROVIDER_BASE_URL,
  env.SORA_BASE_URL,
  env.HEYGEN_BASE_URL,
].flatMap((value) => {
  try {
    return value ? [new URL(value).hostname] : [];
  } catch {
    return [];
  }
});

export const readRemoteAssetPolicy = (env = process.env) => ({
  allowedHosts: [
    ...String(env.REMOTE_ASSET_ALLOWED_HOSTS || "").split(","),
    ...configuredProviderHosts(env),
  ].map(normalizeHost).filter(Boolean),
  maxBytes: parsePositiveInteger(env.REMOTE_ASSET_MAX_BYTES, 512 * 1024 * 1024, 2 * 1024 * 1024 * 1024),
  timeoutMs: parsePositiveInteger(env.REMOTE_ASSET_TIMEOUT_MS, 120_000, 300_000),
  maxRedirects: parsePositiveInteger(env.REMOTE_ASSET_MAX_REDIRECTS, 3, 5),
  requireAllowlist: String(env.NODE_ENV || "").toLowerCase() === "production",
});

const hostMatches = (hostname, pattern) => pattern.startsWith("*.")
  ? hostname === pattern.slice(2) || hostname.endsWith(`.${pattern.slice(2)}`)
  : hostname === pattern;

export const validateRemoteAssetUrl = (value, policy = readRemoteAssetPolicy()) => {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw fail("Remote asset URL is invalid", "REMOTE_ASSET_URL_INVALID");
  }
  if (url.protocol !== "https:") throw fail("Remote assets must use HTTPS", "REMOTE_ASSET_HTTPS_REQUIRED");
  if (url.username || url.password || url.hash || url.hostname.length > 253) {
    throw fail("Remote asset URL contains unsupported credentials or fragments", "REMOTE_ASSET_URL_UNSAFE");
  }
  const hostname = normalizeHost(url.hostname);
  const ipClass = classifyIp(hostname);
  if (ipClass !== "hostname" && ipClass !== "public") {
    throw fail("Remote asset target is private or local", "REMOTE_ASSET_SSRF_BLOCKED");
  }
  const allowlist = Array.isArray(policy.allowedHosts) ? policy.allowedHosts.map(normalizeHost).filter(Boolean) : [];
  if (policy.requireAllowlist && allowlist.length === 0) {
    throw fail("Remote asset host allowlist is not configured", "REMOTE_ASSET_ALLOWLIST_MISSING", 503);
  }
  if (allowlist.length > 0 && !allowlist.some((pattern) => hostMatches(hostname, pattern))) {
    throw fail("Remote asset host is not allowed", "REMOTE_ASSET_HOST_NOT_ALLOWED", 403);
  }
  return url;
};

export const createPinnedPublicLookup = ({ policy, lookup = dns.lookup } = {}) =>
  (hostname, options, callback) => {
    let parsed;
    try {
      parsed = validateRemoteAssetUrl(`https://${hostname}`, policy);
    } catch (error) {
      callback(error);
      return;
    }
    const ipClass = classifyIp(parsed.hostname);
    if (ipClass === "public") {
      callback(null, parsed.hostname, ipClass === "public" && parsed.hostname.includes(":") ? 6 : 4);
      return;
    }
    lookup(parsed.hostname, { all: true, verbatim: true }).then((addresses) => {
      if (!Array.isArray(addresses) || addresses.length === 0) {
        throw fail("Remote asset host has no DNS address", "REMOTE_ASSET_DNS_EMPTY", 503);
      }
      if (addresses.some((entry) => classifyIp(entry.address) !== "public")) {
        throw fail("Remote asset DNS resolves to a private or local address", "REMOTE_ASSET_SSRF_BLOCKED");
      }
      if (options?.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch((error) => callback(
      error.code ? error : fail("Remote asset DNS lookup failed", "REMOTE_ASSET_DNS_LOOKUP_FAILED", 503),
    ));
  };

export const createByteLimitedStream = (source, maxBytes) => {
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        const error = fail("Remote asset exceeds the configured size limit", "REMOTE_ASSET_TOO_LARGE", 413);
        if (typeof source.destroy === "function") source.destroy();
        callback(error);
        return;
      }
      callback(null, chunk);
    },
  });
  source.pipe(limiter);
  return limiter;
};

export const fetchRemoteAssetStream = async ({ remoteUrl, httpClient, policy = readRemoteAssetPolicy() }) => {
  const initialUrl = validateRemoteAssetUrl(remoteUrl, policy);
  const lookup = createPinnedPublicLookup({ policy });
  const validateRedirect = (options) => {
    const hostname = options.hostname || options.host;
    validateRemoteAssetUrl(`${options.protocol || "https:"}//${hostname}${options.path || "/"}`, policy);
  };
  const response = await httpClient.get(initialUrl.toString(), {
    responseType: "stream",
    timeout: policy.timeoutMs,
    maxRedirects: policy.maxRedirects,
    maxContentLength: policy.maxBytes,
    maxBodyLength: policy.maxBytes,
    httpAgent: new http.Agent({ lookup }),
    httpsAgent: new https.Agent({ lookup }),
    beforeRedirect: validateRedirect,
    validateStatus: (status) => status >= 200 && status < 300,
  });
  const contentLength = Number(response.headers?.["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > policy.maxBytes) {
    response.data?.destroy?.();
    throw fail("Remote asset exceeds the configured size limit", "REMOTE_ASSET_TOO_LARGE", 413);
  }
  const responseType = String(response.headers?.["content-type"] || "").toLowerCase();
  if (responseType.startsWith("text/") || responseType.includes("json") || responseType.includes("xml")) {
    response.data?.destroy?.();
    throw fail("Remote asset response is not media", "REMOTE_ASSET_CONTENT_TYPE_INVALID", 502);
  }
  return {
    stream: createByteLimitedStream(response.data, policy.maxBytes),
    contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
    sourceHost: initialUrl.host,
  };
};
