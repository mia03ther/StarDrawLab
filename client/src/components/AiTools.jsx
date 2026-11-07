import { useNavigate } from "react-router-dom";
import { Image, Video, Sparkles } from "lucide-react";
import { useLanguage } from "../contexts/LanguageContext";

const AiToolsData = [
  {
    title: "Scene Image Generator",
    description: "Generate high-quality scene images for e-commerce products",
    Icon: Image,
    bg: { from: "#3C81F6", to: "#9234EA" },
    path: "/ai/scene-image"
  },
  {
    title: "AI Video Generator",
    description: "Create stunning promotional videos using AI",
    Icon: Video,
    bg: { from: "#FF61C5", to: "#9E53EE" },
    path: "/ai/ai-video"
  }
];

const AiTools = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const tools = AiToolsData.map((tool) => ({
    ...tool,
    title: tool.path.endsWith("scene-image") ? t("场景图片生成", "Scene Image Generator") : t("AI 视频生成", "AI Video Generator"),
    description: tool.path.endsWith("scene-image") ? t("为电商产品生成高质量场景图片", "Generate high-quality scene images for e-commerce products") : t("使用 AI 创建精彩宣传视频", "Create stunning promotional videos using AI"),
  }));

  return (
    <div className="mx-auto my-20 max-w-6xl px-4 sm:px-8">
      <div className="text-center">
        <h2 className="text-3xl font-semibold text-slate-100 sm:text-4xl">{t("工具", "Tools")}</h2>
        <p className="qa-muted mx-auto mt-3 max-w-lg text-sm leading-6">
          {t("简洁实用的图片和短视频生成工具。", "Minimal, production-minded generators for images and short video.")}
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {tools.map((tool, index) => (
          <div
            key={index}
            onClick={() => navigate(tool.path)}
            className="qa-card qa-card-hover cursor-pointer p-6"
          >
            <tool.Icon
              className="h-12 w-12 rounded-xl p-3 text-white"
              style={{
                background: `linear-gradient(to bottom, ${tool.bg.from}, ${tool.bg.to})`,
              }}
            />
            <h3 className="mt-5 text-lg font-semibold text-slate-100">{tool.title}</h3>
            <p className="qa-muted mt-2 text-sm leading-6">
              {tool.description}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default AiTools;
