import type {
  LingAppServerDeliberationTriggerDecisionV1,
  LingAppServerDeliberationTriggerPolicyV1,
  LingAppServerDeliberationTriggerSignalV1,
} from "@ling-stack/contracts";

const defaultPolicy: LingAppServerDeliberationTriggerPolicyV1 = {
  enabled: true,
  onPlanFormation: true,
  onDeclaredDecisionPoint: true,
  onConflictingRecommendations: true,
  onMaterialRequirementChange: true,
  minimumParticipants: 2,
  maxRounds: 2,
};

/** Decides whether a durable deliberation round should be opened. This helper
 * is intentionally deterministic so an admission retry cannot open a second
 * round for the same signal. */
export function evaluateDeliberationTrigger(
  signal: LingAppServerDeliberationTriggerSignalV1,
  policy: Partial<LingAppServerDeliberationTriggerPolicyV1> = {},
): LingAppServerDeliberationTriggerDecisionV1 {
  const effective = { ...defaultPolicy, ...policy };
  if (signal.workItemRevision < 1) {
    throw new Error("deliberation_trigger_work_item_revision_invalid");
  }
  if (signal.kind === "manual_request") {
    return {
      shouldOpen: effective.enabled,
      requiresHumanDecision: true,
      reason: effective.enabled ? "Manual deliberation request." : "Deliberation is disabled by policy.",
      triggerKind: signal.kind,
    };
  }
  if (!effective.enabled) {
    return { shouldOpen: false, requiresHumanDecision: false, reason: "Deliberation is disabled by policy.", triggerKind: signal.kind };
  }
  if (signal.kind === "plan_formation" && effective.onPlanFormation) {
    return { shouldOpen: true, requiresHumanDecision: false, reason: "The Work Item is forming an execution plan.", triggerKind: signal.kind };
  }
  if (signal.kind === "declared_decision_point" && effective.onDeclaredDecisionPoint) {
    return { shouldOpen: true, requiresHumanDecision: true, reason: "The plan declared a decision point.", triggerKind: signal.kind };
  }
  if (signal.kind === "material_requirement_change" && effective.onMaterialRequirementChange && signal.materiality !== "low") {
    return { shouldOpen: true, requiresHumanDecision: signal.materiality === "high", reason: "A material requirement change affects the accepted scope.", triggerKind: signal.kind };
  }
  if (signal.kind === "conflicting_recommendations" && effective.onConflictingRecommendations && (signal.conflictCount ?? 0) > 0) {
    return { shouldOpen: true, requiresHumanDecision: true, reason: "Agents supplied conflicting recommendations.", triggerKind: signal.kind };
  }
  return { shouldOpen: false, requiresHumanDecision: false, reason: "The signal does not meet the configured deliberation trigger.", triggerKind: signal.kind };
}
export function defaultDeliberationTriggerPolicy(): LingAppServerDeliberationTriggerPolicyV1 {
  return { ...defaultPolicy };
}
