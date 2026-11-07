import * as heygenProvider from "../providers/heygenAPI.js";
import * as standardVideoProvider from "../providers/soraAPI.js";
import {
  VideoGenerationPort,
  VIDEO_PROVIDER_KINDS,
} from "../ports/mediaGenerationPort.js";

/**
 * Routes the product's video interface to the current standard-video or
 * digital-human adapter while hiding their incompatible call shapes.
 */
export class VideoGenerationAdapter extends VideoGenerationPort {
  #standard;
  #digitalHuman;

  constructor({ standardProvider = standardVideoProvider, digitalHumanProvider = heygenProvider } = {}) {
    super();
    const standardMethods = ["normalizeVideoProviderModel", "normalizeVideoProviderSize", "submitSoraVideoTask", "checkSoraVideoStatus"];
    const digitalHumanMethods = ["isHeyGenProvider", "normalizeHeyGenModel", "normalizeHeyGenSize", "submitHeyGenVideoAgentTask", "checkHeyGenVideoAgentStatus"];
    for (const method of standardMethods) {
      if (typeof standardProvider?.[method] !== "function") throw new TypeError(`Standard video adapter requires ${method}`);
    }
    for (const method of digitalHumanMethods) {
      if (typeof digitalHumanProvider?.[method] !== "function") throw new TypeError(`Digital-human video adapter requires ${method}`);
    }
    this.#standard = standardProvider;
    this.#digitalHuman = digitalHumanProvider;
  }

  classifyProvider(provider) {
    return this.#digitalHuman.isHeyGenProvider(provider)
      ? VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN
      : VIDEO_PROVIDER_KINDS.STANDARD;
  }

  normalizeRequest({ provider, model, size } = {}) {
    const kind = this.classifyProvider(provider);
    if (kind === VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN) {
      return {
        kind,
        model: this.#digitalHuman.normalizeHeyGenModel(model),
        size: this.#digitalHuman.normalizeHeyGenSize(size || "16:9"),
        routeProviderKeys: ["heygen_video_agent"],
      };
    }
    return {
      kind,
      model: this.#standard.normalizeVideoProviderModel(model),
      size: this.#standard.normalizeVideoProviderSize(size),
      routeProviderKeys: ["sora"],
    };
  }

  submit({ provider, prompt, model, seconds, size, imageUrl = null, imageUrls = [], options = {} } = {}) {
    if (this.classifyProvider(provider) === VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN) {
      return this.#digitalHuman.submitHeyGenVideoAgentTask(prompt, {
        ...options,
        model,
        seconds,
        size,
      });
    }
    return this.#standard.submitSoraVideoTask(prompt, model, seconds, size, imageUrl, imageUrls);
  }

  check({ provider, taskId } = {}) {
    if (this.classifyProvider(provider) === VIDEO_PROVIDER_KINDS.DIGITAL_HUMAN) {
      return this.#digitalHuman.checkHeyGenVideoAgentStatus(taskId);
    }
    return this.#standard.checkSoraVideoStatus(taskId);
  }
}

export const createVideoGenerationAdapter = (options = {}) => new VideoGenerationAdapter(options);
