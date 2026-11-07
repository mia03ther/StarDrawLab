import axios from "axios";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import toast from "react-hot-toast";
import { Moon, Sun } from "lucide-react";
import LanguageSwitch from "../components/LanguageSwitch";
import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const apiBase = import.meta.env.VITE_BASE_URL || "";

const DigitalHumanCapture = () => {
  const { t } = useLanguage();
  const { theme, ui } = useStarDrawTheme();
  const { token } = useParams();
  const [role, setRole] = useState(null);
  const [file, setFile] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const toggleTheme = () => {
    const nextTheme = theme === "day" ? "night" : "day";
    window.localStorage.setItem("stardraw_theme", nextTheme);
    document.documentElement.dataset.stardrawTheme = nextTheme;
    window.dispatchEvent(new CustomEvent("stardraw:theme-change", { detail: { theme: nextTheme } }));
  };

  useEffect(() => {
    axios.get(`${apiBase}/api/public/capture/${token}`)
      .then((res) => setRole(res.data?.data || null))
      .catch(() => toast.error(t("采集链接无效或已过期", "This capture link is invalid or has expired")));
  }, [t, token]);

  const submit = async () => {
    if (!file) {
      toast.error(t("请先上传数字人形象图片", "Please upload a digital human portrait first"));
      return;
    }

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("asset", file);
      formData.append("role_name", role?.role_name || "");
      formData.append("role_description", role?.role_description || "");
      formData.append("prompt_text", role?.prompt_text || "");
      await axios.post(`${apiBase}/api/public/capture/${token}`, formData);
      setDone(true);
      toast.success(t("素材已提交", "Asset submitted"));
    } catch (err) {
      toast.error(err.response?.data?.message || t("提交失败", "Submission failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen px-5 py-8 transition-colors" style={{ background: ui.page, color: ui.text }}>
      <div className="mx-auto max-w-md">
        <div className="mb-7 flex items-center justify-end gap-2">
          <LanguageSwitch />
          <button
            type="button"
            onClick={toggleTheme}
            className="grid h-10 w-10 place-items-center rounded-full transition-colors"
            style={{ background: ui.surface, color: ui.muted, border: `1px solid ${ui.lineStrong}` }}
            aria-label={theme === "day" ? t("切换到夜间模式", "Switch to dark mode") : t("切换到日间模式", "Switch to light mode")}
          >
            {theme === "day" ? <Moon size={17} /> : <Sun size={17} />}
          </button>
        </div>
        <div className="mb-6">
          <p className="text-[11px] font-black uppercase tracking-[0.24em]" style={{ color: ui.gold }}>StarDraw {t("采集", "Capture")}</p>
          <h1 className="mt-2 text-3xl font-black">{t("数字人形象采集", "Digital Human Capture")}</h1>
          <p className="mt-3 text-sm leading-7" style={{ color: ui.muted }}>
            {t(
              "上传一张清晰的正面形象图，电脑端会自动进入角色创建流程。",
              "Upload a clear front-facing portrait. The desktop session will automatically continue to role creation.",
            )}
          </p>
        </div>

        <div className="rounded-3xl p-5" style={{ background: ui.surface, border: `1px solid ${ui.line}`, boxShadow: ui.shadow }}>
          <div className="mb-4 rounded-2xl p-4" style={{ background: ui.surfaceAlt }}>
            <p className="text-xs" style={{ color: ui.faint }}>{t("当前角色", "Current role")}</p>
            <p className="mt-1 font-bold">{role?.role_name || t("加载中...", "Loading...")}</p>
          </div>

          {done ? (
            <div className="rounded-2xl p-5 text-center" style={{ background: ui.primarySoft }}>
              <span className="material-symbols-outlined text-5xl" style={{ color: ui.success }}>check_circle</span>
              <p className="mt-3 font-bold">{t("提交完成", "Submission complete")}</p>
              <p className="mt-2 text-sm" style={{ color: ui.muted }}>
                {t("请回到电脑端查看角色创建进度。", "Return to the desktop to view role creation progress.")}
              </p>
            </div>
          ) : (
            <>
              <label className="block cursor-pointer rounded-2xl border border-dashed p-5 text-center transition-colors" style={{ background: ui.surfaceAlt, borderColor: ui.lineStrong }}>
                <span className="material-symbols-outlined text-5xl" style={{ color: ui.primary }}>add_photo_alternate</span>
                <p className="mt-2 font-bold">{t("上传形象图片", "Upload portrait")}</p>
                <p className="mt-1 text-xs" style={{ color: ui.faint }}>
                  {t("建议正面、光线清晰、无遮挡", "Use a front-facing, well-lit, unobstructed image")}
                </p>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => setFile(event.target.files?.[0] || null)}
                />
              </label>

              {file && (
                <p className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: ui.surfaceAlt, color: ui.muted }}>
                  {t("已选择：", "Selected: ")}{file.name}
                </p>
              )}

              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="mt-5 w-full rounded-2xl py-4 font-black transition-opacity disabled:opacity-50"
                style={{ background: ui.buttonGradient, color: ui.primaryText }}
              >
                {submitting ? t("提交中...", "Submitting...") : t("提交形象素材", "Submit portrait")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DigitalHumanCapture;
