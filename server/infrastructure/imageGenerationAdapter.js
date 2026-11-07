import * as imageProvider from "../providers/imageProvider.js";
import { ImageGenerationPort } from "../ports/mediaGenerationPort.js";

/** Adapter for the current OpenAI-compatible image provider module. */
export class ImageGenerationAdapter extends ImageGenerationPort {
  #provider;

  constructor({ provider = imageProvider } = {}) {
    super();
    for (const method of ["normalizeImageModel", "normalizeImageSize", "generateImage"]) {
      if (typeof provider?.[method] !== "function") {
        throw new TypeError(`Image generation adapter requires ${method}`);
      }
    }
    this.#provider = provider;
  }

  normalizeRequest({ model, size } = {}) {
    return {
      model: this.#provider.normalizeImageModel(model),
      size: this.#provider.normalizeImageSize(size),
      routeProviderKeys: ["image_provider"],
    };
  }

  supportsReferenceImages(model) {
    return typeof this.#provider.imageModelSupportsReferenceImages === "function"
      ? this.#provider.imageModelSupportsReferenceImages(model)
      : true;
  }

  generate({ prompt, size, referenceImages = [], referenceImageUrls = [], model } = {}) {
    const args = [prompt, size, referenceImages, model];
    // Preserve the original provider call shape when no staged provider URLs
    // exist. Mirrmart receives this fifth argument only when the application
    // has actually prepared readable reference URLs.
    if (Array.isArray(referenceImageUrls) && referenceImageUrls.length > 0) {
      args.push(referenceImageUrls);
    }
    return this.#provider.generateImage(...args);
  }

  submit({ prompt, size, referenceImages = [], referenceImageUrls = [], model } = {}) {
    if (typeof this.#provider.submitImage !== "function") {
      throw Object.assign(new Error("Image provider does not expose asynchronous task submission"), {
        status: 503,
        code: "IMAGE_PROVIDER_ASYNC_SUBMISSION_UNAVAILABLE",
      });
    }
    return this.#provider.submitImage({
      prompt,
      size,
      referenceImages,
      referenceImageUrls,
      model,
    });
  }

  check({ taskId } = {}) {
    if (typeof this.#provider.checkImage !== "function") {
      throw Object.assign(new Error("Image provider does not expose asynchronous task status checks"), {
        status: 503,
        code: "IMAGE_PROVIDER_STATUS_UNAVAILABLE",
      });
    }
    return this.#provider.checkImage(taskId);
  }
}

export const createImageGenerationAdapter = (options = {}) => new ImageGenerationAdapter(options);
