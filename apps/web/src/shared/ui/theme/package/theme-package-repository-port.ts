import type { LingThemePackManifest } from "@ling-stack/ui-react/theme";
import type {
  DesktopThemePackageBootstrapValue,
  DesktopThemePackageDeleteValue,
  DesktopThemePackageDescriptor,
  DesktopThemePackageError,
  DesktopThemePackageErrorCode,
  DesktopThemePackageResult,
  DesktopThemePackageSetActiveValue,
  DesktopThemePackageWarning,
} from "../../../../../../desktop/shared/theme-package-capabilities.js";

export type ThemePackageRepositoryKind = "desktop" | "web";
export type ThemePackageRepositoryDescriptor = DesktopThemePackageDescriptor;
export type ThemePackageRepositoryError = DesktopThemePackageError;
export type ThemePackageRepositoryErrorCode = DesktopThemePackageErrorCode;
export type ThemePackageRepositoryWarning = DesktopThemePackageWarning;
export type ThemePackageRepositoryResult<T> = DesktopThemePackageResult<T>;
export type ThemePackageRepositoryBootstrapValue = DesktopThemePackageBootstrapValue;
export type ThemePackageRepositoryDeleteValue = DesktopThemePackageDeleteValue;
export type ThemePackageRepositorySetActiveValue = DesktopThemePackageSetActiveValue;

export interface ThemePackageRepositoryPreview {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly height: number;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly path: string;
  readonly width: number;
}

export interface ThemePackageRepositoryPublication {
  readonly licenseText?: string;
  readonly manifest: LingThemePackManifest;
  readonly packageChecksumSha256: string;
  readonly preview?: ThemePackageRepositoryPreview;
}

export interface ThemePackageRepositoryReadValue {
  readonly descriptor: ThemePackageRepositoryDescriptor;
  readonly licenseText?: string;
  readonly preview?: ThemePackageRepositoryPreview;
}

export interface ThemePackageRepositoryReadRequest {
  readonly includePreviewBytes: boolean;
  readonly themeId: string;
}

export interface ThemePackageRepositoryInstallRequest {
  readonly archiveBytes: Uint8Array;
  readonly originalFileName: string;
  readonly publication: ThemePackageRepositoryPublication;
  readonly requestId: string;
}

export interface ThemePackageRepositoryReimportRequest extends ThemePackageRepositoryInstallRequest {
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
  readonly themeId: string;
}

export interface ThemePackageRepositoryDeleteRequest {
  readonly expectedCurrentChecksumSha256?: string;
  readonly expectedRecordRevision: number;
  readonly requestId: string;
  readonly themeId: string;
}

export interface ThemePackageRepositorySetActiveRequest {
  readonly themeId: string;
}

export interface ThemePackageRepositoryPort {
  readonly kind: ThemePackageRepositoryKind;
  bootstrap(): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryBootstrapValue>>;
  list(): Promise<ThemePackageRepositoryResult<readonly ThemePackageRepositoryDescriptor[]>>;
  read(request: ThemePackageRepositoryReadRequest): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryReadValue>>;
  install(request: ThemePackageRepositoryInstallRequest): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>>;
  reimport(request: ThemePackageRepositoryReimportRequest): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDescriptor>>;
  delete(request: ThemePackageRepositoryDeleteRequest): Promise<ThemePackageRepositoryResult<ThemePackageRepositoryDeleteValue>>;
  setActive(request: ThemePackageRepositorySetActiveRequest): Promise<ThemePackageRepositoryResult<ThemePackageRepositorySetActiveValue>>;
}

export function themePackageRepositorySuccess<T>(
  value: T,
  warnings: readonly ThemePackageRepositoryWarning[] = [],
): ThemePackageRepositoryResult<T> {
  return Object.freeze({ ok: true, value, warnings: Object.freeze([...warnings]) });
}

export function themePackageRepositoryFailure(
  code: ThemePackageRepositoryErrorCode,
  detail: Omit<ThemePackageRepositoryError, "code" | "retryable"> & { readonly retryable?: boolean } = {},
): ThemePackageRepositoryResult<never> {
  return Object.freeze({
    ok: false,
    error: Object.freeze({
      code,
      retryable: detail.retryable ?? false,
      ...(detail.operationId !== undefined ? { operationId: detail.operationId } : {}),
      ...(detail.relativePath !== undefined ? { relativePath: detail.relativePath } : {}),
      ...(detail.themeId !== undefined ? { themeId: detail.themeId } : {}),
    }),
  });
}
