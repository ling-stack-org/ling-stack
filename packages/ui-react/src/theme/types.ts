export const LING_THEME_SCHEMA_VERSION = 1 as const;

export type LingColorScheme = "light" | "dark";
export type LingThemeSource = "built-in" | "local-import" | "local-generated";
export type LingResolvedThemeSource = LingThemeSource | "fallback";

export type LingPresentationProfileId =
  | "ling-standard"
  | "ling-glass"
  | "ling-immersive"
  | "ling-illustrated";

export type ThemeSelection =
  | { readonly mode: "fixed"; readonly themeId: string }
  | { readonly mode: "system"; readonly lightThemeId: string; readonly darkThemeId: string };

export interface LingSemanticTone {
  readonly foreground: string;
  readonly background: string;
  readonly border: string;
}

export interface LingThemeTokens {
  readonly background: {
    readonly app: string;
    readonly panel: string;
    readonly elevated: string;
    readonly subtle: string;
    readonly pressed: string;
    readonly overlay: string;
    readonly code: string;
    readonly sidebar: string;
    readonly composer: string;
  };
  readonly text: {
    readonly strong: string;
    readonly default: string;
    readonly muted: string;
    readonly soft: string;
    readonly inverse: string;
    readonly link: string;
  };
  readonly border: {
    readonly default: string;
    readonly strong: string;
    readonly focus: string;
  };
  readonly action: {
    readonly accent: string;
    readonly accentHover: string;
    readonly accentPressed: string;
    readonly accentForeground: string;
    readonly selection: string;
  };
  readonly status: {
    readonly success: LingSemanticTone;
    readonly warning: LingSemanticTone;
    readonly danger: LingSemanticTone;
    readonly info: LingSemanticTone;
  };
  readonly shadow: {
    readonly low: string;
    readonly medium: string;
    readonly overlay: string;
  };
  readonly native: {
    readonly selection: string;
    readonly scrollbar: string;
    readonly scrollbarHover: string;
  };
}

export interface LingDesktopThemeTokens {
  readonly windowBackground?: string;
  readonly sidebarMaterial?: string;
  readonly overlayMaterial?: string;
  readonly titlebarForeground?: string;
  readonly shadowStrength?: number;
  readonly blurStrength?: number;
}

export type LingThemeArtworkSlot =
  | "shell-background"
  | "home-hero"
  | "home-corner-start"
  | "home-corner-end";

export interface LingThemeArtworkAsset {
  readonly slot: LingThemeArtworkSlot;
  readonly image: string;
  readonly variants?: Readonly<Partial<Record<"16:9" | "16:10" | "21:9", string>>>;
  readonly safeArea?: "left" | "right" | "center" | "none";
  readonly focusX?: number;
  readonly focusY?: number;
  readonly taskMode?: "off" | "ambient" | "banner";
  readonly scrim?: "auto" | "light" | "dark";
}

export interface LingThemeArtwork {
  readonly assets: readonly LingThemeArtworkAsset[];
}

export interface LingThemePresentationSelection {
  readonly profileId: LingPresentationProfileId;
  readonly surfaceIntensity?: "subtle" | "balanced" | "strong";
  readonly artworkIntensity?: "subtle" | "balanced" | "strong";
  readonly decorationSet?: "none" | "home-corners";
}

export interface LingThemeGenerationMetadata {
  readonly mode: "quick" | "generate" | "advanced";
  readonly createdAt: string;
  readonly compilerVersion: string;
  readonly plannerModelRef?: string;
  readonly artworkModelRef?: string;
  readonly promptTemplateVersion?: string;
  readonly sourceAssetCount: number;
}

export interface LingThemePackManifest {
  readonly schemaVersion: typeof LING_THEME_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly familyId?: string;
  readonly description?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly license?: string;
  readonly colorScheme: LingColorScheme;
  readonly source: LingThemeSource;
  readonly tokens: LingThemeTokens;
  readonly desktop?: LingDesktopThemeTokens;
  readonly presentation?: LingThemePresentationSelection;
  readonly artwork?: LingThemeArtwork;
  readonly generation?: LingThemeGenerationMetadata;
  readonly preview?: string;
}

export type LingThemeValidationIssueCode =
  | "invalid-schema"
  | "invalid-identity"
  | "reserved-id"
  | "invalid-metadata"
  | "missing-token"
  | "invalid-color"
  | "invalid-shadow"
  | "insufficient-contrast"
  | "invalid-desktop-token"
  | "invalid-presentation"
  | "invalid-artwork"
  | "invalid-generation";

export interface LingThemeValidationIssue {
  readonly code: LingThemeValidationIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface ValidatedThemeCandidate {
  readonly manifest: LingThemePackManifest;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
}

export type LingThemeValidationResult =
  | { readonly ok: true; readonly candidate: ValidatedThemeCandidate }
  | { readonly ok: false; readonly issues: readonly LingThemeValidationIssue[] };

export type RegisteredThemeState = "ready" | "incompatible" | "missing-asset" | "invalid";

export interface RegisteredTheme {
  readonly manifest: LingThemePackManifest;
  readonly source: LingThemeSource;
  readonly state: RegisteredThemeState;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
  readonly installedAt?: string;
  readonly validationIssue?: string;
}

export interface ResolvedThemeState {
  readonly selection: ThemeSelection;
  readonly themeId: string;
  readonly colorScheme: LingColorScheme;
  readonly source: LingResolvedThemeSource;
  readonly presentationProfileId: LingPresentationProfileId;
  readonly manifest: LingThemePackManifest;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
  readonly fallbackFrom?: string;
}

export const LING_THEME_CSS_VARIABLES = [
  "--ling-bg-app",
  "--ling-bg-panel",
  "--ling-bg-elevated",
  "--ling-bg-subtle",
  "--ling-bg-pressed",
  "--ling-bg-overlay",
  "--ling-bg-code",
  "--ling-bg-sidebar",
  "--ling-bg-composer",
  "--ling-text-strong",
  "--ling-text-default",
  "--ling-text-muted",
  "--ling-text-soft",
  "--ling-text-inverse",
  "--ling-text-link",
  "--ling-border-default",
  "--ling-border-strong",
  "--ling-border-focus",
  "--ling-action-accent",
  "--ling-action-accent-hover",
  "--ling-action-accent-pressed",
  "--ling-action-accent-fg",
  "--ling-action-selection",
  "--ling-status-success",
  "--ling-status-success-bg",
  "--ling-status-success-border",
  "--ling-status-warning",
  "--ling-status-warning-bg",
  "--ling-status-warning-border",
  "--ling-status-danger",
  "--ling-status-danger-bg",
  "--ling-status-danger-border",
  "--ling-status-info",
  "--ling-status-info-bg",
  "--ling-status-info-border",
  "--ling-shadow-low",
  "--ling-shadow-medium",
  "--ling-shadow-overlay",
  "--ling-native-selection",
  "--ling-native-scrollbar",
  "--ling-native-scrollbar-hover",
] as const;

export type LingThemeCssVariable = typeof LING_THEME_CSS_VARIABLES[number];

export interface LingThemeBootstrapSnapshot {
  readonly schemaVersion: 1;
  readonly themeId: string;
  readonly colorScheme: LingColorScheme;
  readonly source: "local-import" | "local-generated";
  readonly presentationProfileId: LingPresentationProfileId;
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
  readonly packageChecksumSha256?: string;
}

export const DEFAULT_THEME_SELECTION: ThemeSelection = Object.freeze({
  mode: "system",
  lightThemeId: "ling-light",
  darkThemeId: "ling-dark",
});

export const LING_PRESENTATION_PROFILE_IDS: readonly LingPresentationProfileId[] = [
  "ling-standard",
  "ling-glass",
  "ling-immersive",
  "ling-illustrated",
];
