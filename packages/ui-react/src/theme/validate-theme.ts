import {
  DEFAULT_THEME_SELECTION,
  LING_PRESENTATION_PROFILE_IDS,
  LING_THEME_CSS_VARIABLES,
  LING_THEME_SCHEMA_VERSION,
  type LingBuiltInSceneId,
  type LingColorScheme,
  type LingPresentationProfileId,
  type LingThemeBootstrapSnapshot,
  type LingThemeCssVariable,
  type LingThemePackManifest,
  type LingThemeSource,
  type LingThemeValidationIssue,
  type LingThemeValidationResult,
  type ThemeSelection,
} from "./types.js";
import { themeTokensToCssVariables } from "./token-map.js";

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FAMILY_ID_PATTERN = THEME_ID_PATTERN;
const BUILT_IN_SCENE_IDS: readonly LingBuiltInSceneId[] = ["forest-breeze", "ocean-drift", "midnight-aurora", "farbound-journey"];
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const UNSAFE_CSS_PATTERN = /[;{}<>]|(?:url|var|env|attr|expression|image-set)\s*\(|@import/i;
const SAFE_SHADOW_PATTERN = /^[0-9a-z#(),.%/\s+-]+$/i;
const SAFE_MATERIAL_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ARTWORK_PATH_PATTERN = /^(?:assets\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:png|webp)$/;
const PREVIEW_PATH_PATTERN = /^(?:assets\/)?[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:jpe?g|png|webp)$/;
const COLOR_PATHS = [
  "background.app", "background.panel", "background.elevated", "background.subtle", "background.pressed",
  "background.overlay", "background.code", "background.sidebar", "background.composer",
  "text.strong", "text.default", "text.muted", "text.soft", "text.inverse", "text.link",
  "border.default", "border.strong", "border.focus",
  "action.accent", "action.accentHover", "action.accentPressed", "action.accentForeground", "action.selection",
  "status.success.foreground", "status.success.background", "status.success.border",
  "status.warning.foreground", "status.warning.background", "status.warning.border",
  "status.danger.foreground", "status.danger.background", "status.danger.border",
  "status.info.foreground", "status.info.background", "status.info.border",
  "native.selection", "native.scrollbar", "native.scrollbarHover",
] as const;
const SHADOW_PATHS = ["shadow.low", "shadow.medium", "shadow.overlay"] as const;

export interface ValidateThemeManifestOptions {
  readonly source?: LingThemeSource;
}

export function validateThemeManifest(
  value: unknown,
  options: ValidateThemeManifestOptions = {},
): LingThemeValidationResult {
  const issues: LingThemeValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid("invalid-schema", "$", "Theme manifest must be an object.");
  }
  if (value.schemaVersion !== LING_THEME_SCHEMA_VERSION) {
    issue(issues, "invalid-schema", "schemaVersion", "Only theme schema version 1 is supported.");
  }
  const id = readThemeId(value.id);
  if (!id) {
    issue(issues, "invalid-identity", "id", "Theme id must be lowercase ASCII kebab-case and at most 64 characters.");
  }
  const effectiveSource = options.source ?? readThemeSource(value.source);
  if (!effectiveSource) {
    issue(issues, "invalid-metadata", "source", "Theme source is not supported.");
  }
  if (id?.startsWith("ling-") && effectiveSource && effectiveSource !== "built-in") {
    issue(issues, "reserved-id", "id", "The ling-* namespace is reserved for built-in themes.");
  }
  validateText(issues, value.name, "name", 80, true);
  validateOptionalText(issues, value.familyId, "familyId", 64, FAMILY_ID_PATTERN);
  validateOptionalText(issues, value.description, "description", 240);
  validateOptionalText(issues, value.author, "author", 80);
  validateOptionalText(issues, value.license, "license", 80);
  validateOptionalHttpsUrl(issues, value.homepage, "homepage");
  validateOptionalArtworkPath(issues, value.preview, "preview");
  if (value.colorScheme !== "light" && value.colorScheme !== "dark") {
    issue(issues, "invalid-metadata", "colorScheme", "Theme colorScheme must be light or dark.");
  }

  if (!isRecord(value.tokens)) {
    issue(issues, "missing-token", "tokens", "Theme tokens must be a complete object.");
  } else {
    for (const path of COLOR_PATHS) validateColorToken(issues, value.tokens, path);
    for (const path of SHADOW_PATHS) validateShadowToken(issues, value.tokens, path);
    validateContrastPairs(issues, value.tokens);
  }
  validateDesktop(issues, value.desktop);
  validatePresentation(issues, value.presentation);
  validateArtwork(issues, value.artwork);
  validateScene(issues, value.scene, effectiveSource);
  validateGeneration(issues, value.generation);

  if (issues.length > 0 || !id || !effectiveSource) {
    return { ok: false, issues: Object.freeze(issues) };
  }
  const manifest = Object.freeze({
    ...(value as unknown as LingThemePackManifest),
    id,
    source: effectiveSource,
  });
  return {
    ok: true,
    candidate: Object.freeze({ manifest, variableMap: themeTokensToCssVariables(manifest.tokens) }),
  };
}

export function parseThemeSelection(value: unknown): ThemeSelection | undefined {
  if (!isRecord(value)) return undefined;
  if (value.mode === "fixed") {
    const themeId = readThemeId(value.themeId);
    return themeId ? Object.freeze({ mode: "fixed", themeId }) : undefined;
  }
  if (value.mode === "system") {
    const lightThemeId = readThemeId(value.lightThemeId);
    const darkThemeId = readThemeId(value.darkThemeId);
    return lightThemeId && darkThemeId
      ? Object.freeze({ mode: "system", lightThemeId, darkThemeId })
      : undefined;
  }
  return undefined;
}

export function parseThemeBootstrapSnapshot(value: unknown): LingThemeBootstrapSnapshot | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  const themeId = readThemeId(value.themeId);
  const colorScheme = readColorScheme(value.colorScheme);
  const source = value.source === "local-import" || value.source === "local-generated" ? value.source : undefined;
  const presentationProfileId = readPresentationProfile(value.presentationProfileId);
  if (!themeId || !colorScheme || !source || !presentationProfileId || !isRecord(value.variableMap)) return undefined;
  const keys = Object.keys(value.variableMap);
  if (keys.length !== LING_THEME_CSS_VARIABLES.length || keys.some((key) => !isThemeVariable(key))) return undefined;
  const variableMap = {} as Record<LingThemeCssVariable, string>;
  for (const variable of LING_THEME_CSS_VARIABLES) {
    const raw = value.variableMap[variable];
    if (typeof raw !== "string" || !isSafeThemeVariableValue(variable, raw)) return undefined;
    variableMap[variable] = raw.trim();
  }
  const packageChecksumSha256 = value.packageChecksumSha256 === undefined
    ? undefined
    : typeof value.packageChecksumSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.packageChecksumSha256)
      ? value.packageChecksumSha256
      : null;
  if (packageChecksumSha256 === null) return undefined;
  return Object.freeze({
    schemaVersion: 1,
    themeId,
    colorScheme,
    source,
    presentationProfileId,
    variableMap: Object.freeze(variableMap),
    ...(packageChecksumSha256 ? { packageChecksumSha256 } : {}),
  });
}

export function defaultThemeSelection(): ThemeSelection {
  return DEFAULT_THEME_SELECTION;
}

function validateColorToken(issues: LingThemeValidationIssue[], tokens: Record<string, unknown>, path: string): void {
  const value = readPath(tokens, path);
  if (typeof value !== "string") {
    issue(issues, "missing-token", `tokens.${path}`, "Required color token is missing.");
  } else if (!parseCssColor(value)) {
    issue(issues, "invalid-color", `tokens.${path}`, "Color must be a safe hex, rgb(a), hsl(a), or restricted color-mix value.");
  }
}

function validateShadowToken(issues: LingThemeValidationIssue[], tokens: Record<string, unknown>, path: string): void {
  const value = readPath(tokens, path);
  if (typeof value !== "string") {
    issue(issues, "missing-token", `tokens.${path}`, "Required shadow token is missing.");
  } else if (!isSafeShadow(value)) {
    issue(issues, "invalid-shadow", `tokens.${path}`, "Shadow contains an unsupported or executable CSS value.");
  }
}

function validateContrastPairs(issues: LingThemeValidationIssue[], tokens: Record<string, unknown>): void {
  const pairs: ReadonlyArray<readonly [string, string, number]> = [
    ["text.default", "background.panel", 4.5],
    ["text.muted", "background.panel", 4.5],
    ["border.focus", "background.panel", 3],
    ["action.accentForeground", "action.accent", 4.5],
    ["status.success.foreground", "status.success.background", 4.5],
    ["status.warning.foreground", "status.warning.background", 4.5],
    ["status.danger.foreground", "status.danger.background", 4.5],
    ["status.info.foreground", "status.info.background", 4.5],
  ];
  for (const [foregroundPath, backgroundPath, minimum] of pairs) {
    const foreground = readPath(tokens, foregroundPath);
    const background = readPath(tokens, backgroundPath);
    if (typeof foreground !== "string" || typeof background !== "string") continue;
    const foregroundColor = parseCssColor(foreground);
    const backgroundColor = parseCssColor(background);
    if (!foregroundColor || !backgroundColor) continue;
    if (contrastRatio(foregroundColor, backgroundColor) < minimum) {
      issue(issues, "insufficient-contrast", `tokens.${foregroundPath}`, `Contrast against ${backgroundPath} must be at least ${minimum}:1.`);
    }
  }
}

function validateDesktop(issues: LingThemeValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, "invalid-desktop-token", "desktop", "Desktop tokens must be an object.");
    return;
  }
  for (const key of ["windowBackground", "titlebarForeground"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !parseCssColor(value[key]))) {
      issue(issues, "invalid-desktop-token", `desktop.${key}`, "Desktop color token is invalid.");
    }
  }
  for (const key of ["sidebarMaterial", "overlayMaterial"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || !SAFE_MATERIAL_PATTERN.test(value[key]))) {
      issue(issues, "invalid-desktop-token", `desktop.${key}`, "Desktop material must be a safe identifier.");
    }
  }
  for (const key of ["shadowStrength", "blurStrength"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0 || value[key] > 100)) {
      issue(issues, "invalid-desktop-token", `desktop.${key}`, "Desktop strength must be between 0 and 100.");
    }
  }
}

function validatePresentation(issues: LingThemeValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value) || !readPresentationProfile(value.profileId)) {
    issue(issues, "invalid-presentation", "presentation.profileId", "Presentation profile is not registered.");
    return;
  }
  validateEnum(issues, value.surfaceIntensity, "presentation.surfaceIntensity", ["subtle", "balanced", "strong"], "invalid-presentation");
  validateEnum(issues, value.artworkIntensity, "presentation.artworkIntensity", ["subtle", "balanced", "strong"], "invalid-presentation");
  validateEnum(issues, value.decorationSet, "presentation.decorationSet", ["none", "home-corners"], "invalid-presentation");
}

function validateArtwork(issues: LingThemeValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    issue(issues, "invalid-artwork", "artwork.assets", "Artwork assets must be an array.");
    return;
  }
  for (const [index, asset] of value.assets.entries()) {
    const base = `artwork.assets.${index}`;
    if (!isRecord(asset)) {
      issue(issues, "invalid-artwork", base, "Artwork asset must be an object.");
      continue;
    }
    validateEnum(issues, asset.slot, `${base}.slot`, ["shell-background", "home-hero", "home-corner-start", "home-corner-end"], "invalid-artwork");
    validateArtworkPath(issues, asset.image, `${base}.image`);
    validateEnum(issues, asset.safeArea, `${base}.safeArea`, ["left", "right", "center", "none"], "invalid-artwork");
    validateEnum(issues, asset.taskMode, `${base}.taskMode`, ["off", "ambient", "banner"], "invalid-artwork");
    validateEnum(issues, asset.scrim, `${base}.scrim`, ["auto", "light", "dark"], "invalid-artwork");
    for (const key of ["focusX", "focusY"] as const) {
      if (asset[key] !== undefined && (typeof asset[key] !== "number" || asset[key] < 0 || asset[key] > 1)) {
        issue(issues, "invalid-artwork", `${base}.${key}`, "Artwork focus must be between 0 and 1.");
      }
    }
    if (asset.variants !== undefined) {
      if (!isRecord(asset.variants) || Object.keys(asset.variants).some((key) => !["16:9", "16:10", "21:9"].includes(key))) {
        issue(issues, "invalid-artwork", `${base}.variants`, "Artwork variants contain an unsupported ratio.");
      } else {
        for (const [ratio, image] of Object.entries(asset.variants)) validateArtworkPath(issues, image, `${base}.variants.${ratio}`);
      }
    }
  }
}

function validateScene(issues: LingThemeValidationIssue[], value: unknown, source: LingThemeSource | undefined): void {
  if (value === undefined) return;
  if (source !== "built-in") {
    issue(issues, "invalid-artwork", "scene", "Scene metadata is only supported for built-in themes.");
    return;
  }
  if (!isRecord(value)) {
    issue(issues, "invalid-artwork", "scene", "Scene metadata must be an object.");
    return;
  }
  if (typeof value.id !== "string" || !BUILT_IN_SCENE_IDS.includes(value.id as LingBuiltInSceneId)) {
    issue(issues, "invalid-artwork", "scene.id", "Scene id is not registered.");
  }
  for (const key of ["mascot", "corners"] as const) {
    if (typeof value[key] !== "boolean") issue(issues, "invalid-artwork", `scene.${key}`, "Scene switches must be boolean.");
  }
}

function validateGeneration(issues: LingThemeValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issue(issues, "invalid-generation", "generation", "Generation metadata must be an object.");
    return;
  }
  validateEnum(issues, value.mode, "generation.mode", ["quick", "generate", "advanced"], "invalid-generation");
  validateText(issues, value.compilerVersion, "generation.compilerVersion", 80, true, "invalid-generation");
  if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
    issue(issues, "invalid-generation", "generation.createdAt", "Generation timestamp is invalid.");
  }
  if (!Number.isSafeInteger(value.sourceAssetCount) || Number(value.sourceAssetCount) < 0) {
    issue(issues, "invalid-generation", "generation.sourceAssetCount", "Source asset count must be a non-negative integer.");
  }
  for (const key of ["plannerModelRef", "artworkModelRef", "promptTemplateVersion"] as const) {
    validateOptionalText(issues, value[key], `generation.${key}`, 120, undefined, "invalid-generation");
  }
}

function validateText(
  issues: LingThemeValidationIssue[],
  value: unknown,
  path: string,
  maxLength: number,
  required: boolean,
  code: LingThemeValidationIssue["code"] = "invalid-metadata",
): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength || CONTROL_CHARACTER_PATTERN.test(value)) {
    issue(issues, code, path, `Text must be non-empty, safe, and at most ${maxLength} characters.`);
  }
}

function validateOptionalText(
  issues: LingThemeValidationIssue[],
  value: unknown,
  path: string,
  maxLength: number,
  pattern?: RegExp,
  code: LingThemeValidationIssue["code"] = "invalid-metadata",
): void {
  if (value === undefined) return;
  validateText(issues, value, path, maxLength, true, code);
  if (typeof value === "string" && pattern && !pattern.test(value)) issue(issues, code, path, "Text format is invalid.");
}

function validateOptionalHttpsUrl(issues: LingThemeValidationIssue[], value: unknown, path: string): void {
  if (value === undefined) return;
  try {
    if (typeof value !== "string" || new URL(value).protocol !== "https:") throw new Error();
  } catch {
    issue(issues, "invalid-metadata", path, "URL must use https.");
  }
}

function validateOptionalArtworkPath(issues: LingThemeValidationIssue[], value: unknown, path: string): void {
  if (
    value !== undefined
    && (typeof value !== "string" || value.includes("..") || value.includes(":") || !PREVIEW_PATH_PATTERN.test(value))
  ) {
    issue(issues, "invalid-artwork", path, "Preview must be a local PNG, JPEG, or WebP path inside the theme bundle.");
  }
}

function validateArtworkPath(issues: LingThemeValidationIssue[], value: unknown, path: string): void {
  if (typeof value !== "string" || value.includes("..") || value.includes(":") || !ARTWORK_PATH_PATTERN.test(value)) {
    issue(issues, "invalid-artwork", path, "Artwork must be a local PNG or WebP path inside the theme bundle.");
  }
}

function validateEnum(
  issues: LingThemeValidationIssue[],
  value: unknown,
  path: string,
  allowed: readonly string[],
  code: LingThemeValidationIssue["code"],
): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) issue(issues, code, path, "Value is not allowlisted.");
}

function issue(issues: LingThemeValidationIssue[], code: LingThemeValidationIssue["code"], path: string, message: string): void {
  issues.push(Object.freeze({ code, path, message }));
}

function invalid(code: LingThemeValidationIssue["code"], path: string, message: string): LingThemeValidationResult {
  return { ok: false, issues: [Object.freeze({ code, path, message })] };
}

function readThemeSource(value: unknown): LingThemeSource | undefined {
  return value === "built-in" || value === "local-import" || value === "local-generated" ? value : undefined;
}

function readColorScheme(value: unknown): LingColorScheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

function readThemeId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id.length <= 64 && THEME_ID_PATTERN.test(id) ? id : undefined;
}

function readPresentationProfile(value: unknown): LingPresentationProfileId | undefined {
  return typeof value === "string" && LING_PRESENTATION_PROFILE_IDS.includes(value as LingPresentationProfileId)
    ? value as LingPresentationProfileId
    : undefined;
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThemeVariable(value: string): value is LingThemeCssVariable {
  return LING_THEME_CSS_VARIABLES.includes(value as LingThemeCssVariable);
}

function isSafeThemeVariableValue(variable: LingThemeCssVariable, value: string): boolean {
  return variable.startsWith("--ling-shadow-") ? isSafeShadow(value) : Boolean(parseCssColor(value));
}

function isSafeShadow(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= 200
    && !UNSAFE_CSS_PATTERN.test(normalized)
    && SAFE_SHADOW_PATTERN.test(normalized)
    && /\d/u.test(normalized);
}

interface RgbaColor { readonly r: number; readonly g: number; readonly b: number; readonly a: number }

function parseCssColor(value: string): RgbaColor | undefined {
  const input = value.trim().toLowerCase();
  if (input.length === 0 || input.length > 120 || UNSAFE_CSS_PATTERN.test(input)) return undefined;
  if (input.startsWith("#")) return parseHex(input);
  if (input.startsWith("rgb(" ) || input.startsWith("rgba(")) return parseRgb(input);
  if (input.startsWith("hsl(" ) || input.startsWith("hsla(")) return parseHsl(input);
  if (input.startsWith("color-mix(")) return parseColorMix(input);
  return undefined;
}

function parseHex(input: string): RgbaColor | undefined {
  const raw = input.slice(1);
  if (![3, 4, 6, 8].includes(raw.length) || !/^[0-9a-f]+$/u.test(raw)) return undefined;
  const expanded = raw.length <= 4 ? [...raw].map((character) => `${character}${character}`).join("") : raw;
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
    a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function parseRgb(input: string): RgbaColor | undefined {
  const body = input.slice(input.indexOf("(") + 1, -1).trim();
  const [channelsPart, alphaPart] = body.split("/").map((part) => part.trim());
  const channels = channelsPart.replace(/,/gu, " ").split(/\s+/u).filter(Boolean);
  const legacyAlpha = !alphaPart && channels.length === 4 ? channels.pop() : undefined;
  if (channels.length !== 3) return undefined;
  const values = channels.map((channel) => parseChannel(channel));
  const alpha = alphaPart ? parseAlpha(alphaPart) : legacyAlpha ? parseAlpha(legacyAlpha) : 1;
  return values.every((channel) => channel !== undefined) && alpha !== undefined
    ? { r: values[0]!, g: values[1]!, b: values[2]!, a: alpha }
    : undefined;
}

function parseHsl(input: string): RgbaColor | undefined {
  const body = input.slice(input.indexOf("(") + 1, -1).trim();
  const [channelsPart, alphaPart] = body.split("/").map((part) => part.trim());
  const channels = channelsPart.replace(/,/gu, " ").split(/\s+/u).filter(Boolean);
  const legacyAlpha = !alphaPart && channels.length === 4 ? channels.pop() : undefined;
  if (channels.length !== 3) return undefined;
  const hue = Number.parseFloat(channels[0]);
  const saturation = parsePercentage(channels[1]);
  const lightness = parsePercentage(channels[2]);
  const alpha = alphaPart ? parseAlpha(alphaPart) : legacyAlpha ? parseAlpha(legacyAlpha) : 1;
  if (![hue, saturation, lightness, alpha].every((number) => number !== undefined && Number.isFinite(number))) return undefined;
  const c = (1 - Math.abs(2 * lightness! - 1)) * saturation!;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lightness! - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255, a: alpha! };
}

function parseColorMix(input: string): RgbaColor | undefined {
  const match = /^color-mix\(in srgb,\s*(#[0-9a-f]{3,8})\s*(\d+(?:\.\d+)?%)?,\s*(#[0-9a-f]{3,8})\s*(\d+(?:\.\d+)?%)?\)$/u.exec(input);
  if (!match) return undefined;
  const first = parseHex(match[1]);
  const second = parseHex(match[3]);
  if (!first || !second) return undefined;
  const firstWeight = match[2] ? Number.parseFloat(match[2]) / 100 : match[4] ? 1 - Number.parseFloat(match[4]) / 100 : 0.5;
  const secondWeight = match[4] ? Number.parseFloat(match[4]) / 100 : 1 - firstWeight;
  if (firstWeight < 0 || secondWeight < 0 || Math.abs(firstWeight + secondWeight - 1) > 0.001) return undefined;
  return {
    r: first.r * firstWeight + second.r * secondWeight,
    g: first.g * firstWeight + second.g * secondWeight,
    b: first.b * firstWeight + second.b * secondWeight,
    a: first.a * firstWeight + second.a * secondWeight,
  };
}

function parseChannel(value: string): number | undefined {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return undefined;
  const resolved = value.endsWith("%") ? number * 2.55 : number;
  return resolved >= 0 && resolved <= 255 ? resolved : undefined;
}

function parseAlpha(value: string): number | undefined {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return undefined;
  const resolved = value.endsWith("%") ? number / 100 : number;
  return resolved >= 0 && resolved <= 1 ? resolved : undefined;
}

function parsePercentage(value: string): number | undefined {
  if (!value.endsWith("%")) return undefined;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number / 100 : undefined;
}

function contrastRatio(foreground: RgbaColor, background: RgbaColor): number {
  const flattened = foreground.a < 1 ? composite(foreground, background) : foreground;
  const foregroundLuminance = luminance(flattened);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  return {
    r: foreground.r * foreground.a + background.r * (1 - foreground.a),
    g: foreground.g * foreground.a + background.g * (1 - foreground.a),
    b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    a: 1,
  };
}

function luminance(color: RgbaColor): number {
  const channel = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
