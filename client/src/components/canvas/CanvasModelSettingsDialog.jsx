import { Bot, Check, Film, Image as ImageIcon, Settings2, X } from "lucide-react";

import CanvasIconButton from "./CanvasIconButton";
import CanvasRoundedSelect from "./CanvasRoundedSelect";

const MODEL_GROUPS = [
  { key: "textModel", catalog: "text", icon: Bot, zh: "文本模型", en: "Text model", detailZh: "负责理解指令、对话与逐步工具决策", detailEn: "Understands requests and decides each tool action" },
  { key: "imageModel", catalog: "image", icon: ImageIcon, zh: "图片模型", en: "Image model", detailZh: "画布 Agent 默认使用的图片生成模型", detailEn: "Default image model used by the Canvas Agent" },
  { key: "videoModel", catalog: "video", icon: Film, zh: "视频模型", en: "Video model", detailZh: "画布 Agent 默认使用的视频生成模型", detailEn: "Default video model used by the Canvas Agent" },
];

const CanvasModelSettingsDialog = ({ open, onClose, preferences, catalogs, onChange, saving, ui, t }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={t("画布 Agent 模型设置", "Canvas Agent model settings")}>
      <button type="button" className="absolute inset-0 cursor-default bg-black/45 backdrop-blur-sm" onClick={onClose} aria-label={t("关闭模型设置", "Close model settings")} />
      <section className="relative z-10 w-full max-w-[680px] overflow-hidden rounded-[24px] border shadow-[0_24px_80px_rgba(0,0,0,.3)]" style={{ background: ui.panelStrong, borderColor: ui.line, color: ui.text }}>
        <header className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: ui.line }}>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.gold }}><Settings2 size={17} /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">{t("画布 Agent 默认模型", "Canvas Agent default models")}</h2>
              <p className="mt-0.5 text-[11px]" style={{ color: ui.faint }}>{t("选择会保存到账号，新对话自动继承", "Selections are saved to your account and inherited by new conversations")}</p>
            </div>
          </div>
          <CanvasIconButton label={t("关闭", "Close")} tooltipSide="bottom" onClick={onClose} style={{ background: ui.soft, color: ui.muted }}><X size={13} /></CanvasIconButton>
        </header>

        <div className="divide-y px-5" style={{ borderColor: ui.line }}>
          {MODEL_GROUPS.map((group) => {
            const Icon = group.icon;
            const options = catalogs?.[group.catalog] || [];
            return (
              <label key={group.key} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)] sm:items-center">
                <span className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: ui.soft, color: ui.muted }}><Icon size={15} /></span>
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">{t(group.zh, group.en)}</span>
                    <span className="mt-0.5 block text-[10px] leading-4" style={{ color: ui.faint }}>{t(group.detailZh, group.detailEn)}</span>
                  </span>
                </span>
                <CanvasRoundedSelect
                  label={t(group.zh, group.en)}
                  value={preferences?.[group.key] || ""}
                  options={options}
                  onChange={(value) => onChange({ [group.key]: value })}
                  disabled={saving}
                  placeholder={t("暂无可用模型", "No available models")}
                  ui={{ ...ui, soft: ui.inspectorInput }}
                  className="w-full"
                  triggerClassName="w-full"
                  menuMinWidth={280}
                />
              </label>
            );
          })}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t px-5 py-3" style={{ background: ui.soft, borderColor: ui.line }}>
          <span className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: ui.faint }}><Check size={12} style={{ color: ui.gold }} />{saving ? t("正在保存…", "Saving...") : t("设置按账号记忆", "Remembered for this account")}</span>
          <button type="button" onClick={onClose} className="h-8 rounded-full px-4 text-[11px] font-semibold shadow-sm" style={{ background: ui.accent, color: ui.accentText }}>{t("完成", "Done")}</button>
        </footer>
      </section>
    </div>
  );
};

export default CanvasModelSettingsDialog;
