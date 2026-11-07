/** Provider-neutral seams for image and video generation. */

export const VIDEO_PROVIDER_KINDS = Object.freeze({
  STANDARD: "standard",
  DIGITAL_HUMAN: "digital_human",
});

export class ImageGenerationPort {
  normalizeRequest() {
    throw new Error("ImageGenerationPort.normalizeRequest is not implemented");
  }

  supportsReferenceImages() {
    return true;
  }

  async generate() {
    throw new Error("ImageGenerationPort.generate is not implemented");
  }

  async submit() {
    throw new Error("ImageGenerationPort.submit is not implemented");
  }

  async check() {
    throw new Error("ImageGenerationPort.check is not implemented");
  }
}

export class VideoGenerationPort {
  classifyProvider() {
    throw new Error("VideoGenerationPort.classifyProvider is not implemented");
  }

  normalizeRequest() {
    throw new Error("VideoGenerationPort.normalizeRequest is not implemented");
  }

  async submit() {
    throw new Error("VideoGenerationPort.submit is not implemented");
  }

  async check() {
    throw new Error("VideoGenerationPort.check is not implemented");
  }
}
