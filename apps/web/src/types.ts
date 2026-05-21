export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type RunEventType =
  | "run_created"
  | "run_start"
  | "turn_start"
  | "turn_end"
  | "assistant_text_delta"
  | "assistant_thinking_delta"
  | "message_end"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "run_end"
  | "run_error"
  | "run_cancelled"
  | "approval_requested"
  | "approval_approved"
  | "approval_denied"
  | "result";

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly summaryPath?: string;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export interface RunEventsResponse {
  readonly runId: string;
  readonly events: readonly RunEventEnvelope[];
  readonly nextSeq: number;
}

export interface RunListResponse {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
}

export interface RunCancelResponse {
  readonly cancelled: boolean;
  readonly active: boolean;
  readonly run?: RunSession;
  readonly event?: RunEventEnvelope;
}

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "openai-compatible"
  | "doubao"
  | "deepseek"
  | "minimax"
  | "glm"
  | "jimeng"
  | "seedream"
  | "seedance";

export type ProviderCapability =
  | "chat"
  | "tool_call"
  | "reasoning"
  | "vision"
  | "embedding"
  | "image_generate"
  | "image_edit"
  | "video_generate"
  | "tts"
  | "asr";

export type ProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "mistral-conversations"
  | "media-job";

export interface ProviderPreset {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKeyConfigured: boolean;
  readonly headers: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderListResponse {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
}

export interface ProviderMutationResponse {
  readonly provider: ProviderPreset;
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export type ApprovalActionType =
  | "write"
  | "edit"
  | "bash"
  | "git_commit"
  | "git_push"
  | "external_send"
  | "deploy"
  | "media_cost"
  | "credential_change"
  | "provider_change";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface ApprovalRequest {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly toolCallId?: string;
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly title: string;
  readonly description: string;
  readonly payload: unknown;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: "local-user";
  readonly decisionReason?: string;
}

export interface ApprovalListResponse {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
}

export interface ApprovalMutationResponse {
  readonly approval: ApprovalRequest;
}

export type ToolName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

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
