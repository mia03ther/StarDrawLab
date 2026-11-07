export const MP4_TRANSCODE_ERROR_CODES = Object.freeze({
  UNSUPPORTED: "MP4_TRANSCODE_UNSUPPORTED",
  INVALID_INPUT: "MP4_TRANSCODE_INVALID_INPUT",
  LOAD_FAILED: "FFMPEG_LOAD_FAILED",
  INPUT_FAILED: "FFMPEG_INPUT_FAILED",
  TRANSCODE_FAILED: "FFMPEG_TRANSCODE_FAILED",
  OUTPUT_FAILED: "FFMPEG_OUTPUT_FAILED",
  CANCELLED: "MP4_TRANSCODE_CANCELLED",
});

export class BrowserMp4TranscodeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BrowserMp4TranscodeError";
    this.code = code;
  }
}

const clampProgress = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
};

export const getBrowserMp4TranscodingSupport = (scope = globalThis) => {
  const capabilities = {
    webAssembly: typeof scope?.WebAssembly === "object",
    worker: typeof scope?.Worker === "function",
    blob: typeof scope?.Blob === "function",
    blobUrl: typeof scope?.URL?.createObjectURL === "function"
      && typeof scope?.URL?.revokeObjectURL === "function",
  };
  const missing = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([capability]) => capability);

  return {
    supported: missing.length === 0,
    capabilities,
    missing,
    errorCode: missing.length ? MP4_TRANSCODE_ERROR_CODES.UNSUPPORTED : null,
  };
};

const cancelledError = (cause) => new BrowserMp4TranscodeError(
  MP4_TRANSCODE_ERROR_CODES.CANCELLED,
  "MP4 transcoding was cancelled",
  { cause },
);

const throwIfCancelled = (signal) => {
  if (signal?.aborted) throw cancelledError(signal.reason);
};

const wrapError = (code, message, error, signal) => {
  if (signal?.aborted || error?.name === "AbortError") return cancelledError(error);
  if (error instanceof BrowserMp4TranscodeError) return error;
  return new BrowserMp4TranscodeError(code, message, { cause: error });
};

const loadFfmpegModules = async () => {
  const [ffmpegModule, utilModule, classWorkerModule, coreModule, wasmModule] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
    import("@ffmpeg/ffmpeg/worker?url"),
    import("@ffmpeg/core?url"),
    import("@ffmpeg/core/wasm?url"),
  ]);

  return {
    FFmpeg: ffmpegModule.FFmpeg,
    fetchFile: utilModule.fetchFile,
    classWorkerURL: classWorkerModule.default,
    coreURL: coreModule.default,
    wasmURL: wasmModule.default,
  };
};

/**
 * Converts a MediaRecorder WebM Blob to an H.264/AAC MP4 entirely in the
 * browser. FFmpeg and its core assets are loaded only when this is called.
 */
export const transcodeWebMToMp4 = async (webmBlob, {
  signal,
  onProgress = () => {},
} = {}) => {
  if (!(webmBlob instanceof Blob) || webmBlob.size === 0) {
    throw new BrowserMp4TranscodeError(
      MP4_TRANSCODE_ERROR_CODES.INVALID_INPUT,
      "A non-empty WebM Blob is required for MP4 transcoding",
    );
  }

  const support = getBrowserMp4TranscodingSupport();
  if (!support.supported) {
    throw new BrowserMp4TranscodeError(
      MP4_TRANSCODE_ERROR_CODES.UNSUPPORTED,
      `MP4 transcoding is unavailable; missing browser features: ${support.missing.join(", ")}`,
    );
  }

  throwIfCancelled(signal);
  let ffmpeg;
  let stage = "load";
  const inputName = "timeline-input.webm";
  const outputName = "timeline-output.mp4";
  const report = (phase, progress) => onProgress(clampProgress(progress), { phase });
  const handleAbort = () => ffmpeg?.terminate();

  try {
    report("loading", 0);
    const {
      FFmpeg,
      fetchFile,
      classWorkerURL,
      coreURL,
      wasmURL,
    } = await loadFfmpegModules();
    throwIfCancelled(signal);

    ffmpeg = new FFmpeg();
    signal?.addEventListener("abort", handleAbort, { once: true });
    const handleProgress = ({ progress }) => report("transcoding", progress);
    ffmpeg.on("progress", handleProgress);

    await ffmpeg.load({ classWorkerURL, coreURL, wasmURL }, { signal });
    throwIfCancelled(signal);
    report("loading", 1);

    stage = "input";
    const input = await fetchFile(webmBlob);
    throwIfCancelled(signal);
    await ffmpeg.writeFile(inputName, input, { signal });

    stage = "transcode";
    report("transcoding", 0);
    const exitCode = await ffmpeg.exec([
      "-i", inputName,
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "23",
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
      outputName,
    ], -1, { signal });
    if (exitCode !== 0) {
      throw new BrowserMp4TranscodeError(
        MP4_TRANSCODE_ERROR_CODES.TRANSCODE_FAILED,
        `FFmpeg exited with code ${exitCode}`,
      );
    }

    stage = "output";
    const output = await ffmpeg.readFile(outputName, undefined, { signal });
    if (!(output instanceof Uint8Array) || output.byteLength === 0) {
      throw new BrowserMp4TranscodeError(
        MP4_TRANSCODE_ERROR_CODES.OUTPUT_FAILED,
        "FFmpeg produced an empty MP4 file",
      );
    }
    report("transcoding", 1);
    return new Blob([output], { type: "video/mp4" });
  } catch (error) {
    const details = {
      load: [MP4_TRANSCODE_ERROR_CODES.LOAD_FAILED, "Unable to load the local FFmpeg runtime"],
      input: [MP4_TRANSCODE_ERROR_CODES.INPUT_FAILED, "Unable to copy the WebM input into FFmpeg"],
      transcode: [MP4_TRANSCODE_ERROR_CODES.TRANSCODE_FAILED, "Unable to transcode WebM to MP4"],
      output: [MP4_TRANSCODE_ERROR_CODES.OUTPUT_FAILED, "Unable to read the transcoded MP4 output"],
    }[stage];
    throw wrapError(details[0], details[1], error, signal);
  } finally {
    signal?.removeEventListener("abort", handleAbort);
    if (ffmpeg?.loaded) {
      await ffmpeg.deleteFile(inputName).catch(() => {});
      await ffmpeg.deleteFile(outputName).catch(() => {});
    }
    ffmpeg?.terminate();
  }
};
