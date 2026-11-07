/**
 * Provider-neutral seam for outbound email.
 *
 * Callers provide a normalized mail message. Concrete adapters own the
 * provider SDK, connection lifecycle, and provider-specific errors.
 */
export class EmailPort {
  async send() {
    throw new Error("EmailPort.send is not implemented");
  }
}
