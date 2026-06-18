import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import {
  resolveStoragePaths,
  type LingStackRuntimePaths,
} from "@ling-stack/core";
import { HttpError } from "../errors.js";

export async function ensureWorkspaceStateWritableForRun(cwd: string): Promise<void> {
  const paths = resolveStoragePaths(cwd).workspace;

  if (paths.stateLocation === "repo-local") {
    await assertWritableDirectory(paths.cwd, "workspace cwd", repoLocalHint());
    await ensureWritableRuntimeDirectories(paths, { rootMustExist: false });
    return;
  }

  await ensureWritableRuntimeDirectories(paths, { rootMustExist: true });
}

async function ensureWritableRuntimeDirectories(
  paths: LingStackRuntimePaths,
  options: { readonly rootMustExist: boolean },
): Promise<void> {
  if (options.rootMustExist) {
    await assertWritableDirectory(
      paths.rootDir,
      "workspace state root",
      "Restore the user-data-dir state root or intentionally reinitialize it with ling-stack init --workspace-state-location user-data-dir.",
      "workspace_state_missing",
    );
  } else {
    await ensureWritableDirectory(paths.rootDir, "workspace state root", repoLocalHint());
  }

  const runtimeDirectories = [
    paths.sessionsDir,
    paths.artifactsDir,
    paths.attachmentsDir,
    paths.logsDir,
    paths.piDir,
    paths.pluginsDir,
    paths.pluginCacheDir,
    paths.worktreesDir,
    paths.memoryExportsDir,
  ];
  for (const directoryPath of runtimeDirectories) {
    await ensureWritableDirectory(directoryPath, "workspace runtime directory", stateRootHint(paths));
  }
  await assertFileWritableIfPresent(paths.databasePath, "workspace SQLite database", stateRootHint(paths));
}

async function ensureWritableDirectory(directoryPath: string, label: string, hint: string): Promise<void> {
  try {
    await mkdir(directoryPath, { recursive: true });
  } catch (error) {
    throwStateWriteError(label, directoryPath, hint, error);
  }
  await assertWritableDirectory(directoryPath, label, hint);
}

async function assertWritableDirectory(
  directoryPath: string,
  label: string,
  hint: string,
  missingCode = "workspace_state_not_writable",
): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(directoryPath);
  } catch (error) {
    if (isMissingPathError(error) && missingCode === "workspace_state_missing") {
      throw new HttpError(409, missingCode, `${capitalize(label)} is missing: ${directoryPath}. ${hint}`);
    }
    throwStateWriteError(label, directoryPath, hint, error);
  }

  if (!stats.isDirectory()) {
    throw new HttpError(409, "workspace_state_not_writable", `${capitalize(label)} is not a directory: ${directoryPath}. ${hint}`);
  }

  try {
    await access(directoryPath, fsConstants.W_OK);
  } catch (error) {
    throwStateWriteError(label, directoryPath, hint, error);
  }
}

async function assertFileWritableIfPresent(filePath: string, label: string, hint: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throwStateWriteError(label, filePath, hint, error);
  }

  if (!stats.isFile()) {
    throw new HttpError(409, "workspace_state_not_writable", `${capitalize(label)} is not a file: ${filePath}. ${hint}`);
  }

  try {
    await access(filePath, fsConstants.W_OK);
  } catch (error) {
    throwStateWriteError(label, filePath, hint, error);
  }
}

function throwStateWriteError(label: string, path: string, hint: string, error: unknown): never {
  throw new HttpError(
    409,
    "workspace_state_not_writable",
    `${capitalize(label)} is not writable: ${path}. ${errorMessage(error)} ${hint}`.trim(),
  );
}

function repoLocalHint(): string {
  return "Make the repo-local state path writable or move the workspace state with ling-stack workspace migrate-state --to user-data-dir.";
}

function stateRootHint(paths: LingStackRuntimePaths): string {
  if (paths.stateLocation === "user-data-dir") {
    return "Make the user-data-dir state root writable or restore it from backup.";
  }
  return repoLocalHint();
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
