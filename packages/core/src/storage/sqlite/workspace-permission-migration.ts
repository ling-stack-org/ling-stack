import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  authorizationAndAccessFromLegacyPermission,
  authorizationModes,
  permissionPresets,
  sessionPermissionModes,
  workspaceAccessModes,
} from "../../session-permissions.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const WORKSPACE_PERMISSION_MIGRATION_VERSION = 177;
export const WORKSPACE_PERMISSION_MIGRATION_NAME = "canonicalize_workspace_permission_settings";

export interface WorkspacePermissionMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasTable?: (tableName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}
/**
 * Adds the canonical independent permission fields to persisted workspace settings.
 *
 * The legacy fields intentionally remain in the JSON during the API cutover window;
 * this migration only makes the canonical values durable and deterministic. New
 * writers are responsible for stopping legacy writes in a later slice.
 */
export function applyWorkspacePermissionMigration(input: WorkspacePermissionMigrationInput): boolean {
  if (input.hasMigration(WORKSPACE_PERMISSION_MIGRATION_VERSION)) return false;
  if (input.hasTable && !input.hasTable("workspace_settings")) {
    input.recordMigration(WORKSPACE_PERMISSION_MIGRATION_VERSION, WORKSPACE_PERMISSION_MIGRATION_NAME);
    return true;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    const rows = input.database
      .prepare("SELECT workspace_id, settings_json FROM workspace_settings ORDER BY workspace_id")
      .all() as Array<Record<string, SQLOutputValue>>;
    const update = input.database.prepare("UPDATE workspace_settings SET settings_json = ? WHERE workspace_id = ?");
    for (const row of rows) {
      const workspaceId = readText(row.workspace_id, "workspace_id");
      const raw = readText(row.settings_json, "settings_json");
      const parsed = parseSettingsObject(raw, workspaceId);
      const canonical = canonicalizePermissions(parsed, workspaceId);
      if (JSON.stringify(parsed) !== JSON.stringify(canonical)) {
        update.run(JSON.stringify(canonical), workspaceId);
      }
    }
    input.recordMigration(WORKSPACE_PERMISSION_MIGRATION_VERSION, WORKSPACE_PERMISSION_MIGRATION_NAME);
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    rollbackOwnedSqliteTransaction(input.database);
    throw error;
  }
}

function canonicalizePermissions(value: Record<string, unknown>, workspaceId: string): Record<string, unknown> {
  const hasCanonicalAuthorization = value.defaultAuthorizationMode !== undefined;
  const hasCanonicalAccess = value.defaultWorkspaceAccessMode !== undefined;
  const canonicalAuthorization = hasCanonicalAuthorization
    ? readRequiredEnum(value, "defaultAuthorizationMode", authorizationModes, workspaceId)
    : undefined;
  const canonicalAccess = hasCanonicalAccess
    ? readRequiredEnum(value, "defaultWorkspaceAccessMode", workspaceAccessModes, workspaceId)
    : undefined;

  // Do not inspect legacy fields when both canonical axes are already present.
  // A stale or corrupt legacy projection must not block an otherwise complete
  // canonical record from being opened.
  if (hasCanonicalAuthorization && hasCanonicalAccess) {
    return {
      ...value,
      defaultAuthorizationMode: canonicalAuthorization,
      defaultWorkspaceAccessMode: canonicalAccess,
    };
  }

  const legacyMode = readOptionalEnum(value, "defaultPermissionMode", sessionPermissionModes, workspaceId);
  const legacyPreset = readOptionalEnum(value, "defaultPermissionPreset", permissionPresets, workspaceId);
  const legacy = authorizationAndAccessFromLegacyPermission(legacyMode, legacyPreset);

  return {
    ...value,
    defaultAuthorizationMode: canonicalAuthorization ?? legacy.authorizationMode,
    defaultWorkspaceAccessMode: canonicalAccess ?? legacy.workspaceAccessMode,
  };
}

function parseSettingsObject(raw: string, workspaceId: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`workspace_permission_migration_invalid_json:${workspaceId}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`workspace_permission_migration_expected_object:${workspaceId}`);
  }
  return parsed as Record<string, unknown>;
}

function readOptionalEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  workspaceId: string,
): T | undefined {
  if (value[key] === undefined) return undefined;
  return readRequiredEnum(value, key, allowed, workspaceId);
}

function readRequiredEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  workspaceId: string,
): T {
  if (typeof value[key] !== "string" || !allowed.includes(value[key] as T)) {
    throw new Error(`workspace_permission_migration_invalid_${key}:${workspaceId}`);
  }
  return value[key] as T;
}

function readText(value: SQLOutputValue, key: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`workspace_permission_migration_invalid_${key}`);
  }
  return value;
}
