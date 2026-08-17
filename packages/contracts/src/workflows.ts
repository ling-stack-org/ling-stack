import type { ApprovalRequest, LingApprovalCheckpoint, SkillApprovalProfile } from "./approvals.js";
import type { ExecutionAction } from "./execution-actions.js";
import type { RunArtifact } from "./artifacts.js";
import type { ChannelExecutionProposal, ChannelExecutionProposalStepSource, ChannelHandoff } from "./channels.js";
import type { MemoryObject } from "./memory.js";
import type { RunSession, RunnerFallbackReason, RunnerRequestSource } from "./runtime.js";
import type { ResponseLanguage } from "./settings.js";
import type { RunTool } from "./shared.js";
import type { WorkflowParticipantProviderBindingV1 } from "./conversation-model-binding.js";
import type { Task } from "./tasks.js";
import type {
  ChannelIntentExecutionPlanV1,
  ConversationContextProjectionMetadata,
  RequiredParticipantManifestV1,
} from "./conversation-continuity.js";

export type WorkflowParticipantAuthorityKindV1 = "channel_selection" | "workflow_definition";

export type WorkflowParticipantAuthorityOriginV1 =
  | "channel_intent_proposal"
  | "builtin_template"
  | "custom_template"
  | "workflow_graph"
  | "channel_handoff"
  | "external_work"
  | "proposed_plan"
  | "manual_channel_step"
  | "legacy_migration";

export interface WorkflowParticipantAuthorityV1 {
  readonly schemaVersion: 1;
  readonly kind: WorkflowParticipantAuthorityKindV1;
  readonly origin: WorkflowParticipantAuthorityOriginV1;
  readonly participantId: string;
  readonly sourceId: string;
  readonly fingerprint: string;
}

export function createWorkflowParticipantAuthorityV1(input: {
  readonly kind: WorkflowParticipantAuthorityKindV1;
  readonly origin: WorkflowParticipantAuthorityOriginV1;
  readonly participantId: string;
  readonly sourceId: string;
}): WorkflowParticipantAuthorityV1 {
  const base = {
    schemaVersion: 1 as const,
    kind: input.kind,
    origin: input.origin,
    participantId: input.participantId,
    sourceId: input.sourceId,
  };
  return {
    ...base,
    fingerprint: workflowFingerprint("wpa1", base),
  };
}

export function isWorkflowParticipantAuthorityV1(value: unknown): value is WorkflowParticipantAuthorityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1
    || (record.kind !== "channel_selection" && record.kind !== "workflow_definition")
    || typeof record.origin !== "string"
    || typeof record.participantId !== "string"
    || record.participantId.trim().length === 0
    || typeof record.sourceId !== "string"
    || record.sourceId.trim().length === 0
    || typeof record.fingerprint !== "string"
    || !Object.keys(record).every((key) => ["schemaVersion", "kind", "origin", "participantId", "sourceId", "fingerprint"].includes(key))) {
    return false;
  }
  const origins: readonly WorkflowParticipantAuthorityOriginV1[] = [
    "channel_intent_proposal",
    "builtin_template",
    "custom_template",
    "workflow_graph",
    "channel_handoff",
    "external_work",
    "proposed_plan",
    "manual_channel_step",
    "legacy_migration",
  ];
  if (!origins.includes(record.origin as WorkflowParticipantAuthorityOriginV1)) return false;
  const channelSelectionOrigins: readonly WorkflowParticipantAuthorityOriginV1[] = [
    "channel_intent_proposal",
    "manual_channel_step",
    "legacy_migration",
  ];
  const workflowDefinitionOrigins: readonly WorkflowParticipantAuthorityOriginV1[] = [
    "builtin_template",
    "custom_template",
    "workflow_graph",
    "channel_handoff",
    "external_work",
    "proposed_plan",
  ];
  const validKindOrigin = record.kind === "channel_selection"
    ? channelSelectionOrigins.includes(record.origin as WorkflowParticipantAuthorityOriginV1)
    : workflowDefinitionOrigins.includes(record.origin as WorkflowParticipantAuthorityOriginV1);
  if (!validKindOrigin) return false;
  const base = {
    schemaVersion: 1 as const,
    kind: record.kind as WorkflowParticipantAuthorityKindV1,
    origin: record.origin as WorkflowParticipantAuthorityOriginV1,
    participantId: record.participantId as string,
    sourceId: record.sourceId as string,
  };
  return record.fingerprint === workflowFingerprint("wpa1", base);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isDelegatedEvidenceRefV1(value: unknown): value is DelegatedEvidenceRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === "kind" || key === "id")
    && delegatedEvidenceRefKindsV1.includes(record.kind as DelegatedEvidenceRefKindV1)
    && isNonEmptyText(record.id);
}

export function isDelegatedOutcomeV1(value: unknown): value is DelegatedOutcomeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const evidenceRefsValid = (refs: unknown): refs is readonly DelegatedEvidenceRefV1[] =>
    Array.isArray(refs) && refs.every(isDelegatedEvidenceRefV1)
      && new Set(refs.map((ref) => `${ref.kind}:${ref.id}`)).size === refs.length;
  if (record.kind === "completed") {
    return isNonEmptyText(record.participantId)
      && evidenceRefsValid(record.evidenceRefs)
      && record.evidenceRefs.length > 0
      && Object.keys(record).every((key) => key === "kind" || key === "participantId" || key === "evidenceRefs");
  }
  if (record.kind === "workflow_started") {
    return isNonEmptyText(record.workflowId)
      && isNonEmptyText(record.participantManifestFingerprint)
      && Object.keys(record).every((key) => key === "kind" || key === "workflowId" || key === "participantManifestFingerprint");
  }
  if (record.kind === "blocked") {
    return (record.participantId === undefined || isNonEmptyText(record.participantId))
      && isNonEmptyText(record.code)
      && isNonEmptyText(record.reason)
      && Array.isArray(record.missingRequirements)
      && record.missingRequirements.every(isNonEmptyText)
      && (record.evidenceRefs === undefined || evidenceRefsValid(record.evidenceRefs))
      && Object.keys(record).every((key) => ["kind", "participantId", "code", "reason", "missingRequirements", "evidenceRefs"].includes(key));
  }
  if (record.kind === "failed" || record.kind === "cancelled") {
    return (record.participantId === undefined || isNonEmptyText(record.participantId))
      && isNonEmptyText(record.code)
      && isNonEmptyText(record.reason)
      && evidenceRefsValid(record.evidenceRefs)
      && Object.keys(record).every((key) => ["kind", "participantId", "code", "reason", "evidenceRefs"].includes(key));
  }
  return false;
}

export function workflowGraphFingerprintV1(graph: WorkflowGraph): string {
  return workflowFingerprint("wgfv1", {
    schemaVersion: graph.schemaVersion,
    id: graph.id,
    entryNodeId: graph.entryNodeId,
    nodes: [...graph.nodes].map((node) => ({
      id: node.id,
      kind: node.kind,
      teammateId: node.teammateId,
      teammateTemplateId: node.teammateTemplateId,
      councilSlotKey: node.councilSlotKey,
      providerPresetId: node.providerPresetId,
      providerBinding: node.providerBinding,
      requiredTools: [...(node.requiredTools ?? [])].sort(),
      branchGroupId: node.branchGroupId,
      joinGroupId: node.joinGroupId,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...graph.edges].map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      condition: edge.condition.kind,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    termination: graph.termination,
  });
}

export function workflowCompletionBasisFingerprintV1(value: unknown): string {
  return workflowFingerprint("wcbv1", value);
}

export function delegatedStepRequirementFingerprintV1(
  value: Omit<DelegatedStepRequirementV1, "fingerprint">,
): string {
  return workflowFingerprint("dsrv1", {
    schemaVersion: value.schemaVersion,
    workflowId: value.workflowId,
    workflowStepId: value.workflowStepId,
    participantId: value.participantId,
    participantManifestFingerprint: value.participantManifestFingerprint,
    expectedOutcome: value.expectedOutcome,
    requiredOperationIds: [...value.requiredOperationIds].sort(),
    requiredDependencyStepIds: [...value.requiredDependencyStepIds].sort(),
    acceptedEvidenceKinds: [...value.acceptedEvidenceKinds].sort(),
  });
}

export function delegatedStepFinalizationBasisFingerprintV1(value: unknown): string {
  return workflowFingerprint("dsbv1", value);
}

function workflowFingerprint(prefix: string, value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `${prefix}_${hash.toString(16).padStart(16, "0")}`;
}

export function isWorkflowCompletionGateV1(value: unknown): value is WorkflowCompletionGateV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => [
    "schemaVersion", "status", "sourceIntentDecisionId", "participantManifestFingerprint",
    "graphFingerprint", "basisFingerprint", "participantResults", "checkedAt",
  ].includes(key))
    || record.schemaVersion !== 1
    || !["pending", "verified", "blocked", "failed", "cancelled"].includes(String(record.status))
    || !isNonEmptyText(record.sourceIntentDecisionId)
    || !isNonEmptyText(record.participantManifestFingerprint)
    || !isNonEmptyText(record.graphFingerprint)
    || !isNonEmptyText(record.basisFingerprint)
    || !isNonEmptyText(record.checkedAt)
    || !Number.isFinite(Date.parse(record.checkedAt))
    || !Array.isArray(record.participantResults)) return false;
  const ids = new Set<string>();
  for (const result of record.participantResults) {
    if (!result || typeof result !== "object" || Array.isArray(result)) return false;
    const item = result as Record<string, unknown>;
    if (!Object.keys(item).every((key) => [
      "participantId", "workflowStepIds", "status", "evidenceRefs", "reasonCode",
    ].includes(key))
      || !isNonEmptyText(item.participantId)
      || ids.has(item.participantId)
      || !Array.isArray(item.workflowStepIds)
      || !item.workflowStepIds.every(isNonEmptyText)
      || !["satisfied", "missing", "blocked", "failed", "cancelled"].includes(String(item.status))
      || !Array.isArray(item.evidenceRefs)
      || !item.evidenceRefs.every(isDelegatedEvidenceRefV1)
      || (item.reasonCode !== undefined && !isNonEmptyText(item.reasonCode))) return false;
    ids.add(item.participantId);
  }
  return true;
}

export function isDelegatedStepRequirementV1(value: unknown): value is DelegatedStepRequirementV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every((key) => [
    "schemaVersion", "workflowId", "workflowStepId", "participantId",
    "participantManifestFingerprint", "expectedOutcome", "requiredOperationIds",
    "requiredDependencyStepIds", "acceptedEvidenceKinds", "fingerprint",
  ].includes(key))
    || record.schemaVersion !== 1
    || !isNonEmptyText(record.workflowId)
    || !isNonEmptyText(record.workflowStepId)
    || !isNonEmptyText(record.participantId)
    || !isNonEmptyText(record.participantManifestFingerprint)
    || !["execution", "verification", "synthesis"].includes(String(record.expectedOutcome))
    || !isUniqueNonEmptyTextArray(record.requiredOperationIds)
    || !isUniqueNonEmptyTextArray(record.requiredDependencyStepIds)
    || !Array.isArray(record.acceptedEvidenceKinds)
    || record.acceptedEvidenceKinds.length === 0
    || !record.acceptedEvidenceKinds.every((kind) => delegatedEvidenceRefKindsV1.includes(kind as DelegatedEvidenceRefKindV1))
    || new Set(record.acceptedEvidenceKinds).size !== record.acceptedEvidenceKinds.length
    || !isNonEmptyText(record.fingerprint)) return false;
  return record.fingerprint === delegatedStepRequirementFingerprintV1({
    schemaVersion: 1,
    workflowId: record.workflowId,
    workflowStepId: record.workflowStepId,
    participantId: record.participantId,
    participantManifestFingerprint: record.participantManifestFingerprint,
    expectedOutcome: record.expectedOutcome as DelegatedStepRequirementV1["expectedOutcome"],
    requiredOperationIds: record.requiredOperationIds,
    requiredDependencyStepIds: record.requiredDependencyStepIds,
    acceptedEvidenceKinds: record.acceptedEvidenceKinds as DelegatedStepRequirementV1["acceptedEvidenceKinds"],
  });
}

function isUniqueNonEmptyTextArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every(isNonEmptyText)
    && new Set(value).size === value.length;
}

export type ChannelWorkflowStatus =
  | "draft"
  | "ready"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ChannelWorkflowStepStatus =
  | "queued"
  | "claimed"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type ChannelWorkflowStepStartMode = "create_task" | "create_and_run_task";

export type WorkflowStepFailurePolicy =
  | "block_for_user"
  | "fail_workflow"
  | "cancel_workflow"
  | "skip_if_optional";

export interface WorkflowStepPolicy {
  readonly onRunFailed: WorkflowStepFailurePolicy;
  readonly onRunCancelled: WorkflowStepFailurePolicy;
  readonly onApprovalDenied: WorkflowStepFailurePolicy;
  readonly retryable: boolean;
  readonly maxRetries?: number;
}

export interface WorkflowStepGate {
  readonly stage: "pre" | "post";
  readonly approvalProfile: SkillApprovalProfile;
  readonly title: string;
  readonly reason: string;
  readonly requiredForStatuses?: readonly ChannelWorkflowStepStatus[];
}

export type WorkflowFanInMode =
  | "summarize_outputs"
  | "compare_outputs"
  | "collect_checks"
  | "memory_candidates";

export interface WorkflowFanInPolicy {
  readonly mode: WorkflowFanInMode;
  readonly requireAllBranchesTerminal: boolean;
  readonly includeFailedBranches: boolean;
  readonly createSummaryArtifact: boolean;
  readonly createMemoryCandidates: boolean;
  readonly memoryCandidateScope: "run" | "task" | "channel";
  readonly maxInputArtifacts: number;
}

export interface RunnerResolutionAudit {
  readonly requestedRunnerId: string;
  readonly effectiveRunnerId: string;
  readonly requestSource?: RunnerRequestSource;
  readonly fallbackAllowed?: boolean;
  readonly fallbackReason?: RunnerFallbackReason;
}

export interface WorkflowStepOutputRef {
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly outputArtifactId?: string;
  readonly artifactIds: readonly string[];
  readonly branchGroupId?: string;
}

export type WorkflowPacketSourceRefType =
  | "channel_message"
  | "channel_brief"
  | "channel_decision"
  | "context_summary"
  | "task"
  | "run"
  | "workflow"
  | "workflow_step"
  | "workflow_handoff_intent"
  | "workflow_selector_decision"
  | "artifact"
  | "approval"
  | "memory";

export interface WorkflowPacketSourceRef {
  readonly type: WorkflowPacketSourceRefType;
  readonly id: string;
  readonly label?: string;
}

export interface WorkflowAgentContextStamp {
  readonly schemaVersion: 1;
  readonly sourceItemId: string;
  readonly consumerTeammateId?: string;
  readonly contextProjection: ConversationContextProjectionMetadata;
  readonly roleEvidenceRefs: readonly WorkflowPacketSourceRef[];
  readonly roleEvidenceFingerprint: string;
}

export type WorkflowFanInContextReviewStatus =
  | "accepted_current"
  | "rebased_metadata"
  | "rejected_stale"
  | "rejected_private_leak";

export interface WorkflowFanInContextReview {
  readonly dependencyWorkflowStepId: string;
  readonly status: WorkflowFanInContextReviewStatus;
  readonly consumedProjectionVersion?: string;
  readonly currentProjectionVersion?: string;
  readonly reason: string;
}

export type WorkflowHandoffIntentStatus =
  | "proposed"
  | "validated"
  | "accepted"
  | "declined"
  | "converted"
  | "failed";

export type WorkflowHandoffIntentCreatedBy = "local-user" | "ai-teammate" | "orchestrator";

export interface WorkflowHandoffValidation {
  readonly targetTeammateExists: boolean;
  readonly targetTeammateActive: boolean;
  readonly skillExecutable: boolean;
  readonly providerRunnable: boolean;
  readonly approvalProfileCompatible: boolean;
  readonly resourceLeaseAvailable: boolean;
  readonly blockers: readonly string[];
}

export interface WorkflowHandoffIntent {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId?: string;
  readonly sourceWorkflowStepId?: string;
  readonly sourceRunId?: string;
  readonly sourceMessageId?: string;
  readonly channelHandoffId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel?: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly riskSummary?: string;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly status: WorkflowHandoffIntentStatus;
  readonly validation?: WorkflowHandoffValidation;
  readonly createdBy: WorkflowHandoffIntentCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkflowSelectorDecisionStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "blocked"
  | "superseded";

export type WorkflowSelectorTargetKind =
  | "workflow_step"
  | "graph_node"
  | "teammate"
  | "skill"
  | "handoff"
  | "wait";

export type WorkflowSelectorDecisionCreatedBy = "deterministic" | "model" | "local-user";

export interface WorkflowSelectorAlternative {
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly targetId: string;
  readonly label: string;
  readonly reason: string;
}

export interface WorkflowSelectorDecision {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceWorkflowStepId?: string;
  readonly selectorNodeId?: string;
  readonly targetKind: WorkflowSelectorTargetKind;
  readonly selectedWorkflowStepId?: string;
  readonly selectedGraphNodeId?: string;
  readonly selectedTeammateId?: string;
  readonly selectedSkillId?: string;
  readonly selectedHandoffIntentId?: string;
  readonly reason: string;
  readonly alternativesConsidered: readonly WorkflowSelectorAlternative[];
  readonly confidence: "low" | "medium" | "high";
  readonly requiresUserConfirmation: boolean;
  readonly status: WorkflowSelectorDecisionStatus;
  readonly sourceRefs: readonly WorkflowPacketSourceRef[];
  readonly createdBy: WorkflowSelectorDecisionCreatedBy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelWorkflowStepContextPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly objective: string;
  readonly stepTitle: string;
  readonly stepPrompt: string;
  readonly dependencies: readonly WorkflowStepOutputRef[];
  readonly priorOutputArtifactIds: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly approvalGate?: SkillApprovalProfile;
  readonly contextPack?: WorkflowStepContextPackSnapshot;
  readonly generatedAt: string;
}

export interface WorkflowStepContextPackSnapshot {
  readonly kind: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget: {
    readonly mode: string;
    readonly contextWindowTokens: number;
    readonly reservedOutputTokens: number;
    readonly reservedRuntimeOverheadTokens: number;
    readonly inputBudgetTokens: number;
    readonly tokenizer?: string;
    readonly capabilitySource?: string;
    readonly capabilityConfidence?: string;
  };
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sections: readonly {
    readonly id: string;
    readonly role: string;
    readonly priority: string;
    readonly estimatedTokens?: number;
    readonly sourceRefIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly sourceRefs: readonly {
    readonly type: string;
    readonly id: string;
    readonly label?: string;
  }[];
  readonly contextProjection?: ConversationContextProjectionMetadata;
  readonly agentContext?: WorkflowAgentContextStamp;
}

export interface ChannelWorkflowStepOutputPacket {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly runId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly teammateId?: string;
  readonly skillId?: string;
  readonly status: ChannelWorkflowStepStatus;
  readonly resultSummary?: string;
  readonly artifactIds: readonly string[];
  readonly decisions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly changedPaths?: readonly string[];
  readonly sourceRefs?: readonly WorkflowPacketSourceRef[];
  readonly agentContext?: WorkflowAgentContextStamp;
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly runnerAudit?: RunnerResolutionAudit;
  readonly generatedAt: string;
}

export const delegatedEvidenceRefKindsV1 = [
  "execution_action",
  "workflow_output_packet",
  "artifact",
  "conversation_item",
] as const;

export type DelegatedEvidenceRefKindV1 = (typeof delegatedEvidenceRefKindsV1)[number];

export interface DelegatedEvidenceRefV1 {
  readonly kind: DelegatedEvidenceRefKindV1;
  readonly id: string;
}

export interface DelegatedStepRequirementV1 {
  readonly schemaVersion: 1;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly participantId: string;
  readonly participantManifestFingerprint: string;
  readonly expectedOutcome: "execution" | "verification" | "synthesis";
  readonly requiredOperationIds: readonly string[];
  readonly requiredDependencyStepIds: readonly string[];
  readonly acceptedEvidenceKinds: readonly DelegatedEvidenceRefKindV1[];
  readonly fingerprint: string;
}

export type DelegatedOutcomeV1 =
  | {
      readonly kind: "completed";
      readonly participantId: string;
      readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
    }
  | {
      readonly kind: "workflow_started";
      readonly workflowId: string;
      readonly participantManifestFingerprint: string;
    }
  | {
      readonly kind: "blocked";
      readonly participantId?: string;
      readonly code: string;
      readonly reason: string;
      readonly missingRequirements: readonly string[];
      readonly evidenceRefs?: readonly DelegatedEvidenceRefV1[];
    }
  | {
      readonly kind: "failed" | "cancelled";
      readonly participantId?: string;
      readonly code: string;
      readonly reason: string;
      readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
    };

export type WorkflowParticipantCompletionStatusV1 =
  | "satisfied"
  | "missing"
  | "blocked"
  | "failed"
  | "cancelled";

export interface WorkflowParticipantCompletionResultV1 {
  readonly participantId: string;
  readonly workflowStepIds: readonly string[];
  readonly status: WorkflowParticipantCompletionStatusV1;
  readonly evidenceRefs: readonly DelegatedEvidenceRefV1[];
  readonly reasonCode?: string;
}

export interface WorkflowCompletionGateV1 {
  readonly schemaVersion: 1;
  readonly status: "pending" | "verified" | "blocked" | "failed" | "cancelled";
  readonly sourceIntentDecisionId: string;
  readonly participantManifestFingerprint: string;
  readonly graphFingerprint: string;
  readonly basisFingerprint: string;
  readonly participantResults: readonly WorkflowParticipantCompletionResultV1[];
  readonly checkedAt: string;
}

export interface ChannelWorkflowStepMetadata {
  readonly participantAuthority?: WorkflowParticipantAuthorityV1;
  readonly providerBinding?: WorkflowParticipantProviderBindingV1;
  readonly workflowTemplateId?: string;
  readonly templateVersion?: string;
  readonly templateStepId?: string;
  readonly graphId?: string;
  readonly graphNodeId?: string;
  readonly dependsOnStepIds?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: "all_succeeded" | "all_terminal" | "any_succeeded";
  readonly maxParallelSiblings?: number;
  readonly teammateTemplateId?: string;
  readonly councilSlotKey?: string;
  readonly skillId?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly providerPresetId?: string;
  readonly requiredTools?: readonly RunTool[];
  readonly executionPlan?: ChannelIntentExecutionPlanV1;
  readonly executionOperationIds?: readonly string[];
  readonly executionVerification?: WorkflowStepExecutionVerificationV1;
  readonly delegatedRequirement?: DelegatedStepRequirementV1;
  readonly delegatedOutcome?: DelegatedOutcomeV1;
  readonly delegatedOutcomeBasisFingerprint?: string;
  readonly autoStart?: boolean;
  readonly approvalGate?: SkillApprovalProfile;
  readonly preStepApprovalId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly fanInPolicy?: WorkflowFanInPolicy;
  readonly activeGateStage?: "pre" | "post";
  readonly postStepApprovalId?: string;
  readonly contextArtifactId?: string;
  readonly outputArtifactId?: string;
  readonly outputArtifactIds?: readonly string[];
  readonly selectorDecisionIds?: readonly string[];
  readonly handoffIntentIds?: readonly string[];
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly proposalStepSources?: readonly ChannelExecutionProposalStepSource[];
  readonly fanInSummaryArtifactId?: string;
  readonly memoryCandidateIds?: readonly string[];
  readonly fanInContextReviews?: readonly WorkflowFanInContextReview[];
  readonly resultContextReview?: WorkflowFanInContextReview;
}

export type WorkflowGraphNodeKind = "step" | "join";

export type WorkflowEdgeConditionKind =
  | "always"
  | "all_succeeded"
  | "all_terminal"
  | "any_succeeded";

export interface WorkflowEdgeCondition {
  readonly kind: WorkflowEdgeConditionKind;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly condition: WorkflowEdgeCondition;
}

export type WorkflowTerminationSuccessPolicy = "all_terminal" | "all_required_succeeded";
export type WorkflowTerminationFailurePolicy = "block_for_user" | "fail_workflow";

export interface WorkflowTerminationPolicy {
  readonly success: WorkflowTerminationSuccessPolicy;
  readonly onFailedRequiredNode: WorkflowTerminationFailurePolicy;
  readonly onApprovalDenied: WorkflowTerminationFailurePolicy;
  readonly maxTicks?: number;
}

export interface WorkflowGraphNode {
  readonly id: string;
  readonly kind: WorkflowGraphNodeKind;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly councilSlotKey?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly providerBinding?: WorkflowParticipantProviderBindingV1;
  readonly requestedRunnerId?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly requiredTools?: readonly RunTool[];
  readonly autoStart?: boolean;
  readonly proposalStepSources?: readonly ChannelExecutionProposalStepSource[];
}

export interface WorkflowGraph {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly summary?: string;
  readonly entryNodeId: string;
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly termination: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
}

export interface ChannelWorkflowMetadata {
  readonly workflowGraphId?: string;
  readonly workflowGraphSchemaVersion?: number;
  readonly workflowGraphArtifactId?: string;
  readonly termination?: WorkflowTerminationPolicy;
  readonly maxParallelSteps?: number;
  readonly sourceProposalId?: string;
  readonly sourceMessageId?: string;
  readonly sourceTurnId?: string;
  readonly sourceIntentDecisionId?: string;
  readonly workflowGraph?: WorkflowGraph;
  readonly workflowGraphFingerprint?: string;
  readonly requiredParticipantManifest?: RequiredParticipantManifestV1;
  readonly completionGate?: WorkflowCompletionGateV1;
  readonly responseLanguage?: ResponseLanguage;
}

export type WorkflowStepExecutionVerificationStatusV1 = "pending" | "verified" | "blocked" | "failed";
export type WorkflowOperationVerificationStatusV1 = "succeeded" | "missing" | "failed" | "out_of_order";

export interface WorkflowOperationVerificationResultV1 {
  readonly operationId: string;
  readonly status: WorkflowOperationVerificationStatusV1;
  readonly evidenceActionIds: readonly string[];
  readonly reasonCode?: string;
}

export interface WorkflowStepExecutionVerificationV1 {
  readonly status: WorkflowStepExecutionVerificationStatusV1;
  readonly checkedAt: string;
  readonly operationResults: readonly WorkflowOperationVerificationResultV1[];
}

export interface ChannelWorkflow {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status: ChannelWorkflowStatus;
  readonly createdBy: string;
  readonly metadata?: ChannelWorkflowMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelWorkflowStep {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly workflowId: string;
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly position: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly participantAuthority: WorkflowParticipantAuthorityV1;
  readonly status: ChannelWorkflowStepStatus;
  readonly blocker?: string;
  readonly resultSummary?: string;
  readonly metadata?: ChannelWorkflowStepMetadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkflowEvidenceDiagnostic {
  readonly kind:
    | "missing_context_packet"
    | "missing_output_packet"
    | "missing_run"
    | "bad_packet"
    | "missing_teammate"
    | "blocked"
    | "failed";
  readonly severity: "info" | "warning" | "critical";
  readonly message: string;
}

export type WorkflowContextInspectAvailability =
  | "available"
  | "missing_context_artifact"
  | "unreadable_context_packet"
  | "missing_context_pack";

export interface WorkflowContextInspectSection {
  readonly id: string;
  readonly role: string;
  readonly priority: string;
  readonly estimatedTokens?: number;
  readonly sourceRefIds: readonly string[];
  readonly metadataKeys: readonly string[];
}

export interface WorkflowContextInspectSourceRef {
  readonly type: string;
  readonly id: string;
  readonly label?: string;
}

export interface WorkflowContextInspectBudget {
  readonly mode: string;
  readonly inputBudgetTokens: number;
  readonly estimatedInputTokens: number;
  readonly overBudget: boolean;
  readonly tokenizer?: string;
  readonly capabilitySource?: string;
  readonly capabilityConfidence?: string;
}

export interface WorkflowContextInspectSummary {
  readonly schemaVersion: 1;
  readonly availability: WorkflowContextInspectAvailability;
  readonly contextArtifactId?: string;
  readonly generatedAt?: string;
  readonly kind?: string;
  readonly providerPresetId?: string;
  readonly modelId?: string;
  readonly budget?: WorkflowContextInspectBudget;
  readonly sectionCount: number;
  readonly sourceRefCount: number;
  readonly droppedSectionCount: number;
  readonly compactionCount: number;
  readonly sections: readonly WorkflowContextInspectSection[];
  readonly droppedSectionIds: readonly string[];
  readonly compactionIds: readonly string[];
  readonly sourceRefs: readonly WorkflowContextInspectSourceRef[];
  readonly safety: {
    readonly rawPromptTextIncluded: false;
    readonly rawLogsIncluded: false;
    readonly rawArtifactBodiesIncluded: false;
  };
}

export interface WorkflowMemoryCandidateSummary {
  readonly memory: MemoryObject;
  readonly sourceWorkflowId: string;
  readonly sourceWorkflowStepIds: readonly string[];
}

export interface WorkflowEvidenceStep {
  readonly step: ChannelWorkflowStep;
  readonly contextPacket?: ChannelWorkflowStepContextPacket;
  readonly contextInspect: WorkflowContextInspectSummary;
  readonly outputPacket?: ChannelWorkflowStepOutputPacket;
  readonly linkedRun?: RunSession;
  readonly packetArtifacts: readonly RunArtifact[];
  readonly linkedArtifacts: readonly RunArtifact[];
  readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
}

export interface WorkflowEvidenceResponse {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly WorkflowEvidenceStep[];
  readonly selectorDecisions: readonly WorkflowSelectorDecision[];
  readonly handoffIntents: readonly WorkflowHandoffIntent[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
  readonly actions: readonly ExecutionAction[];
  readonly artifacts: readonly RunArtifact[];
  readonly memoryCandidates: readonly WorkflowMemoryCandidateSummary[];
}

export interface WorkflowStepEvidenceResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: WorkflowEvidenceStep;
  readonly selectorDecisions: readonly WorkflowSelectorDecision[];
  readonly handoffIntents: readonly WorkflowHandoffIntent[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalCheckpoints: readonly LingApprovalCheckpoint[];
  readonly memoryCandidates: readonly WorkflowMemoryCandidateSummary[];
}

export type CollaborationTaskCardMode =
  | "ready_for_confirmation"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type CollaborationExecutionMode = "serial" | "parallel" | "mixed";

export type CollaborationTaskStepState = "queued" | "active" | "waiting" | "blocked" | "done" | "failed" | "cancelled";

export interface CollaborationTaskCardStep {
  readonly id: string;
  readonly title: string;
  readonly ownerLabel: string;
  readonly state: CollaborationTaskStepState;
  readonly summary?: string;
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly updatedAt: string;
}

export interface CollaborationTaskBranch {
  readonly id: string;
  readonly label: string;
  readonly state: CollaborationTaskStepState;
  readonly summary?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly ownerLabels: readonly string[];
  readonly steps: readonly CollaborationTaskCardStep[];
}

export interface CollaborationTaskCardModel {
  readonly id: string;
  readonly workflowId: string;
  readonly title: string;
  readonly objective: string;
  readonly mode: CollaborationTaskCardMode;
  readonly executionMode: CollaborationExecutionMode;
  readonly currentOwnerLabel?: string;
  readonly blocker?: string;
  readonly nextAction?: string;
  readonly completedStepCount: number;
  readonly totalStepCount: number;
  readonly pendingApprovalCount: number;
  readonly steps: readonly CollaborationTaskCardStep[];
  readonly branches: readonly CollaborationTaskBranch[];
  readonly updatedAt: string;
}

export interface WorkflowCollaborationCardResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly card?: CollaborationTaskCardModel;
}

export interface ChannelCollaborationCardListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly cards: readonly CollaborationTaskCardModel[];
}

export interface CreateChannelWorkflowRequest {
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
}

export interface CreateChannelWorkflowFromTemplateRequest {
  readonly templateId: string;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
}

export interface CreateChannelWorkflowFromCustomTemplateRequest {
  readonly customTemplate: CustomWorkflowTemplate;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export interface CreateChannelWorkflowFromCustomTemplateIdRequest {
  readonly customTemplateId: string;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export interface CreateChannelWorkflowFromGraphRequest {
  readonly workflowGraph: WorkflowGraph;
  readonly title?: string;
  readonly objective: string;
  readonly createdBy?: string;
  readonly providerPresetId?: string;
  readonly runnerId?: string;
  readonly autoStart?: boolean;
  readonly confirmUnsafeAutoStart?: boolean;
}

export type CreateChannelWorkflowTemplateCompileRequest =
  | CreateChannelWorkflowFromTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateRequest
  | CreateChannelWorkflowFromCustomTemplateIdRequest
  | CreateChannelWorkflowFromGraphRequest;

export interface CustomWorkflowTemplate {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly maxParallelSteps?: number;
  readonly autoStartDefault?: boolean;
  readonly steps: readonly CustomWorkflowTemplateStep[];
}

export interface CustomWorkflowTemplateStep {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly teammateTemplateId?: string;
  readonly teammateId?: string;
  readonly councilSlotKey?: string;
  readonly skillId?: string;
  readonly providerPresetId?: string;
  readonly requestedRunnerId?: string;
  readonly dependsOn?: readonly string[];
  readonly branchGroupId?: string;
  readonly joinGroupId?: string;
  readonly dependencyMode?: ChannelWorkflowStepMetadata["dependencyMode"];
  readonly maxParallelSiblings?: number;
  readonly policy?: WorkflowStepPolicy;
  readonly gates?: readonly WorkflowStepGate[];
  readonly autoStart?: boolean;
}

export interface CreateChannelWorkflowFromHandoffRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly contextSummaryId?: string;
  readonly createdBy: string;
}

export interface UpdateChannelWorkflowRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
}

export interface ChannelWorkflowCancelResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly cancelledRunIds: readonly string[];
  readonly cancelledApprovalIds: readonly string[];
}

export interface CreateChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status?: ChannelWorkflowStepStatus;
}

export interface UpdateChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
}

export interface StartChannelWorkflowStepRequest {
  readonly mode: ChannelWorkflowStepStartMode;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
  readonly providerPresetId?: string;
  readonly assigneeTeammateId?: string;
  readonly idempotencyKey?: string;
  readonly skipProviderPreflight?: boolean;
}

export interface ChannelWorkflowListResponse {
  readonly cwd: string;
  readonly channelId: string;
  readonly workflows: readonly ChannelWorkflow[];
}

export interface ChannelWorkflowMutationResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowStep?: ChannelWorkflowStep;
}

export interface ChannelWorkflowTemplateMutationResponse {
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

export interface ChannelExecutionProposalWorkflowConfirmResponse {
  readonly proposal: ChannelExecutionProposal;
  readonly workflow: ChannelWorkflow;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly orchestration?: ChannelWorkflowOrchestrationResponse;
}

export interface ChannelWorkflowStepListResponse {
  readonly cwd: string;
  readonly workflowId: string;
  readonly workflowSteps: readonly ChannelWorkflowStep[];
}

export interface ChannelWorkflowStepMutationResponse {
  readonly workflowStep: ChannelWorkflowStep;
  readonly workflow?: ChannelWorkflow;
}

export interface ChannelWorkflowStepStartResponse {
  readonly workflowStep: ChannelWorkflowStep;
  readonly workflow?: ChannelWorkflow;
  readonly task?: Task;
  readonly run?: RunSession;
  readonly blocker?: string;
}

export type ChannelSmartSchedulingEffectiveMode = "serial" | "parallel";

export type ChannelSmartSchedulingReasonCode =
  | "smart_scheduling"
  | "channel_missing_serial"
  | "max_concurrent_runs_one"
  | "no_eligible_steps"
  | "eligible_step_count_one"
  | "active_step_budget_exhausted"
  | "read_only_parallel_disabled"
  | "workflow_parallel_limit_one"
  | "approval_pending"
  | "unknown_tools_serial"
  | "side_effectful_step_serial"
  | "read_only_parallel_allowed";

export interface ChannelSmartSchedulingDecision {
  readonly schedulingMode: "smart";
  readonly effectiveMode: ChannelSmartSchedulingEffectiveMode;
  readonly parallelLimit: number;
  readonly runnableStepIds: readonly string[];
  readonly queuedStepIds: readonly string[];
  readonly reasonCodes: readonly ChannelSmartSchedulingReasonCode[];
  readonly resourceLocks: readonly string[];
  readonly safetyEvidence: "complete" | "partial" | "unknown";
}

export type ChannelWorkflowStepRetryResponse = ChannelWorkflowOrchestrationResponse;

export type ChannelWorkflowOrchestrationResponse =
  | {
      readonly status: "started";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly taskId: string;
      readonly runId?: string;
      readonly startedSteps?: readonly {
        readonly workflowStep: ChannelWorkflowStep;
        readonly taskId: string;
        readonly runId?: string;
      }[];
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    }
  | {
      readonly status: "waiting_for_approval";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep: ChannelWorkflowStep;
      readonly approval: ApprovalRequest;
      readonly waitingApprovals?: readonly {
        readonly workflowStep: ChannelWorkflowStep;
        readonly approval: ApprovalRequest;
      }[];
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    }
  | {
      readonly status: "idle";
      readonly workflow: ChannelWorkflow;
      readonly reason: string;
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    }
  | {
      readonly status: "blocked";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep?: ChannelWorkflowStep;
      readonly blocker: string;
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    }
  | {
      readonly status: "failed";
      readonly workflow: ChannelWorkflow;
      readonly workflowStep?: ChannelWorkflowStep;
      readonly blocker: string;
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    }
  | {
      readonly status: "completed";
      readonly workflow: ChannelWorkflow;
      readonly schedulingDecision?: ChannelSmartSchedulingDecision;
    };

export type ResourceType =
  | "channel"
  | "bound_path"
  | "workspace"
  | "provider"
  | "task"
  | "workflow_step"
  | "external_source"
  | "external_subject"
  | "external_workspace";

export type ResourceLeaseStatus = "active" | "released" | "expired";

export interface ResourceLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly ownerType: "run" | "workflow_step" | "work_unit_attempt" | "system";
  readonly ownerId: string;
  readonly status: ResourceLeaseStatus;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly lastRenewedAt?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
}

export type StateEntityType = "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step" | "work_unit" | "turn";

export interface StateTransitionEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: StateEntityType;
  readonly entityId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly event: string;
  readonly actor: "system" | "local-user" | "ai-teammate" | "runner" | "provider";
  readonly reason?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
}

export interface StateTransitionListResponse {
  readonly cwd: string;
  readonly transitions: readonly StateTransitionEvent[];
}

export interface ResourceLeaseListResponse {
  readonly cwd: string;
  readonly leases: readonly ResourceLease[];
}

export interface ListStateTransitionsRequest {
  readonly entityType?: StateEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export interface ListResourceLeasesRequest {
  readonly status?: ResourceLeaseStatus;
  readonly ownerId?: string;
  readonly ownerType?: ResourceLease["ownerType"];
  readonly resourceType?: ResourceType;
  readonly resourceKey?: string;
  readonly workUnitId?: string;
  readonly attemptId?: string;
  readonly limit?: number;
}
