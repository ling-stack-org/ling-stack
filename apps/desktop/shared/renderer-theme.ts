export const DESKTOP_RENDERER_THEME_VARIABLES = [
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
  "--ling-status-neutral",
  "--ling-status-info",
  "--ling-status-info-bg",
  "--ling-status-info-border",
  "--ling-status-success",
  "--ling-status-success-bg",
  "--ling-status-success-border",
  "--ling-status-warning",
  "--ling-status-danger",
  "--ling-status-warning-bg",
  "--ling-status-warning-border",
  "--ling-status-danger-bg",
  "--ling-status-danger-border",
  "--ling-shadow-low",
  "--ling-shadow-medium",
  "--ling-shadow-overlay",
  "--ling-native-selection",
  "--ling-native-scrollbar",
  "--ling-native-scrollbar-hover",
  "--ling-overlay-scrim",
  "--ling-compact-window-bg",
  "--ling-compact-window-elevated",
  "--ling-compact-window-text",
  "--ling-compact-window-muted",
  "--ling-compact-window-border",
  "--ling-compact-window-focus",
  "--ling-compact-window-shadow",
] as const;

export type DesktopRendererThemeVariable = typeof DESKTOP_RENDERER_THEME_VARIABLES[number];
export type DesktopRendererColorScheme = "light" | "dark";

export interface DesktopRendererThemeInput {
  readonly themeId: string;
  readonly colorScheme: DesktopRendererColorScheme;
  readonly presentationProfileId: string;
  readonly variables: Readonly<Partial<Record<DesktopRendererThemeVariable, string>>>;
}

export interface DesktopRendererThemeSnapshot extends DesktopRendererThemeInput {
  readonly revision: number;
}

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_THEME_ID_LENGTH = 64;
const MAX_THEME_VALUE_LENGTH = 256;
const unsafeThemeValuePattern = /[;{}<>]|(?:url|var|env|attr|image-set|expression)\s*\(|@import|[\u0000-\u001f\u007f]/i;
const PRESENTATION_PROFILE_IDS = ["ling-standard", "ling-glass", "ling-immersive", "ling-illustrated"] as const;

export function parseDesktopRendererThemeInput(value: unknown): DesktopRendererThemeInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const themeId = readIdentifier(value.themeId);
  const presentationProfileId = readPresentationProfileId(value.presentationProfileId);
  const colorScheme = value.colorScheme;
  if (
    !themeId
    || !presentationProfileId
    || (colorScheme !== "light" && colorScheme !== "dark")
    || !isRecord(value.variables)
  ) {
    return undefined;
  }
  const variables: Partial<Record<DesktopRendererThemeVariable, string>> = {};
  for (const variable of DESKTOP_RENDERER_THEME_VARIABLES) {
    const rawValue = value.variables[variable];
    if (rawValue === undefined) {
      continue;
    }
    const parsedValue = readThemeValue(rawValue);
    if (!parsedValue) {
      return undefined;
    }
    variables[variable] = parsedValue;
  }
  if (Object.keys(value.variables).some((key) => !isDesktopRendererThemeVariable(key))) {
    return undefined;
  }
  return Object.freeze({
    themeId,
    colorScheme,
    presentationProfileId,
    variables: Object.freeze(variables),
  });
}

export function parseDesktopRendererThemeSnapshot(value: unknown): DesktopRendererThemeSnapshot | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0) {
    return undefined;
  }
  const input = parseDesktopRendererThemeInput(value);
  return input ? Object.freeze({ ...input, revision: Number(value.revision) }) : undefined;
}

export function builtInDesktopRendererThemeInput(
  colorScheme: DesktopRendererColorScheme,
): DesktopRendererThemeInput {
  return {
    themeId: colorScheme === "dark" ? "ling-dark" : "ling-light",
    colorScheme,
    presentationProfileId: "ling-standard",
    variables: {},
  };
}

function isDesktopRendererThemeVariable(value: string): value is DesktopRendererThemeVariable {
  return DESKTOP_RENDERER_THEME_VARIABLES.includes(value as DesktopRendererThemeVariable);
}

function readIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0
    && normalized.length <= MAX_THEME_ID_LENGTH
    && THEME_ID_PATTERN.test(normalized)
    ? normalized
    : undefined;
}

function readThemeValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= MAX_THEME_VALUE_LENGTH
    && !unsafeThemeValuePattern.test(normalized)
    ? normalized
    : undefined;
}

function readPresentationProfileId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PRESENTATION_PROFILE_IDS.includes(normalized as typeof PRESENTATION_PROFILE_IDS[number])
    ? normalized
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
