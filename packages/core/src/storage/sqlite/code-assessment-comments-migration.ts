import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CODE_ASSESSMENT_COMMENTS_MIGRATION_VERSION = 225;
const migrationName = "code_assessment_comments";
const definitions = [
  `CREATE TABLE code_assessment_comments (
    id TEXT PRIMARY KEY NOT NULL, assessment_id TEXT NOT NULL REFERENCES code_assessments(id),
    finding_id TEXT NOT NULL REFERENCES code_assessment_findings(id), created_at TEXT NOT NULL,
    body_json TEXT NOT NULL CHECK(json_valid(body_json))
  )`,
  `CREATE INDEX code_assessment_comments_finding ON code_assessment_comments(assessment_id,finding_id,created_at,id)`,
];
const normalize = (sql: string) => sql.replace(/\s+/gu, "").toLowerCase();

export function applyCodeAssessmentCommentsMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  function inspect(): boolean {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(CODE_ASSESSMENT_COMMENTS_MIGRATION_VERSION, migrationName) as { version: number; name: string }[];
    if (markers.length > 1 || markers.some(row => row.version !== CODE_ASSESSMENT_COMMENTS_MIGRATION_VERSION || row.name !== migrationName)
      || Boolean(markers.length) !== input.hasMigration(CODE_ASSESSMENT_COMMENTS_MIGRATION_VERSION)) throw new Error("code_assessment_comments.migration_marker_conflict");
    let existing = 0;
    for (const definition of definitions) {
      const objectName = /CREATE (?:TABLE|INDEX) (\w+)/u.exec(definition)![1]!;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(objectName) as { sql: string } | undefined;
      if (row) {
        existing++;
        if (typeof row.sql !== "string" || normalize(row.sql) !== normalize(definition)) throw new Error("code_assessment_comments.migration_schema_conflict");
      }
    }
    if (markers.length === 0 && existing > 0 || markers.length > 0 && existing !== definitions.length) throw new Error("code_assessment_comments.migration_incomplete");
    return markers.length > 0;
  }
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions) db.exec(definition);
      input.recordMigration(CODE_ASSESSMENT_COMMENTS_MIGRATION_VERSION, migrationName);
    }
    if (!inspect()) throw new Error("code_assessment_comments.migration_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
