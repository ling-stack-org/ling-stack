import type { DatabaseSync } from "node:sqlite";

/** Add the lookup/uniqueness constraint only after the existing run_events table is ready. */
export function ensureHostCommandJournalIndex(database: DatabaseSync): void {
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_host_command_settlement
    ON run_events(json_extract(data_json, '$.executionId')) WHERE type='host_command_settled'`);
}
