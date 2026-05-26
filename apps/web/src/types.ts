export type * from "@ling-stack/contracts";

import type {
  ApprovalToolDecision,
  ChannelRuntimePolicy,
  ChannelStatus,
  MediaOperation,
  ProviderApi,
  ProviderKind,
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
}

export interface ProviderFormState {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly apiKeyRef: string;
  readonly capabilitiesText: string;
  readonly inputText: string;
  readonly enabled: boolean;
  readonly authHeader: boolean;
  readonly reasoning: boolean;
  readonly contextWindow: string;
  readonly maxTokens: string;
}

export interface ChannelFormState {
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath: string;
  readonly defaultProviderPresetId: string;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
}

export interface TaskFormState {
  readonly title: string;
  readonly prompt: string;
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
