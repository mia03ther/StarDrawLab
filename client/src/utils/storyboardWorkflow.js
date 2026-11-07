const VISUAL_ELEMENT_TYPES = new Set(["image", "video"]);

const safeDuration = (value) => Math.max(0.1, Math.min(3600, Number(value) || 3));

const makeFallbackId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export const getStoryboardBoundElement = (shot, elements) => {
  const elementId = String(shot?.elementId || shot?.element_id || "");
  if (!elementId) return null;
  return (Array.isArray(elements) ? elements : []).find((element) => (
    String(element?.id || "") === elementId && VISUAL_ELEMENT_TYPES.has(element?.type)
  )) || null;
};

export const upsertStoryboardTimelineClip = ({
  timeline,
  shot,
  element,
  createId = makeFallbackId,
  trackName = "Storyboard",
} = {}) => {
  if (!shot?.id || !element?.id || !VISUAL_ELEMENT_TYPES.has(element?.type)) {
    return { timeline, clipId: "", trackId: "", added: false, changed: false };
  }

  const sourceTracks = Array.isArray(timeline?.tracks) ? timeline.tracks : [];
  const tracks = sourceTracks.map((track) => ({
    ...track,
    clips: Array.isArray(track?.clips) ? track.clips.map((clip) => ({ ...clip })) : [],
  }));
  let trackIndex = tracks.findIndex((track) => track.type === "video" && track.storyboardTrack === true);
  if (trackIndex < 0) trackIndex = tracks.findIndex((track) => track.type === "video");
  if (trackIndex < 0) {
    tracks.push({
      id: createId("storyboard_track"),
      name: trackName,
      type: "video",
      muted: false,
      storyboardTrack: true,
      clips: [],
    });
    trackIndex = tracks.length - 1;
  }

  const track = tracks[trackIndex];
  const shotId = String(shot.id);
  const existingIndex = track.clips.findIndex((clip) => (
    String(clip?.shotId || clip?.storyboardShotId || "") === shotId
  ));
  const duration = safeDuration(shot.duration ?? shot.durationSeconds ?? shot.duration_seconds);
  const clipPatch = {
    assetId: String(element.id),
    elementId: String(element.id),
    assetType: element.type,
    shotId,
    storyboardShotId: shotId,
    text: String(shot.title || shot.prompt || "").slice(0, 2000),
    duration,
  };

  let clip;
  let added = false;
  if (existingIndex >= 0) {
    clip = { ...track.clips[existingIndex], ...clipPatch };
    track.clips[existingIndex] = clip;
  } else {
    const start = track.clips.reduce((max, item) => (
      Math.max(max, Math.max(0, Number(item?.start) || 0) + safeDuration(item?.duration))
    ), 0);
    clip = {
      id: createId("storyboard_clip"),
      start,
      sourceStart: 0,
      sourceDuration: 0,
      speed: 1,
      volume: 1,
      transition: "",
      fadeIn: Math.min(0.45, duration / 2),
      fadeOut: Math.min(0.45, duration / 2),
      effect: "",
      effectAmount: 0.75,
      ...clipPatch,
    };
    track.clips.push(clip);
    added = true;
  }

  return {
    timeline: {
      ...(timeline || {}),
      fps: Math.max(1, Math.min(60, Number(timeline?.fps) || 30)),
      tracks,
    },
    clipId: clip.id,
    trackId: track.id,
    added,
    changed: true,
  };
};
