import type {
  ChannelHandoff,
  ChannelHandoffStatus,
  WorkflowHandoffIntent,
  WorkflowHandoffIntentStatus,
  WorkflowHandoffValidation,
  WorkflowAgentContextStamp,
  WorkflowPacketSourceRef,
} from "./workspace-types.js";

export type LingHandoffIntentSourceKind = "channel_handoff" | "workflow_handoff_intent";

export type LingHandoffIntentStatus = ChannelHandoffStatus | WorkflowHandoffIntentStatus;

export interface LingHandoffParticipant {
  readonly id: string;
  readonly label: string;
}

export interface LingHandoffInputPacket {
  readonly schemaVersion: 1;
  readonly intentId: string;
  readonly sourceKind: LingHandoffIntentSourceKind;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
}

export interface LingHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceKind: LingHandoffIntentSourceKind;
  readonly sourceId: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly from: LingHandoffParticipant;
  readonly to: LingHandoffParticipant;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly status: LingHandoffIntentStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly inputPacket: LingHandoffInputPacket;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NormalizeLingHandoffIntentsInput {
  readonly channelHandoffs?: readonly ChannelHandoff[];
  readonly workflowHandoffIntents?: readonly WorkflowHandoffIntent[];
}

export function normalizeChannelHandoffToLingIntent(handoff: ChannelHandoff): LingHandoffIntent {
  const sourceRefs = sourceRefsFromChannelHandoff(handoff);
  return {
    schemaVersion: 1,
    id: `channel_handoff:${handoff.id}`,
    sourceKind: "channel_handoff",
    sourceId: handoff.id,
    workspaceId: handoff.workspaceId,
    channelId: handoff.channelId,
    sourceRunId: handoff.sourceRunId,
    sourceMessageId: handoff.sourceMessageId,
    channelHandoffId: handoff.id,
    from: {
      id: handoff.fromParticipantId,
      label: handoff.fromParticipantLabel,
    },
    to: {
      id: handoff.toParticipantId,
      label: handoff.toParticipantLabel,
    },
    reason: handoff.reason,
    requiredInput: handoff.requiredInput,
    expectedOutput: handoff.expectedOutput,
    status: handoff.status,
    sourceRefs,
    inputPacket: {
      schemaVersion: 1,
      intentId: `channel_handoff:${handoff.id}`,
      sourceKind: "channel_handoff",
      channelId: handoff.channelId,
      sourceRunId: handoff.sourceRunId,
      sourceMessageId: handoff.sourceMessageId,
      channelHandoffId: handoff.id,
      requiredInput: handoff.requiredInput,
      expectedOutput: handoff.expectedOutput,
      sourceRefs,
    },
    createdBy: handoff.createdBy,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
  };
}

export function normalizeWorkflowHandoffIntentToLingIntent(intent: WorkflowHandoffIntent): LingHandoffIntent {
  const sourceRefs = mergeSourceRefs(intent.sourceRefs, sourceRefsFromWorkflowHandoffIntent(intent));
  return {
    schemaVersion: 1,
    id: `workflow_handoff_intent:${intent.id}`,
    sourceKind: "workflow_handoff_intent",
    sourceId: intent.id,
    workspaceId: intent.workspaceId,
    channelId: intent.channelId,
    workflowId: intent.workflowId,
    sourceWorkflowStepId: intent.sourceWorkflowStepId,
    sourceRunId: intent.sourceRunId,
    sourceMessageId: intent.sourceMessageId,
    channelHandoffId: intent.channelHandoffId,
    from: {
      id: intent.fromParticipantId,
      label: intent.fromParticipantLabel,
    },
    to: {
      id: intent.toParticipantId,
      label: intent.toParticipantLabel ?? intent.toParticipantId,
    },
    reason: intent.reason,
    requiredInput: intent.requiredInput,
    expectedOutput: intent.expectedOutput,
    riskSummary: intent.riskSummary,
    status: intent.status,
    sourceRefs,
    agentContext: intent.agentContext,
    inputPacket: {
      schemaVersion: 1,
      intentId: `workflow_handoff_intent:${intent.id}`,
      sourceKind: "workflow_handoff_intent",
      channelId: intent.channelId,
      workflowId: intent.workflowId,
      sourceWorkflowStepId: intent.sourceWorkflowStepId,
      sourceRunId: intent.sourceRunId,
      sourceMessageId: intent.sourceMessageId,
      channelHandoffId: intent.channelHandoffId,
      requiredInput: intent.requiredInput,
      expectedOutput: intent.expectedOutput,
      sourceRefs,
      agentContext: intent.agentContext,
    },
    validation: intent.validation,
    createdBy: intent.createdBy,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
  };
}

export function normalizeLingHandoffIntents(input: NormalizeLingHandoffIntentsInput): LingHandoffIntent[] {
  return [
    ...(input.channelHandoffs ?? []).map(normalizeChannelHandoffToLingIntent),
    ...(input.workflowHandoffIntents ?? []).map(normalizeWorkflowHandoffIntentToLingIntent),
  ].sort((left, right) => {
    const updated = right.updatedAt.localeCompare(left.updatedAt);
    if (updated !== 0) {
      return updated;
    }
    return right.id.localeCompare(left.id);
  });
}

function sourceRefsFromChannelHandoff(handoff: ChannelHandoff): WorkflowPacketSourceRef[] {
  return mergeSourceRefs([
    handoff.sourceMessageId ? { type: "channel_message", id: handoff.sourceMessageId, label: "source message" } : undefined,
    handoff.sourceTaskId ? { type: "task", id: handoff.sourceTaskId, label: "source task" } : undefined,
    handoff.sourceRunId ? { type: "run", id: handoff.sourceRunId, label: "source run" } : undefined,
  ]);
}

function sourceRefsFromWorkflowHandoffIntent(intent: WorkflowHandoffIntent): WorkflowPacketSourceRef[] {
  return mergeSourceRefs([
    intent.sourceMessageId ? { type: "channel_message", id: intent.sourceMessageId, label: "source message" } : undefined,
    intent.sourceRunId ? { type: "run", id: intent.sourceRunId, label: "source run" } : undefined,
    intent.workflowId ? { type: "workflow", id: intent.workflowId, label: "workflow" } : undefined,
    intent.sourceWorkflowStepId ? { type: "workflow_step", id: intent.sourceWorkflowStepId, label: "source workflow step" } : undefined,
  ]);
}

function mergeSourceRefs(
  ...groups: readonly (readonly (WorkflowPacketSourceRef | undefined)[] | undefined)[]
): WorkflowPacketSourceRef[] {
  const result: WorkflowPacketSourceRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      if (!ref) {
        continue;
      }
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      result.push(ref);
    }
  }
  return result;
}
