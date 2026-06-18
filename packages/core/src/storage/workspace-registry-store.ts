import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  resolveStoragePaths,
  resolveUserConfigPaths,
  type LingStackUserConfigPaths,
  type ResolveConfigPathsOptions,
  type WorkspaceStateLocation,
  type WorkspaceStorageIdentity,
} from "../runtime-paths.js";

export interface WorkspaceRegistryEntry {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly displayName: string;
  readonly stateLocation: WorkspaceStateLocation;
  readonly stateRoot: string;
  readonly gitRoot?: string;
  readonly gitRemoteUrl?: string;
  readonly fingerprint: Record<string, unknown>;
  readonly firstSeenAt: string;
  readonly lastOpenedAt: string;
  readonly archivedAt?: string;
}

export interface RegisterWorkspaceInput {
  readonly identity: WorkspaceStorageIdentity;
  readonly stateLocation: WorkspaceStateLocation;
  readonly stateRoot: string;
  readonly gitRoot?: string;
  readonly gitRemoteUrl?: string;
  readonly now?: string;
}

export interface WorkspaceRegistryStoreOptions {
  readonly userPaths?: LingStackUserConfigPaths;
  readonly configOptions?: ResolveConfigPathsOptions;
}

export class WorkspaceRegistryStore {
  private readonly database: DatabaseSync;

  constructor(readonly userPaths: LingStackUserConfigPaths) {
    mkdirSync(dirname(userPaths.globalDatabasePath), { recursive: true });
    this.database = new DatabaseSync(userPaths.globalDatabasePath);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA foreign_keys = ON;");
    this.applySchema();
  }

  registerWorkspace(input: RegisterWorkspaceInput): WorkspaceRegistryEntry {
    const now = input.now ?? new Date().toISOString();
    const existing = this.getWorkspaceById(input.identity.workspaceId);
    const firstSeenAt = existing?.firstSeenAt ?? now;
    const fingerprintJson = JSON.stringify(input.identity.fingerprint);
    this.database
      .prepare(`
        INSERT INTO workspaces_registry (
          workspace_id,
          canonical_cwd,
          display_name,
          state_location,
          state_root,
          git_root,
          git_remote_url,
          fingerprint_json,
          first_seen_at,
          last_opened_at,
          archived_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(workspace_id) DO UPDATE SET
          canonical_cwd = excluded.canonical_cwd,
          display_name = excluded.display_name,
          state_location = excluded.state_location,
          state_root = excluded.state_root,
          git_root = excluded.git_root,
          git_remote_url = excluded.git_remote_url,
          fingerprint_json = excluded.fingerprint_json,
          last_opened_at = excluded.last_opened_at,
          archived_at = NULL
      `)
      .run(
        input.identity.workspaceId,
        input.identity.canonicalCwd,
        input.identity.displayName,
        input.stateLocation,
        input.stateRoot,
        input.gitRoot ?? null,
        input.gitRemoteUrl ?? null,
        fingerprintJson,
        firstSeenAt,
        now,
      );
    const registered = this.getWorkspaceById(input.identity.workspaceId);
    if (!registered) {
      throw new Error(`Workspace registry write failed: ${input.identity.workspaceId}`);
    }
    return registered;
  }

  getWorkspaceById(workspaceId: string): WorkspaceRegistryEntry | undefined {
    const row = this.database
      .prepare("SELECT * FROM workspaces_registry WHERE workspace_id = ?")
      .get(workspaceId) as Record<string, SQLOutputValue> | undefined;
    return row ? mapWorkspaceRegistryEntry(row) : undefined;
  }

  getWorkspaceByCanonicalCwd(canonicalCwd: string): WorkspaceRegistryEntry | undefined {
    const row = this.database
      .prepare("SELECT * FROM workspaces_registry WHERE canonical_cwd = ? AND archived_at IS NULL ORDER BY last_opened_at DESC LIMIT 1")
      .get(canonicalCwd) as Record<string, SQLOutputValue> | undefined;
    return row ? mapWorkspaceRegistryEntry(row) : undefined;
  }

  close(): void {
    this.database.close();
  }

  private applySchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces_registry (
        workspace_id TEXT PRIMARY KEY,
        canonical_cwd TEXT NOT NULL,
        display_name TEXT NOT NULL,
        state_location TEXT NOT NULL,
        state_root TEXT NOT NULL,
        git_root TEXT,
        git_remote_url TEXT,
        fingerprint_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_opened_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_registry_canonical_cwd
      ON workspaces_registry(canonical_cwd)
      WHERE archived_at IS NULL;

      CREATE INDEX IF NOT EXISTS idx_workspaces_registry_last_opened
      ON workspaces_registry(last_opened_at);
    `);
  }
}

export function createWorkspaceRegistryStore(options: WorkspaceRegistryStoreOptions = {}): WorkspaceRegistryStore {
  return new WorkspaceRegistryStore(options.userPaths ?? resolveUserConfigPaths(options.configOptions));
}

export function registerResolvedWorkspace(cwd: string, options: ResolveConfigPathsOptions = {}): WorkspaceRegistryEntry {
  const paths = resolveStoragePaths(cwd, options);
  const registry = createWorkspaceRegistryStore({ userPaths: paths.user });
  try {
    return registry.registerWorkspace({
      identity: paths.workspace.identity,
      stateLocation: paths.workspace.stateLocation,
      stateRoot: paths.workspace.rootDir,
    });
  } finally {
    registry.close();
  }
}

function mapWorkspaceRegistryEntry(row: Record<string, SQLOutputValue>): WorkspaceRegistryEntry {
  const fingerprintJson = readString(row, "fingerprint_json");
  return {
    workspaceId: readString(row, "workspace_id"),
    canonicalCwd: readString(row, "canonical_cwd"),
    displayName: readString(row, "display_name"),
    stateLocation: readWorkspaceStateLocation(row, "state_location"),
    stateRoot: readString(row, "state_root"),
    gitRoot: readOptionalString(row, "git_root"),
    gitRemoteUrl: readOptionalString(row, "git_remote_url"),
    fingerprint: parseFingerprint(fingerprintJson),
    firstSeenAt: readString(row, "first_seen_at"),
    lastOpenedAt: readString(row, "last_opened_at"),
    archivedAt: readOptionalString(row, "archived_at"),
  };
}

function readWorkspaceStateLocation(row: Record<string, SQLOutputValue>, key: string): WorkspaceStateLocation {
  const value = readString(row, key);
  if (value !== "repo-local" && value !== "user-data-dir") {
    throw new Error(`Unsupported workspace state location: ${value}`);
  }
  return value;
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function readOptionalString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string`);
  }
  return value;
}

function parseFingerprint(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Workspace registry fingerprint must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
