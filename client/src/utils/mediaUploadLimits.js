export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

export const isOversizedReferenceImage = (file) =>
  Number(file?.size || 0) > MAX_REFERENCE_IMAGE_BYTES;
