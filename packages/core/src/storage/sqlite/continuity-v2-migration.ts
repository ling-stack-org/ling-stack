import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import {
  createContinuityV2Tables,
  dropLegacyContinuityTables,
  installConversationItemOutboxTriggers,
  rebuildContinuityV2ReferenceTables,
  renameLingTurnSourceMessageColumn,
} from "./continuity-v2-schema.js";
import {
  importLegacyConversationContinuity,
  type ContinuityV2LegacyImportReport,
} from "./continuity-v2-legacy-import.js";
import { readNumber, readString } from "./helpers.js";

export const CONTINUITY_V2_STORAGE_MIGRATION_VERSION = 110;
export const CONTINUITY_V2_STORAGE_MIGRATION_NAME = "cut_over_conversation_continuity_v2";

export interface ContinuityV2StorageMigrationContext {
  readonly database: DatabaseSync;
  readonly appliedAt: string;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}

export interface ContinuityV2StorageMigrationReport extends ContinuityV2LegacyImportReport {
  readonly migrationVersion: typeof CONTINUITY_V2_STORAGE_MIGRATION_VERSION;
}

export function applyContinuityV2StorageMigration(
  context: ContinuityV2StorageMigrationContext,
): ContinuityV2StorageMigrationReport | undefined {
  if (context.hasMigration(CONTINUITY_V2_STORAGE_MIGRATION_VERSION)) return undefined;
  assertCanonicalTimestamp(context.appliedAt);
  assertLegacySchemaReady(context.database);

  const foreignKeysEnabled = readPragmaBoolean(context.database, "foreign_keys");
  const legacyAlterTableEnabled = readPragmaBoolean(context.database, "legacy_alter_table");
  context.database.exec("PRAGMA foreign_keys = OFF;");
  context.database.exec("PRAGMA legacy_alter_table = ON;");
  context.database.exec("BEGIN IMMEDIATE;");
  try {
    createContinuityV2Tables(context.database);
    const report = importLegacyConversationContinuity(context.database, context.appliedAt);
    renameLingTurnSourceMessageColumn(context.database);
    rebuildContinuityV2ReferenceTables(context.database);
    dropLegacyContinuityTables(context.database);
    installConversationItemOutboxTriggers(context.database);
    validateContinuityV2Cutover(context.database, report);
    context.recordMigration(CONTINUITY_V2_STORAGE_MIGRATION_VERSION, CONTINUITY_V2_STORAGE_MIGRATION_NAME);
    context.database.exec("COMMIT;");
    return { migrationVersion: CONTINUITY_V2_STORAGE_MIGRATION_VERSION, ...report };
  } catch (error) {
    if (context.database.isTransaction) context.database.exec("ROLLBACK;");
    throw error;
  } finally {
    context.database.exec(`PRAGMA legacy_alter_table = ${legacyAlterTableEnabled ? "ON" : "OFF"};`);
    context.database.exec(`PRAGMA foreign_keys = ${foreignKeysEnabled ? "ON" : "OFF"};`);
  }
}

function assertLegacySchemaReady(database: DatabaseSync): void {
  const requiredTables = [
    "channel_messages",
    "channel_context_summaries",
    "ling_threads",
    "ling_turns",
    "channel_attachments",
    "channel_link_previews",
    "channel_decisions",
    "channel_handoffs",
    "channel_execution_proposals",
    "channel_intent_decisions",
    "channel_message_route_decisions",
    "channel_workflow_steps",
  ];
  for (const table of requiredTables) {
    if (!hasTable(database, table)) {
      throw new Error(`Continuity v2 migration requires legacy table: ${table}`);
    }
  }
  if (hasTable(database, "conversation_items")) {
    throw new Error("Continuity v2 migration found conversation_items without migration v110 authority.");
  }
}

function validateContinuityV2Cutover(
  database: DatabaseSync,
  report: ContinuityV2LegacyImportReport,
): void {
  if (hasTable(database, "channel_messages") || hasTable(database, "channel_context_summaries")) {
    throw new Error("Continuity v2 migration left a legacy timeline table behind.");
  }
  const legacyForeignKey = findLegacyForeignKeyReference(database);
  if (legacyForeignKey) {
    throw new Error(`Continuity v2 migration left a legacy foreign key: ${legacyForeignKey}`);
  }
  const itemCount = countRows(database, "conversation_items");
  if (itemCount !== report.legacyMessageCount || itemCount !== report.importedItemCount) {
    throw new Error(`Continuity v2 migration item count mismatch: legacy=${report.legacyMessageCount}, items=${itemCount}`);
  }
  const sequenceViolation = database.prepare(`
    SELECT thread_id
    FROM conversation_items
    GROUP BY thread_id
    HAVING MIN(sequence) <> 1 OR MAX(sequence) <> COUNT(*)
    LIMIT 1
  `).get() as Record<string, SQLOutputValue> | undefined;
  if (sequenceViolation) {
    throw new Error(`Continuity v2 migration produced a non-contiguous item sequence: ${readString(sequenceViolation, "thread_id")}`);
  }
  const userTurnViolation = database.prepare(`
    SELECT items.id
    FROM conversation_items AS items
    LEFT JOIN ling_turns AS turns ON turns.id = items.turn_id
    LEFT JOIN turn_context_assignments AS assignments
      ON assignments.turn_id = turns.id AND assignments.status = 'committed'
    WHERE items.kind = 'user_message'
      AND (turns.id IS NULL OR turns.thread_id <> items.thread_id OR assignments.id IS NULL)
    LIMIT 1
  `).get() as Record<string, SQLOutputValue> | undefined;
  if (userTurnViolation) {
    throw new Error(`Continuity v2 migration produced an unowned user item: ${readString(userTurnViolation, "id")}`);
  }
  const rootViolation = database.prepare(`
    SELECT channels.id
    FROM channels
    LEFT JOIN ling_threads
      ON ling_threads.channel_id = channels.id
      AND ling_threads.surface_kind = 'channel_root'
      AND ling_threads.archived_at IS NULL
    GROUP BY channels.id
    HAVING COUNT(ling_threads.id) <> 1
    LIMIT 1
  `).get() as Record<string, SQLOutputValue> | undefined;
  if (rootViolation) {
    throw new Error(`Continuity v2 migration did not create one active root thread: ${readString(rootViolation, "id")}`);
  }
  const itemCursorViolation = database.prepare(`
    SELECT threads.id
    FROM ling_threads AS threads
    LEFT JOIN (
      SELECT thread_id, COALESCE(MAX(sequence), 0) + 1 AS expected
      FROM conversation_items
      GROUP BY thread_id
    ) AS items ON items.thread_id = threads.id
    WHERE threads.next_item_sequence <> COALESCE(items.expected, 1)
    LIMIT 1
  `).get() as Record<string, SQLOutputValue> | undefined;
  if (itemCursorViolation) {
    throw new Error(`Continuity v2 migration produced an invalid sequence cursor: ${readString(itemCursorViolation, "id")}`);
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) {
    throw new Error(`Continuity v2 migration failed foreign key validation: ${JSON.stringify(foreignKeyViolations[0])}`);
  }
  const integrity = database.prepare("PRAGMA integrity_check").all() as Record<string, SQLOutputValue>[];
  const integrityResults = integrity.flatMap((row) => Object.values(row)).map(String);
  if (integrityResults.length !== 1 || integrityResults[0] !== "ok") {
    throw new Error(`Continuity v2 migration failed integrity validation: ${integrityResults.join("; ")}`);
  }
}

function readPragmaBoolean(database: DatabaseSync, pragma: "foreign_keys" | "legacy_alter_table"): boolean {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, SQLOutputValue>;
  return readNumber(row, pragma) === 1;
}

function countRows(database: DatabaseSync, table: string): number {
  return readNumber(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<string, SQLOutputValue>, "count");
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function findLegacyForeignKeyReference(database: DatabaseSync): string | undefined {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Record<string, SQLOutputValue>[];
  for (const tableRow of tables) {
    const table = readString(tableRow, "name");
    const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Record<string, SQLOutputValue>[];
    for (const foreignKey of foreignKeys) {
      const target = readString(foreignKey, "table");
      if (target === "channel_messages" || target === "channel_context_summaries") {
        return `${table}.${readString(foreignKey, "from")} -> ${target}`;
      }
    }
  }
  return undefined;
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Continuity v2 migration timestamp must be canonical: ${value}`);
  }
}
