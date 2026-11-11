import { parseLiveExecutionEvidenceResponse } from "./execution-evidence.mjs";
import { identifier, requireCondition } from "./manifest.mjs";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_WORK_UNIT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TERMINAL_ATTEMPT_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const REQUIRED_ASSURANCE_KEYS = ["lifecycle", "completion", "budget", "isolation", "admission"];

/**
 * Parse the complete Host evidence shape required before a real trial can be
 * reconsidered. The ordinary live evidence adapter intentionally accepts a
 * smaller read-only shape for diagnostics; this gate does not.
 */
export function parseHostReadinessEvidence(value) {
  const evidence = parseLiveExecutionEvidenceResponse(value);
  requireCondition(REQUIRED_ASSURANCE_KEYS.every(key => Object.hasOwn(evidence, key)),
    "host_readiness_evidence_incomplete", "Host readiness requires lifecycle, completion, budget, isolation and admission evidence.");
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
  const { execution, lifecycle, completion, budget, isolation, admission } = evidence;

  if (!TERMINAL_RUN_STATUSES.has(execution.runStatus)) blockers.push("host_readiness.run_not_terminal");
  if (!TERMINAL_WORK_UNIT_STATUSES.has(execution.workUnitStatus)) blockers.push("host_readiness.work_unit_not_terminal");
  if (!TERMINAL_ATTEMPT_STATUSES.has(execution.attemptStatus)
    || execution.claimStatus !== "terminal_retained") blockers.push("host_readiness.attempt_not_terminal_retained");
  if (execution.effectStatus !== "confirmed") blockers.push("host_readiness.effects_unconfirmed");

  if (lifecycle.status !== "drained") blockers.push("host_readiness.lifecycle_not_drained");
  if (!lifecycle.stop.allAttemptsTerminal) blockers.push("host_readiness.attempts_not_terminal");
  if (lifecycle.stop.localExecution !== "drained") blockers.push("host_readiness.local_execution_not_drained");
  if (lifecycle.stop.effects !== "settled" || !lifecycle.stop.reusable) blockers.push("host_readiness.effects_not_settled");

  if (completion.status !== "satisfied" && completion.status !== "not_applicable") {
    blockers.push("host_readiness.completion_not_satisfied");
  }
  if (completion.issues.length > 0) blockers.push(...completion.issues.map(issue => `host_readiness.${issue.code}`));
  if (budget.status !== "within" && budget.status !== "not_applicable") blockers.push("host_readiness.budget_not_within");
  const expectedDimensionStatus = budget.status === "not_applicable" ? "not_applicable" : "within";
  if (budget.usage.tokenStatus !== expectedDimensionStatus || budget.usage.costStatus !== expectedDimensionStatus) {
    blockers.push("host_readiness.budget_dimensions_not_consistent");
  }
  blockers.push(...budget.blockers.map(issue => `host_readiness.${issue}`));

  if (isolation.status !== "verified") blockers.push("host_readiness.isolation_not_verified");
  if (!isolation.safetyPlan.valid || isolation.safetyPlan.profile !== "pi_host_isolated_files_v1") {
    blockers.push("host_readiness.isolated_profile_invalid");
  }
  if (isolation.binding.status !== "current" || !isolation.binding.matchesCurrentFence) {
    blockers.push("host_readiness.execution_binding_invalid");
  }
  blockers.push(...isolation.blockers.map(issue => `host_readiness.${issue}`));

  if (admission.status !== "verified") blockers.push("host_readiness.admission_not_verified");
  if (admission.toolBroker.mode !== "enforce" || !admission.toolBroker.required || !admission.toolBroker.satisfies) {
    blockers.push("host_readiness.tool_broker_not_enforced");
  }
  if (admission.binding.status !== "current" || !admission.binding.matchesCurrentFence) {
    blockers.push("host_readiness.admission_binding_invalid");
  }
  blockers.push(...admission.blockers.map(issue => `host_readiness.${issue}`));

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
    },
    blockers: uniqueBlockers,
    limitations: [
      "read_only_host_projection",
      "no_execution_authority",
      "no_task_input",
      "no_artifact_body",
      "no_evaluation_grade",
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
  const { execution, lifecycle, completion, budget, isolation, admission } = evidence;
  const current = lifecycle.attempts.find(attempt => attempt.isCurrent);
  requireCondition(current?.attemptId === execution.attemptId
    && current.runtimeInstanceId === execution.runtimeInstanceId
    && current.fencingToken === execution.fencingToken
    && current.attemptNumber === lifecycle.currentGeneration,
  "host_readiness_lineage_mismatch", "Host lifecycle current Attempt does not match execution lineage.");

  if (completion.status !== "not_applicable") {
    requireCondition(completion.rootRunIds.includes(execution.runId),
      "host_readiness_lineage_mismatch", "Completion evidence is not rooted at the observed Run.");
  }
  if (budget.status !== "not_applicable") {
    requireCondition(budget.roots.some(root => root.runId === execution.runId),
      "host_readiness_lineage_mismatch", "Budget evidence is not rooted at the observed Run.");
  }
  requireCondition(admission.profile === null || admission.profile === isolation.safetyPlan.profile,
    "host_readiness_admission_mismatch", "Admission profile does not match the isolation safety profile.");
  requireCondition(admission.safetyPlan.digest === null || admission.safetyPlan.digest === isolation.safetyPlan.digest,
    "host_readiness_admission_mismatch", "Admission safety plan does not match isolation evidence.");
  requireCondition(admission.binding.status === isolation.binding.status
    && admission.binding.matchesCurrentFence === isolation.binding.matchesCurrentFence,
  "host_readiness_admission_mismatch", "Admission binding does not match isolation evidence.");
}
