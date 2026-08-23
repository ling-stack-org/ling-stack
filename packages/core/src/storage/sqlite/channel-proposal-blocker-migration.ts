import type { DatabaseSync } from "node:sqlite";
import { isWorkflowParticipantProviderBlockerV1 } from "@ling-stack/contracts";

export const CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION = 120;
const CHANNEL_PROPOSAL_BLOCKER_MIGRATION_NAME = "add_channel_execution_proposal_blocker";

export function applyChannelProposalBlockerMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly hasColumn: (tableName: string, columnName: string) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): boolean {
  const hasColumn = input.hasColumn("channel_execution_proposals", "blocker_json");
  if (hasColumn
    && input.hasMigration(CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION)
    && postconditionsPass(input.database)) {
    return false;
  }

  input.database.exec("BEGIN IMMEDIATE;");
  try {
    if (!hasColumn) {
      input.database.exec("ALTER TABLE channel_execution_proposals ADD COLUMN blocker_json TEXT;");
    }
    assertValidStoredBlockers(input.database);
    if (!input.hasMigration(CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION)) {
      input.recordMigration(
        CHANNEL_PROPOSAL_BLOCKER_MIGRATION_VERSION,
        CHANNEL_PROPOSAL_BLOCKER_MIGRATION_NAME,
      );
    }
    input.database.exec("COMMIT;");
    return true;
  } catch (error) {
    input.database.exec("ROLLBACK;");
    throw error;
  }
}

function postconditionsPass(database: DatabaseSync): boolean {
  try {
    assertValidStoredBlockers(database);
    return true;
  } catch {
    return false;
  }
}

function assertValidStoredBlockers(database: DatabaseSync): void {
  const rows = database.prepare(`
    SELECT id, blocker_json
    FROM channel_execution_proposals
    WHERE blocker_json IS NOT NULL
  `).all() as unknown as readonly { readonly id: string; readonly blocker_json: string }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.blocker_json) as unknown;
    } catch {
      throw new Error(`Invalid proposal blocker JSON for ${row.id}`);
    }
    if (!isWorkflowParticipantProviderBlockerV1(parsed)) {
      throw new Error(`Invalid proposal blocker contract for ${row.id}`);
    }
  }
}
