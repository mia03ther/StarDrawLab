import * as canvasAgentProvider from "../providers/canvasAgentProvider.js";
import * as scriptOptimizerProvider from "../providers/scriptOptimizerProvider.js";
import * as promptOptimizerProvider from "../providers/promptOptimizerProvider.js";
import { CreativeAgentPort } from "../ports/creativeAgentPort.js";

/** Adapter for the configured GPT-backed creative Agent providers. */
export class CreativeAgentAdapter extends CreativeAgentPort {
  #canvas;
  #script;
  #prompt;

  constructor({ canvas = canvasAgentProvider, script = scriptOptimizerProvider, prompt = promptOptimizerProvider } = {}) {
    super();
    if (typeof canvas?.generateCanvasAgentPlan !== "function") {
      throw new TypeError("Creative Agent adapter requires generateCanvasAgentPlan");
    }
    if (typeof script?.optimizeDigitalHumanScript !== "function") {
      throw new TypeError("Creative Agent adapter requires optimizeDigitalHumanScript");
    }
    if (typeof prompt?.optimizeGenerationPrompt !== "function") {
      throw new TypeError("Creative Agent adapter requires optimizeGenerationPrompt");
    }
    this.#canvas = canvas;
    this.#script = script;
    this.#prompt = prompt;
  }

  planCanvas(request) {
    return this.#canvas.generateCanvasAgentPlan(request);
  }

  planGlobal(request) {
    return typeof this.#canvas.generateGlobalAgentPlan === "function"
      ? this.#canvas.generateGlobalAgentPlan(request)
      : this.#canvas.generateCanvasAgentPlan(request);
  }

  optimizeDigitalHumanScript(request) {
    return this.#script.optimizeDigitalHumanScript(request);
  }

  optimizeGenerationPrompt(request) {
    return this.#prompt.optimizeGenerationPrompt(request);
  }
}

export const createCreativeAgentAdapter = (options = {}) => new CreativeAgentAdapter(options);
