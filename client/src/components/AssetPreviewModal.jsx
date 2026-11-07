import { useEffect } from "react";
import { useLanguage } from "../contexts/LanguageContext";
import { OssImage, OssVideo } from "./OssMedia";

const getPreviewMedia = (item) => {
  const isCompletedVideo = item.type === "video" && item.status === "completed";
  const videoUrl = item.preview_video_url || (isCompletedVideo ? item.content : null);
  const imageUrl = item.reference_preview_url
    || item.preview_image_url
    || item.thumbnail_url
    || (item.type === "image" ? item.content : null);

  if (isCompletedVideo && videoUrl) return { type: "video", src: videoUrl, poster: imageUrl };
  if (imageUrl) return { type: "image", src: imageUrl };
  return null;
};

const AssetPreviewModal = ({ item, onClose, ui }) => {
  const { t } = useLanguage();
  const media = getPreviewMedia(item);

  useEffect(() => {
    if (!media) return undefined;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [media, onClose]);

  if (!media) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("预览素材", "Preview asset")}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-8"
      style={{ background: "rgba(3, 7, 18, 0.88)", backdropFilter: "blur(14px)" }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="relative inline-flex max-h-full max-w-6xl items-center justify-center"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {media.type === "video" ? (
          <OssVideo
            src={media.src}
            poster={media.poster || undefined}
            controls
            autoPlay
            playsInline
            preload="metadata"
            className="max-h-full max-w-full object-contain"
            style={{ maxHeight: "calc(100vh - 4rem)", maxWidth: "calc(100vw - 2rem)" }}
          />
        ) : (
          <OssImage
            src={media.src}
            alt={item.scene_name || t("生成素材", "Generated asset")}
            className="max-h-full max-w-full object-contain"
            style={{ maxHeight: "calc(100vh - 4rem)", maxWidth: "calc(100vw - 2rem)" }}
          />
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("关闭预览", "Close preview")}
          className="absolute right-3 top-3 z-10 flex h-11 w-11 items-center justify-center rounded-full transition-opacity hover:opacity-80"
          style={{ background: ui.surface || ui.card, border: `1px solid ${ui.line}`, color: ui.text }}
        >
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
    </div>
  );
};

export default AssetPreviewModal;
