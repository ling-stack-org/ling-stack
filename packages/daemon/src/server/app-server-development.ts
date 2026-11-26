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
  LingAppServerSimplificationSuggestion,
  LingAppServerSimplifyStartParams,
  LingAppServerSimplifyStartResult,
  LingAppServerSimplifyStatusParams,
  LingAppServerSimplifyStatusResult,
  LingAppServerVerifyCancelParams,
  LingAppServerVerifyCancelResult,
  LingAppServerVerifyPlanParams,
  LingAppServerVerifyPlanResult,
  LingAppServerVerifyStartParams,
  LingAppServerVerifyStatusParams,
  LingAppServerVerifyStatusResult,
  LingAppServerVerifyOperation,
  StartWorkspaceVerificationRequest,
  WorkspaceVerificationReport,
  CreateCodeAssessmentRequest,
  CodeAssessmentDetail,
} from "@ling-stack/contracts";
import type { DaemonContext } from "../context.js";
import { HttpError } from "../errors.js";
import type { ActiveRunRegistry } from "../runtime/active-runs.js";
import { DEFAULT_WORKSPACE_ID, type AppServerStateRecord, type PutAppServerStateResult, type RunStore, type WorkItemConversationBinding } from "@ling-stack/core";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { reconcileCodeAssessments, startCodeAssessment, type StartCodeAssessmentRun } from "../features/code-assessments/service.js";
import { parseReviewRuleRefs } from "../features/code-assessments/review-rules.js";
import { executeAppServerVerificationCheck, verificationRecipePlan, verificationRecipes, type AppServerVerificationCheckResult } from "./app-server-verification-recipes.js";
import type { AppServerVerificationRecipeConfig } from "./app-server-verification-config.js";
import { collectProjectInstructions } from "../features/conversations/project-instructions.js";
import { initializeProjectInstructions } from "../features/conversations/project-instructions-draft.js";
import { trimOversizedEvent } from "../features/control-plane/events.js";
import { isRecord } from "../shared/validation.js";
import { captureAppServerChanges } from "./app-server-changes.js";

const DEFAULT_PROVIDER_PRESET = "default";
type VerifyRecord = {
  readonly operation: LingAppServerVerifyOperation;
  readonly plan: LingAppServerVerifyPlanResult;
  readonly cancelRequested: boolean;
  readonly cancellation?: { readonly key: string; readonly expectedRevision?: string };
};

export interface AppServerDevelopmentOptions {
  readonly context: DaemonContext;
  readonly storeRegistry?: RunStoreRegistry;
  readonly activeRuns?: ActiveRunRegistry;
  readonly startCodeAssessmentRun?: StartCodeAssessmentRun;
  /** Host-owned verification execution. It must use the normal daemon authority. */
  readonly executeVerificationCheck?: (input: {
    readonly cwd: string;
    readonly check: LingAppServerVerifyPlanResult["checks"][number];
    readonly candidate: LingAppServerCandidateReference;
    readonly recipes?: readonly AppServerVerificationRecipeConfig[];
    readonly signal: AbortSignal;
  }) => Promise<AppServerVerificationCheckResult | AppServerVerificationCheckResult["status"]>;
}

/** Coordinates durable verification state and delegates code assessment to its Run owner. */
export class AppServerDevelopmentService {
  private readonly pendingReviews = new Map<string, { fingerprint: string; result: Promise<CodeAssessmentDetail> }>();
  private readonly activeVerifications = new Map<string, AbortController>();

  constructor(private readonly options: AppServerDevelopmentOptions) {}

  async planVerification(input: LingAppServerVerifyPlanParams): Promise<LingAppServerVerifyPlanResult> {
    if (!isRecord(input.candidate) || typeof input.candidate.workspaceId !== "string"
      || typeof input.candidate.candidateDigest !== "string" || !input.candidate.candidateDigest.trim()
      || input.candidate.candidateDigest.length > 200
      || input.requestedChecks !== undefined && (!Array.isArray(input.requestedChecks) || input.requestedChecks.length > 64
        || input.requestedChecks.some(id => typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(id)))
      || [input.workItemId, input.threadId, input.planRevision].some(value =>
        value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 256))) {
      throw new HttpError(400, "invalid_params", "Supply a candidate and valid verification scope and check IDs.");
    }
    if (input.idempotencyKey !== undefined) assertVerificationKey(input.idempotencyKey);
    const cwd = requireCwd(input.cwd ?? input.candidate.workspaceId);
    const store = this.storeRegistry().getStore(cwd);
    const workItem = input.workItemId ? store.getWorkItem(input.workItemId) : undefined;
    if (input.workItemId && !workItem || input.threadId && !store.getLingThread(input.threadId)) {
      throw new HttpError(404, "verification_scope_not_found", "Verification scope is outside this workspace.");
    }
    if (workItem?.planRevision && input.planRevision && workItem.planRevision !== input.planRevision) {
      throw Object.assign(new Error("The accepted Work Item plan changed."), { jsonRpcCode: -32030, code: "stale_revision" });
    }
    const acceptedPlanRevision = workItem?.planRevision ?? input.planRevision;
    const candidateWorkspace = store.paths.cwd;
    const configured = this.verificationRecipes(cwd);
    let paths: readonly string[] | undefined;
    if (configured.length && !input.requestedChecks?.length) {
      const snapshot = await captureCodeAssessmentSnapshot(cwd, { type: "working_tree" });
      if (snapshot.coverage !== "complete" || snapshot.digest !== input.candidate.candidateDigest) {
        throw new HttpError(409, "candidate_stale", "Verification planning requires a current candidate with complete coverage.");
      }
      paths = snapshot.files.flatMap(file => file.originalPath ? [file.path, file.originalPath] : [file.path]);
    }
    const candidate = { ...input.candidate, workspaceId: candidateWorkspace, ...(paths ? { filePaths: [...new Set(paths)] } : {}) };
    const checks = verificationRecipes(input.requestedChecks, configured, paths)
      .map(recipe => verificationRecipePlan(recipe, candidate.candidateDigest));
    const plan: LingAppServerVerifyPlanResult = {
      planId: `verify_plan_${randomUUID()}`,
      planRevision: digest(JSON.stringify({ candidate, checks, acceptedPlanRevision, threadId: input.threadId, workItemId: input.workItemId })),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(acceptedPlanRevision ? { acceptedPlanRevision } : {}),
      candidate,
      checks,
      rationale: [paths ? "Selected Host-registered checks using the captured diff." : "Selected registered checks for the candidate."],
      environmentRequirements: ["workspace_store", "authorized_host_execution"],
    };
    const result = store.putAppServerState({
      kind: "verify_plan", recordId: plan.planId, expectedRevision: 0, payload: plan,
      idempotencyKey: input.idempotencyKey, replayByIdempotencyKey: true,
    }, new Date().toISOString());
    const retained = result?.record.payload as LingAppServerVerifyPlanResult | undefined;
    if (!retained || retained.planRevision !== plan.planRevision) throw verificationConflict();
    return retained;
  }

  async startVerification(input: LingAppServerVerifyStartParams): Promise<LingAppServerVerifyOperation> {
    const store = this.workspaceStore(input.cwd);
    const plan = store.getAppServerState("verify_plan", input.planId)?.payload as LingAppServerVerifyPlanResult | undefined;
    if (!plan || plan.planRevision !== input.planRevision || plan.candidate.candidateDigest !== input.candidateDigest) {
      throw Object.assign(new Error("Verification plan is stale or unavailable."), { jsonRpcCode: -32030, code: "stale_revision" });
    }
    assertVerificationKey(input.idempotencyKey);
    const existing = store.findAppServerStateByIdempotencyKey("verify_operation", input.idempotencyKey);
    if (existing) {
      assertVerificationPlan(existing, plan);
      return this.readVerification(store, existing).operation;
    }
    if (plan.workItemId) {
      const workItem = store.getWorkItem(plan.workItemId);
      if (!workItem || workItem.control.state !== "active" || workItem.holds.some(hold => hold.blocksNewAdmission)) {
        throw Object.assign(new Error("The Work Item is not admitting verification."), { jsonRpcCode: -32061, code: "resume_blocked" });
      }
      if (workItem.planRevision && workItem.planRevision !== plan.acceptedPlanRevision) {
        throw Object.assign(new Error("The accepted Work Item plan changed."), { jsonRpcCode: -32030, code: "stale_revision" });
      }
    }
    if (plan.threadId) {
      const thread = store.getLingThread(plan.threadId);
      if (!thread || thread.status === "archived") {
        throw Object.assign(new Error("The Thread is not admitting verification."), { jsonRpcCode: -32061, code: "resume_blocked" });
      }
    }
    const operationId = `verify_${randomUUID()}`;
    const queued = Boolean(this.options.executeVerificationCheck);
    const operation: LingAppServerVerifyOperation = {
      operationId,
      revision: "1",
      planId: plan.planId,
      ...(plan.threadId ? { threadId: plan.threadId } : {}),
      ...(plan.workItemId ? { workItemId: plan.workItemId } : {}),
      candidateDigest: plan.candidate.candidateDigest,
      status: queued ? "queued" : "blocked",
      ...(queued ? {} : { blocker: "verification_executor_unavailable", completedAt: new Date().toISOString() }),
      checks: plan.checks.map(check => ({
        checkId: check.checkId,
        candidateDigest: plan.candidate.candidateDigest,
        planRevision: plan.planRevision,
        recipeDigest: check.recipeDigest,
        environmentDigest: digest(JSON.stringify({ cwd: plan.candidate.workspaceId, check: check.checkId })),
        producerRefs: [],
        attemptId: `verify_attempt_${randomUUID()}`,
        status: queued ? "pending" : "not_run",
        evidenceRefs: [],
      })),
    };
    const payload: VerifyRecord = { operation, plan, cancelRequested: false };
    const saved = this.persistVerification(store, 0, payload, input.idempotencyKey);
    if (saved.status === "replayed") {
      return assertVerificationPlan(saved.record, plan).operation;
    }
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

  async readWorkspaceVerification(cwd: string, filters: { readonly operationId?: string; readonly threadId?: string }): Promise<WorkspaceVerificationReport> {
    const store = this.workspaceStore(cwd);
    const record = filters.operationId ? store.getAppServerState("verify_operation", filters.operationId) : store.getLatestVerificationState(filters.threadId);
    if (!record && filters.operationId) throw new HttpError(404, "verification_not_found", "The verification operation was not found.");
    if (!record) return { cwd, operation: null, plan: null };
    const { operation, plan } = this.readVerification(store, record);
    if (filters.threadId && operation.threadId !== filters.threadId) {
      throw new HttpError(404, "verification_not_found", "The verification operation was not found in this Thread.");
    }
    if (!operation.completedAt) return { cwd, operation, plan };
    const current = await captureAppServerChanges(cwd).catch(() => undefined);
    const candidateState = current?.coverage === "complete"
      ? current.candidate.candidateDigest === operation.candidateDigest ? "current" : "changed"
      : "unavailable";
    return { cwd, operation, plan, candidateState };
  }

  async startWorkspaceVerification(cwd: string, input: StartWorkspaceVerificationRequest): Promise<WorkspaceVerificationReport> {
    assertVerificationKey(input.idempotencyKey);
    const store = this.workspaceStore(cwd);
    const keyDigest = digest(input.idempotencyKey);
    const planKey = `workspace_verify_plan:${keyDigest}`;
    const operationKey = `workspace_verify:${keyDigest}`;
    const retained = store.findAppServerStateByIdempotencyKey("verify_plan", planKey);
    let plan: LingAppServerVerifyPlanResult;
    if (retained) {
      plan = retained.payload as LingAppServerVerifyPlanResult;
      if (plan.threadId !== input.threadId) throw verificationConflict();
    } else {
      const candidate = await captureAppServerChanges(cwd);
      if (candidate.coverage !== "complete") {
        throw new HttpError(409, "candidate_incomplete", "Verification requires a candidate with complete coverage.");
      }
      const binding = input.threadId ? store.getAppServerState("work_item_thread", input.threadId)?.payload as WorkItemConversationBinding | undefined : undefined;
      plan = await this.planVerification({ cwd, candidate: candidate.candidate, threadId: input.threadId,
        workItemId: binding?.workItemId, idempotencyKey: planKey });
    }
    const operation = await this.startVerification({ cwd, planId: plan.planId, planRevision: plan.planRevision,
      candidateDigest: plan.candidate.candidateDigest, idempotencyKey: operationKey });
    return operation.completedAt
      ? this.readWorkspaceVerification(cwd, { operationId: operation.operationId, threadId: input.threadId })
      : { cwd, operation, plan };
  }

  cancelVerification(input: LingAppServerVerifyCancelParams): LingAppServerVerifyCancelResult {
    assertVerificationKey(input.idempotencyKey);
    const store = this.workspaceStore(input.cwd);
    const stored = store.getAppServerState("verify_operation", input.operationId);
    if (!stored) return { operationId: input.operationId, status: "unknown" };
    const record = this.readVerification(store, stored);
    if (record.cancellation?.key === input.idempotencyKey) {
      if (record.cancellation.expectedRevision !== input.expectedRevision) throw verificationConflict();
      return { operationId: input.operationId, status: "cancel_requested" };
    }
    if (input.expectedRevision !== undefined && input.expectedRevision !== record.operation.revision) {
      throw Object.assign(new Error("Verification operation revision is stale."), { jsonRpcCode: -32030, code: "stale_revision" });
    }
    if (record.operation.status === "unknown") return { operationId: input.operationId, status: "unknown" };
    if (!verificationInFlight(record)) {
      return { operationId: input.operationId, status: "already_terminal" };
    }
    if (record.cancellation) {
      throw Object.assign(new Error("A cancellation request is already recorded."), { jsonRpcCode: -32051, code: "request_already_resolved" });
    }
    this.updateVerification(store, stored, { ...record, cancelRequested: true,
      cancellation: { key: input.idempotencyKey, expectedRevision: input.expectedRevision } });
    this.activeVerifications.get(input.operationId)?.abort();
    return { operationId: input.operationId, status: "cancel_requested" };
  }

  abortVerifications(): void {
    for (const controller of this.activeVerifications.values()) controller.abort();
  }

  async startReview(input: LingAppServerReviewStartParams): Promise<LingAppServerReviewStartResult> {
    return reviewStartResult(await this.startReviewAssessment(input));
  }

  private async startReviewAssessment(
    input: LingAppServerReviewStartParams,
    reviewFocus?: CodeAssessmentDetail["assessment"]["reviewFocus"],
  ): Promise<CodeAssessmentDetail> {
    if (!isRecord(input.candidate) || typeof input.candidate.workspaceId !== "string"
      || typeof input.candidate.candidateDigest !== "string" || !input.candidate.candidateDigest.trim()) {
      throw new HttpError(400, "invalid_params", "Supply a code assessment candidate and its digest.");
    }
    const cwd = requireCwd(input.cwd ?? input.candidate.workspaceId);
    const store = this.storeRegistry().getStore(cwd);
    const key = input.idempotencyKey;
    if (typeof key !== "string" || !key.trim() || key.length > 200) {
      throw new HttpError(400, "invalid_params", "A review idempotency key of up to 200 characters is required.");
    }
    if ([input.workItemId, input.planRevision].some(value => value !== undefined
      && (typeof value !== "string" || !value.trim() || value.length > 256))
      || input.planRevision !== undefined && input.workItemId === undefined) {
      throw new HttpError(400, "invalid_params", "Supply a valid Work Item and its accepted Plan revision.");
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
    const kind = reviewFocus === "simplification" ? "simplify_submission" : "review_submission";
    const assessmentId = `assessment_app_${reviewFocus === "simplification" ? "simplify_" : ""}${digest(key)}`;
    const fingerprint = digest(JSON.stringify([input.workItemId, input.candidate.candidateDigest, request, rulesRefs,
      ...(input.planRevision !== undefined ? [input.planRevision] : [])]));
    const prior = store.getAppServerState(kind, assessmentId);
    if (prior) {
      assertReviewFingerprint(prior.payload, fingerprint);
      if (this.options.activeRuns) reconcileCodeAssessments(store, this.options.activeRuns);
      return requireAssessment(store, assessmentId);
    }
    const pendingKey = JSON.stringify([cwd, assessmentId]);
    const pending = this.pendingReviews.get(pendingKey);
    if (pending) {
      assertReviewFingerprint(pending.fingerprint, fingerprint);
      return await pending.result;
    }
    const item = input.workItemId ? store.getWorkItem(input.workItemId) : undefined;
    if (input.workItemId && !item) throw new HttpError(404, "review_scope_not_found", "The Work Item is unavailable.");
    const workItem = item ? { workItemId: item.id, acceptedPlanRevision: item.planRevision,
      controlGeneration: item.control.generation } : undefined;
    if (input.planRevision !== undefined && input.planRevision !== workItem?.acceptedPlanRevision) {
      throw new HttpError(409, "stale_revision", "The accepted Work Item Plan changed.");
    }
    const assertCurrent = workItem && (() => {
      const current = store.getWorkItem(workItem.workItemId);
      if (!current || current.planRevision !== workItem.acceptedPlanRevision || current.control.generation !== workItem.controlGeneration) {
        throw new HttpError(409, "stale_revision", "The Work Item or its accepted Plan changed.");
      }
      if (current.control.state !== "active" || current.holds.some(hold => hold.blocksNewAdmission)
        || ["done", "cancelled", "archived", "superseded"].includes(current.status)) {
        throw new HttpError(409, "resume_blocked", "The Work Item is not admitting a new review.");
      }
    });
    assertCurrent?.();
    if (!this.options.startCodeAssessmentRun) throw new Error("Code assessment runner is unavailable.");
    const result = startCodeAssessment(store, request, this.options.startCodeAssessmentRun, {
      assessmentId, candidateDigest: input.candidate.candidateDigest, idempotencyKey: key, fingerprint, rulesRefs, reviewFocus, workItem, assertCurrent,
    });
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
    let expectedRevision = input.expectedRevision;
    let freshness: { readonly state: "current"; readonly checkedAt: string } | undefined;
    if (input.disposition === "resolved") {
      expectedRevision ??= detail.assessment.updatedAt;
      const current = await captureCodeAssessmentSnapshot(store.paths.cwd, detail.snapshot.target);
      const replay = readReceipt();
      if (replay) return replay;
      if (current.digest !== detail.snapshot.digest || current.coverage !== "complete") {
        throw new HttpError(409, "candidate_stale", "Resolving a finding requires a current candidate with complete coverage.");
      }
      assertReviewRevision(requireAssessment(store, input.assessmentId), expectedRevision);
      freshness = { state: "current", checkedAt: current.capturedAt };
    }
    try {
      store.setCodeFindingDisposition(input.assessmentId, input.findingId, {
        snapshotDigest: detail.snapshot.digest,
        disposition: input.disposition,
        closeReason: input.closeReason,
        reason: input.reason,
        expectedRevision,
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

  async startSimplify(input: LingAppServerSimplifyStartParams): Promise<LingAppServerSimplifyStartResult> {
    const { cwd, candidate, workItemId, providerPresetId, idempotencyKey } = input;
    return simplifyStartResult(await this.startReviewAssessment({ cwd, candidate, workItemId, providerPresetId, idempotencyKey }, "simplification"));
  }

  getSimplifyStatus(input: LingAppServerSimplifyStatusParams): LingAppServerSimplifyStatusResult {
    if (typeof input.operationId !== "string" || !/^simplify_assessment_app_simplify_[a-f0-9]{64}$/u.test(input.operationId)) {
      throw new HttpError(400, "invalid_params", "Supply a simplification operation ID.");
    }
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HttpError(400, "invalid_params", "The suggestion offset must be a non-negative integer.");
    }
    const store = this.workspaceStore(input.cwd);
    if (this.options.activeRuns) reconcileCodeAssessments(store, this.options.activeRuns);
    const detail = requireAssessment(store, input.operationId.slice("simplify_".length));
    const suggestions: LingAppServerSimplificationSuggestion[] = [];
    // Leave room in the outbound frame for the summary and RPC envelope.
    let remainingBytes = 64 * 1024;
    for (const { id, title, body, path, side, startLine, endLine, evidence } of detail.findings.slice(offset)) {
      const suggestion = { id, title, body, path, side, startLine, endLine, evidence };
      const bytes = Buffer.byteLength(JSON.stringify(suggestion), "utf8") + 1;
      if (bytes > remainingBytes) break;
      remainingBytes -= bytes;
      suggestions.push(suggestion);
    }
    const nextOffset = offset + suggestions.length;
    return {
      ...simplifyStartResult(detail),
      revision: detail.assessment.updatedAt,
      ...(detail.assessment.summary ? { summary: detail.assessment.summary } : {}),
      ...(detail.assessment.errorMessage ? { errorMessage: detail.assessment.errorMessage } : {}),
      suggestions,
      ...(nextOffset < detail.findings.length ? { nextOffset } : {}),
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
      const { claudeProjectRules } = this.storeRegistry().getStore(cwd).getWorkspaceSettings();
      const { manifest } = await collectProjectInstructions(cwd, [], { claudeProjectRules });
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
      return this.updateVerification(store, stored, recovered).payload as VerifyRecord;
    }
    return { ...record, operation: { ...record.operation, revision: String(stored.revision) } };
  }

  private persistVerification(store: RunStore, expectedRevision: number, record: VerifyRecord, idempotencyKey?: string): PutAppServerStateResult {
    const operation = { ...record.operation, revision: String(expectedRevision + 1) };
    const result = store.putAppServerState({
      kind: "verify_operation", recordId: operation.operationId, expectedRevision,
      payload: { ...record, operation }, idempotencyKey, replayByIdempotencyKey: Boolean(idempotencyKey),
    }, new Date().toISOString(), {
      workspaceId: DEFAULT_WORKSPACE_ID, cwd: store.paths.cwd, domain: operation.workItemId ? "work_items" : "runs",
      entityType: "verify_operation", entityId: operation.operationId, action: "verification.updated",
      idempotencyKey: "app-server-verify:" + operation.operationId + ":" + operation.revision,
      data: {
        operationId: operation.operationId, planId: operation.planId, candidateDigest: operation.candidateDigest,
        threadId: operation.threadId, workItemId: operation.workItemId, revision: operation.revision,
        status: operation.status, cancelRequested: record.cancelRequested, blocker: operation.blocker,
        checks: operation.checks.map(({ checkId, status }) => ({ checkId, status })),
      },
    });
    if (!result) throw Object.assign(new Error("Verification operation revision is stale."), { jsonRpcCode: -32030, code: "stale_revision" });
    if (result.event) this.options.context.controlPlaneEvents?.publish(trimOversizedEvent(result.event));
    return result;
  }

  private updateVerification(store: RunStore, stored: AppServerStateRecord, record: VerifyRecord): AppServerStateRecord {
    return this.persistVerification(store, stored.revision, record).record;
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
      stored = this.updateVerification(store, stored, setCheckResult(record, check.checkId, { status: "running" }));
      let result: AppServerVerificationCheckResult;
      try {
        const checked = await executeCheck({
          cwd: store.paths.cwd, check, candidate: record.plan.candidate, recipes: this.verificationRecipes(store.paths.cwd), signal,
        });
        result = typeof checked === "string" ? { status: checked } : checked;
      } catch {
        result = { status: "unknown" };
      }
      stored = store.getAppServerState("verify_operation", operationId)!;
      record = stored.payload as VerifyRecord;
      record = setCheckResult(record, check.checkId, result);
      stored = this.updateVerification(store, stored, record);
      if (record.cancelRequested || signal.aborted) break;
    }
    const statuses = record.operation.checks.map(check => check.status);
    const stopRequested = record.cancelRequested || signal.aborted;
    const status = statuses.includes("unknown") ? "unknown"
      : stopRequested || statuses.includes("cancelled") ? "cancelled"
      : statuses.includes("failed") ? "failed"
      : statuses.every(status => status === "passed") ? "passed"
      : "blocked";
    const blocker = status === "unknown" && stopRequested ? "verification_cancellation_unconfirmed" : undefined;
    this.updateVerification(store, stored, finishVerification(record, status, blocker));
  }

  private verificationRecipes(cwd: string): readonly AppServerVerificationRecipeConfig[] {
    return (this.options.context.config.appServerVerificationRecipes ?? []).filter(recipe => recipe.workspaceRoot === cwd);
  }
}

const developmentByContext = new WeakMap<DaemonContext, AppServerDevelopmentService>();

export function getAppServerDevelopmentService(context: DaemonContext): AppServerDevelopmentService {
  const existing = developmentByContext.get(context);
  if (existing) return existing;
  const service = new AppServerDevelopmentService({
    context,
    activeRuns: context.activeRuns,
    startCodeAssessmentRun: context.startCodeAssessmentRun,
    executeVerificationCheck: executeAppServerVerificationCheck,
  });
  developmentByContext.set(context, service);
  return service;
}

function assertVerificationPlan(stored: AppServerStateRecord, plan: LingAppServerVerifyPlanResult): VerifyRecord {
  const record = stored.payload as VerifyRecord;
  if (record.plan.planId !== plan.planId || record.plan.planRevision !== plan.planRevision) throw verificationConflict();
  return record;
}

function verificationConflict(): Error {
  return Object.assign(new Error("Verification idempotency key was reused with a different request."), { jsonRpcCode: -32031, code: "idempotency_conflict" });
}

function assertVerificationKey(key: unknown): void {
  if (typeof key !== "string" || !key.trim() || key.length > 200 || /[\r\n]/u.test(key)) {
    throw new HttpError(400, "invalid_params", "Supply a verification idempotency key of up to 200 characters.");
  }
}

function verificationInFlight(record: VerifyRecord): boolean {
  return record.operation.status === "queued" || record.operation.status === "running";
}

function setCheckResult(record: VerifyRecord, checkId: string, result: AppServerVerificationCheckResult): VerifyRecord {
  const { verifier, ...outcome } = result;
  const checks = record.operation.checks.map(check => check.checkId === checkId ? { ...check, ...outcome, ...verifier } : check);
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
    throw Object.assign(new Error("Code assessment idempotency key was reused with a different request."), { jsonRpcCode: -32031, code: "idempotency_conflict" });
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
    ...(detail.assessment.workItem ? { workItem: detail.assessment.workItem } : {}),
  };
}

function simplifyStartResult(detail: CodeAssessmentDetail): LingAppServerSimplifyStartResult {
  return {
    operationId: `simplify_${detail.assessment.id}`,
    candidateDigest: detail.snapshot.digest,
    status: assessmentStatus(detail),
    ...(detail.assessment.reportArtifactId ? { suggestionArtifactId: detail.assessment.reportArtifactId } : {}),
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

export function abortAppServerVerifications(context: DaemonContext): void {
  developmentByContext.get(context)?.abortVerifications();
}
