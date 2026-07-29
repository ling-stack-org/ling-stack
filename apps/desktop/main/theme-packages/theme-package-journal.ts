import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readErrno, repositoryError } from "./theme-package-errors.js";
import {
  renameThemePath,
  syncDirectory,
  type ThemePackageFileContext,
} from "./theme-package-files.js";
import {
  assertSafeThemeDirectory,
  relativeThemePath,
  stagingOperationPath,
  type ThemePackagePaths,
} from "./theme-package-paths.js";

export type DesktopThemeOperationPhase =
  | "staging"
  | "candidate-ready"
  | "backup-created"
  | "published"
  | "delete-staged";

export type DesktopThemeOperationKind = "install" | "reimport" | "delete";

export interface DesktopThemeOperationJournalV1 {
  readonly journalSchemaVersion: 1;
  readonly operationId: string;
  readonly kind: DesktopThemeOperationKind;
  readonly themeId: string;
  readonly phase: DesktopThemeOperationPhase;
  readonly expectedPreviousChecksumSha256?: string;
  readonly candidateChecksumSha256?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface JournalOperationEntry {
  readonly operationId: string;
  readonly operationPath: string;
  readonly journal?: DesktopThemeOperationJournalV1;
}

const PHASES: ReadonlySet<string> = new Set([
  "staging",
  "candidate-ready",
  "backup-created",
  "published",
  "delete-staged",
]);

export function createThemeOperationJournal(input: {
  readonly operationId: string;
  readonly kind: DesktopThemeOperationKind;
  readonly themeId: string;
  readonly phase?: DesktopThemeOperationPhase;
  readonly expectedPreviousChecksumSha256?: string;
  readonly candidateChecksumSha256?: string;
  readonly now: string;
}): DesktopThemeOperationJournalV1 {
  return Object.freeze({
    journalSchemaVersion: 1,
    operationId: input.operationId,
    kind: input.kind,
    themeId: input.themeId,
    phase: input.phase ?? "staging",
    ...(input.expectedPreviousChecksumSha256
      ? { expectedPreviousChecksumSha256: input.expectedPreviousChecksumSha256 }
      : {}),
    ...(input.candidateChecksumSha256 ? { candidateChecksumSha256: input.candidateChecksumSha256 } : {}),
    startedAt: input.now,
    updatedAt: input.now,
  });
}

export function advanceThemeOperationJournal(
  journal: DesktopThemeOperationJournalV1,
  phase: DesktopThemeOperationPhase,
  now: string,
): DesktopThemeOperationJournalV1 {
  return Object.freeze({ ...journal, phase, updatedAt: now });
}

export async function writeThemeOperationJournal(
  context: ThemePackageFileContext,
  journal: DesktopThemeOperationJournalV1,
): Promise<void> {
  const operationPath = stagingOperationPath(context.paths, journal.operationId);
  await mkdir(operationPath, { recursive: true, mode: 0o700 });
  await assertSafeThemeDirectory(context.paths, operationPath);
  const destination = join(operationPath, "operation.json");
  const temporary = join(operationPath, `operation.${journal.updatedAt.replace(/[^0-9]/gu, "")}.tmp`);
  const bytes = new TextEncoder().encode(`${JSON.stringify(journal, null, 2)}\n`);
  const relativeTemporary = relativeThemePath(context.paths, temporary);
  await context.hooks?.beforeWrite?.(relativeTemporary);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await context.hooks?.beforeFsync?.(relativeTemporary, "file");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await renameThemePath(context, temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await syncDirectory(context, operationPath);
}

export async function listThemeOperationJournals(paths: ThemePackagePaths): Promise<JournalOperationEntry[]> {
  const entries: JournalOperationEntry[] = [];
  for (const operationId of (await readdir(paths.stagingRoot)).sort()) {
    const operationPath = stagingOperationPath(paths, operationId);
    const info = await lstat(operationPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      entries.push(Object.freeze({ operationId, operationPath }));
      continue;
    }
    try {
      entries.push(Object.freeze({
        operationId,
        operationPath,
        journal: await readThemeOperationJournal(operationPath, operationId),
      }));
    } catch {
      entries.push(Object.freeze({ operationId, operationPath }));
    }
  }
  return entries;
}

export async function readThemeOperationJournal(
  operationPath: string,
  expectedOperationId?: string,
): Promise<DesktopThemeOperationJournalV1> {
  let bytes: Uint8Array;
  try {
    const path = join(operationPath, "operation.json");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 64 * 1024) {
      throw repositoryError("corrupt_installation");
    }
    bytes = new Uint8Array(await readFile(path));
  } catch (error) {
    if (readErrno(error) === "ENOENT") throw repositoryError("corrupt_installation");
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw repositoryError("corrupt_installation", { cause: error });
  }
  if (!isJournal(value) || (expectedOperationId && value.operationId !== expectedOperationId)) {
    throw repositoryError("corrupt_installation");
  }
  return Object.freeze(value);
}

function isJournal(value: unknown): value is DesktopThemeOperationJournalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validChecksum = (candidate: unknown) => candidate === undefined
    || (typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate));
  return record.journalSchemaVersion === 1
    && typeof record.operationId === "string"
    && /^[A-Za-z0-9._-]{1,80}$/u.test(record.operationId)
    && (record.kind === "install" || record.kind === "reimport" || record.kind === "delete")
    && typeof record.themeId === "string"
    && typeof record.phase === "string"
    && PHASES.has(record.phase)
    && validChecksum(record.expectedPreviousChecksumSha256)
    && validChecksum(record.candidateChecksumSha256)
    && isIsoTime(record.startedAt)
    && isIsoTime(record.updatedAt);
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
