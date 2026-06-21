import type { SQLOutputValue } from "node:sqlite";
import type { RunTool } from "../../approval-policy.js";
import type { SkillApprovalProfile } from "../../skill-types.js";
import {
  channelWorkflowStepStatuses,
  type ChannelExecutionProposalStepSource,
  type ChannelWorkflow,
  type ChannelWorkflowMetadata,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepMetadata,
  type ChannelWorkflowStepStatus,
  type ResponseLanguage,
  type WorkflowFanInPolicy,
  type WorkflowHandoffIntent,
  type WorkflowHandoffIntentStatus,
  type WorkflowHandoffValidation,
  type WorkflowPacketSourceRef,
  type WorkflowSelectorAlternative,
  type WorkflowSelectorDecision,
  type WorkflowSelectorDecisionStatus,
  type WorkflowSelectorTargetKind,
  type WorkflowStepFailurePolicy,
  type WorkflowStepGate,
  type WorkflowStepPolicy,
} from "../../workspace-types.js";
import { normalizeStoredRunnerId } from "./runtime-work-mappers.js";
import {
  omitUndefined,
  parseJson,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
} from "./helpers.js";

export function mapWorkflowHandoffIntent(row: Record<string, SQLOutputValue>): WorkflowHandoffIntent {
  return omitUndefined({
    schemaVersion: 1 as const,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readNullableString(row, "workflow_id"),
    sourceWorkflowStepId: readNullableString(row, "source_workflow_step_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    channelHandoffId: readNullableString(row, "channel_handoff_id"),
    fromParticipantId: readString(row, "from_participant_id"),
    fromParticipantLabel: readString(row, "from_participant_label"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readNullableString(row, "to_participant_label"),
    reason: readString(row, "reason"),
    requiredInput: readString(row, "required_input"),
    expectedOutput: readString(row, "expected_output"),
    riskSummary: readNullableString(row, "risk_summary"),
    sourceRefs: parseWorkflowPacketSourceRefs(readString(row, "source_refs_json")),
    status: readString(row, "status") as WorkflowHandoffIntentStatus,
    validation: parseOptionalWorkflowHandoffValidation(readNullableString(row, "validation_json")),
    createdBy: readString(row, "created_by") as WorkflowHandoffIntent["createdBy"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapWorkflowSelectorDecision(row: Record<string, SQLOutputValue>): WorkflowSelectorDecision {
  return omitUndefined({
    schemaVersion: 1 as const,
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readString(row, "workflow_id"),
    sourceWorkflowStepId: readNullableString(row, "source_workflow_step_id"),
    selectorNodeId: readNullableString(row, "selector_node_id"),
    targetKind: readString(row, "target_kind") as WorkflowSelectorTargetKind,
    selectedWorkflowStepId: readNullableString(row, "selected_workflow_step_id"),
    selectedGraphNodeId: readNullableString(row, "selected_graph_node_id"),
    selectedTeammateId: readNullableString(row, "selected_teammate_id"),
    selectedSkillId: readNullableString(row, "selected_skill_id"),
    selectedHandoffIntentId: readNullableString(row, "selected_handoff_intent_id"),
    reason: readString(row, "reason"),
    alternativesConsidered: parseWorkflowSelectorAlternatives(readString(row, "alternatives_json")),
    confidence: readString(row, "confidence") as WorkflowSelectorDecision["confidence"],
    requiresUserConfirmation: readBoolean(row, "requires_user_confirmation"),
    status: readString(row, "status") as WorkflowSelectorDecisionStatus,
    sourceRefs: parseWorkflowPacketSourceRefs(readString(row, "source_refs_json")),
    createdBy: readString(row, "created_by") as WorkflowSelectorDecision["createdBy"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelWorkflow(row: Record<string, SQLOutputValue>): ChannelWorkflow {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceHandoffId: readNullableString(row, "source_handoff_id"),
    title: readString(row, "title"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as ChannelWorkflowStatus,
    createdBy: readString(row, "created_by"),
    metadata: parseOptionalChannelWorkflowMetadata(readNullableString(row, "metadata_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

export function mapChannelWorkflowStep(row: Record<string, SQLOutputValue>): ChannelWorkflowStep {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    workflowId: readString(row, "workflow_id"),
    sourceHandoffId: readNullableString(row, "source_handoff_id"),
    contextSummaryId: readNullableString(row, "context_summary_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    position: readNumber(row, "position"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readString(row, "to_participant_label"),
    status: readString(row, "status") as ChannelWorkflowStepStatus,
    blocker: readNullableString(row, "blocker"),
    resultSummary: readNullableString(row, "result_summary"),
    metadata: parseOptionalChannelWorkflowStepMetadata(readNullableString(row, "metadata_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function parseOptionalChannelWorkflowStepMetadata(value: string | undefined): ChannelWorkflowStepMetadata | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return omitUndefined({
    workflowTemplateId: readOptionalStringValue(record.workflowTemplateId),
    templateVersion: readOptionalStringValue(record.templateVersion),
    templateStepId: readOptionalStringValue(record.templateStepId),
    graphId: readOptionalStringValue(record.graphId),
    graphNodeId: readOptionalStringValue(record.graphNodeId),
    dependsOnStepIds: readOptionalStringListValue(record.dependsOnStepIds),
    branchGroupId: readOptionalStringValue(record.branchGroupId),
    joinGroupId: readOptionalStringValue(record.joinGroupId),
    dependencyMode: readOptionalWorkflowStepDependencyModeValue(record.dependencyMode),
    maxParallelSiblings: readOptionalPositiveIntegerValue(record.maxParallelSiblings),
    teammateTemplateId: readOptionalStringValue(record.teammateTemplateId),
    skillId: readOptionalStringValue(record.skillId),
    requestedRunnerId: normalizeStoredRunnerId(readOptionalStringValue(record.requestedRunnerId)),
    effectiveRunnerId: normalizeStoredRunnerId(readOptionalStringValue(record.effectiveRunnerId)),
    providerPresetId: readOptionalStringValue(record.providerPresetId),
    requiredTools: readOptionalRunToolListValue(record.requiredTools),
    autoStart: typeof record.autoStart === "boolean" ? record.autoStart : undefined,
    approvalGate: parseOptionalApprovalProfileValue(record.approvalGate),
    preStepApprovalId: readOptionalStringValue(record.preStepApprovalId),
    policy: parseOptionalWorkflowStepPolicyValue(record.policy),
    gates: parseOptionalWorkflowStepGateListValue(record.gates),
    fanInPolicy: parseOptionalWorkflowFanInPolicyValue(record.fanInPolicy),
    activeGateStage: readOptionalGateStageValue(record.activeGateStage),
    postStepApprovalId: readOptionalStringValue(record.postStepApprovalId),
    contextArtifactId: readOptionalStringValue(record.contextArtifactId),
    outputArtifactId: readOptionalStringValue(record.outputArtifactId),
    outputArtifactIds: readOptionalStringListValue(record.outputArtifactIds),
    selectorDecisionIds: readOptionalStringListValue(record.selectorDecisionIds),
    handoffIntentIds: readOptionalStringListValue(record.handoffIntentIds),
    sourceProposalId: readOptionalStringValue(record.sourceProposalId),
    sourceMessageId: readOptionalStringValue(record.sourceMessageId),
    proposalStepSources: parseOptionalProposalStepSourcesValue(record.proposalStepSources),
    fanInSummaryArtifactId: readOptionalStringValue(record.fanInSummaryArtifactId),
    memoryCandidateIds: readOptionalStringListValue(record.memoryCandidateIds),
  });
}

function parseOptionalChannelWorkflowMetadata(value: string | undefined): ChannelWorkflowMetadata | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return omitUndefined({
    workflowGraphId: readOptionalStringValue(record.workflowGraphId),
    workflowGraphSchemaVersion: readOptionalPositiveIntegerValue(record.workflowGraphSchemaVersion),
    workflowGraphArtifactId: readOptionalStringValue(record.workflowGraphArtifactId),
    termination: parseOptionalWorkflowTerminationPolicyValue(record.termination),
    maxParallelSteps: readOptionalPositiveIntegerValue(record.maxParallelSteps),
    sourceProposalId: readOptionalStringValue(record.sourceProposalId),
    sourceMessageId: readOptionalStringValue(record.sourceMessageId),
    responseLanguage: parseOptionalResponseLanguage(record.responseLanguage),
  });
}

function parseOptionalWorkflowTerminationPolicyValue(value: unknown): ChannelWorkflowMetadata["termination"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const success = record.success;
  const onFailedRequiredNode = record.onFailedRequiredNode;
  const onApprovalDenied = record.onApprovalDenied;
  if (
    (success !== "all_terminal" && success !== "all_required_succeeded") ||
    (onFailedRequiredNode !== "block_for_user" && onFailedRequiredNode !== "fail_workflow") ||
    (onApprovalDenied !== "block_for_user" && onApprovalDenied !== "fail_workflow")
  ) {
    return undefined;
  }
  return omitUndefined({
    success: success as NonNullable<ChannelWorkflowMetadata["termination"]>["success"],
    onFailedRequiredNode: onFailedRequiredNode as NonNullable<ChannelWorkflowMetadata["termination"]>["onFailedRequiredNode"],
    onApprovalDenied: onApprovalDenied as NonNullable<ChannelWorkflowMetadata["termination"]>["onApprovalDenied"],
    maxTicks: readOptionalPositiveIntegerValue(record.maxTicks),
  });
}

function parseWorkflowPacketSourceRefs(value: string): WorkflowPacketSourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected workflow packet source refs array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected workflow packet source ref object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (!isWorkflowPacketSourceRefTypeValue(record.type) || typeof record.id !== "string") {
      throw new Error("Invalid workflow packet source ref from SQLite");
    }
    return omitUndefined({
      type: record.type,
      id: record.id,
      label: readOptionalStringValue(record.label),
    });
  });
}

function parseWorkflowSelectorAlternatives(value: string): WorkflowSelectorAlternative[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected workflow selector alternatives array from SQLite");
  }
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Expected workflow selector alternative object from SQLite");
    }
    const record = item as Record<string, unknown>;
    if (
      !isWorkflowSelectorTargetKindValue(record.targetKind) ||
      typeof record.targetId !== "string" ||
      typeof record.label !== "string" ||
      typeof record.reason !== "string"
    ) {
      throw new Error("Invalid workflow selector alternative from SQLite");
    }
    return {
      targetKind: record.targetKind,
      targetId: record.targetId,
      label: record.label,
      reason: record.reason,
    };
  });
}

function parseOptionalWorkflowHandoffValidation(value: string | undefined): WorkflowHandoffValidation | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.targetTeammateExists !== "boolean" ||
    typeof record.targetTeammateActive !== "boolean" ||
    typeof record.skillExecutable !== "boolean" ||
    typeof record.providerRunnable !== "boolean" ||
    typeof record.approvalProfileCompatible !== "boolean" ||
    typeof record.resourceLeaseAvailable !== "boolean" ||
    !Array.isArray(record.blockers) ||
    record.blockers.some((item) => typeof item !== "string")
  ) {
    return undefined;
  }
  return {
    targetTeammateExists: record.targetTeammateExists,
    targetTeammateActive: record.targetTeammateActive,
    skillExecutable: record.skillExecutable,
    providerRunnable: record.providerRunnable,
    approvalProfileCompatible: record.approvalProfileCompatible,
    resourceLeaseAvailable: record.resourceLeaseAvailable,
    blockers: record.blockers,
  };
}

function readOptionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readOptionalStringListValue(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : undefined;
}

function parseOptionalProposalStepSourcesValue(value: unknown): readonly ChannelExecutionProposalStepSource[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources: ChannelExecutionProposalStepSource[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const kind = record.kind;
    if (kind !== "direct" && kind !== "council") {
      continue;
    }
    const councilId = readOptionalStringValue(record.councilId);
    const councilDisplayName = readOptionalStringValue(record.councilDisplayName);
    const slotKey = readOptionalStringValue(record.slotKey);
    const label = readOptionalStringValue(record.label);
    const source: ChannelExecutionProposalStepSource = {
      kind,
      ...(councilId ? { councilId } : {}),
      ...(councilDisplayName ? { councilDisplayName } : {}),
      ...(slotKey ? { slotKey } : {}),
      ...(label ? { label } : {}),
      ...(typeof record.isDefault === "boolean" ? { isDefault: record.isDefault } : {}),
    };
    sources.push(source);
  }
  return sources.length > 0 ? sources : undefined;
}

function readOptionalRunToolListValue(value: unknown): readonly RunTool[] | undefined {
  if (!Array.isArray(value) || !value.every((item): item is RunTool => typeof item === "string" && isRunToolValue(item))) {
    return undefined;
  }
  return value;
}

function isRunToolValue(value: string): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function readOptionalPositiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readOptionalWorkflowStepDependencyModeValue(value: unknown): ChannelWorkflowStepMetadata["dependencyMode"] | undefined {
  return value === "all_succeeded" || value === "all_terminal" || value === "any_succeeded" ? value : undefined;
}

function parseOptionalWorkflowStepPolicyValue(value: unknown): WorkflowStepPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const onRunFailed = readWorkflowStepFailurePolicy(record.onRunFailed);
  const onRunCancelled = readWorkflowStepFailurePolicy(record.onRunCancelled);
  const onApprovalDenied = readWorkflowStepFailurePolicy(record.onApprovalDenied);
  if (!onRunFailed || !onRunCancelled || !onApprovalDenied || typeof record.retryable !== "boolean") {
    return undefined;
  }
  return omitUndefined({
    onRunFailed,
    onRunCancelled,
    onApprovalDenied,
    retryable: record.retryable,
    maxRetries: typeof record.maxRetries === "number" && Number.isFinite(record.maxRetries) ? record.maxRetries : undefined,
  });
}

function parseOptionalWorkflowFanInPolicyValue(value: unknown): WorkflowFanInPolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const mode = readWorkflowFanInModeValue(record.mode);
  const memoryCandidateScope = readWorkflowFanInMemoryCandidateScopeValue(record.memoryCandidateScope);
  const maxInputArtifacts = readOptionalPositiveIntegerValue(record.maxInputArtifacts);
  if (
    !mode ||
    !memoryCandidateScope ||
    maxInputArtifacts === undefined ||
    typeof record.requireAllBranchesTerminal !== "boolean" ||
    typeof record.includeFailedBranches !== "boolean" ||
    typeof record.createSummaryArtifact !== "boolean" ||
    typeof record.createMemoryCandidates !== "boolean"
  ) {
    return undefined;
  }
  return {
    mode,
    requireAllBranchesTerminal: record.requireAllBranchesTerminal,
    includeFailedBranches: record.includeFailedBranches,
    createSummaryArtifact: record.createSummaryArtifact,
    createMemoryCandidates: record.createMemoryCandidates,
    memoryCandidateScope,
    maxInputArtifacts,
  };
}

function readWorkflowFanInModeValue(value: unknown): WorkflowFanInPolicy["mode"] | undefined {
  return value === "summarize_outputs" || value === "compare_outputs" || value === "collect_checks" || value === "memory_candidates"
    ? value
    : undefined;
}

function readWorkflowFanInMemoryCandidateScopeValue(value: unknown): WorkflowFanInPolicy["memoryCandidateScope"] | undefined {
  return value === "run" || value === "task" || value === "channel" ? value : undefined;
}

function parseOptionalWorkflowStepGateListValue(value: unknown): readonly WorkflowStepGate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const gates = value
    .map(parseWorkflowStepGateValue)
    .filter((gate): gate is WorkflowStepGate => gate !== undefined);
  return gates.length === value.length ? gates : undefined;
}

function parseWorkflowStepGateValue(value: unknown): WorkflowStepGate | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const stage = readOptionalGateStageValue(record.stage);
  const title = readOptionalStringValue(record.title);
  const reason = readOptionalStringValue(record.reason);
  const approvalProfile = parseOptionalApprovalProfileValue(record.approvalProfile);
  if (!stage || !title || !reason || !approvalProfile) {
    return undefined;
  }
  const requiredForStatuses = parseOptionalWorkflowStepStatusListValue(record.requiredForStatuses);
  return omitUndefined({
    stage,
    approvalProfile,
    title,
    reason,
    requiredForStatuses,
  });
}

function readWorkflowStepFailurePolicy(value: unknown): WorkflowStepFailurePolicy | undefined {
  return value === "block_for_user" || value === "fail_workflow" || value === "cancel_workflow" || value === "skip_if_optional"
    ? value
    : undefined;
}

function readOptionalGateStageValue(value: unknown): "pre" | "post" | undefined {
  return value === "pre" || value === "post" ? value : undefined;
}

function parseOptionalWorkflowStepStatusListValue(value: unknown): readonly ChannelWorkflowStepStatus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every(isChannelWorkflowStepStatusValue) ? value as ChannelWorkflowStepStatus[] : undefined;
}

function isChannelWorkflowStepStatusValue(value: unknown): value is ChannelWorkflowStepStatus {
  return typeof value === "string" && channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus);
}

function parseOptionalApprovalProfileValue(value: unknown): SkillApprovalProfile | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return record.mode === "none" || record.mode === "standard" || record.mode === "strict"
    ? record as unknown as SkillApprovalProfile
    : undefined;
}

function parseOptionalResponseLanguage(value: unknown): ResponseLanguage | undefined {
  return value === "zh-CN" || value === "en-US" ? value : undefined;
}

function isWorkflowSelectorTargetKindValue(value: unknown): value is WorkflowSelectorTargetKind {
  return value === "workflow_step" || value === "graph_node" || value === "teammate" || value === "skill" || value === "handoff" || value === "wait";
}

function isWorkflowPacketSourceRefTypeValue(value: unknown): value is WorkflowPacketSourceRef["type"] {
  return (
    value === "channel_message" ||
    value === "channel_brief" ||
    value === "channel_decision" ||
    value === "context_summary" ||
    value === "task" ||
    value === "run" ||
    value === "workflow" ||
    value === "workflow_step" ||
    value === "workflow_handoff_intent" ||
    value === "workflow_selector_decision" ||
    value === "artifact" ||
    value === "approval" ||
    value === "memory"
  );
}
