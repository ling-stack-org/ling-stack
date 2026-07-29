import { themeTokensToCssVariables } from "../token-map.js";
import { PresentationProfileRegistry } from "../presentation/profile-registry.js";
import type { LingThemePackManifest } from "../types.js";
import { validateThemeManifest } from "../validate-theme.js";
import type {
  CompileLingThemeInput,
  CompiledLingThemeCandidate,
  ThemeVerificationIssue,
} from "./compiler-types.js";
import { isCompilerHex } from "./color-utils.js";
import { compileThemeArtwork } from "./compile-artwork.js";
import { deriveThemeTokens } from "./derive-tokens.js";

export const LING_THEME_COMPILER_VERSION = "1.0.0";
const presentationProfiles = new PresentationProfileRegistry();

export function compileLingTheme(input: CompileLingThemeInput): CompiledLingThemeCandidate {
  const tokens = deriveThemeTokens(input.colorScheme, input.paletteCandidate);
  const artwork = compileThemeArtwork(input.presentation.profileId, input.artwork);
  const manifest: LingThemePackManifest = Object.freeze({
    schemaVersion: 1,
    id: input.identity.id.trim().toLowerCase(),
    name: input.identity.name.trim(),
    ...(input.identity.description?.trim() ? { description: input.identity.description.trim() } : {}),
    colorScheme: input.colorScheme,
    source: "local-generated",
    tokens,
    presentation: Object.freeze({ ...input.presentation }),
    ...(artwork.manifestAssets.length > 0
      ? { artwork: Object.freeze({ assets: artwork.manifestAssets }) }
      : {}),
    generation: Object.freeze({ ...input.generation, compilerVersion: LING_THEME_COMPILER_VERSION }),
  });
  const validation = validateThemeManifest(manifest, { source: "local-generated" });
  const paletteBlockers = paletteIssues(input);
  const presentationBlockers = presentationIssues(input);
  const manifestBlockers = validation.ok
    ? []
    : validation.issues.map((issue) => Object.freeze({ ...issue }));
  const blockers: readonly ThemeVerificationIssue[] = Object.freeze([
    ...paletteBlockers,
    ...presentationBlockers,
    ...artwork.blockers,
    ...manifestBlockers,
  ]);
  const tokenMap = validation.ok
    ? validation.candidate.variableMap
    : themeTokensToCssVariables(tokens);
  const warnings: readonly ThemeVerificationIssue[] = input.presentation.profileId === "ling-standard" || artwork.assets.length > 0
    ? []
    : [Object.freeze({
        code: "missing-artwork",
        path: "artwork",
        message: "This profile is token-only until verified artwork is attached.",
      })];

  return Object.freeze({
    manifest,
    assets: artwork.assets,
    tokenMap,
    analysis: input.analysis,
    verification: Object.freeze({ blockers: Object.freeze(blockers), warnings: Object.freeze(warnings) }),
    previewModel: Object.freeze({
      themeId: manifest.id,
      colorScheme: manifest.colorScheme,
      presentationProfileId: input.presentation.profileId,
      background: tokenMap["--ling-bg-app"],
      accent: tokenMap["--ling-action-accent"],
    }),
    readyToPublish: blockers.length === 0,
  });
}

function presentationIssues(input: CompileLingThemeInput): readonly ThemeVerificationIssue[] {
  const decorationSet = input.presentation.decorationSet;
  if (
    decorationSet
    && !presentationProfiles.supportsDecorationSet(input.presentation.profileId, decorationSet)
  ) {
    return [Object.freeze({
      code: "unsupported-decoration-set",
      path: "presentation.decorationSet",
      message: "The selected Presentation Profile does not support this decoration set.",
    })];
  }
  return [];
}

function paletteIssues(input: CompileLingThemeInput): readonly ThemeVerificationIssue[] {
  const issues: ThemeVerificationIssue[] = [];
  for (const [key, value] of Object.entries(input.paletteCandidate)) {
    if (!isCompilerHex(value)) {
      issues.push(Object.freeze({
        code: "invalid-palette",
        path: `paletteCandidate.${key}`,
        message: "Compiler palette values must be six-digit hex colors.",
      }));
    }
  }
  return Object.freeze(issues);
}
