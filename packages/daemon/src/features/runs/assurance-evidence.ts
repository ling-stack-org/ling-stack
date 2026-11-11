import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type {
  FrameworkAssuranceAdmissionEvidence,
  FrameworkAssuranceArtifactPin,
  FrameworkAssuranceBudgetEvidence,
  FrameworkAssuranceBudgetStatus,
  FrameworkAssuranceClaimStatus,
  FrameworkAssuranceCompletionEvidence,
  FrameworkAssuranceCompletionIssue,
  FrameworkAssuranceCompletionStep,
  FrameworkAssuranceEffectStatus,
  FrameworkAssuranceEvidenceResponse,
  FrameworkAssuranceIsolationEvidence,
  FrameworkAssuranceLifecycleEvidence,
  FrameworkAssuranceStopEffectStatus,
  FrameworkAssuranceStopExecutionStatus,
} from "@ling-stack/contracts";
import {
  createSqliteWorkflowIntegrationCoordinatorStore,
  createSqliteWorkflowIsolationStore,
  createSqliteWorkflowMergeApprovalStore,
  createSqliteWorkflowMergeApplyStore,
  isWorkflowStepSafetyPlanV1,
  toRuntimeAttemptFence,
  workflowIsolationDigest,
  workflowIsolationStepSafetyFingerprint,
  type DelegationBudgetCharge,
  type DelegationBudgetReservation,
  type DelegationCompletionEvidenceV1,
  type RunSession,
  type RunStore,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkflowIntegrationCoordinatorEffect,
  type WorkflowIntegrationRound,
  type WorkflowIsolationReceipt,
} from "@ling-stack/core";
import type { ActiveRunRegistry } from "../../runtime/active-runs.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readWorkUnitStopEvidence } from "../../runtime/work-unit-stop-evidence.js";
import { writeJson } from "../../shared/response.js";
import { isRecord } from "../../shared/validation.js";
import { isPrivateHostRecoveryArtifact } from "./public-artifacts.js";
import { harnessToolBrokerModeForRun } from "../harness/tool-execution/broker.js";

const TERMINAL_ATTEMPT_STATUSES = new Set<WorkUnitAttempt["status"]>(["succeeded", "failed", "cancelled", "lost"]);
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * Expose only Host facts needed to bind a live assurance observation. The route
 * resolves an already-open Store so reading evidence cannot trigger startup
 * recovery, create a Store, or dispatch a Run.
 */
export function handleGetRunAssuranceEvidence(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): void {
  let store: RunStore | undefined;
  try {
    store = storeRegistry.findInitializedStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  } catch {
    writeJson(response, 503, { error: "assurance_evidence_unavailable", message: "Live assurance evidence is unavailable." });
    return;
  }
  if (!store) {
    writeJson(response, 503, { error: "assurance_evidence_unavailable", message: "Live assurance evidence requires an initialized workspace Store." });
    return;
  }

  try {
    const evidence = store.readSnapshot(() => readRunAssuranceEvidence(store!, activeRuns, runId));
    writeJson(response, 200, evidence);
  } catch (error) {
    const code = error instanceof AssuranceEvidenceError ? error.code : "assurance_evidence_unavailable";
    const status = error instanceof AssuranceEvidenceError && error.statusCode ? error.statusCode : 409;
    writeJson(response, status, { error: code, message: error instanceof AssuranceEvidenceError ? error.message : "Live assurance evidence is unavailable." });
  }
}

export function readRunAssuranceEvidence(store: RunStore, activeRuns: ActiveRunRegistry, runId: string): FrameworkAssuranceEvidenceResponse {
  const run = store.getRun(runId);
  if (!run) throw new AssuranceEvidenceError("run_not_found", "Run was not found.", 404);
  if (!run.workUnitId) throw new AssuranceEvidenceError("assurance_lineage_incomplete", "Run has no WorkUnit lineage.");
  const workUnit = store.getWorkUnit(run.workUnitId);
  if (!workUnit) throw new AssuranceEvidenceError("assurance_lineage_incomplete", "Run and WorkUnit lineage is incomplete.");
  if (workUnit.linkedRunId !== run.id) throw new AssuranceEvidenceError("assurance_lineage_mismatch", "Run and WorkUnit lineage does not match.");

  const attempts = store.listWorkUnitAttempts(workUnit.id);
  const attempt = selectAttempt(workUnit, attempts);
  if (!attempt) throw new AssuranceEvidenceError("assurance_attempt_missing", "WorkUnit has no Attempt lineage.");
  if (attempt.workUnitId !== workUnit.id) throw new AssuranceEvidenceError("assurance_lineage_mismatch", "Attempt lineage does not match the WorkUnit.");

  const runtimeEvents = store.listRuntimeEvents(workUnit.id, { limit: 1000 });
  const stop = readWorkUnitStopEvidence(store, workUnit, attempts, activeRuns);
  const stopByAttempt = new Map(stop.attempts.map(value => [value.attemptId, value]));
  const artifacts = store.listArtifacts(run.id)
    .filter(artifact => !isPrivateHostRecoveryArtifact(artifact))
    .filter((artifact): artifact is typeof artifact & { readonly contentSha256: string } => typeof artifact.contentSha256 === "string")
    .map((artifact, index): FrameworkAssuranceArtifactPin => ({
      role: `${artifact.type}-${index}`,
      artifactId: artifact.id,
      contentSha256: artifact.contentSha256,
    }));
  if (artifacts.length === 0) throw new AssuranceEvidenceError("assurance_artifact_unsealed", "Live assurance requires at least one sealed artifact digest.");

  const observedAt = new Date().toISOString();
  const effectStatus = effectStatusFor(attempt, stopByAttempt.get(attempt.id)?.effects);
  const completionEvidence = store.getDelegationCompletionEvidence({ rootRunIds: [run.id] });
  const completion = buildCompletion(completionEvidence);
  const budget = projectDelegationBudgetEvidence(completionEvidence, run.id);
  const isolation = buildIsolation(store, run, attempt, observedAt);
  const lifecycle = buildLifecycle(workUnit, attempts, stop.attempts);
  const claimStatus = claimStatusFor(workUnit, attempt);
  const admission = buildAdmission(run, isolation, lifecycle, effectStatus, completion, budget,
    { claimStatus, workUnitStatus: workUnit.status, attemptStatus: attempt.status });
  return {
    schemaVersion: 1,
    kind: "live_execution_evidence",
    comparison: {
      model: run.providerModel,
      reasoning: readReasoning(run.requestSnapshot),
      executionStrategy: attempt.effectiveRunnerId,
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    },
    execution: {
      ...toRuntimeAttemptFence(attempt),
      runId: run.id,
      runStatus: run.status,
      workUnitStatus: workUnit.status,
      attemptStatus: attempt.status,
      claimStatus,
      effectStatus,
    },
    snapshots: {
      run: { revision: store.countEvents(run.id), sha256: recordDigest(run) },
      workUnit: { revision: runtimeEvents.at(-1)?.seq ?? 0, sha256: recordDigest(workUnit) },
      attempt: { revision: runtimeEvents.filter(event => event.attemptId === attempt.id).at(-1)?.seq ?? 0, sha256: recordDigest(attempt) },
    },
    artifacts,
    lifecycle,
    completion,
    budget,
    isolation,
    admission,
    observedAt,
    limitations: [
      "read_only_host_projection",
      "no_task_input",
      "no_artifact_body",
      "no_evaluation_grade",
      "snapshot_digest_is_authoritative",
      "budget_and_merge_payloads_digest_only",
      ...(runtimeEvents.length >= 1000 ? ["runtime_event_revision_page_bounded"] : []),
      ...(effectStatus === "unknown" ? ["effect_stop_not_confirmed"] : []),
      ...(budget.status === "unknown" ? ["budget_usage_unknown"] : []),
      ...(isolation.status === "blocked" ? ["workflow_isolation_admission_blocked"] : []),
    ],
  };
}

function buildLifecycle(
  workUnit: WorkUnit,
  attempts: readonly WorkUnitAttempt[],
  stopAttempts: readonly {
    readonly attemptId: string;
    readonly localExecution: FrameworkAssuranceStopExecutionStatus;
    readonly effects: FrameworkAssuranceStopEffectStatus;
  }[],
): FrameworkAssuranceLifecycleEvidence {
  const stopByAttempt = new Map(stopAttempts.map(value => [value.attemptId, value]));
  const currentAttemptId = workUnit.activeAttemptId ?? attempts.at(-1)?.id;
  const current = attempts.find(value => value.id === currentAttemptId) ?? attempts.at(-1);
  if (!current) throw new AssuranceEvidenceError("assurance_attempt_missing", "WorkUnit has no Attempt lineage.");
  const projected = attempts.map(value => {
    const stop = stopByAttempt.get(value.id);
    return {
      attemptId: value.id,
      attemptNumber: value.attemptNumber,
      runtimeInstanceId: value.runtimeInstanceId,
      fencingToken: value.fencingToken,
      status: value.status,
      isCurrent: value.id === current.id,
      abortRequestedAt: value.abortRequestedAt ?? null,
      endedAt: value.endedAt ?? null,
      localExecution: stop?.localExecution ?? "unverified" as const,
      effects: stop?.effects ?? "unverified" as const,
    };
  });
  const localExecution = aggregateLocalExecution(projected.map(value => value.localExecution));
  const effects = aggregateEffects(projected.map(value => value.effects));
  const allAttemptsTerminal = projected.every(value => TERMINAL_ATTEMPT_STATUSES.has(value.status));
  const reusable = allAttemptsTerminal && localExecution === "drained" && effects === "settled";
  const status = workUnit.status === "cancelling" || current.status === "cancelling" ? "cancelling"
    : !TERMINAL_ATTEMPT_STATUSES.has(current.status) ? localExecution === "draining" ? "draining" : "active"
      : effects === "unverified" || effects === "unknown" || localExecution === "unverified" ? "unverified"
        : localExecution === "draining" ? "draining" : reusable ? "drained" : "terminal";
  return {
    status,
    currentAttemptId: current.id,
    currentGeneration: current.attemptNumber,
    attemptCount: projected.length,
    oldAttemptCount: projected.filter(value => !value.isCurrent).length,
    attempts: projected,
    stop: { localExecution, effects, allAttemptsTerminal, reusable },
  };
}

function buildCompletion(evidence: DelegationCompletionEvidenceV1): FrameworkAssuranceCompletionEvidence {
  const issues: FrameworkAssuranceCompletionIssue[] = evidence.issues.map(issue => ({
    code: issue.code,
    stepId: issue.stepId ?? null,
    runId: issue.runId ?? null,
    factFingerprint: issue.factFingerprint ?? null,
  }));
  const steps: FrameworkAssuranceCompletionStep[] = evidence.steps.map(read => {
    const hasIssue = issues.some(issue => issue.stepId === read.step.id);
    const terminal = TERMINAL_RUN_STATUSES.has(read.step.state);
    const completionStatus: FrameworkAssuranceCompletionStep["completionStatus"] = hasIssue ? "invalid"
      : !terminal ? "pending"
        : read.hostCompletion?.drainedAt && read.hostCompletion.effectCoverage && read.quiescence === "verified"
          && (read.reservation?.state === "settled" || read.reservation?.state === "released") ? "verified"
          : read.hostCompletion || read.reservation ? "pending" : "missing";
    return {
      stepId: read.step.id,
      required: read.step.required,
      state: read.step.state,
      childRunId: read.childRun?.id ?? null,
      attemptId: read.attempt?.sourceFence.attemptId ?? null,
      reservationState: read.reservation?.state ?? null,
      completionStatus,
      resultArtifacts: uniqueArtifactPins(read.results.map((result, index) => ({
        role: `delegation-result-${read.step.id}-${index}`,
        artifactId: result.artifactId,
        contentSha256: result.artifactContentSha256 ?? result.artifactPayloadSha256 ?? result.artifactFingerprint ?? "",
      })).filter(value => value.contentSha256.length > 0)),
    };
  });
  const resultArtifacts = uniqueArtifactPins(steps.flatMap(step => step.resultArtifacts));
  return {
    status: evidence.steps.length === 0 ? "not_applicable" : evidence.status,
    rootRunIds: evidence.rootRunIds,
    fingerprint: evidence.steps.length === 0 ? null : evidence.fingerprint,
    stepCount: steps.length,
    requiredStepCount: steps.filter(step => step.required).length,
    completedStepCount: steps.filter(step => step.completionStatus === "verified").length,
    steps,
    issues,
    resultArtifacts,
  };
}

interface UsageSummary {
  readonly tokens: bigint;
  readonly costMicros: bigint;
  readonly costKnown: boolean;
  readonly closed: boolean;
  readonly unknown: boolean;
  readonly invalid: boolean;
}

export function projectDelegationBudgetEvidence(evidence: DelegationCompletionEvidenceV1, runId: string): FrameworkAssuranceBudgetEvidence {
  if (evidence.steps.length === 0) {
    return {
      status: "not_applicable", roots: [], reservations: [], charges: [],
      usage: { tokenStatus: "not_applicable", costStatus: "not_applicable", tokens: null, costMicros: null, tokenLimit: null, costLimitMicros: null },
      issues: [], blockers: [],
    };
  }
  const roots = evidence.roots.map(root => ({
    runId: root.runId,
    present: Boolean(root.budget),
    tokenBudget: root.budget?.tokenBudget ?? null,
    costBudgetMicros: root.budget?.costBudgetMicros ?? null,
    deadlineAt: root.budget?.deadlineAt ?? null,
    chargeCount: root.charges.length,
  }));
  const reservations = uniqueById(evidence.steps.flatMap(step => step.reservation ? [step.reservation] : []));
  const charges = uniqueById([...evidence.roots.flatMap(root => root.charges), ...evidence.steps.flatMap(step => step.charges)]);
  const root = evidence.roots.find(value => value.runId === runId) ?? evidence.roots[0];
  const rootBudget = root?.budget;
  const reservationByParent = new Map<string | undefined, DelegationBudgetReservation[]>();
  for (const reservation of reservations) {
    const values = reservationByParent.get(reservation.parentReservationId) ?? [];
    values.push(reservation);
    reservationByParent.set(reservation.parentReservationId, values);
  }
  const chargesByReservation = new Map<string | undefined, DelegationBudgetCharge[]>();
  for (const charge of charges) {
    const values = chargesByReservation.get(charge.reservationId) ?? [];
    values.push(charge);
    chargesByReservation.set(charge.reservationId, values);
  }
  const visiting = new Set<string>();
  const sum = (parentReservationId: string | undefined): UsageSummary => {
    let tokens = 0n, costMicros = 0n, costKnown = true, closed = true, unknown = false, invalid = false;
    for (const charge of chargesByReservation.get(parentReservationId) ?? []) {
      if (charge.state === "cancelled_before_dispatch") continue;
      if (charge.state === "measured") {
        if (charge.inputTokens === undefined || charge.outputTokens === undefined) {
          invalid = true; closed = false; unknown = true; continue;
        }
        tokens += BigInt(charge.inputTokens + charge.outputTokens);
        if (charge.actualCostMicros === undefined) costKnown = false;
        else costMicros += BigInt(charge.actualCostMicros);
        continue;
      }
      tokens += BigInt(charge.reservedTokens ?? 0);
      if (charge.reservedCostMicros === undefined) costKnown = false;
      else costMicros += BigInt(charge.reservedCostMicros);
      closed = false;
      if (charge.state === "unresolved") unknown = true;
    }
    for (const reservation of reservationByParent.get(parentReservationId) ?? []) {
      if (reservation.state === "released") continue;
      if (visiting.has(reservation.id)) {
        invalid = true; unknown = true; closed = false; continue;
      }
      visiting.add(reservation.id);
      const child = sum(reservation.id);
      visiting.delete(reservation.id);
      if (reservation.state === "settled") {
        if (reservation.settledTokenUsage === undefined) {
          invalid = true; unknown = true; closed = false;
        } else tokens += BigInt(reservation.settledTokenUsage);
        if (reservation.settledCostMicros === undefined) costKnown = false;
        else costMicros += BigInt(reservation.settledCostMicros);
        costKnown &&= child.costKnown;
        invalid ||= child.invalid;
        unknown ||= child.unknown;
        closed &&= child.closed;
      } else {
        tokens += maxBigInt(child.tokens, BigInt(reservation.tokenReserved ?? 0));
        if (reservation.costReservedMicros === undefined) costKnown = false;
        else costMicros += maxBigInt(child.costMicros, BigInt(reservation.costReservedMicros));
        costKnown &&= child.costKnown && reservation.costReservedMicros !== undefined;
        closed = false;
        unknown ||= child.unknown || reservation.state === "unresolved";
        invalid ||= child.invalid;
      }
    }
    return { tokens, costMicros, costKnown, closed, unknown, invalid };
  };
  const usage = rootBudget ? sum(undefined) : { tokens: 0n, costMicros: 0n, costKnown: false, closed: false, unknown: true, invalid: false };
  const issueCodes = [...new Set(evidence.issues.map(issue => issue.code))].sort();
  const invalid = usage.invalid || issueCodes.some(code => ["delegation.completion_lineage_invalid", "delegation.completion_fact_invalid", "delegation.completion_usage_invalid"].includes(code));
  const missing = !rootBudget;
  const tokenStatus = dimensionStatus({ missing, invalid, unknown: usage.unknown, closed: usage.closed, value: usage.tokens, limit: rootBudget?.tokenBudget });
  const costStatus = dimensionStatus({ missing, invalid, unknown: usage.unknown || !usage.costKnown, closed: usage.closed, value: usage.costMicros, limit: rootBudget?.costBudgetMicros });
  const status: FrameworkAssuranceBudgetStatus = missing ? "missing"
    : invalid ? "invalid"
      : tokenStatus === "over" || costStatus === "over" ? "over"
        : tokenStatus === "unknown" || costStatus === "unknown" ? "unknown"
          : tokenStatus === "pending" || costStatus === "pending" ? "pending" : "within";
  const blockers: string[] = [...issueCodes];
  if (missing) blockers.push("delegation.completion_budget_missing");
  if (status === "unknown") blockers.push("delegation.usage_unknown");
  if (status === "pending") blockers.push("delegation.budget_pending");
  if (status === "over") blockers.push("delegation.budget_exceeded");
  return {
    status,
    roots,
    reservations: reservations.map(reservation => ({
      reservationId: reservation.id,
      stepId: reservation.delegationStepId,
      state: reservation.state,
      tokenReserved: reservation.tokenReserved ?? null,
      costReservedMicros: reservation.costReservedMicros ?? null,
      settledTokenUsage: reservation.settledTokenUsage ?? null,
      settledCostMicros: reservation.settledCostMicros ?? null,
      failureCode: reservation.failureCode ?? null,
    })),
    charges: charges.map(charge => ({
      chargeId: charge.id,
      reservationId: charge.reservationId ?? null,
      runId: charge.runId,
      attemptId: charge.attemptId,
      state: charge.state,
      reservedTokens: charge.reservedTokens ?? null,
      reservedCostMicros: charge.reservedCostMicros ?? null,
      inputTokens: charge.inputTokens ?? null,
      cachedInputTokens: charge.cachedInputTokens ?? null,
      outputTokens: charge.outputTokens ?? null,
      actualCostMicros: charge.actualCostMicros ?? null,
    })),
    usage: {
      tokenStatus,
      costStatus,
      tokens: usage.unknown || usage.invalid ? null : safeNumber(usage.tokens),
      costMicros: usage.unknown || usage.invalid || !usage.costKnown ? null : safeNumber(usage.costMicros),
      tokenLimit: rootBudget?.tokenBudget ?? null,
      costLimitMicros: rootBudget?.costBudgetMicros ?? null,
    },
    issues: issueCodes,
    blockers: [...new Set(blockers)],
  };
}

function dimensionStatus(input: {
  readonly missing: boolean;
  readonly invalid: boolean;
  readonly unknown: boolean;
  readonly closed: boolean;
  readonly value: bigint;
  readonly limit: number | undefined;
}): FrameworkAssuranceBudgetEvidence["usage"]["tokenStatus"] {
  if (input.missing) return "missing";
  if (input.invalid) return "invalid";
  if (input.limit !== undefined && input.value > BigInt(input.limit)) return "over";
  if (input.unknown) return "unknown";
  if (!input.closed) return "pending";
  return "within";
}

function buildIsolation(store: RunStore, run: RunSession, attempt: WorkUnitAttempt, now: string): FrameworkAssuranceIsolationEvidence {
  const step = run.workflowStepId ? store.getChannelWorkflowStep(run.workflowStepId) : undefined;
  const safety = step?.metadata?.safetyPlan;
  const requested = Boolean(step?.metadata?.isolationScopePlan || safety?.profile === "pi_host_isolated_files_v1"
    || step?.metadata?.sideEffectClass === "workspace_write");
  if (!requested) return emptyIsolation("not_applicable");
  const workflowId = step?.workflowId ?? null;
  const base = emptyIsolation("unavailable", workflowId, step?.id ?? null);
  const blockers: string[] = [];
  if (!step || !workflowId) {
    blockers.push("workflow_isolation.workflow_owner_missing");
    return { ...base, status: "blocked", blockers };
  }
  const safetyPlan = {
    present: safety !== undefined,
    valid: isWorkflowStepSafetyPlanV1(safety),
    profile: typeof safety?.profile === "string" ? safety.profile : null,
    digest: typeof safety?.digest === "string" ? safety.digest : null,
    toolsCount: Array.isArray(safety?.tools) ? safety.tools.length : 0,
    writeRootsCount: Array.isArray(safety?.writeRoots) ? safety.writeRoots.length : 0,
    networkAccess: safety?.networkAccess === false || safety?.networkAccess === "session_policy" ? safety.networkAccess : null,
  } as FrameworkAssuranceIsolationEvidence["safetyPlan"];
  if (!safetyPlan.valid || safetyPlan.profile !== "pi_host_isolated_files_v1") blockers.push("workflow_isolation.safety_plan_invalid");

  try {
    const isolation = createSqliteWorkflowIsolationStore(store);
    const coordinator = createSqliteWorkflowIntegrationCoordinatorStore(store);
    const approvalStore = createSqliteWorkflowMergeApprovalStore(store);
    const applyStore = createSqliteWorkflowMergeApplyStore(store);
    const pin = step.metadata?.isolationScopePlan;
    const plan = pin ? isolation.getScopePlan(pin.planId) : undefined;
    if (!pin || !plan) blockers.push("workflow_isolation.scope_plan_missing");
    else if (plan.planDigest !== pin.planDigest || plan.workflowId !== workflowId || plan.workflowStepId !== step.id)
      blockers.push("workflow_isolation.scope_plan_mismatch");
    else if (plan.safetyFingerprint !== workflowIsolationStepSafetyFingerprint(step))
      blockers.push("workflow_isolation.safety_plan_digest_mismatch");
    const bindingId = workflowIsolationDigest({ runId: run.id, ...toRuntimeAttemptFence(attempt) }, "wib_");
    const binding = isolation.getExecutionBinding(bindingId);
    let bindingStatus: FrameworkAssuranceIsolationEvidence["binding"]["status"] = "missing";
    let matchesCurrentFence = false;
    if (binding) {
      matchesCurrentFence = binding.runId === run.id
        && sameJson(binding.fence, toRuntimeAttemptFence(attempt))
        && (!plan || binding.planDigest === plan.planDigest);
      try {
        const asserted = isolation.assertExecutionBinding({ writer: { bindingId, ...toRuntimeAttemptFence(attempt) }, now, requireReady: false });
        bindingStatus = asserted.status === "current" ? "current" : asserted.status;
      } catch {
        bindingStatus = "invalid";
      }
      if (!matchesCurrentFence) blockers.push("workflow_isolation.binding_fence_mismatch");
    } else blockers.push("workflow_isolation.binding_missing");
    const rounds = coordinator.listRounds(workflowId);
    const selection = isolation.getSelection(workflowId);
    if (selection && selection.profile !== "pi_host_isolated_files_v1") blockers.push("workflow_isolation.selection_invalid");
    const roundId = selection?.roundId ?? plan?.integrationRoundId;
    const round = roundId ? rounds.find(value => value.roundId === roundId) : undefined;
    if (!round) blockers.push("workflow_isolation.round_missing");
    else if (round.inputs.parallelExecution && !selection) blockers.push("workflow_isolation.selection_missing");
    const effects = round ? coordinator.listEffects({ roundId: round.roundId, generation: round.generation }) : [];
    const receipts = round ? coordinator.listReceipts({ roundId: round.roundId, generation: round.generation }) : [];
    for (const effect of effects) if (effect.status !== "confirmed") blockers.push(`workflow_isolation.effect_${effect.status}`);
    const branchResults = round ? readBranchResults(store, isolation, round) : [];
    if (round) {
      if (!round.candidate) blockers.push("workflow_merge.candidate_missing");
      if (branchResults.some(result => result.status !== "confirmed")) blockers.push("workflow_merge.branch_result_unconfirmed");
      if (round.candidate && !workflowCandidateBranchDigestsMatch(round.candidate.branchResultDigests,
        branchResults.map(result => result.packetDigest))) {
        blockers.push("workflow_merge.candidate_branch_results_mismatch");
      }
    }
    const approval = readApproval(approvalStore, round?.outstandingApprovalId, now);
    const apply = readApply(applyStore, approval.approvalId, now);
    const terminalBindingRetained = bindingStatus === "stale" && matchesCurrentFence
      && round?.phase === "applied" && apply.status === "applied"
      && TERMINAL_RUN_STATUSES.has(run.status) && ["succeeded", "failed", "cancelled", "stale"].includes(run.workUnitId ? store.getWorkUnit(run.workUnitId)?.status ?? "" : "")
      && TERMINAL_ATTEMPT_STATUSES.has(attempt.status);
    if (bindingStatus !== "current" && !terminalBindingRetained) blockers.push(`workflow_isolation.binding_${bindingStatus}`);
    const requiresApply = round?.inputs.mode === "apply_to_target";
    if (requiresApply && approval.status === "not_requested") blockers.push("workflow_merge.approval_missing");
    if (approval.status === "pending" || approval.status === "blocked" || approval.status === "invalid"
      || approval.status === "denied" || approval.status === "expired" || approval.status === "cancelled") {
      blockers.push(`workflow_merge.approval_${approval.status}`);
    }
    if (requiresApply && approval.status === "approved" && apply.status === "not_started") blockers.push("workflow_merge.apply_not_started");
    if (requiresApply && (apply.status === "pending" || apply.status === "effect_unknown" || apply.status === "invalid" || apply.status === "blocked")) {
      blockers.push(`workflow_merge.apply_${apply.status}`);
    }
    if (round?.reason) blockers.push(round.reason);
    const hardBlocker = blockers.length > 0;
    const status: FrameworkAssuranceIsolationEvidence["status"] = hardBlocker ? "blocked"
      : !round || !binding || !matchesCurrentFence ? "pending" : "verified";
    return {
      status,
      workflowId,
      workflowStepId: step.id,
      selection: selection ? { profile: selection.profile, roundId: selection.roundId, phase: selection.phase } : null,
      safetyPlan,
      binding: {
        status: binding ? bindingStatus : "missing",
        bindingId: binding?.bindingId ?? null,
        revision: binding?.revision ?? null,
        planDigest: binding?.planDigest ?? plan?.planDigest ?? pin?.planDigest ?? null,
        matchesCurrentFence,
      },
      round: round ? {
        roundId: round.roundId,
        generation: round.generation,
        revision: round.revision,
        phase: round.phase,
        lastConfirmedPhase: round.lastConfirmedPhase,
        candidate: round.candidate ? {
          commit: round.candidate.commit,
          tree: round.candidate.tree,
          packetDigest: round.candidate.packetDigest,
          branchResultDigests: round.candidate.branchResultDigests,
          validationDigest: round.candidate.validationDigest,
        } : null,
      } : null,
      history: rounds.map(value => ({ roundId: value.roundId, generation: value.generation, revision: value.revision,
        phase: value.phase, reason: value.reason ?? null })),
      effects: effects.map(projectEffect),
      receipts: receipts.map(receipt => projectReceipt(store, receipt)),
      branchResults,
      approval,
      apply,
      blockers: [...new Set(blockers)],
    };
  } catch {
    blockers.push("workflow_isolation.projection_unavailable");
    return { ...base, status: "unavailable", safetyPlan, blockers };
  }
}

export function workflowCandidateBranchDigestsMatch(candidate: readonly string[], branchResults: readonly (string | null)[]): boolean {
  return candidate.length > 0 && candidate.length === branchResults.length
    && sameJson([...candidate].sort(), [...branchResults].sort());
}

export function buildAdmission(
  run: RunSession,
  isolation: FrameworkAssuranceIsolationEvidence,
  lifecycle: FrameworkAssuranceLifecycleEvidence,
  effectStatus: FrameworkAssuranceEffectStatus,
  completion: FrameworkAssuranceCompletionEvidence,
  budget: FrameworkAssuranceBudgetEvidence,
  ownership: Pick<FrameworkAssuranceEvidenceResponse["execution"], "claimStatus" | "workUnitStatus" | "attemptStatus">,
): FrameworkAssuranceAdmissionEvidence {
  if (isolation.status === "not_applicable") return {
    status: "not_applicable", profile: null,
    safetyPlan: { present: false, valid: false, digest: null },
    toolBroker: { mode: harnessToolBrokerModeForRun(run), required: false, satisfies: true },
    binding: { status: "not_applicable", matchesCurrentFence: false }, blockers: [],
  };
  const profile = isolation.safetyPlan.profile;
  const mode = harnessToolBrokerModeForRun(run);
  const blockers = [...isolation.blockers, ...completion.issues.map(issue => issue.code), ...budget.blockers];
  if (!TERMINAL_RUN_STATUSES.has(run.status)) blockers.push("workflow_admission.run_not_terminal");
  if (!TERMINAL_RUN_STATUSES.has(ownership.workUnitStatus)) blockers.push("workflow_admission.work_unit_not_terminal");
  if (ownership.claimStatus !== "terminal_retained" || !TERMINAL_RUN_STATUSES.has(ownership.attemptStatus)) {
    blockers.push("workflow_admission.terminal_claim_not_retained");
  }
  if (completion.status !== "satisfied" && completion.status !== "not_applicable") {
    blockers.push("workflow_admission.delegation_completion_not_satisfied");
  }
  if (budget.status !== "within" && budget.status !== "not_applicable") {
    blockers.push("workflow_admission.delegation_budget_not_within");
  }
  if (!isolation.safetyPlan.present) blockers.push("workflow_admission.safety_plan_missing");
  if (!isolation.safetyPlan.valid || profile !== "pi_host_isolated_files_v1") blockers.push("workflow_admission.isolated_profile_required");
  if (mode !== "enforce") blockers.push("workflow_admission.tool_broker_enforce_required");
  if (isolation.binding.status !== "current" || !isolation.binding.matchesCurrentFence) blockers.push("workflow_admission.execution_binding_invalid");
  if (isolation.status !== "verified") blockers.push("workflow_admission.isolation_not_verified");
  if (lifecycle.status !== "drained") blockers.push("workflow_admission.lifecycle_not_drained");
  if (!lifecycle.stop.allAttemptsTerminal) {
    blockers.push("workflow_admission.attempt_not_terminal");
  }
  if (lifecycle.stop.localExecution !== "drained") blockers.push("workflow_admission.local_execution_not_drained");
  if (lifecycle.stop.effects !== "settled" || effectStatus !== "confirmed" || !lifecycle.stop.reusable) {
    blockers.push("workflow_admission.execution_effects_unconfirmed");
  }
  const unique = [...new Set(blockers)];
  return {
    status: unique.length === 0 ? "verified" : isolation.status === "unavailable" ? "unavailable" : "blocked",
    profile,
    safetyPlan: { present: isolation.safetyPlan.present, valid: isolation.safetyPlan.valid, digest: isolation.safetyPlan.digest },
    toolBroker: { mode, required: true, satisfies: mode === "enforce" },
    binding: { status: isolation.binding.status, matchesCurrentFence: isolation.binding.matchesCurrentFence },
    blockers: unique,
  };
}

function readApproval(store: ReturnType<typeof createSqliteWorkflowMergeApprovalStore>, approvalId: string | undefined, now: string): FrameworkAssuranceIsolationEvidence["approval"] {
  if (!approvalId) return { status: "not_requested", approvalId: null, requestId: null, authorityDigest: null, basisFingerprint: null };
  try {
    const inspected = store.inspectApproval({ approvalId, now });
    if ("code" in inspected) return { status: inspected.status, approvalId, requestId: null, authorityDigest: null, basisFingerprint: null };
    return { status: inspected.status, approvalId: inspected.approval.id, requestId: inspected.request.requestId,
      authorityDigest: inspected.request.payload.authorityDigest, basisFingerprint: inspected.request.payload.fingerprint };
  } catch {
    return { status: "invalid", approvalId, requestId: null, authorityDigest: null, basisFingerprint: null };
  }
}

function readApply(store: ReturnType<typeof createSqliteWorkflowMergeApplyStore>, approvalId: string | null, now: string): FrameworkAssuranceIsolationEvidence["apply"] {
  if (!approvalId) return { status: "not_started", code: null, intentPresent: false };
  try {
    const inspected = store.inspectApplication({ approvalId, now });
    if (inspected.status === "invalid") return { status: "invalid", code: inspected.code, intentPresent: false };
    return { status: inspected.status, code: "code" in inspected ? inspected.code ?? null : null, intentPresent: Boolean(inspected.permit) };
  } catch {
    return { status: "invalid", code: "workflow_merge.apply_evidence_unverified", intentPresent: false };
  }
}

function readBranchResults(store: RunStore, isolation: ReturnType<typeof createSqliteWorkflowIsolationStore>, round: WorkflowIntegrationRound) {
  return round.inputs.participants.map(participant => {
    const step = store.getChannelWorkflowStep(participant.workflowStepId);
    const run = step?.runId ? store.getRun(step.runId) : undefined;
    const workUnit = run?.workUnitId ? store.getWorkUnit(run.workUnitId) : undefined;
    const attempt = workUnit ? selectAttempt(workUnit, store.listWorkUnitAttempts(workUnit.id)) : undefined;
    const bindingId = run && attempt ? workflowIsolationDigest({ runId: run.id, ...toRuntimeAttemptFence(attempt) }, "wib_") : undefined;
    const intent = bindingId ? isolation.getTerminalResultIntent(bindingId) : undefined;
    return {
      workflowStepId: participant.workflowStepId,
      status: intent?.status ?? "missing",
      packetDigest: intent?.packetDigest ?? null,
      packetContentSha256: intent?.packetContentSha256 ?? null,
    };
  });
}

function projectEffect(effect: WorkflowIntegrationCoordinatorEffect) {
  return { effectKey: effect.effectKey, kind: effect.kind, status: effect.status, digest: effect.digest,
    beforeDigest: workflowIsolationDigest(effect.before), afterDigest: workflowIsolationDigest(effect.after),
    payloadContentSha256: effect.payloadContentSha256 };
}

function projectReceipt(store: RunStore, receipt: WorkflowIsolationReceipt) {
  return { receiptId: receipt.receiptId, intentId: receipt.intentId, outcome: receipt.outcome,
    observedDigest: workflowIsolationDigest(receipt.observed), artifactId: receipt.artifactId,
    artifactContentSha256: store.getArtifact(receipt.artifactId)?.contentSha256 ?? "" };
}

function emptyIsolation(status: FrameworkAssuranceIsolationEvidence["status"], workflowId: string | null = null, workflowStepId: string | null = null): FrameworkAssuranceIsolationEvidence {
  return {
    status, workflowId, workflowStepId, selection: null,
    safetyPlan: { present: false, valid: false, profile: null, digest: null, toolsCount: 0, writeRootsCount: 0, networkAccess: null },
    binding: { status: "not_checked", bindingId: null, revision: null, planDigest: null, matchesCurrentFence: false },
    round: null, history: [], effects: [], receipts: [], branchResults: [],
    approval: { status: "not_requested", approvalId: null, requestId: null, authorityDigest: null, basisFingerprint: null },
    apply: { status: "not_started", code: null, intentPresent: false }, blockers: [],
  };
}

function selectAttempt(workUnit: WorkUnit, attempts: readonly WorkUnitAttempt[]): WorkUnitAttempt | undefined {
  if (workUnit.activeAttemptId) return attempts.find(attempt => attempt.id === workUnit.activeAttemptId);
  return attempts.at(-1);
}

function claimStatusFor(workUnit: WorkUnit, attempt: WorkUnitAttempt): FrameworkAssuranceClaimStatus {
  if (attempt.status === "lost") return "expired";
  if (workUnit.activeAttemptId === attempt.id) return TERMINAL_ATTEMPT_STATUSES.has(attempt.status) ? "terminal_retained" : "held";
  return "unclaimed";
}

function effectStatusFor(attempt: WorkUnitAttempt, effects: FrameworkAssuranceStopEffectStatus | undefined): FrameworkAssuranceEffectStatus {
  if (!TERMINAL_ATTEMPT_STATUSES.has(attempt.status)) return "none";
  return effects === "settled" ? "confirmed" : "unknown";
}

function aggregateLocalExecution(values: readonly FrameworkAssuranceStopExecutionStatus[]): FrameworkAssuranceStopExecutionStatus {
  if (values.some(value => value === "unverified")) return "unverified";
  if (values.some(value => value === "draining")) return "draining";
  return "drained";
}

function aggregateEffects(values: readonly FrameworkAssuranceStopEffectStatus[]): FrameworkAssuranceStopEffectStatus {
  if (values.some(value => value === "unknown")) return "unknown";
  if (values.some(value => value === "unverified")) return "unverified";
  if (values.some(value => value === "pending")) return "pending";
  return "settled";
}

function uniqueArtifactPins(values: readonly FrameworkAssuranceArtifactPin[]): FrameworkAssuranceArtifactPin[] {
  const byId = new Map<string, FrameworkAssuranceArtifactPin>();
  for (const value of values) if (!byId.has(value.artifactId)) byId.set(value.artifactId, value);
  return [...byId.values()];
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const value of values) if (!byId.has(value.id)) byId.set(value.id, value);
  return [...byId.values()];
}

function maxBigInt(left: bigint, right: bigint): bigint { return left > right ? left : right; }

function safeNumber(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function readReasoning(snapshot: unknown): string {
  if (!isRecord(snapshot)) return "unknown";
  const value = snapshot.thinkingLevel ?? snapshot.reasoning ?? snapshot.reasoningLevel;
  return typeof value === "string" && /^[a-zA-Z0-9._-]{1,200}$/.test(value) ? value : "unknown";
}

function recordDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined", "utf8").digest("hex");
}

class AssuranceEvidenceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode?: number) {
    super(message);
    this.name = "AssuranceEvidenceError";
  }
}
