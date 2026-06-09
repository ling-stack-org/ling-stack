export type * from "@ling-stack/contracts";

import type {
  ApprovalToolDecision,
  ChannelRuntimePolicy,
  ChannelAutoReplyMode,
  ChannelStatus,
  McpServerTransportType,
  MediaOperation,
  PermissionPreset,
  ProviderApi,
  ProviderKind,
  SessionPermissionMode,
  TaskStatus,
  ToolName,
} from "@ling-stack/contracts";

export interface ApprovalPolicyFormState {
  readonly toolDecisions: Record<ToolName, ApprovalToolDecision>;
  readonly allowedWritePathsText: string;
}

export interface RunFormState {
  readonly cwd: string;
  readonly providerPresetId: string;
  readonly taskId: string;
  readonly title: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly api: string;
  readonly tools: readonly ToolName[];
  readonly permissionMode: SessionPermissionMode;
  readonly permissionPreset?: PermissionPreset;
}

export interface ProviderFormState {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyRef: string;
  readonly clearApiKey: boolean;
  readonly capabilitiesText: string;
  readonly inputText: string;
  readonly enabled: boolean;
  readonly authHeader: boolean;
  readonly reasoning: boolean;
  readonly contextWindow: string;
  readonly maxTokens: string;
}

export interface ProviderModelListFormState {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiKeyRef: string;
  readonly authHeader: boolean;
}

export interface McpServerFormState {
  readonly displayName: string;
  readonly serverId: string;
  readonly transportType: McpServerTransportType;
  readonly command: string;
  readonly argsText: string;
  readonly cwd: string;
  readonly url: string;
  readonly headerName: string;
  readonly headerSecretRef: string;
  readonly bearerTokenRef: string;
  readonly envName: string;
  readonly envSecretRef: string;
  readonly startupTimeoutSec: string;
  readonly toolTimeoutSec: string;
  readonly enabled: boolean;
  readonly required: boolean;
}

export interface ChannelFormState {
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath: string;
  readonly defaultProviderPresetId: string;
  readonly defaultTeammateId: string;
  readonly autoReplyMode: ChannelAutoReplyMode;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
}

export interface ChannelCreateFormState extends ChannelFormState {
  readonly selectedTeammateIds: readonly string[];
  readonly defaultResponderTeammateId: string;
}

export interface TaskFormState {
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId?: string;
  readonly requestedSkillId?: string;
}

export interface TaskRunActionState {
  readonly taskId: string;
  readonly action: "run" | "check";
}

export interface TaskEditFormState {
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
}

export interface MediaJobFormState {
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly inputText: string;
}
