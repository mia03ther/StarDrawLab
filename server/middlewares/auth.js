/**
 * 认证中间件
 *
 * 验证流程：
 *  1. 从 Authorization: Bearer <token> 提取 token
 *  2. 通过 IdentityProviderPort 验证访问令牌
 *  3. 从已验证 claims 提取 sub 作为 userId
 *  4. 将 { userId } 挂载到 req.auth
 *
 * Authing/JWKS 配置属于 infrastructure adapter，不在 HTTP 层解析。
 */
import logger from "../configs/logger.js";
import { ACCOUNT_STATUSES, resolveAccessContext } from "../services/accessControlService.js";
import { getIdentityProvider } from "../services/identityProviderComposition.js";
import {
  identityLinksEnabled,
  resolveIdentityUserId,
  shouldHydrateIdentityProfile,
  syncUserIdentityProfile,
} from "../services/identityLinkService.js";
import { getIdentityProfile, identityAccountSupported } from "../services/identityAccountService.js";

const ALLOW_DEV_AUTH_HEADERS = process.env.ALLOW_DEV_AUTH_HEADERS === "true";

export const assertAuthConfiguration = () => getIdentityProvider().assertConfiguration();

/**
 * requireAuth 中间件
 * 与 Clerk 的 requireAuth() 保持同名接口，方便替换
 */
export const requireAuth = () => async (req, res, next) => {
  const identityProvider = getIdentityProvider();
  let configured = false;
  try {
    ({ configured } = identityProvider.assertConfiguration());
  } catch (error) {
    logger.error("auth.configuration.invalid", { code: error.code, error: error.message });
    return res.status(503).json({
      success: false,
      code: error.code || "AUTH_CONFIGURATION_INVALID",
      message: "Authentication service is not configured.",
    });
  }

  // Development identity headers require an explicit opt-in. Merely starting
  // with a non-production NODE_ENV must never enable caller-selected users.
  if (!configured && process.env.NODE_ENV !== "production" && ALLOW_DEV_AUTH_HEADERS) {
    const devUserId = req.headers["x-dev-user-id"] || "dev_user_001";
    try {
      req.auth = await resolveAccessContext({
        userId: devUserId,
        payload: { iat: Math.floor(Date.now() / 1000), amr: ["mfa"] },
      });
      req.authPayload = { sub: devUserId, amr: ["mfa"] };
      logger.warn("auth: identity provider not configured, using dev userId", { userId: devUserId });
      return next();
    } catch (error) {
      logger.error("auth.dev.access.failed", { userId: devUserId, error: error.message });
      return res.status(error.status || 503).json({ success: false, code: error.code || "ACCESS_CONTEXT_UNAVAILABLE", message: error.message });
    }
  }

  if (!configured) {
    return res.status(503).json({
      success: false,
      code: "AUTH_CONFIGURATION_MISSING",
      message: "Authentication service is not configured.",
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "Authorization header required" });
  }

  const token = authHeader.slice(7);

  try {
    const payload = await identityProvider.verifyAccessToken(token);
    // The bearer token is the StarDraw API token. Account API uses a second
    // Logto token minted without a resource; it is supplied only on account
    // routes and remains request-scoped. Never persist or log either token.
    const accountTokenHeader = req.headers["x-identity-account-token"];
    const accountToken = typeof accountTokenHeader === "string"
      && accountTokenHeader.length <= 8192
      ? accountTokenHeader.trim()
      : "";
    req.authToken = token;
    req.identityAccountAccessToken = accountToken || null;

    // OIDC subject is the stable external identity used by access control.
    const userId = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!userId || userId.length > 255) {
      return res.status(401).json({ success: false, code: "INVALID_TOKEN_SUBJECT", message: "Token has an invalid sub claim" });
    }

    const metadata = typeof identityProvider.getIdentityMetadata === "function"
      ? identityProvider.getIdentityMetadata()
      : { provider: process.env.AUTH_PROVIDER || "authing", issuer: payload.iss || "" };
    const stableUserId = await resolveIdentityUserId({
      provider: metadata?.provider || process.env.AUTH_PROVIDER || "authing",
      issuer: metadata?.issuer || payload.iss || "unknown",
      subject: userId,
      email: payload.email,
      emailVerified: payload.email_verified === true || payload.email_verified === 1 || payload.email_verified === "true" || payload.email_verified === "1",
      username: payload.username || payload.preferred_username,
      phoneNumber: payload.phone_number || payload.phone,
    });
    if (identityLinksEnabled()) {
      await syncUserIdentityProfile({
        userId: stableUserId,
        username: payload.username || payload.preferred_username,
        email: payload.email,
        emailVerified: payload.email_verified === true || payload.email_verified === 1 || payload.email_verified === "true" || payload.email_verified === "1",
        phoneNumber: payload.phone_number || payload.phone,
        fullName: payload.full_name || payload.fullname || payload.name,
        gender: payload.gender,
        birthdate: payload.birthdate,
      });

      if (identityAccountSupported() && shouldHydrateIdentityProfile({ userId: stableUserId, claims: payload })) {
        try {
          const profile = await getIdentityProfile({
            accessToken: token,
            ...(req.identityAccountAccessToken ? { accountAccessToken: req.identityAccountAccessToken } : {}),
          });
          await syncUserIdentityProfile({
            userId: stableUserId,
            username: profile?.username || profile?.preferred_username,
            email: profile?.email,
            emailVerified: profile?.email_verified === true || profile?.email_verified === "true",
            phoneNumber: profile?.phone_number || profile?.phone,
            fullName: profile?.name || profile?.full_name || profile?.fullname,
            gender: profile?.gender,
            birthdate: profile?.birthdate,
          });
        } catch (profileError) {
          // Profile hydration is supplementary. A temporary Account API
          // outage must not turn a valid login token into an auth failure.
          logger.warn("auth.identity_profile.hydration_failed", {
            userId: stableUserId,
            code: profileError.code,
            error: profileError.message,
          });
        }
      }
    }
    const accessContext = await resolveAccessContext({
      userId: stableUserId,
      externalSubject: userId,
      identityProvider: metadata?.provider || process.env.AUTH_PROVIDER || "authing",
      identityIssuer: metadata?.issuer || payload.iss || "unknown",
      payload,
    });
    if (accessContext.accountStatus === ACCOUNT_STATUSES.SUSPENDED) {
      return res.status(403).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "This account is suspended.",
      });
    }

    req.auth = accessContext;
    req.authPayload = payload;
    return next();
  } catch (err) {
    logger.warn("auth.verify.failed", { error: err.message, ip: req.ip });

    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, code: "TOKEN_EXPIRED", message: "Token has expired" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, code: "INVALID_TOKEN", message: "Invalid token" });
    }
    const status = Number(err.status) || 401;
    return res.status(status).json({
      success: false,
      code: err.code || "AUTHENTICATION_FAILED",
      message: status >= 500 ? "Authorization service is unavailable" : err.message || "Authentication failed",
    });
  }
};

export default requireAuth;
