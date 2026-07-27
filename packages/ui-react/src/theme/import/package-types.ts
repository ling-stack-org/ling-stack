import type { LingThemePackManifest } from "../types.js";

export const LING_THEME_PACKAGE_LIMITS = Object.freeze({
  archiveBytes: 20 * 1024 * 1024,
  decodedPixels: 32_000_000,
  entryCount: 32,
  fileCount: 16,
  imageEdgePixels: 8192,
  manifestBytes: 1024 * 1024,
  imageBytes: 16 * 1024 * 1024,
  totalUncompressedBytes: 32 * 1024 * 1024,
});

export type LingThemePackageEntryKind = "directory" | "file" | "symlink" | "special";

export interface LingThemePackageIndexEntry {
  readonly compressedBytes: number;
  readonly crc32: number;
  readonly kind: LingThemePackageEntryKind;
  readonly originalPath: string;
  readonly path: string;
  readonly uncompressedBytes: number;
}

export type LingThemePackageIssueCode =
  | "archive-empty"
  | "archive-too-large"
  | "duplicate-path"
  | "file-too-large"
  | "invalid-archive"
  | "invalid-entry-crc"
  | "invalid-entry-size"
  | "invalid-manifest"
  | "invalid-preview"
  | "invalid-preview-dimensions"
  | "invalid-preview-image"
  | "invalid-preview-mime"
  | "invalid-text"
  | "missing-manifest"
  | "missing-preview"
  | "runtime-artwork-not-supported"
  | "too-many-entries"
  | "too-many-files"
  | "unreferenced-asset"
  | "unsafe-path"
  | "unsupported-archive"
  | "unsupported-entry"
  | "unsupported-file";

export interface LingThemePackageIssue {
  readonly code: LingThemePackageIssueCode | string;
  readonly message: string;
  readonly path: string;
}

export type LingThemePackageIndexValidation =
  | {
    readonly ok: true;
    readonly files: readonly LingThemePackageIndexEntry[];
    readonly totalUncompressedBytes: number;
  }
  | { readonly ok: false; readonly issues: readonly LingThemePackageIssue[] };

export interface LingThemePackageSummary {
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256: string;
  readonly installedAt?: string;
  readonly licenseText?: string;
}

export type LingThemeImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export interface LingThemeImageDecodeRequest {
  readonly bytes: Uint8Array;
  readonly mimeType: LingThemeImageMimeType;
  readonly path: string;
}

export interface LingThemeImageDimensions {
  readonly height: number;
  readonly width: number;
}

export type LingThemeImageDecoder = (
  request: LingThemeImageDecodeRequest,
) => Promise<LingThemeImageDimensions> | LingThemeImageDimensions;

export interface ParseThemePackageBytesOptions {
  readonly decodeImage: LingThemeImageDecoder;
}

export type LingThemePackageFileMimeType =
  | "application/json"
  | "text/plain"
  | LingThemeImageMimeType;

export interface NormalizedLingThemePackageFile {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly mimeType: LingThemePackageFileMimeType;
  readonly path: "theme.json" | "LICENSE.txt" | `assets/${string}`;
}

export interface ParsedLingThemePreview {
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly checksumSha256: string;
  readonly height: number;
  readonly mimeType: LingThemeImageMimeType;
  readonly path: `assets/${string}`;
  readonly width: number;
}

export interface ParsedLingThemePackage {
  readonly archiveByteLength: number;
  readonly files: readonly NormalizedLingThemePackageFile[];
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256: string;
  readonly preview?: ParsedLingThemePreview;
  readonly warnings: readonly LingThemePackageIssue[];
}

export class LingThemePackageError extends Error {
  readonly issues: readonly LingThemePackageIssue[];

  constructor(issues: readonly LingThemePackageIssue[]) {
    super(issues[0]?.message ?? "Theme package is invalid.");
    this.name = "LingThemePackageError";
    this.issues = Object.freeze([...issues]);
  }
}
