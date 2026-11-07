import { createRoot } from "react-dom/client";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "@fontsource/material-symbols-outlined/400.css";
import "./index.css";
import App from "./App.jsx";
import { BrowserRouter } from "react-router-dom";
import { AuthingProvider } from "./contexts/AuthingContext.jsx";
import { OssResourceAccessProvider } from "./contexts/OssResourceAccessContext.jsx";
import { LanguageProvider } from "./contexts/LanguageContext.jsx";
import AppErrorBoundary from "./components/AppErrorBoundary.jsx";
import { installChunkLoadRecovery } from "./utils/clientRuntimeRecovery.js";

installChunkLoadRecovery();

const revealMaterialSymbols = () => {
  const root = document.documentElement;
  let settled = false;
  let fallbackTimer;
  const finish = (ready) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(fallbackTimer);
    root.classList.remove("stardraw-icons-loading");
    root.classList.toggle("stardraw-icons-ready", ready);
    root.classList.toggle("stardraw-icons-fallback", !ready);
  };
  const stylesheet = document.querySelector("link[data-stardraw-material-symbols]");
  fallbackTimer = window.setTimeout(() => finish(false), 2500);

  // The HTML gate prevents the raw ligature text from appearing before the
  // app stylesheet is active. Wait for the font stylesheet itself as well as
  // the font face: document.fonts.load() can otherwise resolve before a
  // stylesheet discovered late in the document has registered its face.
  const loadFont = () => {
    if (!document.fonts?.load) {
      finish(false);
      return;
    }

    document.fonts.load('400 24px "Material Symbols Outlined"', "check")
      .then((faces) => finish(Array.isArray(faces) && faces.length > 0))
      .catch(() => finish(false));
  };

  if (stylesheet && !stylesheet.sheet) {
    stylesheet.addEventListener("load", loadFont, { once: true });
    stylesheet.addEventListener("error", () => finish(false), { once: true });
  } else {
    loadFont();
  }
};

createRoot(document.getElementById("root")).render(
  <AppErrorBoundary>
    <AuthingProvider>
      <OssResourceAccessProvider>
        <LanguageProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </LanguageProvider>
      </OssResourceAccessProvider>
    </AuthingProvider>
  </AppErrorBoundary>
);

revealMaterialSymbols();
