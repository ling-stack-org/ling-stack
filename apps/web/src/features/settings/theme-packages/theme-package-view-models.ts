import {
  validateThemeManifest,
  type LingThemePackageIssue,
  type LingThemePackManifest,
  type LingThemeCssVariable,
  type RegisteredTheme,
} from "../../../shared/ui/index.js";
import type { Translate } from "../../../i18n.js";

export interface ThemePreviewTarget {
  readonly id: string;
  readonly manifest: LingThemePackManifest;
  readonly name: string;
  readonly source: RegisteredTheme["source"];
  readonly variableMap: Readonly<Record<LingThemeCssVariable, string>>;
}

export function registeredThemePreviewTarget(theme: RegisteredTheme): ThemePreviewTarget {
  return Object.freeze({
    id: theme.manifest.id,
    manifest: theme.manifest,
    name: theme.manifest.name,
    source: theme.source,
    variableMap: theme.variableMap,
  });
}

export function candidateThemePreviewTarget(manifest: LingThemePackManifest): ThemePreviewTarget {
  const validation = validateThemeManifest(manifest, { source: "local-import" });
  if (!validation.ok) throw new Error(validation.issues[0]?.message ?? "Theme manifest is invalid.");
  return Object.freeze({
    id: manifest.id,
    manifest: validation.candidate.manifest,
    name: validation.candidate.manifest.name,
    source: "local-import",
    variableMap: validation.candidate.variableMap,
  });
}

export function themePackageIssueLabel(issue: LingThemePackageIssue, t: Translate): string {
  switch (issue.code) {
    case "unsupported-extension": return t("Choose a .ling-theme file.");
    case "archive-empty": return t("The theme file is empty.");
    case "archive-too-large": return t("The theme file is larger than 20 MB.");
    case "invalid-archive":
    case "unsupported-archive": return t("This theme archive cannot be opened safely.");
    case "unsafe-path":
    case "duplicate-path": return t("The theme archive contains an unsafe file path.");
    case "unsupported-entry":
    case "unsupported-file": return t("The theme archive contains an unsupported file.");
    case "too-many-entries":
    case "too-many-files": return t("The theme archive contains too many files.");
    case "file-too-large":
    case "invalid-entry-size": return t("A file in this theme exceeds the allowed size.");
    case "missing-manifest":
    case "invalid-manifest":
    case "invalid-schema": return t("The theme manifest is missing or incompatible.");
    case "invalid-identity":
    case "reserved-id": return t("The theme identity is invalid or reserved.");
    case "missing-token":
    case "invalid-color":
    case "invalid-shadow":
    case "insufficient-contrast": return t("The theme colors do not meet Ling's readability requirements.");
    case "invalid-preview":
    case "missing-preview":
    case "invalid-preview-mime":
    case "invalid-preview-image":
    case "invalid-preview-dimensions": return t("The theme preview is missing or invalid.");
    case "runtime-artwork-not-supported": return t("Runtime backgrounds are not supported for imported themes yet.");
    case "unreferenced-asset": return t("This token-only theme contains an unreferenced asset.");
    case "theme-already-installed": return t("This theme is already installed. Use Reimport from its menu.");
    case "reimport-id-mismatch": return t("The replacement file must use the same theme ID.");
    case "publish-failed": return t("The theme could not be saved. The previous theme is unchanged.");
    case "apply-failed": return t("The theme was installed but could not be applied.");
    case "delete-failed": return t("The theme could not be deleted. It remains installed.");
    default: return t("The theme package could not be validated.");
  }
}

export function formatThemePackageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
