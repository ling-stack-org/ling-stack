import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <LingUiProvider>
          <App />
        </LingUiProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
