import { createContext, useContext, useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "stardraw_locale";

const LanguageContext = createContext(null);

export const LanguageProvider = ({ children }) => {
  const [locale, setLocale] = useState(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    return saved || "zh-CN";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, locale);
      document.documentElement.lang = locale === "zh-CN" ? "zh-CN" : "en";
    }
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    isZh: locale === "zh-CN",
    setLocale,
    toggleLocale: () => setLocale((prev) => (prev === "zh-CN" ? "en" : "zh-CN")),
    t: (zh, en) => (locale === "zh-CN" ? zh : en),
  }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

// eslint-disable-next-line react-refresh/only-export-components
export const useLanguage = () => {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
};
