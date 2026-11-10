import { contrastRatio, mixHex, isCompilerHex } from "../compiler/color-utils.js";
import { BACKGROUND_OPACITY } from "./background-model.js";
import type { LingPresentationSurface } from "../presentation/profile-types.js";

export function backgroundSurfaceOpacity(opacity: number, surface: LingPresentationSurface): number {
  return surface === "home" || surface === "sidebar" ? opacity : Math.min(opacity, 0.45);
}

export function backgroundRecipe(opacity: number = BACKGROUND_OPACITY.default) {
  const clamped = Math.min(BACKGROUND_OPACITY.maximum, Math.max(BACKGROUND_OPACITY.minimum, opacity));
  const scrim = 1 - clamped;
  return {
    opacity: clamped,
    scrim,
    panel: Math.min(0.94, 0.68 + scrim * 0.48),
    sidebar: 0.68,
  };
}

/** Canvas tint follows visibility; display text and content protect themselves locally. */
export function resolveBackgroundWorkspaceAlpha(input: {
  app: string; panel: string; opacity: number; baseAlpha?: number;
}): number {
  if (![input.app, input.panel].every(isCompilerHex)) return 1;
  return materialAlpha(input.baseAlpha, 0) * backgroundRecipe(input.opacity).scrim;
}

/** Unknown color syntax stays opaque; tokens are never rewritten to improve visibility. */
export function resolveBackgroundPanelAlpha(input: {
  app: string; panel: string; opacity: number;
  minimumAlpha?: number;
  foregrounds: readonly { color: string; minimum: number }[];
}): number {
  if (![input.app, input.panel, ...input.foregrounds.map(item => item.color)].every(isCompilerHex)) return 1;
  const recipe = backgroundRecipe(input.opacity);
  for (let step = Math.ceil(Math.max(recipe.panel, materialAlpha(input.minimumAlpha, 0)) * 100); step <= 100; step++) {
    const alpha = step / 100;
    const backgrounds = ["#000000", "#ffffff"].map(image => mixHex(mixHex(image, input.app, recipe.scrim), input.panel, alpha));
    if (input.foregrounds.every(({ color, minimum }) => backgrounds.every(background => contrastRatio(color, background) >= minimum))) return alpha;
  }
  return 1;
}

/** Navigation chrome is a structural surface; interaction states carry local text protection. */
export function resolveBackgroundSidebarAlpha(input: { app: string; sidebar: string; minimumAlpha?: number }): number {
  if (![input.app, input.sidebar].every(isCompilerHex)) return 1;
  return materialAlpha(input.minimumAlpha, backgroundRecipe().sidebar);
}

function materialAlpha(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.min(1, value));
}
