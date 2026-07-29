import { createRequire } from "node:module";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_THEME_PACKAGE_ERROR_CODES,
  DESKTOP_THEME_PACKAGE_WARNING_CODES,
  type DesktopThemePackageArchiveRequest,
  type DesktopThemePackageCapabilities,
  type DesktopThemePackageDeleteRequest,
  type DesktopThemePackageError,
  type DesktopThemePackageErrorCode,
  type DesktopThemePackageReadRequest,
  type DesktopThemePackageReimportRequest,
  type DesktopThemePackageResult,
  type DesktopThemePackageSetActiveRequest,
  type DesktopThemePackageWarning,
} from "../../shared/theme-package-capabilities.js";
import { DESKTOP_THEME_PACKAGE_IPC_CHANNELS } from "../../shared/ipc-channels.js";

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/u;
const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_RESERVED_THEME_ID = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;
const FORBIDDEN_REQUEST_KEYS = new Set([
  "absolutepath",
  "acl",
  "destination",
  "destinationpath",
  "directory",
  "filepath",
  "manifest",
  "manifestoverride",
  "oserror",
  "path",
  "stack",
  "staging",
  "stagingname",
  "stagingpath",
  "url",
  "user",
  "username",
  "validated",
]);
const ERROR_CODES = new Set<string>(DESKTOP_THEME_PACKAGE_ERROR_CODES);
const WARNING_CODES = new Set<string>(DESKTOP_THEME_PACKAGE_WARNING_CODES);

type ThemePackageIpcMain = Pick<IpcMain, "handle" | "removeHandler">;
type ParsedRequest<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: DesktopThemePackageErrorCode };

export interface RegisterDesktopThemePackageIpcOptions {
  readonly repository: DesktopThemePackageCapabilities;
  readonly getMainWindow: () => BrowserWindow | undefined;
  readonly ipcMainImpl?: ThemePackageIpcMain;
}

export function registerDesktopThemePackageIpc(
  options: RegisterDesktopThemePackageIpcOptions,
): () => void {
  const desktopIpcMain = options.ipcMainImpl ?? resolveIpcMain();
  const registeredChannels: string[] = [];
  const register = (
    channel: string,
    handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>,
  ): void => {
    desktopIpcMain.handle(channel, handler);
    registeredChannels.push(channel);
  };

  try {
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesBootstrap,
      (event, ...args) => handleRequest(options, event, args, readNoPayload, () => options.repository.bootstrap()),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesList,
      (event, ...args) => handleRequest(options, event, args, readNoPayload, () => options.repository.list()),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesRead,
      (event, ...args) => handleRequest(options, event, args, readReadRequest, (request) => options.repository.read(request)),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesInstall,
      (event, ...args) => handleRequest(options, event, args, readArchiveRequest, (request) => options.repository.install(request)),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesReimport,
      (event, ...args) => handleRequest(options, event, args, readReimportRequest, (request) => options.repository.reimport(request)),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesDelete,
      (event, ...args) => handleRequest(options, event, args, readDeleteRequest, (request) => options.repository.delete(request)),
    );
    register(
      DESKTOP_THEME_PACKAGE_IPC_CHANNELS.themePackagesActiveSet,
      (event, ...args) => handleRequest(options, event, args, readSetActiveRequest, (request) => options.repository.setActive(request)),
    );
  } catch (error) {
    for (const channel of registeredChannels) desktopIpcMain.removeHandler(channel);
    throw error;
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const channel of registeredChannels) desktopIpcMain.removeHandler(channel);
  };
}

async function handleRequest<TRequest, TValue>(
  options: RegisterDesktopThemePackageIpcOptions,
  event: IpcMainInvokeEvent,
  args: readonly unknown[],
  readRequest: (args: readonly unknown[]) => ParsedRequest<TRequest>,
  operation: (request: TRequest) => Promise<DesktopThemePackageResult<TValue>>,
): Promise<DesktopThemePackageResult<TValue>> {
  if (!isAuthorizedMainFrame(options.getMainWindow, event)) {
    return failure("unauthorized_sender");
  }
  let request: ParsedRequest<TRequest>;
  try {
    request = readRequest(args);
  } catch {
    return failure("invalid_request");
  }
  if (!request.ok) return failure(request.code);
  try {
    return sanitizeRepositoryResult(await operation(request.value));
  } catch {
    return failure("unknown_io", true);
  }
}

function isAuthorizedMainFrame(
  getMainWindow: () => BrowserWindow | undefined,
  event: IpcMainInvokeEvent,
): boolean {
  try {
    const mainWindow = getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    const owner = mainWindow.webContents;
    if (owner.isDestroyed() || event.sender.isDestroyed()) return false;
    if (event.sender !== owner || event.sender.id !== owner.id) return false;
    if (!event.senderFrame || event.senderFrame !== owner.mainFrame) return false;
    const ownerUrl = owner.getURL();
    return ownerUrl.length > 0
      && event.sender.getURL() === ownerUrl
      && event.senderFrame.url === ownerUrl;
  } catch {
    return false;
  }
}

function readNoPayload(args: readonly unknown[]): ParsedRequest<undefined> {
  return args.length === 0 ? parsed(undefined) : invalid();
}

function readReadRequest(args: readonly unknown[]): ParsedRequest<DesktopThemePackageReadRequest> {
  const value = readRequestRecord(args);
  if (!value || !isThemeId(value.themeId) || typeof value.includePreviewBytes !== "boolean") {
    return invalid();
  }
  return parsed(Object.freeze({
    themeId: value.themeId,
    includePreviewBytes: value.includePreviewBytes,
  }));
}

function readArchiveRequest(
  args: readonly unknown[],
): ParsedRequest<DesktopThemePackageArchiveRequest> {
  const base = readArchiveRequestRecord(args);
  if (!base.ok) return base;
  return parsed(Object.freeze(base.value));
}

function readReimportRequest(
  args: readonly unknown[],
): ParsedRequest<DesktopThemePackageReimportRequest> {
  const value = readRequestRecord(args);
  if (!value) return invalid();
  const base = readArchiveRecord(value);
  if (!base.ok) return base;
  if (!isThemeId(value.themeId) || !isRevision(value.expectedRecordRevision)) return invalid();
  if (value.expectedCurrentChecksumSha256 !== undefined
    && !isChecksum(value.expectedCurrentChecksumSha256)) return invalid();
  return parsed(Object.freeze({
    ...base.value,
    themeId: value.themeId,
    expectedRecordRevision: value.expectedRecordRevision,
    ...(value.expectedCurrentChecksumSha256 !== undefined
      ? { expectedCurrentChecksumSha256: value.expectedCurrentChecksumSha256 }
      : {}),
  }));
}

function readDeleteRequest(
  args: readonly unknown[],
): ParsedRequest<DesktopThemePackageDeleteRequest> {
  const value = readRequestRecord(args);
  if (!value
    || !isRequestId(value.requestId)
    || !isThemeId(value.themeId)
    || !isRevision(value.expectedRecordRevision)) return invalid();
  if (value.expectedCurrentChecksumSha256 !== undefined
    && !isChecksum(value.expectedCurrentChecksumSha256)) return invalid();
  return parsed(Object.freeze({
    requestId: value.requestId,
    themeId: value.themeId,
    expectedRecordRevision: value.expectedRecordRevision,
    ...(value.expectedCurrentChecksumSha256 !== undefined
      ? { expectedCurrentChecksumSha256: value.expectedCurrentChecksumSha256 }
      : {}),
  }));
}

function readSetActiveRequest(
  args: readonly unknown[],
): ParsedRequest<DesktopThemePackageSetActiveRequest> {
  const value = readRequestRecord(args);
  return value && isThemeId(value.themeId)
    ? parsed(Object.freeze({ themeId: value.themeId }))
    : invalid();
}

function readArchiveRequestRecord(
  args: readonly unknown[],
): ParsedRequest<DesktopThemePackageArchiveRequest> {
  const value = readRequestRecord(args);
  return value ? readArchiveRecord(value) : invalid();
}

function readArchiveRecord(
  value: Readonly<Record<string, unknown>>,
): ParsedRequest<DesktopThemePackageArchiveRequest> {
  if (!isRequestId(value.requestId)
    || !isArchiveFileName(value.originalFileName)
    || !isChecksum(value.rendererPackageChecksumSha256)
    || !(value.archiveBytes instanceof ArrayBuffer)) return invalid();
  if (value.archiveBytes.byteLength === 0) return invalid("archive_empty");
  if (value.archiveBytes.byteLength > MAX_ARCHIVE_BYTES) return invalid("archive_too_large");
  return parsed(Object.freeze({
    requestId: value.requestId,
    originalFileName: value.originalFileName,
    archiveBytes: value.archiveBytes.slice(0),
    rendererPackageChecksumSha256: value.rendererPackageChecksumSha256,
  }));
}

function readRequestRecord(args: readonly unknown[]): Readonly<Record<string, unknown>> | undefined {
  if (args.length !== 1 || !isRecord(args[0])) return undefined;
  for (const key of Object.keys(args[0])) {
    const normalized = key.replaceAll("-", "").replaceAll("_", "").toLowerCase();
    if (FORBIDDEN_REQUEST_KEYS.has(normalized)) return undefined;
  }
  return args[0];
}

function sanitizeRepositoryResult<T>(value: unknown): DesktopThemePackageResult<T> {
  if (!isRecord(value)) return failure("unknown_io", true);
  if (value.ok === true && "value" in value && Array.isArray(value.warnings)) {
    return Object.freeze({
      ok: true,
      value: value.value as T,
      warnings: Object.freeze(value.warnings.map(sanitizeWarning).filter(isDefined)),
    });
  }
  if (value.ok === false && isRecord(value.error)) {
    const error = sanitizeError(value.error);
    return error ? Object.freeze({ ok: false, error }) : failure("unknown_io", true);
  }
  return failure("unknown_io", true);
}

function sanitizeError(value: Readonly<Record<string, unknown>>): DesktopThemePackageError | undefined {
  if (typeof value.code !== "string" || !ERROR_CODES.has(value.code) || typeof value.retryable !== "boolean") {
    return undefined;
  }
  return Object.freeze({
    code: value.code as DesktopThemePackageErrorCode,
    retryable: value.retryable,
    ...safeDiagnosticFields(value),
  });
}

function sanitizeWarning(value: unknown): DesktopThemePackageWarning | undefined {
  if (!isRecord(value)
    || typeof value.code !== "string"
    || !WARNING_CODES.has(value.code)
    || typeof value.retryable !== "boolean") return undefined;
  return Object.freeze({
    code: value.code as DesktopThemePackageWarning["code"],
    retryable: value.retryable,
    ...safeDiagnosticFields(value),
  });
}

function safeDiagnosticFields(value: Readonly<Record<string, unknown>>): {
  readonly operationId?: string;
  readonly themeId?: string;
  readonly relativePath?: string;
} {
  return {
    ...(isRequestId(value.operationId) ? { operationId: value.operationId } : {}),
    ...(isThemeId(value.themeId) ? { themeId: value.themeId } : {}),
    ...(isSafeRelativePath(value.relativePath) ? { relativePath: value.relativePath } : {}),
  };
}

function failure<T>(
  code: DesktopThemePackageErrorCode,
  retryable = false,
): DesktopThemePackageResult<T> {
  return Object.freeze({ ok: false, error: Object.freeze({ code, retryable }) });
}

function parsed<T>(value: T): ParsedRequest<T> {
  return { ok: true, value };
}

function invalid<T>(code: DesktopThemePackageErrorCode = "invalid_request"): ParsedRequest<T> {
  return { ok: false, code };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

function isThemeId(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 64
    && THEME_ID_PATTERN.test(value)
    && !WINDOWS_RESERVED_THEME_ID.test(value);
}

function isChecksum(value: unknown): value is string {
  return typeof value === "string" && CHECKSUM_PATTERN.test(value);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isArchiveFileName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > ".ling-theme".length
    && value.length <= 255
    && value.endsWith(".ling-theme")
    && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[A-Za-z]:[\\/]/u.test(value)
    && !value.split(/[\\/]/u).some((part) => part === ".." || part.length === 0);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function resolveIpcMain(): IpcMain {
  const require = createRequire(import.meta.url);
  const electron = require("electron") as { readonly ipcMain?: IpcMain };
  if (!electron.ipcMain) throw new Error("electron_ipc_main_unavailable");
  return electron.ipcMain;
}
