import { createHash } from "node:crypto";
import { closeSync, openSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostRunCapacityWorkspaceIdentity } from "./host-run-capacity-types.js";

const openedDatabaseIdentities = new WeakMap<DatabaseSync, string>();

function databaseFileIdentity(path: string): string | undefined {
  const file = statSync(path, { bigint: true });
  return file.isFile() && file.nlink === 1n && file.ino > 0n && file.dev >= 0n ? `${file.dev}:${file.ino}` : undefined;
}

/** Capture on both sides of SQLite open; a later pathname observation cannot rebind an old connection. */
export function openHostCapacityWorkspaceDatabase(databasePath: string): DatabaseSync {
  try { closeSync(openSync(databasePath, "ax")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const beforePath = realpathSync.native(databasePath), before = databaseFileIdentity(beforePath);
  const database = new DatabaseSync(databasePath);
  try {
    if (before && realpathSync.native(databasePath) === beforePath && databaseFileIdentity(beforePath) === before) {
      openedDatabaseIdentities.set(database, before);
    }
    return database;
  } catch (error) { database.close(); throw error; }
}

export function isHostCapacityWorkspaceDatabaseConnectionCurrent(database: DatabaseSync,
  identity: HostRunCapacityWorkspaceIdentitySnapshot): boolean {
  try {
    const primary = database.prepare("PRAGMA database_list").all().find(row => row.name === "main");
    return openedDatabaseIdentities.get(database) === identity.databaseFileIdentity && typeof primary?.file === "string"
      && realpathSync.native(primary.file) === identity.databasePath && isCurrentHostRunCapacityWorkspaceIdentity(identity);
  } catch { return false; }
}

export interface HostRunCapacityWorkspaceIdentitySnapshot extends HostRunCapacityWorkspaceIdentity {
  readonly workspaceId: string;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

/** Filesystem identity only; the workspace bridge must also verify its open SQLite connection. */
export function captureHostRunCapacityWorkspaceIdentity(input: {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly databasePath: string;
}): HostRunCapacityWorkspaceIdentitySnapshot {
  if (!validText(input?.workspaceId) || !validText(input.cwd) || !validText(input.databasePath)
    || !isAbsolute(input.cwd) || !isAbsolute(input.databasePath)) {
    throw new TypeError("host_run_capacity.workspace_identity_invalid");
  }
  const canonicalCwd = realpathSync.native(input.cwd);
  const databasePath = realpathSync.native(input.databasePath);
  const cwd = statSync(canonicalCwd, { bigint: true });
  const database = statSync(databasePath, { bigint: true });
  if (!cwd.isDirectory() || !database.isFile() || database.nlink !== 1n
    || database.ino <= 0n || database.dev < 0n) {
    throw new Error("host_run_capacity.workspace_identity_unsupported");
  }
  const observed = statSync(databasePath, { bigint: true });
  const currentCwd = statSync(canonicalCwd, { bigint: true });
  if (realpathSync.native(input.cwd) !== canonicalCwd || realpathSync.native(input.databasePath) !== databasePath
    || currentCwd.dev !== cwd.dev || currentCwd.ino !== cwd.ino
    || !observed.isFile() || observed.nlink !== 1n || observed.dev !== database.dev || observed.ino !== database.ino) {
    throw new Error("host_run_capacity.workspace_identity_changed");
  }
  const databaseFileIdentity = `${database.dev}:${database.ino}`;
  const workspaceKey = createHash("sha256").update(JSON.stringify({ schemaVersion: 1,
    workspaceId: input.workspaceId, canonicalCwd, databasePath, databaseFileIdentity })).digest("hex");
  return Object.freeze({ workspaceId: input.workspaceId, workspaceKey, canonicalCwd, databasePath, databaseFileIdentity });
}

/** A missing, replaced, or aliased-again database never validates an old receipt. */
export function isCurrentHostRunCapacityWorkspaceIdentity(identity: HostRunCapacityWorkspaceIdentitySnapshot): boolean {
  try {
    const current = captureHostRunCapacityWorkspaceIdentity({ workspaceId: identity.workspaceId,
      cwd: identity.canonicalCwd, databasePath: identity.databasePath });
    return current.workspaceKey === identity.workspaceKey && current.canonicalCwd === identity.canonicalCwd
      && current.databasePath === identity.databasePath && current.databaseFileIdentity === identity.databaseFileIdentity;
  } catch {
    return false;
  }
}
