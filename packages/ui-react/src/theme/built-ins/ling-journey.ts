import type { LingThemePackManifest } from "../types.js";

/**
 * The first Ling scene theme that is intentionally independent from the
 * unfinished Core IP. The scene is an anonymous farbound sword journey;
 * the background layer owns the narrative while the UI consumes semantics.
 */
export const lingJourneyTheme: LingThemePackManifest = Object.freeze({
  schemaVersion: 1,
  id: "ling-journey",
  name: "Ling 远行问剑",
  familyId: "ling-scenes",
  description: "An ink-wash sword-journey scene with four distinct travelers, different sword-lights, and a dangerous dead horizon.",
  author: "Ling Stack",
  license: "MIT",
  colorScheme: "dark",
  source: "built-in",
  tokens: {
    background: {
      app: "#0d141c",
      panel: "#111c27",
      elevated: "#182531",
      subtle: "#1b2a38",
      pressed: "#24384b",
      overlay: "rgb(4 10 15 / 66%)",
      code: "#0f1922",
      sidebar: "#101923",
      composer: "#111c27",
    },
    text: {
      strong: "#eef3f5",
      default: "#d2dde2",
      muted: "#9babb4",
      soft: "#758893",
      inverse: "#10161c",
      link: "#a8cbd4",
    },
    border: {
      default: "#2b3c49",
      strong: "#48606f",
      focus: "#c49a63",
    },
    action: {
      accent: "#c49a63",
      accentHover: "#d5b47d",
      accentPressed: "#9a7448",
      accentForeground: "#10161c",
      selection: "#304556",
    },
    status: {
      success: { foreground: "#8fb89b", background: "#182b24", border: "#345442" },
      warning: { foreground: "#d2ab68", background: "#302818", border: "#68532a" },
      danger: { foreground: "#d48779", background: "#301e22", border: "#65373b" },
      info: { foreground: "#83b8c8", background: "#182a33", border: "#3e626e" },
    },
    shadow: {
      low: "0 1px 2px rgb(0 0 0 / 30%)",
      medium: "0 8px 22px rgb(0 0 0 / 38%)",
      overlay: "0 12px 32px rgb(0 0 0 / 48%)",
    },
    native: {
      selection: "#304556",
      scrollbar: "#415765",
      scrollbarHover: "#617884",
    },
  },
  desktop: {
    windowBackground: "#0d141c",
    sidebarMaterial: "sidebar",
    overlayMaterial: "popover",
    titlebarForeground: "#eef3f5",
    shadowStrength: 0.56,
    blurStrength: 0,
  },
  presentation: { profileId: "ling-illustrated", artworkIntensity: "balanced", decorationSet: "none" },
  scene: { id: "farbound-journey", mascot: false, corners: false },
} satisfies LingThemePackManifest);
