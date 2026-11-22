import { createHash, randomUUID } from "node:crypto";
import { redactSecrets, type RunSession, type RunStore } from "@ling-stack/core";
import { isActiveCodeAssessment, parseCodeAssessmentModelOutput, parseCodeAssessmentThreatModel } from "@ling-stack/contracts";
import type { CodeAssessmentDetail, CodeAssessmentFinding, CodeAssessmentRunPhase, CodeAssessmentThreatModel, CreateCodeAssessmentRequest } from "@ling-stack/contracts";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunRequest } from "../runs/schemas.js";
import { startDetachedRunAndResolveReady } from "../runs/detached.js";
import { ensureRunCancelled } from "../runs/cancellation.js";
import { HttpError } from "../../errors.js";
import { captureCodeAssessmentSnapshot } from "./snapshot.js";
import { codeAssessmentRunRequest } from "./prompt.js";
import { readBaselineReviewRules } from "./review-rules.js";

export type StartCodeAssessmentRun = (request: RunRequest, afterRunTerminal: (run: RunSession) => Promise<void>, onRunReady: (runId: string) => void) => Promise<string | undefined>;
const pendingByStore = new WeakMap<RunStore, Map<string, number>>();
function retainPending(store: RunStore, id: string): () => void {
  let pending = pendingByStore.get(store);
  if (!pending) { pending = new Map(); pendingByStore.set(store, pending); }
  pending.set(id, (pending.get(id) ?? 0) + 1);
  return () => { const count = pending!.get(id) ?? 0; if (count > 1) pending!.set(id, count - 1); else pending!.delete(id); };
}
const capturing = new WeakSet<RunStore>();
const maxReconciliationRows = 100;
const maxFreshnessRows = 200;
const now = () => new Date().toISOString();
const safeText = (value: string) => redactSecrets(value) as string;

function finalReportText(store: RunStore, runId: string): string {
  let result = "";
  let afterSeq = 0;
  for (let page = 0; page < 10; page++) {
    const events = store.listEvents(runId, { afterSeq, limit: 1000 });
    for (const event of events) {
      if (event.type === "message_end" && event.data.role === "assistant" && typeof event.data.text === "string") result = event.data.text;
    }
    if (events.length < 1000) return result;
    afterSeq = events.at(-1)!.seq;
  }
  throw new Error("Assessment event history exceeds the report budget.");
}

function recordRunFailure(store: RunStore, assessmentId: string, run: RunSession, cause: unknown): void {
  const detail = store.getCodeAssessment(assessmentId);
  if (!detail || !isActiveCodeAssessment(detail.assessment.status) || detail.assessment.runId !== run.id) return;
  let output = "";
  let outputUnavailable: string | undefined;
  try { output = safeText(finalReportText(store, run.id)); }
  catch (error) { outputUnavailable = safeText(error instanceof Error ? error.message : String(error)).slice(0, 1000); }
  const errorMessage = safeText(cause instanceof Error ? cause.message : String(cause)).slice(0, 8000);
  const artifact = store.createArtifact({ runId: run.id, type: "json", path: `code-assessments/${assessmentId}/diagnostic.json`,
    title: "Local Diff assessment diagnostic", contentType: "application/json", createdAt: now(), sealedPayload: {
      schemaVersion: 1, assessmentId, snapshotDigest: detail.snapshot.digest, phase: detail.assessment.phase,
      runId: run.id, runStatus: run.status, errorMessage, output: output.slice(0, 32 * 1024),
      outputTruncated: output.length > 32 * 1024, ...(outputUnavailable ? { outputUnavailable } : {}),
    } });
  store.finishCodeAssessment(assessmentId, { runId: run.id, status: "failed", errorMessage, diagnosticArtifactId: artifact.id, now: now() });
}

export function finishCodeAssessmentRun(store: RunStore, assessmentId: string, run: RunSession): void {
  const detail = store.getCodeAssessment(assessmentId);
  if (!detail || !isActiveCodeAssessment(detail.assessment.status) || detail.assessment.runId !== run.id) return;
  if (["queued", "running", "waiting_for_approval", "yielded"].includes(run.status)) return;
  const phaseRun = detail.assessment.phaseRuns?.find(item => item.runId === run.id);
  if (phaseRun?.phase === "threat_model" && run.status === "succeeded") {
    if (phaseRun.status === "completed" || materializeThreatModel(store, assessmentId, run)) {
      store.finishCodeAssessment(assessmentId, { runId: run.id, status: "interrupted", errorMessage: "The threat model was saved, but code review was not admitted before interruption. Run again to capture a fresh snapshot.", now: now() });
    }
    return;
  }
  if (run.status !== "succeeded") {
    if (run.status === "cancelled") store.finishCodeAssessment(assessmentId, { runId: run.id, status: "cancelled", now: now() });
    else recordRunFailure(store, assessmentId, run, run.errorMessage ?? "The analysis Run did not complete.");
    return;
  }
  try {
    store.advanceCodeAssessmentPhase(assessmentId, { runId: run.id, phase: "validating_output", now: now() });
    const reportText = finalReportText(store, run.id);
    if (reportText.length > 256 * 1024) throw new Error("Assessment output exceeds the report budget.");
    const decoded: unknown = JSON.parse(reportText.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/u, "$1"));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Assessment output must be a JSON object.");
    store.advanceCodeAssessmentPhase(assessmentId, { runId: run.id, phase: "validating_candidates", now: now() });
    const parsed = parseCodeAssessmentModelOutput(JSON.stringify(decoded), detail.snapshot);
    const availableAt = now();
    store.advanceCodeAssessmentPhase(assessmentId, { runId: run.id, phase: "synthesizing_findings", now: availableAt,
      metrics: { timeToSummaryMs: Math.max(0, Date.parse(availableAt) - Date.parse(detail.assessment.createdAt)) } });
    const summary = safeText(parsed.summary);
    const findings: CodeAssessmentFinding[] = parsed.findings.map(finding => ({ ...finding,
      title: safeText(finding.title), body: safeText(finding.body), evidence: safeText(finding.evidence),
      id: `finding_${randomUUID()}`, assessmentId, snapshotDigest: detail.snapshot.digest,
      fingerprint: createHash("sha256").update(JSON.stringify(finding)).digest("hex"), validation: "unverified", disposition: "open", freshnessState: "current" }));
    const report = { snapshotDigest: detail.snapshot.digest, summary, findings,
      ...(detail.assessment.reviewRules ? { reviewRules: detail.assessment.reviewRules } : {}) };
    const artifact = store.createArtifact({ runId: run.id, type: "json", path: `code-assessments/${assessmentId}/report.json`,
      title: "Local Diff assessment report", contentType: "application/json", sealedPayload: report, createdAt: now() });
    store.finishCodeAssessment(assessmentId, { runId: run.id, status: detail.snapshot.coverage === "complete" ? "completed" : "partial",
      summary, findings, reportArtifactId: artifact.id, metrics: { reportBytes: Buffer.byteLength(JSON.stringify(report), "utf8") }, now: now() });
  } catch (error) {
    recordRunFailure(store, assessmentId, run, error);
  }
}

/** Reconnect materializes a terminal report; orphaned work stays in history and is never silently rerun. */
export function reconcileCodeAssessments(store: RunStore, activeRuns: ActiveRunRegistry): void {
  // Only active rows need recovery; terminal history is immutable until an explicit freshness check.
  for (const status of ["queued", "analyzing"] as const) {
    const page = store.listCodeAssessments({ status, limit: maxReconciliationRows });
    for (const item of page.assessments) {
      if (!isActiveCodeAssessment(item.status) || pendingByStore.get(store)?.has(item.id)) continue;
      const run = item.runId ? store.getRun(item.runId) : undefined;
      if (run && ["succeeded", "failed", "cancelled"].includes(run.status)) finishCodeAssessmentRun(store, item.id, run);
      else if (!run || !activeRuns.get(run.id) && !store.hasRuntimeRunQueueCustody(run.id)) {
        store.finishCodeAssessment(item.id, { runId: item.runId, status: "interrupted",
          errorMessage: "The analysis was interrupted. Run again to capture a fresh snapshot.", now: now() });
      }
    }
  }
}

interface ReviewSubmission {
  readonly assessmentId: string;
  readonly candidateDigest: string;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly rulesRefs: readonly string[];
  readonly reviewFocus?: CodeAssessmentDetail["assessment"]["reviewFocus"];
}

export async function startCodeAssessment(
  store: RunStore,
  input: CreateCodeAssessmentRequest,
  startRun: StartCodeAssessmentRun,
  submission?: ReviewSubmission,
): Promise<CodeAssessmentDetail> {
  const provider = store.getProviderPreset(input.providerPresetId);
  if (!provider?.enabled || !provider.capabilities.includes("chat") || provider.api === "media-job") {
    throw new HttpError(400, "assessment_provider_unavailable", "Choose an enabled chat model before starting an assessment.");
  }
  if (capturing.has(store)) throw new HttpError(409, "assessment_busy", "A snapshot is already being captured.");
  capturing.add(store);
  let detail: CodeAssessmentDetail;
  const preparedAt = now();
  const captureStartedAt = now();
  try {
    const snapshot = await captureCodeAssessmentSnapshot(store.paths.cwd, input.target);
    if (submission && snapshot.digest !== submission.candidateDigest) {
      throw new HttpError(409, "candidate_stale", "The review candidate differs from the submitted digest.");
    }
    for (const status of ["queued", "analyzing"] as const) {
      const active = store.listCodeAssessments({ status, limit: 1 }).assessments[0];
      if (!active) continue;
      if (!submission && !active.reviewFocus && active.snapshotDigest === snapshot.digest && active.kind === input.kind && active.providerPresetId === input.providerPresetId
        && active.instructions === input.instructions) return store.getCodeAssessment(active.id)!;
      throw new HttpError(409, "assessment_busy", "An assessment is already running in this workspace.");
    }
    const reviewRules = input.kind === "review"
      ? await readBaselineReviewRules(store.paths.cwd, snapshot, submission?.rulesRefs) : undefined;
    detail = store.createCodeAssessment({
      id: submission?.assessmentId ?? `assessment_${randomUUID()}`, kind: input.kind,
      providerPresetId: input.providerPresetId, instructions: input.instructions, snapshot, reviewRules, reviewFocus: submission?.reviewFocus,
      ...(submission ? { submission: { idempotencyKey: submission.idempotencyKey, fingerprint: submission.fingerprint } } : {}),
      preparedAt, captureStartedAt, metrics: { captureDurationMs: Math.max(0, Date.now() - Date.parse(captureStartedAt)) }, now: now(),
    });
    let scanned = 0;
    for (let offset = 0; scanned < maxFreshnessRows; offset += 100) {
      const page = store.listCodeAssessments({ targetType: snapshot.target.type, limit: 100, offset });
      for (const previous of page.assessments) {
        scanned++;
        if (previous.id === detail.assessment.id || !["completed", "partial"].includes(previous.status)
          || JSON.stringify(previous.target) !== JSON.stringify(snapshot.target)) continue;
        store.recordCodeAssessmentFreshness(previous.id, {
          state: previous.snapshotDigest !== snapshot.digest ? "stale" : snapshot.coverage === "complete" ? "current" : "unknown", checkedAt: now(),
        });
      }
      if (page.nextOffset === undefined) break;
    }
  } finally { capturing.delete(store); }
  await launchStage(store, detail.assessment.id, input.kind === "security" ? "threat_model" : "reviewing_code", startRun);
  return store.getCodeAssessment(detail.assessment.id)!;
}

function materializeThreatModel(store: RunStore, id: string, run: RunSession): boolean {
  const detail = store.getCodeAssessment(id);
  const phaseRun = detail?.assessment.phaseRuns?.find(item => item.phase === "threat_model" && item.runId === run.id);
  if (!detail || !isActiveCodeAssessment(detail.assessment.status) || detail.assessment.runId !== run.id || phaseRun?.status !== "running") return false;
  if (run.status !== "succeeded") { finishCodeAssessmentRun(store, id, run); return false; }
  try {
    const parsed = parseCodeAssessmentThreatModel(finalReportText(store, run.id), detail.snapshot);
    const report: CodeAssessmentThreatModel = { ...parsed, summary: safeText(parsed.summary), assets: parsed.assets.map(safeText),
      trustBoundaries: parsed.trustBoundaries.map(safeText), attackerControls: parsed.attackerControls.map(safeText), assumptions: parsed.assumptions.map(safeText) };
    const artifact = store.createArtifact({ runId: run.id, type: "json", path: `code-assessments/${id}/threat-model.json`,
      title: "Bounded Diff threat model", contentType: "application/json", sealedPayload: report, createdAt: now() });
    return store.completeCodeAssessmentThreatModel(id, { runId: run.id, artifactId: artifact.id, now: now() });
  } catch (error) {
    recordRunFailure(store, id, run, error);
    return false;
  }
}

async function launchStage(store: RunStore, id: string, phase: CodeAssessmentRunPhase, startRun: StartCodeAssessmentRun): Promise<string | undefined> {
  const detail = store.getCodeAssessment(id);
  if (!detail || !isActiveCodeAssessment(detail.assessment.status)) return undefined;
  let threatModel: CodeAssessmentThreatModel | undefined;
  if (phase === "reviewing_code" && detail.assessment.kind === "security") {
    const artifact = detail.assessment.threatModelArtifactId ? store.getArtifact(detail.assessment.threatModelArtifactId) : undefined;
    const threatRun = detail.assessment.phaseRuns?.find(item => item.phase === "threat_model" && item.status === "completed");
    try {
      if (!artifact || artifact.runId !== threatRun?.runId) throw new Error("The captured threat-model artifact is unavailable.");
      threatModel = parseCodeAssessmentThreatModel(JSON.stringify(artifact.sealedPayload), detail.snapshot);
    } catch (error) {
      store.finishCodeAssessment(id, { runId: detail.assessment.runId, status: "failed", errorMessage: safeText(error instanceof Error ? error.message : String(error)), now: now() });
      return undefined;
    }
  }
  const releasePending = retainPending(store, id);
  const runId = await startDetachedRunAndResolveReady(onReady => Promise.resolve().then(() => {
    if (!isActiveCodeAssessment(store.getCodeAssessment(id)!.assessment.status)) return undefined;
    return startRun(codeAssessmentRunRequest(store.paths.cwd, detail, phase, threatModel), async run => {
      if (phase === "threat_model") {
        if (materializeThreatModel(store, id, run)) await launchStage(store, id, "reviewing_code", startRun);
      } else finishCodeAssessmentRun(store, id, run);
    }, runId => {
      const bound = store.bindCodeAssessmentRun(id, runId, now(), phase);
      if (!isActiveCodeAssessment(bound.status) || bound.runId !== runId || bound.phase !== phase) {
        const run = store.getRun(runId);
        if (run) ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, startedAt: run.startedAt, reason: "Assessment cancelled before stage admission.", active: false });
        throw new Error("Assessment stage was cancelled before admission.");
      }
      onReady(runId);
    });
  }).finally(releasePending));
  if (!runId) {
    const current = store.getCodeAssessment(id)!.assessment;
    if (isActiveCodeAssessment(current.status)) store.finishCodeAssessment(id, { runId: current.runId, status: "failed", errorMessage: "The analysis Run could not be started. Check model availability and Run history.", now: now() });
  }
  return runId;
}

export function cancelCodeAssessment(store: RunStore, activeRuns: ActiveRunRegistry, detail: CodeAssessmentDetail): CodeAssessmentDetail {
  const cancelStartedAt = Date.now();
  const { assessment } = detail;
  if (!isActiveCodeAssessment(assessment.status)) return detail;
  const run = assessment.runId ? store.getRun(assessment.runId) : undefined;
  if (run) {
    if (["succeeded", "failed", "cancelled"].includes(run.status) && !assessment.phaseRuns?.some(item => item.runId === run.id && item.phase === "threat_model")) {
      finishCodeAssessmentRun(store, assessment.id, run);
      return store.getCodeAssessment(assessment.id)!;
    }
    if (!["succeeded", "failed", "cancelled"].includes(run.status)) {
      ensureRunCancelled({ store, runId: run.id, taskId: run.taskId, startedAt: run.startedAt,
        reason: "Assessment cancelled by user.", active: Boolean(activeRuns.get(run.id)) });
      activeRuns.requestStop(run.id, { kind: "user_cancel", actor: "local-user", reason: "Assessment cancelled by user." });
    }
  }
  store.finishCodeAssessment(assessment.id, { runId: assessment.runId, status: "cancelled", metrics: { cancelLatencyMs: Math.max(0, Date.now() - cancelStartedAt) }, now: now() });
  return store.getCodeAssessment(assessment.id)!;
}
