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
  ChannelExecutionProposal,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelHandoff,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelMessageListPage,
  ChannelUpdateInput,
  CreateChannelAttachmentInput,
  CreateChannelContextSummaryInput,
  CreateChannelDecisionInput,
  CreateChannelExecutionProposalInput,
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
  ListChannelExecutionProposalsOptions,
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
  UpdateChannelExecutionProposalInput,
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
  WorkUnitTransitionEvent,
  WorkflowStepTransitionEvent,
  WorkflowTransitionEvent,
} from "./state-machines.js";
import type {
  AcquireRuntimeSemaphoreSlotInput,
  AppendRuntimeEventInput,
  CreateWorkUnitAttemptInput,
  CreateWorkUnitInput,
  ListRuntimeEventsOptions,
  ListRuntimeSemaphoreSlotsOptions,
  ListWorkUnitsOptions,
  RecordRuntimeHeartbeatInput,
  RuntimeEvent,
  RuntimeHeartbeat,
  RuntimeSemaphoreSlot,
  WorkUnit,
  WorkUnitAttempt,
  WorkUnitStatus,
} from "./runtime-supervisor-types.js";
import type {
  CreateExternalWorkActionInput,
  CreateExternalWorkCiTriageInput,
  CreateExternalWorkWorkflowInput,
  ExternalWorkAction,
  ExternalWorkCiTriageRecord,
  ExternalWorkRecord,
  ExternalWorkSchedulerState,
  ExternalWorkWorkflowResult,
  ListExternalWorkActionsOptions,
  ListExternalWorkCiTriageOptions,
  ListExternalWorkRecordsOptions,
  ListExternalWorkSchedulerStatesOptions,
  UpdateExternalWorkActionInput,
  UpdateExternalWorkCiTriageInput,
  UpdateExternalWorkSchedulerStateInput,
  UpsertExternalWorkSchedulerStateInput,
} from "./external-work-types.js";
import type {
  CreateMcpServerInput,
  ListMcpServersOptions,
  ListMcpToolsOptions,
  McpServer,
  McpServerStatus,
  McpTool,
  ReplaceMcpServerToolInput,
  ReplaceTeammateMcpBindingInput,
  TeammateMcpBinding,
  UpdateMcpServerInput,
} from "./mcp-types.js";
import type {
  CreateMemoryObjectInput,
  CreateUsedMemoryEventInput,
  ListMemoryObjectsOptions,
  ListUsedMemoryEventsOptions,
  MemoryObject,
  MemoryObjectUpdateInput,
  MemoryRecallRequest,
  MemoryRecallResult,
  UsedMemoryEvent,
} from "./memory-types.js";

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
  readonly selectedSkillId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly eventLogPath: string;
  readonly workUnitId?: string;
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
  readonly selectedSkillId?: string;
  readonly providerPresetId?: string;
  readonly providerName: string;
  readonly providerModel: string;
  readonly taskSnapshot: unknown;
  readonly providerSnapshot: unknown;
  readonly requestSnapshot: unknown;
  readonly workUnitId?: string;
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
  readonly externalWorkId?: string;
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
  readonly externalWorkId?: string;
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
  createWorkUnit(input: CreateWorkUnitInput): WorkUnit;
  getWorkUnit(workUnitId: string): WorkUnit | undefined;
  listWorkUnits(options?: ListWorkUnitsOptions): WorkUnit[];
  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined;
  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined;
  transitionWorkUnitStatus(input: {
    readonly workUnitId: string;
    readonly expectedStatus?: WorkUnitStatus;
    readonly event: WorkUnitTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly activeAttemptId?: string | null;
    readonly startedAt?: string;
    readonly endedAt?: string | null;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): TransitionResult<WorkUnitStatus>;
  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt;
  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined;
  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[];
  updateWorkUnitAttemptStatus(input: {
    readonly attemptId: string;
    readonly status: WorkUnitAttempt["status"];
    readonly now: string;
    readonly startedAt?: string;
    readonly endedAt?: string;
    readonly lastEventAt?: string;
    readonly lastHeartbeatAt?: string;
    readonly abortRequestedAt?: string;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
  }): WorkUnitAttempt | undefined;
  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent;
  listRuntimeEvents(workUnitId: string, options?: ListRuntimeEventsOptions): RuntimeEvent[];
  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat;
  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined;
  releaseRuntimeSemaphoreSlotsForOwner(ownerId: string, releasedAt: string, releaseReason: string): number;
  listRuntimeSemaphoreSlots(options?: ListRuntimeSemaphoreSlotsOptions): RuntimeSemaphoreSlot[];
  createArtifact(input: CreateRunArtifactInput): RunArtifact;
  getArtifact(artifactId: string): RunArtifact | undefined;
  listArtifacts(runId: string): RunArtifact[];
  listMediaJobArtifacts(mediaJobId: string): RunArtifact[];
  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[];
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
  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject;
  getMemoryObject(id: string): MemoryObject | undefined;
  listMemoryObjects(options?: ListMemoryObjectsOptions): MemoryObject[];
  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined;
  recallMemory(input: MemoryRecallRequest): MemoryRecallResult;
  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent;
  listUsedMemoryEvents(options?: ListUsedMemoryEventsOptions): UsedMemoryEvent[];
  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread;
  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[];
  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined;
  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage;
  updateTeammateDirectMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: TeammateDirectMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): TeammateDirectMessage | undefined;
  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage;
  updateChannelMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: ChannelMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): ChannelMessage | undefined;
  getChannelMessage(id: string): ChannelMessage | undefined;
  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[];
  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage;
  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal;
  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined;
  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[];
  updateChannelExecutionProposal(id: string, input: UpdateChannelExecutionProposalInput, now: string): ChannelExecutionProposal | undefined;
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
  createOrReuseExternalWorkWorkflow(input: CreateExternalWorkWorkflowInput, now: string): ExternalWorkWorkflowResult;
  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined;
  listExternalWorkRecords(options?: ListExternalWorkRecordsOptions): ExternalWorkRecord[];
  countExternalWorkRecords(options?: Omit<ListExternalWorkRecordsOptions, "limit">): number;
  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined;
  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined;
  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction;
  getExternalWorkAction(id: string): ExternalWorkAction | undefined;
  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined;
  listExternalWorkActions(options?: ListExternalWorkActionsOptions): ExternalWorkAction[];
  countExternalWorkActions(options?: Omit<ListExternalWorkActionsOptions, "limit">): number;
  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined;
  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord;
  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined;
  getExternalWorkCiTriageByFailureKey(sourceKind: ExternalWorkCiTriageRecord["sourceKind"], failureKey: string): ExternalWorkCiTriageRecord | undefined;
  listExternalWorkCiTriage(options?: ListExternalWorkCiTriageOptions): ExternalWorkCiTriageRecord[];
  countExternalWorkCiTriage(options?: Omit<ListExternalWorkCiTriageOptions, "limit">): number;
  updateExternalWorkCiTriage(id: string, input: UpdateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord | undefined;
  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState;
  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined;
  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined;
  listExternalWorkSchedulerStates(options?: ListExternalWorkSchedulerStatesOptions): ExternalWorkSchedulerState[];
  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined;
  createMcpServer(input: CreateMcpServerInput, now: string): McpServer;
  getMcpServer(id: string): McpServer | undefined;
  listMcpServers(options?: ListMcpServersOptions): McpServer[];
  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined;
  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined;
  deleteMcpServer(id: string): boolean;
  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void;
  getMcpServerSecret(serverId: string, secretName: string): string | undefined;
  hasMcpServerSecret(serverId: string, secretName: string): boolean;
  deleteMcpServerSecret(serverId: string, secretName: string): boolean;
  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[];
  listMcpTools(options?: ListMcpToolsOptions): McpTool[];
  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[];
  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[];
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
