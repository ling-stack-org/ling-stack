export * from "./types.js";
export * from "./token-map.js";
export * from "./validate-theme.js";
export * from "./theme-registry.js";
export * from "./apply-theme.js";
export * from "./built-ins/index.js";
export * from "./presentation/profile-types.js";
export * from "./presentation/built-in-profiles.js";
export * from "./presentation/profile-registry.js";
export * from "./compiler/compiler-types.js";
export * from "./compiler/analyze-image.js";
export * from "./compiler/color-utils.js";
export * from "./compiler/derive-tokens.js";
export * from "./compiler/compile-artwork.js";
export * from "./compiler/compile-theme.js";
export * from "./import/package-types.js";
export * from "./import/validate-package-index.js";
export * from "./import/inspect-zip-central-directory.js";
export * from "./import/theme-image-validation.js";
export * from "./import/parse-theme-package-bytes.js";

import { builtInThemeManifests } from "./built-ins/index.js";

export const builtInThemes = builtInThemeManifests.map((manifest) => ({
  id: manifest.id,
  colorScheme: manifest.colorScheme,
  label: manifest.name,
}));

export type LingThemeDescriptor = typeof builtInThemes[number];
