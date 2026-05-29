export type RunStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export interface DaemonHealthResponse {
  readonly ok: boolean;
  readonly service?: string;
  readonly defaultWorkspaceCwd?: string;
}

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
  | "approval_expired"
  | "artifact_created"
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
  readonly providerPresetId?: string;
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

export type ArtifactType = "file" | "diff" | "log" | "json" | "markdown" | "image" | "video";

export interface RunArtifact {
  readonly id: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
}

export interface RunArtifactListResponse {
  readonly runId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface MediaJobArtifactListResponse {
  readonly mediaJobId: string;
  readonly artifacts: readonly RunArtifact[];
}

export interface RunArtifactResponse {
  readonly artifact: RunArtifact;
}

export type MediaJobStatus = "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";

export type MediaOperation = "image_generate" | "image_edit" | "video_generate";

export interface MediaJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input: Record<string, unknown>;
  readonly artifactIds: readonly string[];
  readonly status: MediaJobStatus;
  readonly errorMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MediaJobListResponse {
  readonly cwd: string;
  readonly mediaJobs: readonly MediaJob[];
}

export interface MediaJobMutationResponse {
  readonly mediaJob: MediaJob;
  readonly artifacts?: readonly RunArtifact[];
  readonly approval?: ApprovalRequest;
}

export interface CreateMediaJobRequest {
  readonly providerPresetId: string;
  readonly operation: MediaOperation;
  readonly prompt: string;
  readonly input?: Record<string, unknown>;
}

export type TaskStatus = "todo" | "claimed" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";

export type ChannelStatus = "active" | "paused" | "archived";

export type ChannelExecutionMode = "serial" | "parallel";

export type ChannelWriteLockScope = "channel" | "boundPath" | "workspace";

export interface ChannelRuntimePolicy {
  readonly maxConcurrentRuns: number;
  readonly executionMode: ChannelExecutionMode;
  readonly writeLockScope: ChannelWriteLockScope;
  readonly allowReadOnlyParallel: boolean;
  readonly queueOnConflict: boolean;
}

export interface Channel {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly defaultTeammateId?: string;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChannelListResponse {
  readonly cwd: string;
  readonly channels: readonly Channel[];
}

export interface ChannelMutationResponse {
  readonly channel: Channel;
}

export interface CreateChannelRequest {
  readonly name: string;
  readonly status: ChannelStatus;
  readonly boundPath?: string;
  readonly defaultProviderPresetId?: string;
  readonly allowedTools: readonly ToolName[];
  readonly runtimePolicy: ChannelRuntimePolicy;
}

export interface UpdateChannelRequest {
  readonly name?: string;
  readonly status?: ChannelStatus;
  readonly boundPath?: string | null;
  readonly defaultProviderPresetId?: string | null;
  readonly allowedTools?: readonly ToolName[];
  readonly runtimePolicy?: ChannelRuntimePolicy;
}

export interface Task {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
  readonly status: TaskStatus;
  readonly assigneeTeammateId?: string;
  readonly currentRunId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskListResponse {
  readonly cwd: string;
  readonly tasks: readonly Task[];
}

export interface TaskMutationResponse {
  readonly task: Task;
}

export interface CreateTaskRequest {
  readonly channelId: string;
  readonly title: string;
  readonly prompt: string;
}

export interface UpdateTaskRequest {
  readonly channelId?: string;
  readonly title?: string;
  readonly prompt?: string;
  readonly status?: TaskStatus;
}

export type ResourceType = "channel" | "bound_path" | "workspace" | "provider" | "task" | "workflow_step";

export type ResourceLeaseStatus = "active" | "released" | "expired";

export interface ResourceLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly resourceType: ResourceType;
  readonly resourceKey: string;
  readonly ownerType: "run" | "workflow_step" | "system";
  readonly ownerId: string;
  readonly status: ResourceLeaseStatus;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly releasedAt?: string;
}

export type StateEntityType = "task" | "run" | "approval" | "media_job" | "workflow" | "workflow_step";

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

export type SecretRefKind = "env" | "keychain";
export type SecretStatusKind = SecretRefKind | "local";

export type SecretPurpose =
  | "provider_api_key"
  | "github_token"
  | "webhook_secret"
  | "custom_header"
  | "automation_token";

export type SecretStatusErrorCode =
  | "secret_missing"
  | "secret_access_denied"
  | "secret_store_unavailable"
  | "invalid_secret_ref";

export interface SecretStatus {
  readonly ref: string;
  readonly kind: SecretStatusKind;
  readonly configured: boolean;
  readonly errorCode?: SecretStatusErrorCode;
  readonly message?: string;
}

export interface SecretStatusResponse {
  readonly status: SecretStatus;
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
  readonly apiKeyStatus?: SecretStatus;
  readonly headers: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled: boolean;
  readonly lastCheck?: ProviderCheckResult;
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

export interface ProviderSecretResponse {
  readonly providerId: string;
  readonly apiKey: string;
  readonly apiKeyRef?: string;
  readonly configured: boolean;
}

export interface ProviderTemplate {
  readonly templateId: string;
  readonly description: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities: readonly ProviderCapability[];
  readonly enabled?: boolean;
}

export interface ProviderTemplateListResponse {
  readonly templates: readonly ProviderTemplate[];
}

export interface ProviderModelOption {
  readonly id: string;
  readonly displayName?: string;
  readonly ownedBy?: string;
  readonly createdAt?: string;
}

export interface ProviderModelListRequest {
  readonly kind: ProviderKind;
  readonly providerId: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
}

export interface ProviderModelListResponse {
  readonly source: string;
  readonly models: readonly ProviderModelOption[];
}

export interface ProviderCheckResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

export interface ProviderDraftCheckRequest extends ProviderMutationRequest {}

export interface ProviderMutationRequest {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly providerId: string;
  readonly model: string;
  readonly api: ProviderApi;
  readonly baseUrl?: string;
  readonly apiKeyRef?: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly headers?: Record<string, string>;
  readonly authHeader?: boolean;
  readonly reasoning?: boolean;
  readonly input?: readonly string[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly compat?: Record<string, unknown>;
  readonly capabilities?: readonly string[];
  readonly enabled?: boolean;
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
  readonly runId?: string;
  readonly taskId?: string;
  readonly mediaJobId?: string;
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

export interface ResolveApprovalRequest {
  readonly reason?: string;
}

export type ApprovalToolDecision = "allow" | "ask" | "deny";

export interface ApprovalPolicy {
  readonly workspaceId: string;
  readonly toolDecisions: Record<ToolName, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalPolicyResponse {
  readonly cwd: string;
  readonly policy: ApprovalPolicy;
}

export interface UpdateApprovalPolicyRequest {
  readonly toolDecisions: Record<ToolName, ApprovalToolDecision>;
  readonly allowedWritePaths: readonly string[];
}

export type ToolName = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export interface ListTasksRequest {
  readonly channelId?: string;
  readonly status?: TaskStatus;
  readonly limit?: number;
}

export interface ListApprovalsRequest {
  readonly status?: ApprovalStatus | string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly limit?: number;
}

export interface ListStateTransitionsRequest {
  readonly entityType?: StateEntityType;
  readonly entityId?: string;
  readonly limit?: number;
}

export interface ListResourceLeasesRequest {
  readonly status?: ResourceLeaseStatus;
  readonly ownerId?: string;
  readonly limit?: number;
}
