const OIDC_SESSION_KEY = "stardraw:oidc:session:v1";
const OIDC_TRANSACTION_KEY = "stardraw:oidc:transaction:v1";
const AUTH_PROVIDER = String(import.meta.env.VITE_AUTH_PROVIDER || "authing").trim().toLowerCase();
const ISSUER = String(import.meta.env.VITE_OIDC_ISSUER || "").trim().replace(/\/$/, "");
const CLIENT_ID = String(import.meta.env.VITE_OIDC_CLIENT_ID || "").trim();
const RESOURCE = String(import.meta.env.VITE_OIDC_RESOURCE || "").trim();
const REDIRECT_URI = import.meta.env.VITE_OIDC_REDIRECT_URI
  || (typeof window !== "undefined" ? `${window.location.origin}/callback` : "");
const LOGOUT_URI = import.meta.env.VITE_OIDC_LOGOUT_URI
  || (typeof window !== "undefined" ? `${window.location.origin}/` : "");
const DISCOVERY_URL = String(import.meta.env.VITE_OIDC_DISCOVERY_URL || "").trim()
  || (ISSUER ? `${ISSUER}/.well-known/openid-configuration` : "");
const OIDC_SCOPES = String(import.meta.env.VITE_OIDC_SCOPES || "openid profile email phone identities urn:logto:scope:sessions offline_access")
  .split(/\s+/)
  .map((scope) => scope.trim())
  .filter(Boolean)
  .join(" ");
const REQUEST_TIMEOUT_MS = 8000;

const toBase64Url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomString = (length = 32) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

const sha256Base64Url = async (value) => {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toBase64Url(new Uint8Array(digest));
};

const decodeJwtPayload = (token) => {
  try {
    const payload = String(token || "").split(".")[1];
    if (!payload) return {};
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch {
    return {};
  }
};

const readStorage = (storage, key) => {
  try {
    const value = storage?.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
};

const writeStorage = (storage, key, value) => {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch (error) {
    throw Object.assign(new Error("Unable to persist authentication session"), {
      code: "AUTH_SESSION_STORAGE_UNAVAILABLE",
      cause: error,
    });
  }
};

const removeStorage = (storage, key) => {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
};

const fetchJson = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw Object.assign(new Error(body?.error_description || body?.error || `HTTP ${response.status}`), {
        status: response.status,
        code: body?.error || "OIDC_REQUEST_FAILED",
      });
    }
    return body;
  } finally {
    window.clearTimeout(timer);
  }
};

const assertConfigured = () => {
  if (!ISSUER || !CLIENT_ID || !REDIRECT_URI) {
    throw Object.assign(new Error("OIDC authentication is not configured"), {
      code: "AUTH_CONFIGURATION_MISSING",
    });
  }
};

let discoveryPromise = null;
let refreshPromise = null;
let accountRefreshPromise = null;

const getDiscovery = async () => {
  assertConfigured();
  if (!discoveryPromise) {
    discoveryPromise = fetchJson(DISCOVERY_URL).catch((error) => {
      discoveryPromise = null;
      throw error;
    });
  }
  const discovery = await discoveryPromise;
  if (!discovery?.authorization_endpoint || !discovery?.token_endpoint) {
    throw Object.assign(new Error("OIDC discovery response is incomplete"), { code: "OIDC_DISCOVERY_INVALID" });
  }
  return discovery;
};

const getStoredSession = () => readStorage(window.localStorage, OIDC_SESSION_KEY);
const storeSession = (session) => writeStorage(window.localStorage, OIDC_SESSION_KEY, session);

const withResource = (params) => {
  if (RESOURCE) params.set("resource", RESOURCE);
  return params;
};

const refreshSession = async (session) => {
  if (!session?.refreshToken) return null;
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const discovery = await getDiscovery();
    const body = withResource(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: CLIENT_ID,
    }));
    const token = await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    const next = {
      ...session,
      accessToken: token.access_token,
      idToken: token.id_token || session.idToken || null,
      refreshToken: token.refresh_token || session.refreshToken,
      expiresAt: Date.now() + Math.max(30, Number(token.expires_in || 300)) * 1000,
      userInfo: decodeJwtPayload(token.id_token || session.idToken),
    };
    if (!next.accessToken) throw Object.assign(new Error("OIDC refresh response has no access token"), { code: "OIDC_REFRESH_INVALID" });
    storeSession(next);
    return next;
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
};

const tokenStillUsable = (token, expiresAt) => {
  if (!token) return false;
  const jwtExpiry = Number(decodeJwtPayload(token)?.exp);
  if (Number.isFinite(jwtExpiry)) return jwtExpiry * 1000 > Date.now() + 30_000;
  return Number(expiresAt || 0) > Date.now() + 30_000;
};

const refreshAccountToken = async (session) => {
  if (!session?.refreshToken) return null;
  if (accountRefreshPromise) return accountRefreshPromise;

  accountRefreshPromise = (async () => {
    const discovery = await getDiscovery();
    // Logto's Account API token is requested without a resource. This is
    // intentionally separate from refreshSession(), which requests the
    // StarDraw API audience.
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: CLIENT_ID,
    });
    const token = await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!token.access_token) {
      throw Object.assign(new Error("OIDC Account API token response has no access token"), {
        code: "OIDC_ACCOUNT_TOKEN_INVALID",
      });
    }

    const next = {
      ...session,
      accountAccessToken: token.access_token,
      accountExpiresAt: Date.now() + Math.max(30, Number(token.expires_in || 300)) * 1000,
      refreshToken: token.refresh_token || session.refreshToken,
    };
    storeSession(next);
    return next.accountAccessToken;
  })().finally(() => {
    accountRefreshPromise = null;
  });
  return accountRefreshPromise;
};

export const createOidcBrowserClient = () => ({
  storageKey: OIDC_SESSION_KEY,

  async getLoginState() {
    assertConfigured();
    const session = getStoredSession();
    if (!session?.accessToken) return null;
    if (Number(session.expiresAt || 0) > Date.now() + 30_000) {
      return {
        accessToken: session.accessToken,
        idToken: session.idToken,
        userInfo: session.userInfo,
        expiresAt: session.expiresAt,
      };
    }
    const refreshed = await refreshSession(session);
    if (!refreshed) {
      removeStorage(window.localStorage, OIDC_SESSION_KEY);
      return null;
    }
    return {
      accessToken: refreshed.accessToken,
      idToken: refreshed.idToken,
      userInfo: refreshed.userInfo,
      expiresAt: refreshed.expiresAt,
    };
  },

  async getAccountAccessToken() {
    assertConfigured();
    const session = getStoredSession();
    if (!session?.accessToken) return null;

    // Without a configured business audience, the normal token is already
    // the only token available to this client and remains the best fallback.
    if (!RESOURCE) return session.accessToken;
    if (tokenStillUsable(session.accountAccessToken, session.accountExpiresAt)) {
      return session.accountAccessToken;
    }

    // Existing sessions created before offline_access was enabled cannot
    // mint the second token. Never return the business token here: it has a
    // different audience and Logto's Account API will reject it.
    if (!session.refreshToken) {
      throw Object.assign(new Error("A fresh sign-in is required for Account API access"), {
        code: "OIDC_ACCOUNT_REAUTH_REQUIRED",
      });
    }
    try {
      return await refreshAccountToken(session);
    } catch (error) {
      console.warn("Unable to obtain Account API token:", error.code || error.message);
      throw error;
    }
  },

  async loginWithRedirect({ forced = false } = {}) {
    assertConfigured();
    const discovery = await getDiscovery();
    const verifier = randomString(48);
    const state = randomString(32);
    const nonce = randomString(32);
    writeStorage(window.sessionStorage, OIDC_TRANSACTION_KEY, { verifier, state, nonce, createdAt: Date.now() });
    const params = withResource(new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      scope: OIDC_SCOPES,
      state,
      nonce,
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
    }));
    if (forced) params.set("prompt", "login");
    window.location.assign(`${discovery.authorization_endpoint}?${params.toString()}`);
  },

  isRedirectCallback() {
    const params = new URLSearchParams(window.location.search);
    return Boolean(params.get("code") || params.get("error"));
  },

  async handleRedirectCallback() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) {
      removeStorage(window.sessionStorage, OIDC_TRANSACTION_KEY);
      throw Object.assign(new Error(params.get("error_description") || error), { code: "OIDC_LOGIN_FAILED" });
    }
    const code = params.get("code");
    const transaction = readStorage(window.sessionStorage, OIDC_TRANSACTION_KEY);
    removeStorage(window.sessionStorage, OIDC_TRANSACTION_KEY);
    if (!code || !transaction?.state || !transaction?.verifier || transaction.state !== params.get("state")) {
      throw Object.assign(new Error("OIDC callback state validation failed"), { code: "OIDC_CALLBACK_INVALID" });
    }
    if (Date.now() - Number(transaction.createdAt || 0) > 10 * 60 * 1000) {
      throw Object.assign(new Error("OIDC callback transaction expired"), { code: "OIDC_CALLBACK_EXPIRED" });
    }
    const discovery = await getDiscovery();
    const body = withResource(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: transaction.verifier,
    }));
    const token = await fetchJson(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!token.access_token) throw Object.assign(new Error("OIDC token response has no access token"), { code: "OIDC_TOKEN_INVALID" });
    const session = {
      accessToken: token.access_token,
      idToken: token.id_token || null,
      refreshToken: token.refresh_token || null,
      expiresAt: Date.now() + Math.max(30, Number(token.expires_in || 300)) * 1000,
      userInfo: decodeJwtPayload(token.id_token),
    };
    storeSession(session);
    return session;
  },

  async logoutWithRedirect({ redirectUri = LOGOUT_URI } = {}) {
    const session = getStoredSession();
    removeStorage(window.localStorage, OIDC_SESSION_KEY);
    try {
      const discovery = await getDiscovery();
      const endpoint = discovery.end_session_endpoint;
      if (endpoint) {
        const params = new URLSearchParams({ post_logout_redirect_uri: redirectUri });
        if (session?.idToken) params.set("id_token_hint", session.idToken);
        window.location.replace(`${endpoint}?${params.toString()}`);
        return;
      }
    } catch (error) {
      console.error("OIDC logout failed, using local redirect:", error);
    }
    window.location.replace(redirectUri);
  },
});

export const isOidcProvider = AUTH_PROVIDER === "oidc" || AUTH_PROVIDER === "logto";
export const OIDC_BROWSER_STORAGE_KEY = OIDC_SESSION_KEY;
