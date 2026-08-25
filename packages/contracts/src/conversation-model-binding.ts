export type EffectiveConversationModelSourceV1 =
  | "private_request_override"
  | "teammate_fixed"
  | "workspace_default"
  | "channel_ling_agent_model";

export type ConversationModelBindingOwnerV1 = "workspace" | "channel" | "teammate";

export type ConversationModelRepairTargetV1 =
  | "model_workbench"
  | "channel_settings"
  | "teammate_settings";

export type WorkflowParticipantProviderBlockerReasonV1 =
  | "workspace_default_provider_missing"
  | "channel_ling_agent_provider_missing"
  | "fixed_provider_missing"
  | "provider_unavailable"
  | "provider_capability_missing";

export interface WorkflowParticipantProviderBindingV1 {
  readonly schemaVersion: 1;
  readonly participantId: string;
  readonly bindingMode: "workspace_default" | "fixed";
  readonly source: EffectiveConversationModelSourceV1;
  readonly providerPresetId: string;
}

export interface WorkflowParticipantProviderBlockerV1 {
  readonly schemaVersion: 1;
  readonly code: "workflow_participant_provider_unavailable";
  readonly reasonCode: WorkflowParticipantProviderBlockerReasonV1;
  readonly participantId: string;
  readonly bindingMode: "workspace_default" | "fixed";
  readonly source: EffectiveConversationModelSourceV1;
  readonly owner: ConversationModelBindingOwnerV1;
  readonly repairTarget: ConversationModelRepairTargetV1;
  readonly providerPresetId?: string;
  readonly message: string;
}

export function isWorkflowParticipantProviderBindingV1(
  value: unknown,
): value is WorkflowParticipantProviderBindingV1 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && isNonEmptyString(value.participantId)
    && (value.bindingMode === "workspace_default" || value.bindingMode === "fixed")
    && isEffectiveConversationModelSourceV1(value.source)
    && workflowBindingSourceIsConsistent(value)
    && isNonEmptyString(value.providerPresetId)
    && onlyKeys(value, ["schemaVersion", "participantId", "bindingMode", "source", "providerPresetId"]);
}

function workflowBindingSourceIsConsistent(record: Record<string, unknown>): boolean {
  if (record.bindingMode === "fixed") {
    return record.source === "teammate_fixed";
  }
  return record.source === "workspace_default" || record.source === "channel_ling_agent_model";
}

export function isWorkflowParticipantProviderBlockerV1(
  value: unknown,
): value is WorkflowParticipantProviderBlockerV1 {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.code === "workflow_participant_provider_unavailable"
    && isWorkflowParticipantProviderBlockerReasonV1(value.reasonCode)
    && isNonEmptyString(value.participantId)
    && (value.bindingMode === "workspace_default" || value.bindingMode === "fixed")
    && isEffectiveConversationModelSourceV1(value.source)
    && (value.owner === "workspace" || value.owner === "channel" || value.owner === "teammate")
    && (value.repairTarget === "model_workbench"
      || value.repairTarget === "channel_settings"
      || value.repairTarget === "teammate_settings")
    && (value.providerPresetId === undefined || isNonEmptyString(value.providerPresetId))
    && isNonEmptyString(value.message)
    && blockerOwnershipIsConsistent(value)
    && onlyKeys(value, [
      "schemaVersion",
      "code",
      "reasonCode",
      "participantId",
      "bindingMode",
      "source",
      "owner",
      "repairTarget",
      "providerPresetId",
      "message",
    ]);
}

function blockerOwnershipIsConsistent(record: Record<string, unknown>): boolean {
  if (record.source === "channel_ling_agent_model") {
    if (record.owner !== "channel" || record.repairTarget !== "channel_settings") return false;
  } else if (record.source === "teammate_fixed") {
    if (record.owner !== "teammate" || record.repairTarget !== "teammate_settings") return false;
  } else if (record.owner !== "workspace" || record.repairTarget !== "model_workbench") {
    return false;
  }
  if (record.reasonCode === "workspace_default_provider_missing") {
    return record.source === "workspace_default" && record.providerPresetId === undefined;
  }
  if (record.reasonCode === "channel_ling_agent_provider_missing") {
    return record.source === "channel_ling_agent_model" && record.providerPresetId === undefined;
  }
  if (record.reasonCode === "fixed_provider_missing") {
    return record.source === "teammate_fixed" && record.providerPresetId === undefined;
  }
  return record.providerPresetId !== undefined;
}

function isEffectiveConversationModelSourceV1(value: unknown): value is EffectiveConversationModelSourceV1 {
  return value === "private_request_override"
    || value === "teammate_fixed"
    || value === "workspace_default"
    || value === "channel_ling_agent_model";
}

function isWorkflowParticipantProviderBlockerReasonV1(
  value: unknown,
): value is WorkflowParticipantProviderBlockerReasonV1 {
  return value === "workspace_default_provider_missing"
    || value === "channel_ling_agent_provider_missing"
    || value === "fixed_provider_missing"
    || value === "provider_unavailable"
    || value === "provider_capability_missing";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
