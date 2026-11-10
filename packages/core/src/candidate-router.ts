import type {
  CandidateRoute,
  CandidateRouteBlocker,
  ProcedureObservation,
  ProcedureObservationSignal,
} from "./procedure-observation-types.js";

export function routeProcedureObservation(observation: ProcedureObservation): CandidateRoute {
  const text = [
    observation.title,
    observation.summary,
    observation.normalizedGoal,
    ...observation.positiveTriggers,
    ...observation.negativeTriggers,
    ...observation.procedureSteps.flatMap((step) => [step.title, step.instruction ?? "", ...(step.requiredTools ?? [])]),
  ].join(" ").toLowerCase();

  if (containsPermissionExpansion(text)) {
    return route("approval_policy_review", "permission_expansion_requested", "high", ["permission_expansion"]);
  }
  if (containsSecretAdjacentText(text)) {
    return route("reject", "secret_adjacent_instruction", "high", ["unsafe_or_secret_adjacent"]);
  }
  if (observation.source === "multi_agent_handoff" || hasSignal(observation.signals, "handoff_stabilized")) {
    return route("channel_protocol", "multi_agent_handoff_protocol", observation.confidence, []);
  }
  if (
    observation.source === "workflow_step_output" &&
    observation.channelId &&
    observation.procedureSteps.length > 0
  ) {
    return route("playbook", "channel_scoped_repeatable_playbook", observation.confidence, []);
  }
  if (looksScheduled(text)) {
    return route("automation", "scheduled_or_recurring_work", observation.confidence, []);
  }

  if (observation.procedureSteps.length > 0) {
    const blockers: CandidateRouteBlocker[] = [];
    if (observation.validationSteps.length === 0) {
      blockers.push("missing_validation");
    }
    if (observation.negativeTriggers.length === 0) {
      blockers.push("missing_negative_trigger");
    }
    if (observation.positiveTriggers.length === 0) {
      blockers.push("insufficient_evidence");
    }
    return route(
      "skill",
      blockers.length === 0 ? "repeatable_procedure_with_validation" : "repeatable_procedure_missing_gates",
      blockers.length === 0 ? observation.confidence : "medium",
      blockers,
    );
  }

  if (observation.source === "user_correction" || hasSignal(observation.signals, "correction_phrase")) {
    if (observation.positiveTriggers.length === 0 && observation.reusableScore < 50) {
      return route("reject", "one_off_correction_without_reusable_shape", "medium", ["one_off_preference"]);
    }
    return route("memory", "durable_user_correction", observation.confidence, []);
  }

  if (observation.positiveTriggers.length > 0 || observation.reusableScore >= 50) {
    return route("memory", "durable_context_or_preference", observation.confidence, []);
  }

  return route("reject", "insufficient_reusable_evidence", "low", ["insufficient_evidence"]);
}

function route(
  kind: CandidateRoute["kind"],
  reasonCode: string,
  confidence: CandidateRoute["confidence"],
  blockers: readonly CandidateRouteBlocker[],
): CandidateRoute {
  return { kind, reasonCode, confidence, blockers };
}

function hasSignal(signals: readonly ProcedureObservationSignal[], signal: ProcedureObservationSignal): boolean {
  return signals.includes(signal);
}

function containsPermissionExpansion(text: string): boolean {
  return /\b(skip approval|without approval|bypass approval|always allow|grant tool|grant permission|use bash without asking|auto approve|deploy without approval)\b/.test(text);
}

function containsSecretAdjacentText(text: string): boolean {
  return /\b(api[_ -]?key|secret|token|password|private key)\b/.test(text);
}

function looksScheduled(text: string): boolean {
  return /\b(every|daily|weekly|monthly|cron|schedule|scheduled|monitor|reminder|friday|monday)\b/.test(text)
    || /(每周|每天|定时|提醒)/u.test(text);
}
