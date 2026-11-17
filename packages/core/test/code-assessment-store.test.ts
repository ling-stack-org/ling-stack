import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { CodeAssessmentSnapshot, CodeAssessmentFinding } from "@ling-stack/contracts";
import { createSqliteRunStore } from "../dist/index.js";
import { applyCodeAssessmentMigration } from "../dist/storage/sqlite/code-assessment-migration.js";

const now = "2026-11-16T00:00:00Z";
const snapshot: CodeAssessmentSnapshot = { id: "snapshot_store", digest: "a".repeat(64), capturedAt: now, target: { type: "working_tree" },
  files: [{ path: "app.ts", diff: "@@ -1 +1 @@\n-old\n+new\n", kind: "modified", redacted: false, contentDigest: "b".repeat(64) }], totalFileCount: 1, coverage: "complete", exclusions: [] };
const finding: CodeAssessmentFinding = { id: "finding_store", assessmentId: "assessment_store", snapshotDigest: snapshot.digest, fingerprint: "c".repeat(64),
  title: "Concrete bug", body: "This fails for a specific input.", severity: "high", confidence: "high", path: "app.ts", side: "new", startLine: 1, endLine: 1,
  evidence: "new", validation: "unverified", disposition: "open", freshnessState: "current" };

test("snapshot and findings survive reopening; dispositions require digest and a reason", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-assessment-"));
  let store = createSqliteRunStore(cwd);
  try {
    store.createCodeAssessment({ id: "assessment_store", kind: "security", providerPresetId: "provider", snapshot, now });
    assert.throws(() => store.createCodeAssessment({ id: "second", kind: "review", providerPresetId: "provider", snapshot: { ...snapshot, id: "second_snapshot" }, now }), /already running/u);
    store.bindCodeAssessmentRun("assessment_store", "run_store", now);
    assert.throws(() => store.bindCodeAssessmentRun("assessment_store", "another_run", now), /different Run/u);
    assert.throws(() => store.finishCodeAssessment("assessment_store", { runId: "wrong", status: "completed", findings: [finding], now }), /does not match/u);
    assert.throws(() => store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "failed", findings: [finding], now }), /cannot publish/u);
    assert.throws(() => store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "completed", findings: [finding, finding], now }));
    assert.equal(store.getCodeAssessment("assessment_store")?.findings.length, 0, "transaction rollback removes inserted findings");
    store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "completed", summary: "One finding.", findings: [finding], now });
    store.close(); store = createSqliteRunStore(cwd);
    assert.deepEqual(store.getCodeAssessment("assessment_store")?.snapshot, snapshot);
    assert.deepEqual(store.getCodeAssessment("assessment_store")?.findings, [finding]);
    assert.throws(() => store.setCodeFindingDisposition("assessment_store", finding.id, { snapshotDigest: "wrong", disposition: "dismissed", reason: "Reviewed", now }), /snapshot changed/u);
    assert.throws(() => store.setCodeFindingDisposition("assessment_store", finding.id, { snapshotDigest: snapshot.digest, disposition: "dismissed", now }), /reason/u);
    const triagedAt = "2026-11-16T00:00:01Z";
    store.setCodeFindingDisposition("assessment_store", finding.id, { snapshotDigest: snapshot.digest, disposition: "dismissed", closeReason: "out_of_scope", reason: "Not reachable for this input.", now: triagedAt });
    assert.equal(store.getCodeAssessment("assessment_store")?.findings[0]?.disposition, "dismissed");
    assert.equal(store.getCodeAssessment("assessment_store")?.assessment.updatedAt, triagedAt);
    assert.equal(store.listCodeAssessments({ updatedAfter: triagedAt }).assessments[0]?.id, "assessment_store");
    store.recordCodeAssessmentFreshness("assessment_store", { state: "unknown", checkedAt: now });
    assert.equal(store.getCodeAssessment("assessment_store")?.assessment.updatedAt, triagedAt, "delayed freshness must not move updatedAt backwards");
    const reopened = store.setCodeFindingDisposition("assessment_store", finding.id, { snapshotDigest: snapshot.digest, disposition: "open", now });
    assert.equal(reopened.dispositionReason, undefined);
    assert.equal(store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "failed", now }).status, "completed");
    assert.equal(store.bindCodeAssessmentRun("assessment_store", "another", now).runId, "run_store");
    assert.equal(store.listCodeAssessments({ kind: "review" }).assessments.length, 0);
    assert.throws(() => store.listCodeAssessments({ limit: 101 }), /pagination/u);
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("partial capture cannot publish complete coverage", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-assessment-partial-"));
  const store = createSqliteRunStore(cwd);
  try {
    store.createCodeAssessment({ id: "partial", kind: "security", providerPresetId: "provider", snapshot: { ...snapshot, coverage: "partial" }, now });
    assert.throws(() => store.finishCodeAssessment("partial", { status: "completed", now }), /Incomplete coverage/u);
    store.finishCodeAssessment("partial", { status: "partial", now });
    assert.equal(store.getCodeAssessment("partial")?.assessment.status, "partial");
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("phases, metrics and stale findings persist with terminal and Run fences", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-assessment-lifecycle-"));
  let store = createSqliteRunStore(cwd);
  const started = "2026-11-16T00:00:01Z";
  const ended = "2026-11-16T00:00:03Z";
  try {
    const created = store.createCodeAssessment({ id: "assessment_store", kind: "security", providerPresetId: "provider", snapshot, now, metrics: { captureDurationMs: 25 } });
    assert.equal(created.assessment.phase, "collecting_diff");
    assert.ok(created.assessment.metrics.snapshotBytes! > created.assessment.metrics.diffBytes!);
    assert.throws(() => store.bindCodeAssessmentRun("assessment_store", "run_store", started, "reviewing_code"), /threat model must complete/u);
    store.bindCodeAssessmentRun("assessment_store", "threat_run", started, "threat_model");
    assert.equal(store.completeCodeAssessmentThreatModel("assessment_store", { runId: "foreign", artifactId: "threat_artifact", now: started }), false);
    assert.equal(store.completeCodeAssessmentThreatModel("assessment_store", { runId: "threat_run", artifactId: "threat_artifact", now: started }), true);
    assert.equal(store.completeCodeAssessmentThreatModel("assessment_store", { runId: "threat_run", artifactId: "duplicate", now: started }), false);
    store.bindCodeAssessmentRun("assessment_store", "run_store", started, "reviewing_code");
    assert.throws(() => store.advanceCodeAssessmentPhase("assessment_store", { runId: "foreign", phase: "validating_output", now: started }), /does not match/u);
    assert.throws(() => store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "synthesizing_findings", now: started }), /prerequisite/u);
    store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "validating_output", now: started });
    store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "validating_candidates", now: started });
    store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "synthesizing_findings", metrics: { timeToSummaryMs: 1000, timeToFirstFindingMs: 1000 }, now: started });
    assert.throws(() => store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "validating_output", now: started }), /backwards/u);
    store.recordCodeAssessmentFreshness("assessment_store", { state: "stale", checkedAt: started });
    store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "completed", findings: [finding], metrics: { reportBytes: 100 }, now: ended });
    store.close(); store = createSqliteRunStore(cwd);
    const detail = store.getCodeAssessment("assessment_store")!;
    assert.equal(detail.assessment.phase, "completed");
    assert.deepEqual(detail.assessment.phaseHistory.map(entry => [entry.phase, entry.status]), [
      ["preparing", undefined], ["collecting_diff", undefined], ["threat_model", undefined], ["reviewing_code", undefined],
      ["validating_output", undefined], ["validating_candidates", undefined], ["synthesizing_findings", undefined], ["completed", undefined],
    ]);
    assert.equal(detail.assessment.phaseHistory.some(entry => entry.status === "skipped"), false);
    assert.deepEqual(detail.assessment.phaseRuns?.map(item => [item.phase, item.runId, item.status]), [["threat_model", "threat_run", "completed"], ["reviewing_code", "run_store", "completed"]]);
    assert.equal(detail.assessment.threatModelArtifactId, "threat_artifact");
    assert.equal(detail.assessment.validation.state, "inconclusive");
    assert.equal(detail.assessment.metrics.captureDurationMs, 25);
    assert.equal(detail.assessment.metrics.reportBytes, 100);
    assert.equal(detail.assessment.metrics.timeToFinalMs, 3000);
    assert.equal(detail.assessment.freshness?.state, "stale");
    assert.equal(detail.findings[0]?.freshnessState, "stale", "freshness checked during analysis applies to later findings");
    assert.equal(store.recordCodeAssessmentFreshness("assessment_store", { state: "unknown", checkedAt: ended }).state, "stale");
    const closeInput = { snapshotDigest: snapshot.digest, disposition: "resolved" as const, closeReason: "out_of_scope" as const, reason: "Handled by the caller.", now: ended };
    assert.throws(() => store.setCodeFindingDisposition("assessment_store", finding.id, closeInput), /current snapshot/u);
    store.recordCodeAssessmentFreshness("assessment_store", { state: "current", checkedAt: ended });
    const resolved = store.setCodeFindingDisposition("assessment_store", finding.id, closeInput);
    assert.equal(resolved.validation, "unverified");
    assert.equal(resolved.freshnessState, "current");
    assert.equal(store.setCodeFindingDisposition("assessment_store", finding.id, { snapshotDigest: snapshot.digest, disposition: "acknowledged", now: ended }).closeReason, undefined);
    assert.throws(() => store.setCodeFindingDisposition("assessment_store", finding.id, { ...closeInput, closeReason: undefined }), /typed close reason/u);
    assert.deepEqual(store.advanceCodeAssessmentPhase("assessment_store", { runId: "run_store", phase: "validating_output", metrics: { reportBytes: 0 }, now: ended }), store.getCodeAssessment("assessment_store")!.assessment);
    assert.equal(store.finishCodeAssessment("assessment_store", { runId: "run_store", status: "cancelled", now: ended }).status, "completed");
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("lifecycle migration backfills persisted 221 records without inventing execution history", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const input = { database,
    hasMigration: (version: number) => Boolean(database.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version: number, name: string) => { database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name); },
  };
  try {
    applyCodeAssessmentMigration(input);
    database.exec("DELETE FROM schema_migrations WHERE version=222");
    database.prepare("INSERT INTO code_assessment_snapshots VALUES (?,?,?)").run(snapshot.id, snapshot.digest, JSON.stringify(snapshot));
    database.prepare("INSERT INTO code_assessments VALUES (?,?,?,?,?,?)").run("legacy", "review", "completed", snapshot.id, now, JSON.stringify({ id: "legacy", status: "completed", updatedAt: now }));
    applyCodeAssessmentMigration(input);
    const saved = JSON.parse(String(database.prepare("SELECT body_json FROM code_assessments WHERE id='legacy'").get()!.body_json));
    assert.deepEqual(saved.phaseHistory, [{ phase: "completed", enteredAt: now }]);
    assert.equal(saved.metrics.timeToSummaryMs, undefined);
    assert.ok(saved.metrics.snapshotBytes > 0);
    assert.equal(saved.validation.state, "inconclusive");
    database.exec("UPDATE schema_migrations SET name='foreign' WHERE version=222");
    assert.throws(() => applyCodeAssessmentMigration(input), /lifecycle_marker_conflict/u);
  } finally { database.close(); }
});

test("migration is atomic, idempotent and rejects marker/schema conflicts", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const input = { database,
    hasMigration: (version: number) => Boolean(database.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version: number, name: string) => { database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name); },
  };
  try {
    applyCodeAssessmentMigration(input); applyCodeAssessmentMigration(input);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 3);
    database.exec("DROP INDEX code_assessment_active");
    assert.throws(() => applyCodeAssessmentMigration(input), /migration_incomplete/u);
    database.exec("UPDATE schema_migrations SET name='conflict' WHERE version=221");
    assert.throws(() => applyCodeAssessmentMigration(input), /migration_marker_conflict/u);
  } finally { database.close(); }
});


test("history filters intersect before pagination and retain older matching assessments", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-assessment-filters-"));
  let store = createSqliteRunStore(cwd);
  try {
    const createdAt = "2026-11-16T00:00:00.000Z";
    const updatedAt = "2026-11-17T00:00:00.000Z";
    const matches: string[] = [];
    for (let index = 0; index < 105; index++) {
      const id = `history_${String(index).padStart(3, "0")}`;
      const matching = index < 3;
      const captured: CodeAssessmentSnapshot = { ...snapshot, id: `snapshot_${id}`, digest: (matching ? "a" : "d").repeat(64),
        target: matching ? { type: "commit", commitSha: "e".repeat(40) } : { type: index % 2 ? "working_tree" : "branch", ...(index % 2 ? {} : { baseRef: "main" }) } as CodeAssessmentSnapshot["target"] };
      store.createCodeAssessment({ id, kind: matching ? "security" : "review", providerPresetId: "provider", snapshot: captured, now: createdAt });
      const entries: CodeAssessmentFinding[] = matching ? [
        { ...finding, id: `finding_${id}`, assessmentId: id, snapshotDigest: captured.digest },
        { ...finding, id: `finding_second_${id}`, assessmentId: id, snapshotDigest: captured.digest, severity: "low", confidence: "low" },
        { ...finding, id: `finding_info_${id}`, assessmentId: id, snapshotDigest: captured.digest, severity: "info", confidence: "medium" },
      ] : [];
      store.finishCodeAssessment(id, { status: matching ? "completed" : "failed", findings: entries, now: updatedAt });
      if (matching) matches.unshift(id);
    }
    store.close(); store = createSqliteRunStore(cwd);
    assert.equal(store.listCodeAssessments().assessments.length, 30);
    assert.equal(store.listCodeAssessments().total, 105);
    const filters = { kind: "security" as const, targetType: "commit" as const, snapshotDigest: snapshot.digest, status: "completed" as const,
      severity: "high" as const, confidence: "high" as const, updatedAfter: "2026-11-17T08:00:00+08:00", updatedBefore: updatedAt, limit: 2 };
    const first = store.listCodeAssessments(filters);
    assert.deepEqual(first.assessments.map(item => item.id), matches.slice(0, 2));
    assert.equal(first.total, 3); assert.equal(first.nextOffset, 2);
    const second = store.listCodeAssessments({ ...filters, offset: first.nextOffset });
    assert.deepEqual(second.assessments.map(item => item.id), matches.slice(2));
    assert.equal(second.total, 3); assert.equal(second.nextOffset, undefined);
    const empty = store.listCodeAssessments({ ...filters, offset: 30 });
    assert.deepEqual(empty.assessments, []); assert.equal(empty.total, 3); assert.equal(empty.nextOffset, undefined);
    assert.equal(store.listCodeAssessments({ severity: "high", confidence: "low" }).total, 0, "severity and confidence must match one finding");
    assert.equal(store.listCodeAssessments({ severity: "low", confidence: "low" }).total, 3);
    assert.equal(store.listCodeAssessments({ severity: "info", confidence: "medium" }).total, 3);
    assert.equal(store.listCodeAssessments({ targetType: "working_tree" }).total, 51);
    assert.equal(store.listCodeAssessments({ targetType: "branch" }).total, 51);
    assert.equal(store.listCodeAssessments({ status: "failed" }).total, 102);
    assert.equal(store.listCodeAssessments({ updatedAfter: "2026-11-17T00:00:00.001Z" }).total, 0);
    assert.equal(store.listCodeAssessments({ updatedBefore: "2026-11-16T23:59:59.999Z" }).total, 0);
    assert.throws(() => store.listCodeAssessments({ updatedAfter: "invalid" }), /update-time/u);
    assert.throws(() => store.listCodeAssessments({ updatedAfter: updatedAt, updatedBefore: createdAt }), /range/u);
    assert.throws(() => store.listCodeAssessments({ snapshotDigest: "x' OR 1=1--" }), /snapshot filter/u);
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("history index migration upgrades populated assessments and rejects incomplete indexes", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const input = { database,
    hasMigration: (version: number) => Boolean(database.prepare("SELECT version FROM schema_migrations WHERE version=?").get(version)),
    recordMigration: (version: number, name: string) => { database.prepare("INSERT INTO schema_migrations VALUES (?,?)").run(version, name); },
  };
  try {
    applyCodeAssessmentMigration(input);
    for (const index of ["target_history", "snapshot_history", "status_history", "updated_history", "finding_filters"]) database.exec(`DROP INDEX code_assessment_${index}`);
    database.exec("DELETE FROM schema_migrations WHERE version=224");
    database.prepare("INSERT INTO code_assessment_snapshots VALUES (?,?,?)").run(snapshot.id, snapshot.digest, JSON.stringify(snapshot));
    database.prepare("INSERT INTO code_assessments VALUES (?,?,?,?,?,?)").run("existing", "review", "completed", snapshot.id, now, JSON.stringify({ id: "existing", target: snapshot.target, snapshotDigest: snapshot.digest, updatedAt: now }));
    applyCodeAssessmentMigration(input); applyCodeAssessmentMigration(input);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM code_assessments").get()?.count, 1);
    assert.equal(database.prepare("SELECT name FROM schema_migrations WHERE version=224").get()?.name, "code_assessment_history_filters");
    const plan = database.prepare("EXPLAIN QUERY PLAN SELECT id FROM code_assessments WHERE json_extract(body_json,'$.target.type')=? ORDER BY created_at DESC,id DESC").all("working_tree");
    assert.ok(plan.some(row => String(row.detail).includes("code_assessment_target_history")));
    database.exec("DROP INDEX code_assessment_updated_history");
    assert.throws(() => applyCodeAssessmentMigration(input), /history_filters_incomplete/u);
  } finally { database.close(); }
});


test("failed phase retains its diagnostic artifact without publishing findings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-code-assessment-diagnostic-"));
  let store = createSqliteRunStore(cwd);
  try {
    store.createCodeAssessment({ id: "diagnostic", kind: "security", providerPresetId: "provider", snapshot, now });
    store.bindCodeAssessmentRun("diagnostic", "diagnostic_run", now, "threat_model");
    store.finishCodeAssessment("diagnostic", { runId: "diagnostic_run", status: "failed", diagnosticArtifactId: "diagnostic_artifact", now });
    store.close(); store = createSqliteRunStore(cwd);
    const detail = store.getCodeAssessment("diagnostic")!;
    assert.equal(detail.assessment.diagnosticArtifactId, "diagnostic_artifact");
    assert.equal(detail.assessment.reportArtifactId, undefined);
    assert.deepEqual(detail.assessment.phaseRuns, [{ phase: "threat_model", runId: "diagnostic_run", status: "failed", artifactId: "diagnostic_artifact" }]);
    assert.deepEqual(detail.findings, []);
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});
