import { domainToASCII } from "node:url";

const configurationError = (message, code) => Object.assign(new Error(message), { status: 403, code });

const normalizeDomain = (value) => {
  const raw = String(value || "").trim().toLowerCase().replace(/^@/, "");
  if (!raw) return "";
  const wildcard = raw.startsWith("*.");
  const candidate = wildcard ? raw.slice(2) : raw;
  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(ascii)) return "";
  return wildcard ? `*.${ascii}` : ascii;
};

const parseDomains = (value) => [...new Set(
  String(value || "")
    .split(",")
    .map(normalizeDomain)
    .filter(Boolean),
)];

const configuredDomains = (value) => Array.isArray(value) ? value.map(normalizeDomain).filter(Boolean) : parseDomains(value);

const domainMatches = (domain, pattern) => {
  const normalizedDomain = normalizeDomain(domain);
  const normalizedPattern = normalizeDomain(pattern);
  if (!normalizedDomain || !normalizedPattern) return false;
  if (!normalizedPattern.startsWith("*.")) return normalizedDomain === normalizedPattern;
  const suffix = normalizedPattern.slice(2);
  return normalizedDomain.endsWith(`.${suffix}`);
};

export const hasVerifiedEmailClaim = (payload = {}) => {
  const email = String(payload.email || "").trim();
  const claim = payload.email_verified ?? payload.emailVerified;
  return Boolean(email) && (claim === true || claim === 1 || claim === "true" || claim === "1");
};

export const normalizeEmailAddress = (value) => String(value || "").trim().toLowerCase();

export const emailDomain = (value) => {
  const email = normalizeEmailAddress(value);
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@") !== at) return "";
  return normalizeDomain(email.slice(at + 1));
};

export const resolveEmailPolicy = ({
  requireVerifiedEmail = false,
  emailAllowlist = process.env.AUTH_EMAIL_DOMAIN_ALLOWLIST,
  emailBlocklist = process.env.AUTH_EMAIL_DOMAIN_BLOCKLIST,
} = {}) => ({
  requireVerifiedEmail: Boolean(requireVerifiedEmail),
  allowlist: configuredDomains(emailAllowlist),
  blocklist: configuredDomains(emailBlocklist),
});

export const assertEmailPolicy = (payload = {}, policy = {}) => {
  const email = normalizeEmailAddress(payload.email);
  const domain = emailDomain(email);
  const allowlist = configuredDomains(policy.allowlist);
  const blocklist = configuredDomains(policy.blocklist);

  if (policy.requireVerifiedEmail && !hasVerifiedEmailClaim(payload)) {
    throw configurationError("A verified email address is required", "EMAIL_VERIFICATION_REQUIRED");
  }

  if ((allowlist.length > 0 || blocklist.length > 0) && !domain) {
    throw configurationError("A valid email address is required", "EMAIL_DOMAIN_REQUIRED");
  }
  if (blocklist.some((pattern) => domainMatches(domain, pattern))) {
    throw configurationError("This email domain is not allowed", "EMAIL_DOMAIN_BLOCKED");
  }
  if (allowlist.length > 0 && !allowlist.some((pattern) => domainMatches(domain, pattern))) {
    throw configurationError("This email domain is not on the allowlist", "EMAIL_DOMAIN_NOT_ALLOWED");
  }
  return { email, domain };
};
