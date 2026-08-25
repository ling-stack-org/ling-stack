import type { DatabaseSync } from "node:sqlite";
import {
  createWorkflowParticipantAuthorityV1,
  isWorkflowParticipantAuthorityV1,
  type WorkflowParticipantAuthorityV1,
} from "@ling-stack/contracts";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION = 119;
export const CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_NAME = "add_channel_participant_authority";

export interface ChannelParticipantAuthorityMigrationInput {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export function applyChannelParticipantAuthorityMigration(input: ChannelParticipantAuthorityMigrationInput): void {
  const { database } = input;
  database.exec("BEGIN IMMEDIATE;");
  try {
    // Keep the schema change and its backfill in one transaction.  A malformed
    // legacy row must not leave a half-migrated column behind after a failed
    // startup; the next open should see the exact pre-migration schema.
    if (!input.hasColumn("channel_workflow_steps", "participant_authority_json")) {
      database.exec("ALTER TABLE channel_workflow_steps ADD COLUMN participant_authority_json TEXT NOT NULL DEFAULT '';");
    }
    const rows = database.prepare(`
      SELECT id, to_participant_id, participant_authority_json
      FROM channel_workflow_steps
    `).all() as Array<Record<string, unknown>>;
    const update = database.prepare(`
      UPDATE channel_workflow_steps
      SET participant_authority_json = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const participantId = typeof row.to_participant_id === "string" ? row.to_participant_id : "";
      const rowId = typeof row.id === "string" ? row.id : "";
      if (!participantId || !rowId) {
        throw new Error("Cannot backfill participant authority for a malformed workflow step row");
      }
      const current = parseAuthority(row.participant_authority_json);
      const authority = current && current.participantId === participantId
        ? current
        : createWorkflowParticipantAuthorityV1({
            kind: "channel_selection",
            origin: "legacy_migration",
            participantId,
            sourceId: rowId,
          });
      update.run(JSON.stringify(authority), rowId);
    }
    database.exec("COMMIT;");
  } catch (error) {
    rollbackOwnedSqliteTransaction(database);
    throw error;
  }

  if (!input.hasMigration(CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION)) {
    input.recordMigration(CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_VERSION, CHANNEL_PARTICIPANT_AUTHORITY_MIGRATION_NAME);
  }
}

function parseAuthority(value: unknown): WorkflowParticipantAuthorityV1 | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isWorkflowParticipantAuthorityV1(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
