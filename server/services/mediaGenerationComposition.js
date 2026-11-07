import { createImageGenerationAdapter } from "../infrastructure/imageGenerationAdapter.js";
import { createVideoGenerationAdapter } from "../infrastructure/videoGenerationAdapter.js";
import { ImageGenerationPort, VideoGenerationPort } from "../ports/mediaGenerationPort.js";

let imageAdapter;
let videoAdapter;

const currentImageAdapter = () => {
  if (!imageAdapter) imageAdapter = createImageGenerationAdapter();
  return imageAdapter;
};

const currentVideoAdapter = () => {
  if (!videoAdapter) videoAdapter = createVideoGenerationAdapter();
  return videoAdapter;
};

class ImageGenerationRuntime extends ImageGenerationPort {
  normalizeRequest(...args) { return currentImageAdapter().normalizeRequest(...args); }
  supportsReferenceImages(...args) { return currentImageAdapter().supportsReferenceImages(...args); }
  generate(...args) { return currentImageAdapter().generate(...args); }
  submit(...args) { return currentImageAdapter().submit(...args); }
  check(...args) { return currentImageAdapter().check(...args); }
}

class VideoGenerationRuntime extends VideoGenerationPort {
  classifyProvider(...args) { return currentVideoAdapter().classifyProvider(...args); }
  normalizeRequest(...args) { return currentVideoAdapter().normalizeRequest(...args); }
  submit(...args) { return currentVideoAdapter().submit(...args); }
  check(...args) { return currentVideoAdapter().check(...args); }
}

const imageRuntime = new ImageGenerationRuntime();
const videoRuntime = new VideoGenerationRuntime();

export const getImageGenerationProvider = () => imageRuntime;
export const getVideoGenerationProvider = () => videoRuntime;

export const setMediaGenerationProvidersForTests = ({ image, video } = {}) => {
  if (image) {
    if (typeof image.normalizeRequest !== "function" || typeof image.generate !== "function") {
      throw new TypeError("Image generation adapter is incomplete");
    }
    imageAdapter = image;
  }
  if (video) {
    for (const method of ["classifyProvider", "normalizeRequest", "submit", "check"]) {
      if (typeof video?.[method] !== "function") throw new TypeError(`Video generation adapter requires ${method}`);
    }
    videoAdapter = video;
  }
  return { image: imageRuntime, video: videoRuntime };
};

export const resetMediaGenerationProviders = () => {
  imageAdapter = null;
  videoAdapter = null;
};
