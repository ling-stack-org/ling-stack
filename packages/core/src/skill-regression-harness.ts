import { skillRegressionGuardrails } from "./skill-regression-policy.js";
import type { ApprovalRisk } from "./approval-types.js";
import type {
  CreateSkillRegressionRunInput,
  SkillRegressionCaseResult,
  SkillRegressionFinding,
  SkillRegressionFixture,
  SkillRegressionLifecycleVerdict,
  SkillRegressionMode,
  SkillRegressionModeSummary,
  SkillRegressionObservation,
  SkillRegressionRun,
  SkillRegressionSummary,
} from "./skill-types.js";

export interface BuildSkillRegressionRunInput {
  readonly skillId: string;
  readonly sourceSnapshotId?: string;
  readonly compiledViewId?: string;
  readonly suiteId?: string;
  readonly fixtures: readonly SkillRegressionFixture[];
  readonly observations: readonly SkillRegressionObservation[];
  readonly now: string;
  readonly id?: string;
  readonly minimumTokenReductionRatio?: number;
  readonly maximumFallbackRate?: number;
  readonly runtimeSupportsCompiledContext?: boolean;
  readonly historicalSelectionCount?: number;
}

export function buildSkillRegressionRunInput(input: BuildSkillRegressionRunInput): CreateSkillRegressionRunInput {
  const results = input.observations.map((observation) => {
    const fixture = input.fixtures.find((candidate) => candidate.id === observation.fixtureId);
    if (!fixture) {
      return orphanObservationResult(observation);
    }
    return evaluateObservation(fixture, observation);
  });
  const summary = summarizeSkillRegressionResults(results);
  const lifecycleVerdict = resolveSkillRegressionLifecycleVerdict({
    summary,
    fixtures: input.fixtures,
    runtimeSupportsCompiledContext: input.runtimeSupportsCompiledContext,
    historicalSelectionCount: input.historicalSelectionCount,
    minimumTokenReductionRatio: input.minimumTokenReductionRatio,
    maximumFallbackRate: input.maximumFallbackRate,
  });
  return {
    id: input.id,
    skillId: input.skillId,
    sourceSnapshotId: input.sourceSnapshotId,
    compiledViewId: input.compiledViewId,
    suiteId: input.suiteId,
    fixtures: input.fixtures,
    observations: input.observations,
    results,
    summary,
    lifecycleVerdict,
    autoSafeEligible: lifecycleVerdict === "safe_for_core_lazy",
  };
}

export function materializeSkillRegressionRun(
  input: CreateSkillRegressionRunInput,
  workspaceId: string,
  createdAt: string,
  id: string,
): SkillRegressionRun {
  return {
    id,
    workspaceId,
    skillId: input.skillId,
    sourceSnapshotId: input.sourceSnapshotId,
    compiledViewId: input.compiledViewId,
    suiteId: input.suiteId,
    guardrails: skillRegressionGuardrails,
    fixtures: input.fixtures,
    observations: input.observations,
    results: input.results,
    summary: input.summary,
    lifecycleVerdict: input.lifecycleVerdict,
    autoSafeEligible: input.autoSafeEligible,
    createdAt,
  };
}

export function summarizeSkillRegressionResults(
  results: readonly SkillRegressionCaseResult[],
): SkillRegressionSummary {
  const modeSummaries = regressionModes.map((mode) => summarizeMode(mode, results));
  const originalAverageTokenEstimate = modeSummaries.find((summary) => summary.mode === "original_source")?.averageTokenEstimate ?? 0;
  const compiledAverageTokenEstimate = averageNonZero(
    modeSummaries
      .filter((summary) => summary.mode !== "original_source")
      .map((summary) => summary.averageTokenEstimate),
  );
  const compiledResults = results.filter((result) => result.mode !== "original_source");
  const fallbackCount = compiledResults.filter((result) => result.fallbackUsed).length;
  const tokenReductionRatio = originalAverageTokenEstimate > 0 && compiledAverageTokenEstimate > 0
    ? Math.max(0, (originalAverageTokenEstimate - compiledAverageTokenEstimate) / originalAverageTokenEstimate)
    : 0;
  return {
    passedCount: results.filter((result) => result.passed).length,
    failedCount: results.filter((result) => !result.passed).length,
    totalCount: results.length,
    originalAverageTokenEstimate,
    compiledAverageTokenEstimate,
    tokenReductionRatio,
    fallbackRate: compiledResults.length === 0 ? 0 : fallbackCount / compiledResults.length,
    missingReferenceRegressionCount: results.filter((result) => result.missingReferenceRegression).length,
    approvalRegressionCount: results.filter((result) => !result.approvalSafe).length,
    routingRegressionCount: results.filter((result) => !result.routingPreserved).length,
    taskSuccessRegressionCount: results.filter((result) => !result.taskSucceeded).length,
    modeSummaries,
  };
}

export function resolveSkillRegressionLifecycleVerdict(input: {
  readonly summary: SkillRegressionSummary;
  readonly fixtures: readonly SkillRegressionFixture[];
  readonly runtimeSupportsCompiledContext?: boolean;
  readonly historicalSelectionCount?: number;
  readonly minimumTokenReductionRatio?: number;
  readonly maximumFallbackRate?: number;
}): SkillRegressionLifecycleVerdict {
  if (input.runtimeSupportsCompiledContext === false) {
    return "black_box_runtime_only";
  }
  if (input.fixtures.length === 0 || input.summary.totalCount === 0 || input.historicalSelectionCount === 0) {
    return "obsolete_or_low_value";
  }
  const baselineFailed = input.summary.modeSummaries
    .filter((summary) => summary.mode === "original_source")
    .some((summary) => summary.failedCount > 0);
  if (
    baselineFailed ||
    input.summary.routingRegressionCount > 0 ||
    input.summary.taskSuccessRegressionCount > 0 ||
    input.summary.approvalRegressionCount > 0 ||
    input.summary.missingReferenceRegressionCount > 0
  ) {
    return "needs_manual_review";
  }
  const maximumFallbackRate = input.maximumFallbackRate ?? 0;
  if (input.summary.fallbackRate > maximumFallbackRate) {
    return "needs_manual_review";
  }
  const minimumTokenReductionRatio = input.minimumTokenReductionRatio ?? 0.15;
  if (input.summary.tokenReductionRatio < minimumTokenReductionRatio) {
    return "safe_to_keep_full";
  }
  return "safe_for_core_lazy";
}

export function canPromoteSkillOptimizationAutoSafe(run: SkillRegressionRun): boolean {
  return run.guardrails.requiresPassingGateForAutoSafe &&
    !run.guardrails.canChangeRuntimeAuthority &&
    run.autoSafeEligible &&
    run.lifecycleVerdict === "safe_for_core_lazy" &&
    run.summary.failedCount === 0;
}

function evaluateObservation(
  fixture: SkillRegressionFixture,
  observation: SkillRegressionObservation,
): SkillRegressionCaseResult {
  const reasons: string[] = [];
  const findings: SkillRegressionFinding[] = [];
  const sourceRefs = sourceRefsForObservation(observation);
  const routingPreserved = observation.selectedSkillId === fixture.expectedSelectedSkillId;
  if (!routingPreserved) {
    reasons.push(`selected_skill:${observation.selectedSkillId ?? "none"}`);
    findings.push(finding("routing_regression", fixture, observation, `Expected ${fixture.expectedSelectedSkillId} but observed ${observation.selectedSkillId ?? "none"}.`, sourceRefs));
  }
  const taskSucceeded = taskSucceededForFixture(fixture, observation);
  if (!taskSucceeded) {
    reasons.push("task_success_failed");
    findings.push(finding("task_success_regression", fixture, observation, "Observed output did not satisfy fixture success markers.", sourceRefs));
  }
  const approvalSafe = approvalSafeForFixture(fixture, observation);
  if (!approvalSafe) {
    reasons.push("approval_risk_failed");
    findings.push(finding("approval_risk_regression", fixture, observation, "Observed approvals exceeded the fixture risk boundary.", sourceRefs));
  }
  const missingReferenceRegression = missingReferenceRegressionForObservation(observation);
  if (missingReferenceRegression) {
    reasons.push("missing_reference_regression");
    findings.push(finding("missing_reference_regression", fixture, observation, "Compiled context failed with a missing-reference signature.", sourceRefs));
  }
  const fallbackSafe = fallbackSafeForFixture(fixture, observation);
  if (!fallbackSafe) {
    reasons.push("fallback_used");
    findings.push(finding("fallback_regression", fixture, observation, "Compiled context required fallback to original source.", sourceRefs));
  }
  const tokenEstimate = observation.tokenEstimate ??
    observation.runtimeContext?.tokenEstimate ??
    estimateTokens(observation.outputText ?? "");
  const loadedLazyReferenceCount = observation.loadedLazyReferenceIds?.length ??
    observation.runtimeContext?.materializedRefs?.length ??
    0;
  return {
    fixtureId: fixture.id,
    mode: observation.mode,
    passed: routingPreserved && taskSucceeded && approvalSafe && fallbackSafe && !missingReferenceRegression,
    routingPreserved,
    taskSucceeded,
    approvalSafe,
    fallbackUsed: Boolean(observation.fallbackPlan),
    fallbackSafe,
    missingReferenceRegression,
    clarificationCount: observation.clarificationCount ?? 0,
    tokenEstimate,
    latencyMs: observation.latencyMs,
    loadedLazyReferenceCount,
    reasons,
    findings,
  };
}

function orphanObservationResult(observation: SkillRegressionObservation): SkillRegressionCaseResult {
  return {
    fixtureId: observation.fixtureId,
    mode: observation.mode,
    passed: false,
    routingPreserved: false,
    taskSucceeded: false,
    approvalSafe: false,
    fallbackUsed: Boolean(observation.fallbackPlan),
    fallbackSafe: false,
    missingReferenceRegression: false,
    clarificationCount: observation.clarificationCount ?? 0,
    tokenEstimate: observation.tokenEstimate ?? observation.runtimeContext?.tokenEstimate ?? 0,
    latencyMs: observation.latencyMs,
    loadedLazyReferenceCount: observation.loadedLazyReferenceIds?.length ?? 0,
    reasons: ["fixture_missing"],
    findings: [{
      kind: "baseline_failure",
      severity: "critical",
      fixtureId: observation.fixtureId,
      mode: observation.mode,
      message: "Regression observation did not match any fixture.",
      sourceRefs: sourceRefsForObservation(observation),
    }],
  };
}

function taskSucceededForFixture(fixture: SkillRegressionFixture, observation: SkillRegressionObservation): boolean {
  if (observation.completed === false) {
    return false;
  }
  const output = normalize(observation.outputText);
  const expectedMarkers = fixture.expectedSuccessMarkers ?? [];
  const forbiddenMarkers = fixture.forbiddenOutputMarkers ?? [];
  return expectedMarkers.every((marker) => output.includes(normalize(marker))) &&
    forbiddenMarkers.every((marker) => !output.includes(normalize(marker)));
}

function approvalSafeForFixture(fixture: SkillRegressionFixture, observation: SkillRegressionObservation): boolean {
  const maxApprovalCount = fixture.maxApprovalCount ?? 0;
  const approvalCount = observation.approvalCount ?? 0;
  const observedRisk = observation.maxApprovalRisk ?? "low";
  const maxRisk = fixture.maxApprovalRisk ?? "low";
  return approvalCount <= maxApprovalCount && riskRank(observedRisk) <= riskRank(maxRisk);
}

function fallbackSafeForFixture(fixture: SkillRegressionFixture, observation: SkillRegressionObservation): boolean {
  return !observation.fallbackPlan || fixture.allowFallback === true;
}

function missingReferenceRegressionForObservation(observation: SkillRegressionObservation): boolean {
  const message = normalize(observation.errorMessage);
  return Boolean(observation.fallbackPlan?.reasonCode === "compiled_missing_reference") ||
    /missing reference|missing skill reference|unknown ref|reference not loaded|context not loaded/.test(message);
}

function sourceRefsForObservation(observation: SkillRegressionObservation): readonly string[] {
  const context = observation.runtimeContext;
  if (!context) {
    return [];
  }
  const matchedRefs = new Set(observation.fallbackPlan?.matchedRefIds ?? []);
  const deferredRefs = context.deferredRefs ?? [];
  const matchedSourceRefs = deferredRefs
    .filter((reference) => matchedRefs.has(reference.id))
    .map((reference) => reference.sourceRef);
  if (matchedSourceRefs.length > 0) {
    return matchedSourceRefs;
  }
  return [
    context.compiledViewId ? `compiled-view:${context.compiledViewId}` : undefined,
    context.snapshotId ? `skill-source:${context.snapshotId}` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function finding(
  kind: SkillRegressionFinding["kind"],
  fixture: SkillRegressionFixture,
  observation: SkillRegressionObservation,
  message: string,
  sourceRefs: readonly string[],
): SkillRegressionFinding {
  return {
    kind,
    severity: kind === "routing_regression" || kind === "approval_risk_regression" ? "critical" : "warning",
    fixtureId: fixture.id,
    mode: observation.mode,
    message,
    sourceRefs,
  };
}

function summarizeMode(
  mode: SkillRegressionMode,
  results: readonly SkillRegressionCaseResult[],
): SkillRegressionModeSummary {
  const modeResults = results.filter((result) => result.mode === mode);
  const latencies = modeResults
    .map((result) => result.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    mode,
    passedCount: modeResults.filter((result) => result.passed).length,
    failedCount: modeResults.filter((result) => !result.passed).length,
    totalCount: modeResults.length,
    fallbackCount: modeResults.filter((result) => result.fallbackUsed).length,
    missingReferenceRegressionCount: modeResults.filter((result) => result.missingReferenceRegression).length,
    clarificationCount: modeResults.reduce((total, result) => total + result.clarificationCount, 0),
    averageTokenEstimate: average(modeResults.map((result) => result.tokenEstimate)),
    averageLatencyMs: latencies.length === 0 ? undefined : average(latencies),
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

function averageNonZero(values: readonly number[]): number {
  return average(values.filter((value) => value > 0));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function riskRank(risk: ApprovalRisk): number {
  switch (risk) {
    case "low":
      return 1;
    case "medium":
      return 2;
    case "high":
      return 3;
    case "critical":
      return 4;
  }
}

function normalize(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

const regressionModes: readonly SkillRegressionMode[] = [
  "original_source",
  "compiled_view",
  "compressed_routing_compiled_view",
];
