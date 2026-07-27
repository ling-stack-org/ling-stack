import { lingDarkTheme } from "../built-ins/ling-dark.js";
import { lingLightTheme } from "../built-ins/ling-light.js";
import type { LingColorScheme, LingThemeTokens } from "../types.js";
import type { ThemePaletteCandidate } from "./compiler-types.js";
import { bestForeground, ensureContrast, mixHex, normalizeHex } from "./color-utils.js";

export function deriveThemeTokens(
  colorScheme: LingColorScheme,
  palette: ThemePaletteCandidate,
): LingThemeTokens {
  const base = colorScheme === "dark" ? lingDarkTheme.tokens : lingLightTheme.tokens;
  const seed = normalizeHex(palette.background, base.background.app);
  const rawAccent = normalizeHex(palette.accent, base.action.accent);
  const background = colorScheme === "dark"
    ? darkBackground(seed)
    : lightBackground(seed);
  const accentTarget = colorScheme === "dark" ? "#ffffff" : "#000000";
  const textTarget = colorScheme === "dark" ? "#ffffff" : "#000000";
  const focus = ensureContrast(rawAccent, background.panel, 3, accentTarget);
  const link = ensureContrast(rawAccent, background.panel, 4.5, accentTarget);
  const accentForeground = bestForeground(rawAccent);
  const text = Object.freeze({
    ...base.text,
    strong: ensureContrast(base.text.strong, background.panel, 7, textTarget),
    default: ensureContrast(base.text.default, background.panel, 4.5, textTarget),
    muted: ensureContrast(base.text.muted, background.panel, 4.5, textTarget),
    soft: ensureContrast(base.text.soft, background.panel, 3, textTarget),
    link,
  });

  return Object.freeze({
    background: Object.freeze(background),
    text,
    border: Object.freeze({
      default: mixHex(text.muted, background.panel, 0.68),
      strong: mixHex(text.muted, background.panel, 0.46),
      focus,
    }),
    action: Object.freeze({
      accent: rawAccent,
      accentHover: mixHex(rawAccent, accentForeground, 0.12),
      accentPressed: mixHex(rawAccent, accentForeground === "#ffffff" ? "#000000" : "#ffffff", 0.14),
      accentForeground,
      selection: mixHex(rawAccent, background.panel, colorScheme === "dark" ? 0.68 : 0.82),
    }),
    status: base.status,
    shadow: base.shadow,
    native: Object.freeze({
      selection: mixHex(rawAccent, background.panel, colorScheme === "dark" ? 0.56 : 0.74),
      scrollbar: mixHex(text.muted, background.app, 0.6),
      scrollbarHover: mixHex(text.muted, background.app, 0.38),
    }),
  });
}

function lightBackground(seed: string): LingThemeTokens["background"] {
  return {
    app: mixHex(seed, "#ffffff", 0.9),
    panel: mixHex(seed, "#ffffff", 0.97),
    elevated: mixHex(seed, "#ffffff", 0.985),
    subtle: mixHex(seed, "#ffffff", 0.86),
    pressed: mixHex(seed, "#ffffff", 0.77),
    overlay: "rgb(18 20 23 / 36%)",
    code: mixHex(seed, "#ffffff", 0.92),
    sidebar: mixHex(seed, "#ffffff", 0.95),
    composer: mixHex(seed, "#ffffff", 0.985),
  };
}

function darkBackground(seed: string): LingThemeTokens["background"] {
  return {
    app: mixHex(seed, "#000000", 0.82),
    panel: mixHex(seed, "#000000", 0.76),
    elevated: mixHex(seed, "#000000", 0.69),
    subtle: mixHex(seed, "#000000", 0.64),
    pressed: mixHex(seed, "#000000", 0.54),
    overlay: "rgb(0 0 0 / 58%)",
    code: mixHex(seed, "#000000", 0.8),
    sidebar: mixHex(seed, "#000000", 0.78),
    composer: mixHex(seed, "#000000", 0.72),
  };
}
