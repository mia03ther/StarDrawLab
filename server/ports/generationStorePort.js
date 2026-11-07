/**
 * Durable generation state and accounting seam.
 *
 * Implementations must make reserve, settle, and release atomic with the
 * points ledger. Callers never receive a transaction or database client.
 */
export class GenerationStorePort {
  async findTemplate() {
    throw new Error("GenerationStorePort.findTemplate is not implemented");
  }

  async getMembershipTier() {
    throw new Error("GenerationStorePort.getMembershipTier is not implemented");
  }

  async findDigitalHumanRole() {
    throw new Error("GenerationStorePort.findDigitalHumanRole is not implemented");
  }

  async reserveImage() {
    throw new Error("GenerationStorePort.reserveImage is not implemented");
  }

  async persistImageReference() {
    throw new Error("GenerationStorePort.persistImageReference is not implemented");
  }

  async settleImage() {
    throw new Error("GenerationStorePort.settleImage is not implemented");
  }

  async releaseImage() {
    throw new Error("GenerationStorePort.releaseImage is not implemented");
  }

  async reserveVideo() {
    throw new Error("GenerationStorePort.reserveVideo is not implemented");
  }

  async persistVideoTask() {
    throw new Error("GenerationStorePort.persistVideoTask is not implemented");
  }

  async releaseVideo() {
    throw new Error("GenerationStorePort.releaseVideo is not implemented");
  }
}
