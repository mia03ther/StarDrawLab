import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";

import multer from "multer";

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_IMAGE_MAX_BYTES = 12 * MEBIBYTE;
export const DEFAULT_VIDEO_MAX_BYTES = 200 * MEBIBYTE;
export const DEFAULT_AUDIO_MAX_BYTES = 50 * MEBIBYTE;
export const DEFAULT_UPLOAD_TEMP_ROOT = path.join(os.tmpdir(), "stardraw-uploads");

const EXTENSION_MIME_RULES = new Map([
  [".jpg", { kind: "image", types: new Set(["image/jpeg"]) }],
  [".jpeg", { kind: "image", types: new Set(["image/jpeg"]) }],
  [".png", { kind: "image", types: new Set(["image/png"]) }],
  [".webp", { kind: "image", types: new Set(["image/webp"]) }],
  [".gif", { kind: "image", types: new Set(["image/gif"]) }],
  [".bmp", { kind: "image", types: new Set(["image/bmp", "image/x-ms-bmp"]) }],
  [".heic", { kind: "image", types: new Set(["image/heic", "image/heif"]) }],
  [".heif", { kind: "image", types: new Set(["image/heif", "image/heic"]) }],
  [".avif", { kind: "image", types: new Set(["image/avif"]) }],
  [".mp4", { kind: "video", types: new Set(["video/mp4"]) }],
  [".webm", { kind: "video", types: new Set(["video/webm", "audio/webm"]) }],
  [".mov", { kind: "video", types: new Set(["video/quicktime"]) }],
  [".m4v", { kind: "video", types: new Set(["video/x-m4v", "video/mp4"]) }],
  [".avi", { kind: "video", types: new Set(["video/x-msvideo", "video/avi"]) }],
  [".mpeg", { kind: "video", types: new Set(["video/mpeg"]) }],
  [".mpg", { kind: "video", types: new Set(["video/mpeg"]) }],
  [".mkv", { kind: "video", types: new Set(["video/x-matroska"]) }],
  [".mp3", { kind: "audio", types: new Set(["audio/mpeg", "audio/mp3"]) }],
  [".wav", { kind: "audio", types: new Set(["audio/wav", "audio/x-wav"]) }],
  [".ogg", { kind: "audio", types: new Set(["audio/ogg"]) }],
  [".m4a", { kind: "audio", types: new Set(["audio/mp4", "audio/x-m4a"]) }],
  [".aac", { kind: "audio", types: new Set(["audio/aac"]) }],
  [".flac", { kind: "audio", types: new Set(["audio/flac", "audio/x-flac"]) }],
]);

const uploadError = (message, { code = "UPLOAD_ERROR", status = 400 } = {}) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const fileSizeError = (fieldName) => {
  const error = new multer.MulterError("LIMIT_FILE_SIZE", fieldName);
  error.status = 413;
  return error;
};

export const classifyUpload = (file, allowedKinds = ["image", "video", "audio"]) => {
  const extension = path.extname(String(file?.originalname || "")).toLowerCase();
  const mimetype = String(file?.mimetype || "").trim().toLowerCase();
  const rule = EXTENSION_MIME_RULES.get(extension);
  const resolvedKind = extension === ".webm" && mimetype === "audio/webm" ? "audio" : rule?.kind;

  if (!rule || !rule.types.has(mimetype) || !allowedKinds.includes(resolvedKind)) {
    throw uploadError("File MIME type and extension do not match an allowed media format.", {
      code: "INVALID_UPLOAD_TYPE",
      status: 400,
    });
  }

  return { extension, mimetype, kind: resolvedKind };
};

const collectMemoryFile = async (file, maxBytes) => {
  const chunks = [];
  let size = 0;
  const hash = createHash("sha256");
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(fileSizeError(file.fieldname));
      hash.update(chunk);
      chunks.push(chunk);
      return callback();
    },
  });
  await pipeline(file.stream, sink);
  return {
    buffer: Buffer.concat(chunks, size),
    size,
    sha256: hash.digest("hex"),
    storage: "memory",
    mediaKind: file.mediaKind,
  };
};

const writeTemporaryFile = async (file, { tempRoot, maxBytes }) => {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const extension = path.extname(String(file.originalname || "")).toLowerCase();
  const temporaryPath = path.join(tempRoot, `${randomUUID()}${extension}`);
  let size = 0;
  const hash = createHash("sha256");
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(fileSizeError(file.fieldname));
      hash.update(chunk);
      return callback(null, chunk);
    },
  });

  try {
    await pipeline(
      file.stream,
      limiter,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    return {
      path: temporaryPath,
      size,
      sha256: hash.digest("hex"),
      storage: "temporary",
      mediaKind: file.mediaKind,
    };
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
};

class SafeMediaStorage {
  constructor({ tempRoot, imageMaxBytes, videoMaxBytes, audioMaxBytes }) {
    this.tempRoot = tempRoot;
    this.limits = {
      image: imageMaxBytes,
      video: videoMaxBytes,
      audio: audioMaxBytes,
    };
  }

  _handleFile(_req, file, callback) {
    const maxBytes = this.limits[file.mediaKind];
    const operation = file.mediaKind === "image"
      ? collectMemoryFile(file, maxBytes)
      : writeTemporaryFile(file, { tempRoot: this.tempRoot, maxBytes });
    operation.then((result) => callback(null, result), callback);
  }

  _removeFile(_req, file, callback) {
    if (!file?.path) return callback(null);
    unlink(file.path).then(() => callback(null), (error) => {
      if (error?.code === "ENOENT") return callback(null);
      return callback(error);
    });
  }
}

export const createSafeMediaUpload = ({
  tempRoot = DEFAULT_UPLOAD_TEMP_ROOT,
  imageMaxBytes = DEFAULT_IMAGE_MAX_BYTES,
  videoMaxBytes = DEFAULT_VIDEO_MAX_BYTES,
  audioMaxBytes = DEFAULT_AUDIO_MAX_BYTES,
  files = 1,
  allowedKinds = ["image", "video", "audio"],
} = {}) => {
  const limitsByKind = { image: imageMaxBytes, video: videoMaxBytes, audio: audioMaxBytes };
  for (const kind of allowedKinds) {
    if (!Number.isSafeInteger(limitsByKind[kind]) || limitsByKind[kind] <= 0) {
      throw new TypeError(`${kind} upload limit must be a positive safe integer`);
    }
  }

  return multer({
    storage: new SafeMediaStorage({ tempRoot, imageMaxBytes, videoMaxBytes, audioMaxBytes }),
    fileFilter: (_req, file, callback) => {
      try {
        const classification = classifyUpload(file, allowedKinds);
        file.mediaKind = classification.kind;
        file.validatedExtension = classification.extension;
        callback(null, true);
      } catch (error) {
        callback(error);
      }
    },
    limits: {
      files,
      fileSize: Math.max(...allowedKinds.map((kind) => limitsByKind[kind])),
    },
  });
};

const requestFiles = (req) => {
  const files = [];
  if (req?.file) files.push(req.file);
  if (Array.isArray(req?.files)) files.push(...req.files);
  if (req?.files && !Array.isArray(req.files)) {
    for (const value of Object.values(req.files)) {
      if (Array.isArray(value)) files.push(...value);
    }
  }
  return files;
};

export const cleanupTemporaryUploads = async (req) => {
  const paths = [...new Set(requestFiles(req)
    .filter((file) => file?.storage === "temporary" && file.path)
    .map((file) => file.path))];
  await Promise.all(paths.map((filePath) => unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  })));
};

export const purgeStaleTemporaryUploads = async ({
  tempRoot = DEFAULT_UPLOAD_TEMP_ROOT,
  maxAgeMs = 24 * 60 * 60 * 1000,
  now = Date.now(),
} = {}) => {
  const maximumAge = Number(maxAgeMs);
  if (!Number.isSafeInteger(maximumAge) || maximumAge < 60_000) {
    throw new TypeError("Temporary upload maxAgeMs must be at least one minute");
  }
  let entries;
  try {
    entries = await readdir(tempRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { scanned: 0, removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(tempRoot, entry.name);
    const metadata = await lstat(filePath).catch(() => null);
    if (!metadata) continue;
    if (entry.isSymbolicLink() || now - metadata.mtimeMs >= maximumAge) {
      await unlink(filePath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      removed += 1;
    }
  }
  return { scanned: entries.length, removed };
};

export const attachTemporaryUploadCleanup = (req, res, next) => {
  let cleanupStarted = false;
  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    cleanupTemporaryUploads(req).catch(() => {});
  };
  res.once("finish", cleanup);
  res.once("close", cleanup);
  next();
};
