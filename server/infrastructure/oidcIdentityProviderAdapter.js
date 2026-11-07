import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { IdentityProviderPort } from "../ports/identityProviderPort.js";
import { assertEmailPolicy, resolveEmailPolicy } from "./identityEmailPolicy.js";

const configurationError = (message, code) => Object.assign(new Error(message), { code });
const enabled = (value) => ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
const list = (value, fallback) => String(value ?? fallback ?? "RS256")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean);

const validateUrl = (value, name, production) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw configurationError(`${name} must be a valid URL`, "AUTH_CONFIGURATION_INVALID");
  }
  if (production && parsed.protocol !== "https:") {
    throw configurationError(`${name} must use HTTPS in production`, "AUTH_CONFIGURATION_INVALID");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || value.length > 512) {
    throw configurationError(`${name} contains unsupported URL components`, "AUTH_CONFIGURATION_INVALID");
  }
  return parsed;
};

/** Standard OIDC/JWT adapter used by Logto and other OIDC providers. */
export class OidcIdentityProviderAdapter extends IdentityProviderPort {
  #issuer;
  #audience;
  #jwksUri;
  #production;
  #jwt;
  #jwksClientFactory;
  #jwksClient;
  #algorithms;
  #emailPolicy;

  constructor({
    issuer = process.env.OIDC_ISSUER,
    audience = process.env.OIDC_AUDIENCE || process.env.OIDC_CLIENT_ID,
    jwksUri = process.env.OIDC_JWKS_URI,
    production = process.env.NODE_ENV === "production",
    jwtLibrary = jwt,
    jwksClientFactory = jwksClient,
    algorithms = process.env.OIDC_ALGORITHMS,
    requireVerifiedEmail = enabled(process.env.AUTH_REQUIRE_VERIFIED_EMAIL),
    emailAllowlist = process.env.AUTH_EMAIL_DOMAIN_ALLOWLIST,
    emailBlocklist = process.env.AUTH_EMAIL_DOMAIN_BLOCKLIST,
  } = {}) {
    super();
    this.#issuer = String(issuer || "").trim().replace(/\/$/, "");
    this.#audience = String(audience || "").trim();
    this.#jwksUri = String(jwksUri || "").trim();
    this.#production = Boolean(production);
    this.#jwt = jwtLibrary;
    this.#jwksClientFactory = jwksClientFactory;
    this.#algorithms = list(algorithms, "RS256");
    this.#emailPolicy = resolveEmailPolicy({ requireVerifiedEmail, emailAllowlist, emailBlocklist });
  }

  assertConfiguration() {
    const anyConfigured = Boolean(this.#issuer || this.#audience || this.#jwksUri);
    if (this.#production && (!this.#issuer || !this.#audience || !this.#jwksUri)) {
      throw configurationError(
        "OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI are required in production",
        "AUTH_CONFIGURATION_MISSING",
      );
    }
    if (!anyConfigured) return { configured: false };
    if (!this.#issuer || !this.#audience || !this.#jwksUri) {
      throw configurationError(
        "OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URI must be configured together",
        "AUTH_CONFIGURATION_INCOMPLETE",
      );
    }
    validateUrl(this.#issuer, "OIDC_ISSUER", this.#production);
    validateUrl(this.#jwksUri, "OIDC_JWKS_URI", this.#production);
    if (this.#issuer.length > 512 || this.#audience.length > 255 || this.#algorithms.length === 0) {
      throw configurationError("OIDC authentication configuration is invalid", "AUTH_CONFIGURATION_INVALID");
    }
    return { configured: true, issuer: this.#issuer };
  }

  getIdentityMetadata() {
    return { provider: "oidc", issuer: this.#issuer };
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
        jwksUri: this.#jwksUri,
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
      algorithms: this.#algorithms,
      audience: this.#audience,
      issuer: this.#issuer,
    });
    assertEmailPolicy(payload, this.#emailPolicy);
    return payload;
  }
}

export const createOidcIdentityProviderAdapter = (options) => new OidcIdentityProviderAdapter(options);
