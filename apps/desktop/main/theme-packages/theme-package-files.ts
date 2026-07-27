import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LING_THEME_PACKAGE_LIMITS,
  LingThemePackageError,
  normalizeThemePackagePath,
  validateThemeImage,
  validateThemeManifest,
  type LingThemeImageDecoder,
  type LingThemePackManifest,
  type NormalizedLingThemePackageFile,
  type ParsedLingThemePackage,
} from "@ling-stack/ui-react/theme";
import type { DesktopThemePackagePreviewDescriptor } from "../../shared/theme-package-capabilities.js";
import { normalizeThemePackageError, readErrno, repositoryError } from "./theme-package-errors.js";
import { assertSafeThemeDirectory, relativeThemePath, type ThemePackagePaths } from "./theme-package-paths.js";

const INSTALLATION_FILE = "installation.json";
const INSTALLATION_LIMIT = 64 * 1024;
const WINDOWS_RETRY_DELAYS = Object.freeze([50, 150, 450]);

export type InstallationFilePath = "theme.json" | "LICENSE.txt" | `assets/${string}`;

export interface DesktopThemeInstallationRecordV1 {
  readonly storageSchemaVersion: 1;
  readonly themeId: string;
  readonly source: "local-import";
  readonly packageChecksumSha256: string;
  readonly manifestChecksumSha256: string;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly files: readonly InstallationFileRecord[];
}

export interface InstallationFileRecord {
  readonly path: InstallationFilePath;
  readonly byteLength: number;
  readonly checksumSha256: string;
  readonly mimeType: NormalizedLingThemePackageFile["mimeType"];
}

export interface ReadInstalledTheme {
  readonly record: DesktopThemeInstallationRecordV1;
  readonly manifest: LingThemePackManifest;
  readonly licenseText?: string;
  readonly preview?: DesktopThemePackagePreviewDescriptor;
  readonly previewBytes?: Uint8Array;
}

export interface ThemePackageFileHooks {
  readonly beforeWrite?: (relativePath: string) => void | Promise<void>;
  readonly beforeFsync?: (relativePath: string, kind: "file" | "directory") => void | Promise<void>;
  readonly beforeRename?: (event: {
    readonly sourceRelativePath: string;
    readonly destinationRelativePath: string;
    readonly attempt: number;
  }) => void | Promise<void>;
  readonly beforeRemove?: (relativePath: string) => void | Promise<void>;
}

export interface ThemePackageFileContext {
  readonly paths: ThemePackagePaths;
  readonly platform: NodeJS.Platform;
  readonly decodeImage: LingThemeImageDecoder;
  readonly hooks?: ThemePackageFileHooks;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function writeThemeCandidate(
  context: ThemePackageFileContext,
  candidatePath: string,
  parsed: ParsedLingThemePackage,
  timestamps: { readonly installedAt: string; readonly updatedAt: string },
): Promise<DesktopThemeInstallationRecordV1> {
  await mkdir(candidatePath, { recursive: false, mode: 0o700 });
  await assertSafeThemeDirectory(context.paths, candidatePath);
  const files = [...parsed.files].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  for (const file of files) {
    const destination = join(candidatePath, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await assertSafeThemeDirectory(context.paths, dirname(destination));
    await writeExclusiveFile(context, destination, file.bytes);
    await syncDirectory(context, dirname(destination));
  }
  const manifestRecord = files.find((file) => file.path === "theme.json");
  if (!manifestRecord) throw repositoryError("corrupt_installation", { themeId: parsed.manifest.id });
  const record: DesktopThemeInstallationRecordV1 = Object.freeze({
    storageSchemaVersion: 1,
    themeId: parsed.manifest.id,
    source: "local-import",
    packageChecksumSha256: parsed.packageChecksumSha256,
    manifestChecksumSha256: manifestRecord.checksumSha256,
    installedAt: timestamps.installedAt,
    updatedAt: timestamps.updatedAt,
    files: Object.freeze(files.map((file) => Object.freeze({
      path: file.path,
      byteLength: file.byteLength,
      checksumSha256: file.checksumSha256,
      mimeType: file.mimeType,
    }))),
  });
  const metadata = new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`);
  if (metadata.byteLength > INSTALLATION_LIMIT) {
    throw repositoryError("corrupt_installation", { themeId: parsed.manifest.id });
  }
  await writeExclusiveFile(context, join(candidatePath, INSTALLATION_FILE), metadata);
  await syncDirectory(context, candidatePath);
  return record;
}

export async function readInstalledTheme(
  context: ThemePackageFileContext,
  packagePath: string,
  options: { readonly includePreviewBytes?: boolean } = {},
): Promise<ReadInstalledTheme> {
  await assertSafeTree(context.paths, packagePath);
  const metadataBytes = await readBoundedFile(join(packagePath, INSTALLATION_FILE), INSTALLATION_LIMIT);
  const record = parseInstallationRecord(metadataBytes);
  const actualPaths = await listPackageFiles(packagePath);
  const expectedPaths = [INSTALLATION_FILE, ...record.files.map((file) => file.path)].sort();
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((path, index) => path !== expectedPaths[index])) {
    throw repositoryError("corrupt_installation", { themeId: record.themeId });
  }

  let manifest: LingThemePackManifest | undefined;
  let licenseText: string | undefined;
  let preview: DesktopThemePackagePreviewDescriptor | undefined;
  let previewBytes: Uint8Array | undefined;
  for (const file of record.files) {
    const bytes = await readBoundedFile(join(packagePath, ...file.path.split("/")), file.byteLength);
    if (bytes.byteLength !== file.byteLength || sha256(bytes) !== file.checksumSha256) {
      throw repositoryError("corrupt_installation", { themeId: record.themeId, relativePath: file.path });
    }
    if (file.path === "theme.json") {
      if (file.mimeType !== "application/json" || file.checksumSha256 !== record.manifestChecksumSha256) {
        throw repositoryError("corrupt_installation", { themeId: record.themeId, relativePath: file.path });
      }
      manifest = parseInstalledManifest(bytes, record.themeId);
    } else if (file.path === "LICENSE.txt") {
      if (file.mimeType !== "text/plain") throw repositoryError("corrupt_installation", { themeId: record.themeId });
      licenseText = decodeUtf8(bytes, file.path);
    } else {
      const validated = await validateThemeImage(file.path, bytes, context.decodeImage).catch((error) => {
        throw normalizeThemePackageError(error, { themeId: record.themeId, relativePath: file.path, fallbackCode: "corrupt_installation" });
      });
      if (validated.mimeType !== file.mimeType) {
        throw repositoryError("corrupt_installation", { themeId: record.themeId, relativePath: file.path });
      }
      preview = Object.freeze({
        path: file.path,
        mimeType: validated.mimeType,
        byteLength: bytes.byteLength,
        width: validated.width,
        height: validated.height,
        checksumSha256: file.checksumSha256,
      });
      if (options.includePreviewBytes) previewBytes = bytes;
    }
  }
  if (!manifest) throw repositoryError("corrupt_installation", { themeId: record.themeId });
  if (manifest.preview !== preview?.path && (manifest.preview || preview)) {
    throw repositoryError("corrupt_installation", { themeId: record.themeId });
  }
  return Object.freeze({
    record,
    manifest,
    ...(licenseText !== undefined ? { licenseText } : {}),
    ...(preview ? { preview } : {}),
    ...(previewBytes ? { previewBytes } : {}),
  });
}

export async function renameThemePath(
  context: ThemePackageFileContext,
  source: string,
  destination: string,
): Promise<void> {
  const delays = context.platform === "win32" ? WINDOWS_RETRY_DELAYS : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await context.hooks?.beforeRename?.({
        sourceRelativePath: relativeThemePath(context.paths, source),
        destinationRelativePath: relativeThemePath(context.paths, destination),
        attempt,
      });
      await rename(source, destination);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(readErrno(error) ?? "");
      if (!retryable || attempt >= delays.length) throw error;
      await (context.sleep ?? defaultSleep)(delays[attempt]);
    }
  }
}

export async function syncDirectory(context: ThemePackageFileContext, path: string): Promise<void> {
  try {
    await context.hooks?.beforeFsync?.(relativeThemePath(context.paths, path), "directory");
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const unsupported = ["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(readErrno(error) ?? "")
      || (context.platform === "win32" && ["EPERM", "EACCES"].includes(readErrno(error) ?? ""));
    if (!unsupported) throw error;
  }
}

export async function safeRemoveThemePath(context: ThemePackageFileContext, path: string): Promise<void> {
  await context.hooks?.beforeRemove?.(relativeThemePath(context.paths, path));
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (readErrno(error) === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    await unlink(path);
    return;
  }
  for (const entry of await readdir(path)) await safeRemoveThemePath(context, join(path, entry));
  await rmdir(path);
}

export async function themePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (readErrno(error) === "ENOENT") return false;
    throw error;
  }
}
export async function assertSafeTree(paths: ThemePackagePaths, root: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw repositoryError("corrupt_installation");
  const authority = await realpath(paths.authorityRoot);
  const actualRoot = await realpath(root);
  if (!actualRoot.startsWith(`${authority}/`) && !actualRoot.startsWith(`${authority}\\`)) {
    throw repositoryError("unsafe_path");
  }
  for (const entry of await readdir(root)) {
    const child = join(root, entry);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) {
      throw repositoryError("corrupt_installation", { relativePath: relativeThemePath(paths, child) });
    }
    if (info.isDirectory()) await assertSafeTree(paths, child);
  }
}

async function writeExclusiveFile(context: ThemePackageFileContext, path: string, bytes: Uint8Array): Promise<void> {
  const relativePath = relativeThemePath(context.paths, path);
  await context.hooks?.beforeWrite?.(relativePath);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await context.hooks?.beforeFsync?.(relativePath, "file");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw repositoryError("corrupt_installation", { relativePath });
  const reread = new Uint8Array(await readFile(path));
  if (reread.byteLength !== bytes.byteLength || sha256(reread) !== sha256(bytes)) {
    throw repositoryError("corrupt_installation", { relativePath });
  }
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Uint8Array> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximumBytes) {
    throw repositoryError("corrupt_installation");
  }
  return new Uint8Array(await readFile(path));
}

function parseInstallationRecord(bytes: Uint8Array): DesktopThemeInstallationRecordV1 {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, INSTALLATION_FILE));
  } catch (error) {
    if (error instanceof LingThemePackageError) throw error;
    throw repositoryError("corrupt_installation", { cause: error });
  }
  if (!isRecord(value) || value.storageSchemaVersion !== 1 || value.source !== "local-import") {
    throw repositoryError("corrupt_installation");
  }
  const files = Array.isArray(value.files) ? value.files : [];
  const pathSet = new Set<string>();
  const filePaths = files.flatMap((file) => isRecord(file) && typeof file.path === "string" ? [file.path] : []);
  if (
    typeof value.themeId !== "string"
    || !hasOnlyKeys(value, ["storageSchemaVersion", "themeId", "source", "packageChecksumSha256", "manifestChecksumSha256", "installedAt", "updatedAt", "files"])
    || !isChecksum(value.packageChecksumSha256)
    || !isChecksum(value.manifestChecksumSha256)
    || !isIsoTime(value.installedAt)
    || !isIsoTime(value.updatedAt)
    || files.length === 0
    || files.length > LING_THEME_PACKAGE_LIMITS.fileCount
    || filePaths.filter((path) => path === "theme.json").length !== 1
    || filePaths.filter((path) => path === "LICENSE.txt").length > 1
    || filePaths.filter((path) => path.startsWith("assets/")).length > 1
    || files.some((file) => !isInstallationFile(file) || !hasOnlyKeys(file, ["path", "byteLength", "checksumSha256", "mimeType"]) || pathSet.has(file.path) || !pathSet.add(file.path))
    || files.reduce((total, file) => total + (isRecord(file) && typeof file.byteLength === "number" ? file.byteLength : 0), 0) > LING_THEME_PACKAGE_LIMITS.totalUncompressedBytes
  ) throw repositoryError("corrupt_installation");
  const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path, "en-US"));
  if (files.some((file, index) => file.path !== sorted[index].path)) throw repositoryError("corrupt_installation");
  return value as unknown as DesktopThemeInstallationRecordV1;
}

function parseInstalledManifest(bytes: Uint8Array, themeId: string): LingThemePackManifest {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, "theme.json"));
  } catch {
    throw repositoryError("corrupt_installation", { themeId, relativePath: "theme.json" });
  }
  const validation = validateThemeManifest(value, { source: "local-import" });
  if (!validation.ok || validation.candidate.manifest.id !== themeId || validation.candidate.manifest.artwork) {
    throw repositoryError("corrupt_installation", { themeId, relativePath: "theme.json" });
  }
  return validation.candidate.manifest;
}

async function listPackageFiles(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await listPackageFiles(join(root, entry.name), path));
    else result.push(path);
  }
  return result.sort();
}

function isInstallationFile(value: unknown): value is InstallationFileRecord {
  if (!isRecord(value) || typeof value.path !== "string") return false;
  const normalizedPath = normalizeThemePackagePath(value.path);
  const validPath = value.path === "theme.json" || value.path === "LICENSE.txt" || (normalizedPath === value.path && value.path.startsWith("assets/") && /\.(?:png|jpe?g|webp)$/u.test(value.path));
  const validMime = value.mimeType === "application/json" || value.mimeType === "text/plain" || ["image/png", "image/jpeg", "image/webp"].includes(String(value.mimeType));
  const maximum = value.path === "theme.json"
    ? LING_THEME_PACKAGE_LIMITS.manifestBytes
    : value.path.startsWith("assets/")
      ? LING_THEME_PACKAGE_LIMITS.imageBytes
      : LING_THEME_PACKAGE_LIMITS.totalUncompressedBytes;
  return validPath && validMime && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0 && Number(value.byteLength) <= maximum && isChecksum(value.checksumSha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isChecksum(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw repositoryError("corrupt_installation", { relativePath: path, cause: error });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
