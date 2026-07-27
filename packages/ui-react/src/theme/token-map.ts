import {
  LING_THEME_CSS_VARIABLES,
  type LingThemeBootstrapSnapshot,
  type LingThemeCssVariable,
  type LingThemePackManifest,
  type LingThemePresentationSelection,
  type LingThemeTokens,
  type ResolvedThemeState,
  type ThemeSelection,
} from "./types.js";

export function themeTokensToCssVariables(tokens: LingThemeTokens): Readonly<Record<LingThemeCssVariable, string>> {
  return Object.freeze({
    "--ling-bg-app": tokens.background.app,
    "--ling-bg-panel": tokens.background.panel,
    "--ling-bg-elevated": tokens.background.elevated,
    "--ling-bg-subtle": tokens.background.subtle,
    "--ling-bg-pressed": tokens.background.pressed,
    "--ling-bg-overlay": tokens.background.overlay,
    "--ling-bg-code": tokens.background.code,
    "--ling-bg-sidebar": tokens.background.sidebar,
    "--ling-bg-composer": tokens.background.composer,
    "--ling-text-strong": tokens.text.strong,
    "--ling-text-default": tokens.text.default,
    "--ling-text-muted": tokens.text.muted,
    "--ling-text-soft": tokens.text.soft,
    "--ling-text-inverse": tokens.text.inverse,
    "--ling-text-link": tokens.text.link,
    "--ling-border-default": tokens.border.default,
    "--ling-border-strong": tokens.border.strong,
    "--ling-border-focus": tokens.border.focus,
    "--ling-action-accent": tokens.action.accent,
    "--ling-action-accent-hover": tokens.action.accentHover,
    "--ling-action-accent-pressed": tokens.action.accentPressed,
    "--ling-action-accent-fg": tokens.action.accentForeground,
    "--ling-action-selection": tokens.action.selection,
    "--ling-status-success": tokens.status.success.foreground,
    "--ling-status-success-bg": tokens.status.success.background,
    "--ling-status-success-border": tokens.status.success.border,
    "--ling-status-warning": tokens.status.warning.foreground,
    "--ling-status-warning-bg": tokens.status.warning.background,
    "--ling-status-warning-border": tokens.status.warning.border,
    "--ling-status-danger": tokens.status.danger.foreground,
    "--ling-status-danger-bg": tokens.status.danger.background,
    "--ling-status-danger-border": tokens.status.danger.border,
    "--ling-status-info": tokens.status.info.foreground,
    "--ling-status-info-bg": tokens.status.info.background,
    "--ling-status-info-border": tokens.status.info.border,
    "--ling-shadow-low": tokens.shadow.low,
    "--ling-shadow-medium": tokens.shadow.medium,
    "--ling-shadow-overlay": tokens.shadow.overlay,
    "--ling-native-selection": tokens.native.selection,
    "--ling-native-scrollbar": tokens.native.scrollbar,
    "--ling-native-scrollbar-hover": tokens.native.scrollbarHover,
  });
}

export function presentationProfileId(
  presentation: LingThemePresentationSelection | undefined,
): ResolvedThemeState["presentationProfileId"] {
  return presentation?.profileId ?? "ling-standard";
}

export function resolvedThemeToBootstrapSnapshot(
  resolved: ResolvedThemeState,
  packageChecksumSha256?: string,
): LingThemeBootstrapSnapshot | undefined {
  if (resolved.source !== "local-import" && resolved.source !== "local-generated") {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1,
    themeId: resolved.themeId,
    colorScheme: resolved.colorScheme,
    source: resolved.source,
    presentationProfileId: resolved.presentationProfileId,
    variableMap: resolved.variableMap,
    ...(packageChecksumSha256 ? { packageChecksumSha256 } : {}),
  });
}

export function bootstrapSnapshotToResolvedTheme(
  selection: ThemeSelection,
  snapshot: LingThemeBootstrapSnapshot,
): ResolvedThemeState {
  const tokens = cssVariablesToThemeTokens(snapshot.variableMap);
  const manifest: LingThemePackManifest = Object.freeze({
    schemaVersion: 1,
    id: snapshot.themeId,
    name: snapshot.themeId,
    colorScheme: snapshot.colorScheme,
    source: snapshot.source,
    tokens,
    presentation: { profileId: snapshot.presentationProfileId },
  });
  return Object.freeze({
    selection,
    themeId: snapshot.themeId,
    colorScheme: snapshot.colorScheme,
    source: snapshot.source,
    presentationProfileId: snapshot.presentationProfileId,
    manifest,
    variableMap: snapshot.variableMap,
  });
}

export function manifestMatchesVariableMap(
  manifest: LingThemePackManifest,
  variableMap: Readonly<Partial<Record<LingThemeCssVariable, string>>>,
): boolean {
  const expected = themeTokensToCssVariables(manifest.tokens);
  return LING_THEME_CSS_VARIABLES.every((variable) => expected[variable] === variableMap[variable]);
}

function cssVariablesToThemeTokens(variableMap: Readonly<Record<LingThemeCssVariable, string>>): LingThemeTokens {
  return Object.freeze({
    background: Object.freeze({
      app: variableMap["--ling-bg-app"],
      panel: variableMap["--ling-bg-panel"],
      elevated: variableMap["--ling-bg-elevated"],
      subtle: variableMap["--ling-bg-subtle"],
      pressed: variableMap["--ling-bg-pressed"],
      overlay: variableMap["--ling-bg-overlay"],
      code: variableMap["--ling-bg-code"],
      sidebar: variableMap["--ling-bg-sidebar"],
      composer: variableMap["--ling-bg-composer"],
    }),
    text: Object.freeze({
      strong: variableMap["--ling-text-strong"],
      default: variableMap["--ling-text-default"],
      muted: variableMap["--ling-text-muted"],
      soft: variableMap["--ling-text-soft"],
      inverse: variableMap["--ling-text-inverse"],
      link: variableMap["--ling-text-link"],
    }),
    border: Object.freeze({
      default: variableMap["--ling-border-default"],
      strong: variableMap["--ling-border-strong"],
      focus: variableMap["--ling-border-focus"],
    }),
    action: Object.freeze({
      accent: variableMap["--ling-action-accent"],
      accentHover: variableMap["--ling-action-accent-hover"],
      accentPressed: variableMap["--ling-action-accent-pressed"],
      accentForeground: variableMap["--ling-action-accent-fg"],
      selection: variableMap["--ling-action-selection"],
    }),
    status: Object.freeze({
      success: Object.freeze({ foreground: variableMap["--ling-status-success"], background: variableMap["--ling-status-success-bg"], border: variableMap["--ling-status-success-border"] }),
      warning: Object.freeze({ foreground: variableMap["--ling-status-warning"], background: variableMap["--ling-status-warning-bg"], border: variableMap["--ling-status-warning-border"] }),
      danger: Object.freeze({ foreground: variableMap["--ling-status-danger"], background: variableMap["--ling-status-danger-bg"], border: variableMap["--ling-status-danger-border"] }),
      info: Object.freeze({ foreground: variableMap["--ling-status-info"], background: variableMap["--ling-status-info-bg"], border: variableMap["--ling-status-info-border"] }),
    }),
    shadow: Object.freeze({
      low: variableMap["--ling-shadow-low"],
      medium: variableMap["--ling-shadow-medium"],
      overlay: variableMap["--ling-shadow-overlay"],
    }),
    native: Object.freeze({
      selection: variableMap["--ling-native-selection"],
      scrollbar: variableMap["--ling-native-scrollbar"],
      scrollbarHover: variableMap["--ling-native-scrollbar-hover"],
    }),
  });
}
