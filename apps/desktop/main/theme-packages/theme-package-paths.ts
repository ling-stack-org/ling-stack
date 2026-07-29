import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { repositoryError } from "./theme-package-errors.js";

const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u;

export interface ThemePackagePaths {
  readonly root: string;
  readonly authorityRoot: string;
  readonly stagingRoot: string;
  readonly rollbackRoot: string;
  readonly trashRoot: string;
}

export async function initializeThemePackagePaths(themesRoot: string): Promise<ThemePackagePaths> {
  await assertRootIsNotSymlink(themesRoot);
  await mkdir(themesRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(themesRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw repositoryError("storage_unavailable");
  }
  const authorityRoot = await realpath(themesRoot);
  const paths = Object.freeze({
    root: themesRoot,
    authorityRoot,
    stagingRoot: resolve(authorityRoot, ".staging"),
    rollbackRoot: resolve(authorityRoot, ".rollback"),
    trashRoot: resolve(authorityRoot, ".trash"),
  });
  for (const path of [paths.stagingRoot, paths.rollbackRoot, paths.trashRoot]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const childInfo = await lstat(path);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) {
      throw repositoryError("storage_unavailable");
    }
    if ((await stat(path)).dev !== rootInfo.dev) {
      throw repositoryError("storage_unavailable");
    }
  }
  return paths;
}

export function assertPortableThemeId(themeId: string): void {
  if (
    themeId.length === 0
    || themeId.length > 64
    || !THEME_ID_PATTERN.test(themeId)
    || themeId.startsWith("ling-")
    || WINDOWS_RESERVED_NAME.test(themeId)
  ) {
    throw repositoryError("reserved_theme_id", { themeId });
  }
}

export function resolveThemePath(paths: ThemePackagePaths, relativePath: string): string {
  const candidate = resolve(paths.authorityRoot, relativePath);
  const offset = relative(paths.authorityRoot, candidate);
  if (!offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw repositoryError("unsafe_path", { relativePath });
  }
  return candidate;
}

export function finalThemePath(paths: ThemePackagePaths, themeId: string): string {
  assertPortableThemeId(themeId);
  return resolveThemePath(paths, themeId);
}

export function stagingOperationPath(paths: ThemePackagePaths, operationId: string): string {
  assertOperationId(operationId);
  return resolveThemePath(paths, join(".staging", operationId));
}

export function rollbackThemePath(paths: ThemePackagePaths, themeId: string, operationId: string): string {
  assertPortableThemeId(themeId);
  assertOperationId(operationId);
  return resolveThemePath(paths, join(".rollback", `${themeId}.${operationId}`));
}

export function trashThemePath(paths: ThemePackagePaths, themeId: string, operationId: string): string {
  assertPortableThemeId(themeId);
  assertOperationId(operationId);
  return resolveThemePath(paths, join(".trash", `${themeId}.${operationId}`));
}

export function relativeThemePath(paths: ThemePackagePaths, absolutePath: string): string {
  const value = relative(paths.authorityRoot, absolutePath);
  return value.split("\\").join("/");
}

export async function assertSafeThemeDirectory(paths: ThemePackagePaths, path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw repositoryError("unsafe_path");
  const authority = await realpath(paths.authorityRoot);
  const actual = await realpath(path);
  const offset = relative(authority, actual);
  if (!offset || isAbsolute(offset) || offset === ".." || offset.startsWith(`..${sep}`)) {
    throw repositoryError("unsafe_path");
  }
}

async function assertRootIsNotSymlink(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw repositoryError("storage_unavailable");
  } catch (error) {
    if (readCode(error) !== "ENOENT") throw error;
  }
}

function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(operationId)) {
    throw repositoryError("invalid_request");
  }
}

function readCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}
