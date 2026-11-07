import dns from "node:dns/promises";
import { isIP } from "node:net";

const IPV4_PRIVATE = [
  [/^10\./, "private"],
  [/^127\./, "loopback"],
  [/^169\.254\./, "link_local"],
  [/^172\.(1[6-9]|2\d|3[0-1])\./, "private"],
  [/^192\.168\./, "private"],
  [/^192\.0\.0\./, "reserved"],
  [/^192\.0\.2\./, "documentation"],
  [/^192\.88\.99\./, "reserved"],
  [/^198\.18\./, "benchmark"],
  [/^198\.19\./, "benchmark"],
  [/^198\.51\.100\./, "documentation"],
  [/^203\.0\.113\./, "documentation"],
  [/^22[4-9]\./, "multicast"],
  [/^23[0-9]\./, "multicast"],
  [/^240\./, "reserved"],
  [/^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./, "shared"],
  [/^0\./, "unspecified"],
];

const normalizeHost = (host) => String(host || "").trim().toLowerCase().replace(/\.$/, "");
const stripIpv6Brackets = (host) => normalizeHost(host).replace(/^\[|\]$/g, "");

export const classifyIp = (value) => {
  const ip = stripIpv6Brackets(value);
  if (isIP(ip) === 4) {
    const match = IPV4_PRIVATE.find(([pattern]) => pattern.test(ip));
    return match?.[1] || "public";
  }
  if (isIP(ip) === 6) {
    if (ip.startsWith("::ffff:")) return classifyIp(ip.slice(7));
    if (ip === "::1" || ip === "::") return "loopback";
    if (ip.startsWith("fc") || ip.startsWith("fd")) return "private";
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) return "link_local";
    if (ip.startsWith("fec")) return "reserved";
    if (ip.startsWith("ff")) return "multicast";
    if (ip.startsWith("2001:db8:")) return "documentation";
    return "public";
  }
  return "hostname";
};

export const assertSafeMcpUrl = (value, { production = process.env.NODE_ENV === "production", allowLoopback = false } = {}) => {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw Object.assign(new Error("MCP URL must be valid"), { status: 400, code: "MCP_URL_INVALID" });
  }
  const ipClass = classifyIp(url.hostname);
  const developmentLoopback = allowLoopback && !production && url.protocol === "http:" && ipClass === "loopback";
  if (url.protocol !== "https:" && !developmentLoopback) {
    throw Object.assign(new Error("MCP endpoints must use HTTPS"), { status: 400, code: "MCP_HTTPS_REQUIRED" });
  }
  if (url.username || url.password || url.hash || url.hostname.length > 253) {
    throw Object.assign(new Error("MCP URL contains unsupported credentials or fragment"), { status: 400, code: "MCP_URL_UNSAFE" });
  }
  // allowLoopback is deliberately narrow: only explicit development HTTP
  // loopback is allowed. It must never make HTTPS private targets safe.
  if (!developmentLoopback && ipClass !== "hostname" && ipClass !== "public") {
    throw Object.assign(new Error("MCP endpoint resolves to a private or local address"), { status: 400, code: "MCP_SSRF_BLOCKED" });
  }
  return url;
};

export const assertAllowedMcpHost = (url, allowedDomains = []) => {
  const host = normalizeHost(url.hostname || url);
  const patterns = Array.isArray(allowedDomains) ? allowedDomains.map(normalizeHost).filter(Boolean) : [];
  if (patterns.length === 0) return true;
  const allowed = patterns.some((pattern) => pattern.startsWith("*.")
    ? (host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`))
    : host === pattern);
  if (!allowed) throw Object.assign(new Error("MCP endpoint host is not on the allowlist"), { status: 403, code: "MCP_HOST_NOT_ALLOWED" });
  return true;
};

/** Resolve and retain every validated address so the HTTP layer can pin the connection. */
export const resolveAndPinPublicMcpHost = async (url, options = {}) => {
  const parsed = assertSafeMcpUrl(url, options);
  const literalClass = classifyIp(parsed.hostname);
  if (literalClass !== "hostname") {
    const address = stripIpv6Brackets(parsed.hostname);
    return Object.freeze({
      url: parsed,
      hostname: normalizeHost(parsed.hostname),
      addresses: Object.freeze([Object.freeze({ address, family: isIP(address) })]),
    });
  }
  let addresses;
  try {
    const lookup = options.lookup || dns.lookup;
    addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("MCP endpoint DNS lookup failed"), { status: 503, code: "MCP_DNS_LOOKUP_FAILED" });
  }
  if (!addresses.length) throw Object.assign(new Error("MCP endpoint has no DNS address"), { status: 503, code: "MCP_DNS_EMPTY" });
  for (const address of addresses) {
    if (classifyIp(address.address) !== "public") {
      throw Object.assign(new Error("MCP endpoint DNS resolves to a private or local address"), { status: 400, code: "MCP_SSRF_BLOCKED" });
    }
  }
  return Object.freeze({
    url: parsed,
    hostname: normalizeHost(parsed.hostname),
    addresses: Object.freeze(addresses.map((entry) => Object.freeze({
      address: stripIpv6Brackets(entry.address),
      family: Number(entry.family),
    }))),
  });
};

/** Backward-compatible URL-only validation for configuration/application callers. */
export const resolveAndAssertPublicMcpHost = async (url, options = {}) => (
  await resolveAndPinPublicMcpHost(url, options)
).url;
