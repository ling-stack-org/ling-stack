import type { LingThemeArtworkAsset } from "../types.js";
import { PresentationProfileRegistry } from "../presentation/profile-registry.js";
import type {
  CompiledThemeAsset,
  ThemeVerificationIssue,
  ValidatedThemeArtworkInput,
} from "./compiler-types.js";

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ASSET_EDGE = 16_384;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

export interface CompiledArtworkResult {
  readonly manifestAssets: readonly LingThemeArtworkAsset[];
  readonly assets: readonly CompiledThemeAsset[];
  readonly blockers: readonly ThemeVerificationIssue[];
}

export function compileThemeArtwork(
  profileId: string,
  inputs: readonly ValidatedThemeArtworkInput[] = [],
  registry = new PresentationProfileRegistry(),
): CompiledArtworkResult {
  const manifestAssets: LingThemeArtworkAsset[] = [];
  const assets: CompiledThemeAsset[] = [];
  const blockers: ThemeVerificationIssue[] = [];
  const identities = new Set<string>();
  const slots = new Set<string>();

  for (const [index, input] of inputs.entries()) {
    const base = `artwork.${index}`;
    const issues = validateArtworkInput(profileId, input, registry, base, identities, slots);
    blockers.push(...issues);
    if (issues.length > 0) continue;

    identities.add(input.id);
    slots.add(input.slot);
    const extension = input.mimeType === "image/png" ? "png" : "webp";
    const path = `assets/${input.id}.${extension}`;
    assets.push(Object.freeze({
      id: input.id,
      path,
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      byteLength: input.byteLength,
      checksumSha256: input.checksumSha256,
    }));
    manifestAssets.push(Object.freeze({
      slot: input.slot,
      image: path,
      safeArea: input.analysis.safeArea,
      focusX: input.analysis.focusX,
      focusY: input.analysis.focusY,
      taskMode: input.slot === "home-hero" ? "banner" : input.slot === "shell-background" ? "ambient" : "off",
      scrim: "auto",
    }));
  }

  return Object.freeze({
    manifestAssets: Object.freeze(manifestAssets),
    assets: Object.freeze(assets),
    blockers: Object.freeze(blockers),
  });
}

function validateArtworkInput(
  profileId: string,
  input: ValidatedThemeArtworkInput,
  registry: PresentationProfileRegistry,
  base: string,
  identities: ReadonlySet<string>,
  slots: ReadonlySet<string>,
): readonly ThemeVerificationIssue[] {
  const issues: ThemeVerificationIssue[] = [];
  if (!ASSET_ID_PATTERN.test(input.id) || input.id.length > 64 || identities.has(input.id)) {
    issues.push(issue("invalid-artwork-identity", `${base}.id`, "Artwork id must be unique lowercase ASCII kebab-case."));
  }
  if (slots.has(input.slot)) {
    issues.push(issue("duplicate-artwork-slot", `${base}.slot`, "Only one primary asset is allowed per artwork slot."));
  }
  if (!registry.supportsArtworkSlot(profileId, input.slot)) {
    issues.push(issue("unsupported-artwork-slot", `${base}.slot`, "The selected Presentation Profile does not support this artwork slot."));
  }
  if (
    !Number.isSafeInteger(input.width)
    || !Number.isSafeInteger(input.height)
    || input.width <= 0
    || input.height <= 0
    || input.width > MAX_ASSET_EDGE
    || input.height > MAX_ASSET_EDGE
  ) {
    issues.push(issue("invalid-artwork-dimensions", `${base}.width`, "Artwork dimensions are outside the supported range."));
  }
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > MAX_ASSET_BYTES) {
    issues.push(issue("invalid-artwork-size", `${base}.byteLength`, "Artwork file size is outside the supported range."));
  }
  if (!SHA256_PATTERN.test(input.checksumSha256)) {
    issues.push(issue("invalid-artwork-checksum", `${base}.checksumSha256`, "Artwork requires a lowercase SHA-256 identity."));
  }
  if ((input.slot === "home-corner-start" || input.slot === "home-corner-end") && !input.hasAlpha) {
    issues.push(issue("decoration-requires-alpha", `${base}.hasAlpha`, "Corner decoration artwork must contain transparency."));
  }
  if (input.contentRisk.readableText) {
    issues.push(issue("artwork-readable-text", `${base}.contentRisk.readableText`, "Artwork with readable text cannot be published as a theme background."));
  }
  if (input.contentRisk.logoOrWatermark) {
    issues.push(issue("artwork-logo-watermark", `${base}.contentRisk.logoOrWatermark`, "Artwork with a logo or watermark cannot be published."));
  }
  if (input.contentRisk.uiChrome) {
    issues.push(issue("artwork-ui-chrome", `${base}.contentRisk.uiChrome`, "Screenshots or artwork containing UI chrome cannot be installed directly."));
  }
  return Object.freeze(issues);
}

function issue(code: string, path: string, message: string): ThemeVerificationIssue {
  return Object.freeze({ code, path, message });
}
