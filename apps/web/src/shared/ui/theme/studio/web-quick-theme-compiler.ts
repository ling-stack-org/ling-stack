import {
  compileLingTheme,
  type CompiledLingThemeCandidate,
  type LingColorScheme,
  type LingThemePackManifest,
  type ThemeImageAnalysis,
} from "@ling-stack/ui-react/theme";

export interface QuickThemeCompileInput {
  readonly analysis: ThemeImageAnalysis;
  readonly colorScheme: LingColorScheme;
  readonly createdAt: string;
  readonly name: string;
  readonly themeId: string;
}

export function compileTokenOnlyQuickTheme(input: QuickThemeCompileInput): CompiledLingThemeCandidate {
  const candidate = compileLingTheme({
    identity: {
      id: input.themeId,
      name: input.name,
      description: "Generated locally from an image palette.",
    },
    colorScheme: input.colorScheme,
    presentation: {
      profileId: "ling-standard",
      surfaceIntensity: "balanced",
      artworkIntensity: "subtle",
      decorationSet: "none",
    },
    paletteCandidate: {
      background: input.analysis.dominantColors[0] ?? fallbackBackground(input.colorScheme),
      accent: input.analysis.accentCandidate,
    },
    analysis: input.analysis,
    generation: {
      mode: "quick",
      createdAt: input.createdAt,
      sourceAssetCount: 1,
    },
  });

  assertTokenOnlyManifest(candidate.manifest, candidate.assets.length);
  return candidate;
}

export function assertTokenOnlyManifest(manifest: LingThemePackManifest, assetCount: number): void {
  if (manifest.source !== "local-generated" || manifest.generation?.mode !== "quick") {
    throw new Error("Quick publication requires a locally generated Quick theme.");
  }
  if (manifest.presentation?.profileId !== "ling-standard") {
    throw new Error("Quick themes must use the Standard presentation profile.");
  }
  if (manifest.artwork !== undefined || assetCount !== 0) {
    throw new Error("Quick themes cannot publish runtime artwork.");
  }
}

function fallbackBackground(colorScheme: LingColorScheme): string {
  return colorScheme === "dark" ? "#17191d" : "#f5f6f8";
}
