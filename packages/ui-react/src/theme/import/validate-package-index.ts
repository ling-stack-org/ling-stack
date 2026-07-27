import {
  LING_THEME_PACKAGE_LIMITS,
  type LingThemePackageIndexEntry,
  type LingThemePackageIndexValidation,
  type LingThemePackageIssue,
} from "./package-types.js";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const ASSET_PATH_PATTERN = /^assets\/[a-zA-Z0-9][a-zA-Z0-9._/-]*\.(?:jpe?g|png|webp)$/;

export function validateThemePackageIndex(
  archiveBytes: number,
  entries: readonly LingThemePackageIndexEntry[],
): LingThemePackageIndexValidation {
  const issues: LingThemePackageIssue[] = [];
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes <= 0) {
    addIssue(issues, "archive-empty", "$", "Theme archive is empty.");
  } else if (archiveBytes > LING_THEME_PACKAGE_LIMITS.archiveBytes) {
    addIssue(issues, "archive-too-large", "$", "Theme archive exceeds the 20 MB limit.");
  }
  if (entries.length > LING_THEME_PACKAGE_LIMITS.entryCount) {
    addIssue(issues, "too-many-entries", "$", "Theme archive contains too many entries.");
  }

  const seen = new Set<string>();
  const files: LingThemePackageIndexEntry[] = [];
  let manifestCount = 0;
  let totalUncompressedBytes = 0;

  for (const entry of entries) {
    const path = normalizeThemePackagePath(entry.originalPath, entry.kind === "directory");
    if (!path || path !== entry.path) {
      addIssue(issues, "unsafe-path", entry.originalPath || "$", "Theme entry path is unsafe or not canonical.");
      continue;
    }
    const collisionKey = path.toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) {
      addIssue(issues, "duplicate-path", path, "Theme archive contains a duplicate case-insensitive path.");
      continue;
    }
    seen.add(collisionKey);

    if (entry.kind === "directory") {
      if (path !== "assets/" && !path.startsWith("assets/")) {
        addIssue(issues, "unsupported-file", path, "Only the assets directory is allowed in a theme archive.");
      }
      continue;
    }
    if (entry.kind !== "file") {
      addIssue(issues, "unsupported-entry", path, "Theme archives may contain only regular files and directories.");
      continue;
    }
    if (
      !Number.isSafeInteger(entry.compressedBytes)
      || !Number.isSafeInteger(entry.uncompressedBytes)
      || entry.compressedBytes < 0
      || entry.uncompressedBytes < 0
    ) {
      addIssue(issues, "invalid-entry-size", path, "Theme entry has an invalid declared size.");
      continue;
    }

    files.push(entry);
    totalUncompressedBytes += entry.uncompressedBytes;
    if (path === "theme.json") {
      manifestCount += 1;
      if (entry.uncompressedBytes <= 0 || entry.uncompressedBytes > LING_THEME_PACKAGE_LIMITS.manifestBytes) {
        addIssue(issues, "file-too-large", path, "theme.json must be non-empty and no larger than 1 MB.");
      }
    } else if (path === "LICENSE.txt") {
      if (entry.uncompressedBytes > LING_THEME_PACKAGE_LIMITS.manifestBytes) {
        addIssue(issues, "file-too-large", path, "LICENSE.txt must be no larger than 1 MB.");
      }
    } else if (ASSET_PATH_PATTERN.test(path)) {
      if (entry.uncompressedBytes <= 0 || entry.uncompressedBytes > LING_THEME_PACKAGE_LIMITS.imageBytes) {
        addIssue(issues, "file-too-large", path, "Theme image must be non-empty and no larger than 16 MB.");
      }
    } else {
      addIssue(issues, "unsupported-file", path, "Theme archive contains an unsupported file.");
    }
  }

  if (files.length > LING_THEME_PACKAGE_LIMITS.fileCount) {
    addIssue(issues, "too-many-files", "$", "Theme archive contains more than 16 files.");
  }
  if (totalUncompressedBytes > LING_THEME_PACKAGE_LIMITS.totalUncompressedBytes) {
    addIssue(issues, "file-too-large", "$", "Theme archive exceeds the 32 MB uncompressed limit.");
  }
  if (manifestCount !== 1) {
    addIssue(issues, "missing-manifest", "theme.json", "Theme archive must contain exactly one root theme.json.");
  }

  return issues.length > 0
    ? { ok: false, issues: Object.freeze(issues) }
    : {
      ok: true,
      files: Object.freeze(files),
      totalUncompressedBytes,
    };
}

export function normalizeThemePackagePath(value: string, directory = false): string | undefined {
  if (
    value.length === 0
    || value.length > 240
    || value.startsWith("/")
    || value.includes("\\")
    || CONTROL_CHARACTER_PATTERN.test(value)
    || [...value].some((character) => character.codePointAt(0)! > 0x7f)
  ) return undefined;
  const hasTrailingSlash = value.endsWith("/");
  if (directory !== hasTrailingSlash) return undefined;
  const body = hasTrailingSlash ? value.slice(0, -1) : value;
  const segments = body.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return hasTrailingSlash ? `${segments.join("/")}/` : segments.join("/");
}

function addIssue(
  issues: LingThemePackageIssue[],
  code: LingThemePackageIssue["code"],
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ code, path, message }));
}
