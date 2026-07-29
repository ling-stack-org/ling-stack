import { builtInThemeManifests } from "./built-ins/index.js";
import { presentationProfileId } from "./token-map.js";
import {
  type LingColorScheme,
  type LingThemePackManifest,
  type LingThemeSource,
  type RegisteredTheme,
  type ResolvedThemeState,
  type ThemeSelection,
} from "./types.js";
import { validateThemeManifest } from "./validate-theme.js";

export interface ThemeInstallResult {
  readonly ok: boolean;
  readonly theme?: RegisteredTheme;
  readonly issues?: readonly { readonly code: string; readonly path: string; readonly message: string }[];
}

export interface ThemeRegistryOptions {
  readonly builtIns?: readonly LingThemePackManifest[];
}

export class ThemeRegistry {
  private readonly themes = new Map<string, RegisteredTheme>();

  constructor(options: ThemeRegistryOptions = {}) {
    for (const manifest of options.builtIns ?? builtInThemeManifests) {
      const result = validateThemeManifest(manifest, { source: "built-in" });
      if (!result.ok) {
        throw new Error(`Built-in theme ${manifest.id} is invalid: ${result.issues.map((item) => `${item.path}: ${item.message}`).join("; ")}`);
      }
      this.themes.set(manifest.id, Object.freeze({
        manifest: result.candidate.manifest,
        source: "built-in",
        state: "ready",
        variableMap: result.candidate.variableMap,
      }));
    }
  }

  list(): readonly RegisteredTheme[] {
    return Object.freeze([...this.themes.values()].sort((left, right) => left.manifest.name.localeCompare(right.manifest.name)));
  }

  get(themeId: string): RegisteredTheme | undefined {
    return this.themes.get(themeId);
  }

  install(
    manifest: unknown,
    source: Exclude<LingThemeSource, "built-in">,
    installedAt = new Date().toISOString(),
  ): ThemeInstallResult {
    const result = validateThemeManifest(manifest, { source });
    if (!result.ok) return { ok: false, issues: result.issues };
    const existing = this.themes.get(result.candidate.manifest.id);
    if (existing?.source === "built-in") {
      return {
        ok: false,
        issues: [{ code: "reserved-id", path: "id", message: "Built-in themes cannot be replaced." }],
      };
    }
    const theme = Object.freeze<RegisteredTheme>({
      manifest: result.candidate.manifest,
      source,
      state: "ready",
      variableMap: result.candidate.variableMap,
      installedAt,
    });
    this.themes.set(theme.manifest.id, theme);
    return { ok: true, theme };
  }

  uninstall(themeId: string): boolean {
    const theme = this.themes.get(themeId);
    if (!theme || theme.source === "built-in") return false;
    return this.themes.delete(themeId);
  }

  resolve(selection: ThemeSelection, systemScheme: LingColorScheme): ResolvedThemeState {
    const requestedThemeId = selection.mode === "fixed"
      ? selection.themeId
      : systemScheme === "dark"
        ? selection.darkThemeId
        : selection.lightThemeId;
    const requested = this.themes.get(requestedThemeId);
    if (requested?.state === "ready") return resolved(selection, requested);
    const expectedScheme = requested?.manifest.colorScheme ?? systemScheme;
    const fallbackId = expectedScheme === "dark" ? "ling-dark" : "ling-light";
    const fallback = this.themes.get(fallbackId);
    if (!fallback || fallback.state !== "ready") {
      throw new Error(`Required built-in fallback ${fallbackId} is unavailable.`);
    }
    return Object.freeze({
      ...resolved(selection, fallback),
      source: "fallback",
      fallbackFrom: requestedThemeId,
    });
  }
}

function resolved(selection: ThemeSelection, theme: RegisteredTheme): ResolvedThemeState {
  return Object.freeze({
    selection,
    themeId: theme.manifest.id,
    colorScheme: theme.manifest.colorScheme,
    source: theme.source,
    presentationProfileId: presentationProfileId(theme.manifest.presentation),
    manifest: theme.manifest,
    variableMap: theme.variableMap,
  });
}

export function createThemeRegistry(options?: ThemeRegistryOptions): ThemeRegistry {
  return new ThemeRegistry(options);
}
