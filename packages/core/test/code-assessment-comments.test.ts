import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CodeAssessmentSnapshot, CodeAssessmentFinding } from "@ling-stack/contracts";
import { SqliteCodeAssessmentStore } from "../dist/storage/sqlite/code-assessment-store.js";
import { SqliteCodeAssessmentCommentsStore } from "../dist/storage/sqlite/code-assessment-comments.js";
import { applyCodeAssessmentMigration } from "../dist/storage/sqlite/code-assessment-migration.js";
import { applyCodeAssessmentCommentsMigration } from "../dist/storage/sqlite/code-assessment-comments-migration.js";

const now = "2026-11-17T00:00:00Z";
const snapshot: CodeAssessmentSnapshot = { id: "snapshot", digest: "a".repeat(64), capturedAt: now, target: { type: "working_tree" },
  files: [{ path: "app.ts", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n context\n", kind: "modified", redacted: false, contentDigest: "b".repeat(64) }], totalFileCount: 1, coverage: "complete", exclusions: [] };
const finding: CodeAssessmentFinding = { id: "finding", assessmentId: "assessment", snapshotDigest: snapshot.digest, fingerprint: "c".repeat(64),
  title: "Concrete bug", body: "A specific input fails.", severity: "high", confidence: "high", path: "app.ts", side: "new", startLine: 1, endLine: 1,
  evidence: "new", validation: "unverified", disposition: "open" };
function migrationInput(database: DatabaseSync) {
  return { database,
    hasMigration: (version: number) => Boolean(database.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version: number, name: string) => { database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name); } };
}

test("comments persist with immutable finding anchors and cannot cross assessments or hunks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-comments-"));
  const path = join(cwd, "comments.sqlite");
  let database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL)");
  try {
    applyCodeAssessmentMigration(migrationInput(database)); applyCodeAssessmentCommentsMigration(migrationInput(database));
    let assessments = new SqliteCodeAssessmentStore({ database });
    let comments = new SqliteCodeAssessmentCommentsStore({ database }, assessments);
    assessments.createCodeAssessment({ id: "assessment", kind: "review", providerPresetId: "provider", snapshot, now });
    assessments.finishCodeAssessment("assessment", { status: "completed", findings: [finding], now });
    const input = { id: "comment", now, snapshotDigest: snapshot.digest, path: finding.path, side: finding.side,
      startLine: finding.startLine, endLine: finding.endLine, body: "  Confirmed this boundary.  " };
    for (const patch of [{ snapshotDigest: "d".repeat(64) }, { path: "other.ts" }, { side: "old" as const }, { startLine: 2, endLine: 2 },
      { startLine: 3, endLine: 3 }, { body: " " }]) {
      assert.throws(() => comments.createCodeAssessmentComment("assessment", "finding", { ...input, ...patch }));
    }
    assert.throws(() => comments.createCodeAssessmentComment("assessment", "other_finding", input), /Finding not found/u);
    assert.throws(() => comments.listCodeAssessmentComments("other_assessment", "finding"), /Assessment not found/u);
    const commentAt = "2026-11-17T00:00:01Z";
    const created = comments.createCodeAssessmentComment("assessment", "finding", { ...input, now: commentAt });
    assert.equal(created.body, "Confirmed this boundary.");
    assert.equal(assessments.getCodeAssessment("assessment")?.assessment.updatedAt, commentAt);
    assert.throws(() => comments.createCodeAssessmentComment("assessment", "finding", input), /UNIQUE/u);
    database.close(); database = new DatabaseSync(path);
    assessments = new SqliteCodeAssessmentStore({ database }); comments = new SqliteCodeAssessmentCommentsStore({ database }, assessments);
    assert.deepEqual(comments.listCodeAssessmentComments("assessment", "finding"), [created]);
    assert.equal(assessments.getCodeAssessment("assessment")?.findings[0]?.disposition, "open");
    for (let index = 1; index < 100; index++) comments.createCodeAssessmentComment("assessment", "finding", { ...input, id: `comment_${index}` });
    assert.throws(() => comments.createCodeAssessmentComment("assessment", "finding", { ...input, id: "comment_101" }), /at most 100/u);
    assert.equal(assessments.getCodeAssessment("assessment")?.assessment.updatedAt, commentAt, "older activity must not move updatedAt backwards");
    assert.equal(comments.listCodeAssessmentComments("assessment", "finding").length, 100);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM code_assessment_comments").get()?.count, 100);
  } finally { database.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("comments migration is idempotent and detects marker, missing-index and schema conflicts", () => {
  for (const kind of ["missing_index", "marker", "schema"] as const) {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL)");
    const input = migrationInput(database);
    try {
      applyCodeAssessmentCommentsMigration(input); applyCodeAssessmentCommentsMigration(input);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 1);
      if (kind === "missing_index") database.exec("DROP INDEX code_assessment_comments_finding");
      if (kind === "marker") database.exec("UPDATE schema_migrations SET name='unrelated' WHERE version=232");
      if (kind === "schema") database.exec("DROP TABLE code_assessment_comments; CREATE TABLE code_assessment_comments(id TEXT)");
      assert.throws(() => applyCodeAssessmentCommentsMigration(input), new RegExp(`migration_${kind === "missing_index" ? "incomplete" : kind === "marker" ? "marker_conflict" : "schema_conflict"}`, "u"));
    } finally { database.close(); }
  }
});
