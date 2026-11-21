import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseCreateCodeAssessment } from "@ling-stack/contracts";
import type {
  DiagnosticsCheck,
  LingAppServerCandidateReference,
  LingAppServerDoctorRunParams,
  LingAppServerDoctorRunResult,
  LingAppServerInstructionsInitParams,
  LingAppServerInstructionsInitResult,
  LingAppServerReviewFindingUpdateParams,
  LingAppServerReviewFindingUpdateResult,
  LingAppServerReviewStartParams,
  LingAppServerReviewStartResult,
  LingAppServerReviewStatusParams,
  LingAppServerReviewStatusResult,
  LingAppServerSimplifyStartParams,
  LingAppServerSimplifyStartResult,
  LingAppServerVerificationCheckPlan,
  LingAppServerVerificationCheckStatus,
  LingAppServerVerifyCancelParams,
  LingAppServerVerifyCancelResult,
  LingAppServerVerifyPlanParams,
  LingAppServerVerifyPlanResult,
  LingAppServerVerifyStartParams,
  LingAppServerVerifyStatusParams,
  LingAppServerVerifyStatusResult,
  LingAppServerVerifyOperation,
  CreateCodeAssessmentRequest,
  CodeAssessmentDetail,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import type { ActiveRunRegistry } from "../runtime/active-runs.js";
import type { AppServerStateRecord, RunStore } from "@ling-stack/core";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { reconcileCodeAssessments, startCodeAssessment, type StartCodeAssessmentRun } from "../features/code-assessments/service.js";
import { parseReviewRuleRefs } from "../features/code-assessments/review-rules.js";
import { verificationRecipes } from "./app-server-verification-recipes.js";
import { collectProjectInstructions } from "../features/conversations/project-instructions.js";
import { initializeProjectInstructions } from "../features/conversations/project-instructions-draft.js";

const DEFAULT_PROVIDER_PRESET = "default";
type VerifyRecord = {
  readonly operation: LingAppServerVerifyOperation;
  readonly plan: LingAppServerVerifyPlanResult;
  readonly cancelRequested: boolean;
};

export interface AppServerDevelopmentOptions {
  readonly context: DaemonContext;
  readonly storeRegistry?: RunStoreRegistry;
  readonly activeRuns?: ActiveRunRegistry;
  readonly startCodeAssessmentRun?: StartCodeAssessmentRun;
  /** Host-owned verification execution. It must use the normal daemon authority. */
  readonly executeVerificationCheck?: (input: {
    readonly cwd: string;
    readonly check: LingAppServerVerificationCheckPlan;
    readonly candidate: LingAppServerCandidateReference;
    readonly signal: AbortSignal;
  }) => Promise<LingAppServerVerificationCheckStatus>;
}

/** Coordinates durable verification state and delegates code assessment to its Run owner. */
export class AppServerDevelopmentService {
  private readonly pendingReviews = new Map<string, { fingerprint: string; result: Promise<LingAppServerReviewStartResult> }>();
  private readonly activeVerifications = new Map<string, AbortController>();

  constructor(private readonly options: AppServerDevelopmentOptions) {}

  async planVerification(input: LingAppServerVerifyPlanParams): Promise<LingAppServerVerifyPlanResult> {
    const cwd = requireCwd(input.cwd ?? input.candidate.workspaceId);
    const store = this.storeRegistry().getStore(cwd);
    const candidate = { ...input.candidate, workspaceId: store.paths.cwd };
    const checks = verificationRecipes(input.requestedChecks).map(({ id, kind, label, argv, required }) => {
      return {
        checkId: id,
        kind,
        label,
        ...(argv.length ? { command: argv.join(" ") } : {}),
        recipeDigest: digest(JSON.stringify({ id, kind, argv, candidateDigest: candidate.candidateDigest })),
        ...(input.planRevision ? { verifierBasisRef: input.planRevision } : {}),
        required,
      } satisfies LingAppServerVerificationCheckPlan;
    });
    const plan: LingAppServerVerifyPlanResult = {
      planId: `verify_plan_${randomUUID()}`,
      planRevision: digest(JSON.stringify({ candidate, checks })),
      candidate,
      checks,
      rationale: ["Selected deterministic workspace checks for the candidate."],
      environmentRequirements: ["workspace_store", "authorized_host_execution"],
    };
    const prior = input.idempotencyKey && store.findAppServerStateByIdempotencyKey("verify_plan", input.idempotencyKey);
    if (prior) {
      const retained = prior.payload as LingAppServerVerifyPlanResult;
      if (retained.planRevision !== plan.planRevision) throw verificationConflict();
      return retained;
    }
    store.putAppServerState({ kind: "verify_plan", recordId: plan.planId, payload: plan, idempotencyKey: input.idempotencyKey }, new Date().toISOString());
    return plan;
  }

  async startVerification(input: LingAppServerVerifyStartParams): Promise<LingAppServerVerifyOperation> {
    const store = this.workspaceStore(input.cwd);
    const plan = store.getAppServerState("verify_plan", input.planId)?.payload as LingAppServerVerifyPlanResult | undefined;
    if (!plan || plan.planRevision !== input.planRevision || plan.candidate.candidateDigest !== input.candidateDigest) {
      throw Object.assign(new Error("Verification plan is stale or unavailable."), { jsonRpcCode: -32030, code: "stale_revision" });
    }
    if (!input.idempotencyKey?.trim()) throw Object.assign(new Error("An idempotency key is required."), { jsonRpcCode: -32602, code: "invalid_params" });
    const existing = store.findAppServerStateByIdempotencyKey("verify_operation", input.idempotencyKey);
    if (existing) {
      const value = existing.payload as VerifyRecord;
      if (value.plan.planId !== plan.planId || value.plan.planRevision !== plan.planRevision) throw verificationConflict();
      return this.readVerification(store, existing).operation;
    }
    const operationId = `verify_${randomUUID()}`;
    const queued = Boolean(this.options.executeVerificationCheck);
    const operation: LingAppServerVerifyOperation = {
      operationId,
      planId: plan.planId,
      candidateDigest: plan.candidate.candidateDigest,
      status: queued ? "queued" : "blocked",
      ...(queued ? {} : { blocker: "verification_executor_unavailable", completedAt: new Date().toISOString() }),
      checks: plan.checks.map(check => ({
        checkId: check.checkId,
        candidateDigest: plan.candidate.candidateDigest,
        planRevision: plan.planRevision,
        recipeDigest: check.recipeDigest,
        environmentDigest: digest(JSON.stringify({ cwd: plan.candidate.workspaceId, check: check.checkId })),
        ...(check.verifierBasisRef ? { verifierBasisRef: check.verifierBasisRef } : {}),
        producerRefs: [],
        attemptId: `verify_attempt_${randomUUID()}`,
        status: queued ? "pending" : "not_run",
        evidenceRefs: [],
      })),
    };
    const payload: VerifyRecord = { operation, plan, cancelRequested: false };
    store.putAppServerState({ kind: "verify_operation", recordId: operationId, payload, idempotencyKey: input.idempotencyKey }, new Date().toISOString());
    if (this.options.executeVerificationCheck) {
      const controller = new AbortController();
      this.activeVerifications.set(operationId, controller);
      const settled = this.executeVerification(store, operationId, controller.signal, this.options.executeVerificationCheck)
        .catch(() => { /* In-flight state is reconciled by the next authorized read. */ })
        .finally(() => this.activeVerifications.delete(operationId));
      this.options.activeRuns?.trackCompletion(settled);
    }
    return operation;
  }

  getVerification(input: LingAppServerVerifyStatusParams): LingAppServerVerifyStatusResult {
    const store = this.workspaceStore(input.cwd);
    const record = store.getAppServerState("verify_operation", input.operationId);
    if (!record) throw new Error("Verification operation was not found.");
    return { operation: this.readVerification(store, record).operation };
  }

  cancelVerification(input: LingAppServerVerifyCancelParams): LingAppServerVerifyCancelResult {
    const store = this.workspaceStore(input.cwd);
    const stored = store.getAppServerState("verify_operation", input.operationId);
    if (!stored) return { operationId: input.operationId, status: "unknown" };
    const record = this.readVerification(store, stored);
    if (record.operation.status === "unknown") return { operationId: input.operationId, status: "unknown" };
    if (!verificationInFlight(record)) {
      return { operationId: input.operationId, status: "already_terminal" };
    }
    if (!record.cancelRequested) this.updateVerification(store, stored, { ...record, cancelRequested: true });
    this.activeVerifications.get(input.operationId)?.abort();
    return { operationId: input.operationId, status: "cancel_requested" };
  }

  abortVerifications(): void {
    for (const controller of this.activeVerifications.values()) controller.abort();
  }

  async startReview(input: LingAppServerReviewStartParams): Promise<LingAppServerReviewStartResult> {
    const cwd = requireCwd(input.cwd ?? input.candidate.workspaceId);
    const store = this.storeRegistry().getStore(cwd);
    const key = input.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 200) {
      throw new HttpError(400, "invalid_params", "A review idempotency key of up to 200 characters is required.");
    }
    const rulesRefs = parseReviewRuleRefs(input.reviewRulesRefs);
    let request: CreateCodeAssessmentRequest;
    try {
      request = parseCreateCodeAssessment({
        kind: "review",
        target: assessmentTarget(input.candidate),
        providerPresetId: input.providerPresetId ?? DEFAULT_PROVIDER_PRESET,
        instructions: input.baseInstructions,
      });
    } catch (error) {
      throw new HttpError(400, "invalid_params", errorMessage(error));
    }
    const assessmentId = `assessment_app_${digest(key)}`;
    const fingerprint = digest(JSON.stringify([input.workItemId, input.candidate.candidateDigest, request, rulesRefs]));
    const prior = store.getAppServerState("review_submission", assessmentId);
    if (prior) {
      assertReviewFingerprint(prior.payload, fingerprint);
      if (this.options.activeRuns) reconcileCodeAssessments(store, this.options.activeRuns);
      return reviewStartResult(requireAssessment(store, assessmentId));
    }
    const pendingKey = JSON.stringify([cwd, assessmentId]);
    const pending = this.pendingReviews.get(pendingKey);
    if (pending) {
      assertReviewFingerprint(pending.fingerprint, fingerprint);
      return await pending.result;
    }
    if (!this.options.startCodeAssessmentRun) throw new Error("Code assessment runner is unavailable.");
    const result = startCodeAssessment(store, request, this.options.startCodeAssessmentRun, {
      assessmentId, candidateDigest: input.candidate.candidateDigest, idempotencyKey: key, fingerprint, rulesRefs,
    }).then(reviewStartResult);
    this.pendingReviews.set(pendingKey, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.pendingReviews.delete(pendingKey);
    }
  }

  getReviewStatus(input: LingAppServerReviewStatusParams): LingAppServerReviewStatusResult {
    const assessmentId = input.assessmentId ?? (input.operationId?.startsWith("review_assessment_") ? input.operationId.slice("review_".length) : undefined);
    if (!assessmentId || input.operationId && input.operationId !== `review_${assessmentId}`) {
      throw new HttpError(400, "invalid_params", "Supply an assessment ID or its matching review operation ID.");
    }
    const cwd = requireCwd(input.cwd ?? this.options.context.config.defaultWorkspaceCwd);
    const store = this.storeRegistry().getStore(cwd);
    if (this.options.activeRuns) reconcileCodeAssessments(store, this.options.activeRuns);
    const detail = requireAssessment(store, assessmentId);
    return {
      ...reviewStartResult(detail),
      revision: detail.assessment.updatedAt,
      findingIds: detail.findings.map(finding => finding.id),
      ...(detail.assessment.summary ? { summary: detail.assessment.summary } : {}),
      ...(detail.assessment.errorMessage ? { errorMessage: detail.assessment.errorMessage } : {}),
      ...(detail.assessment.reviewRules ? { reviewRules: detail.assessment.reviewRules } : {}),
    };
  }

  async updateReviewFinding(input: LingAppServerReviewFindingUpdateParams): Promise<LingAppServerReviewFindingUpdateResult> {
    const store = this.workspaceStore(input.cwd);
    const key = input.idempotencyKey;
    const closing = input.disposition === "resolved" || input.disposition === "dismissed";
    if (typeof key !== "string" || !key.trim() || key.length > 200
      || !["open", "acknowledged", "resolved", "dismissed"].includes(input.disposition)
      || input.reason !== undefined && (typeof input.reason !== "string" || input.reason.length > 2000)
      || closing && (!input.reason?.trim() || !["false_positive", "accepted_risk", "not_reproducible", "duplicate", "out_of_scope"].includes(input.closeReason ?? ""))) {
      throw new HttpError(400, "invalid_params", "Supply an idempotency key and a valid disposition. Closing a finding requires a typed reason.");
    }
    const recordId = digest(key);
    const fingerprint = digest(JSON.stringify([input.assessmentId, input.findingId, input.disposition, input.closeReason,
      input.reason?.trim(), input.expectedRevision]));
    const readReceipt = () => {
      const record = store.getAppServerState("review_finding_update", recordId);
      if (!record) return undefined;
      const payload = record.payload as { fingerprint: string; result: LingAppServerReviewFindingUpdateResult };
      assertReviewFingerprint(payload.fingerprint, fingerprint);
      return payload.result;
    };
    const prior = readReceipt();
    if (prior) return prior;
    const detail = requireAssessment(store, input.assessmentId);
    if (!detail.findings.some(item => item.id === input.findingId)) {
      throw new HttpError(404, "finding_not_found", "Code assessment finding was not found.");
    }
    assertReviewRevision(detail, input.expectedRevision);
    let freshness: { readonly state: "current"; readonly checkedAt: string } | undefined;
    if (input.disposition === "resolved") {
      const current = await captureCodeAssessmentSnapshot(store.paths.cwd, detail.snapshot.target);
      const replay = readReceipt();
      if (replay) return replay;
      if (current.digest !== detail.snapshot.digest || current.coverage !== "complete") {
        throw new HttpError(409, "candidate_stale", "Resolving a finding requires a current candidate with complete coverage.");
      }
      assertReviewRevision(requireAssessment(store, input.assessmentId), input.expectedRevision);
      freshness = { state: "current", checkedAt: current.capturedAt };
    }
    try {
      store.setCodeFindingDisposition(input.assessmentId, input.findingId, {
        snapshotDigest: detail.snapshot.digest,
        disposition: input.disposition,
        closeReason: input.closeReason,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
        verifiedCurrent: input.disposition === "resolved",
        freshness,
        submission: { recordId, idempotencyKey: key, fingerprint },
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "app_server_state_idempotency_conflict") {
        throw Object.assign(new Error("Finding update idempotency key was reused with a different request."), {
          jsonRpcCode: -32031, code: "idempotency_conflict",
        });
      }
      throw error;
    }
    return readReceipt()!;
  }

  startSimplify(input: LingAppServerSimplifyStartParams): LingAppServerSimplifyStartResult {
    return {
      operationId: `simplify_${randomUUID()}`,
      candidateDigest: input.candidate.candidateDigest,
      status: "queued",
    };
  }

  async runDoctor(input: LingAppServerDoctorRunParams = {}): Promise<LingAppServerDoctorRunResult> {
    const cwd = requireCwd(input.cwd ?? this.options.context.config.defaultWorkspaceCwd);
    const checks: Array<LingAppServerDoctorRunResult["checks"][number]> = [];
    try {
      this.storeRegistry().getStore(cwd);
      checks.push({ id: "workspace_store", category: "workspace", status: "ok", summary: "Workspace run store opened", details: `cwd: ${cwd}` });
    } catch (error) {
      checks.push({ id: "workspace_store", category: "workspace", status: "fail", summary: "Workspace run store could not be opened", details: errorMessage(error) });
    }
    const startup = this.options.context.startupState.snapshot(cwd);
    if (!startup) checks.push({ id: "startup_phases", category: "startup", status: "unchecked", summary: "No startup status recorded for this workspace yet" });
    else {
      const failed = Object.entries(startup.phases).filter(([, status]) => status === "failed" || status === "degraded").map(([phase]) => phase);
      checks.push({ id: "startup_phases", category: "startup", status: failed.length ? "warning" : "ok", summary: failed.length ? `Startup phase(s) not ready: ${failed.join(", ")}` : `Startup state: ${startup.state}` });
    }
    checks.push({ id: "feature_flags", category: "config", status: "ok", summary: "Feature configuration loaded", details: `channels.autoRoute: ${this.options.context.config.channels.autoRoute === true}` });
    if (input.scope === "project") {
      const { manifest } = await collectProjectInstructions(cwd);
      checks.push({ id: "project_instructions", category: "instructions", status: manifest.omitted.length ? "warning" : "ok",
        summary: manifest.sources.length ? "Project instruction sources discovered" : "No project instruction files found",
        details: JSON.stringify(manifest) });
    }
    return {
      doctorVersion: 1,
      cwd,
      overallStatus: checks.some(check => check.status === "fail") ? "fail" : checks.some(check => check.status === "warning") ? "warning" : "ok",
      checks,
      generatedAt: new Date().toISOString(),
    };
  }

  async initInstructions(input: LingAppServerInstructionsInitParams): Promise<LingAppServerInstructionsInitResult> {
    const cwd = requireCwd(input.cwd ?? this.options.context.config.defaultWorkspaceCwd);
    return await initializeProjectInstructions(cwd, input);
  }

  private storeRegistry(): RunStoreRegistry {
    return this.options.storeRegistry ?? this.options.context.storeRegistry;
  }

  private workspaceStore(cwd?: string): RunStore {
    return this.storeRegistry().getStore(requireCwd(cwd ?? this.options.context.config.defaultWorkspaceCwd));
  }

  private readVerification(store: RunStore, stored: AppServerStateRecord): VerifyRecord {
    const record = stored.payload as VerifyRecord;
    if (verificationInFlight(record) && !this.activeVerifications.has(stored.recordId)) {
      const recovered = finishVerification(record, "unknown", "daemon_restart_reconciliation_required");
      this.updateVerification(store, stored, recovered);
      return recovered;
    }
    return record;
  }

  private updateVerification(store: RunStore, stored: AppServerStateRecord, record: VerifyRecord): AppServerStateRecord {
    const result = store.putAppServerState({
      kind: "verify_operation", recordId: stored.recordId, expectedRevision: stored.revision, payload: record,
    }, new Date().toISOString());
    if (!result) throw new Error("Verification operation revision changed.");
    return result.record;
  }

  private async executeVerification(
    store: RunStore,
    operationId: string,
    signal: AbortSignal,
    executeCheck: NonNullable<AppServerDevelopmentOptions["executeVerificationCheck"]>,
  ): Promise<void> {
    let stored = store.getAppServerState("verify_operation", operationId)!;
    let record = stored.payload as VerifyRecord;
    record = { ...record, operation: { ...record.operation, status: "running", startedAt: new Date().toISOString() } };
    stored = this.updateVerification(store, stored, record);
    for (const check of record.plan.checks) {
      if (record.cancelRequested || signal.aborted) break;
      stored = this.updateVerification(store, stored, setCheckStatus(record, check.checkId, "running"));
      let status: LingAppServerVerificationCheckStatus;
      try {
        status = await executeCheck({ cwd: store.paths.cwd, check, candidate: record.plan.candidate, signal });
      } catch {
        status = "unknown";
      }
      stored = store.getAppServerState("verify_operation", operationId)!;
      record = setCheckStatus(stored.payload as VerifyRecord, check.checkId, status);
      stored = this.updateVerification(store, stored, record);
    }
    const statuses = record.operation.checks.map(check => check.status);
    const status = statuses.includes("unknown") ? "unknown"
      : record.cancelRequested || signal.aborted || statuses.includes("cancelled") ? "cancelled"
      : statuses.includes("failed") ? "failed"
      : statuses.every(status => status === "passed") ? "passed"
      : "blocked";
    this.updateVerification(store, stored, finishVerification(record, status));
  }
}

function verificationConflict(): Error {
  return Object.assign(new Error("Verification idempotency key was reused with a different request."), { jsonRpcCode: -32031, code: "idempotency_conflict" });
}

function verificationInFlight(record: VerifyRecord): boolean {
  return record.operation.status === "queued" || record.operation.status === "running";
}

function setCheckStatus(record: VerifyRecord, checkId: string, status: LingAppServerVerificationCheckStatus): VerifyRecord {
  const checks = record.operation.checks.map(check => check.checkId === checkId ? { ...check, status } : check);
  return { ...record, operation: { ...record.operation, checks } };
}

function finishVerification(
  record: VerifyRecord,
  status: Exclude<LingAppServerVerifyOperation["status"], "queued" | "running">,
  blocker?: string,
): VerifyRecord {
  const checks = record.operation.checks.map(check => ({
    ...check,
    status: check.status === "pending" ? "not_run" as const
      : check.status === "running" ? "unknown" as const : check.status,
  }));
  return {
    ...record,
    operation: { ...record.operation, checks, status, completedAt: new Date().toISOString(), ...(blocker ? { blocker } : {}) },
  };
}

function assessmentTarget(candidate: LingAppServerCandidateReference): CreateCodeAssessmentRequest["target"] {
  if (candidate.headCommit) return { type: "commit", commitSha: candidate.headCommit, ...(candidate.baseCommit ? { baseRef: candidate.baseCommit } : {}) };
  return { type: "working_tree" };
}

function assertReviewFingerprint(stored: unknown, expected: string): void {
  if (stored !== expected) {
    throw Object.assign(new Error("Review idempotency key was reused with a different request."), { jsonRpcCode: -32031, code: "idempotency_conflict" });
  }
}

function assertReviewRevision(detail: CodeAssessmentDetail, expected: string | undefined): void {
  if (expected !== undefined && expected !== detail.assessment.updatedAt) {
    throw Object.assign(new Error("Code assessment revision is stale."), { jsonRpcCode: -32030, code: "stale_revision" });
  }
}

function reviewStartResult(detail: CodeAssessmentDetail): LingAppServerReviewStartResult {
  return {
    operationId: `review_${detail.assessment.id}`,
    assessmentId: detail.assessment.id,
    candidateDigest: detail.snapshot.digest,
    status: assessmentStatus(detail),
  };
}

function assessmentStatus(detail: CodeAssessmentDetail): LingAppServerReviewStartResult["status"] {
  switch (detail.assessment.status) {
    case "queued": return "queued";
    case "analyzing": return "running";
    case "completed": return "completed";
    case "partial": return "partial";
    case "cancelled": return "cancelled";
    default: return "failed";
  }
}

function requireAssessment(store: RunStore, assessmentId: string): CodeAssessmentDetail {
  const detail = store.getCodeAssessment(assessmentId);
  if (!detail) throw new HttpError(404, "assessment_not_found", "Code assessment was not found.");
  return detail;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireCwd(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("cwd is required.");
  return resolve(trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function asDiagnosticsCheck(check: LingAppServerDoctorRunResult["checks"][number]): DiagnosticsCheck | undefined {
  if (check.category !== "workspace" && check.category !== "startup" && check.category !== "logs" && check.category !== "config") return undefined;
  return {
    id: check.id,
    category: check.category,
    status: check.status,
    summary: check.summary,
    ...(check.details ? { details: check.details } : {}),
    ...(check.remediation ? { remediation: check.remediation } : {}),
  };
}
