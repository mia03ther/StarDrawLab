const videoEntries = (videos) => Object.entries(
  videos && typeof videos === "object" ? videos : {},
);

export const muteCanvasVideo = (video) => {
  if (!video) return false;
  video.muted = true;
  return true;
};

export const activateCanvasVideoAudio = async ({ videos, elementId } = {}) => {
  const key = String(elementId || "");
  const entries = videoEntries(videos);
  const target = entries.find(([id]) => String(id) === key)?.[1] || null;
  if (!target) return false;

  entries.forEach(([id, video]) => {
    if (String(id) !== key) muteCanvasVideo(video);
  });
  target.muted = false;
  if (!Number.isFinite(Number(target.volume)) || Number(target.volume) <= 0) target.volume = 1;
  try {
    await target.play?.();
  } catch {
    // The click still unlocks audio; a not-yet-loaded video can be played once ready.
  }
  return true;
};
