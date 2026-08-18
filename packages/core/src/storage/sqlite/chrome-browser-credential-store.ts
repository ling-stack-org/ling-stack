import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import type {
  ChromeBrowserCredentialRecord,
  UpsertChromeBrowserCredentialInput,
} from "../../chrome-browser-types.js";

export class SqliteChromeBrowserCredentialStore {
  constructor(private readonly database: DatabaseSync) {}

  upsertChromeBrowserCredential(
    input: UpsertChromeBrowserCredentialInput,
    now: string,
  ): ChromeBrowserCredentialRecord {
    validateCredentialInput(input);
    this.database.prepare(`
      INSERT INTO chrome_browser_credentials (
        workspace_id, plugin_id, extension_id, credential_hash,
        created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(workspace_id, plugin_id, extension_id) DO UPDATE SET
        credential_hash = excluded.credential_hash,
        updated_at = excluded.updated_at,
        revoked_at = NULL
    `).run(
      input.workspaceId,
      input.pluginId,
      input.extensionId,
      input.credentialHash.toLowerCase(),
      now,
      now,
    );
    const stored = this.getChromeBrowserCredential(
      input.workspaceId,
      input.pluginId,
      input.extensionId,
    );
    if (!stored) {
      throw new Error("Failed to persist Chrome browser credential.");
    }
    return stored;
  }

  getChromeBrowserCredential(
    workspaceId: string,
    pluginId: string,
    extensionId: string,
  ): ChromeBrowserCredentialRecord | undefined {
    const row = this.database.prepare(`
      SELECT workspace_id, plugin_id, extension_id, credential_hash,
             created_at, updated_at, revoked_at
      FROM chrome_browser_credentials
      WHERE workspace_id = ? AND plugin_id = ? AND extension_id = ?
    `).get(workspaceId, pluginId, extensionId) as Record<string, SQLOutputValue> | undefined;
    return row ? mapCredential(row) : undefined;
  }

  listChromeBrowserCredentials(
    workspaceId: string,
    pluginId: string,
  ): ChromeBrowserCredentialRecord[] {
    return (this.database.prepare(`
      SELECT workspace_id, plugin_id, extension_id, credential_hash,
             created_at, updated_at, revoked_at
      FROM chrome_browser_credentials
      WHERE workspace_id = ? AND plugin_id = ?
      ORDER BY updated_at DESC, extension_id ASC
    `).all(workspaceId, pluginId) as Record<string, SQLOutputValue>[]).map(mapCredential);
  }

  revokeChromeBrowserCredentials(
    workspaceId: string,
    pluginId: string,
    now: string,
  ): number {
    const result = this.database.prepare(`
      UPDATE chrome_browser_credentials
      SET revoked_at = ?, updated_at = ?
      WHERE workspace_id = ? AND plugin_id = ? AND revoked_at IS NULL
    `).run(now, now, workspaceId, pluginId);
    return Number(result.changes);
  }
}

function validateCredentialInput(input: UpsertChromeBrowserCredentialInput): void {
  for (const [field, value] of [
    ["workspaceId", input.workspaceId],
    ["pluginId", input.pluginId],
    ["extensionId", input.extensionId],
  ] as const) {
    if (!value.trim() || value.length > 256) {
      throw new Error(`Invalid Chrome browser credential ${field}.`);
    }
  }
  if (!/^[a-f0-9]{64}$/i.test(input.credentialHash)) {
    throw new Error("Chrome browser credential hash must be a SHA-256 hex digest.");
  }
}

function mapCredential(row: Record<string, SQLOutputValue>): ChromeBrowserCredentialRecord {
  const revokedAt = readNullableString(row, "revoked_at");
  return {
    workspaceId: readString(row, "workspace_id"),
    pluginId: readString(row, "plugin_id"),
    extensionId: readString(row, "extension_id"),
    credentialHash: readString(row, "credential_hash"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function readString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a string.`);
  }
  return value;
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Expected ${key} to be a nullable string.`);
  }
  return value;
}
