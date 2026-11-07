import { OssImage, OssVideo } from "./OssMedia";
import { getStoryboardBoundElement } from "../utils/storyboardWorkflow";

const makeShotId = () => `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const normalizeShots = (value, t) => (Array.isArray(value?.shots) ? value.shots : []).map((shot, index) => ({
  id: String(shot?.id || makeShotId()),
  title: String(shot?.title || t(`镜头 ${index + 1}`, `Shot ${index + 1}`)).slice(0, 120),
  description: String(shot?.description || "").slice(0, 1000),
  prompt: String(shot?.prompt || "").slice(0, 3000),
  duration: Math.max(0.1, Math.min(3600, Number(shot?.duration ?? shot?.durationSeconds ?? shot?.duration_seconds ?? 3) || 3)),
  camera: String(shot?.camera || shot?.cameraMovement || shot?.camera_movement || "").slice(0, 120),
  style: String(shot?.style || "").slice(0, 120),
  elementId: shot?.elementId || shot?.element_id || null,
  pendingElementId: shot?.pendingElementId || shot?.pending_element_id || null,
  generationType: ["image", "video"].includes(shot?.generationType || shot?.generation_type)
    ? (shot.generationType || shot.generation_type) : "",
  generationStatus: ["idle", "generating", "completed", "failed"].includes(shot?.generationStatus || shot?.generation_status)
    ? (shot.generationStatus || shot.generation_status) : "idle",
  generationError: String(shot?.generationError || shot?.generation_error || "").slice(0, 500),
  creationId: shot?.creationId || shot?.creation_id || null,
  resultUrl: String(shot?.resultUrl || shot?.result_url || "").slice(0, 4000),
  timelineClipId: shot?.timelineClipId || shot?.timeline_clip_id || null,
  timelineTrackId: shot?.timelineTrackId || shot?.timeline_track_id || null,
  generatedAt: shot?.generatedAt || shot?.generated_at || null,
}));

const inputStyle = (ui) => ({
  background: ui.panelSolid,
  color: ui.text,
  border: `1px solid ${ui.line}`,
});

const getElementMediaUrl = (element) => String(
  element?.src || element?.content || element?.url || element?.preview_video_url || element?.preview_image_url || "",
);

const getElementPosterUrl = (element) => String(
  element?.poster || element?.thumbnail_url || element?.preview_image_url || "",
);

const StoryboardPanel = ({
  value,
  onChange,
  elements = [],
  onGenerateImage,
  onGenerateVideo,
  onAddToTimeline,
  onFocusElement,
  imageGenerating = false,
  videoGenerating = false,
  imageModelLabel = "",
  videoModelLabel = "",
  ui,
  t,
}) => {
  const shots = normalizeShots(value, t);
  const update = (nextShots) => onChange({ ...(value || {}), shots: nextShots });

  const addShot = () => update([
    ...shots,
    {
      id: makeShotId(),
      title: t(`镜头 ${shots.length + 1}`, `Shot ${shots.length + 1}`),
      description: "",
      prompt: "",
      duration: 3,
      camera: "",
      style: "",
      elementId: null,
      generationStatus: "idle",
    },
  ]);

  const patchShot = (id, patch) => update(shots.map((shot) => shot.id === id ? { ...shot, ...patch } : shot));
  const removeShot = (id) => update(shots.filter((shot) => shot.id !== id));
  const moveShot = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= shots.length) return;
    const next = [...shots];
    [next[index], next[target]] = [next[target], next[index]];
    update(next);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-widest font-bold" style={{ color: ui.faint }}>
            {t("影视分镜", "Storyboard")}
          </p>
          <p className="text-sm font-bold mt-1" style={{ color: ui.text }}>
            {shots.length} {t("个镜头", "shots")}
          </p>
        </div>
        <button
          type="button"
          onClick={addShot}
          className="rounded-xl px-3 py-2 text-xs font-bold inline-flex items-center gap-1"
          style={{ background: ui.blueSoft, color: ui.blue, border: `1px solid ${ui.blueLine}` }}
        >
          <span className="material-symbols-outlined text-[16px]">add</span>
          {t("添加镜头", "Add shot")}
        </button>
      </div>

      {shots.length === 0 ? (
        <div className="rounded-2xl p-4 text-center text-xs" style={{ background: ui.panelSolid, color: ui.muted, border: `1px dashed ${ui.line2}` }}>
          {t("先添加镜头，再把提示词交给 Agent 或生成器。", "Add a shot, then hand its prompt to the Agent or generator.")}
        </div>
      ) : shots.map((shot, index) => {
        const boundElement = getStoryboardBoundElement(shot, elements);
        const mediaUrl = getElementMediaUrl(boundElement);
        const isGenerating = shot.generationStatus === "generating";
        const canGenerate = Boolean(shot.prompt.trim()) && !isGenerating;
        const hasTimelineClip = Boolean(shot.timelineClipId);
        return (
        <div key={shot.id} className="rounded-2xl p-3 space-y-3" style={{ background: ui.panelSolid, border: `1px solid ${ui.line}` }}>
          <div className="flex items-center gap-2">
            <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black" style={{ background: ui.blueSoft, color: ui.blue }}>
              {index + 1}
            </span>
            <input
              value={shot.title}
              onChange={(event) => patchShot(shot.id, { title: event.target.value.slice(0, 120) })}
              className="flex-1 rounded-lg px-2.5 py-2 text-xs font-bold outline-none"
              style={inputStyle(ui)}
              aria-label={t("镜头标题", "Shot title")}
            />
            <button type="button" onClick={() => moveShot(index, -1)} disabled={index === 0} className="w-7 h-7 rounded-lg disabled:opacity-30" style={{ background: ui.soft, color: ui.muted }} title={t("上移", "Move up")}>
              <span className="material-symbols-outlined text-[15px]">arrow_upward</span>
            </button>
            <button type="button" onClick={() => moveShot(index, 1)} disabled={index === shots.length - 1} className="w-7 h-7 rounded-lg disabled:opacity-30" style={{ background: ui.soft, color: ui.muted }} title={t("下移", "Move down")}>
              <span className="material-symbols-outlined text-[15px]">arrow_downward</span>
            </button>
            <button type="button" onClick={() => removeShot(shot.id)} className="w-7 h-7 rounded-lg" style={{ background: ui.dangerSoft, color: ui.danger }} title={t("删除镜头", "Delete shot")}>
              <span className="material-symbols-outlined text-[15px]">delete</span>
            </button>
          </div>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-2">
              <textarea
                value={shot.prompt}
                onChange={(event) => patchShot(shot.id, { prompt: event.target.value.slice(0, 3000) })}
                rows={3}
                placeholder={t("镜头提示词、动作和画面内容", "Shot prompt, action and visual direction")}
                className="w-full rounded-xl px-3 py-2 text-xs outline-none resize-y"
                style={inputStyle(ui)}
              />
              <div className="grid grid-cols-3 gap-2">
                <label className="text-[10px]" style={{ color: ui.faint }}>
                  {t("时长（秒）", "Duration (s)")}
                  <input type="number" min="0.1" max="3600" step="0.1" value={shot.duration} onChange={(event) => patchShot(shot.id, { duration: event.target.value })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={inputStyle(ui)} />
                </label>
                <label className="text-[10px]" style={{ color: ui.faint }}>
                  {t("摄影", "Camera")}
                  <input value={shot.camera} onChange={(event) => patchShot(shot.id, { camera: event.target.value })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={inputStyle(ui)} />
                </label>
                <label className="text-[10px]" style={{ color: ui.faint }}>
                  {t("画风", "Style")}
                  <input value={shot.style} onChange={(event) => patchShot(shot.id, { style: event.target.value })} className="mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" style={inputStyle(ui)} />
                </label>
              </div>
            </div>
            <div className="relative min-h-32 overflow-hidden rounded-xl flex items-center justify-center" style={{ background: ui.soft, border: `1px solid ${ui.line}` }}>
              {boundElement?.type === "video" && mediaUrl ? (
                <OssVideo src={mediaUrl} poster={getElementPosterUrl(boundElement)} muted playsInline preload="metadata" className="h-full min-h-32 w-full object-cover" />
              ) : boundElement?.type === "image" && mediaUrl ? (
                <OssImage src={mediaUrl} alt={shot.title} className="h-full min-h-32 w-full object-cover" />
              ) : (
                <div className="px-4 text-center text-[11px] leading-5" style={{ color: ui.faint }}>
                  <span className="material-symbols-outlined block text-3xl">movie_creation</span>
                  {isGenerating ? t("正在生成并写入画布", "Generating and adding to canvas") : t("生成结果会自动绑定到这里", "The generated result will be bound here")}
                </div>
              )}
              {isGenerating && <span className="material-symbols-outlined absolute right-2 top-2 animate-spin text-[18px]" style={{ color: ui.blue }}>progress_activity</span>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onGenerateImage?.(shot)} disabled={!canGenerate || imageGenerating} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1 disabled:opacity-35" style={{ background: ui.goldSoft, color: ui.gold, border: `1px solid ${ui.goldLine || ui.line}` }} title={imageModelLabel || undefined}>
              <span className="material-symbols-outlined text-[16px]">image</span>
              {t("生成图片", "Generate image")}
            </button>
            <button type="button" onClick={() => onGenerateVideo?.(shot)} disabled={!canGenerate || videoGenerating} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1 disabled:opacity-35" style={{ background: ui.blueSoft, color: ui.blue, border: `1px solid ${ui.blueLine}` }} title={videoModelLabel || undefined}>
              <span className="material-symbols-outlined text-[16px]">movie_filter</span>
              {t("生成视频", "Generate video")}
            </button>
            <button type="button" onClick={() => onAddToTimeline?.(shot)} disabled={!boundElement || isGenerating} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1 disabled:opacity-35" style={{ background: ui.panelSolid, color: hasTimelineClip ? ui.blue : ui.text, border: `1px solid ${hasTimelineClip ? ui.blueLine : ui.line}` }}>
              <span className="material-symbols-outlined text-[16px]">playlist_add</span>
              {hasTimelineClip ? t("更新时间线片段", "Update timeline clip") : t("加入时间线", "Add to timeline")}
            </button>
            {boundElement && (
              <button type="button" onClick={() => onFocusElement?.(boundElement.id)} className="rounded-xl px-3 py-2 text-[11px] font-bold inline-flex items-center gap-1" style={{ background: ui.soft, color: ui.muted, border: `1px solid ${ui.line}` }}>
                <span className="material-symbols-outlined text-[16px]">center_focus_strong</span>
                {t("在画布定位", "Locate on canvas")}
              </button>
            )}
            <span className="ml-auto text-[10px]" style={{ color: shot.generationStatus === "failed" ? ui.danger : ui.faint }}>
              {shot.generationStatus === "failed"
                ? (shot.generationError || t("生成失败", "Generation failed"))
                : shot.generationStatus === "completed"
                  ? t(`已绑定${shot.generationType === "video" ? "视频" : "图片"}`, `Bound ${shot.generationType || "media"}`)
                  : imageModelLabel && videoModelLabel
                    ? `${t("当前模型", "Models")}: ${imageModelLabel} / ${videoModelLabel}`
                    : ""}
            </span>
          </div>
        </div>
        );
      })}
    </div>
  );
};

export default StoryboardPanel;
