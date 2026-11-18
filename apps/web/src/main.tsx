import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { CompanionDesktopWindow } from "./features/companions/CompanionDesktopWindow.js";
import { App } from "./App.js";
import { I18nProvider } from "./i18n.js";
import { LingUiProvider } from "./shared/ui/index.js";
import { ThemeProvider } from "./theme.js";
import "./styles.css";
import "katex/dist/katex.min.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

const companionWindow = Boolean(window.lingCompanionDesktop) && new URLSearchParams(window.location.search).get("companionWindow") === "1";
if (companionWindow) document.documentElement.dataset.companionWindow = "true";

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <LingUiProvider>
          {companionWindow ? <CompanionDesktopWindow /> : <App />}
        </LingUiProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
