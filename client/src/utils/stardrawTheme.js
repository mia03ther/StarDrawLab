import { useEffect, useState } from "react";

export const normalizeStarDrawTheme = (value) => (value === "day" ? "day" : "night");

export const readStarDrawTheme = () => {
  if (typeof window === "undefined") return "night";
  return normalizeStarDrawTheme(window.localStorage.getItem("stardraw_theme"));
};

export const stardrawThemeTokens = {
  night: {
    page: "#0d1117",
    surface: "rgba(23, 30, 38, 0.74)",
    surfaceAlt: "rgba(12, 17, 23, 0.72)",
    surfaceHigh: "rgba(39, 48, 58, 0.76)",
    surfaceRaised: "#262a31",
    text: "#dfe2eb",
    muted: "#c2c7d0",
    faint: "#8f9095",
    line: "rgba(255,255,255,0.10)",
    lineStrong: "rgba(255,255,255,0.18)",
    primary: "#ee9d47",
    primaryStrong: "#d77b2c",
    primaryText: "#2b1708",
    primarySoft: "rgba(238,157,71,0.14)",
    gold: "#e9c349",
    goldSoft: "rgba(233,195,73,0.12)",
    danger: "#ffb4ab",
    dangerSoft: "rgba(255,180,171,0.12)",
    success: "#52d87a",
    overlay: "rgba(16,20,26,0.85)",
    shadow: "0 24px 70px rgba(0,0,0,0.36)",
    buttonGradient: "linear-gradient(135deg, #f2ad61 0%, #cf6f26 100%)",
  },
  day: {
    page: "#f7f5f0",
    surface: "#ffffff",
    surfaceAlt: "#f4f1ea",
    surfaceHigh: "#ece8df",
    surfaceRaised: "#e9e4da",
    text: "#171717",
    muted: "#525866",
    faint: "#818792",
    line: "rgba(30,34,42,0.12)",
    lineStrong: "rgba(30,34,42,0.22)",
    primary: "#c56b23",
    primaryStrong: "#a94f18",
    primaryText: "#fffaf2",
    primarySoft: "rgba(197,107,35,0.12)",
    gold: "#9a6a00",
    goldSoft: "rgba(154,106,0,0.10)",
    danger: "#b42318",
    dangerSoft: "rgba(180,35,24,0.10)",
    success: "#147a45",
    overlay: "rgba(255,255,255,0.88)",
    shadow: "0 18px 44px rgba(30,34,42,0.10)",
    buttonGradient: "linear-gradient(135deg, #d27c35 0%, #a94f18 100%)",
  },
};

export const useStarDrawTheme = () => {
  const [theme, setTheme] = useState(readStarDrawTheme);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const syncTheme = (event) => {
      setTheme(normalizeStarDrawTheme(event?.detail?.theme || readStarDrawTheme()));
    };
    const handleStorage = (event) => {
      if (event.key === "stardraw_theme") syncTheme(event);
    };

    window.addEventListener("stardraw:theme-change", syncTheme);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("stardraw:theme-change", syncTheme);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  return {
    theme,
    isDay: theme === "day",
    ui: stardrawThemeTokens[theme] || stardrawThemeTokens.night,
  };
};
