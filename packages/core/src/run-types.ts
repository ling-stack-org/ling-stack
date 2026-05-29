import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  CreateApprovalRequestInput,
  ListApprovalRequestsOptions,
  ResolveApprovalRequestInput,
} from "./approval-types.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyUpdateInput,
} from "./approval-policy.js";
import type {
  ListProviderPresetsOptions,
  ProviderCheckResult,
  ProviderPreset,
  ProviderPresetInput,
  ProviderPresetUpdateInput,
} from "./provider-types.js";
import type { LingStackRuntimePaths } from "./runtime-paths.js";
import type {
  CreateMediaJobInput,
  ListMediaJobsOptions,
  MediaJob,
  UpdateMediaJobStatusInput,
} from "./media-types.js";
import type {
  AiTeammate,
  AiTeammateUpdateInput,
  Channel,
  ChannelAttachment,
  ChannelBrief,
  ChannelContextSummary,
  ChannelDecision,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelHandoff,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelUpdateInput,
  CreateChannelAttachmentInput,
  CreateChannelContextSummaryInput,
  CreateChannelDecisionInput,
  CreateChannelWorkflowInput,
  CreateChannelWorkflowStepInput,
  CreateChannelHandoffInput,
  CreateChannelInput,
  CreateChannelLinkPreviewInput,
  CreateChannelMessageInput,
  CreateAiTeammateInput,
  CreateTeammateDirectMessageInput,
  CreateTaskInput,
  ListAiTeammatesOptions,
  ListChannelAttachmentsOptions,
  ListChannelContextSummariesOptions,
  ListChannelDecisionsOptions,
  ListChannelWorkflowStepsOptions,
  ListChannelWorkflowsOptions,
  ListChannelHandoffsOptions,
  ListChannelsOptions,
  ListChannelLinkPreviewsOptions,
  ListChannelMessagesOptions,
  ListTeammateDirectMessagesOptions,
  ListTasksOptions,
  ReplaceTeammateChannelMembershipInput,
  ReplaceTeammateMemoryScopeInput,
  ReplaceTeammateSkillBindingInput,
  Task,
  TaskUpdateInput,
  TeammateChannelMembership,
  TeammateDirectMessage,
  TeammateDirectThread,
  TeammateMemoryScope,
  TeammateSkillBinding,
  UpdateChannelBriefInput,
  UpdateChannelContextSummaryInput,
  UpdateChannelDecisionInput,
  UpdateChannelWorkflowInput,
  UpdateChannelWorkflowStepInput,
  UpdateChannelHandoffInput,
  UpdateChannelLinkPreviewInput,
} from "./workspace-types.js";
import type {
  CreateResourceLeaseInput,
  CreateStateTransitionEventInput,
  ListResourceLeasesOptions,
  ListStateTransitionEventsOptions,
  ResourceLease,
  ResourceLeaseOwnerType,
  ResourceLeaseStatus,
  StateTransitionEvent,
} from "./channel-runtime-types.js";
import type {
  RunTransitionEvent,
  StateTransitionActor,
  TaskTransitionEvent,
  TransitionResult,
  WorkflowStepTransitionEvent,
  WorkflowTransitionEvent,
} from "./state-machines.js";

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
  | "approval_expired"
  | "artifact_created"
  | "result";

export interface RunSession {
  readonly id: string;
  readonly status: RunStatus;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
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

export interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: RunEventType;
  readonly data: unknown;
}

export interface CreateRunInput {
  readonly id: string;
  readonly cwd: string;
  readonly taskId: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly createdAt: string;
}

export interface ListRunEventsOptions {
  readonly afterSeq?: number;
  readonly limit?: number;
}

export interface ListRunsOptions {
  readonly status?: RunStatus;
  readonly teammateId?: string;
  readonly limit?: number;
}

export interface RunSummary {
  readonly runId: string;
  readonly status: RunStatus;
  readonly taskId: string;
  readonly eventCount: number;
  readonly messageCount?: number;
  readonly startedAt?: string;
  readonly endedAt: string;
  readonly errorMessage: string | null;
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

export interface CreateRunArtifactInput {
  readonly id?: string;
  readonly runId?: string;
  readonly mediaJobId?: string;
  readonly type: ArtifactType;
  readonly path: string;
  readonly title?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
}

export interface RunStore {
  readonly paths: LingStackRuntimePaths;
  createRun(input: CreateRunInput): RunSession;
  markRunStarted(runId: string, startedAt: string): void;
  markRunWaitingForApproval(runId: string, updatedAt: string): void;
  markRunRunning(runId: string, updatedAt: string): void;
  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void;
  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void;
  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void;
  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope;
  getRun(runId: string): RunSession | undefined;
  listRuns(options?: ListRunsOptions): RunSession[];
  listEvents(runId: string, options?: ListRunEventsOptions): RunEventEnvelope[];
  countEvents(runId: string): number;
  createArtifact(input: CreateRunArtifactInput): RunArtifact;
  getArtifact(artifactId: string): RunArtifact | undefined;
  listArtifacts(runId: string): RunArtifact[];
  listMediaJobArtifacts(mediaJobId: string): RunArtifact[];
  recoverStaleRuns(now: string): number;
  listStateTransitionEvents(options?: ListStateTransitionEventsOptions): StateTransitionEvent[];
  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent;
  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined;
  transitionTaskStatus(input: {
    readonly taskId: string;
    readonly expectedStatus?: Task["status"];
    readonly event: TaskTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly currentRunId?: string | null;
    readonly assigneeTeammateId?: string | null;
  }): TransitionResult<Task["status"]>;
  transitionRunStatus(input: {
    readonly runId: string;
    readonly expectedStatus?: RunStatus;
    readonly event: RunTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly summaryPath?: string;
    readonly errorMessage?: string | null;
  }): TransitionResult<RunStatus>;
  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined;
  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number;
  expireResourceLeases(now: string): number;
  listResourceLeases(options?: ListResourceLeasesOptions): ResourceLease[];
  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined;
  createChannel(input: CreateChannelInput, now: string): Channel;
  getChannel(id: string): Channel | undefined;
  listChannels(options?: ListChannelsOptions): Channel[];
  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined;
  deleteChannel(id: string): boolean;
  createTask(input: CreateTaskInput, now: string): Task;
  getTask(id: string): Task | undefined;
  listTasks(options?: ListTasksOptions): Task[];
  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined;
  deleteTask(id: string): boolean;
  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate;
  getAiTeammate(id: string): AiTeammate | undefined;
  listAiTeammates(options?: ListAiTeammatesOptions): AiTeammate[];
  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined;
  disableAiTeammate(id: string, now: string): AiTeammate | undefined;
  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[];
  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[];
  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[];
  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[];
  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[];
  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[];
  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread;
  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[];
  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage;
  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage;
  getChannelMessage(id: string): ChannelMessage | undefined;
  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[];
  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment;
  getChannelAttachment(id: string): ChannelAttachment | undefined;
  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[];
  deleteChannelAttachment(id: string): boolean;
  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview;
  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined;
  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[];
  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined;
  getChannelBrief(channelId: string): ChannelBrief | undefined;
  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief;
  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision;
  getChannelDecision(id: string): ChannelDecision | undefined;
  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[];
  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined;
  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff;
  getChannelHandoff(id: string): ChannelHandoff | undefined;
  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[];
  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined;
  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary;
  getChannelContextSummary(id: string): ChannelContextSummary | undefined;
  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[];
  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined;
  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow;
  getChannelWorkflow(id: string): ChannelWorkflow | undefined;
  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[];
  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined;
  transitionChannelWorkflowStatus(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflow["status"];
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflow["status"]>;
  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep;
  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined;
  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[];
  updateChannelWorkflowStep(id: string, input: UpdateChannelWorkflowStepInput, now: string): ChannelWorkflowStep | undefined;
  transitionChannelWorkflowStepStatus(input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStep["status"];
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }): TransitionResult<ChannelWorkflowStep["status"]>;
  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset;
  getProviderPreset(id: string): ProviderPreset | undefined;
  listProviderPresets(options?: ListProviderPresetsOptions): ProviderPreset[];
  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined;
  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined;
  deleteProviderPreset(id: string): boolean;
  setProviderSecret(providerId: string, secretValue: string, now: string): void;
  getProviderSecret(providerId: string): string | undefined;
  hasProviderSecret(providerId: string): boolean;
  deleteProviderSecret(providerId: string): boolean;
  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob;
  getMediaJob(id: string): MediaJob | undefined;
  listMediaJobs(options?: ListMediaJobsOptions): MediaJob[];
  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined;
  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  listApprovalRequests(options?: ListApprovalRequestsOptions): ApprovalRequest[];
  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined;
  getApprovalPolicy(): ApprovalPolicy;
  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy;
  close(): void;
}

export function createRunId(): string {
  return `run_${randomUUID()}`;
}

export function createEventId(): string {
  return `evt_${randomUUID()}`;
}

export function createArtifactId(): string {
  return `artifact_${randomUUID()}`;
}
