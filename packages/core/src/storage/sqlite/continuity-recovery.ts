import { COPYFILE_EXCL } from "node:constants";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

export const CONTINUITY_V2_MIGRATION_ID = "channel_conversation_continuity_v2";
export const CONTINUITY_V2_RECOVERY_SNAPSHOT_NAME = "continuity-v2-pre-migration.sqlite";
export const CONTINUITY_V2_RECOVERY_MANIFEST_NAME = "continuity-v2-pre-migration.json";

export type ContinuityMigrationRecoveryErrorCode =
  | "source_integrity_failed"
  | "recovery_point_exists"
  | "snapshot_creation_failed"
  | "snapshot_validation_failed"
  | "manifest_invalid"
  | "restore_target_invalid"
  | "restore_failed";

export class ContinuityMigrationRecoveryError extends Error {
  readonly code: ContinuityMigrationRecoveryErrorCode;

  constructor(code: ContinuityMigrationRecoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContinuityMigrationRecoveryError";
    this.code = code;
  }
}

export interface ContinuityMigrationLegacyCounts {
  readonly channelMessages: number;
  readonly channelContextSummaries: number;
  readonly lingThreads: number;
  readonly lingTurns: number;
}

export interface ContinuityMigrationRecoveryManifest {
  readonly schemaVersion: 1;
  readonly migrationId: typeof CONTINUITY_V2_MIGRATION_ID;
  readonly sourceDatabasePath: string;
  readonly snapshotPath: string;
  readonly createdAt: string;
  readonly sourceSchemaVersion: number;
  readonly legacyCounts: ContinuityMigrationLegacyCounts;
}

export interface CreateContinuityMigrationRecoveryPointOptions {
  readonly database: DatabaseSync;
  readonly databasePath: string;
  readonly recoveryDirectory: string;
  readonly createdAt: string;
}

export interface VerifiedContinuityMigrationRecoveryPoint {
  readonly manifestPath: string;
  readonly manifest: ContinuityMigrationRecoveryManifest;
}

export interface RestoreContinuityMigrationRecoveryPointOptions {
  readonly databasePath: string;
  readonly manifestPath: string;
  readonly failedDatabasePath: string;
}

export interface RestoreContinuityMigrationRecoveryPointResult {
  readonly databasePath: string;
  readonly failedDatabasePath: string;
  readonly snapshotPath: string;
}

export function createContinuityMigrationRecoveryPoint(
  options: CreateContinuityMigrationRecoveryPointOptions,
): VerifiedContinuityMigrationRecoveryPoint {
  const databasePath = resolve(options.databasePath);
  const recoveryDirectory = resolve(options.recoveryDirectory);
  const snapshotPath = join(recoveryDirectory, CONTINUITY_V2_RECOVERY_SNAPSHOT_NAME);
  const manifestPath = join(recoveryDirectory, CONTINUITY_V2_RECOVERY_MANIFEST_NAME);
  assertCanonicalTimestamp(options.createdAt);
  if (!existsSync(databasePath)) {
    throw new ContinuityMigrationRecoveryError(
      "snapshot_creation_failed",
      `Continuity migration source database does not exist: ${databasePath}`,
    );
  }
  if (existsSync(snapshotPath) || existsSync(manifestPath)) {
    throw new ContinuityMigrationRecoveryError(
      "recovery_point_exists",
      `Continuity migration recovery point already exists: ${recoveryDirectory}`,
    );
  }

  assertSqliteDatabaseIntegrity(options.database, "source_integrity_failed", "source database");
  const manifest: ContinuityMigrationRecoveryManifest = {
    schemaVersion: 1,
    migrationId: CONTINUITY_V2_MIGRATION_ID,
    sourceDatabasePath: databasePath,
    snapshotPath,
    createdAt: options.createdAt,
    sourceSchemaVersion: readSourceSchemaVersion(options.database),
    legacyCounts: readLegacyCounts(options.database),
  };

  mkdirSync(recoveryDirectory, { recursive: true });
  try {
    options.database.prepare("VACUUM INTO ?").run(snapshotPath);
  } catch (error) {
    rmSync(snapshotPath, { force: true });
    throw new ContinuityMigrationRecoveryError(
      "snapshot_creation_failed",
      `Failed to create Continuity migration recovery snapshot: ${snapshotPath}`,
      { cause: error },
    );
  }

  try {
    verifySnapshot(manifest);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    rmSync(snapshotPath, { force: true });
    rmSync(manifestPath, { force: true });
    if (error instanceof ContinuityMigrationRecoveryError) throw error;
    throw new ContinuityMigrationRecoveryError(
      "snapshot_validation_failed",
      `Failed to validate Continuity migration recovery snapshot: ${snapshotPath}`,
      { cause: error },
    );
  }

  return { manifestPath, manifest };
}

export function verifyContinuityMigrationRecoveryPoint(
  manifestPathInput: string,
  expectedDatabasePath?: string,
): VerifiedContinuityMigrationRecoveryPoint {
  const manifestPath = resolve(manifestPathInput);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new ContinuityMigrationRecoveryError(
      "manifest_invalid",
      `Continuity migration recovery manifest is not readable JSON: ${manifestPath}`,
      { cause: error },
    );
  }
  const manifest = parseRecoveryManifest(parsed, manifestPath);
  if (expectedDatabasePath && manifest.sourceDatabasePath !== resolve(expectedDatabasePath)) {
    throw new ContinuityMigrationRecoveryError(
      "manifest_invalid",
      `Continuity migration recovery manifest belongs to another database: ${manifest.sourceDatabasePath}`,
    );
  }
  verifySnapshot(manifest);
  return { manifestPath, manifest };
}

export function restoreContinuityMigrationRecoveryPoint(
  options: RestoreContinuityMigrationRecoveryPointOptions,
): RestoreContinuityMigrationRecoveryPointResult {
  const databasePath = resolve(options.databasePath);
  const failedDatabasePath = resolve(options.failedDatabasePath);
  if (databasePath === failedDatabasePath || dirname(databasePath) !== dirname(failedDatabasePath)) {
    throw new ContinuityMigrationRecoveryError(
      "restore_target_invalid",
      "Continuity restore must preserve the failed database under a distinct path in the same directory.",
    );
  }
  if (!existsSync(databasePath)) {
    throw new ContinuityMigrationRecoveryError(
      "restore_target_invalid",
      `Continuity restore target does not exist: ${databasePath}`,
    );
  }
  for (const path of diagnosticPaths(failedDatabasePath)) {
    if (existsSync(path)) {
      throw new ContinuityMigrationRecoveryError(
        "restore_target_invalid",
        `Continuity restore diagnostic target already exists: ${path}`,
      );
    }
  }

  const { manifest } = verifyContinuityMigrationRecoveryPoint(options.manifestPath, databasePath);
  const restoreTempPath = join(dirname(databasePath), `.${basename(databasePath)}.continuity-v2-restore.tmp`);
  if (existsSync(restoreTempPath)) {
    throw new ContinuityMigrationRecoveryError(
      "restore_target_invalid",
      `Continuity restore temporary path already exists: ${restoreTempPath}`,
    );
  }

  const moved: Array<{ readonly from: string; readonly to: string }> = [];
  try {
    copyFileSync(manifest.snapshotPath, restoreTempPath, COPYFILE_EXCL);
    verifySnapshot({ ...manifest, snapshotPath: restoreTempPath });
    moveIfPresent(databasePath, failedDatabasePath, moved);
    moveIfPresent(`${databasePath}-wal`, `${failedDatabasePath}-wal`, moved);
    moveIfPresent(`${databasePath}-shm`, `${failedDatabasePath}-shm`, moved);
    renameSync(restoreTempPath, databasePath);
  } catch (error) {
    rmSync(restoreTempPath, { force: true });
    rollbackMoves(moved);
    if (error instanceof ContinuityMigrationRecoveryError) throw error;
    throw new ContinuityMigrationRecoveryError(
      "restore_failed",
      `Failed to restore Continuity migration recovery snapshot: ${manifest.snapshotPath}`,
      { cause: error },
    );
  }

  return {
    databasePath,
    failedDatabasePath,
    snapshotPath: manifest.snapshotPath,
  };
}

export function assertSqliteDatabaseIntegrity(
  database: Pick<DatabaseSync, "prepare">,
  errorCode: ContinuityMigrationRecoveryErrorCode,
  label: string,
): void {
  let rows: readonly Record<string, SQLOutputValue>[];
  try {
    rows = database.prepare("PRAGMA integrity_check").all() as Record<string, SQLOutputValue>[];
  } catch (error) {
    throw new ContinuityMigrationRecoveryError(errorCode, `Could not check ${label} integrity.`, { cause: error });
  }
  const results = rows.flatMap((row) => Object.values(row)).map(String);
  if (results.length !== 1 || results[0] !== "ok") {
    throw new ContinuityMigrationRecoveryError(
      errorCode,
      `${label} failed PRAGMA integrity_check: ${results.join("; ") || "no result"}`,
    );
  }
}

function verifySnapshot(manifest: ContinuityMigrationRecoveryManifest): void {
  if (!existsSync(manifest.snapshotPath)) {
    throw new ContinuityMigrationRecoveryError(
      "snapshot_validation_failed",
      `Continuity migration recovery snapshot does not exist: ${manifest.snapshotPath}`,
    );
  }
  let snapshot: DatabaseSync | undefined;
  try {
    snapshot = new DatabaseSync(manifest.snapshotPath, { readOnly: true });
    assertSqliteDatabaseIntegrity(snapshot, "snapshot_validation_failed", "recovery snapshot");
    const actualVersion = readSourceSchemaVersion(snapshot);
    const actualCounts = readLegacyCounts(snapshot);
    if (actualVersion !== manifest.sourceSchemaVersion || !sameLegacyCounts(actualCounts, manifest.legacyCounts)) {
      throw new ContinuityMigrationRecoveryError(
        "snapshot_validation_failed",
        "Continuity migration recovery snapshot does not match the source schema version and legacy counts.",
      );
    }
  } catch (error) {
    if (error instanceof ContinuityMigrationRecoveryError) throw error;
    throw new ContinuityMigrationRecoveryError(
      "snapshot_validation_failed",
      `Continuity migration recovery snapshot is not a valid SQLite database: ${manifest.snapshotPath}`,
      { cause: error },
    );
  } finally {
    snapshot?.close();
  }
}

function readSourceSchemaVersion(database: DatabaseSync): number {
  if (!hasTable(database, "schema_migrations")) return 0;
  const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as
    | Record<string, SQLOutputValue>
    | undefined;
  const value = row?.version;
  return typeof value === "number" ? value : Number(value ?? 0);
}

function readLegacyCounts(database: DatabaseSync): ContinuityMigrationLegacyCounts {
  return {
    channelMessages: countRows(database, "channel_messages"),
    channelContextSummaries: countRows(database, "channel_context_summaries"),
    lingThreads: countRows(database, "ling_threads"),
    lingTurns: countRows(database, "ling_turns"),
  };
}

function countRows(database: DatabaseSync, table: string): number {
  if (!hasTable(database, table)) return 0;
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, SQLOutputValue>;
  const value = row.count;
  return typeof value === "number" ? value : Number(value);
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function sameLegacyCounts(left: ContinuityMigrationLegacyCounts, right: ContinuityMigrationLegacyCounts): boolean {
  return left.channelMessages === right.channelMessages
    && left.channelContextSummaries === right.channelContextSummaries
    && left.lingThreads === right.lingThreads
    && left.lingTurns === right.lingTurns;
}

function parseRecoveryManifest(value: unknown, manifestPath: string): ContinuityMigrationRecoveryManifest {
  if (!isRecord(value)
    || !hasOnlyKeys(value, [
      "schemaVersion",
      "migrationId",
      "sourceDatabasePath",
      "snapshotPath",
      "createdAt",
      "sourceSchemaVersion",
      "legacyCounts",
    ])
    || value.schemaVersion !== 1
    || value.migrationId !== CONTINUITY_V2_MIGRATION_ID
    || typeof value.sourceDatabasePath !== "string"
    || typeof value.snapshotPath !== "string"
    || typeof value.createdAt !== "string"
    || !Number.isSafeInteger(value.sourceSchemaVersion)
    || Number(value.sourceSchemaVersion) < 0
    || !isLegacyCounts(value.legacyCounts)) {
    throw new ContinuityMigrationRecoveryError(
      "manifest_invalid",
      `Continuity migration recovery manifest has an invalid shape: ${manifestPath}`,
    );
  }
  assertCanonicalTimestamp(value.createdAt);
  const manifestDirectory = dirname(manifestPath);
  const expectedSnapshotPath = join(manifestDirectory, CONTINUITY_V2_RECOVERY_SNAPSHOT_NAME);
  if (resolve(value.snapshotPath) !== expectedSnapshotPath || resolve(value.sourceDatabasePath) !== value.sourceDatabasePath) {
    throw new ContinuityMigrationRecoveryError(
      "manifest_invalid",
      `Continuity migration recovery manifest contains non-canonical paths: ${manifestPath}`,
    );
  }
  return value as unknown as ContinuityMigrationRecoveryManifest;
}

function isLegacyCounts(value: unknown): value is ContinuityMigrationLegacyCounts {
  return isRecord(value)
    && hasOnlyKeys(value, ["channelMessages", "channelContextSummaries", "lingThreads", "lingTurns"])
    && ["channelMessages", "channelContextSummaries", "lingThreads", "lingTurns"]
      .every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0);
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ContinuityMigrationRecoveryError(
      "manifest_invalid",
      `Continuity migration recovery timestamp is not canonical: ${value}`,
    );
  }
}

function diagnosticPaths(databasePath: string): readonly string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

function moveIfPresent(
  from: string,
  to: string,
  moved: Array<{ readonly from: string; readonly to: string }>,
): void {
  if (!existsSync(from)) return;
  renameSync(from, to);
  moved.push({ from, to });
}

function rollbackMoves(moved: readonly { readonly from: string; readonly to: string }[]): void {
  for (const move of [...moved].reverse()) {
    if (existsSync(move.to) && !existsSync(move.from)) {
      renameSync(move.to, move.from);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}
