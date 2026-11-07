/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Authing } from "@authing/web";
import { startLogoutRedirect } from "../utils/authSessionFlow";
import { shouldInvalidateSession } from "../utils/authFailureClassification";
import { createOidcBrowserClient, isOidcProvider, OIDC_BROWSER_STORAGE_KEY } from "../auth/oidcBrowserClient";

const AuthingContext = createContext(null);

const APP_ID       = import.meta.env.VITE_AUTHING_APP_ID       || "";
const APP_DOMAIN   = import.meta.env.VITE_AUTHING_DOMAIN       || "";
const REDIRECT_URI = import.meta.env.VITE_AUTHING_REDIRECT_URI || `${window.location.origin}/callback`;
const LOGOUT_URI   = import.meta.env.VITE_AUTHING_LOGOUT_URI   || `${window.location.origin}/`;
const API_BASE_URL = import.meta.env.VITE_BASE_URL || "";

const LEGACY_STORAGE_KEY = "@authing/web:sdk:loginState";
const SDK_STORAGE_KEY = isOidcProvider
  ? OIDC_BROWSER_STORAGE_KEY
  : (APP_ID ? `authing-spa:1:${APP_ID}:login-state` : null);
const VALID_APP_ROLES = new Set(["root", "admin", "user"]);
const DEFAULT_AUTHORIZATION = {
  role: "user",
  accountStatus: "active",
  mfaVerified: null,
  source: "default",
};
const AUTH_STATE_TIMEOUT_MS = 8000;
const AUTH_PROFILE_TIMEOUT_MS = 6000;

let authingSingleton = null;
let oidcSingleton = null;
let authStateInFlight = null;
const getAuthing = () => {
  if (isOidcProvider) {
    if (!oidcSingleton) oidcSingleton = createOidcBrowserClient();
    return oidcSingleton;
  }
  if (!authingSingleton && APP_ID && APP_DOMAIN) {
    authingSingleton = new Authing({
      appId:             APP_ID,
      domain:            APP_DOMAIN,
      redirectUri:       REDIRECT_URI,
      logoutRedirectUri: LOGOUT_URI,
      useImplicitMode:   false,
      redirectResponseMode: "query",
    });
  }
  return authingSingleton;
};

const getAccountApiToken = async (fallbackToken) => {
  if (!isOidcProvider) return fallbackToken;
  const sdk = getAuthing();
  if (typeof sdk?.getAccountAccessToken !== "function") return null;
  try {
    return await sdk.getAccountAccessToken();
  } catch (error) {
    // Account API access is supplementary. Keep the business session alive,
    // but never substitute the business-audience token for the Account API.
    console.warn("Unable to prepare Account API token:", error.code || error.message);
    return null;
  }
};

// 简单解析 JWT payload（不验证签名，仅获取用户信息）
const decodeJwtPayload = (token) => {
  try {
    const parts = token.split(".");
    const payload = parts[1];
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(decoded);
  } catch {
    return {};
  }
};

const getLoginStateExpiry = (state) => {
  const rawExpiry = state?.expireAt || state?.expiresAt;
  const expiry = Number(rawExpiry);
  return Number.isFinite(expiry) ? expiry : null;
};

const isLoginStateValid = (state) => {
  if (!state?.accessToken) return false;
  const expiry = getLoginStateExpiry(state);
  return !expiry || expiry > Date.now() + 30 * 1000;
};

const isTokenUsable = (token) => {
  if (!token) return false;
  const expiry = Number(decodeJwtPayload(token)?.exp);
  return !Number.isFinite(expiry) || expiry * 1000 > Date.now() + 30 * 1000;
};

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
};

const removeStoredLoginState = ({ includeSdkState = true } = {}) => {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    if (includeSdkState && SDK_STORAGE_KEY) {
      localStorage.removeItem(SDK_STORAGE_KEY);
    }
  } catch (err) {
    console.error("Failed to clear stored login state:", err);
  }
};

const resolveAuthState = async (sdk) => {
  if (authStateInFlight) return authStateInFlight;

  const request = (async () => {
    try {
      const sdkState = await Promise.race([
        sdk.getLoginState(),
        new Promise((resolve) => window.setTimeout(() => resolve(null), AUTH_STATE_TIMEOUT_MS)),
      ]);
      if (isLoginStateValid(sdkState)) return sdkState;
    } catch (err) {
      console.error("getLoginState error:", err);
    }
    return null;
  })();

  authStateInFlight = request;
  try {
    return await request;
  } finally {
    if (authStateInFlight === request) authStateInFlight = null;
  }
};

const buildUserObject = (claims) => ({
  id:        claims.sub || claims.userId || "unknown",
  externalId: claims.sub || claims.userId || "unknown",
  name:      claims.name || claims.nickname || claims.username || "用户",
  username:  claims.username || claims.preferred_username || "",
  email:     claims.email || "",
  imageUrl:  claims.picture || null,
  phone:     claims.phone_number || claims.phone || "",
  fullName:  claims.full_name || claims.fullname || claims.name || "",
  gender:    claims.gender || "",
  birthdate: claims.birthdate || "",
  raw:       claims,
});

const mergeUserProfile = (baseUser, profile) => {
  if (!baseUser) return null;
  return {
    ...baseUser,
    id: profile?.user_id || baseUser.id,
    name: profile?.display_name?.trim() || baseUser.name,
    email: profile?.email || baseUser.email,
    imageUrl: profile?.avatar_url || baseUser.imageUrl,
    username: profile?.username || baseUser.username,
    phone: profile?.phone || baseUser.phone,
    fullName: profile?.full_name || baseUser.fullName,
    gender: profile?.gender || baseUser.gender,
    birthdate: profile?.birthdate || baseUser.birthdate,
    profile,
  };
};

const normalizeAppRole = (value) => {
  const role = String(value || "").trim().toLowerCase();
  return VALID_APP_ROLES.has(role) ? role : "user";
};

const normalizeAccountStatus = (value) => {
  const status = String(value || "").trim().toLowerCase();
  return status || "active";
};

const normalizeOptionalBoolean = (value) => {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
};

const getResponseErrorCode = (payload, fallback = "") => String(
  payload?.code || payload?.error?.code || payload?.data?.code || fallback,
).trim().toUpperCase();

const parseBackendIdentity = (payload, source) => {
  const data = payload?.data ?? payload ?? {};
  const authorization = data.authorization || data.permissions || {};
  const account = data.account || data.user_account || {};
  const backendUser = data.user || {};
  const profileData = data.profile || data.user_profile || backendUser.profile || data;

  return {
    userId: data.user_id || authorization.user_id || backendUser.user_id || null,
    identity: data.identity || authorization.identity || null,
    profile: {
      user_id: data.user_id || authorization.user_id || backendUser.user_id || null,
      display_name: profileData?.display_name || backendUser?.display_name || null,
      avatar_url: profileData?.avatar_url || backendUser?.avatar_url || null,
      email: profileData?.email || backendUser?.email || null,
      username: profileData?.username || backendUser?.username || null,
      phone: profileData?.phone || profileData?.phone_number || backendUser?.phone || null,
      full_name: profileData?.full_name || backendUser?.full_name || null,
      gender: profileData?.gender || backendUser?.gender || null,
      birthdate: profileData?.birthdate || backendUser?.birthdate || null,
    },
    authorization: {
      // Never derive the application role from JWT claims. The DB-backed API is authoritative.
      role: normalizeAppRole(
        data.role || data.app_role || authorization.role || account.role || backendUser.role,
      ),
      accountStatus: normalizeAccountStatus(
        data.account_status || authorization.account_status || account.status || backendUser.account_status,
      ),
      mfaVerified: normalizeOptionalBoolean(
        data.mfa_verified ?? authorization.mfa_verified ?? account.mfa_verified,
      ),
      source,
    },
  };
};

const readJsonSafely = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const AuthingProvider = ({ children }) => {
  const [baseUser, setBaseUser]       = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [authorization, setAuthorization] = useState(DEFAULT_AUTHORIZATION);
  const [authorizationLoading, setAuthorizationLoading] = useState(true);
  const [authorizationError, setAuthorizationError] = useState(null);
  const [authorizationIssue, setAuthorizationIssue] = useState(null);
  const [isLoading, setLoading]       = useState(true);
  const [isReady, setReady]           = useState(false);
  const [isLoggingOut, setLoggingOut] = useState(false);
  const tokenRef                      = useRef(null);
  const sessionInvalidatedRef         = useRef(false);
  const logoutInFlightRef             = useRef(false);

  const user = useMemo(() => mergeUserProfile(baseUser, userProfile), [baseUser, userProfile]);

  const invalidateLocalSession = useCallback((issue) => {
    sessionInvalidatedRef.current = true;
    tokenRef.current = null;
    removeStoredLoginState();
    setBaseUser(null);
    setUserProfile(null);
    setAuthorization(DEFAULT_AUTHORIZATION);
    setAuthorizationError(issue?.message || "Please sign in again");
    setAuthorizationIssue(issue || { code: "AUTHENTICATION_REQUIRED", message: "Please sign in again" });
  }, []);

  const handleAuthorizationFailure = useCallback(({ status, code: rawCode, message } = {}) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (shouldInvalidateSession({ status, code })) {
      invalidateLocalSession({
        status: 401,
        code: code || "AUTHENTICATION_REQUIRED",
        message: message || "Please sign in again",
      });
      return;
    }
    if (status !== 403) return;
    if (code === "ACCOUNT_SUSPENDED") {
      setAuthorization((current) => ({ ...current, accountStatus: "suspended" }));
    } else if (code === "EMAIL_VERIFICATION_REQUIRED") {
      invalidateLocalSession({
        status: 403,
        code,
        message: message || "请先验证邮箱，然后重新登录。",
      });
      return;
    } else {
      return;
    }
    setAuthorizationError(message || "Authorization failed");
    setAuthorizationIssue({ status, code, message: message || "Authorization failed" });
  }, [invalidateLocalSession]);

  const refreshProfile = useCallback(async (tokenOverride) => {
    const token = tokenOverride || tokenRef.current;
    if (!token) {
      setAuthorization(DEFAULT_AUTHORIZATION);
      setAuthorizationLoading(false);
      return null;
    }

    setAuthorizationLoading(true);
    setAuthorizationError(null);
    setAuthorizationIssue(null);
    const accountToken = await getAccountApiToken(token);

    const endpoints = ["/api/auth/me", "/api/user/profile"];
    let lastError = null;

    try {
      for (const endpoint of endpoints) {
        try {
          const response = await fetchWithTimeout(`${API_BASE_URL}${endpoint}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              ...(accountToken ? { "X-Identity-Account-Token": accountToken } : {}),
            },
          }, AUTH_PROFILE_TIMEOUT_MS);
          const payload = await readJsonSafely(response);

          if (response.ok) {
            const identity = parseBackendIdentity(payload, endpoint);
            sessionInvalidatedRef.current = false;
            setUserProfile({
              ...identity.profile,
              user_id: identity.userId || identity.profile.user_id || null,
              external_identity: identity.identity || null,
            });
            if (identity.userId) {
              setBaseUser((current) => current
                ? {
                    ...current,
                    id: identity.userId,
                    externalId: current.externalId || current.id,
                  }
                : current);
            }
            setAuthorization(identity.authorization);
            setAuthorizationIssue(null);
            return identity.profile;
          }

          if (endpoint === "/api/auth/me" && response.status === 404) {
            continue;
          }

          const code = getResponseErrorCode(payload, response.status === 401 ? "AUTHENTICATION_REQUIRED" : "");
          const message = payload?.message || `HTTP ${response.status}`;

          if (response.status === 401 || code === "SESSION_REVOKED") {
            invalidateLocalSession({ code, message, status: response.status });
            return null;
          }

          if (response.status === 403) {
            if (code === "ACCOUNT_SUSPENDED") {
              setAuthorization((current) => ({
                ...current,
                accountStatus: "suspended",
                source: endpoint,
              }));
            } else {
              setAuthorization((current) => ({
                ...current,
                accountStatus: "restricted",
                source: endpoint,
              }));
            }
            setAuthorizationError(message);
            setAuthorizationIssue({ code: code || "FORBIDDEN", message, status: response.status });
            return null;
          }

          lastError = new Error(message);
          continue;
        } catch (err) {
          lastError = err;
          // A stalled compatibility endpoint must not prevent the fallback
          // profile endpoint from completing authentication initialization.
          continue;
        }
      }

      // Fail closed for privileged UI while keeping ordinary product pages usable during rollout.
      setAuthorization(DEFAULT_AUTHORIZATION);
      setAuthorizationError(lastError?.message || "Authorization profile is unavailable");
      setAuthorizationIssue({
        code: "AUTHORIZATION_UNAVAILABLE",
        message: lastError?.message || "Authorization profile is unavailable",
      });
      if (lastError) console.error("Failed to load backend identity:", lastError);
      return null;
    } finally {
      setAuthorizationLoading(false);
    }
  }, [invalidateLocalSession]);

  const applyProfile = useCallback((profilePatch) => {
    setUserProfile((prev) => ({
      ...(prev || {}),
      ...(profilePatch || {}),
    }));
  }, []);

  const getToken = useCallback(async () => {
    if (sessionInvalidatedRef.current) return null;

    if (isTokenUsable(tokenRef.current)) return tokenRef.current;

    const sdk = getAuthing();
    if (sdk) {
      const state = await resolveAuthState(sdk);
      if (state?.accessToken) {
        tokenRef.current = state.accessToken;
        return state.accessToken;
      }
    }

    return isTokenUsable(tokenRef.current) ? tokenRef.current : null;
  }, []);

  const getAccountToken = useCallback(async () => {
    if (sessionInvalidatedRef.current) return null;
    const token = await getToken();
    return getAccountApiToken(token);
  }, [getToken]);

  const login = useCallback(() => {
    sessionInvalidatedRef.current = false;
    setAuthorizationIssue(null);
    getAuthing()?.loginWithRedirect();
  }, []);

  const reauthenticate = useCallback(() => {
    sessionInvalidatedRef.current = true;
    tokenRef.current = null;
    // Do not let the SDK reuse a revoked or stale token after a forced login.
    removeStoredLoginState();
    const sdk = getAuthing();
    if (sdk) {
      sdk.loginWithRedirect({ forced: true });
    } else {
      window.location.href = "/";
    }
  }, []);

  const logout = useCallback(() => {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLoggingOut(true);
    sessionInvalidatedRef.current = true;
    tokenRef.current = null;
    setBaseUser(null);
    setUserProfile(null);
    setAuthorization(DEFAULT_AUTHORIZATION);
    setAuthorizationError(null);
    setAuthorizationIssue(null);
    // Keep the SDK key until logoutWithRedirect reads its id_token_hint.
    removeStoredLoginState({ includeSdkState: false });
    const sdk = getAuthing();
    let hasSdkLoginState = false;
    try {
      hasSdkLoginState = Boolean(SDK_STORAGE_KEY && localStorage.getItem(SDK_STORAGE_KEY));
    } catch (error) {
      console.error("Failed to inspect Authing login state:", error);
    }

    void startLogoutRedirect({
      sdk,
      hasSdkLoginState,
      logoutUri: LOGOUT_URI,
      replaceLocation: (uri) => window.location.replace(uri),
    });
  }, []);

  useEffect(() => {
    // Remove the pre-PKCE compatibility cache. The SDK-owned login state is
    // retained and is the only accepted source of browser tokens.
    removeStoredLoginState({ includeSdkState: false });
    const sdk = getAuthing();
    if (!sdk) {
      if (import.meta.env.DEV) {
        setBaseUser({ id: "dev_user_001", name: "Dev User", email: "dev@example.com", imageUrl: null });
      } else {
        console.error(`${isOidcProvider ? "OIDC" : "Authing"} config missing in production build.`);
        setBaseUser(null);
      }
      setAuthorization(DEFAULT_AUTHORIZATION);
      setAuthorizationLoading(false);
      setLoading(false);
      setReady(true);
      return;
    }

    const init = async () => {
      try {
        // The SDK validates the PKCE transaction, state and nonce. Never accept
        // access tokens parsed directly from the URL.
        if (sdk.isRedirectCallback()) {
          await sdk.handleRedirectCallback();
          window.history.replaceState({}, "", window.location.pathname);
        }

        // 2) 获取登录状态
        const state = await resolveAuthState(sdk);

        if (!state?.accessToken) {
          setAuthorization(DEFAULT_AUTHORIZATION);
          setAuthorizationLoading(false);
          setLoading(false);
          setReady(true);
          return;
        }

        tokenRef.current = state.accessToken;
        sessionInvalidatedRef.current = false;

        // 3) 构建用户对象
        let resolvedBaseUser = null;
        if (state?.userInfo) {
          resolvedBaseUser = buildUserObject(state.userInfo);
        } else if (state?.idToken) {
          // 从 idToken JWT 解析用户信息
          const claims = decodeJwtPayload(state.idToken);
          if (claims && claims.sub) {
            resolvedBaseUser = buildUserObject(claims);
          } else {
            // 兜底：从 accessToken 解析
            const accessClaims = decodeJwtPayload(state.accessToken);
            resolvedBaseUser = buildUserObject(accessClaims);
          }
        } else {
          // 最后的兜底
          const accessClaims = decodeJwtPayload(state.accessToken);
          resolvedBaseUser = buildUserObject(accessClaims);
        }

        setBaseUser(resolvedBaseUser);
        await refreshProfile(state.accessToken);
      } catch (err) {
      console.error(`${isOidcProvider ? "OIDC" : "Authing"} init error:`, err);
        setAuthorization(DEFAULT_AUTHORIZATION);
        setAuthorizationError("Unable to initialize authentication");
        setAuthorizationIssue({
          code: "AUTHENTICATION_UNAVAILABLE",
          message: "Unable to initialize authentication",
        });
        setAuthorizationLoading(false);
      } finally {
        setLoading(false);
        setReady(true);
      }
    };

    init();
  }, [refreshProfile]);

  const value = {
    user,
    baseUser,
    userProfile,
    isLoading,
    isReady,
    isLoggingOut,
    isSignedIn: !!user,
    role: authorization.role,
    accountStatus: authorization.accountStatus,
    authorization,
    authorizationLoading,
    authorizationError,
    authorizationIssue,
    handleAuthorizationFailure,
    isRoot: authorization.role === "root",
    isAdmin: authorization.role === "admin" || authorization.role === "root",
    getToken,
    getAccountToken,
    login,
    reauthenticate,
    logout,
    refreshProfile,
    applyProfile,
  };

  return (
    <AuthingContext.Provider value={value}>
      {children}
    </AuthingContext.Provider>
  );
};

export const useAuthing = () => {
  const ctx = useContext(AuthingContext);
  if (!ctx) throw new Error("useAuthing must be used within AuthingProvider");
  return ctx;
};

export default AuthingContext;
