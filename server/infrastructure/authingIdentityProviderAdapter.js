import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { IdentityProviderPort } from "../ports/identityProviderPort.js";
import { assertEmailPolicy, hasVerifiedEmailClaim, resolveEmailPolicy } from "./identityEmailPolicy.js";

const configurationError = (message, code) => Object.assign(new Error(message), { code });
const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());

/** Authing OIDC adapter backed by its remote JWKS endpoint. */
export class AuthingIdentityProviderAdapter extends IdentityProviderPort {
  #appHost;
  #appId;
  #production;
  #jwt;
  #jwksClientFactory;
  #jwksClient;
  #emailPolicy;

  constructor({
    appHost = process.env.AUTHING_APP_HOST,
    appId = process.env.AUTHING_APP_ID,
    production = process.env.NODE_ENV === "production",
    jwtLibrary = jwt,
    jwksClientFactory = jwksClient,
    requireVerifiedEmail = enabled(process.env.AUTH_REQUIRE_VERIFIED_EMAIL),
    emailAllowlist = process.env.AUTH_EMAIL_DOMAIN_ALLOWLIST,
    emailBlocklist = process.env.AUTH_EMAIL_DOMAIN_BLOCKLIST,
  } = {}) {
    super();
    this.#appHost = String(appHost || "").trim();
    this.#appId = String(appId || "").trim();
    this.#production = Boolean(production);
    this.#jwt = jwtLibrary;
    this.#jwksClientFactory = jwksClientFactory;
    this.#emailPolicy = resolveEmailPolicy({ requireVerifiedEmail, emailAllowlist, emailBlocklist });
  }

  assertConfiguration() {
    if (this.#production && (!this.#appHost || !this.#appId)) {
      throw configurationError(
        "AUTHING_APP_HOST and AUTHING_APP_ID are required in production",
        "AUTH_CONFIGURATION_MISSING",
      );
    }
    if (Boolean(this.#appHost) !== Boolean(this.#appId)) {
      throw configurationError(
        "AUTHING_APP_HOST and AUTHING_APP_ID must be configured together",
        "AUTH_CONFIGURATION_INCOMPLETE",
      );
    }
    if (this.#appHost) {
      let parsed;
      try {
        parsed = new URL(this.#appHost);
      } catch {
        throw configurationError("AUTHING_APP_HOST must be a valid URL", "AUTH_CONFIGURATION_INVALID");
      }
      if (this.#production && parsed.protocol !== "https:") {
        throw configurationError("AUTHING_APP_HOST must use HTTPS in production", "AUTH_CONFIGURATION_INVALID");
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash || this.#appHost.length > 512) {
        throw configurationError(
          "AUTHING_APP_HOST contains unsupported URL components",
          "AUTH_CONFIGURATION_INVALID",
        );
      }
    }
    if (this.#appId.length > 255) {
      throw configurationError("AUTHING_APP_ID is invalid", "AUTH_CONFIGURATION_INVALID");
    }
    return { configured: Boolean(this.#appHost && this.#appId) };
  }

  getIdentityMetadata() {
    return {
      provider: "authing",
      issuer: this.#appHost ? `${this.#appHost.replace(/\/$/, "")}/oidc` : "",
    };
  }

  #getJwksClient() {
    const { configured } = this.assertConfiguration();
    if (!configured) {
      throw Object.assign(new Error("Authentication service is not configured"), {
        status: 503,
        code: "AUTH_CONFIGURATION_MISSING",
      });
    }
    if (!this.#jwksClient) {
      this.#jwksClient = this.#jwksClientFactory({
        jwksUri: `${this.#appHost.replace(/\/$/, "")}/oidc/.well-known/jwks.json`,
        cache: true,
        cacheMaxEntries: 5,
        cacheMaxAge: 5 * 60 * 1000,
        rateLimit: true,
        jwksRequestsPerMinute: 10,
      });
    }
    return this.#jwksClient;
  }

  #getSigningKey(header) {
    return new Promise((resolve, reject) => {
      this.#getJwksClient().getSigningKey(header.kid, (error, key) => {
        if (error) return reject(error);
        try {
          return resolve(key.getPublicKey());
        } catch (keyError) {
          return reject(keyError);
        }
      });
    });
  }

  async verifyAccessToken(token) {
    const decoded = this.#jwt.decode(token, { complete: true });
    if (!decoded || !decoded.header) {
      throw Object.assign(new Error("Invalid token format"), { status: 401 });
    }

    const signingKey = await this.#getSigningKey(decoded.header);
    const payload = this.#jwt.verify(token, signingKey, {
      algorithms: ["RS256"],
      audience: this.#appId || undefined,
      issuer: this.#appHost ? `${this.#appHost.replace(/\/$/, "")}/oidc` : undefined,
    });
    assertEmailPolicy(payload, this.#emailPolicy);
    return payload;
  }
}

export const createAuthingIdentityProviderAdapter = (options) => new AuthingIdentityProviderAdapter(options);
export { hasVerifiedEmailClaim } from "./identityEmailPolicy.js";
