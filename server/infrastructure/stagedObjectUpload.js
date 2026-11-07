import { constants as fsConstants, createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";

import { getOSSClient } from "../configs/oss.js";
import logger from "../configs/logger.js";

const uploadStreamToOss = async ({ stream, objectKey, contentType, contentLength }) => {
  await getOSSClient().putStream(objectKey, stream, {
    timeout: 300_000,
    contentLength,
    mime: contentType,
    headers: { "Content-Type": contentType },
  });
  const url = `/oss-proxy/${objectKey}`;
  logger.info("oss.uploadStream.success", { objectKey, size: contentLength, url });
  return { objectKey, url };
};

export const uploadStagedMedia = async ({
  file,
  objectKey,
  contentType,
  objectStorage,
  streamUploader = uploadStreamToOss,
}) => {
  if (file?.storage !== "temporary") {
    if (!Buffer.isBuffer(file?.buffer)) {
      throw new TypeError("Memory-backed upload requires a Buffer");
    }
    return objectStorage.uploadBuffer(file.buffer, objectKey, contentType);
  }

  const metadata = await lstat(file.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Upload source must be a regular temporary file");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || metadata.size !== file.size) {
    throw new Error("Temporary upload size changed before object storage upload");
  }

  const stream = createReadStream(file.path, {
    flags: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  });
  try {
    return await streamUploader({
      stream,
      objectKey,
      contentType,
      contentLength: file.size,
    });
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
};
