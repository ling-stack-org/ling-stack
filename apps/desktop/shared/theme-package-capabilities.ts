import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";

export const DESKTOP_THEME_PACKAGE_ERROR_CODES = Object.freeze([
  "unauthorized_sender",
  "invalid_request",
  "archive_empty",
  "archive_too_large",
  "invalid_archive",
  "unsupported_archive",
  "unsafe_path",
  "unsupported_entry",
  "unsupported_file",
  "invalid_entry_size",
  "invalid_entry_crc",
  "invalid_text",
  "invalid_manifest",
  "invalid_schema",
  "reserved_theme_id",
  "runtime_artwork_not_supported",
  "missing_preview",
  "invalid_preview_mime",
  "invalid_preview_image",
  "invalid_preview_dimensions",
  "checksum_mismatch",
  "theme_id_mismatch",
  "theme_already_installed",
  "theme_not_found",
  "built_in_theme_protected",
  "active_theme_protected",
  "active_theme_unknown",
  "stale_repository_revision",
  "operation_in_progress",
  "storage_unavailable",
  "permission_denied",
  "disk_full",
  "corrupt_installation",
  "publication_failed",
  "rollback_failed",
  "cleanup_failed",
  "unknown_io",
] as const);

export type DesktopThemePackageErrorCode =
  (typeof DESKTOP_THEME_PACKAGE_ERROR_CODES)[number];

export const DESKTOP_THEME_PACKAGE_WARNING_CODES = Object.freeze([
  "cleanup_pending",
] as const);

export type DesktopThemePackageWarningCode =
  (typeof DESKTOP_THEME_PACKAGE_WARNING_CODES)[number];

export type DesktopThemePackageHealth = "ready" | "corrupt";

export type DesktopThemePackagePreviewMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export interface DesktopThemePackagePreviewDescriptor {
  readonly path: string;
  readonly mimeType: DesktopThemePackagePreviewMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly checksumSha256: string;
}

export interface DesktopThemePackageDescriptor {
  readonly themeId: string;
  readonly health: DesktopThemePackageHealth;
  readonly recordRevision: number;
  readonly manifest?: LingThemePackManifest;
  readonly packageChecksumSha256?: string;
  readonly installedAt?: string;
  readonly updatedAt?: string;
  readonly preview?: DesktopThemePackagePreviewDescriptor;
  readonly issueCode?: DesktopThemePackageErrorCode;
}

export interface DesktopThemePackageReadValue {
  readonly descriptor: DesktopThemePackageDescriptor;
  readonly licenseText?: string;
  readonly previewBytes?: ArrayBuffer;
}

export interface DesktopThemePackageWarning {
  readonly code: DesktopThemePackageWarningCode;
  readonly operationId?: string;
  readonly themeId?: string;
  readonly relativePath?: string;
  readonly retryable: boolean;
}

export interface DesktopThemePackageBootstrapValue {
  readonly repositoryRevision: number;
  readonly packages: readonly DesktopThemePackageDescriptor[];
  readonly recoveryWarnings: readonly DesktopThemePackageWarning[];
  readonly activeGuardReady: boolean;
}

export interface DesktopThemePackageFirstPaintState {
  readonly repositoryRevision: number;
  readonly authorityComplete: boolean;
  readonly readyThemes: readonly DesktopThemePackageFirstPaintEntry[];
}

export interface DesktopThemePackageFirstPaintEntry {
  readonly themeId: string;
  readonly packageChecksumSha256: string;
}

export interface DesktopThemePackageReadRequest {
  readonly themeId: string;
  readonly includePreviewBytes: boolean;
}

export interface DesktopThemePackageArchiveRequest {
  readonly requestId: string;
  readonly originalFileName: string;
  readonly archiveBytes: ArrayBuffer;
  readonly rendererPackageChecksumSha256: string;
}

export interface DesktopThemePackageReimportRequest
  extends DesktopThemePackageArchiveRequest {
  readonly themeId: string;
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
}

export interface DesktopThemePackageDeleteRequest {
  readonly requestId: string;
  readonly themeId: string;
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
}

export interface DesktopThemePackageSetActiveRequest {
  readonly themeId: string;
}

export interface DesktopThemePackageDeleteValue {
  readonly repositoryRevision: number;
}

export interface DesktopThemePackageSetActiveValue {
  readonly activeThemeId: string;
}

export interface DesktopThemePackageError {
  readonly code: DesktopThemePackageErrorCode;
  readonly operationId?: string;
  readonly themeId?: string;
  readonly relativePath?: string;
  readonly retryable: boolean;
}

export type DesktopThemePackageResult<T> =
  | {
    readonly ok: true;
    readonly value: T;
    readonly warnings: readonly DesktopThemePackageWarning[];
  }
  | {
    readonly ok: false;
    readonly error: DesktopThemePackageError;
  };

export type DesktopThemePackageBootstrapResult =
  DesktopThemePackageResult<DesktopThemePackageBootstrapValue>;

export type DesktopThemePackageListResult =
  DesktopThemePackageResult<readonly DesktopThemePackageDescriptor[]>;

export type DesktopThemePackageReadResult =
  DesktopThemePackageResult<DesktopThemePackageReadValue>;

export type DesktopThemePackageInstallResult =
  DesktopThemePackageResult<DesktopThemePackageDescriptor>;

export type DesktopThemePackageReimportResult =
  DesktopThemePackageResult<DesktopThemePackageDescriptor>;

export type DesktopThemePackageDeleteResult =
  DesktopThemePackageResult<DesktopThemePackageDeleteValue>;

export type DesktopThemePackageSetActiveResult =
  DesktopThemePackageResult<DesktopThemePackageSetActiveValue>;

export interface DesktopThemePackageCapabilities {
  readonly firstPaint?: DesktopThemePackageFirstPaintState;
  bootstrap(): Promise<DesktopThemePackageBootstrapResult>;
  list(): Promise<DesktopThemePackageListResult>;
  read(request: DesktopThemePackageReadRequest): Promise<DesktopThemePackageReadResult>;
  install(request: DesktopThemePackageArchiveRequest): Promise<DesktopThemePackageInstallResult>;
  reimport(request: DesktopThemePackageReimportRequest): Promise<DesktopThemePackageReimportResult>;
  delete(request: DesktopThemePackageDeleteRequest): Promise<DesktopThemePackageDeleteResult>;
  setActive(request: DesktopThemePackageSetActiveRequest): Promise<DesktopThemePackageSetActiveResult>;
}

export type DesktopThemePackageIpcChannelKey =
  | "themePackagesBootstrap"
  | "themePackagesList"
  | "themePackagesRead"
  | "themePackagesInstall"
  | "themePackagesReimport"
  | "themePackagesDelete"
  | "themePackagesActiveSet";
