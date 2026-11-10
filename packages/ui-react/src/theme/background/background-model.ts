export const BACKGROUND_LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, edge: 8192, pixels: 16_000_000 });
export const BACKGROUND_VIDEO_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, edge: 4096, seconds: 120 });
/** Bounded RGBA storage prevents high-detail JPEGs expanding beyond the PNG byte budget. */
export const BACKGROUND_OUTPUT_LIMITS = Object.freeze({ edge: 2560, pixels: 4_000_000 });
export const BACKGROUND_OPACITY = Object.freeze({ minimum: 0.2, maximum: 1, default: 0.6 });

export function backgroundOutputDimensions(width: number, height: number): { width: number; height: number } {
  checkBackgroundDimensions(width, height);
  const scale = Math.min(1, BACKGROUND_OUTPUT_LIMITS.edge / Math.max(width, height),
    Math.sqrt(BACKGROUND_OUTPUT_LIMITS.pixels / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export const BACKGROUND_STRENGTHS = ["subtle", "balanced", "strong"] as const;
export type BackgroundStrength = typeof BACKGROUND_STRENGTHS[number];
export type BackgroundSelection =
  | { readonly kind: "none" }
  | { readonly kind: "local-image"; readonly assetId: string }
  | { readonly kind: "local-video"; readonly assetId: string };
export interface BackgroundPreference {
  readonly schemaVersion: 3;
  readonly revision: number;
  readonly selection: BackgroundSelection;
  readonly opacity: number;
  readonly profiles: Readonly<Record<string, BackgroundThemeProfile>>;
}
export interface BackgroundThemeProfile {
  readonly opacity: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly paused: boolean;
}
export interface BackgroundPresentation extends Omit<BackgroundThemeProfile, "opacity"> { readonly themeId: string }
export const BACKGROUND_PROFILE_LIMIT = 24;
export function recommendedBackgroundProfile(): BackgroundThemeProfile {
  return { opacity: BACKGROUND_OPACITY.default, focusX: 50, focusY: 50, paused: false };
}
export function backgroundThemeProfile(preference: BackgroundPreference, themeId: string): BackgroundThemeProfile {
  return Object.hasOwn(preference.profiles, themeId) ? preference.profiles[themeId] : { ...recommendedBackgroundProfile(), opacity: preference.opacity };
}
export function isBackgroundThemeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(value);
}
export function isBackgroundFocus(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}
export function parseBackgroundPresentation(value: unknown): BackgroundPresentation {
  if (!exactObject(value, ["themeId", "focusX", "focusY", "paused"]) || !isBackgroundThemeId(value.themeId)
    || !isBackgroundFocus(value.focusX) || !isBackgroundFocus(value.focusY) || typeof value.paused !== "boolean") throw new BackgroundError("invalid-request");
  return Object.freeze({ ...value }) as unknown as BackgroundPresentation;
}
export type BackgroundAsset =
  | {
      readonly kind: "image";
      readonly assetId: string;
      readonly mimeType: "image/png";
      readonly byteLength: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly kind: "video";
      readonly assetId: string;
      readonly mimeType: BackgroundVideoMimeType;
      readonly byteLength: number;
      readonly width: number;
      readonly height: number;
      readonly duration: number;
    };

export type BackgroundVideoMimeType = "video/mp4" | "video/webm";
export const INITIAL_BACKGROUND: BackgroundPreference = Object.freeze({ schemaVersion: 3, revision: 0,
  selection: Object.freeze({ kind: "none" }), opacity: BACKGROUND_OPACITY.default, profiles: Object.freeze({}) });
export type BackgroundErrorCode = "invalid-image" | "capacity" | "conflict" | "unavailable" | "corrupt" | "aborted" | "invalid-request";
export class BackgroundError extends Error {
  constructor(readonly code: BackgroundErrorCode) { super(code); this.name = "BackgroundError"; }
}

export function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)));
}
export function isBackgroundStrength(value: unknown): value is BackgroundStrength {
  return BACKGROUND_STRENGTHS.includes(value as BackgroundStrength);
}
export function backgroundOpacityFromStrength(strength: BackgroundStrength): number {
  return { subtle: 0.45, balanced: 0.6, strong: 0.75 }[strength];
}
export function isBackgroundOpacity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
    && value >= BACKGROUND_OPACITY.minimum && value <= BACKGROUND_OPACITY.maximum;
}
export function isBackgroundAssetId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
export function checkBackgroundDimensions(width: number, height: number): void {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= BACKGROUND_LIMITS.edge)
    || width * height > BACKGROUND_LIMITS.pixels) throw new BackgroundError("capacity");
}
export function checkBackgroundVideoMetadata(width: number, height: number, duration: number): void {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= BACKGROUND_VIDEO_LIMITS.edge)
    || typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0 || duration > BACKGROUND_VIDEO_LIMITS.seconds) {
    throw new BackgroundError("capacity");
  }
}
export function backgroundVideoMimeType(bytes: Uint8Array, fileName = "", mimeType = ""): BackgroundVideoMimeType | undefined {
  const lowerName = fileName.toLowerCase();
  if ((mimeType === "video/mp4" || lowerName.endsWith(".mp4") || lowerName.endsWith(".m4v"))
    && bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
  if ((mimeType === "video/webm" || lowerName.endsWith(".webm"))
    && bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return undefined;
}
export function parseBackgroundPreference(value: unknown): BackgroundPreference {
  if (!exactObject(value, ["schemaVersion", "revision", "selection", "opacity"])
    && !exactObject(value, ["schemaVersion", "revision", "selection", "strength"])
    && !exactObject(value, ["schemaVersion", "revision", "selection", "opacity", "profiles"])) throw new BackgroundError("corrupt");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw new BackgroundError("corrupt");
  const opacity = (value.schemaVersion === 2 || value.schemaVersion === 3) && isBackgroundOpacity(value.opacity)
    ? value.opacity
    : value.schemaVersion === 1 && isBackgroundStrength(value.strength)
      ? backgroundOpacityFromStrength(value.strength)
      : undefined;
  if (opacity === undefined) throw new BackgroundError("corrupt");
  const selection = parseBackgroundSelection(value.selection);
  const profiles: Record<string, BackgroundThemeProfile> = {};
  if (value.schemaVersion === 3) {
    if (!isRecord(value.profiles) || Object.keys(value.profiles).length > BACKGROUND_PROFILE_LIMIT) throw new BackgroundError("corrupt");
    for (const [themeId, profile] of Object.entries(value.profiles)) {
      if (!isBackgroundThemeId(themeId) || !exactObject(profile, ["opacity", "focusX", "focusY", "paused"])
        || !isBackgroundOpacity(profile.opacity) || !isBackgroundFocus(profile.focusX) || !isBackgroundFocus(profile.focusY)
        || typeof profile.paused !== "boolean") throw new BackgroundError("corrupt");
      Object.defineProperty(profiles, themeId, { value: Object.freeze({ ...profile }), enumerable: true });
    }
  } else if ("profiles" in value || value.schemaVersion === 2 && "strength" in value || value.schemaVersion === 1 && "opacity" in value) {
    throw new BackgroundError("corrupt");
  }
  return Object.freeze({ schemaVersion: 3, revision: value.revision as number, selection, opacity, profiles: Object.freeze(profiles) });
}
export function parseBackgroundSelection(value: unknown): BackgroundSelection {
  if (exactObject(value, ["kind"]) && value.kind === "none") return Object.freeze({ kind: "none" });
  if (exactObject(value, ["kind", "assetId"]) && (value.kind === "local-image" || value.kind === "local-video") && isBackgroundAssetId(value.assetId)) {
    return Object.freeze({ kind: value.kind, assetId: value.assetId });
  }
  throw new BackgroundError("corrupt");
}
export function parseBackgroundAsset(value: unknown): BackgroundAsset {
  if (!isRecord(value) || !isBackgroundAssetId(value.assetId)
    || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) <= 0) throw new BackgroundError("corrupt");
  const kind = value.kind ?? "image";
  if (kind === "image") {
    const keys = Object.keys(value).sort();
    const expected = ["assetId", "byteLength", "height", "mimeType", "width"];
    const expectedWithKind = ["assetId", "byteLength", "height", "kind", "mimeType", "width"];
    if (keys.join("\0") !== (value.kind === undefined ? expected : expectedWithKind).join("\0") || value.mimeType !== "image/png"
      || (value.byteLength as number) > BACKGROUND_LIMITS.bytes) throw new BackgroundError("corrupt");
    checkBackgroundDimensions(value.width as number, value.height as number);
    return Object.freeze({ kind: "image", ...value }) as unknown as BackgroundAsset;
  }
  if (kind !== "video" || !exactObject(value, ["assetId", "byteLength", "duration", "height", "kind", "mimeType", "width"])
    || (value.mimeType !== "video/mp4" && value.mimeType !== "video/webm")
    || (value.byteLength as number) > BACKGROUND_VIDEO_LIMITS.bytes) throw new BackgroundError("corrupt");
  checkBackgroundVideoMetadata(value.width as number, value.height as number, value.duration as number);
  return Object.freeze({ ...value }) as unknown as BackgroundAsset;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
