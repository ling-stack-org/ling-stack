import { lingDarkTheme } from "./ling-dark.js";
import { lingLightTheme } from "./ling-light.js";

export { lingDarkTheme, lingLightTheme };

export const builtInThemeManifests = [lingLightTheme, lingDarkTheme] as const;
export const builtInThemeIds = ["ling-light", "ling-dark"] as const;
export type BuiltInThemeId = typeof builtInThemeIds[number];
