import { createProcedureObservationInputFromJob, type RunStore, type LearningReviewJob } from "@ling-stack/core";
import type { LearningDraft } from "./extractor.js";

/** Propose in the existing channel review surface. No override, activation or workflow execution. */
export function createScopedLearningCandidate(store: RunStore, job: LearningReviewJob,
  draft: Extract<LearningDraft, { readonly kind: "procedure" }>, now: string): string {
  if (!job.evidence.channelId) throw new Error("learning_destination_scope_invalid");
  const channel = store.getChannel(job.evidence.channelId);
  if (!channel || channel.status === "archived" || channel.workspaceId !== job.workspaceId) throw new Error("learning_destination_scope_invalid");
  const built = createProcedureObservationInputFromJob({ source: "explicit_user_request", signals: ["save_as_skill"],
    workspaceId: job.workspaceId, runId: job.evidence.runId, taskId: job.evidence.taskId, channelId: channel.id,
    evidenceVersion: job.evidence.digest, effectiveAttemptId: job.evidence.sourceAttemptId, userConfirmed: job.mode === "explicit",
    destinationHint: draft.destination, title: draft.title, summary: draft.summary, normalizedGoal: draft.title,
    positiveTriggers: draft.appliesWhen, negativeTriggers: draft.doesNotApplyWhen,
    procedureSteps: draft.steps.map((step, i) => ({ title: `Step ${i + 1}`, instruction: step.instruction,
      expectedEvidence: `${step.evidence.evidenceId}: ${step.evidence.quote}` })),
    validationSteps: draft.checks.map(check => ({ title: check.check, commandOrCheck: check.check, expectedResult: check.expected })),
  });
  const observation = store.createProcedureObservation(built.observationInput, now);
  if (observation.routeKind === "reject" || observation.routeKind === "approval_policy_review" || observation.routeBlockers.length > 0) throw new Error("learning_procedure_blocked");
  if (draft.destination === "playbook") {
    return store.createChannelPlaybookCandidate({ channelId: channel.id, title: draft.title, summary: draft.summary,
      normalizedGoal: draft.title, procedureSteps: observation.procedureSteps, validationSteps: observation.validationSteps,
      positiveTriggers: [...draft.appliesWhen, ...draft.prerequisites.map(value => `Prerequisite: ${value}`)],
      negativeTriggers: draft.doesNotApplyWhen, sourceRefs: observation.sourceRefs,
      reason: `Learning review ${job.id}; evidence checked, not runtime validated`, createdBy: "ai-draft" }, now).id;
  }
  const current = store.getChannelCollaborationProtocolOverride(channel.id);
  return store.createChannelCollaborationProtocolDraft({ channelId: channel.id, baseVersion: current?.version,
    proposedPatch: { reviewRules: [...(current?.reviewRules ?? []),
      `${draft.title}: ${draft.summary}`, ...draft.appliesWhen.map(value => `Apply when: ${value}`),
      ...draft.doesNotApplyWhen.map(value => `Do not apply when: ${value}`),
      ...draft.prerequisites.map(value => `Prerequisite: ${value}`), ...draft.steps.map(step => step.instruction),
      ...draft.checks.map(check => `Verify: ${check.check}; expected ${check.expected}`)] },
    reason: `Learning review ${job.id}; propose a scoped method for review`, createdBy: "ai-draft",
    sourceRefs: [{ type: job.evidence.decisionId ? "channel_decision" : "run", id: job.evidence.decisionId ?? job.evidence.runId!, label: `Evidence ${job.evidence.digest}` }],
  }, now).id;
}
