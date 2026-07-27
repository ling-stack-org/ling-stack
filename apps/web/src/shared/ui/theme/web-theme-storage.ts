import {
  DEFAULT_THEME_SELECTION,
  parseThemeBootstrapSnapshot,
  parseThemeSelection,
  resolvedThemeToBootstrapSnapshot,
  type LingThemeBootstrapSnapshot,
  type LingThemePackManifest,
  type ResolvedThemeState,
  type ThemeSelection,
} from "@ling-stack/ui-react/theme";
import {
  WEB_THEME_MANIFEST_STORE,
  openWebThemeDatabase,
} from "./web-theme-database.js";

export type LegacyThemePreference = "system" | "light" | "dark";

export const THEME_SELECTION_STORAGE_KEY = "ling-stack.themeSelection";
export const THEME_BOOTSTRAP_SELECTION_STORAGE_KEY = "ling-stack.themeBootstrapSelection";
export const THEME_BOOTSTRAP_SNAPSHOT_STORAGE_KEY = "ling-stack.themeBootstrapSnapshot";
export const LEGACY_THEME_STORAGE_KEY = "ling-stack.themePreference";
export const LEGACY_THEME_BOOTSTRAP_STORAGE_KEY = "ling-stack.themeBootstrapPreference";

export function readInitialThemeSelection(): { readonly selection: ThemeSelection; readonly explicit: boolean } {
  const bootstrap = readStoredSelection(THEME_BOOTSTRAP_SELECTION_STORAGE_KEY);
  if (bootstrap) return { selection: bootstrap, explicit: true };
  const saved = readStoredSelection(THEME_SELECTION_STORAGE_KEY);
  if (saved) return { selection: saved, explicit: true };
  const legacy = readLegacyBootstrapPreference() ?? readSavedLegacyThemePreference();
  return { selection: legacy ? legacyPreferenceToSelection(legacy) : DEFAULT_THEME_SELECTION, explicit: false };
}

export function readThemeBootstrapSnapshot(): LingThemeBootstrapSnapshot | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_BOOTSTRAP_SNAPSHOT_STORAGE_KEY);
    return raw ? parseThemeBootstrapSnapshot(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

export function persistResolvedTheme(
  selection: ThemeSelection,
  resolved: ResolvedThemeState,
  packageChecksumSha256?: string,
): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error("Theme preference storage is unavailable.");
  const writes = new Map<string, string | null>([
    [THEME_SELECTION_STORAGE_KEY, JSON.stringify(selection)],
    [THEME_BOOTSTRAP_SELECTION_STORAGE_KEY, JSON.stringify(selection)],
    [THEME_BOOTSTRAP_SNAPSHOT_STORAGE_KEY, snapshotJson(resolved, packageChecksumSha256)],
    [LEGACY_THEME_BOOTSTRAP_STORAGE_KEY, legacyPreferenceFromResolved(resolved)],
  ]);
  const previous = new Map<string, string | null>();
  for (const key of writes.keys()) previous.set(key, storage.getItem(key));
  try {
    for (const [key, value] of writes) {
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
  } catch (error) {
    for (const [key, value] of previous) {
      try {
        if (value === null) storage.removeItem(key);
        else storage.setItem(key, value);
      } catch {
        // Preserve the original storage failure; the DOM transaction will roll back.
      }
    }
    throw error;
  }
}

export function readSavedLegacyThemePreference(): LegacyThemePreference | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(LEGACY_THEME_STORAGE_KEY);
    return isLegacyThemePreference(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

export function clearSavedLegacyThemePreference(): void {
  try {
    globalThis.localStorage?.removeItem(LEGACY_THEME_STORAGE_KEY);
  } catch {
    // Legacy cleanup is best effort in restricted browser contexts.
  }
}

export function writeLegacyBootstrapPreference(preference: LegacyThemePreference): void {
  try {
    globalThis.localStorage?.setItem(LEGACY_THEME_BOOTSTRAP_STORAGE_KEY, preference);
  } catch {
    // The current session can continue even if the legacy mirror is unavailable.
  }
}

export function legacyPreferenceToSelection(preference: LegacyThemePreference): ThemeSelection {
  if (preference === "system") return DEFAULT_THEME_SELECTION;
  return { mode: "fixed", themeId: preference === "dark" ? "ling-dark" : "ling-light" };
}

export function themeSelectionToLegacyPreference(
  selection: ThemeSelection,
  resolved: ResolvedThemeState,
): LegacyThemePreference {
  if (selection.mode === "system") return "system";
  if (resolved.themeId === "ling-dark") return "dark";
  if (resolved.themeId === "ling-light") return "light";
  return resolved.colorScheme;
}

export async function listStoredThemeManifests(): Promise<readonly LingThemePackManifest[]> {
  const database = await openWebThemeDatabase();
  if (!database) return [];
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(WEB_THEME_MANIFEST_STORE, "readonly");
      const request = transaction.objectStore(WEB_THEME_MANIFEST_STORE).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result as LingThemePackManifest[] : []);
      request.onerror = () => reject(request.error ?? new Error("Theme registry read failed."));
    });
  } finally {
    database.close();
  }
}

export async function putStoredThemeManifest(manifest: LingThemePackManifest): Promise<void> {
  const database = await openWebThemeDatabase();
  if (!database) throw new Error("Theme registry storage is unavailable.");
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WEB_THEME_MANIFEST_STORE, "readwrite");
      transaction.objectStore(WEB_THEME_MANIFEST_STORE).put(manifest);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Theme registry write failed."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Theme registry write was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function deleteStoredThemeManifest(themeId: string): Promise<void> {
  const database = await openWebThemeDatabase();
  if (!database) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(WEB_THEME_MANIFEST_STORE, "readwrite");
      transaction.objectStore(WEB_THEME_MANIFEST_STORE).delete(themeId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Theme registry delete failed."));
    });
  } finally {
    database.close();
  }
}

function snapshotJson(resolved: ResolvedThemeState, packageChecksumSha256?: string): string | null {
  const snapshot = resolvedThemeToBootstrapSnapshot(resolved, packageChecksumSha256);
  return snapshot ? JSON.stringify(snapshot) : null;
}

function legacyPreferenceFromResolved(resolved: ResolvedThemeState): LegacyThemePreference {
  return themeSelectionToLegacyPreference(resolved.selection, resolved);
}

function readStoredSelection(key: string): ThemeSelection | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? parseThemeSelection(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

function readLegacyBootstrapPreference(): LegacyThemePreference | undefined {
  try {
    const saved = globalThis.localStorage?.getItem(LEGACY_THEME_BOOTSTRAP_STORAGE_KEY);
    return isLegacyThemePreference(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function isLegacyThemePreference(value: unknown): value is LegacyThemePreference {
  return value === "system" || value === "light" || value === "dark";
}
