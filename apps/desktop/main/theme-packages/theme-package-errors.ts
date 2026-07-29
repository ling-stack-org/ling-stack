import { createHash } from "node:crypto";
import { basename, resolve, win32 } from "node:path";
import { LingThemePackageError } from "@ling-stack/ui-react/theme";
import { LING_THEME_PACKAGE_LIMITS } from "@ling-stack/ui-react/theme";
import type {
  DesktopThemePackageArchiveRequest,
  DesktopThemePackageError,
  DesktopThemePackageErrorCode,
  DesktopThemePackageResult,
  DesktopThemePackageWarning,
} from "../../shared/theme-package-capabilities.js";

const PARSER_ERROR_CODES: Readonly<Record<string, DesktopThemePackageErrorCode>> = Object.freeze({
  "archive-empty": "archive_empty",
  "archive-too-large": "archive_too_large",
  "duplicate-path": "unsafe_path",
  "file-too-large": "invalid_entry_size",
  "invalid-archive": "invalid_archive",
  "invalid-entry-crc": "invalid_entry_crc",
  "invalid-entry-size": "invalid_entry_size",
  "invalid-manifest": "invalid_manifest",
  "invalid-preview": "invalid_schema",
  "invalid-preview-dimensions": "invalid_preview_dimensions",
  "invalid-preview-image": "invalid_preview_image",
  "invalid-preview-mime": "invalid_preview_mime",
  "invalid-text": "invalid_text",
  "missing-manifest": "invalid_manifest",
  "missing-preview": "missing_preview",
  "runtime-artwork-not-supported": "runtime_artwork_not_supported",
  "too-many-entries": "archive_too_large",
  "too-many-files": "archive_too_large",
  "unreferenced-asset": "unsupported_file",
  "unsafe-path": "unsafe_path",
  "unsupported-archive": "unsupported_archive",
  "unsupported-entry": "unsupported_entry",
  "unsupported-file": "unsupported_file",
  "reserved-id": "reserved_theme_id",
});

export class ThemePackageRepositoryError extends Error {
  readonly detail: DesktopThemePackageError;

  constructor(
    code: DesktopThemePackageErrorCode,
    options: {
      readonly operationId?: string;
      readonly themeId?: string;
      readonly relativePath?: string;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super(code, { cause: options.cause });
    this.name = "ThemePackageRepositoryError";
    this.detail = Object.freeze({
      code,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(options.themeId ? { themeId: options.themeId } : {}),
      ...(options.relativePath ? { relativePath: options.relativePath } : {}),
      retryable: options.retryable ?? false,
    });
  }
}

export class AsyncMutationMutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

interface ThemeRequestCacheEntry {
  fingerprint: string;
  promise: Promise<DesktopThemePackageResult<unknown>>;
  settled: boolean;
}

export class ThemeRequestDedupe {
  readonly #cache = new Map<string, ThemeRequestCacheEntry>();

  run<T>(requestId: string, fingerprint: string, action: () => Promise<DesktopThemePackageResult<T>>): Promise<DesktopThemePackageResult<T>> {
    const existing = this.#cache.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(themeFailure(repositoryError("invalid_request")));
      }
      return existing.promise as Promise<DesktopThemePackageResult<T>>;
    }
    const entry: ThemeRequestCacheEntry = { fingerprint, promise: undefined as never, settled: false };
    entry.promise = action().finally(() => {
      entry.settled = true;
      this.#prune();
    }) as Promise<DesktopThemePackageResult<unknown>>;
    this.#cache.set(requestId, entry);
    return entry.promise as Promise<DesktopThemePackageResult<T>>;
  }

  #prune(): void {
    if (this.#cache.size <= 128) return;
    for (const [requestId, entry] of this.#cache) {
      if (!entry.settled) continue;
      this.#cache.delete(requestId);
      if (this.#cache.size <= 128) return;
    }
  }
}

export interface ThemeRootCoordination {
  readonly mutex: AsyncMutationMutex;
  readonly requestDedupe: ThemeRequestDedupe;
}

const ROOT_COORDINATION = new Map<string, ThemeRootCoordination>();

export function themeRootCoordination(themesRoot: string): ThemeRootCoordination {
  const key = resolve(themesRoot);
  const existing = ROOT_COORDINATION.get(key);
  if (existing) return existing;
  const coordination = Object.freeze({
    mutex: new AsyncMutationMutex(),
    requestDedupe: new ThemeRequestDedupe(),
  });
  ROOT_COORDINATION.set(key, coordination);
  return coordination;
}

export function repositoryError(
  code: DesktopThemePackageErrorCode,
  options: ConstructorParameters<typeof ThemePackageRepositoryError>[1] = {},
): ThemePackageRepositoryError {
  return new ThemePackageRepositoryError(code, options);
}

export function normalizeThemePackageError(
  error: unknown,
  context: {
    readonly operationId?: string;
    readonly themeId?: string;
    readonly relativePath?: string;
    readonly fallbackCode?: DesktopThemePackageErrorCode;
  } = {},
): ThemePackageRepositoryError {
  if (error instanceof ThemePackageRepositoryError) return error;
  if (error instanceof LingThemePackageError) {
    const issue = error.issues[0];
    return repositoryError(
      PARSER_ERROR_CODES[issue?.code ?? ""] ?? "invalid_schema",
      {
        ...context,
        ...(issue?.path && issue.path !== "$" ? { relativePath: issue.path } : {}),
        cause: error,
      },
    );
  }
  const errno = readErrno(error);
  const code = errno === "EACCES" || errno === "EPERM"
    ? "permission_denied"
    : errno === "ENOSPC" || errno === "EDQUOT"
      ? "disk_full"
      : errno === "EXDEV"
        ? "storage_unavailable"
      : context.fallbackCode ?? "unknown_io";
  return repositoryError(code, {
    ...context,
    retryable: code === "permission_denied" || code === "storage_unavailable" || code === "unknown_io",
    cause: error,
  });
}

export function readErrno(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function prepareThemeArchiveRequest(request: DesktopThemePackageArchiveRequest):
  | { readonly ok: true; readonly bytes: Uint8Array; readonly fingerprint: string }
  | { readonly ok: false; readonly result: DesktopThemePackageResult<never> } {
  try {
    validateThemeRequestId(request.requestId);
    if (
      typeof request.originalFileName !== "string"
      || request.originalFileName.length === 0
      || request.originalFileName.length > 160
      || basename(request.originalFileName) !== request.originalFileName
      || win32.basename(request.originalFileName) !== request.originalFileName
      || /[\u0000-\u001f\u007f]/u.test(request.originalFileName)
      || !request.originalFileName.endsWith(".ling-theme")
    ) throw repositoryError("invalid_request");
    if (!(request.archiveBytes instanceof ArrayBuffer) || request.archiveBytes.byteLength === 0) {
      throw repositoryError("archive_empty");
    }
    if (request.archiveBytes.byteLength > LING_THEME_PACKAGE_LIMITS.archiveBytes) {
      throw repositoryError("archive_too_large");
    }
    validateThemeChecksum(request.rendererPackageChecksumSha256);
    const bytes = new Uint8Array(request.archiveBytes.slice(0));
    return {
      ok: true,
      bytes,
      fingerprint: `${hashThemeBytes(bytes)}:${request.originalFileName}:${request.rendererPackageChecksumSha256}`,
    };
  } catch (error) {
    return { ok: false, result: themeFailure(normalizeThemePackageError(error)) };
  }
}

export function validateThemeRequestId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/u.test(value)) {
    throw repositoryError("invalid_request");
  }
}

export function validateThemeExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw repositoryError("invalid_request");
}

export function validateThemeChecksum(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw repositoryError("invalid_request");
}

export function validateOptionalThemeChecksum(value: string | undefined): void {
  if (value !== undefined) validateThemeChecksum(value);
}

export function validateThemeIdInput(value: string): void {
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value) || value.length > 64) {
    throw repositoryError("invalid_request");
  }
}

export function themeSuccess<T>(
  value: T,
  warnings: readonly DesktopThemePackageWarning[] = [],
): DesktopThemePackageResult<T> {
  return Object.freeze({ ok: true, value, warnings: Object.freeze([...warnings]) });
}

export function themeFailure(
  error: ThemePackageRepositoryError,
): DesktopThemePackageResult<never> {
  return Object.freeze({ ok: false, error: error.detail });
}

export function cleanupPendingWarning(
  operationId?: string,
  themeId?: string,
  relativePath?: string,
): DesktopThemePackageWarning {
  return Object.freeze({
    code: "cleanup_pending",
    ...(operationId ? { operationId } : {}),
    ...(themeId ? { themeId } : {}),
    ...(relativePath ? { relativePath } : {}),
    retryable: true,
  });
}

export function dedupeThemeWarnings(
  warnings: readonly DesktopThemePackageWarning[],
): DesktopThemePackageWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}:${warning.operationId ?? ""}:${warning.themeId ?? ""}:${warning.relativePath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function hashThemeBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function copyThemeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
