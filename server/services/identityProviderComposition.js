import { createAuthingIdentityProviderAdapter } from "../infrastructure/authingIdentityProviderAdapter.js";
import { createOidcIdentityProviderAdapter } from "../infrastructure/oidcIdentityProviderAdapter.js";
import { IdentityProviderPort } from "../ports/identityProviderPort.js";

let adapter;

const currentAdapter = () => {
  if (!adapter) {
    const provider = String(process.env.AUTH_PROVIDER || "authing").trim().toLowerCase();
    adapter = provider === "authing"
      ? createAuthingIdentityProviderAdapter()
      : createOidcIdentityProviderAdapter();
  }
  return adapter;
};

class IdentityProviderRuntime extends IdentityProviderPort {
  assertConfiguration(...args) {
    return currentAdapter().assertConfiguration(...args);
  }

  verifyAccessToken(...args) {
    return currentAdapter().verifyAccessToken(...args);
  }

  getIdentityMetadata(...args) {
    const candidate = currentAdapter();
    return typeof candidate.getIdentityMetadata === "function"
      ? candidate.getIdentityMetadata(...args)
      : { provider: process.env.AUTH_PROVIDER || "authing", issuer: "" };
  }
}

const runtime = new IdentityProviderRuntime();

/** Composition root for the server identity provider. */
export const getIdentityProvider = () => runtime;

export const setIdentityProviderForTests = (candidate) => {
  for (const method of ["assertConfiguration", "verifyAccessToken"]) {
    if (typeof candidate?.[method] !== "function") {
      throw new TypeError(`Identity provider adapter requires ${method}`);
    }
  }
  adapter = candidate;
  return runtime;
};

export const resetIdentityProvider = () => {
  adapter = null;
};
