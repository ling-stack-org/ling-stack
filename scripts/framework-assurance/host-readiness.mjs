import { parseLiveExecutionEvidenceResponse } from "./execution-evidence.mjs";
import { identifier, requireCondition } from "./manifest.mjs";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_WORK_UNIT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_LIFECYCLE_ATTEMPT_STATUSES = new Set([...TERMINAL_ATTEMPT_STATUSES, "lost"]);
const REQUIRED_ASSURANCE_KEYS = ["lifecycle", "completion", "budget", "isolation", "admission", "recovery", "policy", "evaluation"];

/**
 * Parse the complete Host evidence shape required before a real trial can be
 * reconsidered. The ordinary live evidence adapter intentionally accepts a
 * smaller read-only shape for diagnostics; this gate does not.
 */
export function parseHostReadinessEvidence(value) {
  const evidence = parseLiveExecutionEvidenceResponse(value);
  requireCondition(evidence.executionAuthorized === false && REQUIRED_ASSURANCE_KEYS.every(key => Object.hasOwn(evidence, key)),
    "host_readiness_evidence_incomplete", "Host readiness requires read-only execution authority and all eight assurance domains.");
  assertCrossFieldIdentity(evidence);
  return evidence;
}

/**
 * Assess a complete Host projection without dispatching work or granting
 * execution authority. A blocked result is useful evidence; it is not a
 * request to recover, retry, cancel or mutate the Run.
 */
export function assessHostReadiness(value) {
  const evidence = parseHostReadinessEvidence(value);
  const blockers = [];
  const { execution, lifecycle, completion, budget, isolation, admission, recovery, policy, evaluation } = evidence;

  if (!TERMINAL_RUN_STATUSES.has(execution.runStatus)) blockers.push("host_readiness.run_not_terminal");
  if (!TERMINAL_WORK_UNIT_STATUSES.has(execution.workUnitStatus)) blockers.push("host_readiness.work_unit_not_terminal");
  if (!TERMINAL_ATTEMPT_STATUSES.has(execution.attemptStatus)
    || execution.claimStatus !== "terminal_retained") blockers.push("host_readiness.attempt_not_terminal_retained");
  if (execution.effectStatus !== "confirmed") blockers.push("host_readiness.effects_unconfirmed");

  if (lifecycle.status !== "drained") blockers.push("host_readiness.lifecycle_not_drained");
  if (!lifecycle.stop.allAttemptsTerminal) blockers.push("host_readiness.attempts_not_terminal");
  if (!lifecycle.attempts.every(attempt => TERMINAL_LIFECYCLE_ATTEMPT_STATUSES.has(attempt.status))) {
    blockers.push("host_readiness.attempts_not_terminal");
  }
  if (lifecycle.stop.localExecution !== "drained") blockers.push("host_readiness.local_execution_not_drained");
  if (lifecycle.stop.effects !== "settled" || !lifecycle.stop.reusable) blockers.push("host_readiness.effects_not_settled");

  if (completion.status !== "satisfied" && completion.status !== "not_applicable") {
    blockers.push("host_readiness.completion_not_satisfied");
  }
  const requiredCompletionSteps = completion.steps.filter(step => step.required);
  const verifiedCompletionSteps = completion.steps.filter(step => step.completionStatus === "verified");
  if ((completion.status === "not_applicable" && completion.steps.length > 0)
    || completion.requiredStepCount !== requiredCompletionSteps.length
    || completion.completedStepCount !== verifiedCompletionSteps.length
    || completion.completedStepCount < completion.requiredStepCount
    || requiredCompletionSteps.some(step => step.completionStatus !== "verified")) {
    blockers.push("host_readiness.completion_steps_incomplete");
  }
  if (completion.issues.length > 0) blockers.push(...completion.issues.map(issue => `host_readiness.${issue.code}`));
  if (budget.status !== "within" && budget.status !== "not_applicable") blockers.push("host_readiness.budget_not_within");
  const expectedDimensionStatus = budget.status === "not_applicable" ? "not_applicable" : "within";
  if (budget.usage.tokenStatus !== expectedDimensionStatus || budget.usage.costStatus !== expectedDimensionStatus) {
    blockers.push("host_readiness.budget_dimensions_not_consistent");
  }
  if (budget.issues.length > 0) blockers.push("host_readiness.budget_issues_present");
  if (budget.status === "not_applicable" && (
    budget.roots.length > 0 || budget.reservations.length > 0 || budget.charges.length > 0
    || budget.issues.length > 0 || budget.blockers.length > 0
    || budget.usage.tokens !== null || budget.usage.costMicros !== null
    || budget.usage.tokenLimit !== null || budget.usage.costLimitMicros !== null
  )) {
    blockers.push("host_readiness.budget_not_applicable_has_facts");
  }
  blockers.push(...budget.blockers.map(issue => `host_readiness.${issue}`));

  if (isolation.status !== "verified") blockers.push("host_readiness.isolation_not_verified");
  if (!isolation.safetyPlan.present || !isolation.safetyPlan.valid
    || isolation.safetyPlan.profile !== "pi_host_isolated_files_v1" || isolation.safetyPlan.digest === null
    || isolation.safetyPlan.networkAccess !== false) {
    blockers.push("host_readiness.isolated_profile_invalid");
  }
  if (isolation.binding.status !== "current" || !isolation.binding.matchesCurrentFence) {
    blockers.push("host_readiness.execution_binding_invalid");
  }
  if (isolation.round === null || isolation.round.phase !== "applied" || isolation.round.lastConfirmedPhase !== "applied") {
    blockers.push("host_readiness.isolation_round_not_applied");
  }
  if (isolation.apply.status !== "applied" || !isolation.apply.intentPresent) {
    blockers.push("host_readiness.isolation_apply_not_confirmed");
  }
  blockers.push(...isolation.blockers.map(issue => `host_readiness.${issue}`));

  if (admission.status !== "verified") blockers.push("host_readiness.admission_not_verified");
  if (!admission.safetyPlan.present || !admission.safetyPlan.valid
    || admission.profile !== "pi_host_isolated_files_v1" || admission.safetyPlan.digest === null) {
    blockers.push("host_readiness.admission_safety_plan_invalid");
  }
  if (admission.toolBroker.mode !== "enforce" || !admission.toolBroker.required || !admission.toolBroker.satisfies) {
    blockers.push("host_readiness.tool_broker_not_enforced");
  }
  if (admission.binding.status !== "current" || !admission.binding.matchesCurrentFence) {
    blockers.push("host_readiness.admission_binding_invalid");
  }
  blockers.push(...admission.blockers.map(issue => `host_readiness.${issue}`));

  if (recovery.status !== "verified" && recovery.status !== "not_applicable") blockers.push("host_readiness.recovery_not_verified");
  if (recovery.status === "not_applicable" && (recovery.source !== null || recovery.target !== null || recovery.continuation !== null
    || recovery.duplicateDispatch.continuationCount !== 0)) blockers.push("host_readiness.recovery_not_applicable_has_facts");
  if (recovery.status === "verified" && (!recovery.source || !recovery.target || !recovery.continuation
    || recovery.source.localExecution !== "drained" || recovery.source.effects !== "settled"
    || recovery.continuation.origin !== "daemon_recovery" || recovery.continuation.state !== "succeeded"
    || recovery.duplicateDispatch.status !== "protected" || recovery.duplicateDispatch.continuationCount < 1)) {
    blockers.push("host_readiness.recovery_chain_invalid");
  }
  blockers.push(...recovery.blockers.map(issue => `host_readiness.${issue}`));

  if (policy.status !== "current") blockers.push("host_readiness.policy_not_current");
  if (!policy.stored.present || policy.stored.fingerprint === null) blockers.push("host_readiness.policy_stored_missing");
  if (!policy.current.available || policy.current.fingerprint === null) blockers.push("host_readiness.policy_current_unavailable");
  if (policy.stored.fingerprint !== null && policy.current.fingerprint !== null
    && policy.stored.fingerprint !== policy.current.fingerprint) blockers.push("host_readiness.policy_snapshot_drift");
  blockers.push(...policy.blockers.map(issue => `host_readiness.${issue}`));

  if (evaluation.status !== "verified" && evaluation.status !== "not_applicable") blockers.push("host_readiness.evaluation_not_verified");
  if (evaluation.status === "not_applicable" && (evaluation.evaluation !== null || evaluation.grades.length > 0
    || evaluation.charges.length > 0 || evaluation.budget !== null)) blockers.push("host_readiness.evaluation_not_applicable_has_facts");
  if (evaluation.status === "verified") {
    if (!evaluation.evaluation || evaluation.evaluation.state !== "completed" || evaluation.evaluation.runId !== execution.runId) {
      blockers.push("host_readiness.evaluation_lineage_invalid");
    }
    if (!evaluation.budget?.present || evaluation.budget.rootRunId !== evaluation.evaluation?.rootRunId) blockers.push("host_readiness.evaluation_budget_missing");
    const chargeById = new Map(evaluation.charges.map(charge => [charge.chargeId, charge]));
    if (evaluation.grades.length === 0 || evaluation.grades.some(grade => {
      if (grade.evaluationId !== evaluation.evaluation?.id) return true;
      if (!["matched", "not_required"].includes(grade.chargeMatch)) return true;
      if (grade.chargeMatch !== "matched") return false;
      if (grade.chargeId === null) return true;
      const charge = chargeById.get(grade.chargeId);
      return !charge || charge.inputTokens !== grade.costInputTokens
        || charge.outputTokens !== grade.costOutputTokens || charge.actualCostMicros !== grade.costAmountMicros;
    })) {
      blockers.push("host_readiness.evaluation_grades_incomplete");
    }
  }
  blockers.push(...evaluation.blockers.map(issue => `host_readiness.${issue}`));

  const uniqueBlockers = [...new Set(blockers)];
  return {
    schemaVersion: 1,
    kind: "host_readiness_report",
    status: uniqueBlockers.length === 0 ? "ready-for-trial-review" : "blocked",
    executionAuthorized: false,
    lineage: {
      runId: execution.runId,
      workUnitId: execution.workUnitId,
      attemptId: execution.attemptId,
      runtimeInstanceId: execution.runtimeInstanceId,
    },
    observedAt: evidence.observedAt,
    domains: {
      lifecycle: {
        status: lifecycle.status,
        attemptCount: lifecycle.attemptCount,
        oldAttemptCount: lifecycle.oldAttemptCount,
        allAttemptsTerminal: lifecycle.stop.allAttemptsTerminal,
        localExecution: lifecycle.stop.localExecution,
        effects: lifecycle.stop.effects,
        reusable: lifecycle.stop.reusable,
      },
      completion: {
        status: completion.status,
        stepCount: completion.stepCount,
        requiredStepCount: completion.requiredStepCount,
        completedStepCount: completion.completedStepCount,
        issues: completion.issues.map(issue => issue.code),
      },
      budget: {
        status: budget.status,
        tokenStatus: budget.usage.tokenStatus,
        costStatus: budget.usage.costStatus,
        blockers: budget.blockers,
      },
      isolation: {
        status: isolation.status,
        profile: isolation.safetyPlan.profile,
        safetyPlanValid: isolation.safetyPlan.valid,
        bindingStatus: isolation.binding.status,
        matchesCurrentFence: isolation.binding.matchesCurrentFence,
        approvalStatus: isolation.approval.status,
        applyStatus: isolation.apply.status,
        blockers: isolation.blockers,
      },
      admission: {
        status: admission.status,
        profile: admission.profile,
        toolBrokerMode: admission.toolBroker.mode,
        toolBrokerSatisfies: admission.toolBroker.satisfies,
        bindingStatus: admission.binding.status,
        matchesCurrentFence: admission.binding.matchesCurrentFence,
        blockers: admission.blockers,
      },
      recovery: {
        status: recovery.status,
        sourceAttemptId: recovery.source?.attemptId ?? null,
        targetAttemptId: recovery.target?.attemptId ?? null,
        continuationState: recovery.continuation?.state ?? null,
        duplicateDispatch: recovery.duplicateDispatch.status,
        blockers: recovery.blockers,
      },
      policy: {
        status: policy.status,
        storedFingerprint: policy.stored.fingerprint,
        currentFingerprint: policy.current.fingerprint,
        blockers: policy.blockers,
      },
      evaluation: {
        status: evaluation.status,
        evaluationId: evaluation.evaluation?.id ?? null,
        gradeCount: evaluation.grades.length,
        matchedChargeCount: evaluation.grades.filter(grade => grade.chargeMatch === "matched").length,
        blockers: evaluation.blockers,
      },
    },
    blockers: uniqueBlockers,
    limitations: [
      "read_only_host_projection",
      "no_execution_authority",
      "no_task_input",
      "no_artifact_body",
      "no_evaluation_grade",
      "no_evaluation_grade_body",
      "readiness_is_not_real_trial_acceptance",
    ],
  };
}

/**
 * Read one already-existing Host projection through a client-owned endpoint.
 * This helper deliberately exposes no recovery, dispatch or Store operation.
 */
export async function collectHostReadiness({ client, cwd, runId } = {}) {
  requireCondition(client !== null && typeof client === "object"
    && typeof client.getRunAssuranceEvidence === "function",
  "host_readiness_client_invalid", "A read-only assurance evidence client is required.");
  requireCondition(typeof cwd === "string" && cwd.length > 0, "host_readiness_query_invalid", "A workspace cwd is required.");
  identifier(runId, "Host readiness Run id");
  const source = parseHostReadinessEvidence(await client.getRunAssuranceEvidence(runId, cwd));
  requireCondition(source.execution.runId === runId,
    "host_readiness_lineage_mismatch", "Host readiness evidence does not match the requested Run.");
  return assessHostReadiness(source);
}

export function renderHostReadinessMarkdown(report) {
  const lines = [
    "# Host readiness",
    "",
    `- Status: **${report.status}**`,
    `- Run: \`${report.lineage.runId}\``,
    `- Attempt: \`${report.lineage.attemptId}\``,
    `- Execution authorized: \`${report.executionAuthorized}\``,
    "",
    "| Domain | Status | Key result |",
    "| --- | --- | --- |",
    `| lifecycle | ${report.domains.lifecycle.status} | reusable=${report.domains.lifecycle.reusable} |`,
    `| completion | ${report.domains.completion.status} | ${report.domains.completion.completedStepCount}/${report.domains.completion.requiredStepCount} required steps |`,
    `| budget | ${report.domains.budget.status} | tokens=${report.domains.budget.tokenStatus}, cost=${report.domains.budget.costStatus} |`,
    `| isolation | ${report.domains.isolation.status} | profile=${report.domains.isolation.profile ?? "none"}, apply=${report.domains.isolation.applyStatus} |`,
    `| admission | ${report.domains.admission.status} | broker=${report.domains.admission.toolBrokerMode} |`,
    "",
    `Blockers: ${report.blockers.length === 0 ? "none" : report.blockers.join(", ")}`,
    "",
    "This is a read-only Host projection gate; it does not authorize a Provider, model, Run, Store, daemon or paid task.",
    "",
  ];
  return lines.join("\n");
}

function assertCrossFieldIdentity(evidence) {
  const { execution, lifecycle, completion, budget, isolation, admission, recovery, policy, evaluation } = evidence;
  const lineageRoots = [
    ...(completion.status !== "not_applicable" ? completion.rootRunIds : []),
    ...(budget.status !== "not_applicable" ? budget.roots.map(root => root.runId) : []),
    ...(evaluation.status !== "not_applicable" && evaluation.evaluation ? [evaluation.evaluation.rootRunId] : []),
  ];
  const uniqueLineageRoots = [...new Set(lineageRoots)];
  requireCondition(uniqueLineageRoots.length <= 1,
    "host_readiness_lineage_mismatch", "Host assurance domains disagree about the Run lineage root.");
  const lineageRootId = uniqueLineageRoots[0] ?? execution.runId;
  const current = lifecycle.attempts.find(attempt => attempt.isCurrent);
  requireCondition(current?.attemptId === execution.attemptId
    && current.runtimeInstanceId === execution.runtimeInstanceId
    && current.fencingToken === execution.fencingToken
    && current.attemptNumber === lifecycle.currentGeneration
    && current.status === execution.attemptStatus,
  "host_readiness_lineage_mismatch", "Host lifecycle current Attempt does not match execution lineage.");

  if (completion.status !== "not_applicable") {
    requireCondition(completion.rootRunIds.length > 0 && completion.rootRunIds.every(rootRunId => rootRunId === lineageRootId),
      "host_readiness_lineage_mismatch", "Completion evidence is not rooted in the observed Run lineage.");
  }
  if (budget.status !== "not_applicable") {
    requireCondition(budget.roots.length > 0 && budget.roots.every(root => root.runId === lineageRootId),
      "host_readiness_lineage_mismatch", "Budget evidence is not rooted in the observed Run lineage.");
  }
  requireCondition(admission.profile !== null && admission.profile === isolation.safetyPlan.profile,
    "host_readiness_admission_mismatch", "Admission profile does not match the isolation safety profile.");
  requireCondition(admission.safetyPlan.digest !== null && admission.safetyPlan.digest === isolation.safetyPlan.digest,
    "host_readiness_admission_mismatch", "Admission safety plan does not match isolation evidence.");
  requireCondition(admission.binding.status === isolation.binding.status
    && admission.binding.matchesCurrentFence === isolation.binding.matchesCurrentFence,
  "host_readiness_admission_mismatch", "Admission binding does not match isolation evidence.");
  requireCondition(policy.stored.fingerprint === null || policy.current.fingerprint === null
    || policy.stored.fingerprint === policy.current.fingerprint || policy.status === "drifted",
  "host_readiness_policy_mismatch", "Policy evidence fingerprints are inconsistent.");
  if (recovery.status === "verified") {
    requireCondition(recovery.target?.attemptId === execution.attemptId
      && recovery.target.runtimeInstanceId === execution.runtimeInstanceId,
    "host_readiness_lineage_mismatch", "Recovery target does not match execution lineage.");
  }
  if (evaluation.status !== "not_applicable") {
    requireCondition(evaluation.evaluation?.runId === execution.runId
      && evaluation.evaluation?.rootRunId === lineageRootId,
    "host_readiness_lineage_mismatch", "Evaluation does not belong to the observed Run lineage.");
    requireCondition(evaluation.charges.every(charge => charge.runId === execution.runId),
    "host_readiness_lineage_mismatch", "Evaluation Provider charges do not belong to the observed Run.");
  }
}
