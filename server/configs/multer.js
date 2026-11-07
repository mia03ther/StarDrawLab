import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_VIDEO_MAX_BYTES,
  createSafeMediaUpload,
} from "../infrastructure/safeMultipartUpload.js";

export const upload = createSafeMediaUpload({
  allowedKinds: ["image"],
  files: 4,
  imageMaxBytes: 10 * 1024 * 1024,
});

export const uploadPreview = createSafeMediaUpload({
  allowedKinds: ["image", "video", "audio"],
  files: 1,
  imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
  videoMaxBytes: DEFAULT_VIDEO_MAX_BYTES,
  audioMaxBytes: 50 * 1024 * 1024,
});

export const uploadDigitalHumanRoleAssets = createSafeMediaUpload({
  allowedKinds: ["image", "video"],
  files: 2,
  imageMaxBytes: DEFAULT_IMAGE_MAX_BYTES,
  videoMaxBytes: DEFAULT_VIDEO_MAX_BYTES,
});
