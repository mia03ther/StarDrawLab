import { useState } from "react";
import { Download } from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";

const CreationItem = ({ item, expired, onDownload }) => {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const statusLabels = { completed: t("已完成", "completed"), pending: t("排队中", "pending"), running: t("执行中", "running"), processing: t("处理中", "processing"), failed: t("失败", "failed") };
  const typeLabels = { image: t("图片", "image"), video: t("视频", "video") };

  const statusColor = {
    completed: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
    pending:   "text-yellow-400 border-yellow-400/30 bg-yellow-400/10",
    running:   "text-blue-400 border-blue-400/30 bg-blue-400/10",
    failed:    "text-red-400 border-red-400/30 bg-red-400/10",
  }[item.status] ?? "text-slate-400 border-white/10 bg-white/5";

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className="qa-card qa-card-hover max-w-5xl cursor-pointer p-4 text-sm"
    >
      <div className="flex justify-between items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-slate-100">
            {item.scene_name || item.scene_key || item.type}
          </h2>
          <p className="qa-muted mt-0.5 text-xs truncate">{item.prompt}</p>
          <div className="qa-muted mt-1 flex items-center gap-3 text-xs">
            <span>{new Date(item.created_at).toLocaleDateString()}</span>
            {item.points_cost > 0 && <span>{item.points_cost} {t("积分", "pts")}</span>}
            {expired && <span className="text-red-400">{t("已过期", "Expired")}</span>}
            {item.expires_at && !expired && (
              <span>{t("到期时间", "Expires")} {new Date(item.expires_at).toLocaleDateString()}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusColor}`}>
            {statusLabels[item.status] || item.status}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-slate-300">
            {typeLabels[item.type] || item.type}
          </span>
          {item.status === "completed" && !expired && onDownload && (
            <button
              className="qa-btn qa-btn-ghost py-1 px-2"
              onClick={(e) => { e.stopPropagation(); onDownload(); }}
              type="button"
              title={t("下载", "Download")}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-4" onClick={(e) => e.stopPropagation()}>
          {item.type === "image" && item.content ? (
            <img
              src={item.content}
              alt="generated"
              className="w-full max-w-md rounded-lg border border-white/10"
            />
          ) : item.type === "video" && item.content ? (
            <video
              className="w-full max-w-2xl rounded-lg border border-white/10"
              controls
              src={item.content}
              poster={item.thumbnail_url || undefined}
            />
          ) : item.status === "failed" ? (
            <p className="text-xs text-red-400">{item.error_message || t("生成失败。", "Generation failed.")}</p>
          ) : null}
        </div>
      )}
    </div>
  );
};

export default CreationItem;
