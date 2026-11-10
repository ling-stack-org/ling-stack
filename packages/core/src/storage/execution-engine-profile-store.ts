import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { ExecutionEngineProfile, ExecutionEngineProfileReference, ExternalExecutionEngineId } from "@ling-stack/contracts";
import type { LingStackUserConfigPaths } from "../runtime-paths.js";
import { assertProfileRevision, ExecutionEngineProfileError, parseExecutionEngineProfileConfiguration } from "../execution-engine-profiles.js";

export class ExecutionEngineProfileStore {
  private readonly database: DatabaseSync;
  private readonly authRoot: string;

  constructor(userPaths: LingStackUserConfigPaths) {
    mkdirSync(dirname(userPaths.globalDatabasePath), { recursive: true });
    this.authRoot = join(realpathSync(userPaths.rootDir), "state", "execution-engines");
    this.database = new DatabaseSync(userPaths.globalDatabasePath);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS execution_engine_profiles (
        engine_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        schema_version INTEGER NOT NULL CHECK(schema_version = 1),
        status TEXT NOT NULL CHECK(status IN ('configured', 'disconnected')),
        configuration_json TEXT NOT NULL,
        configuration_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS execution_engine_profile_references (
        workspace_id TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES execution_engine_profiles(profile_id),
        profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
        PRIMARY KEY (workspace_id, reference_id)
      );
      CREATE INDEX IF NOT EXISTS execution_engine_profile_references_by_profile
        ON execution_engine_profile_references(profile_id);
      CREATE TABLE IF NOT EXISTS execution_engine_retired_auth_generations (
        engine_id TEXT NOT NULL,
        auth_profile_id TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        PRIMARY KEY (engine_id, auth_profile_id)
      );
    `);
    try {
      this.transaction(() => {
        for (const profile of this.list()) if (profile.status === "disconnected") this.retireAuth(profile);
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  list(): readonly ExecutionEngineProfile[] {
    return this.database.prepare("SELECT * FROM execution_engine_profiles ORDER BY engine_id").all().map(mapProfile);
  }

  get(engineId: ExternalExecutionEngineId): ExecutionEngineProfile | undefined {
    const row = this.database.prepare("SELECT * FROM execution_engine_profiles WHERE engine_id = ?").get(engineId);
    return row ? mapProfile(row) : undefined;
  }

  save(input: unknown, expectedRevision: number, prepare?: () => void): ExecutionEngineProfile {
    assertProfileRevision(expectedRevision);
    const requested = parseExecutionEngineProfileConfiguration(input);
    return this.transaction(() => {
      const current = this.get(requested.engineId);
      assertExpected(current, expectedRevision);
      // Reconnect and mode changes keep configuration, never retired native credentials.
      const changedMode = current && ["codex-app-server", "kimi-acp"].includes(requested.engineId)
        && Boolean(current.configuration.secretRef) !== Boolean(requested.secretRef);
      const configuration = changedMode || this.isAuthRetired(requested.engineId, requested.authProfileId)
        ? { ...requested, authProfileId: `auth-${randomUUID()}` } : requested;
      const configurationJson = JSON.stringify(configuration);
      const fingerprint = createHash("sha256").update(configurationJson).digest("hex");
      if (current?.status === "configured" && current.configurationFingerprint === fingerprint) return current;
      if (current) this.assertUnreferenced(current);
      if (current && current.configuration.authProfileId !== configuration.authProfileId) this.retireAuth(current);
      this.database.prepare(`
        INSERT INTO execution_engine_profiles (
          engine_id, profile_id, revision, schema_version, status, configuration_json,
          configuration_fingerprint, updated_at
        ) VALUES (?, ?, ?, 1, 'configured', ?, ?, ?)
        ON CONFLICT(engine_id) DO UPDATE SET revision = excluded.revision,
          status = excluded.status, configuration_json = excluded.configuration_json,
          configuration_fingerprint = excluded.configuration_fingerprint, updated_at = excluded.updated_at
      `).run(configuration.engineId, current?.id ?? randomUUID(), expectedRevision + 1,
        configurationJson, fingerprint, new Date().toISOString());
      // Host resources are prepared only after revision/reference checks and before commit.
      prepare?.();
      return this.require(configuration.engineId);
    });
  }

  disconnect(engineId: ExternalExecutionEngineId, expectedRevision: number): ExecutionEngineProfile {
    assertProfileRevision(expectedRevision);
    return this.transaction(() => {
      const current = this.require(engineId);
      assertExpected(current, expectedRevision);
      this.assertUnreferenced(current);
      this.retireAuth(current);
      this.database.prepare(`UPDATE execution_engine_profiles
        SET status = 'disconnected', revision = revision + 1, updated_at = ? WHERE engine_id = ?`
      ).run(new Date().toISOString(), engineId);
      return this.require(engineId);
    });
  }

  close(): void {
    this.database.close();
  }

  assertCurrentAuthProfile(expected: ExecutionEngineProfile): void {
    assertProfileRevision(expected.revision);
    const current = this.require(expected.configuration.engineId);
    assertExpected(current, expected.revision);
    if (current.id !== expected.id || current.configurationFingerprint !== expected.configurationFingerprint
      || JSON.stringify(current.configuration) !== JSON.stringify(expected.configuration)) {
      throw new ExecutionEngineProfileError("profile_revision_conflict");
    }
    if (current.status !== "configured" || expected.status !== "configured"
      || this.isAuthRetired(current.configuration.engineId, current.configuration.authProfileId)) {
      throw new ExecutionEngineProfileError("profile_unavailable");
    }
  }

  getAuthProfileDirectory(expected: ExecutionEngineProfile): string {
    this.assertCurrentAuthProfile(expected);
    return join(this.authRoot, expected.configuration.engineId, "auth", expected.configuration.authProfileId);
  }

  /** Host-only final synchronous publication; prepare files and perform HTTP before entering. */
  commitAuthRefresh(expected: ExecutionEngineProfile, publish: () => void): void {
    this.transaction(() => {
      this.assertCurrentAuthProfile(expected);
      publish();
    });
  }

  listReferences(engineId: ExternalExecutionEngineId): readonly ExecutionEngineProfileReference[] {
    const current = this.require(engineId);
    return this.database.prepare(`SELECT workspace_id, reference_id FROM execution_engine_profile_references
      WHERE profile_id = ? ORDER BY workspace_id, reference_id`).all(current.id).map((row) => ({
        workspaceId: readString(row, "workspace_id"), referenceId: readString(row, "reference_id"),
      }));
  }

  /**
   * Opt-in host-only pin; callers own its retain/release lifecycle, including archived bindings they protect.
   * Workspace defaults do not implicitly acquire a permanent pin: profile changes invalidate their revisioned selection.
   * Never exposed as a browser mutation.
   */
  retainReference(engineId: ExternalExecutionEngineId, expectedRevision: number, reference: ExecutionEngineProfileReference): void {
    validateReference(reference);
    assertProfileRevision(expectedRevision);
    this.transaction(() => {
      const current = this.require(engineId);
      assertExpected(current, expectedRevision);
      if (current.status !== "configured") throw new ExecutionEngineProfileError("profile_unavailable");
      const existing = this.database.prepare(`SELECT profile_id, profile_revision FROM execution_engine_profile_references
        WHERE workspace_id = ? AND reference_id = ?`).get(reference.workspaceId, reference.referenceId);
      if (existing) {
        if (existing.profile_id !== current.id || existing.profile_revision !== expectedRevision) {
          throw new ExecutionEngineProfileError("profile_reference_conflict");
        }
        return;
      }
      this.database.prepare(`INSERT INTO execution_engine_profile_references
        (workspace_id, reference_id, profile_id, profile_revision) VALUES (?, ?, ?, ?)`
      ).run(reference.workspaceId, reference.referenceId, current.id, expectedRevision);
    });
  }

  releaseReference(engineId: ExternalExecutionEngineId, expectedRevision: number, reference: ExecutionEngineProfileReference): void {
    validateReference(reference);
    assertProfileRevision(expectedRevision);
    this.transaction(() => {
      const current = this.require(engineId);
      assertExpected(current, expectedRevision);
      this.database.prepare(`DELETE FROM execution_engine_profile_references
        WHERE workspace_id = ? AND reference_id = ? AND profile_id = ? AND profile_revision = ?`
      ).run(reference.workspaceId, reference.referenceId, current.id, expectedRevision);
    });
  }

  private assertUnreferenced(profile: ExecutionEngineProfile): void {
    if (this.database.prepare("SELECT 1 FROM execution_engine_profile_references WHERE profile_id = ? LIMIT 1").get(profile.id)) {
      throw new ExecutionEngineProfileError("profile_in_use");
    }
  }

  private isAuthRetired(engineId: ExternalExecutionEngineId, authProfileId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM execution_engine_retired_auth_generations
      WHERE engine_id = ? AND auth_profile_id = ?`).get(engineId, authProfileId));
  }

  private retireAuth(profile: ExecutionEngineProfile): void {
    this.database.prepare(`INSERT OR IGNORE INTO execution_engine_retired_auth_generations
      (engine_id, auth_profile_id, retired_at) VALUES (?, ?, ?)`
    ).run(profile.configuration.engineId, profile.configuration.authProfileId, new Date().toISOString());
  }

  private require(engineId: ExternalExecutionEngineId): ExecutionEngineProfile {
    const profile = this.get(engineId);
    if (!profile) throw new ExecutionEngineProfileError("profile_not_found");
    return profile;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function assertExpected(current: ExecutionEngineProfile | undefined, expectedRevision: number): void {
  if ((current?.revision ?? 0) !== expectedRevision) throw new ExecutionEngineProfileError("profile_revision_conflict");
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new ExecutionEngineProfileError("profile_invalid", "expectedRevision");
}

function mapProfile(row: Record<string, SQLOutputValue>): ExecutionEngineProfile {
  try {
    if (row.schema_version !== 1 || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1
      || (row.status !== "configured" && row.status !== "disconnected")) throw new Error("invalid schema");
    const configuration = parseExecutionEngineProfileConfiguration(JSON.parse(readString(row, "configuration_json")));
    const fingerprint = createHash("sha256").update(JSON.stringify(configuration)).digest("hex");
    if (configuration.engineId !== row.engine_id || fingerprint !== row.configuration_fingerprint) throw new Error("invalid identity");
    return {
      schemaVersion: 1,
      id: readString(row, "profile_id"),
      revision: row.revision,
      status: row.status,
      configuration,
      configurationFingerprint: fingerprint,
      updatedAt: readString(row, "updated_at"),
    };
  } catch {
    throw new ExecutionEngineProfileError("profile_store_invalid");
  }
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) throw new Error("invalid stored string");
  return value;
}

function validateReference(reference: ExecutionEngineProfileReference): void {
  if (!reference || [reference.workspaceId, reference.referenceId].some((value) =>
    typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) {
    throw new ExecutionEngineProfileError("profile_invalid", "reference");
  }
}
