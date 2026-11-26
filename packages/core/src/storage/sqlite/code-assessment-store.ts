import {
  isActiveCodeAssessment,
  isCodeAssessmentPath,
  type CodeAssessment,
  type CodeAssessmentDetail,
  type CodeAssessmentFinding,
  type CodeAssessmentMetrics,
  type CodeAssessmentPhase,
  type CodeAssessmentRunPhase,
} from "@ling-stack/contracts";
import type { CodeAssessmentStore } from "../../code-assessment-store.js";
import type { SqliteStoreContext } from "./store-context.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { SqliteAppServerStateStore } from "./app-server-state-store.js";
import { readSqliteWithinTransaction } from "./read-snapshot.js";

const maxSnapshotBytes = 1024 * 1024;
const maxDiffBytes = 256 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;
const terminalStatuses = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const phaseOrder: readonly CodeAssessmentPhase[] = ["preparing", "collecting_diff", "threat_model", "reviewing_code", "validating_output", "validating_candidates", "synthesizing_findings"];

function mergeMetrics(current: CodeAssessmentMetrics, update: CodeAssessmentMetrics = {}): CodeAssessmentMetrics {
  const allowed: readonly (keyof CodeAssessmentMetrics)[] = ["captureDurationMs", "snapshotBytes", "diffBytes", "timeToSummaryMs", "timeToFirstFindingMs", "timeToFinalMs", "cancelLatencyMs", "reportBytes"];
  for (const [key, value] of Object.entries(update)) {
    if (!allowed.includes(key as keyof CodeAssessmentMetrics) || typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Assessment metric is invalid.");
  }
  return { ...current, ...update };
}

function enterPhase(current: CodeAssessment, phase: CodeAssessmentPhase, enteredAt: string): Pick<CodeAssessment, "phase" | "phaseHistory"> {
  return { phase, phaseHistory: current.phase === phase ? current.phaseHistory : [...current.phaseHistory, { phase, enteredAt }] };
}

function assertSnapshot(snapshot: Parameters<CodeAssessmentStore["createCodeAssessment"]>[0]["snapshot"]): void {
  if (!snapshot.id || !sha256.test(snapshot.digest) || !Number.isSafeInteger(snapshot.totalFileCount) || snapshot.totalFileCount < snapshot.files.length) {
    throw new Error("Assessment snapshot metadata is invalid.");
  }
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (!isCodeAssessmentPath(file.path) || paths.has(file.path) || !sha256.test(file.contentDigest)
      || Buffer.byteLength(file.diff, "utf8") > maxDiffBytes) throw new Error("Assessment snapshot file is invalid.");
    paths.add(file.path);
  }
  for (const exclusion of snapshot.exclusions) {
    if (!isCodeAssessmentPath(exclusion.path)) throw new Error("Assessment snapshot exclusion is invalid.");
  }
}

function begin(db: SqliteStoreContext["database"]): void { db.exec("BEGIN IMMEDIATE"); }
function rollback(db: SqliteStoreContext["database"], error: unknown): never { rollbackOwnedSqliteTransaction(db); throw error; }

export class SqliteCodeAssessmentStore implements CodeAssessmentStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createCodeAssessment(input: Parameters<CodeAssessmentStore["createCodeAssessment"]>[0]): CodeAssessmentDetail {
    assertSnapshot(input.snapshot);
    if (Buffer.byteLength(JSON.stringify(input.snapshot), "utf8") > maxSnapshotBytes) throw new Error("Assessment snapshot exceeds its storage budget.");
    const assessment: CodeAssessment = {
      id: input.id, kind: input.kind, providerPresetId: input.providerPresetId, status: "queued",
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}),
      ...(input.reviewRules ? { reviewRules: input.reviewRules } : {}),
      ...(input.submission?.workItem ? { workItem: input.submission.workItem } : {}),
      phase: "collecting_diff", phaseHistory: [{ phase: "preparing", enteredAt: input.preparedAt ?? input.now }, { phase: "collecting_diff", enteredAt: input.captureStartedAt ?? input.now }],
      metrics: mergeMetrics({ snapshotBytes: Buffer.byteLength(JSON.stringify(input.snapshot), "utf8"), diffBytes: input.snapshot.files.reduce((size, file) => size + Buffer.byteLength(file.diff, "utf8"), 0) }, input.metrics),
      validation: { state: "not_run", reason: "Tool-free Diff assessment does not execute tests or reproduce exploits." },
      snapshotId: input.snapshot.id, snapshotDigest: input.snapshot.digest, target: input.snapshot.target,
      ...(input.snapshot.branchName ? { branchName: input.snapshot.branchName } : {}), findingCount: 0,
      createdAt: input.preparedAt ?? input.now, updatedAt: input.now,
    };
    const db = this.context.database;
    begin(db);
    try {
      if (input.submission?.assertCurrent) readSqliteWithinTransaction(db, input.submission.assertCurrent);
      if (db.prepare("SELECT id FROM code_assessments WHERE status IN ('queued','analyzing') LIMIT 1").get()) throw new Error("An assessment is already running in this workspace.");
      db.prepare("INSERT INTO code_assessment_snapshots(id,digest,body_json) VALUES (?,?,?)").run(input.snapshot.id, input.snapshot.digest, JSON.stringify(input.snapshot));
      db.prepare("INSERT INTO code_assessments(id,kind,status,snapshot_id,created_at,body_json) VALUES (?,?,?,?,?,?)").run(assessment.id, assessment.kind, assessment.status, assessment.snapshotId, assessment.createdAt, JSON.stringify(assessment));
      if (input.submission) {
        const receipt = new SqliteAppServerStateStore(this.context).putWithinTransaction({
          kind: input.reviewFocus === "simplification" ? "simplify_submission" : "review_submission",
          recordId: assessment.id, expectedRevision: 0,
          idempotencyKey: input.submission.idempotencyKey, payload: input.submission.fingerprint,
        }, input.now);
        if (receipt?.status !== "created") throw new Error("The review submission already has an assessment.");
      }
      db.exec("COMMIT");
    } catch (error) { return rollback(db, error); }
    return { assessment, snapshot: input.snapshot, findings: [] };
  }

  getCodeAssessment(id: string): CodeAssessmentDetail | undefined {
    const db = this.context.database;
    const row = db.prepare("SELECT a.body_json, s.body_json AS snapshot_json FROM code_assessments a JOIN code_assessment_snapshots s ON s.id=a.snapshot_id WHERE a.id=?").get(id) as { body_json?: string; snapshot_json?: string } | undefined;
    if (!row?.body_json || !row.snapshot_json) return undefined;
    const findings = db.prepare("SELECT body_json FROM code_assessment_findings WHERE assessment_id=? ORDER BY rowid").all(id)
      .map(item => JSON.parse(String((item as { body_json: string }).body_json)) as CodeAssessmentFinding);
    return { assessment: JSON.parse(row.body_json) as CodeAssessment, snapshot: JSON.parse(row.snapshot_json), findings };
  }

  listCodeAssessments(input: Parameters<CodeAssessmentStore["listCodeAssessments"]>[0] = {}) {
    const limit = input.limit ?? 30;
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Assessment pagination is invalid.");
    const where: string[] = [];
    const parameters: (string | number)[] = [];
    const add = (clause: string, value: string | number) => { where.push(clause); parameters.push(value); };
    if (input.kind !== undefined) {
      if (!["review", "security"].includes(input.kind)) throw new Error("Assessment kind filter is invalid.");
      add("a.kind=?", input.kind);
    }
    if (input.targetType !== undefined) {
      if (!["working_tree", "branch", "commit"].includes(input.targetType)) throw new Error("Assessment target filter is invalid.");
      add("json_extract(a.body_json,'$.target.type')=?", input.targetType);
    }
    if (input.snapshotDigest !== undefined) {
      if (!sha256.test(input.snapshotDigest)) throw new Error("Assessment snapshot filter is invalid.");
      add("json_extract(a.body_json,'$.snapshotDigest')=?", input.snapshotDigest);
    }
    if (input.status !== undefined) {
      if (!["queued", "analyzing", ...terminalStatuses].includes(input.status)) throw new Error("Assessment status filter is invalid.");
      add("a.status=?", input.status);
    }
    for (const [key, operator] of [["updatedAfter", ">="], ["updatedBefore", "<="]] as const) {
      const value = input[key];
      if (value !== undefined) {
        if (!Number.isFinite(Date.parse(value))) throw new Error("Assessment update-time filter is invalid.");
        add(`julianday(json_extract(a.body_json,'$.updatedAt'))${operator}julianday(?)`, new Date(value).toISOString());
      }
    }
    if (input.updatedAfter !== undefined && input.updatedBefore !== undefined && Date.parse(input.updatedAfter) > Date.parse(input.updatedBefore)) {
      throw new Error("Assessment update-time range is invalid.");
    }
    const findingFilters: string[] = [];
    if (input.severity !== undefined) {
      if (!["critical", "high", "medium", "low", "info"].includes(input.severity)) throw new Error("Assessment severity filter is invalid.");
      findingFilters.push("json_extract(f.body_json,'$.severity')=?"); parameters.push(input.severity);
    }
    if (input.confidence !== undefined) {
      if (!["high", "medium", "low"].includes(input.confidence)) throw new Error("Assessment confidence filter is invalid.");
      findingFilters.push("json_extract(f.body_json,'$.confidence')=?"); parameters.push(input.confidence);
    }
    if (findingFilters.length) where.push(`EXISTS (SELECT 1 FROM code_assessment_findings f WHERE f.assessment_id=a.id AND ${findingFilters.join(" AND ")})`);
    const predicate = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = Number(this.context.database.prepare(`SELECT COUNT(*) AS total FROM code_assessments a${predicate}`).get(...parameters)!.total);
    const rows = this.context.database.prepare(`SELECT a.body_json FROM code_assessments a${predicate} ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`)
      .all(...parameters, limit + 1, offset);
    return {
      assessments: rows.slice(0, limit).map(row => JSON.parse(String((row as { body_json: string }).body_json)) as CodeAssessment),
      total,
      ...(rows.length > limit ? { nextOffset: offset + limit } : {}),
    };
  }

  bindCodeAssessmentRun(id: string, runId: string, now: string, phase?: CodeAssessmentRunPhase): CodeAssessment {
    const db = this.context.database;
    begin(db);
    try {
      const current = this.require(id).assessment;
      if (!isActiveCodeAssessment(current.status)) { db.exec("COMMIT"); return current; }
      const nextPhase = phase ?? (current.kind === "security" ? "threat_model" : "reviewing_code");
      const existing = current.phaseRuns?.find(item => item.phase === nextPhase);
      if (existing) {
        if (existing.runId !== runId) throw new Error("Assessment already has a different Run for this phase.");
        db.exec("COMMIT"); return current;
      }
      if (nextPhase === "threat_model" && (current.kind !== "security" || current.runId || current.threatModelArtifactId)) throw new Error("Assessment threat-model phase is not available.");
      if (nextPhase === "reviewing_code" && current.kind === "security" && (!current.threatModelArtifactId || current.phase !== "reviewing_code")) throw new Error("Assessment threat model must complete before code review.");
      if (current.runId && current.runId !== runId && !(nextPhase === "reviewing_code" && current.kind === "security" && current.phaseRuns?.some(item => item.phase === "threat_model" && item.runId === current.runId && item.status === "completed"))) throw new Error("Assessment already has a different Run.");
      const next: CodeAssessment = { ...current, runId, status: "analyzing", updatedAt: now, ...enterPhase(current, nextPhase, now),
        phaseRuns: [...(current.phaseRuns ?? []), { phase: nextPhase, runId, status: "running" }] };
      this.write(next); db.exec("COMMIT"); return next;
    } catch (error) { return rollback(db, error); }
  }

  completeCodeAssessmentThreatModel(id: string, input: Parameters<CodeAssessmentStore["completeCodeAssessmentThreatModel"]>[1]): boolean {
    const db = this.context.database;
    begin(db);
    try {
      const current = this.require(id).assessment;
      const phaseRun = current.phaseRuns?.find(item => item.phase === "threat_model" && item.runId === input.runId);
      if (!isActiveCodeAssessment(current.status) || current.runId !== input.runId || phaseRun?.status !== "running") { db.exec("COMMIT"); return false; }
      if (current.phase !== "threat_model" || !input.artifactId) throw new Error("Assessment threat-model completion is invalid.");
      this.write({ ...current, ...enterPhase(current, "reviewing_code", input.now), threatModelArtifactId: input.artifactId, updatedAt: input.now,
        phaseRuns: current.phaseRuns!.map(item => item === phaseRun ? { ...item, status: "completed", artifactId: input.artifactId } : item) });
      db.exec("COMMIT"); return true;
    } catch (error) { return rollback(db, error); }
  }

  advanceCodeAssessmentPhase(id: string, input: Parameters<CodeAssessmentStore["advanceCodeAssessmentPhase"]>[1]): CodeAssessment {
    const db = this.context.database;
    begin(db);
    try {
      const current = this.require(id).assessment;
      if (!isActiveCodeAssessment(current.status)) { db.exec("COMMIT"); return current; }
      if (current.runId !== input.runId) throw new Error("Assessment Run does not match.");
      const previous: Record<string, CodeAssessmentPhase> = { validating_output: "reviewing_code", validating_candidates: "validating_output", synthesizing_findings: "validating_candidates" };
      if (!(input.phase in previous) || phaseOrder.indexOf(input.phase) < phaseOrder.indexOf(current.phase)) throw new Error("Assessment phase cannot move backwards.");
      if (current.phase !== input.phase && current.phase !== previous[input.phase]) throw new Error("Assessment phase prerequisite is missing.");
      const next: CodeAssessment = { ...current, ...enterPhase(current, input.phase, input.now), metrics: mergeMetrics(current.metrics, input.metrics), updatedAt: input.now };
      this.write(next); db.exec("COMMIT"); return next;
    } catch (error) { return rollback(db, error); }
  }

  recordCodeAssessmentFreshness(id: string, freshness: Parameters<CodeAssessmentStore["recordCodeAssessmentFreshness"]>[1]) {
    if (!["current", "stale", "unknown"].includes(freshness.state) || !Number.isFinite(Date.parse(freshness.checkedAt))) throw new Error("Assessment freshness is invalid.");
    const db = this.context.database;
    begin(db);
    try {
      const detail = this.require(id);
      const state = freshness.state === "unknown" && detail.assessment.freshness?.state === "stale" ? "stale" : freshness.state;
      const previousFreshness = detail.assessment.freshness;
      if (previousFreshness && Date.parse(freshness.checkedAt) < Date.parse(previousFreshness.checkedAt)) {
        db.exec("COMMIT");
        return previousFreshness;
      }
      const nextFreshness = { ...freshness, state };
      const updatedAt = Date.parse(freshness.checkedAt) >= Date.parse(detail.assessment.updatedAt) ? freshness.checkedAt : detail.assessment.updatedAt;
      this.write({ ...detail.assessment, freshness: nextFreshness, updatedAt });
      if (state !== "unknown") {
        for (const finding of detail.findings) db.prepare("UPDATE code_assessment_findings SET body_json=? WHERE id=? AND assessment_id=?")
          .run(JSON.stringify({ ...finding, freshnessState: state }), finding.id, id);
      }
      db.exec("COMMIT"); return nextFreshness;
    } catch (error) { return rollback(db, error); }
  }

  finishCodeAssessment(id: string, input: Parameters<CodeAssessmentStore["finishCodeAssessment"]>[1]): CodeAssessment {
    if (!terminalStatuses.has(input.status)) throw new Error("Assessment terminal status is invalid.");
    const db = this.context.database;
    begin(db);
    try {
      const current = this.require(id);
      if (!isActiveCodeAssessment(current.assessment.status)) { db.exec("COMMIT"); return current.assessment; }
      if (current.assessment.runId !== input.runId) throw new Error("Assessment Run does not match.");
      const findings = input.findings ?? [];
      if ((input.status !== "completed" && input.status !== "partial") && findings.length > 0) throw new Error("Terminal failure cannot publish findings.");
      if (findings.length > 50 || findings.some(finding => finding.assessmentId !== id || finding.snapshotDigest !== current.snapshot.digest
        || finding.validation !== "unverified" || finding.disposition !== "open")) throw new Error("Finding snapshot binding is invalid.");
      if (input.status === "completed" && current.snapshot.coverage !== "complete") throw new Error("Incomplete coverage cannot be completed.");
      for (const finding of findings) {
        if (!finding.id || !finding.fingerprint || !finding.title || !finding.body || !finding.evidence) throw new Error("Finding content is invalid.");
        db.prepare("INSERT INTO code_assessment_findings(id,assessment_id,body_json) VALUES (?,?,?)").run(finding.id, id, JSON.stringify({ ...finding, freshnessState: current.assessment.freshness?.state === "stale" ? "stale" : "current" }));
      }
      const next: CodeAssessment = { ...current.assessment, status: input.status, findingCount: findings.length, updatedAt: input.now,
        ...enterPhase(current.assessment, input.status, input.now),
        ...(current.assessment.phaseRuns ? { phaseRuns: current.assessment.phaseRuns.map(item => item.runId === input.runId && item.status === "running" ? { ...item, status: input.status === "partial" ? "completed" as const : input.status, ...((input.reportArtifactId ?? input.diagnosticArtifactId) ? { artifactId: input.reportArtifactId ?? input.diagnosticArtifactId } : {}) } : item) } : {}),
        metrics: mergeMetrics(current.assessment.metrics, { ...input.metrics, timeToFinalMs: Math.max(0, Date.parse(input.now) - Date.parse(current.assessment.createdAt)) }),
        validation: { state: input.status === "completed" || input.status === "partial" ? "inconclusive" : "not_run", reason: input.status === "completed" || input.status === "partial" ? "Report schema, snapshot binding and hunk evidence were checked. Tests and exploit reproduction were not run." : "Tool-free Diff assessment does not execute tests or reproduce exploits." },
        ...(input.summary !== undefined ? { summary: input.summary } : {}), ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
        ...(input.reportArtifactId !== undefined ? { reportArtifactId: input.reportArtifactId } : {}),
        ...(input.diagnosticArtifactId !== undefined ? { diagnosticArtifactId: input.diagnosticArtifactId } : {}) };
      this.write(next);
      db.exec("COMMIT");
      return next;
    } catch (error) { return rollback(db, error); }
  }

  setCodeFindingDisposition(assessmentId: string, findingId: string, input: Parameters<CodeAssessmentStore["setCodeFindingDisposition"]>[2]): CodeAssessmentFinding {
    if (!["open", "acknowledged", "resolved", "dismissed"].includes(input.disposition)) throw new Error("Finding disposition is invalid.");
    if (!Number.isFinite(Date.parse(input.now))) throw new Error("Finding update time is invalid.");
    const db = this.context.database;
    begin(db);
    try {
      if (input.submission) {
        const prior = new SqliteAppServerStateStore(this.context).get("review_finding_update", input.submission.recordId);
        if (prior) {
          const payload = prior.payload as { readonly fingerprint?: unknown };
          if (payload.fingerprint !== input.submission.fingerprint) throw new Error("app_server_state_idempotency_conflict");
          db.exec("COMMIT");
          const finding = this.getCodeAssessment(assessmentId)?.findings.find(item => item.id === findingId);
          if (!finding) throw new Error("Finding not found.");
          return finding;
        }
      }
      const detail = this.require(assessmentId);
      if (input.snapshotDigest !== detail.snapshot.digest) throw new Error("Finding snapshot changed.");
      if (input.expectedRevision !== undefined && input.expectedRevision !== detail.assessment.updatedAt) throw new Error("Finding update revision changed.");
      const reason = input.reason?.trim();
      const closing = input.disposition === "dismissed" || input.disposition === "resolved";
      if ((closing && !reason) || (reason && reason.length > 2000)) throw new Error("Closing a finding requires a bounded reason.");
      if (closing && !["false_positive", "accepted_risk", "not_reproducible", "duplicate", "out_of_scope"].includes(input.closeReason ?? "")) throw new Error("Closing a finding requires a typed close reason.");
      if (input.disposition === "resolved" && !input.freshness && detail.assessment.freshness?.state !== "current") throw new Error("Resolving a finding requires a current snapshot freshness check.");
      const finding = detail.findings.find(item => item.id === findingId);
      if (!finding) throw new Error("Finding not found.");
      const next: CodeAssessmentFinding = { ...finding, disposition: input.disposition,
        dispositionReason: closing ? reason : undefined, closeReason: closing ? input.closeReason : undefined,
        ...(input.freshness ? { freshnessState: "current" } : {}) };
      const updateFinding = db.prepare("UPDATE code_assessment_findings SET body_json=? WHERE id=? AND assessment_id=?");
      updateFinding.run(JSON.stringify(next), findingId, assessmentId);
      const previous = Date.parse(detail.assessment.updatedAt);
      const updatedAt = input.submission
        ? new Date(Math.max(Date.parse(input.now), previous + 1)).toISOString()
        : Date.parse(input.now) >= previous ? input.now : detail.assessment.updatedAt;
      const nextAssessment = { ...detail.assessment, updatedAt,
        ...(input.freshness ? { freshness: input.freshness } : {}) };
      this.write(nextAssessment);
      if (input.freshness) {
        for (const currentFinding of detail.findings) {
          if (currentFinding.id !== findingId) {
            updateFinding.run(JSON.stringify({ ...currentFinding, freshnessState: "current" }), currentFinding.id, assessmentId);
          }
        }
      }
      if (input.submission) {
        const receipt = new SqliteAppServerStateStore(this.context).putWithinTransaction({
          kind: "review_finding_update", recordId: input.submission.recordId, expectedRevision: 0,
          idempotencyKey: input.submission.idempotencyKey,
          payload: { fingerprint: input.submission.fingerprint, result: {
            assessmentId, findingId, revision: updatedAt, disposition: next.disposition,
          } },
        }, input.now);
        if (receipt?.status !== "created") throw new Error("The finding update already has a receipt.");
      }
      db.exec("COMMIT");
      return next;
    } catch (error) { return rollback(db, error); }
  }

  private require(id: string): CodeAssessmentDetail {
    const detail = this.getCodeAssessment(id);
    if (!detail) throw new Error("Assessment not found.");
    return detail;
  }

  private write(assessment: CodeAssessment): void {
    this.context.database.prepare("UPDATE code_assessments SET status=?,body_json=? WHERE id=?").run(assessment.status, JSON.stringify(assessment), assessment.id);
  }
}
