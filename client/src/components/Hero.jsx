import { useNavigate } from "react-router-dom";
import { assets } from "../assets/assets";
import { useLanguage } from "../contexts/LanguageContext";

const Hero = () => {
  const navigate = useNavigate();
  const { t } = useLanguage();

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden px-4 pt-28 sm:px-20 xl:px-32 bg-[radial-gradient(900px_circle_at_50%_15%,rgba(109,94,252,0.22),transparent_60%),radial-gradient(800px_circle_at_15%_85%,rgba(56,189,248,0.10),transparent_55%)]">
      <div className="pointer-events-none absolute inset-0 opacity-40" />

      <div className="mx-auto w-full max-w-5xl text-center">
        <div className="mb-6">
          <h1 className="mx-auto max-w-4xl text-3xl font-semibold leading-[1.15] text-slate-100 sm:text-5xl md:text-6xl">
            {t("安静地创作出色作品", "Create quietly exceptional assets")}
            <br />
            <span className="text-primary">{t("服务电商创作", "for e-commerce")}</span>
          </h1>
          <p className="qa-muted mx-auto mt-4 max-w-xl text-sm leading-6 sm:text-base">
            {t("面向场景图片和短视频的简洁创作工具。高效制作、导出并交付。", "A minimal, tech-forward suite for scene images and short promo videos. Build, export, and ship without noise.")}
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-3 text-sm">
          <button onClick={() => navigate("/ai")} className="qa-btn qa-btn-primary px-7 py-2.5" type="button">
            {t("打开工作台", "Open workspace")}
          </button>
          <button className="qa-btn qa-btn-ghost px-7 py-2.5" type="button">
            {t("观看演示", "Watch demo")}
          </button>
        </div>

        <div className="qa-muted mx-auto mt-8 flex items-center justify-center gap-3 text-sm">
          <img src={assets.user_group} alt="users" className="h-8 opacity-90" />
          {t("受到创作者和运营团队信赖", "Trusted by creators and operators")}
        </div>
      </div>

      <div className="mt-16 w-full overflow-hidden">
        <div className="mx-auto w-full max-w-5xl">
          <div className="flex gap-12 whitespace-nowrap opacity-80 animate-marquee">
            <img
              src={assets.facebook}
              alt="Facebook"
              className="h-8 inline-block opacity-70"
            />
            <img src={assets.slack} alt="Slack" className="h-8 inline-block opacity-70" />
            <img
              src={assets.framer}
              alt="Framer"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.netflix}
              alt="Netflix"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.google}
              alt="Google"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.linkedin}
              alt="LinkedIn"
              className="h-8 inline-block opacity-70"
            />

            {/* Duplicate for seamless loop */}
            <img
              src={assets.facebook}
              alt="Facebook"
              className="h-8 inline-block opacity-70"
            />
            <img src={assets.slack} alt="Slack" className="h-8 inline-block opacity-70" />
            <img
              src={assets.framer}
              alt="Framer"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.netflix}
              alt="Netflix"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.google}
              alt="Google"
              className="h-8 inline-block opacity-70"
            />
            <img
              src={assets.linkedin}
              alt="LinkedIn"
              className="h-8 inline-block opacity-70"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Hero;
