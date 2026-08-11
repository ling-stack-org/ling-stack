import {
  type CreateWorkflowHandoffIntentInput,
  type RunStore,
  type WorkflowAgentContextStamp,
  type WorkflowHandoffIntent,
  type WorkflowHandoffValidation,
} from "@ling-stack/core";
import {
  readWorkflowAgentContextFromRunSnapshot,
  readWorkflowStepContextPacketArtifact,
} from "./workflow-step-packets.js";
import {
  createWorkflowAgentContextStamp,
  privateRoleEvidenceValues,
  reviewWorkflowAgentContextStamp,
  textContainsPrivateRoleEvidence,
} from "./agent-context-consistency.js";

export function createValidatedWorkflowHandoffIntent(input: {
  readonly store: RunStore;
  readonly intent: CreateWorkflowHandoffIntentInput;
  readonly now: string;
}): WorkflowHandoffIntent {
  const resolvedContext = resolveHandoffAgentContext(input.store, input.intent);
  const validation = withContextValidationBlocker(
    validateWorkflowHandoffIntentTarget(input.store, input.intent),
    resolvedContext.blocker,
  );
  const intent = input.store.createWorkflowHandoffIntent(
    {
      ...input.intent,
      agentContext: resolvedContext.agentContext,
      status: validation.blockers.length > 0 ? "failed" : "validated",
      validation,
    },
    input.now,
  );
  attachHandoffIntentToSourceStep(input.store, intent, input.now);
  return intent;
}

function resolveHandoffAgentContext(
  store: RunStore,
  intent: CreateWorkflowHandoffIntentInput,
): HandoffAgentContextResolution {
  const sourceContext = readSourceStepAgentContext(store, intent) ?? intent.agentContext;
  if (!sourceContext) {
    return continuityBackedHandoff(store, intent)
      ? { blocker: "Continuity-backed handoff has no source agent context stamp." }
      : {};
  }
  return resolveTargetHandoffAgentContext(store, intent, sourceContext);
}

function resolveTargetHandoffAgentContext(
  store: RunStore,
  intent: Pick<CreateWorkflowHandoffIntentInput, "channelId" | "sourceWorkflowStepId" | "toParticipantId" | "reason" | "requiredInput" | "expectedOutput" | "riskSummary">,
  sourceContext: WorkflowAgentContextStamp,
): HandoffAgentContextResolution {
  const sourceItem = store.getEffectiveConversationItem(sourceContext.sourceItemId);
  if (!sourceItem || sourceItem.channelId !== intent.channelId) {
    return { blocker: "Workflow handoff agent context does not belong to the target channel." };
  }
  const privateValues = privateRoleEvidenceValues({ store, stamp: sourceContext });
  if ([intent.reason, intent.requiredInput, intent.expectedOutput, intent.riskSummary].some((value) =>
    textContainsPrivateRoleEvidence(value, privateValues))) {
    return { blocker: "Workflow handoff text repeats private role evidence." };
  }
  const reviewed = reviewWorkflowAgentContextStamp({
    store,
    dependencyWorkflowStepId: intent.sourceWorkflowStepId ?? "workflow_handoff",
    consumed: sourceContext,
  });
  if (reviewed.review.status === "rejected_stale") {
    return { blocker: `Workflow handoff source context is stale: ${reviewed.review.reason}` };
  }
  const current = reviewed.current ?? sourceContext;
  try {
    return {
      agentContext: createWorkflowAgentContextStamp({
        store,
        sourceItemId: current.sourceItemId,
        contextProjection: current.contextProjection,
        consumerTeammateId: intent.toParticipantId,
        roleEvidenceRefs: [],
      }),
    };
  } catch (error) {
    return {
      blocker: `Workflow handoff target context could not be created safely: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  const refreshedContext = refreshAcceptedHandoffAgentContext(input.store, existing);
  const validation = withContextValidationBlocker(
    validateWorkflowHandoffIntentTarget(input.store, existing),
    refreshedContext.blocker,
  );
  if (validation.blockers.length > 0) {
    const failed = input.store.updateWorkflowHandoffIntent(existing.id, {
      agentContext: refreshedContext.agentContext,
      status: "failed",
      validation,
    }, input.now) ?? existing;
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
      agentContext: refreshedContext.agentContext,
      status: "accepted",
      validation,
    },
    input.now,
  ) ?? existing;
  attachHandoffIntentToSourceStep(input.store, accepted, input.now);
  return { intent: accepted };
}

export function resolveWorkflowHandoffExecutionContext(input: {
  readonly store: RunStore;
  readonly channelHandoffId: string;
  readonly now: string;
}): {
  readonly intent?: WorkflowHandoffIntent;
  readonly sourceItemId?: string;
  readonly blocker?: string;
} {
  const linkedIntents = input.store
    .listWorkflowHandoffIntents({ channelHandoffId: input.channelHandoffId, limit: 2 });
  if (linkedIntents.length === 0) return {};
  if (linkedIntents.length > 1) {
    return { blocker: `Channel handoff is linked to multiple workflow handoff intents: ${input.channelHandoffId}` };
  }
  const refreshed = acceptWorkflowHandoffIntent({
    store: input.store,
    intentId: linkedIntents[0].id,
    now: input.now,
  }).intent;
  if (refreshed.status !== "accepted" || !refreshed.agentContext) {
    return {
      intent: refreshed,
      blocker: refreshed.validation?.blockers.join("; ") || "Workflow handoff context is not valid for execution.",
    };
  }
  return {
    intent: refreshed,
    sourceItemId: refreshed.agentContext.sourceItemId,
  };
}

interface HandoffAgentContextResolution {
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly blocker?: string;
}

function refreshAcceptedHandoffAgentContext(
  store: RunStore,
  intent: WorkflowHandoffIntent,
): HandoffAgentContextResolution {
  const sourceContext = readSourceStepAgentContext(store, intent);
  if (sourceContext) {
    const refreshed = resolveTargetHandoffAgentContext(store, intent, sourceContext);
    return refreshed.blocker?.startsWith("Workflow handoff source context is stale:")
      ? {
          agentContext: refreshed.agentContext,
          blocker: refreshed.blocker.replace(
            "Workflow handoff source context is stale:",
            "Workflow handoff context changed before acceptance:",
          ),
        }
      : refreshed;
  }
  if (!intent.agentContext) {
    return continuityBackedHandoff(store, intent)
      ? { blocker: "Continuity-backed handoff has no persisted agent context stamp." }
      : {};
  }
  const reviewed = reviewWorkflowAgentContextStamp({
    store,
    dependencyWorkflowStepId: intent.sourceWorkflowStepId ?? "workflow_handoff",
    consumed: intent.agentContext,
  });
  if (reviewed.review.status === "rejected_stale") {
    return {
      agentContext: intent.agentContext,
      blocker: `Workflow handoff context changed before acceptance: ${reviewed.review.reason}`,
    };
  }
  return { agentContext: reviewed.current ?? intent.agentContext };
}

function readSourceStepAgentContext(
  store: RunStore,
  intent: Pick<CreateWorkflowHandoffIntentInput, "sourceWorkflowStepId">,
): WorkflowAgentContextStamp | undefined {
  const step = intent.sourceWorkflowStepId
    ? store.getChannelWorkflowStep(intent.sourceWorkflowStepId)
    : undefined;
  const contextArtifactId = step?.metadata?.contextArtifactId;
  const artifactContext = contextArtifactId
    ? readWorkflowStepContextPacketArtifact({ store, artifactId: contextArtifactId })?.agentContext
    : undefined;
  if (artifactContext) return artifactContext;
  const run = step?.runId ? store.getRun(step.runId) : undefined;
  return run ? readWorkflowAgentContextFromRunSnapshot(run) : undefined;
}

function continuityBackedHandoff(
  store: RunStore,
  intent: Pick<CreateWorkflowHandoffIntentInput, "workflowId" | "sourceWorkflowStepId" | "sourceMessageId">,
): boolean {
  if (intent.sourceMessageId) return true;
  const step = intent.sourceWorkflowStepId
    ? store.getChannelWorkflowStep(intent.sourceWorkflowStepId)
    : undefined;
  const workflowId = intent.workflowId ?? step?.workflowId;
  const workflow = workflowId ? store.getChannelWorkflow(workflowId) : undefined;
  return Boolean(step?.metadata?.sourceMessageId ?? workflow?.metadata?.sourceMessageId);
}

function withContextValidationBlocker(
  validation: WorkflowHandoffValidation,
  blocker: string | undefined,
): WorkflowHandoffValidation {
  return blocker
    ? { ...validation, blockers: [...new Set([...validation.blockers, blocker])] }
    : validation;
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
