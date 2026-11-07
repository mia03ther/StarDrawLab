/** Product-level Agent capabilities behind a provider-neutral seam. */
export class CreativeAgentPort {
  async planGlobal() {
    throw new Error("CreativeAgentPort.planGlobal is not implemented");
  }

  async planCanvas() {
    throw new Error("CreativeAgentPort.planCanvas is not implemented");
  }

  async optimizeDigitalHumanScript() {
    throw new Error("CreativeAgentPort.optimizeDigitalHumanScript is not implemented");
  }

  async optimizeGenerationPrompt() {
    throw new Error("CreativeAgentPort.optimizeGenerationPrompt is not implemented");
  }
}
