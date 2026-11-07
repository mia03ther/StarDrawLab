import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clampTimelinePlayhead,
  collectTimelineSnapPoints,
  getTimelineClipOpacity,
  getTimelineEffectOverlay,
  getTimelinePlaybackState,
  moveTimelineClip,
  normalizeTimelineClip,
  splitTimelineClip,
  trimTimelineClip,
} from "../utils/browserTimelineRenderer";
import CanvasRoundedSelect from "./canvas/CanvasRoundedSelect";

const makeClipId = () => `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const makeTrackId = () => `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TRACK_TYPES = ["video", "audio", "caption", "effect"];
const MIN_CLIP_DURATION = 0.1;

const normalizeTrack = (track, index, t) => {
  const id = String(track?.id || `track_${index + 1}`);
  return {
    id,
    name: String(track?.name || (index === 0 ? t("视频 1", "Video 1") : t(`轨道 ${index + 1}`, `Track ${index + 1}`))).slice(0, 80),
    type: TRACK_TYPES.includes(track?.type) ? track.type : "video",
    muted: Boolean(track?.muted),
    clips: Array.isArray(track?.clips) ? track.clips.map((clip, clipIndex) => ({
      ...clip,
      ...normalizeTimelineClip(clip, `${id}_clip_${clipIndex + 1}`),
    })) : [],
  };
};

const trackLabel = (type, t) => ({
  video: t("视频轨", "Video"),
  audio: t("音频轨", "Audio"),
  caption: t("字幕轨", "Captions"),
  effect: t("效果轨", "Effects"),
}[type] || type);

const trackIcon = (type) => ({
  video: "movie",
  audio: "music_note",
  caption: "subtitles",
  effect: "auto_awesome",
}[type] || "layers");

const rawAssetUrl = (element) => String(
  element?.src
  || element?.url
  || element?.audio_url
  || element?.preview_video_url
  || element?.content
  || "",
);

const replaceClip = (tracks, trackId, clipId, replacement) => tracks.map((track) => (
  track.id === trackId
    ? {
      ...track,
      clips: track.clips.flatMap((clip) => clip.id === clipId
        ? (Array.isArray(replacement) ? replacement : [replacement])
        : [clip]),
    }
    : track
));

const TimelinePanel = ({
  value,
  elements,
  onChange,
  onRender,
  onCancel,
  resolveAssetUrl,
  rendering = false,
  renderProgress = 0,
  ui,
  t,
}) => {
  const fps = Math.max(1, Math.min(60, Number(value?.fps) || 30));
  const tracks = useMemo(() => {
    const source = Array.isArray(value?.tracks) && value.tracks.length > 0 ? value.tracks : [null];
    return source.map((track, index) => normalizeTrack(track, index, t));
  }, [t, value?.tracks]);
  const [selectedTrackId, setSelectedTrackId] = useState(tracks[0]?.id || "");
  const [selectedClipId, setSelectedClipId] = useState("");
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [scale, setScale] = useState(64);
  const [previewUrls, setPreviewUrls] = useState({ visual: "", visualType: "", audio: "" });
  const [previewError, setPreviewError] = useState("");
  const timelineRef = useRef(null);
  const videoPreviewRef = useRef(null);
  const audioPreviewRef = useRef(null);
  const playheadRef = useRef(0);

  const visualElements = useMemo(() => (elements || []).filter((element) => ["image", "video"].includes(element?.type) && element?.id), [elements]);
  const visualElementMap = useMemo(() => new Map(visualElements.map((element) => [String(element.id), element])), [visualElements]);
  const audioElements = useMemo(() => (elements || []).filter((element) => element?.type === "audio" && element?.id), [elements]);
  const anyRenderableClips = tracks.some((track) => track.clips.length > 0);
  const totalDuration = tracks.flatMap((track) => track.clips)
    .reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
  const timelineWidth = Math.max(760, (totalDuration + 4) * scale);

  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) || tracks[0] || null;
  const selectedClip = selectedTrack?.clips.find((clip) => clip.id === selectedClipId) || null;
  const selectedPlayback = selectedClip ? getTimelinePlaybackState(selectedClip, playhead) : null;
  const canSplit = Boolean(selectedClip && selectedPlayback?.active
    && playhead > selectedClip.start + MIN_CLIP_DURATION / 2
    && playhead < selectedClip.start + selectedClip.duration - MIN_CLIP_DURATION / 2);

  const activeVisual = tracks.flatMap((track) => track.type === "video" && !track.muted
    ? track.clips.map((clip) => ({
      track,
      clip,
      assetType: clip.assetType || visualElementMap.get(String(clip.assetId))?.type || "video",
      playback: getTimelinePlaybackState(clip, playhead),
    }))
    : []).filter((entry) => entry.playback.active).at(-1) || null;
  const activeAudio = tracks.flatMap((track) => track.type === "audio" && !track.muted
    ? track.clips.map((clip) => ({ track, clip, playback: getTimelinePlaybackState(clip, playhead) }))
    : []).find((entry) => entry.playback.active) || null;
  const activeCaptions = tracks.flatMap((track) => track.type === "caption" && !track.muted
    ? track.clips.map((clip) => ({ clip, playback: getTimelinePlaybackState(clip, playhead) }))
    : []).filter((entry) => entry.playback.active && entry.clip.text);
  const activeEffect = tracks.flatMap((track) => track.type === "effect" && !track.muted
    ? track.clips.map((clip) => ({ clip, playback: getTimelinePlaybackState(clip, playhead) }))
    : []).filter((entry) => entry.playback.active)
    .map((entry) => getTimelineEffectOverlay(entry.clip, entry.playback.localTime))
    .sort((left, right) => right.alpha - left.alpha)[0] || { color: "#000000", alpha: 0 };

  const update = (nextTracks, nextFps = fps) => onChange?.({
    ...(value || {}),
    fps: Math.max(1, Math.min(60, Number(nextFps) || fps)),
    tracks: nextTracks,
  });
  const patchTrack = (trackId, patch) => update(tracks.map((track) => track.id === trackId ? { ...track, ...patch } : track));
  const patchClip = (trackId, clipId, patch) => update(tracks.map((track) => track.id === trackId
    ? { ...track, clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip) }
    : track));

  const seekTo = useCallback((time) => {
    const next = clampTimelinePlayhead(time, totalDuration);
    playheadRef.current = next;
    setPlayhead(next);
  }, [totalDuration]);

  useEffect(() => {
    if (!tracks.some((track) => track.id === selectedTrackId)) setSelectedTrackId(tracks[0]?.id || "");
    if (selectedClipId && !tracks.some((track) => track.clips.some((clip) => clip.id === selectedClipId))) setSelectedClipId("");
  }, [selectedClipId, selectedTrackId, tracks]);

  useEffect(() => {
    if (playheadRef.current > totalDuration) seekTo(totalDuration);
  }, [seekTo, totalDuration]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    if (totalDuration <= 0 || playheadRef.current >= totalDuration) seekTo(0);
    let frameId = 0;
    let previous = performance.now();
    const tick = (now) => {
      const next = playheadRef.current + Math.max(0, now - previous) / 1000;
      previous = now;
      if (next >= totalDuration) {
        seekTo(totalDuration);
        setIsPlaying(false);
        return;
      }
      seekTo(next);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [isPlaying, seekTo, totalDuration]);

  useEffect(() => {
    let alive = true;
    const visualAssetId = activeVisual?.clip.assetId || "";
    const visualType = activeVisual?.assetType || "";
    const audioAssetId = activeAudio?.clip.assetId || "";
    const resolve = async (assetId, type) => {
      if (!assetId) return "";
      if (typeof resolveAssetUrl === "function") return resolveAssetUrl(assetId, { type });
      const element = (elements || []).find((item) => String(item?.id) === String(assetId));
      return rawAssetUrl(element);
    };
    setPreviewError("");
    Promise.all([resolve(visualAssetId, visualType || "video"), resolve(audioAssetId, "audio")])
      .then(([visual, audio]) => { if (alive) setPreviewUrls({ visual: visual || "", visualType, audio: audio || "" }); })
      .catch(() => { if (alive) { setPreviewUrls({ visual: "", visualType: "", audio: "" }); setPreviewError(t("预览素材加载失败", "Unable to load preview media")); } });
    return () => { alive = false; };
  }, [activeAudio?.clip.assetId, activeVisual?.assetType, activeVisual?.clip.assetId, elements, resolveAssetUrl, t]);

  useEffect(() => {
    const syncMedia = (media, entry) => {
      if (!media || !entry) return;
      const desiredTime = Math.max(0, entry.playback.sourceTime);
      if (Number.isFinite(media.duration) && Math.abs((media.currentTime || 0) - desiredTime) > 0.12) {
        media.currentTime = Math.min(desiredTime, Math.max(0, media.duration - 0.03));
      }
      media.playbackRate = entry.playback.playbackRate;
      media.volume = Math.min(1, entry.playback.gain);
      if (isPlaying) void media.play().catch(() => {});
      else media.pause();
    };
    syncMedia(videoPreviewRef.current, activeVisual?.assetType === "video" ? activeVisual : null);
    syncMedia(audioPreviewRef.current, activeAudio);
  }, [activeAudio, activeVisual, isPlaying, playhead, previewUrls]);

  const addTrack = (type) => {
    const next = {
      id: makeTrackId(),
      name: `${trackLabel(type, t)} ${tracks.filter((track) => track.type === type).length + 1}`,
      type,
      muted: false,
      clips: [],
    };
    setSelectedTrackId(next.id);
    setSelectedClipId("");
    update([...tracks, next]);
  };

  const removeTrack = (trackId) => {
    if (tracks.length <= 1) return;
    const nextTracks = tracks.filter((track) => track.id !== trackId);
    setSelectedTrackId(nextTracks[0]?.id || "");
    setSelectedClipId("");
    update(nextTracks);
  };

  const addClip = (trackId) => {
    const target = tracks.find((track) => track.id === trackId);
    if (!target) return;
    const element = target.type === "video" ? visualElements[0] : target.type === "audio" ? audioElements[0] : null;
    if ((target.type === "video" || target.type === "audio") && !element) return;
    const end = target.clips.reduce((max, clip) => Math.max(max, clip.start + clip.duration), 0);
    const id = makeClipId();
    const clip = normalizeTimelineClip({
      id,
      assetId: element?.id || "",
      assetType: element?.type || "",
      start: end,
      duration: 3,
      text: target.type === "caption" ? t("字幕文本", "Caption text") : "",
      effect: target.type === "effect" ? "fade" : "",
      effectAmount: 0.75,
      transition: "",
    }, id);
    setSelectedTrackId(trackId);
    setSelectedClipId(id);
    patchTrack(trackId, { clips: [...target.clips, clip] });
  };

  const removeClip = (trackId, clipId) => {
    setSelectedClipId("");
    update(tracks.map((track) => track.id === trackId
      ? { ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }
      : track));
  };

  const splitSelectedClip = () => {
    if (!selectedTrack || !selectedClip || !canSplit) return;
    const pieces = splitTimelineClip(selectedClip, playhead, { rightId: makeClipId() });
    if (!pieces) return;
    update(replaceClip(tracks, selectedTrack.id, selectedClip.id, pieces));
    setSelectedClipId(pieces[1].id);
  };

  const pointerTime = (clientX) => {
    const rect = timelineRef.current?.getBoundingClientRect();
    return rect ? Math.max(0, (clientX - rect.left) / scale) : 0;
  };

  const beginPlayheadDrag = (event) => {
    event.preventDefault();
    setIsPlaying(false);
    seekTo(pointerTime(event.clientX));
    const move = (moveEvent) => seekTo(pointerTime(moveEvent.clientX));
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  const beginClipGesture = (event, trackId, clipId, mode) => {
    event.preventDefault();
    event.stopPropagation();
    setIsPlaying(false);
    setSelectedTrackId(trackId);
    setSelectedClipId(clipId);
    const originalTracks = tracks;
    const originalTrack = originalTracks.find((track) => track.id === trackId);
    const originalClip = originalTrack?.clips.find((clip) => clip.id === clipId);
    if (!originalClip) return;
    const startX = event.clientX;
    const snapPoints = snapEnabled
      ? collectTimelineSnapPoints(originalTracks, { excludeClipId: clipId, playhead })
      : [];
    const snapThreshold = snapEnabled ? 9 / scale : 0;
    const move = (moveEvent) => {
      const delta = (moveEvent.clientX - startX) / scale;
      const nextClip = mode === "move"
        ? moveTimelineClip(originalClip, delta, { snapPoints, snapThreshold })
        : trimTimelineClip(originalClip, mode, delta, { snapPoints, snapThreshold, minDuration: MIN_CLIP_DURATION });
      update(replaceClip(originalTracks, trackId, clipId, nextClip));
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] font-bold" style={{ color: ui.faint }}>{t("浏览器时间线", "Browser timeline")}</p>
          <p className="text-sm font-bold mt-1" style={{ color: ui.text }}>{totalDuration.toFixed(1)}s · {fps} FPS · {tracks.length} {t("轨道", "tracks")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {TRACK_TYPES.map((type) => (
            <button type="button" key={type} onClick={() => addTrack(type)} className="rounded-xl px-2.5 py-2 text-[11px] font-bold inline-flex items-center gap-1" style={{ background: type === "video" ? ui.goldSoft : ui.blueSoft, color: type === "video" ? ui.gold : ui.blue, border: `1px solid ${ui.line}` }}>
              <span className="material-symbols-outlined text-[15px]">{trackIcon(type)}</span>+ {trackLabel(type, t)}
            </button>
          ))}
          {onRender && (
            <button type="button" onClick={rendering ? onCancel : onRender} disabled={!rendering && !anyRenderableClips} className="rounded-xl px-3 py-2 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-35" style={{ background: ui.blueSoft, color: ui.blue, border: `1px solid ${ui.blueLine}` }} title={rendering ? t("取消本地渲染", "Cancel local render") : t("本地导出", "Local render")}>
              <span className="material-symbols-outlined text-[16px]">{rendering ? "stop_circle" : "movie_edit"}</span>{rendering ? `${Math.round(renderProgress * 100)}%` : t("本地导出", "Local render")}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-3 min-w-0">
          <div className="relative overflow-hidden rounded-2xl aspect-video flex items-center justify-center" style={{ background: "#050505", border: `1px solid ${ui.line}` }} onClick={() => totalDuration > 0 && setIsPlaying((current) => !current)}>
            {previewUrls.visual && previewUrls.visualType === "video" ? (
              <video
                ref={videoPreviewRef}
                src={previewUrls.visual}
                crossOrigin="anonymous"
                playsInline
                preload="auto"
                onLoadedMetadata={() => seekTo(playheadRef.current)}
                onError={() => setPreviewError(t("视频预览失败", "Video preview failed"))}
                className="absolute inset-0 h-full w-full object-contain"
                style={{ opacity: activeVisual ? getTimelineClipOpacity(activeVisual.clip, activeVisual.playback.localTime) : 0 }}
              />
            ) : previewUrls.visual && previewUrls.visualType === "image" ? (
              <img
                src={previewUrls.visual}
                alt={activeVisual?.clip.text || ""}
                className="absolute inset-0 h-full w-full object-contain"
                style={{ opacity: activeVisual ? getTimelineClipOpacity(activeVisual.clip, activeVisual.playback.localTime) : 0 }}
              />
            ) : (
              <div className="text-center px-6" style={{ color: ui.faint }}><span className="material-symbols-outlined text-4xl">movie</span><p className="text-xs mt-2">{previewError || t("把播放头移到图片或视频片段上即可预览", "Move the playhead onto an image or video clip to preview")}</p></div>
            )}
            {activeCaptions.map(({ clip, playback }) => (
              <div key={clip.id} className="absolute left-1/2 bottom-[12%] -translate-x-1/2 max-w-[82%] rounded-xl bg-black/65 px-4 py-2 text-center text-sm font-semibold text-white" style={{ opacity: getTimelineClipOpacity(clip, playback.localTime) }}>{clip.text}</div>
            ))}
            {activeEffect.alpha > 0 && <div className="pointer-events-none absolute inset-0" style={{ background: activeEffect.color, opacity: activeEffect.alpha }} />}
            <button type="button" className="absolute left-3 bottom-3 h-9 w-9 rounded-full bg-black/60 text-white inline-flex items-center justify-center backdrop-blur" onClick={(event) => { event.stopPropagation(); setIsPlaying((current) => !current); }}>
              <span className="material-symbols-outlined text-[20px]">{isPlaying ? "pause" : "play_arrow"}</span>
            </button>
            <div className="absolute right-3 bottom-3 rounded-lg bg-black/60 px-2 py-1 text-[10px] font-bold text-white/85 tabular-nums">{playhead.toFixed(2)} / {totalDuration.toFixed(2)}s</div>
            {previewUrls.audio && <audio ref={audioPreviewRef} src={previewUrls.audio} crossOrigin="anonymous" preload="auto" />}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-2xl p-2.5" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
            <button type="button" onClick={() => setIsPlaying((current) => !current)} disabled={totalDuration <= 0} className="h-9 w-9 rounded-xl inline-flex items-center justify-center disabled:opacity-35" style={{ background: ui.panelSolid, color: ui.text }}><span className="material-symbols-outlined text-[19px]">{isPlaying ? "pause" : "play_arrow"}</span></button>
            <button type="button" onClick={() => seekTo(0)} disabled={totalDuration <= 0} className="h-9 w-9 rounded-xl inline-flex items-center justify-center disabled:opacity-35" style={{ background: ui.panelSolid, color: ui.muted }}><span className="material-symbols-outlined text-[18px]">first_page</span></button>
            <button type="button" onClick={splitSelectedClip} disabled={!canSplit} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1 disabled:opacity-35" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }}><span className="material-symbols-outlined text-[16px]">content_cut</span>{t("在播放头分割", "Split at playhead")}</button>
            <button type="button" onClick={() => setSnapEnabled((current) => !current)} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1" style={{ background: snapEnabled ? ui.blueSoft : ui.panelSolid, color: snapEnabled ? ui.blue : ui.muted, border: `1px solid ${snapEnabled ? ui.blueLine : ui.line}` }}><span className="material-symbols-outlined text-[16px]">border_vertical</span>{t("磁吸", "Snap")}</button>
            <label className="ml-auto text-[10px] inline-flex items-center gap-2" style={{ color: ui.faint }}>{t("缩放", "Zoom")}<input type="range" min="36" max="140" step="4" value={scale} onChange={(event) => setScale(Number(event.target.value))} className="w-24" /></label>
            <label className="text-[10px] inline-flex items-center gap-2" style={{ color: ui.faint }}>FPS<input type="number" min="1" max="60" value={fps} onChange={(event) => update(tracks, event.target.value)} className="w-16 rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
          </div>

          <div className="overflow-x-auto rounded-2xl p-3" style={{ background: ui.panelSolid, border: `1px solid ${ui.line}` }}>
            <div ref={timelineRef} className="relative select-none" style={{ width: timelineWidth, minHeight: 58 + tracks.length * 66, touchAction: "none" }}>
              <div className="relative h-7 border-b cursor-ew-resize" style={{ borderColor: ui.line }} onPointerDown={beginPlayheadDrag}>
                {Array.from({ length: Math.ceil(timelineWidth / scale) + 1 }, (_, second) => (
                  <span key={second} className="absolute top-0 text-[9px] tabular-nums" style={{ left: second * scale, color: ui.faint }}>{second}s</span>
                ))}
              </div>
              <div className="space-y-2 mt-2">
                {tracks.map((track) => (
                  <div key={track.id} className="relative h-[58px] rounded-xl overflow-hidden" style={{ background: selectedTrackId === track.id ? ui.soft2 : ui.soft, outline: selectedTrackId === track.id ? `1px solid ${ui.lineStrong}` : "none" }} onClick={() => setSelectedTrackId(track.id)}>
                    <div className="absolute left-2 top-1 z-20 rounded-md px-1.5 py-0.5 text-[9px] font-black inline-flex items-center gap-1" style={{ background: ui.panelSolid, color: track.type === "video" ? ui.gold : ui.blue }}><span className="material-symbols-outlined text-[12px]">{trackIcon(track.type)}</span>{track.name || trackLabel(track.type, t)}</div>
                    {track.muted && <span className="material-symbols-outlined absolute right-2 top-1 z-20 text-[14px]" style={{ color: ui.danger }}>volume_off</span>}
                    {track.clips.map((clip) => {
                      const selected = selectedClipId === clip.id;
                      const clipColor = track.type === "video" ? ui.gold : ui.blue;
                      const clipLine = track.type === "video" ? ui.goldLine : ui.blueLine;
                      const clipBackground = track.type === "video" ? ui.goldSoft : ui.blueSoft;
                      return (
                        <div
                          key={clip.id}
                          className="absolute top-6 bottom-1 rounded-lg overflow-hidden cursor-grab active:cursor-grabbing"
                          style={{ left: clip.start * scale, width: Math.max(18, clip.duration * scale), background: clipBackground, border: `1px solid ${selected ? clipColor : clipLine}`, color: clipColor, boxShadow: selected ? `0 0 0 2px ${clipLine}` : "none" }}
                          onPointerDown={(event) => beginClipGesture(event, track.id, clip.id, "move")}
                          title={`${clip.start.toFixed(2)}s – ${(clip.start + clip.duration).toFixed(2)}s`}
                        >
                          <button type="button" aria-label={t("裁剪左边缘", "Trim left edge")} className="absolute left-0 top-0 bottom-0 z-10 w-2 cursor-ew-resize bg-black/10 hover:bg-black/25" onPointerDown={(event) => beginClipGesture(event, track.id, clip.id, "left")} />
                          <div className="h-full px-2 flex items-center gap-1 pointer-events-none">
                            <span className="text-[10px] font-bold truncate">{clip.text || clip.assetId || (track.type === "effect" ? clip.effect : trackLabel(track.type, t))}</span>
                            {clip.speed !== 1 && <span className="text-[8px] font-black opacity-75">{clip.speed}×</span>}
                          </div>
                          <button type="button" aria-label={t("裁剪右边缘", "Trim right edge")} className="absolute right-0 top-0 bottom-0 z-10 w-2 cursor-ew-resize bg-black/10 hover:bg-black/25" onPointerDown={(event) => beginClipGesture(event, track.id, clip.id, "right")} />
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="absolute top-0 bottom-0 z-30 w-px pointer-events-none" style={{ left: playhead * scale, background: ui.danger }}>
                <div className="absolute -left-[5px] -top-0 h-3 w-3 rotate-45 rounded-[2px]" style={{ background: ui.danger }} />
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-3 min-w-0">
          <div className="rounded-2xl p-3 space-y-2" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
            <p className="text-[10px] uppercase tracking-widest font-bold" style={{ color: ui.faint }}>{t("轨道", "Tracks")}</p>
            {tracks.map((track) => (
              <div key={track.id} className="rounded-xl p-2 space-y-2" style={{ background: selectedTrackId === track.id ? ui.panelSolid : "transparent", border: `1px solid ${selectedTrackId === track.id ? ui.lineStrong : ui.line}` }} onClick={() => setSelectedTrackId(track.id)}>
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[16px]" style={{ color: track.type === "video" ? ui.gold : ui.blue }}>{trackIcon(track.type)}</span>
                  <input value={track.name} onChange={(event) => patchTrack(track.id, { name: event.target.value.slice(0, 80) })} className="min-w-0 flex-1 bg-transparent text-xs font-bold outline-none" style={{ color: ui.text }} />
                  <button type="button" onClick={() => patchTrack(track.id, { muted: !track.muted })} className="h-7 w-7 rounded-lg inline-flex items-center justify-center" style={{ background: ui.soft2, color: track.muted ? ui.danger : ui.muted }}><span className="material-symbols-outlined text-[15px]">{track.muted ? "volume_off" : "volume_up"}</span></button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => addClip(track.id)} disabled={(track.type === "video" && visualElements.length === 0) || (track.type === "audio" && audioElements.length === 0)} className="flex-1 rounded-lg px-2 py-1.5 text-[10px] font-bold disabled:opacity-35" style={{ background: ui.goldSoft, color: ui.gold }}>+ {t("片段", "Clip")}</button>
                  {tracks.length > 1 && <button type="button" onClick={() => removeTrack(track.id)} className="rounded-lg px-2 py-1.5 text-[10px] font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}>{t("移除", "Remove")}</button>}
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl p-3 space-y-3" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
            <div className="flex items-center justify-between gap-2"><p className="text-[10px] uppercase tracking-widest font-bold" style={{ color: ui.faint }}>{t("片段检查器", "Clip inspector")}</p>{selectedClip && <button type="button" onClick={() => removeClip(selectedTrack.id, selectedClip.id)} className="rounded-lg px-2 py-1 text-[10px] font-bold" style={{ background: ui.dangerSoft, color: ui.danger }}>{t("删除", "Delete")}</button>}</div>
            {!selectedClip && <p className="text-[11px] leading-5" style={{ color: ui.faint }}>{t("选择一个片段后，可调整裁剪、速度、音量和淡入淡出。", "Select a clip to edit trims, speed, volume and fades.")}</p>}
            {selectedClip && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[10px]" style={{ color: ui.faint }}>{t("开始", "Start")}<input type="number" min="0" step="0.01" value={selectedClip.start} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { start: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
                  <label className="text-[10px]" style={{ color: ui.faint }}>{t("时长", "Duration")}<input type="number" min="0.1" max="3600" step="0.01" value={selectedClip.duration} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { duration: Math.max(0.1, Number(event.target.value) || 0.1) })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
                </div>

                {["video", "audio"].includes(selectedTrack.type) && (
                  <>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("素材", "Asset")}<CanvasRoundedSelect label={t("素材", "Asset")} value={selectedClip.assetId} onChange={(value) => { const nextElement = (selectedTrack.type === "video" ? visualElements : audioElements).find((element) => String(element.id) === value); patchClip(selectedTrack.id, selectedClip.id, { assetId: value, assetType: nextElement?.type || selectedTrack.type }); }} options={(selectedTrack.type === "video" ? visualElements : audioElements).map((element) => ({ value: element.id, label: element.title || element.name || element.id }))} ui={ui} className="mt-1 w-full" triggerClassName="h-8 w-full rounded-lg px-2 text-xs" menuMinWidth={220} /></label>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("素材入点", "Source in")}<input type="number" min="0" step="0.01" value={selectedClip.sourceStart} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { sourceStart: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("速度", "Speed")} · {selectedClip.speed.toFixed(2)}×<input type="range" min="0.1" max="4" step="0.05" value={selectedClip.speed} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { speed: Number(event.target.value) })} className="mt-1 w-full" /></label>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("音量", "Volume")} · {Math.round(selectedClip.volume * 100)}%<input type="range" min="0" max="2" step="0.05" value={selectedClip.volume} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { volume: Number(event.target.value) })} className="mt-1 w-full" /></label>
                  </>
                )}

                {selectedTrack.type === "caption" && <label className="text-[10px] block" style={{ color: ui.faint }}>{t("字幕文本", "Caption text")}<textarea value={selectedClip.text} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { text: event.target.value.slice(0, 2000) })} rows="3" className="mt-1 w-full resize-none rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>}

                {selectedTrack.type === "effect" ? (
                  <>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("效果", "Effect")}<CanvasRoundedSelect label={t("效果", "Effect")} value={selectedClip.effect || "fade"} onChange={(value) => patchClip(selectedTrack.id, selectedClip.id, { effect: value })} options={[{ value: "fade", label: t("黑场淡入淡出", "Fade through black") }, { value: "fade-in", label: t("从黑场淡入", "Fade in from black") }, { value: "fade-out", label: t("淡出到黑场", "Fade out to black") }, { value: "dim", label: t("压暗", "Dim") }, { value: "none", label: t("无", "None") }]} ui={ui} className="mt-1 w-full" triggerClassName="h-8 w-full rounded-lg px-2 text-xs" menuMinWidth={180} /></label>
                    <label className="text-[10px] block" style={{ color: ui.faint }}>{t("强度", "Amount")} · {Math.round(selectedClip.effectAmount * 100)}%<input type="range" min="0" max="1" step="0.05" value={selectedClip.effectAmount} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { effectAmount: Number(event.target.value) })} className="mt-1 w-full" /></label>
                  </>
                ) : (
                  <label className="text-[10px] block" style={{ color: ui.faint }}>{t("淡入淡出", "Fade")}<CanvasRoundedSelect label={t("淡入淡出", "Fade")} value={selectedClip.transition} onChange={(value) => patchClip(selectedTrack.id, selectedClip.id, { transition: value })} options={[{ value: "", label: t("无", "None") }, { value: "fade", label: t("淡入淡出", "Fade in/out") }, { value: "fade-in", label: t("淡入", "Fade in") }, { value: "fade-out", label: t("淡出", "Fade out") }]} ui={ui} className="mt-1 w-full" triggerClassName="h-8 w-full rounded-lg px-2 text-xs" menuMinWidth={160} /></label>
                )}

                {(selectedTrack.type === "effect" || selectedClip.transition) && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-[10px]" style={{ color: ui.faint }}>{t("淡入秒数", "Fade in seconds")}<input type="number" min="0" max={selectedClip.duration / 2} step="0.05" value={selectedClip.fadeIn} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { fadeIn: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
                    <label className="text-[10px]" style={{ color: ui.faint }}>{t("淡出秒数", "Fade out seconds")}<input type="number" min="0" max={selectedClip.duration / 2} step="0.05" value={selectedClip.fadeOut} onChange={(event) => patchClip(selectedTrack.id, selectedClip.id, { fadeOut: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={{ background: ui.panelSolid, color: ui.text, border: `1px solid ${ui.line}` }} /></label>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default TimelinePanel;
