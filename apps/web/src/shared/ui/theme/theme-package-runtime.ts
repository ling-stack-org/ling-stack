import type {
  LingColorScheme,
  LingThemePackManifest,
  ThemeSelection,
} from "@ling-stack/ui-react/theme";
import type {
  ThemePackageRepositoryDescriptor,
  ThemePackageRepositoryError,
  ThemePackageRepositoryReadValue,
  ThemePackageRepositoryResult,
} from "./package/theme-package-repository-port.js";
import type {
  ParsedWebThemePackage,
  StoredWebThemePackage,
} from "./package/index.js";

export type ThemePackageRepairKind = "corrupt" | "legacy-browser-only";

export interface ThemePackageRepairItem {
  readonly descriptor?: ThemePackageRepositoryDescriptor;
  readonly displayName: string;
  readonly issueCode?: string;
  readonly kind: ThemePackageRepairKind;
  readonly themeId: string;
}

export class ThemePackageRepositoryOperationError extends Error {
  readonly detail: ThemePackageRepositoryError;

  constructor(detail: ThemePackageRepositoryError) {
    super(detail.code);
    this.name = "ThemePackageRepositoryOperationError";
    this.detail = detail;
  }
}

export function requireThemePackageResult<T>(
  result: ThemePackageRepositoryResult<T>,
): T {
  if (!result.ok) throw new ThemePackageRepositoryOperationError(result.error);
  return result.value;
}

export function themePackagePublication(candidate: ParsedWebThemePackage) {
  return Object.freeze({
    manifest: candidate.manifest,
    packageChecksumSha256: candidate.packageChecksumSha256,
    ...(candidate.licenseText !== undefined ? { licenseText: candidate.licenseText } : {}),
    ...(candidate.preview !== undefined ? { preview: candidate.preview } : {}),
  });
}

export function createThemePackageRequestId(operation: "delete" | "install" | "reimport"): string {
  const suffix = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${operation}-${suffix}`.slice(0, 80);
}

export function storedPackageFromRepositoryRead(
  value: ThemePackageRepositoryReadValue,
): StoredWebThemePackage | undefined {
  const manifest = value.descriptor.manifest;
  if (!manifest || value.descriptor.health !== "ready") return undefined;
  return Object.freeze({
    installedAt: value.descriptor.installedAt ?? new Date(0).toISOString(),
    manifest,
    updatedAt: value.descriptor.updatedAt ?? new Date(0).toISOString(),
    ...(value.licenseText !== undefined ? { licenseText: value.licenseText } : {}),
    ...(value.descriptor.packageChecksumSha256 !== undefined
      ? { packageChecksumSha256: value.descriptor.packageChecksumSha256 }
      : {}),
    ...(value.preview !== undefined ? { preview: value.preview } : {}),
  });
}

export function repairUnavailableThemeSelection(
  selection: ThemeSelection,
  availableThemeIds: ReadonlySet<string>,
  systemScheme: LingColorScheme,
  manifests: ReadonlyMap<string, LingThemePackManifest>,
  snapshotScheme?: LingColorScheme,
): ThemeSelection {
  if (selection.mode === "fixed") {
    if (availableThemeIds.has(selection.themeId)) return selection;
    return {
      mode: "fixed",
      themeId: fallbackThemeId(manifests.get(selection.themeId)?.colorScheme ?? snapshotScheme ?? systemScheme),
    };
  }
  return {
    mode: "system",
    lightThemeId: availableThemeIds.has(selection.lightThemeId) ? selection.lightThemeId : "ling-light",
    darkThemeId: availableThemeIds.has(selection.darkThemeId) ? selection.darkThemeId : "ling-dark",
  };
}

export function fallbackThemeId(scheme: LingColorScheme): "ling-dark" | "ling-light" {
  return scheme === "dark" ? "ling-dark" : "ling-light";
}

export function selectionAfterThemeRemoval(
  selection: ThemeSelection,
  themeId: string,
  scheme: LingColorScheme,
): ThemeSelection {
  const fallbackId = fallbackThemeId(scheme);
  if (selection.mode === "fixed") return { mode: "fixed", themeId: fallbackId };
  return {
    mode: "system",
    lightThemeId: selection.lightThemeId === themeId ? "ling-light" : selection.lightThemeId,
    darkThemeId: selection.darkThemeId === themeId ? "ling-dark" : selection.darkThemeId,
  };
}
