import {
  type CreateWorkflowHandoffIntentInput,
  type RunStore,
  type WorkflowHandoffIntent,
  type WorkflowHandoffValidation,
} from "@ling-stack/core";

export function createValidatedWorkflowHandoffIntent(input: {
  readonly store: RunStore;
  readonly intent: CreateWorkflowHandoffIntentInput;
  readonly now: string;
}): WorkflowHandoffIntent {
  const validation = validateWorkflowHandoffIntentTarget(input.store, input.intent);
  const intent = input.store.createWorkflowHandoffIntent(
    {
      ...input.intent,
      status: validation.blockers.length > 0 ? "failed" : "validated",
      validation,
    },
    input.now,
  );
  attachHandoffIntentToSourceStep(input.store, intent, input.now);
  return intent;
}

export function acceptWorkflowHandoffIntent(input: {
  readonly store: RunStore;
  readonly intentId: string;
  readonly now: string;
}): {
  readonly intent: WorkflowHandoffIntent;
} {
  const existing = input.store.getWorkflowHandoffIntent(input.intentId);
  if (!existing) {
    throw new Error(`Workflow handoff intent not found: ${input.intentId}`);
  }
  const validation = existing.validation ?? validateWorkflowHandoffIntentTarget(input.store, existing);
  if (validation.blockers.length > 0) {
    const failed = input.store.updateWorkflowHandoffIntent(existing.id, { status: "failed", validation }, input.now) ?? existing;
    attachHandoffIntentToSourceStep(input.store, failed, input.now);
    return { intent: failed };
  }

  const channelHandoff = existing.channelHandoffId
    ? input.store.getChannelHandoff(existing.channelHandoffId)
    : input.store.createChannelHandoff(
        {
          channelId: existing.channelId,
          sourceMessageId: existing.sourceMessageId,
          sourceRunId: existing.sourceRunId,
          fromParticipantId: existing.fromParticipantId,
          fromParticipantLabel: existing.fromParticipantLabel,
          toParticipantId: existing.toParticipantId,
          toParticipantLabel: existing.toParticipantLabel ?? resolveParticipantLabel(input.store, existing.toParticipantId),
          reason: existing.reason,
          requiredInput: existing.requiredInput,
          expectedOutput: existing.expectedOutput,
          status: "accepted",
          createdBy: existing.createdBy,
        },
        input.now,
      );

  const accepted = input.store.updateWorkflowHandoffIntent(
    existing.id,
    {
      channelHandoffId: channelHandoff?.id,
      toParticipantLabel: channelHandoff?.toParticipantLabel ?? existing.toParticipantLabel,
      status: "accepted",
      validation,
    },
    input.now,
  ) ?? existing;
  attachHandoffIntentToSourceStep(input.store, accepted, input.now);
  return { intent: accepted };
}

export function validateWorkflowHandoffIntentTarget(
  store: RunStore,
  intent: Pick<CreateWorkflowHandoffIntentInput, "channelId" | "toParticipantId">,
): WorkflowHandoffValidation {
  const target = store.getAiTeammate(intent.toParticipantId);
  const blockers: string[] = [];
  if (!target) {
    blockers.push(`Target teammate not found: ${intent.toParticipantId}`);
  } else if (target.status !== "active") {
    blockers.push(`Target teammate is ${target.status}.`);
  }
  const providerPreset = target?.providerPresetId ? store.getProviderPreset(target.providerPresetId) : undefined;
  if (target?.providerPresetId && !providerPreset) {
    blockers.push(`Target provider preset not found: ${target.providerPresetId}`);
  }
  return {
    targetTeammateExists: Boolean(target),
    targetTeammateActive: target?.status === "active",
    skillExecutable: true,
    providerRunnable: !target?.providerPresetId || Boolean(providerPreset),
    approvalProfileCompatible: true,
    resourceLeaseAvailable: true,
    blockers,
  };
}

function attachHandoffIntentToSourceStep(store: RunStore, intent: WorkflowHandoffIntent, now: string): void {
  if (!intent.sourceWorkflowStepId) {
    return;
  }
  const step = store.getChannelWorkflowStep(intent.sourceWorkflowStepId);
  if (!step) {
    return;
  }
  store.updateChannelWorkflowStep(
    step.id,
    {
      metadata: {
        ...step.metadata,
        handoffIntentIds: uniqueStrings([
          ...(step.metadata?.handoffIntentIds ?? []),
          intent.id,
        ]),
      },
    },
    now,
  );
}

function resolveParticipantLabel(store: RunStore, participantId: string): string {
  return store.getAiTeammate(participantId)?.displayName ?? participantId;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
