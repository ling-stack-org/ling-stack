import { lingDarkTheme } from "./ling-dark.js";
import { lingLightTheme } from "./ling-light.js";
import { lingBreezeTheme } from "./ling-breeze.js";
import { lingNightTheme } from "./ling-night.js";
import { lingOceanTheme } from "./ling-ocean.js";
import { lingJourneyTheme } from "./ling-journey.js";

export { lingBreezeTheme, lingDarkTheme, lingJourneyTheme, lingLightTheme, lingNightTheme, lingOceanTheme };

export const builtInThemeManifests = [lingLightTheme, lingDarkTheme, lingBreezeTheme, lingOceanTheme, lingNightTheme, lingJourneyTheme] as const;
export const builtInThemeIds = ["ling-light", "ling-dark", "ling-breeze", "ling-ocean", "ling-night", "ling-journey"] as const;
export type BuiltInThemeId = typeof builtInThemeIds[number];
