/**
 * Provider-neutral identity verification seam.
 *
 * Implementations own provider configuration, signing-key discovery and
 * access-token verification. Callers receive only verified JWT claims.
 */
export class IdentityProviderPort {
  /**
   * Validate provider configuration and report whether it is configured.
   * Invalid or incomplete configuration must throw instead of degrading to an
   * unauthenticated mode.
   */
  assertConfiguration() {
    throw new Error("IdentityProviderPort.assertConfiguration is not implemented");
  }

  async verifyAccessToken() {
    throw new Error("IdentityProviderPort.verifyAccessToken is not implemented");
  }

  getIdentityMetadata() {
    return { provider: "unknown", issuer: "" };
  }
}
