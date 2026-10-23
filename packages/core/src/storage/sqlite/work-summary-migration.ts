import type { DatabaseSync } from "node:sqlite";

export const WORK_SUMMARY_MIGRATION_VERSION = 175;
export function applyWorkSummaryMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  input.database.exec(`CREATE TABLE IF NOT EXISTS work_summary_pull_requests (
    url TEXT PRIMARY KEY, created_at TEXT NOT NULL
  )`);
  if (!input.hasMigration(WORK_SUMMARY_MIGRATION_VERSION)) {
    input.recordMigration(WORK_SUMMARY_MIGRATION_VERSION, "create_work_summary_pull_requests");
  }
}
