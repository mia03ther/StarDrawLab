import { createCreativeAgentAdapter } from "../infrastructure/creativeAgentAdapter.js";
import { CreativeAgentPort } from "../ports/creativeAgentPort.js";

let adapter;
const currentAdapter = () => {
  if (!adapter) adapter = createCreativeAgentAdapter();
  return adapter;
};

class CreativeAgentRuntime extends CreativeAgentPort {
  planGlobal(...args) { return currentAdapter().planGlobal(...args); }
  planCanvas(...args) { return currentAdapter().planCanvas(...args); }
  optimizeDigitalHumanScript(...args) { return currentAdapter().optimizeDigitalHumanScript(...args); }
  optimizeGenerationPrompt(...args) { return currentAdapter().optimizeGenerationPrompt(...args); }
}

const runtime = new CreativeAgentRuntime();

export const getCreativeAgent = () => runtime;

export const setCreativeAgentForTests = (candidate) => {
  for (const method of ["planGlobal", "planCanvas", "optimizeDigitalHumanScript", "optimizeGenerationPrompt"]) {
    if (typeof candidate?.[method] !== "function") throw new TypeError(`Creative Agent adapter requires ${method}`);
  }
  adapter = candidate;
  return runtime;
};

export const resetCreativeAgent = () => {
  adapter = null;
};
