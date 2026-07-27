import type {
  LingColorScheme,
  LingPresentationProfileId,
  LingThemeCssVariable,
  LingThemeGenerationMetadata,
  LingThemePackManifest,
  LingThemePresentationSelection,
  LingThemeArtworkSlot,
} from "../types.js";

export interface ThemeImageSample {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

export interface ThemeImageAnalysis {
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: number;
  readonly averageLuminance: number;
  readonly dominantColors: readonly string[];
  readonly accentCandidate: string;
  readonly leftInformationScore: number;
  readonly rightInformationScore: number;
  readonly focusX: number;
  readonly focusY: number;
  readonly safeArea: "left" | "right" | "center" | "none";
  readonly recommendedProfileId: LingPresentationProfileId;
}

export interface ThemePaletteCandidate {
  readonly background: string;
  readonly accent: string;
}

export interface CompileLingThemeInput {
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
  };
  readonly colorScheme: LingColorScheme;
  readonly presentation: LingThemePresentationSelection;
  readonly paletteCandidate: ThemePaletteCandidate;
  readonly analysis: ThemeImageAnalysis;
  readonly artwork?: readonly ValidatedThemeArtworkInput[];
  readonly generation: Omit<LingThemeGenerationMetadata, "compilerVersion">;
}

export interface ThemeArtworkContentRisk {
  readonly readableText: boolean;
  readonly logoOrWatermark: boolean;
  readonly uiChrome: boolean;
}

export interface ValidatedThemeArtworkInput {
  readonly id: string;
  readonly slot: LingThemeArtworkSlot;
  readonly mimeType: "image/png" | "image/webp";
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly hasAlpha: boolean;
  readonly analysis: ThemeImageAnalysis;
  readonly contentRisk: ThemeArtworkContentRisk;
}

export interface CompiledThemeAsset {
  readonly id: string;
  readonly path: string;
  readonly mimeType: ValidatedThemeArtworkInput["mimeType"];
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly checksumSha256: string;
}

export interface ThemeVerificationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ThemeVerificationReport {
  readonly blockers: readonly ThemeVerificationIssue[];
  readonly warnings: readonly ThemeVerificationIssue[];
}

export interface ThemePreviewModel {
  readonly themeId: string;
  readonly colorScheme: LingColorScheme;
  readonly presentationProfileId: LingPresentationProfileId;
  readonly background: string;
  readonly accent: string;
}

export interface CompiledLingThemeCandidate {
  readonly manifest: LingThemePackManifest;
  readonly assets: readonly CompiledThemeAsset[];
  readonly tokenMap: Readonly<Record<LingThemeCssVariable, string>>;
  readonly analysis: ThemeImageAnalysis;
  readonly verification: ThemeVerificationReport;
  readonly previewModel: ThemePreviewModel;
  readonly readyToPublish: boolean;
}
