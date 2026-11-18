import type { DatabaseSync } from "node:sqlite";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";

export const CODE_ASSESSMENT_MIGRATION_VERSION = 230;
export const CODE_ASSESSMENT_LIFECYCLE_MIGRATION_VERSION = 231;
const migrationName = "code_assessments";
const definitions = [
  `CREATE TABLE code_assessment_snapshots (
    id TEXT PRIMARY KEY NOT NULL, digest TEXT NOT NULL,
    body_json TEXT NOT NULL CHECK(json_valid(body_json))
  )`,
  `CREATE TABLE code_assessments (
    id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('review','security')),
    status TEXT NOT NULL CHECK(status IN ('queued','analyzing','completed','partial','failed','cancelled','interrupted')),
    snapshot_id TEXT NOT NULL REFERENCES code_assessment_snapshots(id), created_at TEXT NOT NULL,
    body_json TEXT NOT NULL CHECK(json_valid(body_json))
  )`,
  `CREATE TABLE code_assessment_findings (
    id TEXT PRIMARY KEY NOT NULL, assessment_id TEXT NOT NULL REFERENCES code_assessments(id),
    body_json TEXT NOT NULL CHECK(json_valid(body_json))
  )`,
  `CREATE UNIQUE INDEX code_assessment_active ON code_assessments((1)) WHERE status IN ('queued','analyzing')`,
  `CREATE INDEX code_assessment_history ON code_assessments(kind,created_at DESC,id DESC)`,
  `CREATE INDEX code_assessment_findings_owner ON code_assessment_findings(assessment_id)`,
];
const normalize = (sql: string) => sql.replace(/\s+/gu, "").toLowerCase();

export function applyCodeAssessmentMigration(input: {
  readonly database: DatabaseSync;
  readonly hasMigration: (version: number) => boolean;
  readonly recordMigration: (version: number, name: string) => void;
}): void {
  const db = input.database;
  function inspect(): boolean {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?")
      .all(CODE_ASSESSMENT_MIGRATION_VERSION, migrationName) as { version: number; name: string }[];
    if (markers.length > 1 || markers.some(row => row.version !== CODE_ASSESSMENT_MIGRATION_VERSION || row.name !== migrationName)
      || Boolean(markers.length) !== input.hasMigration(CODE_ASSESSMENT_MIGRATION_VERSION)) {
      throw new Error("code_assessment.migration_marker_conflict");
    }
    let existing = 0;
    for (const definition of definitions) {
      const objectName = /CREATE (?:UNIQUE )?(?:TABLE|INDEX) (\w+)/u.exec(definition)![1]!;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(objectName) as { sql: string } | undefined;
      if (row) {
        existing++;
        if (typeof row.sql !== "string" || normalize(row.sql) !== normalize(definition)) throw new Error("code_assessment.migration_schema_conflict");
      }
    }
    if (markers.length === 0 && existing > 0 || markers.length > 0 && existing !== definitions.length) {
      throw new Error("code_assessment.migration_incomplete");
    }
    return markers.length > 0;
  }
  if (inspect()) { applyCodeAssessmentLifecycleMigration(input); applyCodeAssessmentHistoryFiltersMigration(input); return; }
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of definitions) db.exec(definition);
      input.recordMigration(CODE_ASSESSMENT_MIGRATION_VERSION, migrationName);
    }
    if (!inspect()) throw new Error("code_assessment.migration_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
  applyCodeAssessmentLifecycleMigration(input);
  applyCodeAssessmentHistoryFiltersMigration(input);
}

function applyCodeAssessmentLifecycleMigration(input: Parameters<typeof applyCodeAssessmentMigration>[0]): void {
  const db = input.database;
  const version = CODE_ASSESSMENT_LIFECYCLE_MIGRATION_VERSION;
  const name = "code_assessment_lifecycle";
  function inspect(): boolean {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name) as { version: number; name: string }[];
    if (markers.length > 1 || markers.some(marker => marker.version !== version || marker.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("code_assessment.lifecycle_marker_conflict");
    return markers.length > 0;
  }
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      const rows = db.prepare("SELECT a.id,a.body_json,s.body_json AS snapshot_json FROM code_assessments a JOIN code_assessment_snapshots s ON s.id=a.snapshot_id").all();
      for (const row of rows) {
        const assessment = JSON.parse(String(row.body_json)) as Record<string, unknown>;
        const snapshot = JSON.parse(String(row.snapshot_json)) as { files: { diff: string }[] };
        const phase = assessment.status === "queued" ? "preparing" : assessment.status === "analyzing" ? "reviewing_code" : assessment.status;
        const body = { ...assessment, phase, phaseHistory: [{ phase, enteredAt: assessment.updatedAt }],
          metrics: { snapshotBytes: Buffer.byteLength(String(row.snapshot_json), "utf8"), diffBytes: snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.diff, "utf8"), 0) },
          validation: { state: assessment.status === "completed" || assessment.status === "partial" ? "inconclusive" : "not_run", reason: "Tool-free Diff assessment does not execute tests or reproduce exploits." } };
        db.prepare("UPDATE code_assessments SET body_json=? WHERE id=?").run(JSON.stringify(body), String(row.id));
      }
      for (const row of db.prepare("SELECT id,body_json FROM code_assessment_findings").all()) {
        db.prepare("UPDATE code_assessment_findings SET body_json=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(String(row.body_json)), freshnessState: "current" }), String(row.id));
      }
      input.recordMigration(version, name);
    }
    if (!inspect()) throw new Error("code_assessment.lifecycle_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}

function applyCodeAssessmentHistoryFiltersMigration(input: Parameters<typeof applyCodeAssessmentMigration>[0]): void {
  const db = input.database;
  const version = 233;
  const name = "code_assessment_history_filters";
  const indexes = [
    "CREATE INDEX code_assessment_target_history ON code_assessments(json_extract(body_json,'$.target.type'),created_at DESC,id DESC)",
    "CREATE INDEX code_assessment_snapshot_history ON code_assessments(json_extract(body_json,'$.snapshotDigest'),created_at DESC,id DESC)",
    "CREATE INDEX code_assessment_status_history ON code_assessments(status,created_at DESC,id DESC)",
    "CREATE INDEX code_assessment_updated_history ON code_assessments(julianday(json_extract(body_json,'$.updatedAt')))",
    "CREATE INDEX code_assessment_finding_filters ON code_assessment_findings(assessment_id,json_extract(body_json,'$.severity'),json_extract(body_json,'$.confidence'))",
  ];
  function inspect(): boolean {
    const markers = db.prepare("SELECT version,name FROM schema_migrations WHERE version=? OR name=?").all(version, name) as { version: number; name: string }[];
    if (markers.length > 1 || markers.some(marker => marker.version !== version || marker.name !== name)
      || Boolean(markers.length) !== input.hasMigration(version)) throw new Error("code_assessment.history_filters_marker_conflict");
    let existing = 0;
    for (const definition of indexes) {
      const indexName = /CREATE INDEX (\w+)/u.exec(definition)![1]!;
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(indexName) as { sql: string } | undefined;
      if (row) {
        existing++;
        if (typeof row.sql !== "string" || normalize(row.sql) !== normalize(definition)) throw new Error("code_assessment.history_filters_schema_conflict");
      }
    }
    if (markers.length === 0 && existing > 0 || markers.length > 0 && existing !== indexes.length) throw new Error("code_assessment.history_filters_incomplete");
    return markers.length > 0;
  }
  if (inspect()) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!inspect()) {
      for (const definition of indexes) db.exec(definition);
      input.recordMigration(version, name);
    }
    if (!inspect()) throw new Error("code_assessment.history_filters_postcondition");
    db.exec("COMMIT");
  } catch (error) { rollbackOwnedSqliteTransaction(db); throw error; }
}
