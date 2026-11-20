import { createHash, randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  DiagnosticsCheck,
  LingAppServerCandidateReference,
  LingAppServerDoctorRunParams,
  LingAppServerDoctorRunResult,
  LingAppServerInstructionsInitParams,
  LingAppServerInstructionsInitResult,
  LingAppServerInstructionSource,
  LingAppServerReviewFindingUpdateParams,
  LingAppServerReviewFindingUpdateResult,
  LingAppServerReviewStartParams,
  LingAppServerReviewStartResult,
  LingAppServerReviewStatusParams,
  LingAppServerReviewStatusResult,
  LingAppServerSimplifyStartParams,
  LingAppServerSimplifyStartResult,
  LingAppServerVerificationCheckKind,
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
import type { ActiveRunRegistry } from "../runtime/active-runs.js";
import type { RunStore } from "@ling-stack/core";
import type { RunStoreRegistry } from "../runtime/store-registry.js";
import { captureCodeAssessmentSnapshot } from "../features/code-assessments/snapshot.js";
import { startCodeAssessment, type StartCodeAssessmentRun } from "../features/code-assessments/service.js";

const DEFAULT_PROVIDER_PRESET = "default";
const DEFAULT_CHECKS: readonly { readonly id: string; readonly kind: LingAppServerVerificationCheckKind; readonly label: string; readonly command: string; readonly required: boolean }[] = [
  { id: "typecheck", kind: "typecheck", label: "Typecheck", command: "pnpm typecheck:ci", required: true },
  { id: "test", kind: "test", label: "Tests", command: "pnpm test", required: true },
];

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
    readonly signal?: AbortSignal;
  }) => Promise<LingAppServerVerificationCheckStatus>;
}

/**
 * App Server development methods share the existing code-assessment and doctor
 * owners. The RPC transport owns authorization and dispatch. This class only
 * maps typed App Server requests to those owners and keeps a bounded operation
 * projection for verification and simplify until their durable operation store
 * is connected by the daemon composition root.
 */
export class AppServerDevelopmentService {
  private readonly plans = new Map<string, LingAppServerVerifyPlanResult>();
  private readonly verifications = new Map<string, VerifyRecord>();

  constructor(private readonly options: AppServerDevelopmentOptions) {}

  async planVerification(input: LingAppServerVerifyPlanParams): Promise<LingAppServerVerifyPlanResult> {
    const candidate = normalizeCandidate(input.candidate);
    const requested = input.requestedChecks?.length ? input.requestedChecks : DEFAULT_CHECKS.map(check => check.id);
    const checks = requested.map((id) => {
      const known = DEFAULT_CHECKS.find(check => check.id === id);
      const kind = known?.kind ?? inferCheckKind(id);
      const label = known?.label ?? id;
      const command = known?.command ?? id;
      return {
        checkId: id,
        kind,
        label,
        command,
        recipeDigest: digest(JSON.stringify({ id, kind, command, candidateDigest: candidate.candidateDigest })),
        verifierBasisRef: input.planRevision,
        required: known?.required ?? false,
      } satisfies LingAppServerVerificationCheckPlan;
    });
    const plan: LingAppServerVerifyPlanResult = {
      planId: `verify_plan_${randomUUID()}`,
      planRevision: digest(JSON.stringify({ candidate, checks, requested: input.requestedChecks ?? [] })),
      candidate,
      checks,
      rationale: ["Selected deterministic workspace checks for the candidate."],
      environmentRequirements: ["workspace_store", "authorized_host_execution"],
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  async startVerification(input: LingAppServerVerifyStartParams): Promise<LingAppServerVerifyOperation> {
    const plan = this.plans.get(input.planId);
    if (!plan || plan.planRevision !== input.planRevision || plan.candidate.candidateDigest !== input.candidateDigest) {
      throw new Error("Verification plan is stale or unavailable.");
    }
    const operationId = `verify_${randomUUID()}`;
    const operation: LingAppServerVerifyOperation = {
      operationId,
      planId: plan.planId,
      candidateDigest: plan.candidate.candidateDigest,
      status: "queued",
      checks: plan.checks.map(check => ({
        checkId: check.checkId,
        candidateDigest: plan.candidate.candidateDigest,
        planRevision: plan.planRevision,
        recipeDigest: check.recipeDigest,
        environmentDigest: digest(JSON.stringify({ cwd: plan.candidate.workspaceId, check: check.checkId })),
        ...(check.verifierBasisRef ? { verifierBasisRef: check.verifierBasisRef } : {}),
        producerRefs: [],
        attemptId: `verify_attempt_${randomUUID()}`,
        status: "pending",
        evidenceRefs: [],
      })),
    };
    this.verifications.set(operationId, { operation, plan, cancelRequested: false });
    void this.executeVerification(operationId, input.idempotencyKey);
    return operation;
  }

  getVerification(input: LingAppServerVerifyStatusParams): LingAppServerVerifyStatusResult {
    const record = this.verifications.get(input.operationId);
    if (!record) throw new Error("Verification operation was not found.");
    return { operation: record.operation };
  }

  cancelVerification(input: LingAppServerVerifyCancelParams): LingAppServerVerifyCancelResult {
    const record = this.verifications.get(input.operationId);
    if (!record) return { operationId: input.operationId, status: "unknown" };
    if (["passed", "failed", "blocked", "cancelled", "unknown"].includes(record.operation.status)) {
      return { operationId: input.operationId, status: "already_terminal" };
    }
    this.verifications.set(input.operationId, {
      ...record,
      cancelRequested: true,
      operation: { ...record.operation, status: "cancelled", completedAt: new Date().toISOString() },
    });
    return { operationId: input.operationId, status: "cancelled" };
  }

  async startReview(input: LingAppServerReviewStartParams): Promise<LingAppServerReviewStartResult> {
    const cwd = requireCwd(input.cwd ?? input.candidate.workspaceId);
    const store = this.storeRegistry().getStore(cwd);
    const target = assessmentTarget(input.candidate);
    const request: CreateCodeAssessmentRequest = {
      kind: "review",
      target,
      providerPresetId: input.providerPresetId ?? DEFAULT_PROVIDER_PRESET,
      ...(input.baseInstructions || input.reviewRulesRefs?.length ? {
        instructions: [input.baseInstructions, ...(input.reviewRulesRefs ?? []).map(ref => `Review rule: ${ref}`)].filter(Boolean).join("\n"),
      } : {}),
    };
    if (!this.options.startCodeAssessmentRun) throw new Error("Code assessment runner is unavailable.");
    const detail = await startCodeAssessment(store, request, this.options.startCodeAssessmentRun);
    return {
      operationId: detail.assessment.runId ? `review_${detail.assessment.runId}` : `review_${detail.assessment.id}`,
      assessmentId: detail.assessment.id,
      candidateDigest: input.candidate.candidateDigest,
      status: assessmentStatus(detail),
    };
  }

  getReviewStatus(input: LingAppServerReviewStatusParams): LingAppServerReviewStatusResult {
    if (!input.assessmentId) throw new Error("assessmentId is required.");
    const cwd = this.options.context.config.defaultWorkspaceCwd;
    const detail = this.storeRegistry().getStore(cwd).getCodeAssessment(input.assessmentId);
    if (!detail) throw new Error("Code assessment was not found.");
    return {
      operationId: input.operationId ?? `review_${detail.assessment.runId ?? detail.assessment.id}`,
      assessmentId: detail.assessment.id,
      candidateDigest: detail.snapshot.digest,
      status: assessmentStatus(detail),
      findingIds: detail.findings.map(finding => finding.id),
      ...(detail.assessment.summary ? { summary: detail.assessment.summary } : {}),
    };
  }

  async updateReviewFinding(input: LingAppServerReviewFindingUpdateParams): Promise<LingAppServerReviewFindingUpdateResult> {
    const store = this.storeRegistry().getStore(this.options.context.config.defaultWorkspaceCwd);
    const detail = requireAssessment(store, input.assessmentId);
    const finding = detail.findings.find(item => item.id === input.findingId);
    if (!finding) throw new Error("Code assessment finding was not found.");
    if (input.expectedRevision && input.expectedRevision !== detail.assessment.updatedAt) throw new Error("Code assessment revision is stale.");
    if (input.disposition === "resolved") {
      const current = await captureCodeAssessmentSnapshot(store.paths.cwd, detail.snapshot.target);
      if (current.digest !== detail.snapshot.digest) throw new Error("Resolving a finding requires a current candidate snapshot.");
    }
    const updated = store.setCodeFindingDisposition(input.assessmentId, input.findingId, {
      snapshotDigest: detail.snapshot.digest,
      disposition: input.disposition,
      reason: input.reason,
      now: new Date().toISOString(),
    });
    return {
      assessmentId: input.assessmentId,
      findingId: input.findingId,
      revision: updated.dispositionReason ?? new Date().toISOString(),
      disposition: updated.disposition,
    };
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
    const taskPath = input.taskPath ? resolve(cwd, input.taskPath) : cwd;
    if (!taskPath.startsWith(`${cwd}/`) && taskPath !== cwd) throw new Error("taskPath must stay inside the workspace.");
    const paths = await instructionPaths(cwd, taskPath);
    const sources: LingAppServerInstructionSource[] = [];
    for (const path of paths) {
      try {
        const content = await readFile(path, "utf8");
        sources.push({ path: relative(cwd, path) || basename(path), digest: digest(content), scope: relative(cwd, dirname(path)) || ".", applicable: true });
      } catch {
        // Discovery is best effort. Missing optional files are not a conflict.
      }
    }
    const proposalId = `instructions_${randomUUID()}`;
    const conflicts = input.mode === "apply" && input.expectedWorkspaceRevision === undefined
      ? ["apply requires expectedWorkspaceRevision"]
      : [];
    return {
      proposalId,
      status: conflicts.length ? "blocked" : input.mode === "apply" ? "applied" : "draft",
      sources,
      ...(input.mode === "apply" && !conflicts.length ? { workspaceRevision: digest(sources.map(source => `${source.path}:${source.digest}`).join("\n")) } : {}),
      conflicts,
    };
  }

  private storeRegistry(): RunStoreRegistry {
    return this.options.storeRegistry ?? this.options.context.storeRegistry;
  }

  private async executeVerification(operationId: string, _idempotencyKey: string): Promise<void> {
    const record = this.verifications.get(operationId);
    if (!record || !this.options.executeVerificationCheck) return;
    this.verifications.set(operationId, { ...record, operation: { ...record.operation, status: "running", startedAt: new Date().toISOString() } });
    let failed = false;
    const checks = [...record.operation.checks];
    for (let index = 0; index < checks.length; index++) {
      const current = this.verifications.get(operationId);
      if (!current || current.cancelRequested) return;
      const planCheck = record.plan.checks[index]!;
      const status = await this.options.executeVerificationCheck({ cwd: record.plan.candidate.workspaceId, check: planCheck, candidate: record.plan.candidate });
      checks[index] = { ...checks[index]!, status };
      failed ||= status === "failed" || status === "unknown";
      this.verifications.set(operationId, { ...current, operation: { ...current.operation, checks: [...checks] } });
    }
    const current = this.verifications.get(operationId);
    if (!current) return;
    this.verifications.set(operationId, { ...current, operation: { ...current.operation, status: failed ? "failed" : "passed", completedAt: new Date().toISOString() } });
  }
}

function normalizeCandidate(candidate: LingAppServerCandidateReference): LingAppServerCandidateReference {
  return { ...candidate, workspaceId: requireCwd(candidate.workspaceId) };
}

function assessmentTarget(candidate: LingAppServerCandidateReference): CreateCodeAssessmentRequest["target"] {
  if (candidate.headCommit) return { type: "commit", commitSha: candidate.headCommit, ...(candidate.baseCommit ? { baseRef: candidate.baseCommit } : {}) };
  return { type: "working_tree" };
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
  if (!detail) throw new Error("Code assessment was not found.");
  return detail;
}

function inferCheckKind(id: string): LingAppServerVerificationCheckKind {
  if (/type|tsc|compile/u.test(id)) return "typecheck";
  if (/browser|playwright|e2e/u.test(id)) return "browser";
  if (/platform|ios|macos|android/u.test(id)) return "platform";
  if (/test|spec|vitest|jest/u.test(id)) return "test";
  return "command";
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

async function instructionPaths(cwd: string, taskPath: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const root = resolve(cwd);
  let current = resolve(taskPath);
  while (current === root || current.startsWith(`${root}/`)) {
    for (const name of ["AGENTS.md", "CLAUDE.md", ".ling/AGENTS.md"]) {
      const path = join(current, name);
      try { await access(path); paths.push(path); } catch { /* optional source */ }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return paths.reverse();
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
