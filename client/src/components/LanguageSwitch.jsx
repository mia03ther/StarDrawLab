import { useLanguage } from "../contexts/LanguageContext";
import { useStarDrawTheme } from "../utils/stardrawTheme";

const LanguageSwitch = () => {
  const { locale, setLocale, isZh } = useLanguage();
  const { ui } = useStarDrawTheme();

  return (
    <div
      className="inline-flex items-center p-1 rounded-full"
      style={{ background: ui.surface, border: `1px solid ${ui.lineStrong}` }}
    >
      {[
        { key: "zh-CN", label: "中文" },
        { key: "en", label: "EN" },
      ].map((item) => {
        const active = locale === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => setLocale(item.key)}
            className="px-3 py-1.5 rounded-full text-xs font-bold transition-all"
            style={{
              background: active ? ui.primary : "transparent",
              color: active ? ui.primaryText : ui.faint,
              minWidth: isZh ? 54 : 44,
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
};

export default LanguageSwitch;
