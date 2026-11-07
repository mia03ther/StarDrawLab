export const TIMELINE_RENDER_ERROR_CODES = Object.freeze({
  UNSUPPORTED: "TIMELINE_RENDER_UNSUPPORTED",
  INVALID_ARGUMENT: "TIMELINE_RENDER_INVALID_ARGUMENT",
  EMPTY_TIMELINE: "TIMELINE_RENDER_EMPTY",
  MEDIA_LOAD_FAILED: "TIMELINE_MEDIA_LOAD_FAILED",
  RECORDING_FAILED: "TIMELINE_RECORDING_FAILED",
  CANCELLED: "TIMELINE_RENDER_CANCELLED",
});

export class BrowserTimelineRenderError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BrowserTimelineRenderError";
    this.code = code;
  }
}

const cancelledError = (cause) => new BrowserTimelineRenderError(
  TIMELINE_RENDER_ERROR_CODES.CANCELLED,
  "Browser timeline rendering was cancelled",
  { cause },
);

const throwIfCancelled = (signal) => {
  if (signal?.aborted) throw cancelledError(signal.reason);
};

const waitFor = (target, eventName, signal) => new Promise((resolve, reject) => {
  const cleanup = () => {
    target.removeEventListener(eventName, handleSuccess);
    target.removeEventListener("error", handleError);
    signal?.removeEventListener("abort", handleAbort);
  };
  const handleSuccess = () => { cleanup(); resolve(); };
  const handleError = () => { cleanup(); reject(new Error(`Media ${eventName} failed`)); };
  const handleAbort = () => { cleanup(); reject(cancelledError(signal.reason)); };
  if (signal?.aborted) {
    reject(cancelledError(signal.reason));
    return;
  }
  target.addEventListener(eventName, handleSuccess, { once: true });
  target.addEventListener("error", handleError, { once: true });
  signal?.addEventListener("abort", handleAbort, { once: true });
});

const nextFrame = (signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(cancelledError(signal.reason));
    return;
  }
  const handleAbort = () => {
    cancelAnimationFrame(frameId);
    reject(cancelledError(signal.reason));
  };
  const frameId = requestAnimationFrame(() => {
    signal?.removeEventListener("abort", handleAbort);
    resolve();
  });
  signal?.addEventListener("abort", handleAbort, { once: true });
});

const WEBM_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const preferredMimeType = (scope = globalThis) => WEBM_MIME_TYPES
  .find((type) => scope?.MediaRecorder?.isTypeSupported?.(type)) || null;

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

const roundTimelineTime = (value) => Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;

export const normalizeTimelineClip = (clip, fallbackId = "clip_1") => {
  const duration = Math.max(0.1, Math.min(3600, Number(clip?.duration) || 3));
  return {
    id: String(clip?.id || fallbackId),
    assetId: String(clip?.assetId || clip?.asset_id || clip?.elementId || clip?.element_id || ""),
    start: Math.max(0, Number(clip?.start) || 0),
    duration,
    sourceStart: Math.max(0, Number(clip?.sourceStart ?? clip?.source_start ?? clip?.trimStart ?? clip?.trim_start) || 0),
    sourceDuration: Math.max(0, Number(clip?.sourceDuration ?? clip?.source_duration) || 0),
    speed: clamp(clip?.speed, 0.1, 8, 1),
    volume: clamp(clip?.volume, 0, 2, 1),
    text: String(clip?.text || "").slice(0, 2000),
    transition: String(clip?.transition || "").slice(0, 80),
    fadeIn: clamp(clip?.fadeIn ?? clip?.fade_in, 0, duration / 2, Math.min(0.45, duration / 2)),
    fadeOut: clamp(clip?.fadeOut ?? clip?.fade_out, 0, duration / 2, Math.min(0.45, duration / 2)),
    effect: String(clip?.effect || "").slice(0, 40),
    effectAmount: clamp(clip?.effectAmount ?? clip?.effect_amount, 0, 1, 0.75),
  };
};

export const collectTimelineSnapPoints = (tracks, {
  excludeClipId = "",
  playhead = null,
} = {}) => {
  const points = [0];
  if (Number.isFinite(Number(playhead))) points.push(Math.max(0, Number(playhead)));
  (Array.isArray(tracks) ? tracks : []).forEach((track) => {
    (Array.isArray(track?.clips) ? track.clips : []).forEach((clip) => {
      if (String(clip?.id || "") === String(excludeClipId || "")) return;
      const start = Math.max(0, Number(clip?.start) || 0);
      const duration = Math.max(0, Number(clip?.duration) || 0);
      points.push(start, start + duration);
    });
  });
  return [...new Set(points.map(roundTimelineTime))].sort((left, right) => left - right);
};

export const snapTimelineTime = (time, snapPoints, threshold = 0.12) => {
  const value = Math.max(0, Number(time) || 0);
  const limit = Math.max(0, Number(threshold) || 0);
  let snapped = value;
  let bestDistance = limit + Number.EPSILON;
  (Array.isArray(snapPoints) ? snapPoints : []).forEach((point) => {
    const candidate = Math.max(0, Number(point) || 0);
    const distance = Math.abs(candidate - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      snapped = candidate;
    }
  });
  return roundTimelineTime(snapped);
};

export const moveTimelineClip = (clip, deltaSeconds, {
  snapPoints = [],
  snapThreshold = 0.12,
} = {}) => {
  const start = Math.max(0, (Number(clip?.start) || 0) + (Number(deltaSeconds) || 0));
  const duration = Math.max(0.1, Number(clip?.duration) || 0.1);
  const threshold = Math.max(0, Number(snapThreshold) || 0);
  const adjustments = (Array.isArray(snapPoints) ? snapPoints : []).flatMap((point) => {
    const target = Math.max(0, Number(point) || 0);
    return [target - start, target - (start + duration)];
  }).filter((adjustment) => Math.abs(adjustment) <= threshold);
  const adjustment = adjustments.sort((left, right) => Math.abs(left) - Math.abs(right))[0] || 0;
  const nextStart = start + adjustment;
  return { ...clip, start: roundTimelineTime(Math.max(0, nextStart)) };
};

export const trimTimelineClip = (clip, edge, deltaSeconds, {
  snapPoints = [],
  snapThreshold = 0.12,
  minDuration = 0.1,
} = {}) => {
  const start = Math.max(0, Number(clip?.start) || 0);
  const duration = Math.max(minDuration, Number(clip?.duration) || minDuration);
  const end = start + duration;
  const delta = Number(deltaSeconds) || 0;
  if (edge === "left") {
    const latestStart = end - minDuration;
    const speed = clamp(clip?.speed, 0.1, 8, 1);
    const earliestStart = Math.max(0, start - (Number(clip?.sourceStart) || 0) / speed);
    const rawStart = Math.min(latestStart, Math.max(earliestStart, start + delta));
    const nextStart = Math.min(latestStart, Math.max(earliestStart, snapTimelineTime(rawStart, snapPoints, snapThreshold)));
    const consumed = nextStart - start;
    return {
      ...clip,
      start: roundTimelineTime(nextStart),
      duration: roundTimelineTime(end - nextStart),
      sourceStart: roundTimelineTime(Math.max(0, (Number(clip?.sourceStart) || 0) + consumed * speed)),
    };
  }
  if (edge === "right") {
    const rawEnd = Math.max(start + minDuration, end + delta);
    const nextEnd = Math.max(start + minDuration, snapTimelineTime(rawEnd, snapPoints, snapThreshold));
    return { ...clip, duration: roundTimelineTime(nextEnd - start) };
  }
  return { ...clip };
};

export const splitTimelineClip = (clip, playhead, {
  rightId = `${String(clip?.id || "clip")}_split`,
  minDuration = 0.1,
} = {}) => {
  const start = Math.max(0, Number(clip?.start) || 0);
  const duration = Math.max(minDuration, Number(clip?.duration) || minDuration);
  const splitAt = Number(playhead);
  if (!Number.isFinite(splitAt) || splitAt <= start + minDuration / 2 || splitAt >= start + duration - minDuration / 2) return null;
  const leftDuration = splitAt - start;
  const rightDuration = duration - leftDuration;
  const speed = clamp(clip?.speed, 0.1, 8, 1);
  return [
    { ...clip, duration: roundTimelineTime(leftDuration) },
    {
      ...clip,
      id: String(rightId),
      start: roundTimelineTime(splitAt),
      duration: roundTimelineTime(rightDuration),
      sourceStart: roundTimelineTime((Number(clip?.sourceStart) || 0) + leftDuration * speed),
    },
  ];
};

export const clampTimelinePlayhead = (time, totalDuration) => roundTimelineTime(
  Math.min(Math.max(0, Number(totalDuration) || 0), Math.max(0, Number(time) || 0)),
);

export const getTimelineClipOpacity = (clip, elapsed) => {
  const duration = Math.max(0.1, Number(clip?.duration) || 0.1);
  const localTime = Math.min(duration, Math.max(0, Number(elapsed) || 0));
  const transition = String(clip?.transition || "").toLowerCase();
  if (!["fade", "crossfade", "fade-in", "fade-out"].includes(transition)) return 1;
  const fadeIn = clamp(clip?.fadeIn ?? clip?.fade_in, 0.01, duration / 2, Math.min(0.45, duration / 2));
  const fadeOut = clamp(clip?.fadeOut ?? clip?.fade_out, 0.01, duration / 2, Math.min(0.45, duration / 2));
  const incoming = Math.min(1, localTime / fadeIn);
  const outgoing = Math.min(1, (duration - localTime) / fadeOut);
  if (transition === "fade-in") return incoming;
  if (transition === "fade-out") return outgoing;
  return Math.max(0, Math.min(incoming, outgoing));
};

export const getTimelinePlaybackState = (clip, timelineTime) => {
  const start = Math.max(0, Number(clip?.start) || 0);
  const duration = Math.max(0.1, Number(clip?.duration) || 0.1);
  const localTime = roundTimelineTime((Number(timelineTime) || 0) - start);
  const playbackRate = clamp(clip?.speed, 0.1, 8, 1);
  const active = localTime >= 0 && localTime < duration;
  const opacity = active ? getTimelineClipOpacity(clip, localTime) : 0;
  return {
    active,
    localTime,
    sourceTime: roundTimelineTime((Number(clip?.sourceStart) || 0) + localTime * playbackRate),
    playbackRate,
    opacity,
    gain: roundTimelineTime(clamp(clip?.volume, 0, 2, 1) * opacity),
  };
};

export const getTimelineEffectOverlay = (clip, elapsed) => {
  const duration = Math.max(0.1, Number(clip?.duration) || 0.1);
  const localTime = Math.min(duration, Math.max(0, Number(elapsed) || 0));
  const amount = clamp(clip?.effectAmount ?? clip?.effect_amount, 0, 1, 0.75);
  const effect = String(clip?.effect || "none").toLowerCase();
  const fadeIn = clamp(clip?.fadeIn ?? clip?.fade_in, 0.01, duration, Math.min(0.45, duration));
  const fadeOut = clamp(clip?.fadeOut ?? clip?.fade_out, 0.01, duration, Math.min(0.45, duration));
  let alpha = 0;
  if (effect === "dim") alpha = amount;
  if (effect === "fade-in" || effect === "fade") alpha = amount * Math.max(0, 1 - localTime / fadeIn);
  if (effect === "fade-out" || effect === "fade") {
    alpha = Math.max(alpha, amount * Math.max(0, (localTime - (duration - fadeOut)) / fadeOut));
  }
  return { color: "#000000", alpha: roundTimelineTime(Math.min(1, Math.max(0, alpha))) };
};

const normalizeFormat = (format) => String(format || "mp4").toLowerCase();

export const getBrowserTimelineRenderingSupport = ({
  format = "mp4",
  scope = globalThis,
} = {}) => {
  const outputFormat = normalizeFormat(format);
  let canvasCaptureStream = false;
  try {
    canvasCaptureStream = typeof scope?.document?.createElement?.("canvas")?.captureStream === "function";
  } catch {
    canvasCaptureStream = false;
  }

  const capabilities = {
    mediaRecorder: typeof scope?.MediaRecorder === "function",
    webmRecording: Boolean(preferredMimeType(scope)),
    canvasCaptureStream,
    worker: typeof scope?.Worker === "function",
    webAssembly: typeof scope?.WebAssembly === "object",
    blobUrl: typeof scope?.URL?.createObjectURL === "function"
      && typeof scope?.URL?.revokeObjectURL === "function",
  };
  const required = outputFormat === "mp4"
    ? ["mediaRecorder", "webmRecording", "canvasCaptureStream", "worker", "webAssembly", "blobUrl"]
    : ["mediaRecorder", "webmRecording", "canvasCaptureStream"];
  const missing = outputFormat === "mp4" || outputFormat === "webm"
    ? required.filter((capability) => !capabilities[capability])
    : ["outputFormat"];
  const webmSupported = capabilities.mediaRecorder
    && capabilities.webmRecording
    && capabilities.canvasCaptureStream;

  return {
    supported: missing.length === 0,
    format: outputFormat,
    capabilities,
    missing,
    errorCode: missing.length ? TIMELINE_RENDER_ERROR_CODES.UNSUPPORTED : null,
    webmFallback: { supported: webmSupported, format: "webm" },
  };
};

export const supportsBrowserTimelineRendering = (options) => (
  getBrowserTimelineRenderingSupport(options).supported
);

const PROGRESS_RANGES = Object.freeze({
  mp4: Object.freeze({
    preparing: [0, 0.05],
    composing: [0.05, 0.70],
    "ffmpeg-loading": [0.70, 0.82],
    transcoding: [0.82, 0.99],
    finalizing: [0.99, 1],
  }),
  webm: Object.freeze({
    preparing: [0, 0.05],
    composing: [0.05, 0.98],
    finalizing: [0.98, 1],
  }),
});

export const mapTimelineRenderProgress = (format, phase, phaseProgress) => {
  const outputFormat = normalizeFormat(format);
  const range = PROGRESS_RANGES[outputFormat]?.[phase];
  if (!range) return 0;
  const value = clamp(phaseProgress, 0, 1, 0);
  return range[0] + (range[1] - range[0]) * value;
};

const normalizedTracks = (timeline) => (Array.isArray(timeline?.tracks) ? timeline.tracks : [])
  .map((track, index) => ({
    id: String(track?.id || `track_${index + 1}`),
    type: ["video", "audio", "caption", "effect"].includes(track?.type) ? track.type : "video",
    muted: Boolean(track?.muted),
    clips: Array.isArray(track?.clips) ? track.clips.map((clip, clipIndex) => ({
      ...clip,
      ...normalizeTimelineClip(clip, `clip_${index + 1}_${clipIndex + 1}`),
      assetType: ["image", "video", "audio"].includes(clip?.assetType || clip?.asset_type)
        ? (clip.assetType || clip.asset_type) : "",
    })) : [],
  }));

const drawCover = (context, media, width, height, alpha = 1) => {
  const mediaWidth = media.videoWidth || media.naturalWidth || media.width || 0;
  const mediaHeight = media.videoHeight || media.naturalHeight || media.height || 0;
  if (!mediaWidth || !mediaHeight) return;
  const scale = Math.max(width / mediaWidth, height / mediaHeight);
  const drawWidth = mediaWidth * scale;
  const drawHeight = mediaHeight * scale;
  context.save();
  context.globalAlpha = alpha;
  context.drawImage(media, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  context.restore();
};

const transitionAlpha = getTimelineClipOpacity;

const drawCaption = (context, clip, elapsed, width, height) => {
  if (!clip.text) return;
  const alpha = transitionAlpha(clip, elapsed);
  context.save();
  context.globalAlpha = alpha;
  context.font = "600 28px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const maxWidth = width * 0.82;
  const words = [...clip.text];
  const lines = [];
  let line = "";
  words.forEach((character) => {
    const candidate = line + character;
    if (context.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = character;
    } else line = candidate;
  });
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 3);
  const lineHeight = 36;
  const startY = height - 80 - (visibleLines.length - 1) * lineHeight / 2;
  const boxWidth = Math.min(maxWidth + 36, Math.max(...visibleLines.map((value) => context.measureText(value).width), 100) + 36);
  context.fillStyle = "rgba(0,0,0,.62)";
  context.roundRect?.((width - boxWidth) / 2, startY - lineHeight / 2 - 12, boxWidth, visibleLines.length * lineHeight + 24, 12);
  if (context.roundRect) context.fill();
  context.fillStyle = "#fff";
  visibleLines.forEach((value, index) => context.fillText(value, width / 2, startY + index * lineHeight));
  context.restore();
};

const releaseMedia = (media) => {
  media.pause?.();
  media.removeAttribute?.("src");
  media.load?.();
};

const loadImageMedia = async (url, signal) => {
  const image = new Image();
  image.crossOrigin = "anonymous";
  const loaded = waitFor(image, "load", signal);
  image.src = url;
  await loaded;
  return image;
};

const loadVideo = async (url, clip, signal) => {
  const video = document.createElement("video");
  try {
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    video.load();
    await waitFor(video, "loadedmetadata", signal);
    const sourceStart = Math.min(clip.sourceStart, Math.max(0, video.duration - 0.05));
    if (sourceStart > 0) {
      video.currentTime = sourceStart;
      await waitFor(video, "seeked", signal);
    }
    return video;
  } catch (error) {
    releaseMedia(video);
    throw error;
  }
};

const loadAudio = async (url, clip, signal) => {
  const audio = new Audio();
  try {
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.src = url;
    audio.load();
    await waitFor(audio, "loadedmetadata", signal);
    if (clip.sourceStart > 0) {
      audio.currentTime = Math.min(clip.sourceStart, Math.max(0, audio.duration - 0.05));
      await waitFor(audio, "seeked", signal);
    }
    audio.playbackRate = clip.speed;
    audio.volume = Math.min(1, clip.volume);
    return audio;
  } catch (error) {
    releaseMedia(audio);
    throw error;
  }
};

/**
 * Browser-local compositor. It keeps the public interface small while
 * hiding media loading, multi-track composition, captions, audio routing and
 * basic fade transitions behind the renderer seam.
 */
export const renderTimeline = async ({
  timeline,
  resolveAssetUrl,
  width = 1280,
  height = 720,
  format = "mp4",
  mp4Fallback = null,
  signal,
  onProgress = () => {},
} = {}) => {
  const requestedFormat = normalizeFormat(format);
  if (!["mp4", "webm"].includes(requestedFormat)) {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.INVALID_ARGUMENT,
      `Unsupported timeline output format: ${requestedFormat}`,
    );
  }
  if (mp4Fallback !== null && mp4Fallback !== "webm") {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.INVALID_ARGUMENT,
      "mp4Fallback must be null or \"webm\"",
    );
  }
  if (typeof resolveAssetUrl !== "function") {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.INVALID_ARGUMENT,
      "resolveAssetUrl is required",
    );
  }

  const support = getBrowserTimelineRenderingSupport({ format: requestedFormat });
  let outputFormat = requestedFormat;
  if (!support.supported && requestedFormat === "mp4" && mp4Fallback === "webm" && support.webmFallback.supported) {
    outputFormat = "webm";
  } else if (!support.supported) {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.UNSUPPORTED,
      `Browser timeline ${requestedFormat.toUpperCase()} rendering is unavailable; missing: ${support.missing.join(", ")}`,
    );
  }
  throwIfCancelled(signal);

  let lastProgress = 0;
  const report = (phase, phaseProgress, details = {}) => {
    const mapped = mapTimelineRenderProgress(outputFormat, phase, phaseProgress);
    lastProgress = Math.max(lastProgress, mapped);
    onProgress(lastProgress, {
      format: outputFormat,
      phase,
      phaseProgress: clamp(phaseProgress, 0, 1, 0),
      ...details,
    });
  };

  const tracks = normalizedTracks(timeline);
  const clipEntries = tracks.flatMap((track, trackIndex) => track.clips.map((clip) => ({ track, trackIndex, clip })));
  const renderableEntries = clipEntries.filter(({ track, clip }) => (
    track.type === "caption" || track.type === "effect" || clip.assetId
  ));
  if (!renderableEntries.length) {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.EMPTY_TIMELINE,
      "Timeline has no renderable clips",
    );
  }

  const totalDuration = clipEntries.reduce((max, { clip }) => Math.max(max, clip.start + clip.duration), 0);
  const fps = clamp(timeline?.fps, 1, 60, 30);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new BrowserTimelineRenderError(
      TIMELINE_RENDER_ERROR_CODES.UNSUPPORTED,
      "Canvas 2D context is unavailable",
    );
  }

  const loaded = [];
  const audioContext = window.AudioContext ? new window.AudioContext() : null;
  const audioDestination = audioContext?.createMediaStreamDestination?.() || null;
  let canvasStream;
  let stream;
  let recorder;
  let recorderStopped;
  let recorderStarted = false;
  let webmBlob;
  let stage = "media";
  try {
    report("preparing", 0);
    const mediaEntries = renderableEntries.filter(({ track, clip }) => (
      !["caption", "effect"].includes(track.type) && clip.assetId
    ));
    for (const [index, entry] of mediaEntries.entries()) {
      throwIfCancelled(signal);
      if (entry.track.type === "caption" || !entry.clip.assetId) continue;
      const assetType = entry.track.type === "audio" ? "audio" : entry.clip.assetType || "video";
      const url = await resolveAssetUrl(entry.clip.assetId, { signal, type: assetType });
      throwIfCancelled(signal);
      if (!url) throw new Error(`Timeline asset is unavailable: ${entry.clip.assetId}`);
      let media;
      if (assetType === "image") {
        media = await loadImageMedia(url, signal);
      } else if (entry.track.type === "audio") {
        media = await loadAudio(url, entry.clip, signal);
      } else {
        media = await loadVideo(url, entry.clip, signal);
      }
      if (assetType === "image") {
        loaded.push({ ...entry, media, assetType });
      } else if (audioContext && audioDestination) {
        media.muted = false;
        media.volume = 1;
        const source = audioContext.createMediaElementSource(media);
        const gain = audioContext.createGain();
        gain.gain.value = 0;
        source.connect(gain);
        gain.connect(audioDestination);
        loaded.push({ ...entry, media, source, gain, assetType });
      } else {
        media.muted = true;
        loaded.push({ ...entry, media, assetType });
      }
      report("preparing", (index + 1) / Math.max(mediaEntries.length, 1));
    }
    report("preparing", 1);

    stage = "recording";
    canvasStream = canvas.captureStream(fps);
    stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(audioDestination?.stream?.getAudioTracks?.() || []),
    ]);
    recorder = new MediaRecorder(stream, {
      mimeType: preferredMimeType(),
      videoBitsPerSecond: 8_000_000,
    });
    const chunks = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
    recorderStopped = waitFor(recorder, "stop");
    recorderStopped.catch(() => {});
    recorder.start(1000);
    recorderStarted = true;
    await audioContext?.resume?.();
    const captions = renderableEntries.filter(({ track }) => track.type === "caption");
    const effects = renderableEntries.filter(({ track }) => track.type === "effect");

    const startedAt = performance.now();
    while ((performance.now() - startedAt) / 1000 < totalDuration) {
      const elapsed = (performance.now() - startedAt) / 1000;
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      loaded.forEach(({ track, clip, media, gain, assetType }) => {
        const playback = getTimelinePlaybackState(clip, elapsed);
        if (!playback.active) {
          if (gain) gain.gain.value = 0;
          media.pause?.();
          return;
        }
        if (assetType === "image") {
          drawCover(context, media, width, height, playback.opacity);
          return;
        }
        const desiredTime = playback.sourceTime;
        if (Number.isFinite(media.duration) && Math.abs(media.currentTime - desiredTime) > 0.3) {
          media.currentTime = Math.min(desiredTime, Math.max(0, media.duration - 0.05));
        }
        media.playbackRate = playback.playbackRate;
        if (gain) gain.gain.value = track.muted ? 0 : playback.gain;
        if (media.paused) void media.play().catch(() => {});
        if (track.type === "audio") {
          return;
        }
        drawCover(context, media, width, height, playback.opacity);
      });
      captions.forEach(({ clip }) => {
        const localTime = elapsed - clip.start;
        if (localTime >= 0 && localTime < clip.duration) drawCaption(context, clip, localTime, width, height);
      });
      effects.forEach(({ track, clip }) => {
        const localTime = elapsed - clip.start;
        if (track.muted || localTime < 0 || localTime >= clip.duration) return;
        const overlay = getTimelineEffectOverlay(clip, localTime);
        if (overlay.alpha <= 0) return;
        context.save();
        context.globalAlpha = overlay.alpha;
        context.fillStyle = overlay.color;
        context.fillRect(0, 0, width, height);
        context.restore();
      });
      report("composing", elapsed / Math.max(totalDuration, 0.1));
      await nextFrame(signal);
    }

    if (recorder.state !== "inactive") recorder.stop();
    await recorderStopped;
    if (!chunks.length) throw new Error("MediaRecorder produced no video data");
    report("composing", 1);
    webmBlob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
  } catch (error) {
    if (error instanceof BrowserTimelineRenderError) throw error;
    if (signal?.aborted || error?.name === "AbortError") throw cancelledError(error);
    const code = stage === "media"
      ? TIMELINE_RENDER_ERROR_CODES.MEDIA_LOAD_FAILED
      : TIMELINE_RENDER_ERROR_CODES.RECORDING_FAILED;
    const message = stage === "media"
      ? "Unable to load timeline media"
      : "Unable to record the composed timeline";
    throw new BrowserTimelineRenderError(code, message, { cause: error });
  } finally {
    if (recorderStarted && recorder?.state !== "inactive") recorder.stop();
    if (recorderStarted) await recorderStopped?.catch(() => {});
    canvasStream?.getTracks().forEach((track) => track.stop());
    stream?.getTracks().forEach((track) => track.stop());
    loaded.forEach(({ media, source, gain }) => {
      gain?.disconnect?.();
      source?.disconnect?.();
      releaseMedia(media);
    });
    await audioContext?.close?.().catch?.(() => {});
  }

  throwIfCancelled(signal);
  if (outputFormat === "webm") {
    report("finalizing", 1);
    return webmBlob;
  }

  try {
    const { transcodeWebMToMp4 } = await import("./browserMp4Transcoder.js");
    const mp4Blob = await transcodeWebMToMp4(webmBlob, {
      signal,
      onProgress: (phaseProgress, { phase }) => {
        report(phase === "loading" ? "ffmpeg-loading" : "transcoding", phaseProgress);
      },
    });
    report("finalizing", 1);
    return mp4Blob;
  } catch (error) {
    if (mp4Fallback !== "webm" || error?.code === "MP4_TRANSCODE_CANCELLED") throw error;
    outputFormat = "webm";
    report("finalizing", 1, { fallbackFrom: "mp4", fallbackErrorCode: error?.code || "UNKNOWN" });
    return webmBlob;
  }
};

// Compatibility name retained for callers that only want the old one-track
// behaviour; the compositor now handles that case as a normal timeline.
export const renderSingleVideoTrack = renderTimeline;
