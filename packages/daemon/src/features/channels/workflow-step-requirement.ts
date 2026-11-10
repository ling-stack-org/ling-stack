import type {
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunStore,
} from "@ling-stack/core";
import {
  delegatedStepRequirementFingerprintV1,
  isChannelIntentExecutionPlanV1,
  type DelegatedEvidenceRefKindV1,
  type DelegatedStepRequirementV1,
  type RequiredParticipantManifestV1,
  type RequiredParticipantV1,
} from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";

export function materializeWorkflowDelegatedStepRequirements(input: {
  readonly store: RunStore;
  readonly workflow: ChannelWorkflow;
  readonly manifest: RequiredParticipantManifestV1;
  readonly now: string;
}): readonly ChannelWorkflowStep[] {
  const steps = input.store.listChannelWorkflowSteps({ workflowId: input.workflow.id, complete: true });
  const participants = new Map(input.manifest.participants.map((participant) => [participant.participantId, participant]));
  const stepsByParticipant = new Map<string, ChannelWorkflowStep[]>();
  for (const step of steps) {
    const participant = participants.get(step.toParticipantId);
    if (!participant) {
      throw new HttpError(
        409,
        "required_participant_missing",
        `Workflow step ${step.id} is owned by a participant outside the accepted manifest: ${step.toParticipantId}.`,
      );
    }
    if (participant.expectedOutcome === "discussion_reply") {
      throw new HttpError(
        409,
        "delegated_requirement_invalid",
        `Workflow step ${step.id} cannot use discussion_reply as a delegated outcome.`,
      );
    }
    const owned = stepsByParticipant.get(participant.participantId) ?? [];
    owned.push(step);
    stepsByParticipant.set(participant.participantId, owned);
  }
  for (const participant of input.manifest.participants.filter((candidate) => candidate.requirement === "required")) {
    if (!(stepsByParticipant.get(participant.participantId)?.length)) {
      throw new HttpError(
        409,
        "required_participant_missing",
        `Accepted participant has no workflow step: ${participant.participantId}.`,
      );
    }
  }
  for (const participant of input.manifest.participants) {
    assertParticipantOperationOwnership(participant, stepsByParticipant.get(participant.participantId) ?? []);
  }
  return steps.map((step) => {
    const participant = participants.get(step.toParticipantId)!;
    const requirement = createDelegatedStepRequirement({
      workflow: input.workflow,
      step,
      participant,
      manifestFingerprint: input.manifest.fingerprint,
    });
    return input.store.updateChannelWorkflowStep(step.id, {
      metadata: {
        ...step.metadata,
        delegatedRequirement: requirement,
        delegatedOutcome: {
          kind: "workflow_started",
          workflowId: input.workflow.id,
          participantManifestFingerprint: input.manifest.fingerprint,
        },
      },
    }, input.now) ?? step;
  });
}

export function createDelegatedStepRequirement(input: {
  readonly workflow: Pick<ChannelWorkflow, "id">;
  readonly step: ChannelWorkflowStep;
  readonly participant: RequiredParticipantV1;
  readonly manifestFingerprint: string;
}): DelegatedStepRequirementV1 {
  if (input.participant.expectedOutcome === "discussion_reply") {
    throw new Error("A delegated workflow step cannot require discussion_reply.");
  }
  const acceptedEvidenceKinds: readonly DelegatedEvidenceRefKindV1[] = input.participant.expectedOutcome === "synthesis"
    ? ["workflow_output_packet"]
    : ["execution_action"];
  const plan = input.step.metadata?.executionPlan;
  const typed = plan?.bindingVersion !== undefined || plan?.operations.some((operation) => operation.binding !== undefined);
  if (typed && (!isChannelIntentExecutionPlanV1(plan) || plan.bindingVersion !== 1)) {
    throw new HttpError(409, "operation_binding_fingerprint_invalid", "Cannot materialize a requirement from an invalid typed operation plan.");
  }
  const value: Omit<DelegatedStepRequirementV1, "fingerprint"> = {
    schemaVersion: 1,
    workflowId: input.workflow.id,
    workflowStepId: input.step.id,
    participantId: input.step.toParticipantId,
    participantManifestFingerprint: input.manifestFingerprint,
    ...(typed ? { executionPlanFingerprint: plan!.fingerprint } : {}),
    expectedOutcome: input.participant.expectedOutcome,
    requiredOperationIds: [...(input.step.metadata?.executionOperationIds ?? [])].sort(),
    requiredDependencyStepIds: [...(input.step.metadata?.dependsOnStepIds ?? [])].sort(),
    acceptedEvidenceKinds,
  };
  return { ...value, fingerprint: delegatedStepRequirementFingerprintV1(value) };
}

function assertParticipantOperationOwnership(
  participant: RequiredParticipantV1,
  steps: readonly ChannelWorkflowStep[],
): void {
  const expected = [...participant.requiredOperationIds].sort();
  const actual = [...new Set(steps.flatMap((step) => step.metadata?.executionOperationIds ?? []))].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new HttpError(
      409,
      "required_participant_operation_mismatch",
      `Participant ${participant.participantId} operation ownership changed. Required: ${expected.join(", ") || "none"}; actual: ${actual.join(", ") || "none"}.`,
    );
  }
}
