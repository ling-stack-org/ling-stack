import type { ChannelWorkflowStep, ChannelWorkflowStepContextPacket } from "@ling-stack/core";

export type WorkflowContextInspectAvailability =
  | "available"
  | "missing_context_artifact"
  | "unreadable_context_packet"
  | "missing_context_pack";

export interface WorkflowContextInspectSummary {
  readonly schemaVersion: 1;
  readonly availability: WorkflowContextInspectAvailability;
  readonly contextArtifactId?: string;
  readonly generatedAt?: string;
  readonly kind?: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget?: {
    readonly mode: string;
    readonly inputBudgetTokens: number;
    readonly estimatedInputTokens: number;
    readonly overBudget: boolean;
    readonly tokenizer?: string;
    readonly capabilitySource?: string;
    readonly capabilityConfidence?: string;
  };
  readonly sectionCount: number;
  readonly sourceRefCount: number;
  readonly droppedSectionCount: number;
  readonly compactionCount: number;
  readonly sections: readonly {
    readonly id: string;
    readonly role: string;
    readonly priority: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds: readonly string[];
    readonly metadataKeys: readonly string[];
  }[];
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sourceRefs: readonly {
    readonly type: string;
    readonly id: string;
    readonly label?: string;
  }[];
  readonly safety: {
    readonly rawPromptTextIncluded: false;
    readonly rawLogsIncluded: false;
    readonly rawArtifactBodiesIncluded: false;
  };
}

export function buildWorkflowContextInspectSummary(input: {
  readonly step: ChannelWorkflowStep;
  readonly contextPacket?: ChannelWorkflowStepContextPacket;
  readonly contextArtifactMissing?: boolean;
  readonly contextPacketUnreadable?: boolean;
}): WorkflowContextInspectSummary {
  const contextArtifactId = input.step.metadata?.contextArtifactId;
  if (!contextArtifactId || input.contextArtifactMissing) {
    return emptyInspectSummary("missing_context_artifact");
  }
  if (!input.contextPacket) {
    return emptyInspectSummary(input.contextPacketUnreadable ? "unreadable_context_packet" : "missing_context_pack", contextArtifactId);
  }
  const pack = input.contextPacket.contextPack;
  if (!pack) {
    return emptyInspectSummary("missing_context_pack", contextArtifactId, input.contextPacket.generatedAt);
  }
  return {
    schemaVersion: 1,
    availability: "available",
    contextArtifactId,
    generatedAt: input.contextPacket.generatedAt,
    kind: pack.kind,
    providerPresetId: pack.providerPresetId,
    modelId: pack.modelId,
    budget: {
      mode: pack.budget.mode,
      inputBudgetTokens: pack.budget.inputBudgetTokens,
      estimatedInputTokens: pack.estimatedInputTokens,
      overBudget: pack.overBudget,
      tokenizer: pack.budget.tokenizer,
      capabilitySource: pack.budget.capabilitySource,
      capabilityConfidence: pack.budget.capabilityConfidence,
    },
    sectionCount: pack.sections.length,
    sourceRefCount: pack.sourceRefs.length,
    droppedSectionCount: pack.droppedSectionIds.length,
    compactionCount: pack.compactionIds.length,
    sections: pack.sections.map((section) => ({
      id: section.id,
      role: section.role,
      priority: section.priority,
      estimatedTokens: section.estimatedTokens,
      sourceRefIds: section.sourceRefIds ?? [],
      metadataKeys: section.metadata ? Object.keys(section.metadata).sort() : [],
    })),
    droppedSectionIds: pack.droppedSectionIds,
    compactionIds: pack.compactionIds,
    sourceRefs: pack.sourceRefs.map((ref) => ({
      type: ref.type,
      id: ref.id,
      label: ref.label,
    })),
    safety: inspectSafety(),
  };
}

function emptyInspectSummary(
  availability: Exclude<WorkflowContextInspectAvailability, "available">,
  contextArtifactId?: string,
  generatedAt?: string,
): WorkflowContextInspectSummary {
  return {
    schemaVersion: 1,
    availability,
    contextArtifactId,
    generatedAt,
    sectionCount: 0,
    sourceRefCount: 0,
    droppedSectionCount: 0,
    compactionCount: 0,
    sections: [],
    droppedSectionIds: [],
    compactionIds: [],
    sourceRefs: [],
    safety: inspectSafety(),
  };
}

function inspectSafety(): WorkflowContextInspectSummary["safety"] {
  return {
    rawPromptTextIncluded: false,
    rawLogsIncluded: false,
    rawArtifactBodiesIncluded: false,
  };
}
