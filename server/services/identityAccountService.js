import logger from "../configs/logger.js";
const REQUEST_TIMEOUT_MS = 8_000;

const fail = (message, { status = 502, code = "IDENTITY_ACCOUNT_API_FAILED", cause } = {}) => {
  throw Object.assign(new Error(message), { status, code, cause });
};

const configuredIdentityProvider = () => String(process.env.AUTH_PROVIDER || "oidc").trim().toLowerCase() || "oidc";

const resolveAccountApiBaseUrl = () => {
  const configured = String(process.env.OIDC_ACCOUNT_API_URL || "").trim();
  if (configured) return configured.replace(/\/$/, "");

  const issuer = String(process.env.OIDC_ISSUER || "").trim();
  if (!issuer) return "";
  try {
    // The Account API is exposed at the provider origin /api. Keeping this
    // derivation provider-neutral also supports a custom identity domain.
    return new URL("/api", issuer).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
};

export const identityAccountSupported = () => {
  const provider = configuredIdentityProvider();
  return (provider === "oidc" || provider === "logto") && Boolean(resolveAccountApiBaseUrl());
};

const accountUrl = (path) => {
  const base = resolveAccountApiBaseUrl();
  if (!base) fail("Identity Account API is not configured", { status: 503, code: "IDENTITY_ACCOUNT_CONFIGURATION_MISSING" });
  return `${base}${path}`;
};

const readBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
};

export const requestIdentityAccount = async ({
  accessToken,
  accountAccessToken,
  path,
  method = "GET",
  body,
  requestHeaders = {},
  fetchImpl = globalThis.fetch,
} = {}) => {
  const provider = configuredIdentityProvider();
  if ((provider === "oidc" || provider === "logto") && !accountAccessToken) {
    fail("A dedicated Logto Account API token is required", { status: 401, code: "IDENTITY_ACCOUNT_TOKEN_MISSING" });
  }
  const token = accountAccessToken || accessToken;
  if (!token) fail("A signed-in identity token is required", { status: 401, code: "IDENTITY_ACCOUNT_TOKEN_MISSING" });
  if (typeof fetchImpl !== "function") fail("Identity Account API transport is unavailable", { status: 503, code: "IDENTITY_ACCOUNT_TRANSPORT_UNAVAILABLE" });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(accountUrl(path), {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...requestHeaders,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const payload = await readBody(response);
    if (!response.ok) {
      const providerMessage = String(payload?.message || payload?.error_description || payload?.error || "").trim();
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      fail(providerMessage || `Identity Account API returned HTTP ${response.status}`, {
        status,
        code: response.status === 401 ? "IDENTITY_ACCOUNT_UNAUTHORIZED" : "IDENTITY_ACCOUNT_API_FAILED",
      });
    }
    return payload;
  } catch (error) {
    if (error.status && error.code) throw error;
    if (error.name === "AbortError") {
      fail("Identity Account API timed out", { status: 504, code: "IDENTITY_ACCOUNT_TIMEOUT", cause: error });
    }
    fail("Identity Account API is unavailable", { status: 503, code: "IDENTITY_ACCOUNT_UNAVAILABLE", cause: error });
  } finally {
    clearTimeout(timer);
  }
};

const normalizeObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const profileFromPayload = (payload) => {
  const data = normalizeObject(payload?.data || payload);
  const otherProfile = normalizeObject(data.profile);
  const profile = { ...data };
  const aliases = [
    ["email", ["primaryEmail", "email"]],
    ["phone_number", ["primaryPhone", "phoneNumber", "phone_number", "phone"]],
    ["full_name", ["name", "fullName", "full_name"]],
    ["avatar_url", ["avatar", "avatarUrl", "avatar_url"]],
  ];

  for (const [target, candidates] of aliases) {
    const source = candidates.find((key) => data[key] !== undefined && data[key] !== null);
    if (source) profile[target] = data[source];
  }
  for (const key of ["gender", "birthdate", "website"]) {
    if (profile[key] === undefined && otherProfile[key] !== undefined) profile[key] = otherProfile[key];
  }
  return profile;
};

export const getIdentityAccount = async ({ accessToken, accountAccessToken, fetchImpl } = {}) => {
  if (!identityAccountSupported()) {
    return { available: false, status: "not_configured", provider: configuredIdentityProvider(), profile: null, security: null };
  }

  const profile = await getIdentityProfile({ accessToken, accountAccessToken, fetchImpl });
  const securityResults = await Promise.allSettled([
    requestIdentityAccount({ accessToken, accountAccessToken, path: "/my-account/mfa-verifications", fetchImpl }),
    requestIdentityAccount({ accessToken, accountAccessToken, path: "/my-account/sessions", fetchImpl }),
  ]);
  const [mfaResult, sessionsResult] = securityResults;

  if (mfaResult.status === "rejected") {
    logger.info("identity.account.mfa_unavailable", { code: mfaResult.reason?.code || "UNKNOWN" });
  }
  if (sessionsResult.status === "rejected") {
    logger.info("identity.account.sessions_unavailable", { code: sessionsResult.reason?.code || "UNKNOWN" });
  }

  const mfa = mfaResult.status === "fulfilled" ? mfaResult.value : null;
  const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : null;
  const mfaItems = Array.isArray(mfa) ? mfa : (Array.isArray(mfa?.data) ? mfa.data : (Array.isArray(mfa?.mfa_verifications) ? mfa.mfa_verifications : []));
  const sessionItems = Array.isArray(sessions) ? sessions : (Array.isArray(sessions?.data) ? sessions.data : (Array.isArray(sessions?.sessions) ? sessions.sessions : []));

  return {
    available: true,
    status: "connected",
    provider: configuredIdentityProvider(),
    profile,
    security: {
      mfa_available: mfaResult.status === "fulfilled",
      mfa_count: mfaItems.length,
      sessions_available: sessionsResult.status === "fulfilled",
      active_session_count: sessionItems.length,
    },
  };
};

// Authentication tokens commonly carry only the subject and standard claims.
// Keep profile hydration separate from the full account-center read so the
// auth middleware can repair the local directory without fetching security
// endpoints on every first request.
export const getIdentityProfile = async ({ accessToken, accountAccessToken, fetchImpl } = {}) => {
  if (!identityAccountSupported()) return null;
  // Account API exposes the current account with GET /my-account. The
  // /profile resource is PATCH-only on the current API version.
  const payload = await requestIdentityAccount({ accessToken, accountAccessToken, path: "/my-account", fetchImpl });
  return profileFromPayload(payload);
};

const cleanPatch = (input = {}, fields) => {
  const patch = {};
  for (const key of fields) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  return patch;
};

export const updateIdentityAccount = async ({ accessToken, accountAccessToken, profile, fetchImpl } = {}) => {
  if (!identityAccountSupported()) {
    fail("Identity Account API is not configured", { status: 503, code: "IDENTITY_ACCOUNT_CONFIGURATION_MISSING" });
  }
  const basicPatch = cleanPatch(profile, ["name", "username", "avatar", "customData"]);
  const otherPatch = cleanPatch(profile, ["familyName", "givenName", "middleName", "nickname", "profile", "website", "gender", "birthdate", "zoneinfo", "locale", "address"]);
  if (Object.keys(basicPatch).length === 0 && Object.keys(otherPatch).length === 0) {
    fail("At least one identity profile field is required", { status: 400, code: "IDENTITY_PROFILE_EMPTY" });
  }

  const payloads = [];
  if (Object.keys(basicPatch).length > 0) {
    payloads.push(await requestIdentityAccount({
      accessToken,
      accountAccessToken,
      path: "/my-account",
      method: "PATCH",
      body: basicPatch,
      fetchImpl,
    }));
  }
  if (Object.keys(otherPatch).length > 0) {
    payloads.push(await requestIdentityAccount({
      accessToken,
      accountAccessToken,
      path: "/my-account/profile",
      method: "PATCH",
      body: otherPatch,
      fetchImpl,
    }));
  }
  const merged = payloads.reduce((current, payload) => ({ ...current, ...profileFromPayload(payload) }), {});
  // PATCH responses may be empty or contain only changed fields. Read the
  // canonical account once so the UI keeps displaying untouched fields.
  try {
    const refreshed = await getIdentityProfile({ accessToken, accountAccessToken, fetchImpl });
    if (Object.keys(refreshed || {}).length > 0) return refreshed;
  } catch {
    // The mutation already succeeded; return the partial response if the
    // best-effort read-back is temporarily unavailable.
  }
  return merged;
};

export const changeIdentityPassword = async ({ accessToken, accountAccessToken, currentPassword, newPassword, fetchImpl } = {}) => {
  if (!identityAccountSupported()) {
    fail("Identity Account API is not configured", { status: 503, code: "IDENTITY_ACCOUNT_CONFIGURATION_MISSING" });
  }
  const current = String(currentPassword || "");
  const next = String(newPassword || "");
  if (!current || !next) fail("Current password and new password are required", { status: 400, code: "IDENTITY_PASSWORD_REQUIRED" });
  if (next.length < 8 || next.length > 128) fail("New password must contain 8 to 128 characters", { status: 400, code: "IDENTITY_PASSWORD_INVALID" });
  const verification = await requestIdentityAccount({
    accessToken,
    accountAccessToken,
    path: "/verifications/password",
    method: "POST",
    body: { password: current },
    fetchImpl,
  });

  const verificationRecordId = verification?.verificationRecordId || verification?.data?.verificationRecordId;
  if (!verificationRecordId) {
    fail("Password verification did not return a verification record", { status: 502, code: "IDENTITY_VERIFICATION_INVALID" });
  }
  await requestIdentityAccount({
    accessToken,
    accountAccessToken,
    path: "/my-account/password",
    method: "POST",
    requestHeaders: { "logto-verification-id": verificationRecordId },
    body: { password: next },
    fetchImpl,
  });
  return { changed: true };
};
