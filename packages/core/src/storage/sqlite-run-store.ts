import { existsSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  ensureRuntimePaths,
  getRunEventLogPath,
  resolveRuntimePaths,
  type LingStackRuntimePaths,
} from "../runtime-paths.js";
import {
  createApprovalRequestId,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
  type ListApprovalRequestsOptions,
  type ResolveApprovalRequestInput,
} from "../approval-types.js";
import {
  createProviderPresetId,
  type ListProviderPresetsOptions,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
} from "../provider-types.js";
import {
  createDefaultApprovalPolicy,
  defaultApprovalToolDecisions,
  readOnlyRunTools,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type ApprovalToolDecision,
  type ApprovalToolDecisions,
  type RunTool,
} from "../approval-policy.js";
import {
  DEFAULT_WORKSPACE_ID,
  createAiTeammateId,
  createBuiltinAiTeammateId,
  createChannelAttachmentId,
  createChannelBriefId,
  createChannelContextSummaryId,
  createChannelDecisionId,
  createChannelExecutionProposalId,
  createChannelHandoffId,
  createChannelId,
  createChannelLinkPreviewId,
  createChannelMessageId,
  createChannelWorkflowId,
  createChannelWorkflowStepId,
  createTeammateDirectMessageId,
  createTeammateDirectThreadId,
  createTeammateMemoryScopeId,
  createTaskId,
  normalizeChannelRuntimePolicy,
  type AiTeammate,
  type AiTeammateStatus,
  type AiTeammateUpdateInput,
  type Channel,
  type ChannelAttachment,
  type ChannelAttachmentKind,
  type ChannelBrief,
  type ChannelContextSummary,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  type ChannelDecision,
  type ChannelDecisionStatus,
  type ChannelExecutionProposal,
  type ChannelExecutionProposalStatus,
  type ChannelHandoff,
  type ChannelHandoffStatus,
  type ChannelLinkPreview,
  type ChannelLinkPreviewStatus,
  type ChannelMessage,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
  type ChannelMessageListPage,
  type ChannelRuntimePolicy,
  type ChannelStatus,
  type ChannelUpdateInput,
  type ChannelWorkflow,
  type ChannelWorkflowStep,
  type ChannelWorkflowStepStatus,
  type ChannelWorkflowStatus,
  type CreateAiTeammateInput,
  type CreateChannelAttachmentInput,
  type CreateChannelContextSummaryInput,
  type CreateChannelDecisionInput,
  type CreateChannelExecutionProposalInput,
  type CreateChannelHandoffInput,
  type CreateChannelInput,
  type CreateChannelLinkPreviewInput,
  type CreateChannelMessageInput,
  type CreateChannelWorkflowInput,
  type CreateChannelWorkflowStepInput,
  type CreateTeammateDirectMessageInput,
  type CreateTaskInput,
  type ListAiTeammatesOptions,
  type ListChannelAttachmentsOptions,
  type ListChannelContextSummariesOptions,
  type ListChannelDecisionsOptions,
  type ListChannelExecutionProposalsOptions,
  type ListChannelHandoffsOptions,
  type ListChannelsOptions,
  type ListChannelLinkPreviewsOptions,
  type ListChannelMessagesOptions,
  type ListChannelWorkflowsOptions,
  type ListChannelWorkflowStepsOptions,
  type ListTeammateDirectMessagesOptions,
  type ListTasksOptions,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type Task,
  type TaskStatus,
  type TaskUpdateInput,
  type TeammateChannelMembership,
  type TeammateDirectMessage,
  type TeammateDirectMessageAuthorType,
  type TeammateDirectMessageStatus,
  type TeammateDirectThread,
  type TeammateMemoryScope,
  type TeammateMemoryScopeKind,
  type TeammateSkillBinding,
  type TeammateSkillBindingSource,
  type UpdateChannelBriefInput,
  type UpdateChannelContextSummaryInput,
  type UpdateChannelDecisionInput,
  type UpdateChannelExecutionProposalInput,
  type UpdateChannelHandoffInput,
  type UpdateChannelLinkPreviewInput,
  type UpdateChannelWorkflowInput,
  type UpdateChannelWorkflowStepInput,
} from "../workspace-types.js";
import { GSTACK_DEFAULT_SKILL_PACK_ID, listDefaultTeammateTemplates } from "../builtin-skill-packs.js";
import type { AiTeammateRoleKey, SkillApprovalProfile } from "../skill-types.js";
import {
  createArtifactId,
  createEventId,
  type ArtifactType,
  type CreateRunArtifactInput,
  type CreateRunInput,
  type ListRunEventsOptions,
  type ListRunsOptions,
  type RunArtifact,
  type RunEventEnvelope,
  type RunEventType,
  type RunSession,
  type RunStore,
  type RunStatus,
} from "../run-types.js";
import {
  createRuntimeEventId,
  createRuntimeHeartbeatId,
  createRuntimeSemaphoreSlotId,
  createWorkUnitAttemptId,
  createWorkUnitId,
  defaultRuntimeTimeoutPolicy,
  type AcquireRuntimeSemaphoreSlotInput,
  type AppendRuntimeEventInput,
  type CreateWorkUnitAttemptInput,
  type CreateWorkUnitInput,
  type ListRuntimeEventsOptions,
  type ListRuntimeSemaphoreSlotsOptions,
  type ListWorkUnitsOptions,
  type RecordRuntimeHeartbeatInput,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeHeartbeat,
  type RuntimeSemaphoreResourceType,
  type RuntimeSemaphoreSlot,
  type RuntimeSemaphoreSlotStatus,
  type RuntimeTimeoutPolicy,
  type WorkUnit,
  type WorkUnitAttempt,
  type WorkUnitAttemptStatus,
  type WorkUnitKind,
  type WorkUnitStatus,
} from "../runtime-supervisor-types.js";
import {
  createExternalWorkActionId,
  createExternalWorkCiTriageId,
  createExternalWorkId,
  type CreateExternalWorkActionInput,
  type CreateExternalWorkCiTriageInput,
  type CreateExternalWorkWorkflowInput,
  type ExternalWorkAction,
  type ExternalWorkCiTriageRecord,
  type ExternalWorkItem,
  type ExternalWorkRecord,
  type ExternalWorkSchedulerState,
  type ExternalWorkWorkflowResult,
  type ListExternalWorkActionsOptions,
  type ListExternalWorkCiTriageOptions,
  type ListExternalWorkRecordsOptions,
  type ListExternalWorkSchedulerStatesOptions,
  type UpdateExternalWorkActionInput,
  type UpdateExternalWorkCiTriageInput,
  type UpdateExternalWorkSchedulerStateInput,
  type UpsertExternalWorkSchedulerStateInput,
} from "../external-work-types.js";
import {
  createResourceLeaseId,
  createStateTransitionEventId,
  type CreateResourceLeaseInput,
  type CreateStateTransitionEventInput,
  type ListResourceLeasesOptions,
  type ListStateTransitionEventsOptions,
  type ResourceLease,
  type ResourceLeaseOwnerType,
  type ResourceLeaseStatus,
  type StateTransitionEvent,
} from "../channel-runtime-types.js";
import {
  transitionRun,
  transitionTask,
  transitionWorkUnit,
  transitionWorkflow,
  transitionWorkflowStep,
  type RunTransitionEvent,
  type StateEntityType,
  type StateTransitionActor,
  type TaskTransitionEvent,
  type TransitionResult,
  type WorkUnitTransitionEvent,
  type WorkflowStepTransitionEvent,
  type WorkflowTransitionEvent,
} from "../state-machines.js";
import {
  createMediaJobId,
  type CreateMediaJobInput,
  type ListMediaJobsOptions,
  type MediaJob,
  type MediaJobStatus,
  type UpdateMediaJobStatusInput,
} from "../media-types.js";
import {
  createMcpServerId,
  type CreateMcpServerInput,
  type ListMcpServersOptions,
  type ListMcpToolsOptions,
  type McpServer,
  type McpServerStatus,
  type McpServerTransport,
  type McpTool,
  type ReplaceMcpServerToolInput,
  type ReplaceTeammateMcpBindingInput,
  type TeammateMcpBinding,
  type UpdateMcpServerInput,
} from "../mcp-types.js";
import {
  createMemoryObjectId,
  createUsedMemoryEventId,
  type CreateMemoryObjectInput,
  type CreateUsedMemoryEventInput,
  type ListMemoryObjectsOptions,
  type ListUsedMemoryEventsOptions,
  type MemoryObject,
  type MemoryObjectUpdateInput,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySensitivity,
  type MemorySourceRef,
  type UsedMemoryEvent,
} from "../memory-types.js";
import { redactSecrets } from "../redaction.js";
import { appendEventLogLine } from "./event-log.js";

const INITIAL_MIGRATION_VERSION = 1;
const INITIAL_MIGRATION_NAME = "create_run_sessions_and_events";
const PROVIDERS_MIGRATION_VERSION = 2;
const PROVIDERS_MIGRATION_NAME = "create_provider_presets";
const APPROVALS_MIGRATION_VERSION = 3;
const APPROVALS_MIGRATION_NAME = "create_approval_requests";
const WORKSPACE_MIGRATION_VERSION = 4;
const WORKSPACE_MIGRATION_NAME = "create_workspace_channels_tasks";
const APPROVAL_POLICY_MIGRATION_VERSION = 5;
const APPROVAL_POLICY_MIGRATION_NAME = "create_approval_policy";
const PROVIDER_CHECKS_MIGRATION_VERSION = 6;
const PROVIDER_CHECKS_MIGRATION_NAME = "add_provider_check_results";
const ARTIFACTS_MIGRATION_VERSION = 7;
const ARTIFACTS_MIGRATION_NAME = "create_artifacts";
const MEDIA_JOBS_MIGRATION_VERSION = 8;
const MEDIA_JOBS_MIGRATION_NAME = "create_media_jobs";
const MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION = 9;
const MEDIA_JOB_ARTIFACTS_MIGRATION_NAME = "allow_media_job_artifacts";
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION = 10;
const APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME = "allow_media_job_approval_owners";
const CHANNEL_RUNTIME_MIGRATION_VERSION = 11;
const CHANNEL_RUNTIME_MIGRATION_NAME = "add_channel_runtime_state_and_leases";
const PROVIDER_SECRETS_MIGRATION_VERSION = 12;
const PROVIDER_SECRETS_MIGRATION_NAME = "create_provider_secrets";
const CHANNEL_WORKSPACE_MIGRATION_VERSION = 13;
const CHANNEL_WORKSPACE_MIGRATION_NAME = "create_channel_workspace_assets";
const CHANNEL_PROTOCOL_MIGRATION_VERSION = 14;
const CHANNEL_PROTOCOL_MIGRATION_NAME = "create_channel_collaboration_protocol";
const CHANNEL_WORKFLOW_MIGRATION_VERSION = 15;
const CHANNEL_WORKFLOW_MIGRATION_NAME = "create_channel_handoff_workflows";
const AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION = 16;
const AI_TEAMMATE_WORKSPACE_MIGRATION_NAME = "create_ai_teammate_private_workspace";
const EXTERNAL_WORK_MIGRATION_VERSION = 17;
const EXTERNAL_WORK_MIGRATION_NAME = "create_external_work_items";
const EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION = 18;
const EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME = "create_external_work_scheduler_state";
const EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION = 19;
const EXTERNAL_WORK_ACTIONS_MIGRATION_NAME = "create_external_work_actions";
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION = 20;
const EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME = "create_external_work_ci_triage";
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION = 21;
const CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME = "create_channel_execution_proposals";
const RUNTIME_SUPERVISOR_MIGRATION_VERSION = 22;
const RUNTIME_SUPERVISOR_MIGRATION_NAME = "create_runtime_supervisor";
const MCP_TOOL_MANAGEMENT_MIGRATION_VERSION = 23;
const MCP_TOOL_MANAGEMENT_MIGRATION_NAME = "create_mcp_tool_management";
const LING_MEMORY_MIGRATION_VERSION = 24;
const LING_MEMORY_MIGRATION_NAME = "create_ling_memory_v1";
const SKILL_AWARE_RUN_MIGRATION_VERSION = 25;
const SKILL_AWARE_RUN_MIGRATION_NAME = "add_skill_aware_tasks_and_runs";
const STALE_RUN_ERROR = "Daemon stopped before the run reached a terminal state.";

export interface SqliteRunStoreOptions {
  readonly cwd: string;
  readonly paths?: LingStackRuntimePaths;
}

export class SqliteRunStore implements RunStore {
  readonly paths: LingStackRuntimePaths;
  private readonly database: DatabaseSync;

  constructor(options: SqliteRunStoreOptions) {
    this.paths = options.paths ?? resolveRuntimePaths(options.cwd);
    ensureRuntimePaths(this.paths);
    const existed = existsSync(this.paths.databasePath);
    this.database = new DatabaseSync(this.paths.databasePath);
    this.configureDatabase();
    this.applyMigrations();
    this.ensureDefaultWorkspace();
    this.ensureDefaultApprovalPolicy();
    this.ensureDefaultAiTeammates();

    if (!existed) {
      this.database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    }
  }

  createRun(input: CreateRunInput): RunSession {
    const eventLogPath = getRunEventLogPath(this.paths, input.id);
    const redactedTaskSnapshot = redactSecrets(input.taskSnapshot);
    const redactedProviderSnapshot = redactSecrets(input.providerSnapshot);
    const redactedRequestSnapshot = redactSecrets(input.requestSnapshot);

    this.database
      .prepare(`
        INSERT INTO run_sessions (
          id,
          status,
          cwd,
          task_id,
          channel_id,
          teammate_id,
          selected_skill_id,
          provider_preset_id,
          provider_name,
          provider_model,
          task_snapshot_json,
          provider_snapshot_json,
          request_snapshot_json,
          event_log_path,
          work_unit_id,
          summary_path,
          error_message,
          created_at,
          started_at,
          ended_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        "queued",
        input.cwd,
        input.taskId,
        input.channelId ?? null,
        input.teammateId ?? null,
        input.selectedSkillId ?? null,
        input.providerPresetId ?? null,
        input.providerName,
        input.providerModel,
        stringifyJson(redactedTaskSnapshot),
        stringifyJson(redactedProviderSnapshot),
        stringifyJson(redactedRequestSnapshot),
        eventLogPath,
        input.workUnitId ?? null,
        null,
        null,
        input.createdAt,
        null,
        null,
        input.createdAt,
      );

    const session = this.getRun(input.id);
    if (!session) {
      throw new Error(`Failed to create run session: ${input.id}`);
    }
    return session;
  }

  markRunStarted(runId: string, startedAt: string): void {
    this.updateRunStatus(runId, "running", startedAt, null, undefined, undefined, startedAt);
  }

  markRunWaitingForApproval(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "waiting_for_approval", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunRunning(runId: string, updatedAt: string): void {
    this.updateRunStatus(runId, "running", undefined, undefined, undefined, undefined, updatedAt);
  }

  markRunSucceeded(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "succeeded", undefined, endedAt, null, summaryPath, endedAt);
  }

  markRunFailed(runId: string, endedAt: string, errorMessage: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "failed", undefined, endedAt, errorMessage, summaryPath, endedAt);
  }

  markRunCancelled(runId: string, endedAt: string, summaryPath?: string): void {
    this.updateRunStatus(runId, "cancelled", undefined, endedAt, null, summaryPath, endedAt);
  }

  appendEvent(runId: string, type: RunEventType, data: unknown): RunEventEnvelope {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }

    const envelope: RunEventEnvelope = {
      id: createEventId(),
      runId,
      seq: this.nextEventSeq(runId),
      ts: new Date().toISOString(),
      type,
      data: redactSecrets(data),
    };

    this.database
      .prepare("INSERT INTO run_events (id, run_id, seq, ts, type, data_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(envelope.id, envelope.runId, envelope.seq, envelope.ts, envelope.type, stringifyJson(envelope.data));
    appendEventLogLine(run.eventLogPath, envelope);
    return envelope;
  }

  getRun(runId: string): RunSession | undefined {
    const row = this.database
      .prepare(
        `
          SELECT
            id,
            status,
            cwd,
            task_id,
            channel_id,
            teammate_id,
            selected_skill_id,
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
            request_snapshot_json,
            event_log_path,
            work_unit_id,
            summary_path,
            error_message,
            created_at,
            started_at,
            ended_at,
            updated_at
          FROM run_sessions
          WHERE id = ?
        `,
      )
      .get(runId);

    return row ? mapRunSession(row) : undefined;
  }

  listRuns(options: ListRunsOptions = {}): RunSession[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const statement = this.database.prepare(`
      SELECT
        id,
        status,
        cwd,
        task_id,
        channel_id,
        teammate_id,
        selected_skill_id,
        provider_preset_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
        request_snapshot_json,
        event_log_path,
        work_unit_id,
        summary_path,
        error_message,
        created_at,
        started_at,
        ended_at,
        updated_at
      FROM run_sessions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = statement.all(...params);
    return rows.map(mapRunSession);
  }

  listEvents(runId: string, options: ListRunEventsOptions = {}): RunEventEnvelope[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.database
      .prepare(
        `
          SELECT id, run_id, seq, ts, type, data_json
          FROM run_events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `,
      )
      .all(runId, afterSeq, limit)
      .map(mapRunEvent);
  }

  countEvents(runId: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "count");
  }

  createWorkUnit(input: CreateWorkUnitInput): WorkUnit {
    const id = input.id ?? createWorkUnitId();
    const timeoutPolicy = input.timeoutPolicy ?? defaultRuntimeTimeoutPolicy;
    const status = input.status ?? "queued";
    this.database
      .prepare(`
        INSERT INTO work_units (
          id,
          workspace_id,
          kind,
          owner_type,
          owner_id,
          channel_id,
          task_id,
          teammate_id,
          provider_preset_id,
          runner_id,
          idempotency_key,
          status,
          priority,
          attempt_count,
          active_attempt_id,
          created_by_client_id,
          created_by_actor,
          request_json,
          timeout_policy_json,
          linked_run_id,
          linked_message_id,
          linked_media_job_id,
          linked_external_work_id,
          created_at,
          updated_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workspaceId,
        input.kind,
        input.ownerType,
        input.ownerId,
        input.channelId ?? null,
        input.taskId ?? null,
        input.teammateId ?? null,
        input.providerPresetId ?? null,
        input.runnerId ?? null,
        input.idempotencyKey,
        status,
        input.priority ?? 0,
        0,
        null,
        input.createdByClientId ?? null,
        input.createdByActor,
        stringifyJson(redactSecrets(input.request)),
        stringifyJson(timeoutPolicy),
        input.linkedRunId ?? null,
        input.linkedMessageId ?? null,
        input.linkedMediaJobId ?? null,
        input.linkedExternalWorkId ?? null,
        input.now,
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
      );

    const workUnit = this.getWorkUnit(id);
    if (!workUnit) {
      throw new Error(`Failed to create work unit: ${id}`);
    }
    return workUnit;
  }

  getWorkUnit(workUnitId: string): WorkUnit | undefined {
    const row = this.database.prepare(workUnitSelectSql("WHERE id = ?")).get(workUnitId);
    return row ? mapWorkUnit(row) : undefined;
  }

  listWorkUnits(options: ListWorkUnitsOptions = {}): WorkUnit[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.linkedRunId) {
      clauses.push("linked_run_id = ?");
      params.push(options.linkedRunId);
    }
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${workUnitSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapWorkUnit);
  }

  findWorkUnitByIdempotency(input: {
    readonly kind: WorkUnit["kind"];
    readonly ownerType: string;
    readonly ownerId: string;
    readonly idempotencyKey: string;
  }): WorkUnit | undefined {
    const row = this.database
      .prepare(workUnitSelectSql("WHERE workspace_id = ? AND kind = ? AND owner_type = ? AND owner_id = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, input.kind, input.ownerType, input.ownerId, input.idempotencyKey);
    return row ? mapWorkUnit(row) : undefined;
  }

  linkRunToWorkUnit(runId: string, workUnitId: string, now: string): RunSession | undefined {
    this.database
      .prepare("UPDATE run_sessions SET work_unit_id = ?, updated_at = ? WHERE id = ?")
      .run(workUnitId, now, runId);
    this.database
      .prepare("UPDATE work_units SET linked_run_id = ?, updated_at = ? WHERE id = ?")
      .run(runId, now, workUnitId);
    return this.getRun(runId);
  }

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
  }): TransitionResult<WorkUnitStatus> {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("work_unit", input.workUnitId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: workUnit.status, to: workUnit.status, duplicate: true };
      }
    }

    const result = transitionWorkUnit({
      entityId: input.workUnitId,
      currentStatus: workUnit.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }

    const update = this.database
      .prepare(`
        UPDATE work_units
        SET
          status = ?,
          active_attempt_id = ?,
          updated_at = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.activeAttemptId === undefined ? workUnit.activeAttemptId ?? null : input.activeAttemptId,
        input.now,
        input.startedAt ?? workUnit.startedAt ?? null,
        input.endedAt === undefined ? workUnit.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? workUnit.lastEventAt ?? null,
        input.lastHeartbeatAt ?? workUnit.lastHeartbeatAt ?? null,
        input.errorCode === undefined ? workUnit.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? workUnit.errorMessage ?? null : input.errorMessage,
        input.workUnitId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getWorkUnit(input.workUnitId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workUnit.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: workUnit.workspaceId,
      entityType: "work_unit",
      entityId: input.workUnitId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  createWorkUnitAttempt(input: CreateWorkUnitAttemptInput): WorkUnitAttempt {
    const id = input.id ?? createWorkUnitAttemptId();
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    this.database
      .prepare(`
        INSERT INTO work_unit_attempts (
          id,
          work_unit_id,
          attempt_number,
          runtime_instance_id,
          runner_id,
          provider_preset_id,
          status,
          created_at,
          started_at,
          ended_at,
          last_event_at,
          last_heartbeat_at,
          abort_requested_at,
          error_code,
          error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.workUnitId,
        input.attemptNumber,
        input.runtimeInstanceId,
        input.runnerId,
        input.providerPresetId ?? null,
        input.status ?? "created",
        input.now,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      );
    this.database
      .prepare("UPDATE work_units SET attempt_count = MAX(attempt_count, ?), active_attempt_id = ?, updated_at = ? WHERE id = ?")
      .run(input.attemptNumber, id, input.now, input.workUnitId);
    const attempt = this.getWorkUnitAttempt(id);
    if (!attempt) {
      throw new Error(`Failed to create work unit attempt: ${id}`);
    }
    return attempt;
  }

  getWorkUnitAttempt(attemptId: string): WorkUnitAttempt | undefined {
    const row = this.database.prepare(workUnitAttemptSelectSql("WHERE id = ?")).get(attemptId);
    return row ? mapWorkUnitAttempt(row) : undefined;
  }

  listWorkUnitAttempts(workUnitId: string): WorkUnitAttempt[] {
    return this.database
      .prepare(`${workUnitAttemptSelectSql("WHERE work_unit_id = ?")} ORDER BY attempt_number ASC, created_at ASC`)
      .all(workUnitId)
      .map(mapWorkUnitAttempt);
  }

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
  }): WorkUnitAttempt | undefined {
    const attempt = this.getWorkUnitAttempt(input.attemptId);
    if (!attempt) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE work_unit_attempts
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          last_event_at = ?,
          last_heartbeat_at = ?,
          abort_requested_at = ?,
          error_code = ?,
          error_message = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        input.startedAt ?? attempt.startedAt ?? null,
        input.endedAt === undefined ? attempt.endedAt ?? null : input.endedAt,
        input.lastEventAt ?? attempt.lastEventAt ?? null,
        input.lastHeartbeatAt ?? attempt.lastHeartbeatAt ?? null,
        input.abortRequestedAt ?? attempt.abortRequestedAt ?? null,
        input.errorCode === undefined ? attempt.errorCode ?? null : input.errorCode,
        input.errorMessage === undefined ? attempt.errorMessage ?? null : input.errorMessage,
        input.attemptId,
      );
    return this.getWorkUnitAttempt(input.attemptId);
  }

  appendRuntimeEvent(input: AppendRuntimeEventInput): RuntimeEvent {
    const workUnit = this.getWorkUnit(input.workUnitId);
    if (!workUnit) {
      throw new Error(`Work unit not found: ${input.workUnitId}`);
    }
    const event: RuntimeEvent = {
      id: createRuntimeEventId(),
      workUnitId: input.workUnitId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      seq: this.nextRuntimeEventSeq(input.workUnitId),
      ts: input.ts,
      type: input.type,
      actor: input.actor,
      data: redactSecrets(input.data),
    };
    this.database
      .prepare(`
        INSERT INTO runtime_events (id, work_unit_id, attempt_id, seq, ts, type, actor, data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(event.id, event.workUnitId, event.attemptId ?? null, event.seq, event.ts, event.type, event.actor, stringifyJson(event.data));
    this.database
      .prepare("UPDATE work_units SET last_event_at = ?, updated_at = ? WHERE id = ?")
      .run(event.ts, event.ts, input.workUnitId);
    if (input.attemptId) {
      this.database
        .prepare("UPDATE work_unit_attempts SET last_event_at = ? WHERE id = ?")
        .run(event.ts, input.attemptId);
    }
    return event;
  }

  listRuntimeEvents(workUnitId: string, options: ListRuntimeEventsOptions = {}): RuntimeEvent[] {
    const afterSeq = options.afterSeq ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
    return this.database
      .prepare(`${runtimeEventSelectSql("WHERE work_unit_id = ? AND seq > ?")} ORDER BY seq ASC LIMIT ?`)
      .all(workUnitId, afterSeq, limit)
      .map(mapRuntimeEvent);
  }

  recordRuntimeHeartbeat(input: RecordRuntimeHeartbeatInput): RuntimeHeartbeat {
    const heartbeat: RuntimeHeartbeat = {
      id: createRuntimeHeartbeatId(),
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
      runtimeInstanceId: input.runtimeInstanceId,
      ts: input.ts,
      source: input.source,
      ...(input.detail !== undefined ? { detail: redactSecrets(input.detail) } : {}),
    };
    this.database
      .prepare(`
        INSERT INTO runtime_heartbeats (id, work_unit_id, attempt_id, runtime_instance_id, ts, source, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        heartbeat.id,
        heartbeat.workUnitId,
        heartbeat.attemptId,
        heartbeat.runtimeInstanceId,
        heartbeat.ts,
        heartbeat.source,
        heartbeat.detail === undefined ? null : stringifyJson(heartbeat.detail),
      );
    this.database
      .prepare("UPDATE work_units SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?")
      .run(input.ts, input.ts, input.workUnitId);
    this.database
      .prepare("UPDATE work_unit_attempts SET last_heartbeat_at = ? WHERE id = ?")
      .run(input.ts, input.attemptId);
    this.database
      .prepare("UPDATE resource_leases SET last_renewed_at = ? WHERE attempt_id = ? AND status = 'active'")
      .run(input.ts, input.attemptId);
    this.database
      .prepare("UPDATE runtime_semaphore_slots SET last_renewed_at = ? WHERE attempt_id = ? AND status = 'active'")
      .run(input.ts, input.attemptId);
    return heartbeat;
  }

  acquireRuntimeSemaphoreSlot(input: AcquireRuntimeSemaphoreSlotInput): RuntimeSemaphoreSlot | undefined {
    const id = createRuntimeSemaphoreSlotId();
    try {
      this.database.exec("BEGIN IMMEDIATE;");
      const activeCount = readNumber(
        this.database
          .prepare(`
            SELECT COUNT(*) AS count
            FROM runtime_semaphore_slots
            WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'
          `)
          .get(input.workspaceId, input.resourceType, input.resourceKey),
        "count",
      );
      if (activeCount >= input.limit) {
        this.database.exec("ROLLBACK;");
        return undefined;
      }
      this.database
        .prepare(`
          INSERT INTO runtime_semaphore_slots (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            work_unit_id,
            attempt_id,
            status,
            acquired_at,
            last_renewed_at,
            expires_at,
            released_at,
            release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          input.workspaceId,
          input.resourceType,
          input.resourceKey,
          input.ownerType,
          input.ownerId,
          input.workUnitId,
          input.attemptId,
          input.acquiredAt,
          input.acquiredAt,
          input.expiresAt,
          null,
          null,
        );
      this.database.exec("COMMIT;");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Ignore rollback failure; original error path returns no slot.
      }
      return undefined;
    }
    const slot = this.database.prepare(runtimeSemaphoreSlotSelectSql("WHERE id = ?")).get(id);
    return slot ? mapRuntimeSemaphoreSlot(slot) : undefined;
  }

  releaseRuntimeSemaphoreSlotsForOwner(ownerId: string, releasedAt: string, releaseReason: string): number {
    const result = this.database
      .prepare(`
        UPDATE runtime_semaphore_slots
        SET status = 'released', released_at = ?, release_reason = ?
        WHERE owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, releaseReason, ownerId);
    return Number(result.changes);
  }

  listRuntimeSemaphoreSlots(options: ListRuntimeSemaphoreSlotsOptions = {}): RuntimeSemaphoreSlot[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${runtimeSemaphoreSlotSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapRuntimeSemaphoreSlot);
  }

  createArtifact(input: CreateRunArtifactInput): RunArtifact {
    const runId = normalizeOptionalOwnerId(input.runId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkId = normalizeOptionalOwnerId(input.externalWorkId);
    const ownerCount = [runId, mediaJobId, externalWorkId].filter(Boolean).length;
    if (ownerCount !== 1) {
      throw new Error("Artifact must belong to exactly one run, media job, or external work item.");
    }
    if (runId && !this.getRun(runId)) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (mediaJobId && !this.getMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkId && !this.getExternalWorkRecord(externalWorkId)) {
      throw new Error(`External work item not found: ${externalWorkId}`);
    }

    const artifact: RunArtifact = omitUndefined({
      id: input.id ?? createArtifactId(),
      runId,
      mediaJobId,
      externalWorkId,
      type: input.type,
      path: input.path,
      title: input.title,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      createdAt: input.createdAt,
    });

    this.database
      .prepare(`
        INSERT INTO artifacts (
          id,
          run_id,
          media_job_id,
          external_work_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artifact.id,
        artifact.runId ?? null,
        artifact.mediaJobId ?? null,
        artifact.externalWorkId ?? null,
        artifact.type,
        artifact.path,
        artifact.title ?? null,
        artifact.contentType ?? null,
        artifact.sizeBytes ?? null,
        artifact.createdAt,
      );

    const created = this.getArtifact(artifact.id);
    if (!created) {
      throw new Error(`Failed to create artifact: ${artifact.id}`);
    }
    return created;
  }

  getArtifact(artifactId: string): RunArtifact | undefined {
    const row = this.database.prepare(artifactSelectSql("WHERE id = ?")).get(artifactId);
    return row ? mapArtifact(row) : undefined;
  }

  listArtifacts(runId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE run_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(runId)
      .map(mapArtifact);
  }

  listMediaJobArtifacts(mediaJobId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE media_job_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(mediaJobId)
      .map(mapArtifact);
  }

  listExternalWorkArtifacts(externalWorkId: string): RunArtifact[] {
    return this.database
      .prepare(`${artifactSelectSql("WHERE external_work_id = ?")} ORDER BY created_at ASC, id ASC`)
      .all(externalWorkId)
      .map(mapArtifact);
  }

  recoverStaleRuns(now: string): number {
    this.expireResourceLeases(now);
    const staleRuns = this.database
      .prepare("SELECT id FROM run_sessions WHERE status IN ('queued', 'running', 'waiting_for_approval')")
      .all()
      .map((row) => readString(row, "id"));

    for (const runId of staleRuns) {
      if (!this.hasTerminalEvent(runId)) {
        this.appendEvent(runId, "run_error", { message: STALE_RUN_ERROR });
      }
      this.markRunFailed(runId, now, STALE_RUN_ERROR);
    }

    return staleRuns.length;
  }

  listStateTransitionEvents(options: ListStateTransitionEventsOptions = {}): StateTransitionEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.entityType) {
      clauses.push("entity_type = ?");
      params.push(options.entityType);
    }
    if (options.entityId) {
      clauses.push("entity_id = ?");
      params.push(options.entityId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${stateTransitionSelectSql(whereClause)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapStateTransitionEvent);
  }

  recordStateTransitionEvent(input: CreateStateTransitionEventInput): StateTransitionEvent {
    const event: StateTransitionEvent = {
      id: createStateTransitionEventId(),
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    };
    this.database
      .prepare(`
        INSERT INTO state_transition_events (
          id,
          workspace_id,
          entity_type,
          entity_id,
          from_status,
          to_status,
          event,
          actor,
          reason,
          idempotency_key,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        event.entityType,
        event.entityId,
        event.fromStatus,
        event.toStatus,
        event.event,
        event.actor,
        event.reason ?? null,
        event.idempotencyKey ?? null,
        event.createdAt,
      );
    return event;
  }

  findStateTransitionByIdempotency(
    entityType: StateTransitionEvent["entityType"],
    entityId: string,
    idempotencyKey: string,
  ): StateTransitionEvent | undefined {
    const row = this.database
      .prepare(stateTransitionSelectSql("WHERE entity_type = ? AND entity_id = ? AND idempotency_key = ?"))
      .get(entityType, entityId, idempotencyKey);
    return row ? mapStateTransitionEvent(row) : undefined;
  }

  transitionTaskStatus(input: {
    readonly taskId: string;
    readonly expectedStatus?: TaskStatus;
    readonly event: TaskTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly currentRunId?: string | null;
    readonly assigneeTeammateId?: string | null;
  }): TransitionResult<TaskStatus> {
    const task = this.getTask(input.taskId);
    if (!task) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("task", input.taskId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: task.status, to: task.status, duplicate: true };
      }
    }

    const result = transitionTask({
      entityId: input.taskId,
      currentStatus: task.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }

    const update = this.database
      .prepare(`
        UPDATE tasks
        SET
          status = ?,
          current_run_id = ?,
          assignee_teammate_id = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.currentRunId === undefined ? task.currentRunId ?? null : input.currentRunId,
        input.assigneeTeammateId === undefined ? task.assigneeTeammateId ?? null : input.assigneeTeammateId,
        input.now,
        input.taskId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getTask(input.taskId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? task.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: task.workspaceId,
      entityType: "task",
      entityId: input.taskId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

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
  }): TransitionResult<RunStatus> {
    const run = this.getRun(input.runId);
    if (!run) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("run", input.runId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: run.status, to: run.status, duplicate: true };
      }
    }

    const result = transitionRun({
      entityId: input.runId,
      currentStatus: run.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }

    const update = this.database
      .prepare(`
        UPDATE run_sessions
        SET
          status = ?,
          started_at = ?,
          ended_at = ?,
          error_message = ?,
          summary_path = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.startedAt ?? run.startedAt ?? null,
        input.endedAt === undefined ? run.endedAt ?? null : input.endedAt,
        input.errorMessage === undefined ? run.errorMessage ?? null : input.errorMessage,
        input.summaryPath ?? run.summaryPath ?? null,
        input.now,
        input.runId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getRun(input.runId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? run.status };
    }

    this.recordStateTransitionEvent({
      workspaceId: DEFAULT_WORKSPACE_ID,
      entityType: "run",
      entityId: input.runId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  acquireResourceLease(input: CreateResourceLeaseInput): ResourceLease | undefined {
    const lease: ResourceLease = {
      id: createResourceLeaseId(),
      workspaceId: input.workspaceId,
      resourceType: input.resourceType,
      resourceKey: input.resourceKey,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      status: "active",
      acquiredAt: input.acquiredAt,
      expiresAt: input.expiresAt,
      lastRenewedAt: input.lastRenewedAt ?? input.acquiredAt,
      workUnitId: input.workUnitId,
      attemptId: input.attemptId,
    };
    try {
      this.database
        .prepare(`
          INSERT INTO resource_leases (
            id,
            workspace_id,
            resource_type,
            resource_key,
            owner_type,
            owner_id,
            status,
            acquired_at,
            expires_at,
            last_renewed_at,
            released_at,
            release_reason,
            work_unit_id,
            attempt_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          lease.id,
          lease.workspaceId,
          lease.resourceType,
          lease.resourceKey,
          lease.ownerType,
          lease.ownerId,
          lease.status,
          lease.acquiredAt,
          lease.expiresAt,
          lease.lastRenewedAt ?? lease.acquiredAt,
          null,
          null,
          lease.workUnitId ?? null,
          lease.attemptId ?? null,
        );
      return lease;
    } catch {
      return undefined;
    }
  }

  releaseResourceLeasesForOwner(ownerType: ResourceLeaseOwnerType, ownerId: string, releasedAt: string): number {
    const result = this.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'released', released_at = ?, release_reason = COALESCE(release_reason, 'released')
        WHERE owner_type = ? AND owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, ownerType, ownerId);
    return Number(result.changes);
  }

  expireResourceLeases(now: string): number {
    const result = this.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'expired', released_at = ?, release_reason = COALESCE(release_reason, 'expired')
        WHERE status = 'active' AND expires_at <= ?
      `)
      .run(now, now);
    return Number(result.changes);
  }

  listResourceLeases(options: ListResourceLeasesOptions = {}): ResourceLease[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.ownerType) {
      clauses.push("owner_type = ?");
      params.push(options.ownerType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.resourceType) {
      clauses.push("resource_type = ?");
      params.push(options.resourceType);
    }
    if (options.resourceKey) {
      clauses.push("resource_key = ?");
      params.push(options.resourceKey);
    }
    if (options.workUnitId) {
      clauses.push("work_unit_id = ?");
      params.push(options.workUnitId);
    }
    if (options.attemptId) {
      clauses.push("attempt_id = ?");
      params.push(options.attemptId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${resourceLeaseSelectSql(whereClause)} ORDER BY acquired_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapResourceLease);
  }

  getBlockingResourceLease(resourceType: ResourceLease["resourceType"], resourceKey: string): ResourceLease | undefined {
    const row = this.database
      .prepare(resourceLeaseSelectSql("WHERE workspace_id = ? AND resource_type = ? AND resource_key = ? AND status = 'active'"))
      .get(DEFAULT_WORKSPACE_ID, resourceType, resourceKey);
    return row ? mapResourceLease(row) : undefined;
  }

  createChannel(input: CreateChannelInput, now: string): Channel {
    const channel: Channel = {
      id: createChannelId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: input.name,
      status: input.status ?? "active",
      boundPath: input.boundPath,
      defaultProviderPresetId: input.defaultProviderPresetId,
      defaultTeammateId: input.defaultTeammateId,
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      runtimePolicy: normalizeChannelRuntimePolicy(input.runtimePolicy),
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channels (
          id,
          workspace_id,
          name,
          status,
          bound_path,
          default_provider_preset_id,
          default_teammate_id,
          allowed_tools_json,
          runtime_policy_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        channel.id,
        channel.workspaceId,
        channel.name,
        channel.status,
        channel.boundPath ?? null,
        channel.defaultProviderPresetId ?? null,
        channel.defaultTeammateId ?? null,
        stringifyJson(channel.allowedTools),
        stringifyJson(channel.runtimePolicy),
        channel.createdAt,
        channel.updatedAt,
      );

    const created = this.getChannel(channel.id);
    if (!created) {
      throw new Error(`Failed to create channel: ${channel.id}`);
    }
    return created;
  }

  getChannel(id: string): Channel | undefined {
    const row = this.database.prepare(channelSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannel(row) : undefined;
  }

  listChannels(options: ListChannelsOptions = {}): Channel[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelSelectSql("WHERE workspace_id = ?")} ORDER BY created_at DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, limit)
      .map(mapChannel);
  }

  updateChannel(id: string, input: ChannelUpdateInput, now: string): Channel | undefined {
    const existing = this.getChannel(id);
    if (!existing) {
      return undefined;
    }

    const next: Channel = {
      ...existing,
      name: input.name ?? existing.name,
      status: input.status ?? existing.status,
      boundPath: nullableUpdate(input.boundPath, existing.boundPath),
      defaultProviderPresetId: nullableUpdate(input.defaultProviderPresetId, existing.defaultProviderPresetId),
      defaultTeammateId: nullableUpdate(input.defaultTeammateId, existing.defaultTeammateId),
      allowedTools: input.allowedTools ?? existing.allowedTools,
      runtimePolicy: input.runtimePolicy ? normalizeChannelRuntimePolicy({ ...existing.runtimePolicy, ...input.runtimePolicy }) : existing.runtimePolicy,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE channels
        SET
          name = ?,
          status = ?,
          bound_path = ?,
          default_provider_preset_id = ?,
          default_teammate_id = ?,
          allowed_tools_json = ?,
          runtime_policy_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.name,
        next.status,
        next.boundPath ?? null,
        next.defaultProviderPresetId ?? null,
        next.defaultTeammateId ?? null,
        stringifyJson(next.allowedTools),
        stringifyJson(next.runtimePolicy),
        next.updatedAt,
        id,
      );

    return this.getChannel(id);
  }

  deleteChannel(id: string): boolean {
    const result = this.database.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createTask(input: CreateTaskInput, now: string): Task {
    const task: Task = {
      id: createTaskId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      title: input.title,
      prompt: input.prompt,
      status: input.status ?? "todo",
      assigneeTeammateId: input.assigneeTeammateId,
      requestedSkillId: input.requestedSkillId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO tasks (
          id,
          workspace_id,
          channel_id,
          title,
          prompt,
          status,
          assignee_teammate_id,
          requested_skill_id,
          current_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.workspaceId,
        task.channelId,
        task.title,
        task.prompt,
        task.status,
        task.assigneeTeammateId ?? null,
        task.requestedSkillId ?? null,
        task.currentRunId ?? null,
        task.createdAt,
        task.updatedAt,
      );

    const created = this.getTask(task.id);
    if (!created) {
      throw new Error(`Failed to create task: ${task.id}`);
    }
    return created;
  }

  getTask(id: string): Task | undefined {
    const row = this.database.prepare(taskSelectSql("WHERE id = ?")).get(id);
    return row ? mapTask(row) : undefined;
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.assigneeTeammateId) {
      clauses.push("assignee_teammate_id = ?");
      params.push(options.assigneeTeammateId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${taskSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapTask);
  }

  updateTask(id: string, input: TaskUpdateInput, now: string): Task | undefined {
    const existing = this.getTask(id);
    if (!existing) {
      return undefined;
    }

    const next: Task = {
      ...existing,
      channelId: input.channelId ?? existing.channelId,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      status: input.status ?? existing.status,
      assigneeTeammateId: nullableUpdate(input.assigneeTeammateId, existing.assigneeTeammateId),
      requestedSkillId: nullableUpdate(input.requestedSkillId, existing.requestedSkillId),
      currentRunId: nullableUpdate(input.currentRunId, existing.currentRunId),
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE tasks
        SET
          channel_id = ?,
          title = ?,
          prompt = ?,
          status = ?,
          assignee_teammate_id = ?,
          requested_skill_id = ?,
          current_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.channelId,
        next.title,
        next.prompt,
        next.status,
        next.assigneeTeammateId ?? null,
        next.requestedSkillId ?? null,
        next.currentRunId ?? null,
        next.updatedAt,
        id,
      );

    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    const result = this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createAiTeammate(input: CreateAiTeammateInput, now: string): AiTeammate {
    const teammate: AiTeammate = {
      id: input.id ?? createAiTeammateId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      templateId: input.templateId,
      roleKey: input.roleKey,
      displayName: input.displayName,
      description: input.description,
      avatarTone: input.avatarTone,
      avatarImageAttachmentId: input.avatarImageAttachmentId,
      providerPresetId: input.providerPresetId,
      systemPrompt: input.systemPrompt,
      appendSystemPrompt: input.appendSystemPrompt ?? [],
      allowedTools: input.allowedTools ?? [...readOnlyRunTools],
      approvalProfile: input.approvalProfile,
      status: input.status ?? "active",
      pinned: input.pinned ?? false,
      hidden: input.hidden ?? false,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO ai_teammates (
          id,
          workspace_id,
          template_id,
          role_key,
          display_name,
          description,
          avatar_tone,
          avatar_image_attachment_id,
          provider_preset_id,
          system_prompt,
          append_system_prompt_json,
          allowed_tools_json,
          approval_profile_json,
          status,
          pinned,
          hidden,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        teammate.id,
        teammate.workspaceId,
        teammate.templateId ?? null,
        teammate.roleKey,
        teammate.displayName,
        teammate.description,
        teammate.avatarTone ?? null,
        teammate.avatarImageAttachmentId ?? null,
        teammate.providerPresetId ?? null,
        teammate.systemPrompt ?? null,
        stringifyJson(teammate.appendSystemPrompt),
        stringifyJson(teammate.allowedTools),
        stringifyJson(teammate.approvalProfile),
        teammate.status,
        teammate.pinned ? 1 : 0,
        teammate.hidden ? 1 : 0,
        teammate.createdAt,
        teammate.updatedAt,
      );

    const created = this.getAiTeammate(teammate.id);
    if (!created) {
      throw new Error(`Failed to create AI teammate: ${teammate.id}`);
    }
    return created;
  }

  getAiTeammate(id: string): AiTeammate | undefined {
    const row = this.database.prepare(aiTeammateSelectSql("WHERE id = ?")).get(id);
    return row ? mapAiTeammate(row) : undefined;
  }

  listAiTeammates(options: ListAiTeammatesOptions = {}): AiTeammate[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeDisabled) {
      clauses.push("status != 'disabled'");
    }
    if (!options.includeHidden) {
      clauses.push("hidden = 0");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${aiTeammateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned DESC, display_name ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapAiTeammate);
  }

  updateAiTeammate(id: string, input: AiTeammateUpdateInput, now: string): AiTeammate | undefined {
    const existing = this.getAiTeammate(id);
    if (!existing) {
      return undefined;
    }

    const next: AiTeammate = {
      ...existing,
      templateId: nullableUpdate(input.templateId, existing.templateId),
      roleKey: input.roleKey ?? existing.roleKey,
      displayName: input.displayName ?? existing.displayName,
      description: input.description ?? existing.description,
      avatarTone: nullableUpdate(input.avatarTone, existing.avatarTone),
      avatarImageAttachmentId: nullableUpdate(input.avatarImageAttachmentId, existing.avatarImageAttachmentId),
      providerPresetId: nullableUpdate(input.providerPresetId, existing.providerPresetId),
      systemPrompt: nullableUpdate(input.systemPrompt, existing.systemPrompt),
      appendSystemPrompt: input.appendSystemPrompt ?? existing.appendSystemPrompt,
      allowedTools: input.allowedTools ?? existing.allowedTools,
      approvalProfile: input.approvalProfile ?? existing.approvalProfile,
      status: input.status ?? existing.status,
      pinned: input.pinned ?? existing.pinned,
      hidden: input.hidden ?? existing.hidden,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE ai_teammates
        SET
          template_id = ?,
          role_key = ?,
          display_name = ?,
          description = ?,
          avatar_tone = ?,
          avatar_image_attachment_id = ?,
          provider_preset_id = ?,
          system_prompt = ?,
          append_system_prompt_json = ?,
          allowed_tools_json = ?,
          approval_profile_json = ?,
          status = ?,
          pinned = ?,
          hidden = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.templateId ?? null,
        next.roleKey,
        next.displayName,
        next.description,
        next.avatarTone ?? null,
        next.avatarImageAttachmentId ?? null,
        next.providerPresetId ?? null,
        next.systemPrompt ?? null,
        stringifyJson(next.appendSystemPrompt),
        stringifyJson(next.allowedTools),
        stringifyJson(next.approvalProfile),
        next.status,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        next.updatedAt,
        id,
      );

    return this.getAiTeammate(id);
  }

  disableAiTeammate(id: string, now: string): AiTeammate | undefined {
    return this.updateAiTeammate(id, { status: "disabled", hidden: true }, now);
  }

  listTeammateChannelMemberships(teammateId: string): TeammateChannelMembership[] {
    return this.database
      .prepare(`${teammateChannelMembershipSelectSql("WHERE teammate_id = ?")} ORDER BY created_at ASC`)
      .all(teammateId)
      .map(mapTeammateChannelMembership);
  }

  replaceTeammateChannelMemberships(
    teammateId: string,
    memberships: readonly ReplaceTeammateChannelMembershipInput[],
    now: string,
  ): TeammateChannelMembership[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }

    const normalized = dedupeMembershipInputs(memberships);
    for (const membership of normalized) {
      if (!this.getChannel(membership.channelId)) {
        throw new Error(`Channel not found: ${membership.channelId}`);
      }
    }

    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_channel_memberships WHERE teammate_id = ?").run(teammateId);
      this.database.prepare("UPDATE channels SET default_teammate_id = NULL, updated_at = ? WHERE default_teammate_id = ?").run(now, teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_channel_memberships (
          teammate_id,
          channel_id,
          is_default,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const membership of normalized) {
        insert.run(teammateId, membership.channelId, membership.isDefault ? 1 : 0, now, now);
        if (membership.isDefault) {
          this.database.prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE id = ?").run(teammateId, now, membership.channelId);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateChannelMemberships(teammateId);
  }

  listTeammateSkillBindings(teammateId: string): TeammateSkillBinding[] {
    return this.database
      .prepare(`${teammateSkillBindingSelectSql("WHERE teammate_id = ?")} ORDER BY skill_id ASC`)
      .all(teammateId)
      .map(mapTeammateSkillBinding);
  }

  replaceTeammateSkillBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateSkillBindingInput[],
    now: string,
  ): TeammateSkillBinding[] {
    const teammate = this.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }

    const existing = this.listTeammateSkillBindings(teammateId);
    const normalized = protectDefaultSkillBindings(teammate, existing, dedupeSkillBindingInputs(bindings));
    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_skill_bindings (
          teammate_id,
          skill_id,
          source,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const binding of normalized) {
        insert.run(teammateId, binding.skillId, binding.source ?? "user", binding.enabled === false ? 0 : 1, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateSkillBindings(teammateId);
  }

  listTeammateMemoryScopes(teammateId: string): TeammateMemoryScope[] {
    return this.database
      .prepare(`${teammateMemoryScopeSelectSql("WHERE teammate_id = ?")} ORDER BY created_at ASC`)
      .all(teammateId)
      .map(mapTeammateMemoryScope);
  }

  replaceTeammateMemoryScopes(
    teammateId: string,
    scopes: readonly ReplaceTeammateMemoryScopeInput[],
    now: string,
  ): TeammateMemoryScope[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    for (const scope of scopes) {
      if (scope.channelId && !this.getChannel(scope.channelId)) {
        throw new Error(`Channel not found: ${scope.channelId}`);
      }
    }

    this.database.exec("BEGIN");
    try {
      this.database.prepare("DELETE FROM teammate_memory_scopes WHERE teammate_id = ?").run(teammateId);
      const insert = this.database.prepare(`
        INSERT INTO teammate_memory_scopes (
          id,
          teammate_id,
          kind,
          channel_id,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const scope of scopes) {
        insert.run(scope.id ?? createTeammateMemoryScopeId(), teammateId, scope.kind, scope.channelId ?? null, scope.enabled === false ? 0 : 1, now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    return this.listTeammateMemoryScopes(teammateId);
  }

  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject {
    const id = input.id ?? createMemoryObjectId();
    const memory: MemoryObject = {
      id,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      scopeType: input.scopeType,
      ownerId: input.ownerId,
      title: input.title,
      body: input.body,
      tags: normalizeStringList(input.tags ?? []),
      sourceRefs: ensureMemorySourceRefs(id, normalizeMemorySourceRefs(input.sourceRefs ?? [])),
      reviewState: input.reviewState ?? "active",
      enabled: input.enabled ?? true,
      sensitivity: input.sensitivity ?? "normal",
      retrievalProviderId: input.retrievalProviderId,
      retrievalHandle: input.retrievalHandle,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateMemoryObject(memory);

    this.database
      .prepare(`
        INSERT INTO memory_objects (
          id,
          workspace_id,
          scope_type,
          owner_id,
          title,
          body,
          tags_json,
          source_refs_json,
          review_state,
          enabled,
          sensitivity,
          retrieval_provider_id,
          retrieval_handle,
          created_by,
          created_at,
          updated_at,
          last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.workspaceId,
        memory.scopeType,
        memory.ownerId,
        memory.title,
        memory.body,
        stringifyJson(memory.tags),
        stringifyJson(memory.sourceRefs),
        memory.reviewState,
        memory.enabled ? 1 : 0,
        memory.sensitivity,
        memory.retrievalProviderId ?? null,
        memory.retrievalHandle ?? null,
        memory.createdBy ?? null,
        memory.createdAt,
        memory.updatedAt,
        memory.lastUsedAt ?? null,
      );

    const created = this.getMemoryObject(memory.id);
    if (!created) {
      throw new Error(`Failed to create memory object: ${memory.id}`);
    }
    return created;
  }

  getMemoryObject(id: string): MemoryObject | undefined {
    const row = this.database.prepare(memoryObjectSelectSql("WHERE id = ?")).get(id);
    return row ? mapMemoryObject(row) : undefined;
  }

  listMemoryObjects(options: ListMemoryObjectsOptions = {}): MemoryObject[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.scopeType) {
      clauses.push("scope_type = ?");
      params.push(options.scopeType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.reviewState) {
      clauses.push("review_state = ?");
      params.push(options.reviewState);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.sensitivity) {
      clauses.push("sensitivity = ?");
      params.push(options.sensitivity);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const memories = this.database
      .prepare(`${memoryObjectSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapMemoryObject);
    if (!options.tag) {
      return memories;
    }
    const tag = options.tag.toLowerCase();
    return memories.filter((memory) => memory.tags.some((item) => item.toLowerCase() === tag));
  }

  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined {
    const existing = this.getMemoryObject(id);
    if (!existing) {
      return undefined;
    }
    const next: MemoryObject = {
      ...existing,
      scopeType: input.scopeType ?? existing.scopeType,
      ownerId: input.ownerId ?? existing.ownerId,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      tags: input.tags ? normalizeStringList(input.tags) : existing.tags,
      sourceRefs: input.sourceRefs ? ensureMemorySourceRefs(existing.id, normalizeMemorySourceRefs(input.sourceRefs)) : existing.sourceRefs,
      reviewState: input.reviewState ?? existing.reviewState,
      enabled: input.enabled ?? existing.enabled,
      sensitivity: input.sensitivity ?? existing.sensitivity,
      retrievalProviderId: nullableUpdate(input.retrievalProviderId, existing.retrievalProviderId),
      retrievalHandle: nullableUpdate(input.retrievalHandle, existing.retrievalHandle),
      createdBy: nullableUpdate(input.createdBy, existing.createdBy),
      lastUsedAt: nullableUpdate(input.lastUsedAt, existing.lastUsedAt),
      updatedAt: now,
    };
    validateMemoryObject(next);

    this.database
      .prepare(`
        UPDATE memory_objects
        SET
          scope_type = ?,
          owner_id = ?,
          title = ?,
          body = ?,
          tags_json = ?,
          source_refs_json = ?,
          review_state = ?,
          enabled = ?,
          sensitivity = ?,
          retrieval_provider_id = ?,
          retrieval_handle = ?,
          created_by = ?,
          updated_at = ?,
          last_used_at = ?
        WHERE id = ?
      `)
      .run(
        next.scopeType,
        next.ownerId,
        next.title,
        next.body,
        stringifyJson(next.tags),
        stringifyJson(next.sourceRefs),
        next.reviewState,
        next.enabled ? 1 : 0,
        next.sensitivity,
        next.retrievalProviderId ?? null,
        next.retrievalHandle ?? null,
        next.createdBy ?? null,
        next.updatedAt,
        next.lastUsedAt ?? null,
        id,
      );

    return this.getMemoryObject(id);
  }

  recallMemory(input: MemoryRecallRequest): MemoryRecallResult {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const maxResults = Math.min(Math.max(input.maxResults ?? 8, 1), 20);
    const allowedScopes = memoryRecallAllowedScopes(input, workspaceId);
    if (allowedScopes.length === 0) {
      return { request: { ...input, workspaceId }, memories: [], policyVersion: "ling-memory-v1-lexical" };
    }

    const listOptions: ListMemoryObjectsOptions = {
      workspaceId,
      limit: 500,
    };
    const candidates = this.listMemoryObjects(input.includeDisabled ? listOptions : { ...listOptions, enabled: true })
      .filter((memory) => memoryAllowedForRecall(memory, input, allowedScopes));
    const queryTerms = tokenizeMemoryQuery([input.query, ...(input.tags ?? [])].join(" "));
    const requestedTags = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()));
    const memories = candidates
      .map((memory) => scoreMemoryForRecall(memory, queryTerms, requestedTags))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, maxResults);
    return {
      request: { ...input, workspaceId },
      memories,
      policyVersion: "ling-memory-v1-lexical",
    };
  }

  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent {
    const event: UsedMemoryEvent = {
      id: input.id ?? createUsedMemoryEventId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      memoryIds: normalizeStringList(input.memoryIds),
      intent: input.intent,
      recallQuery: input.recallQuery,
      teammateId: input.teammateId,
      channelId: input.channelId,
      taskId: input.taskId,
      runId: input.runId,
      responseId: input.responseId,
      policyVersion: input.policyVersion,
      createdAt: now,
    };
    if (event.memoryIds.length === 0) {
      throw new Error("memoryIds must contain at least one memory id");
    }

    this.database
      .prepare(`
        INSERT INTO memory_used_events (
          id,
          workspace_id,
          memory_ids_json,
          intent,
          recall_query,
          teammate_id,
          channel_id,
          task_id,
          run_id,
          response_id,
          policy_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        stringifyJson(event.memoryIds),
        event.intent,
        event.recallQuery,
        event.teammateId ?? null,
        event.channelId ?? null,
        event.taskId ?? null,
        event.runId ?? null,
        event.responseId ?? null,
        event.policyVersion,
        event.createdAt,
      );
    for (const memoryId of event.memoryIds) {
      this.database
        .prepare("UPDATE memory_objects SET last_used_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, memoryId);
    }
    return event;
  }

  listUsedMemoryEvents(options: ListUsedMemoryEventsOptions = {}): UsedMemoryEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.responseId) {
      clauses.push("response_id = ?");
      params.push(options.responseId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const events = this.database
      .prepare(`${memoryUsedEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapUsedMemoryEvent);
    if (!options.memoryId) {
      return events;
    }
    return events.filter((event) => event.memoryIds.includes(options.memoryId as string));
  }

  getOrCreateTeammateDirectThread(teammateId: string, now: string): TeammateDirectThread {
    const teammate = this.getAiTeammate(teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    const existing = this.database
      .prepare(teammateDirectThreadSelectSql("WHERE workspace_id = ? AND teammate_id = ?"))
      .get(DEFAULT_WORKSPACE_ID, teammateId);
    if (existing) {
      return mapTeammateDirectThread(existing);
    }

    const thread: TeammateDirectThread = {
      id: createTeammateDirectThreadId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId,
      title: teammate.displayName,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO teammate_direct_threads (
          id,
          workspace_id,
          teammate_id,
          title,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(thread.id, thread.workspaceId, thread.teammateId, thread.title, thread.createdAt, thread.updatedAt);

    return thread;
  }

  listTeammateDirectMessages(options: ListTeammateDirectMessagesOptions): TeammateDirectMessage[] {
    const clauses = ["workspace_id = ?", "teammate_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.teammateId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${teammateDirectMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map(mapTeammateDirectMessage);
  }

  getTeammateDirectMessage(id: string): TeammateDirectMessage | undefined {
    const row = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapTeammateDirectMessage(row) : undefined;
  }

  createTeammateDirectMessage(input: CreateTeammateDirectMessageInput, now: string): TeammateDirectMessage {
    const teammate = this.getAiTeammate(input.teammateId);
    if (!teammate) {
      throw new Error(`AI teammate not found: ${input.teammateId}`);
    }
    const thread = this.getOrCreateTeammateDirectThread(input.teammateId, now);
    if (thread.id !== input.threadId) {
      throw new Error(`Direct thread does not belong to teammate: ${input.threadId}`);
    }

    const message: TeammateDirectMessage = {
      id: createTeammateDirectMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      threadId: input.threadId,
      teammateId: input.teammateId,
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO teammate_direct_messages (
          id,
          workspace_id,
          thread_id,
          teammate_id,
          author_type,
          author_id,
          body,
          status,
          error_message,
          linked_task_id,
          linked_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.threadId,
        message.teammateId,
        message.authorType,
        message.authorId ?? null,
        message.body,
        message.status,
        message.errorMessage ?? null,
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(message.id);
    if (!created) {
      throw new Error(`Failed to create teammate direct message: ${message.id}`);
    }
    return mapTeammateDirectMessage(created);
  }

  updateTeammateDirectMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: TeammateDirectMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): TeammateDirectMessage | undefined {
    const existing = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    if (!existing) {
      return undefined;
    }
    const current = mapTeammateDirectMessage(existing);
    this.database
      .prepare(`
        UPDATE teammate_direct_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? current.body,
        input.status ?? current.status,
        input.errorMessage === undefined ? current.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? current.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    const updated = this.database.prepare(teammateDirectMessageSelectSql("WHERE id = ?")).get(id);
    return updated ? mapTeammateDirectMessage(updated) : undefined;
  }

  createChannelMessage(input: CreateChannelMessageInput, now: string): ChannelMessage {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const message: ChannelMessage = {
      id: createChannelMessageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      threadId: input.threadId,
      kind: input.kind ?? "message",
      intent: input.intent ?? "discuss",
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      mentions: input.mentions ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      status: input.status ?? "ready",
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_messages (
          id,
          workspace_id,
          channel_id,
          thread_id,
          kind,
          intent,
          author_type,
          author_id,
          body,
          mentions_json,
          attachment_ids_json,
          link_preview_ids_json,
          linked_task_id,
          linked_run_id,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.workspaceId,
        message.channelId,
        message.threadId ?? null,
        message.kind,
        message.intent,
        message.authorType,
        message.authorId ?? null,
        message.body,
        stringifyJson(message.mentions),
        stringifyJson(message.attachmentIds),
        stringifyJson(message.linkPreviewIds),
        message.linkedTaskId ?? null,
        message.linkedRunId ?? null,
        message.status,
        message.errorMessage ?? null,
        message.createdAt,
        message.updatedAt,
      );

    const created = this.getChannelMessage(message.id);
    if (!created) {
      throw new Error(`Failed to create channel message: ${message.id}`);
    }
    return created;
  }

  updateChannelMessageRuntime(
    id: string,
    input: {
      readonly body?: string;
      readonly status?: ChannelMessage["status"];
      readonly errorMessage?: string | null;
      readonly linkedRunId?: string | null;
    },
    now: string,
  ): ChannelMessage | undefined {
    const existing = this.getChannelMessage(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE channel_messages
        SET
          body = ?,
          status = ?,
          error_message = ?,
          linked_run_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.body ?? existing.body,
        input.status ?? existing.status,
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        input.linkedRunId === undefined ? existing.linkedRunId ?? null : input.linkedRunId,
        now,
        id,
      );
    return this.getChannelMessage(id);
  }

  getChannelMessage(id: string): ChannelMessage | undefined {
    const row = this.database.prepare(channelMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessage(row) : undefined;
  }

  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[] {
    return this.listChannelMessagesPage(options).messages.slice();
  }

  listChannelMessagesPage(options: ListChannelMessagesOptions): ChannelMessageListPage {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.beforeMessageId) {
      const cursor = this.database
        .prepare("SELECT channel_id, thread_id, created_at, rowid FROM channel_messages WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, options.beforeMessageId);
      if (!cursor || readString(cursor, "channel_id") !== options.channelId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      const cursorThreadId = readNullableString(cursor, "thread_id");
      if ((options.threadId ?? undefined) !== cursorThreadId) {
        throw new Error(`Invalid channel message cursor: ${options.beforeMessageId}`);
      }
      clauses.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
      const cursorCreatedAt = readString(cursor, "created_at");
      params.push(cursorCreatedAt, cursorCreatedAt, readNumber(cursor, "rowid"));
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit + 1);
    const rows = this.database
      .prepare(`${channelMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelMessage);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse();
    return {
      messages,
      hasMore,
      nextBeforeMessageId: hasMore && messages.length > 0 ? messages[0].id : undefined,
    };
  }

  createChannelExecutionProposal(input: CreateChannelExecutionProposalInput, now: string): ChannelExecutionProposal {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const sourceMessage = this.getChannelMessage(input.sourceMessageId);
    if (!sourceMessage || sourceMessage.channelId !== input.channelId) {
      throw new Error(`Source message does not belong to channel: ${input.sourceMessageId}`);
    }
    const proposal: ChannelExecutionProposal = {
      id: createChannelExecutionProposalId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      proposedByTeammateId: input.proposedByTeammateId,
      title: input.title,
      prompt: input.prompt,
      assigneeTeammateId: input.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      collaborationSteps: input.collaborationSteps ?? [],
      requiredTools: input.requiredTools ?? [],
      riskSummary: input.riskSummary,
      status: input.status ?? "draft",
      linkedTaskId: input.linkedTaskId,
      linkedRunId: input.linkedRunId,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_execution_proposals (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          proposed_by_teammate_id,
          title,
          prompt,
          assignee_teammate_id,
          acceptance_criteria_json,
          collaboration_steps_json,
          required_tools_json,
          risk_summary,
          status,
          linked_task_id,
          linked_run_id,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        proposal.id,
        proposal.workspaceId,
        proposal.channelId,
        proposal.sourceMessageId,
        proposal.proposedByTeammateId,
        proposal.title,
        proposal.prompt,
        proposal.assigneeTeammateId,
        stringifyJson(proposal.acceptanceCriteria),
        stringifyJson(proposal.collaborationSteps),
        stringifyJson(proposal.requiredTools),
        proposal.riskSummary ?? null,
        proposal.status,
        proposal.linkedTaskId ?? null,
        proposal.linkedRunId ?? null,
        proposal.errorMessage ?? null,
        proposal.createdAt,
        proposal.updatedAt,
      );

    const created = this.getChannelExecutionProposal(proposal.id);
    if (!created) {
      throw new Error(`Failed to create channel execution proposal: ${proposal.id}`);
    }
    return created;
  }

  getChannelExecutionProposal(id: string): ChannelExecutionProposal | undefined {
    const row = this.database.prepare(channelExecutionProposalSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelExecutionProposal(row) : undefined;
  }

  listChannelExecutionProposals(options: ListChannelExecutionProposalsOptions): ChannelExecutionProposal[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.sourceMessageId) {
      clauses.push("source_message_id = ?");
      params.push(options.sourceMessageId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelExecutionProposalSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map(mapChannelExecutionProposal);
  }

  updateChannelExecutionProposal(
    id: string,
    input: UpdateChannelExecutionProposalInput,
    now: string,
  ): ChannelExecutionProposal | undefined {
    const existing = this.getChannelExecutionProposal(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelExecutionProposal = {
      ...existing,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      assigneeTeammateId: input.assigneeTeammateId ?? existing.assigneeTeammateId,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      collaborationSteps: input.collaborationSteps ?? existing.collaborationSteps,
      requiredTools: input.requiredTools ?? existing.requiredTools,
      riskSummary: nullableUpdate(input.riskSummary, existing.riskSummary),
      status: input.status ?? existing.status,
      linkedTaskId: nullableUpdate(input.linkedTaskId, existing.linkedTaskId),
      linkedRunId: nullableUpdate(input.linkedRunId, existing.linkedRunId),
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE channel_execution_proposals
        SET
          title = ?,
          prompt = ?,
          assignee_teammate_id = ?,
          acceptance_criteria_json = ?,
          collaboration_steps_json = ?,
          required_tools_json = ?,
          risk_summary = ?,
          status = ?,
          linked_task_id = ?,
          linked_run_id = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title,
        next.prompt,
        next.assigneeTeammateId,
        stringifyJson(next.acceptanceCriteria),
        stringifyJson(next.collaborationSteps),
        stringifyJson(next.requiredTools),
        next.riskSummary ?? null,
        next.status,
        next.linkedTaskId ?? null,
        next.linkedRunId ?? null,
        next.errorMessage ?? null,
        next.updatedAt,
        next.id,
      );

    return this.getChannelExecutionProposal(id);
  }

  createChannelAttachment(input: CreateChannelAttachmentInput): ChannelAttachment {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const attachment: ChannelAttachment = {
      id: createChannelAttachmentId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      messageId: input.messageId,
      kind: input.kind,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      path: input.path,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.database
      .prepare(`
        INSERT INTO channel_attachments (
          id,
          workspace_id,
          channel_id,
          message_id,
          kind,
          file_name,
          content_type,
          size_bytes,
          path,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        attachment.id,
        attachment.workspaceId,
        attachment.channelId,
        attachment.messageId ?? null,
        attachment.kind,
        attachment.fileName,
        attachment.contentType,
        attachment.sizeBytes,
        attachment.path,
        attachment.createdAt,
      );

    const created = this.getChannelAttachment(attachment.id);
    if (!created) {
      throw new Error(`Failed to create channel attachment: ${attachment.id}`);
    }
    return created;
  }

  getChannelAttachment(id: string): ChannelAttachment | undefined {
    const row = this.database.prepare(channelAttachmentSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelAttachment(row) : undefined;
  }

  listChannelAttachments(options: ListChannelAttachmentsOptions): ChannelAttachment[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelAttachmentSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map(mapChannelAttachment);
  }

  deleteChannelAttachment(id: string): boolean {
    const result = this.database.prepare("DELETE FROM channel_attachments WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  createChannelLinkPreview(input: CreateChannelLinkPreviewInput, now: string): ChannelLinkPreview {
    if (!this.getChannel(input.channelId)) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const preview: ChannelLinkPreview = {
      id: createChannelLinkPreviewId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl: input.normalizedUrl,
      title: input.title,
      description: input.description,
      imageUrl: input.imageUrl,
      siteName: input.siteName,
      status: input.status,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO channel_link_previews (
          id,
          workspace_id,
          channel_id,
          message_id,
          url,
          normalized_url,
          title,
          description,
          image_url,
          site_name,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preview.id,
        preview.workspaceId,
        preview.channelId,
        preview.messageId ?? null,
        preview.url,
        preview.normalizedUrl,
        preview.title ?? null,
        preview.description ?? null,
        preview.imageUrl ?? null,
        preview.siteName ?? null,
        preview.status,
        preview.errorMessage ?? null,
        preview.createdAt,
        preview.updatedAt,
      );

    const created = this.getChannelLinkPreview(preview.id);
    if (!created) {
      throw new Error(`Failed to create channel link preview: ${preview.id}`);
    }
    return created;
  }

  getChannelLinkPreview(id: string): ChannelLinkPreview | undefined {
    const row = this.database.prepare(channelLinkPreviewSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelLinkPreview(row) : undefined;
  }

  listChannelLinkPreviews(options: ListChannelLinkPreviewsOptions): ChannelLinkPreview[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    return this.database
      .prepare(`${channelLinkPreviewSelectSql("WHERE workspace_id = ? AND channel_id = ?")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(DEFAULT_WORKSPACE_ID, options.channelId, limit)
      .map(mapChannelLinkPreview);
  }

  updateChannelLinkPreview(id: string, input: UpdateChannelLinkPreviewInput, now: string): ChannelLinkPreview | undefined {
    const existing = this.getChannelLinkPreview(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelLinkPreview = {
      ...existing,
      title: nullableUpdate(input.title, existing.title),
      description: nullableUpdate(input.description, existing.description),
      imageUrl: nullableUpdate(input.imageUrl, existing.imageUrl),
      siteName: nullableUpdate(input.siteName, existing.siteName),
      status: input.status ?? existing.status,
      errorMessage: nullableUpdate(input.errorMessage, existing.errorMessage),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_link_previews
        SET
          title = ?,
          description = ?,
          image_url = ?,
          site_name = ?,
          status = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.title ?? null,
        next.description ?? null,
        next.imageUrl ?? null,
        next.siteName ?? null,
        next.status,
        next.errorMessage ?? null,
        next.updatedAt,
        id,
    );
    return this.getChannelLinkPreview(id);
  }

  getChannelBrief(channelId: string): ChannelBrief | undefined {
    const row = this.database.prepare(channelBriefSelectSql("WHERE channel_id = ?")).get(channelId);
    return row ? mapChannelBrief(row) : undefined;
  }

  updateChannelBrief(channelId: string, input: UpdateChannelBriefInput, now: string): ChannelBrief {
    this.assertChannelExists(channelId);
    for (const decisionId of input.decisionIds ?? []) {
      this.assertDecisionInChannel(channelId, decisionId);
    }
    for (const attachmentId of input.attachmentIds ?? []) {
      this.assertAttachmentInChannel(channelId, attachmentId);
    }
    for (const linkPreviewId of input.linkPreviewIds ?? []) {
      this.assertLinkPreviewInChannel(channelId, linkPreviewId);
    }

    const existing = this.getChannelBrief(channelId);
    const brief: ChannelBrief = {
      id: existing?.id ?? createChannelBriefId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId,
      objective: input.objective,
      scope: input.scope,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      risks: input.risks ?? [],
      decisionIds: input.decisionIds ?? [],
      attachmentIds: input.attachmentIds ?? [],
      linkPreviewIds: input.linkPreviewIds ?? [],
      updatedBy: input.updatedBy,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_briefs (
          id,
          workspace_id,
          channel_id,
          objective,
          scope,
          acceptance_criteria_json,
          open_questions_json,
          risks_json,
          decision_ids_json,
          attachment_ids_json,
          link_preview_ids_json,
          updated_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          objective = excluded.objective,
          scope = excluded.scope,
          acceptance_criteria_json = excluded.acceptance_criteria_json,
          open_questions_json = excluded.open_questions_json,
          risks_json = excluded.risks_json,
          decision_ids_json = excluded.decision_ids_json,
          attachment_ids_json = excluded.attachment_ids_json,
          link_preview_ids_json = excluded.link_preview_ids_json,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `)
      .run(
        brief.id,
        brief.workspaceId,
        brief.channelId,
        brief.objective,
        brief.scope,
        stringifyJson(brief.acceptanceCriteria),
        stringifyJson(brief.openQuestions),
        stringifyJson(brief.risks),
        stringifyJson(brief.decisionIds),
        stringifyJson(brief.attachmentIds),
        stringifyJson(brief.linkPreviewIds),
        brief.updatedBy,
        brief.createdAt,
        brief.updatedAt,
      );

    const updated = this.getChannelBrief(channelId);
    if (!updated) {
      throw new Error(`Failed to update channel brief: ${channelId}`);
    }
    return updated;
  }

  createChannelDecision(input: CreateChannelDecisionInput, now: string): ChannelDecision {
    this.assertChannelExists(input.channelId);
    this.assertSourceRefsInChannel(input.channelId, input);
    if (input.supersedesDecisionId) {
      this.assertDecisionInChannel(input.channelId, input.supersedesDecisionId);
      this.updateChannelDecision(input.supersedesDecisionId, { status: "superseded" }, now);
    }

    const decision: ChannelDecision = {
      id: createChannelDecisionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      title: input.title,
      decision: input.decision,
      rationale: input.rationale ?? "",
      alternatives: input.alternatives ?? [],
      status: input.supersedesDecisionId ? "active" : input.status ?? "active",
      supersedesDecisionId: input.supersedesDecisionId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_decisions (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          source_task_id,
          source_run_id,
          title,
          decision,
          rationale,
          alternatives_json,
          status,
          supersedes_decision_id,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.channelId,
        decision.sourceMessageId ?? null,
        decision.sourceTaskId ?? null,
        decision.sourceRunId ?? null,
        decision.title,
        decision.decision,
        decision.rationale,
        stringifyJson(decision.alternatives),
        decision.status,
        decision.supersedesDecisionId ?? null,
        decision.createdBy,
        decision.createdAt,
        decision.updatedAt,
      );

    const created = this.getChannelDecision(decision.id);
    if (!created) {
      throw new Error(`Failed to create channel decision: ${decision.id}`);
    }
    return created;
  }

  getChannelDecision(id: string): ChannelDecision | undefined {
    const row = this.database.prepare(channelDecisionSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelDecision(row) : undefined;
  }

  listChannelDecisions(options: ListChannelDecisionsOptions): ChannelDecision[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelDecisionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelDecision);
  }

  updateChannelDecision(id: string, input: UpdateChannelDecisionInput, now: string): ChannelDecision | undefined {
    const existing = this.getChannelDecision(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelDecision = {
      ...existing,
      title: input.title ?? existing.title,
      decision: input.decision ?? existing.decision,
      rationale: input.rationale ?? existing.rationale,
      alternatives: input.alternatives ?? existing.alternatives,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_decisions
        SET title = ?, decision = ?, rationale = ?, alternatives_json = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.decision, next.rationale, stringifyJson(next.alternatives), next.status, next.updatedAt, id);
    return this.getChannelDecision(id);
  }

  createChannelHandoff(input: CreateChannelHandoffInput, now: string): ChannelHandoff {
    this.assertChannelExists(input.channelId);
    this.assertSourceRefsInChannel(input.channelId, input);
    const handoff: ChannelHandoff = {
      id: createChannelHandoffId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceMessageId: input.sourceMessageId,
      sourceTaskId: input.sourceTaskId,
      sourceRunId: input.sourceRunId,
      fromParticipantId: input.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      reason: input.reason,
      requiredInput: input.requiredInput,
      expectedOutput: input.expectedOutput,
      status: input.status ?? "proposed",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_handoffs (
          id,
          workspace_id,
          channel_id,
          source_message_id,
          source_task_id,
          source_run_id,
          from_participant_id,
          from_participant_label,
          to_participant_id,
          to_participant_label,
          reason,
          required_input,
          expected_output,
          status,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        handoff.id,
        handoff.workspaceId,
        handoff.channelId,
        handoff.sourceMessageId ?? null,
        handoff.sourceTaskId ?? null,
        handoff.sourceRunId ?? null,
        handoff.fromParticipantId,
        handoff.fromParticipantLabel,
        handoff.toParticipantId,
        handoff.toParticipantLabel,
        handoff.reason,
        handoff.requiredInput,
        handoff.expectedOutput,
        handoff.status,
        handoff.createdBy,
        handoff.createdAt,
        handoff.updatedAt,
      );

    const created = this.getChannelHandoff(handoff.id);
    if (!created) {
      throw new Error(`Failed to create channel handoff: ${handoff.id}`);
    }
    return created;
  }

  getChannelHandoff(id: string): ChannelHandoff | undefined {
    const row = this.database.prepare(channelHandoffSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelHandoff(row) : undefined;
  }

  listChannelHandoffs(options: ListChannelHandoffsOptions): ChannelHandoff[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelHandoffSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelHandoff);
  }

  updateChannelHandoff(id: string, input: UpdateChannelHandoffInput, now: string): ChannelHandoff | undefined {
    const existing = this.getChannelHandoff(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelHandoff = {
      ...existing,
      fromParticipantId: input.fromParticipantId ?? existing.fromParticipantId,
      fromParticipantLabel: input.fromParticipantLabel ?? existing.fromParticipantLabel,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      reason: input.reason ?? existing.reason,
      requiredInput: input.requiredInput ?? existing.requiredInput,
      expectedOutput: input.expectedOutput ?? existing.expectedOutput,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_handoffs
        SET
          from_participant_id = ?,
          from_participant_label = ?,
          to_participant_id = ?,
          to_participant_label = ?,
          reason = ?,
          required_input = ?,
          expected_output = ?,
          status = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.fromParticipantId,
        next.fromParticipantLabel,
        next.toParticipantId,
        next.toParticipantLabel,
        next.reason,
        next.requiredInput,
        next.expectedOutput,
        next.status,
        next.updatedAt,
        id,
      );
    return this.getChannelHandoff(id);
  }

  createChannelContextSummary(input: CreateChannelContextSummaryInput, now: string): ChannelContextSummary {
    this.assertChannelExists(input.channelId);
    this.assertSummaryTargetInChannel(input.channelId, input.targetType, input.targetId);
    for (const messageId of input.sourceMessageIds ?? []) {
      this.assertMessageInChannel(input.channelId, messageId);
    }
    for (const decisionId of input.decisionIds ?? []) {
      this.assertDecisionInChannel(input.channelId, decisionId);
    }

    const summary: ChannelContextSummary = {
      id: createChannelContextSummaryId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      targetType: input.targetType,
      targetId: input.targetId,
      sourceMessageIds: input.sourceMessageIds ?? [],
      decisionIds: input.decisionIds ?? [],
      summary: input.summary,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      openQuestions: input.openQuestions ?? [],
      authorType: input.authorType,
      authorId: input.authorId,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_context_summaries (
          id,
          workspace_id,
          channel_id,
          target_type,
          target_id,
          source_message_ids_json,
          decision_ids_json,
          summary,
          acceptance_criteria_json,
          open_questions_json,
          author_type,
          author_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        summary.id,
        summary.workspaceId,
        summary.channelId,
        summary.targetType,
        summary.targetId,
        stringifyJson(summary.sourceMessageIds),
        stringifyJson(summary.decisionIds),
        summary.summary,
        stringifyJson(summary.acceptanceCriteria),
        stringifyJson(summary.openQuestions),
        summary.authorType,
        summary.authorId ?? null,
        summary.createdAt,
        summary.updatedAt,
      );

    const created = this.getChannelContextSummary(summary.id);
    if (!created) {
      throw new Error(`Failed to create channel context summary: ${summary.id}`);
    }
    return created;
  }

  getChannelContextSummary(id: string): ChannelContextSummary | undefined {
    const row = this.database.prepare(channelContextSummarySelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelContextSummary(row) : undefined;
  }

  listChannelContextSummaries(options: ListChannelContextSummariesOptions): ChannelContextSummary[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.targetType) {
      clauses.push("target_type = ?");
      params.push(options.targetType);
    }
    if (options.targetId) {
      clauses.push("target_id = ?");
      params.push(options.targetId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelContextSummarySelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelContextSummary);
  }

  updateChannelContextSummary(
    id: string,
    input: UpdateChannelContextSummaryInput,
    now: string,
  ): ChannelContextSummary | undefined {
    const existing = this.getChannelContextSummary(id);
    if (!existing) {
      return undefined;
    }
    const targetType = input.targetType ?? existing.targetType;
    const targetId = input.targetId ?? existing.targetId;
    this.assertSummaryTargetInChannel(existing.channelId, targetType, targetId);
    for (const messageId of input.sourceMessageIds ?? existing.sourceMessageIds) {
      this.assertMessageInChannel(existing.channelId, messageId);
    }
    for (const decisionId of input.decisionIds ?? existing.decisionIds) {
      this.assertDecisionInChannel(existing.channelId, decisionId);
    }
    const next: ChannelContextSummary = {
      ...existing,
      targetType,
      targetId,
      sourceMessageIds: input.sourceMessageIds ?? existing.sourceMessageIds,
      decisionIds: input.decisionIds ?? existing.decisionIds,
      summary: input.summary ?? existing.summary,
      acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
      openQuestions: input.openQuestions ?? existing.openQuestions,
      authorType: input.authorType ?? existing.authorType,
      authorId: nullableUpdate(input.authorId, existing.authorId),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_context_summaries
        SET
          target_type = ?,
          target_id = ?,
          source_message_ids_json = ?,
          decision_ids_json = ?,
          summary = ?,
          acceptance_criteria_json = ?,
          open_questions_json = ?,
          author_type = ?,
          author_id = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.targetType,
        next.targetId,
        stringifyJson(next.sourceMessageIds),
        stringifyJson(next.decisionIds),
        next.summary,
        stringifyJson(next.acceptanceCriteria),
        stringifyJson(next.openQuestions),
        next.authorType,
        next.authorId ?? null,
        next.updatedAt,
        id,
      );
    return this.getChannelContextSummary(id);
  }

  createChannelWorkflow(input: CreateChannelWorkflowInput, now: string): ChannelWorkflow {
    this.assertChannelExists(input.channelId);
    if (input.sourceHandoffId) {
      this.assertHandoffInChannel(input.channelId, input.sourceHandoffId);
    }

    const workflow: ChannelWorkflow = {
      id: createChannelWorkflowId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceHandoffId: input.sourceHandoffId,
      title: input.title,
      objective: input.objective,
      status: input.status ?? "draft",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_workflows (
          id,
          workspace_id,
          channel_id,
          source_handoff_id,
          title,
          objective,
          status,
          created_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        workflow.id,
        workflow.workspaceId,
        workflow.channelId,
        workflow.sourceHandoffId ?? null,
        workflow.title,
        workflow.objective,
        workflow.status,
        workflow.createdBy,
        workflow.createdAt,
        workflow.updatedAt,
      );

    const created = this.getChannelWorkflow(workflow.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow: ${workflow.id}`);
    }
    return created;
  }

  getChannelWorkflow(id: string): ChannelWorkflow | undefined {
    const row = this.database.prepare(channelWorkflowSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflow(row) : undefined;
  }

  listChannelWorkflows(options: ListChannelWorkflowsOptions): ChannelWorkflow[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelWorkflowSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map(mapChannelWorkflow);
  }

  updateChannelWorkflow(id: string, input: UpdateChannelWorkflowInput, now: string): ChannelWorkflow | undefined {
    const existing = this.getChannelWorkflow(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelWorkflow = {
      ...existing,
      title: input.title ?? existing.title,
      objective: input.objective ?? existing.objective,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_workflows
        SET title = ?, objective = ?, status = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(next.title, next.objective, next.status, next.updatedAt, id);
    return this.getChannelWorkflow(id);
  }

  transitionChannelWorkflowStatus(input: {
    readonly workflowId: string;
    readonly expectedStatus?: ChannelWorkflowStatus;
    readonly event: WorkflowTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
  }): TransitionResult<ChannelWorkflowStatus> {
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("workflow", input.workflowId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: workflow.status, to: workflow.status, duplicate: true };
      }
    }
    const result = transitionWorkflow({
      entityId: input.workflowId,
      currentStatus: workflow.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }
    const update = this.database
      .prepare("UPDATE channel_workflows SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(result.to, input.now, input.workflowId, result.from);
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflow(input.workflowId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? workflow.status };
    }
    this.recordStateTransitionEvent({
      workspaceId: workflow.workspaceId,
      entityType: "workflow",
      entityId: input.workflowId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    return result;
  }

  createChannelWorkflowStep(input: CreateChannelWorkflowStepInput, now: string): ChannelWorkflowStep {
    const workflow = this.getChannelWorkflow(input.workflowId);
    if (!workflow) {
      throw new Error(`Channel workflow not found: ${input.workflowId}`);
    }
    if (input.sourceHandoffId) {
      this.assertHandoffInChannel(workflow.channelId, input.sourceHandoffId);
    }
    if (input.contextSummaryId) {
      this.assertContextSummaryInChannel(workflow.channelId, input.contextSummaryId);
    }
    const position = input.position ?? this.nextWorkflowStepPosition(input.workflowId);
    const step: ChannelWorkflowStep = {
      id: createChannelWorkflowStepId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: workflow.channelId,
      workflowId: workflow.id,
      sourceHandoffId: input.sourceHandoffId,
      contextSummaryId: input.contextSummaryId,
      position,
      title: input.title,
      prompt: input.prompt,
      toParticipantId: input.toParticipantId,
      toParticipantLabel: input.toParticipantLabel,
      status: input.status ?? "queued",
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO channel_workflow_steps (
          id,
          workspace_id,
          channel_id,
          workflow_id,
          source_handoff_id,
          context_summary_id,
          task_id,
          run_id,
          position,
          title,
          prompt,
          to_participant_id,
          to_participant_label,
          status,
          blocker,
          result_summary,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        step.id,
        step.workspaceId,
        step.channelId,
        step.workflowId,
        step.sourceHandoffId ?? null,
        step.contextSummaryId ?? null,
        null,
        null,
        step.position,
        step.title,
        step.prompt,
        step.toParticipantId,
        step.toParticipantLabel,
        step.status,
        null,
        null,
        step.createdAt,
        step.updatedAt,
      );

    const created = this.getChannelWorkflowStep(step.id);
    if (!created) {
      throw new Error(`Failed to create channel workflow step: ${step.id}`);
    }
    return created;
  }

  getChannelWorkflowStep(id: string): ChannelWorkflowStep | undefined {
    const row = this.database.prepare(channelWorkflowStepSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelWorkflowStep(row) : undefined;
  }

  listChannelWorkflowSteps(options: ListChannelWorkflowStepsOptions): ChannelWorkflowStep[] {
    const clauses = ["workspace_id = ?", "workflow_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.workflowId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelWorkflowStepSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY position ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map(mapChannelWorkflowStep);
  }

  updateChannelWorkflowStep(
    id: string,
    input: UpdateChannelWorkflowStepInput,
    now: string,
  ): ChannelWorkflowStep | undefined {
    const existing = this.getChannelWorkflowStep(id);
    if (!existing) {
      return undefined;
    }
    const sourceHandoffId = nullableUpdate(input.sourceHandoffId, existing.sourceHandoffId);
    const contextSummaryId = nullableUpdate(input.contextSummaryId, existing.contextSummaryId);
    const taskId = nullableUpdate(input.taskId, existing.taskId);
    const runId = nullableUpdate(input.runId, existing.runId);
    if (sourceHandoffId) {
      this.assertHandoffInChannel(existing.channelId, sourceHandoffId);
    }
    if (contextSummaryId) {
      this.assertContextSummaryInChannel(existing.channelId, contextSummaryId);
    }
    if (taskId) {
      this.assertTaskInChannel(existing.channelId, taskId);
    }
    if (runId) {
      this.assertRunInChannel(existing.channelId, runId);
    }
    const next: ChannelWorkflowStep = {
      ...existing,
      sourceHandoffId,
      contextSummaryId,
      taskId,
      runId,
      position: input.position ?? existing.position,
      title: input.title ?? existing.title,
      prompt: input.prompt ?? existing.prompt,
      toParticipantId: input.toParticipantId ?? existing.toParticipantId,
      toParticipantLabel: input.toParticipantLabel ?? existing.toParticipantLabel,
      status: input.status ?? existing.status,
      blocker: nullableUpdate(input.blocker, existing.blocker),
      resultSummary: nullableUpdate(input.resultSummary, existing.resultSummary),
      updatedAt: now,
    };
    this.database
      .prepare(`
        UPDATE channel_workflow_steps
        SET
          source_handoff_id = ?,
          context_summary_id = ?,
          task_id = ?,
          run_id = ?,
          position = ?,
          title = ?,
          prompt = ?,
          to_participant_id = ?,
          to_participant_label = ?,
          status = ?,
          blocker = ?,
          result_summary = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.sourceHandoffId ?? null,
        next.contextSummaryId ?? null,
        next.taskId ?? null,
        next.runId ?? null,
        next.position,
        next.title,
        next.prompt,
        next.toParticipantId,
        next.toParticipantLabel,
        next.status,
        next.blocker ?? null,
        next.resultSummary ?? null,
        next.updatedAt,
        id,
      );
    return this.getChannelWorkflowStep(id);
  }

  transitionChannelWorkflowStepStatus(input: {
    readonly workflowStepId: string;
    readonly expectedStatus?: ChannelWorkflowStepStatus;
    readonly event: WorkflowStepTransitionEvent;
    readonly actor: StateTransitionActor;
    readonly reason?: string;
    readonly idempotencyKey?: string;
    readonly now: string;
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  }): TransitionResult<ChannelWorkflowStepStatus> {
    const step = this.getChannelWorkflowStep(input.workflowStepId);
    if (!step) {
      return { ok: false, code: "stale_transition", currentStatus: input.expectedStatus ?? "cancelled" };
    }
    if (input.idempotencyKey) {
      const existing = this.findStateTransitionByIdempotency("workflow_step", input.workflowStepId, input.idempotencyKey);
      if (existing) {
        return { ok: true, from: step.status, to: step.status, duplicate: true };
      }
    }
    const result = transitionWorkflowStep({
      entityId: input.workflowStepId,
      currentStatus: step.status,
      expectedStatus: input.expectedStatus,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.ok) {
      return result;
    }
    const update = this.database
      .prepare(`
        UPDATE channel_workflow_steps
        SET
          status = ?,
          task_id = ?,
          run_id = ?,
          blocker = ?,
          result_summary = ?,
          updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(
        result.to,
        input.taskId === undefined ? step.taskId ?? null : input.taskId,
        input.runId === undefined ? step.runId ?? null : input.runId,
        input.blocker === undefined ? step.blocker ?? null : input.blocker,
        input.resultSummary === undefined ? step.resultSummary ?? null : input.resultSummary,
        input.now,
        input.workflowStepId,
        result.from,
      );
    if (Number(update.changes) === 0) {
      const current = this.getChannelWorkflowStep(input.workflowStepId);
      return { ok: false, code: "stale_transition", currentStatus: current?.status ?? step.status };
    }
    this.recordStateTransitionEvent({
      workspaceId: step.workspaceId,
      entityType: "workflow_step",
      entityId: input.workflowStepId,
      fromStatus: result.from,
      toStatus: result.to,
      event: input.event,
      actor: input.actor,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
    });
    if (result.to === "succeeded" || result.to === "failed" || result.to === "skipped" || result.to === "cancelled") {
      this.releaseResourceLeasesForOwner("workflow_step", input.workflowStepId, input.now);
    }
    return result;
  }

  createOrReuseExternalWorkWorkflow(input: CreateExternalWorkWorkflowInput, now: string): ExternalWorkWorkflowResult {
    this.assertChannelExists(input.channelId);
    const existing = this.getExternalWorkRecordByIdempotency(input.externalWorkItem.sourceKind, input.externalWorkItem.idempotencyKey);
    if (existing) {
      const workflow = this.getChannelWorkflow(existing.workflowId);
      const workflowStep = this.getChannelWorkflowStep(existing.workflowStepId);
      if (!workflow || !workflowStep) {
        throw new Error(`External work mapping points to missing workflow state: ${existing.id}`);
      }
      return {
        externalWork: existing,
        workflow,
        workflowStep,
        duplicate: true,
      };
    }

    const channel = this.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const participantId = input.toParticipantId ?? channel.defaultTeammateId ?? input.workflowDefinition.config.agent.teammateId ?? "engineer";
    const participantLabel = input.toParticipantLabel ?? labelForParticipant(participantId);
    const workflow = this.createChannelWorkflow(
      {
        channelId: input.channelId,
        title: `External work: ${input.externalWorkItem.identifier}`,
        objective: `Handle ${input.externalWorkItem.kind} ${input.externalWorkItem.identifier}: ${input.externalWorkItem.title}`,
        status: "ready",
        createdBy: `${input.externalWorkItem.sourceKind}:external-work`,
      },
      now,
    );
    const workflowStep = this.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        title: `Review ${input.externalWorkItem.identifier}`,
        prompt: input.renderedPrompt,
        toParticipantId: participantId,
        toParticipantLabel: participantLabel,
      },
      now,
    );
    const record: ExternalWorkRecord = {
      id: createExternalWorkId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      sourceKind: input.externalWorkItem.sourceKind,
      workItemKind: input.externalWorkItem.kind,
      externalId: input.externalWorkItem.id,
      identifier: input.externalWorkItem.identifier,
      idempotencyKey: input.externalWorkItem.idempotencyKey,
      workflowId: workflow.id,
      workflowStepId: workflowStep.id,
      artifactIds: [],
      item: input.externalWorkItem,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO external_work_items (
          id,
          workspace_id,
          channel_id,
          source_kind,
          work_item_kind,
          external_id,
          identifier,
          idempotency_key,
          workflow_id,
          workflow_step_id,
          artifact_ids_json,
          item_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.sourceKind,
        record.workItemKind,
        record.externalId,
        record.identifier,
        record.idempotencyKey,
        record.workflowId,
        record.workflowStepId,
        stringifyJson(record.artifactIds),
        stringifyJson(record.item),
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkRecord(record.id);
    if (!created) {
      throw new Error(`Failed to create external work item: ${record.id}`);
    }
    return {
      externalWork: created,
      workflow,
      workflowStep,
      duplicate: false,
    };
  }

  getExternalWorkRecord(id: string): ExternalWorkRecord | undefined {
    const row = this.database.prepare(externalWorkSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkRecord(row) : undefined;
  }

  listExternalWorkRecords(options: ListExternalWorkRecordsOptions = {}): ExternalWorkRecord[] {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`
        SELECT
          ${externalWorkSelectColumnsFromAlias("w")}
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY w.updated_at DESC, w.id DESC
        LIMIT ?
      `)
      .all(...params)
      .map(mapExternalWorkRecord);
  }

  countExternalWorkRecords(options: Omit<ListExternalWorkRecordsOptions, "limit"> = {}): number {
    const clauses = ["w.workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("w.channel_id = ?");
      params.push(options.channelId);
    }
    if (options.sourceKind) {
      clauses.push("w.source_kind = ?");
      params.push(options.sourceKind);
    }
    if (options.workItemKind) {
      clauses.push("w.work_item_kind = ?");
      params.push(options.workItemKind);
    }
    if (options.schedulerStatus) {
      clauses.push("s.scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    const row = this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM external_work_items w
        LEFT JOIN external_work_scheduler_state s ON s.external_work_id = w.id
        WHERE ${clauses.join(" AND ")}
      `)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getExternalWorkRecordByIdempotency(sourceKind: ExternalWorkRecord["sourceKind"], idempotencyKey: string): ExternalWorkRecord | undefined {
    const row = this.database
      .prepare(externalWorkSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkRecord(row) : undefined;
  }

  updateExternalWorkArtifacts(id: string, artifactIds: readonly string[], now: string): ExternalWorkRecord | undefined {
    const existing = this.getExternalWorkRecord(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare("UPDATE external_work_items SET artifact_ids_json = ?, updated_at = ? WHERE id = ?")
      .run(stringifyJson([...artifactIds]), now, id);
    return this.getExternalWorkRecord(id);
  }

  createExternalWorkAction(input: CreateExternalWorkActionInput, now: string): ExternalWorkAction {
    this.assertChannelExists(input.channelId);
    const externalWork = this.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkActionByIdempotency(input.sourceKind, input.idempotencyKey);
    if (existing) {
      return existing;
    }
    const action: ExternalWorkAction = omitUndefined({
      id: createExternalWorkActionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      actionKind: input.actionKind,
      status: input.status,
      approvalId: input.approvalId,
      idempotencyKey: input.idempotencyKey,
      target: input.target,
      payload: input.payload,
      approvalRequirement: input.approvalRequirement,
      artifactIds: [...(input.artifactIds ?? [])],
      executionAttemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.database
      .prepare(`
        INSERT INTO external_work_actions (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          action_kind,
          status,
          approval_id,
          idempotency_key,
          target_json,
          payload_json,
          approval_requirement,
          artifact_ids_json,
          execution_attempt_count,
          last_attempt_at,
          next_attempt_at,
          last_error_code,
          last_error_message,
          created_at,
          updated_at,
          executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        action.id,
        action.workspaceId,
        action.channelId,
        action.externalWorkId,
        action.sourceKind,
        action.actionKind,
        action.status,
        action.approvalId ?? null,
        action.idempotencyKey,
        stringifyJson(action.target),
        stringifyJson(action.payload),
        action.approvalRequirement,
        stringifyJson(action.artifactIds),
        action.executionAttemptCount,
        null,
        null,
        null,
        null,
        action.createdAt,
        action.updatedAt,
        null,
      );

    const created = this.getExternalWorkAction(action.id);
    if (!created) {
      throw new Error(`Failed to create external work action: ${action.id}`);
    }
    return created;
  }

  getExternalWorkAction(id: string): ExternalWorkAction | undefined {
    const row = this.database.prepare(externalWorkActionSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkAction(row) : undefined;
  }

  getExternalWorkActionByIdempotency(sourceKind: ExternalWorkAction["sourceKind"], idempotencyKey: string): ExternalWorkAction | undefined {
    const row = this.database
      .prepare(externalWorkActionSelectSql("WHERE workspace_id = ? AND source_kind = ? AND idempotency_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, idempotencyKey);
    return row ? mapExternalWorkAction(row) : undefined;
  }

  listExternalWorkActions(options: ListExternalWorkActionsOptions = {}): ExternalWorkAction[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkActionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkAction);
  }

  countExternalWorkActions(options: Omit<ListExternalWorkActionsOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.actionKind) {
      clauses.push("action_kind = ?");
      params.push(options.actionKind);
    }
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_actions WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkAction(id: string, input: UpdateExternalWorkActionInput, now: string): ExternalWorkAction | undefined {
    const existing = this.getExternalWorkAction(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE external_work_actions
        SET
          status = ?,
          approval_id = ?,
          artifact_ids_json = ?,
          execution_attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?,
          executed_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        input.approvalId === undefined ? existing.approvalId ?? null : input.approvalId,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.executionAttemptCount ?? existing.executionAttemptCount,
        input.lastAttemptAt === undefined ? existing.lastAttemptAt ?? null : input.lastAttemptAt,
        input.nextAttemptAt === undefined ? existing.nextAttemptAt ?? null : input.nextAttemptAt,
        input.lastErrorCode === undefined ? existing.lastErrorCode ?? null : input.lastErrorCode,
        input.lastErrorMessage === undefined ? existing.lastErrorMessage ?? null : input.lastErrorMessage,
        now,
        input.executedAt === undefined ? existing.executedAt ?? null : input.executedAt,
        id,
      );
    return this.getExternalWorkAction(id);
  }

  createExternalWorkCiTriage(input: CreateExternalWorkCiTriageInput, now: string): ExternalWorkCiTriageRecord {
    this.assertChannelExists(input.channelId);
    const externalWork = this.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    if (externalWork.channelId !== input.channelId) {
      throw new Error(`External work item does not belong to channel: ${input.channelId}`);
    }
    const existing = this.getExternalWorkCiTriageByFailureKey(input.sourceKind, input.failureKey);
    if (existing) {
      return existing;
    }

    const record: ExternalWorkCiTriageRecord = omitUndefined({
      id: createExternalWorkCiTriageId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      externalWorkId: input.externalWorkId,
      sourceKind: input.sourceKind,
      repository: input.repository,
      subjectKind: input.subjectKind,
      subjectNumber: input.subjectNumber,
      headSha: input.headSha,
      failureKey: input.failureKey,
      status: input.status,
      checkName: input.checkName,
      workflowName: input.workflowName,
      jobName: input.jobName,
      conclusion: input.conclusion,
      htmlUrl: input.htmlUrl,
      firstFailingCommand: input.firstFailingCommand,
      reproductionCommand: input.reproductionCommand,
      suspectedSourcePath: input.suspectedSourcePath,
      taskId: input.taskId,
      runId: input.runId,
      artifactIds: [...(input.artifactIds ?? [])],
      failure: input.failure,
      lastErrorCode: input.lastErrorCode,
      lastErrorMessage: input.lastErrorMessage,
      createdAt: now,
      updatedAt: now,
    });

    this.database
      .prepare(`
        INSERT INTO external_work_ci_triage (
          id,
          workspace_id,
          channel_id,
          external_work_id,
          source_kind,
          repository,
          subject_kind,
          subject_number,
          head_sha,
          failure_key,
          status,
          check_name,
          workflow_name,
          job_name,
          conclusion,
          html_url,
          first_failing_command,
          reproduction_command,
          suspected_source_path,
          task_id,
          run_id,
          artifact_ids_json,
          failure_json,
          last_error_code,
          last_error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.workspaceId,
        record.channelId,
        record.externalWorkId,
        record.sourceKind,
        record.repository,
        record.subjectKind,
        record.subjectNumber,
        record.headSha,
        record.failureKey,
        record.status,
        record.checkName,
        record.workflowName ?? null,
        record.jobName ?? null,
        record.conclusion,
        record.htmlUrl ?? null,
        record.firstFailingCommand ?? null,
        record.reproductionCommand ?? null,
        record.suspectedSourcePath ?? null,
        record.taskId ?? null,
        record.runId ?? null,
        stringifyJson(record.artifactIds),
        stringifyJson(record.failure),
        record.lastErrorCode ?? null,
        record.lastErrorMessage ?? null,
        record.createdAt,
        record.updatedAt,
      );

    const created = this.getExternalWorkCiTriage(record.id);
    if (!created) {
      throw new Error(`Failed to create external work CI triage: ${record.id}`);
    }
    return created;
  }

  getExternalWorkCiTriage(id: string): ExternalWorkCiTriageRecord | undefined {
    const row = this.database.prepare(externalWorkCiTriageSelectSql("WHERE id = ?")).get(id);
    return row ? mapExternalWorkCiTriage(row) : undefined;
  }

  getExternalWorkCiTriageByFailureKey(
    sourceKind: ExternalWorkCiTriageRecord["sourceKind"],
    failureKey: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const row = this.database
      .prepare(externalWorkCiTriageSelectSql("WHERE workspace_id = ? AND source_kind = ? AND failure_key = ?"))
      .get(DEFAULT_WORKSPACE_ID, sourceKind, failureKey);
    return row ? mapExternalWorkCiTriage(row) : undefined;
  }

  listExternalWorkCiTriage(options: ListExternalWorkCiTriageOptions = {}): ExternalWorkCiTriageRecord[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkCiTriageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkCiTriage);
  }

  countExternalWorkCiTriage(options: Omit<ListExternalWorkCiTriageOptions, "limit"> = {}): number {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.externalWorkId) {
      clauses.push("external_work_id = ?");
      params.push(options.externalWorkId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM external_work_ci_triage WHERE ${clauses.join(" AND ")}`)
      .get(...params) as { readonly count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  updateExternalWorkCiTriage(
    id: string,
    input: UpdateExternalWorkCiTriageInput,
    now: string,
  ): ExternalWorkCiTriageRecord | undefined {
    const existing = this.getExternalWorkCiTriage(id);
    if (!existing) {
      return undefined;
    }
    this.database
      .prepare(`
        UPDATE external_work_ci_triage
        SET
          status = ?,
          first_failing_command = ?,
          reproduction_command = ?,
          suspected_source_path = ?,
          task_id = ?,
          run_id = ?,
          artifact_ids_json = ?,
          failure_json = ?,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? existing.status,
        nullableUpdate(input.firstFailingCommand, existing.firstFailingCommand) ?? null,
        nullableUpdate(input.reproductionCommand, existing.reproductionCommand) ?? null,
        nullableUpdate(input.suspectedSourcePath, existing.suspectedSourcePath) ?? null,
        nullableUpdate(input.taskId, existing.taskId) ?? null,
        nullableUpdate(input.runId, existing.runId) ?? null,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        stringifyJson(input.failure ?? existing.failure),
        nullableUpdate(input.lastErrorCode, existing.lastErrorCode) ?? null,
        nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage) ?? null,
        now,
        id,
      );
    return this.getExternalWorkCiTriage(id);
  }

  upsertExternalWorkSchedulerState(input: UpsertExternalWorkSchedulerStateInput, now: string): ExternalWorkSchedulerState {
    this.assertChannelExists(input.channelId);
    if (!this.getExternalWorkRecord(input.externalWorkId)) {
      throw new Error(`External work item not found: ${input.externalWorkId}`);
    }
    this.database
      .prepare(`
        INSERT INTO external_work_scheduler_state (
          external_work_id,
          workspace_id,
          channel_id,
          subject_key,
          source_key,
          workflow_id,
          workflow_step_id,
          scheduler_status,
          attempt_count,
          last_attempt_at,
          next_attempt_at,
          max_retry_backoff_ms,
          last_error_code,
          last_error_message,
          workspace_path,
          workspace_mode,
          hook_artifact_ids_json,
          last_reconciled_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_work_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          subject_key = excluded.subject_key,
          source_key = excluded.source_key,
          workflow_id = excluded.workflow_id,
          workflow_step_id = excluded.workflow_step_id,
          scheduler_status = excluded.scheduler_status,
          attempt_count = excluded.attempt_count,
          last_attempt_at = excluded.last_attempt_at,
          next_attempt_at = excluded.next_attempt_at,
          max_retry_backoff_ms = excluded.max_retry_backoff_ms,
          last_error_code = excluded.last_error_code,
          last_error_message = excluded.last_error_message,
          workspace_path = excluded.workspace_path,
          workspace_mode = excluded.workspace_mode,
          hook_artifact_ids_json = excluded.hook_artifact_ids_json,
          last_reconciled_at = excluded.last_reconciled_at,
          updated_at = excluded.updated_at
      `)
      .run(
        input.externalWorkId,
        DEFAULT_WORKSPACE_ID,
        input.channelId,
        input.subjectKey,
        input.sourceKey,
        input.workflowId,
        input.workflowStepId,
        input.schedulerStatus,
        input.attemptCount ?? 0,
        input.lastAttemptAt ?? null,
        input.nextAttemptAt ?? null,
        input.maxRetryBackoffMs,
        input.lastErrorCode ?? null,
        input.lastErrorMessage ?? null,
        input.workspacePath ?? null,
        input.workspaceMode ?? null,
        stringifyJson(input.hookArtifactIds ?? []),
        input.lastReconciledAt ?? null,
        now,
        now,
      );
    const created = this.getExternalWorkSchedulerState(input.externalWorkId);
    if (!created) {
      throw new Error(`Failed to upsert external work scheduler state: ${input.externalWorkId}`);
    }
    return created;
  }

  getExternalWorkSchedulerState(externalWorkId: string): ExternalWorkSchedulerState | undefined {
    const row = this.database.prepare(externalWorkSchedulerStateSelectSql("WHERE external_work_id = ?")).get(externalWorkId);
    return row ? mapExternalWorkSchedulerState(row) : undefined;
  }

  findActiveExternalWorkSchedulerState(sourceKey: string, subjectKey: string): ExternalWorkSchedulerState | undefined {
    const row = this.database
      .prepare(`
        ${externalWorkSchedulerStateSelectSql(
          "WHERE workspace_id = ? AND source_key = ? AND subject_key = ? AND scheduler_status IN ('discovered', 'claimed', 'workspace_preparing', 'ready', 'retry_wait')",
        )}
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(DEFAULT_WORKSPACE_ID, sourceKey, subjectKey);
    return row ? mapExternalWorkSchedulerState(row) : undefined;
  }

  listExternalWorkSchedulerStates(options: ListExternalWorkSchedulerStatesOptions = {}): ExternalWorkSchedulerState[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.schedulerStatus) {
      clauses.push("scheduler_status = ?");
      params.push(options.schedulerStatus);
    }
    if (options.sourceKey) {
      clauses.push("source_key = ?");
      params.push(options.sourceKey);
    }
    if (options.subjectKey) {
      clauses.push("subject_key = ?");
      params.push(options.subjectKey);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${externalWorkSchedulerStateSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, external_work_id DESC LIMIT ?`)
      .all(...params)
      .map(mapExternalWorkSchedulerState);
  }

  updateExternalWorkSchedulerState(
    externalWorkId: string,
    input: UpdateExternalWorkSchedulerStateInput,
    now: string,
  ): ExternalWorkSchedulerState | undefined {
    const existing = this.getExternalWorkSchedulerState(externalWorkId);
    if (!existing) {
      return undefined;
    }
    const next = {
      schedulerStatus: input.schedulerStatus ?? existing.schedulerStatus,
      attemptCount: input.attemptCount ?? existing.attemptCount,
      lastAttemptAt: nullableUpdate(input.lastAttemptAt, existing.lastAttemptAt),
      nextAttemptAt: nullableUpdate(input.nextAttemptAt, existing.nextAttemptAt),
      maxRetryBackoffMs: input.maxRetryBackoffMs ?? existing.maxRetryBackoffMs,
      lastErrorCode: nullableUpdate(input.lastErrorCode, existing.lastErrorCode),
      lastErrorMessage: nullableUpdate(input.lastErrorMessage, existing.lastErrorMessage),
      workspacePath: nullableUpdate(input.workspacePath, existing.workspacePath),
      workspaceMode: nullableUpdate(input.workspaceMode, existing.workspaceMode),
      hookArtifactIds: input.hookArtifactIds ?? existing.hookArtifactIds,
      lastReconciledAt: nullableUpdate(input.lastReconciledAt, existing.lastReconciledAt),
    };
    this.database
      .prepare(`
        UPDATE external_work_scheduler_state
        SET
          scheduler_status = ?,
          attempt_count = ?,
          last_attempt_at = ?,
          next_attempt_at = ?,
          max_retry_backoff_ms = ?,
          last_error_code = ?,
          last_error_message = ?,
          workspace_path = ?,
          workspace_mode = ?,
          hook_artifact_ids_json = ?,
          last_reconciled_at = ?,
          updated_at = ?
        WHERE external_work_id = ?
      `)
      .run(
        next.schedulerStatus,
        next.attemptCount,
        next.lastAttemptAt ?? null,
        next.nextAttemptAt ?? null,
        next.maxRetryBackoffMs,
        next.lastErrorCode ?? null,
        next.lastErrorMessage ?? null,
        next.workspacePath ?? null,
        next.workspaceMode ?? null,
        stringifyJson(next.hookArtifactIds),
        next.lastReconciledAt ?? null,
        now,
        externalWorkId,
      );
    return this.getExternalWorkSchedulerState(externalWorkId);
  }

  createProviderPreset(input: ProviderPresetInput, now: string): ProviderPreset {
    const preset: ProviderPreset = {
      id: createProviderPresetId(),
      kind: input.kind,
      displayName: input.displayName,
      providerId: input.providerId,
      model: input.model,
      api: input.api,
      baseUrl: input.baseUrl,
      apiKeyRef: input.apiKeyRef,
      headers: input.headers ?? {},
      authHeader: input.authHeader,
      reasoning: input.reasoning,
      input: input.input ?? ["text"],
      contextWindow: input.contextWindow,
      maxTokens: input.maxTokens,
      compat: input.compat ?? {},
      capabilities: input.capabilities,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO provider_presets (
          id,
          kind,
          display_name,
          provider_id,
          model,
          api,
          base_url,
          api_key_ref,
          headers_json,
          auth_header,
          reasoning,
          input_json,
          context_window,
          max_tokens,
          compat_json,
          capabilities_json,
          enabled,
          last_check_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        preset.id,
        preset.kind,
        preset.displayName,
        preset.providerId,
        preset.model,
        preset.api,
        preset.baseUrl ?? null,
        preset.apiKeyRef ?? null,
        stringifyJson(preset.headers),
        booleanToSql(preset.authHeader),
        booleanToSql(preset.reasoning),
        stringifyJson(preset.input),
        preset.contextWindow ?? null,
        preset.maxTokens ?? null,
        stringifyJson(preset.compat),
        stringifyJson(preset.capabilities),
        preset.enabled ? 1 : 0,
        preset.lastCheck ? stringifyJson(preset.lastCheck) : null,
        preset.createdAt,
        preset.updatedAt,
      );

    const created = this.getProviderPreset(preset.id);
    if (!created) {
      throw new Error(`Failed to create provider preset: ${preset.id}`);
    }
    return created;
  }

  getProviderPreset(id: string): ProviderPreset | undefined {
    const row = this.database.prepare(providerPresetSelectSql("WHERE id = ?")).get(id);
    return row ? mapProviderPreset(row) : undefined;
  }

  listProviderPresets(options: ListProviderPresetsOptions = {}): ProviderPreset[] {
    const whereClause = options.enabled === undefined ? "" : "WHERE enabled = ?";
    const statement = this.database.prepare(`${providerPresetSelectSql(whereClause)} ORDER BY created_at DESC`);
    const rows = options.enabled === undefined ? statement.all() : statement.all(options.enabled ? 1 : 0);
    return rows.map(mapProviderPreset);
  }

  updateProviderPreset(id: string, input: ProviderPresetUpdateInput, now: string): ProviderPreset | undefined {
    const existing = this.getProviderPreset(id);
    if (!existing) {
      return undefined;
    }

    const next: ProviderPreset = {
      ...existing,
      kind: input.kind ?? existing.kind,
      displayName: input.displayName ?? existing.displayName,
      providerId: input.providerId ?? existing.providerId,
      model: input.model ?? existing.model,
      api: input.api ?? existing.api,
      baseUrl: nullableUpdate(input.baseUrl, existing.baseUrl),
      apiKeyRef: nullableUpdate(input.apiKeyRef, existing.apiKeyRef),
      headers: input.headers ?? existing.headers,
      authHeader: nullableUpdate(input.authHeader, existing.authHeader),
      reasoning: nullableUpdate(input.reasoning, existing.reasoning),
      input: input.input ?? existing.input,
      contextWindow: nullableUpdate(input.contextWindow, existing.contextWindow),
      maxTokens: nullableUpdate(input.maxTokens, existing.maxTokens),
      compat: input.compat ?? existing.compat,
      capabilities: input.capabilities ?? existing.capabilities,
      enabled: input.enabled ?? existing.enabled,
      lastCheck: undefined,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE provider_presets
        SET
          kind = ?,
          display_name = ?,
          provider_id = ?,
          model = ?,
          api = ?,
          base_url = ?,
          api_key_ref = ?,
          headers_json = ?,
          auth_header = ?,
          reasoning = ?,
          input_json = ?,
          context_window = ?,
          max_tokens = ?,
          compat_json = ?,
          capabilities_json = ?,
          enabled = ?,
          last_check_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.kind,
        next.displayName,
        next.providerId,
        next.model,
        next.api,
        next.baseUrl ?? null,
        next.apiKeyRef ?? null,
        stringifyJson(next.headers),
        booleanToSql(next.authHeader),
        booleanToSql(next.reasoning),
        stringifyJson(next.input),
        next.contextWindow ?? null,
        next.maxTokens ?? null,
        stringifyJson(next.compat),
        stringifyJson(next.capabilities),
        next.enabled ? 1 : 0,
        next.lastCheck ? stringifyJson(next.lastCheck) : null,
        next.updatedAt,
        id,
      );

    return this.getProviderPreset(id);
  }

  recordProviderCheckResult(id: string, result: ProviderCheckResult): ProviderPreset | undefined {
    const updateResult = this.database
      .prepare("UPDATE provider_presets SET last_check_json = ? WHERE id = ?")
      .run(stringifyJson(result), id);
    if (Number(updateResult.changes) === 0) {
      return undefined;
    }
    return this.getProviderPreset(id);
  }

  deleteProviderPreset(id: string): boolean {
    const result = this.database.prepare("DELETE FROM provider_presets WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setProviderSecret(providerId: string, secretValue: string, now: string): void {
    this.database
      .prepare(`
        INSERT INTO provider_secrets (
          provider_id,
          secret_value,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET
          secret_value = excluded.secret_value,
          updated_at = excluded.updated_at
      `)
      .run(providerId, secretValue, now, now);
  }

  getProviderSecret(providerId: string): string | undefined {
    const row = this.database
      .prepare("SELECT secret_value FROM provider_secrets WHERE provider_id = ?")
      .get(providerId);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasProviderSecret(providerId: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 AS found FROM provider_secrets WHERE provider_id = ?").get(providerId));
  }

  deleteProviderSecret(providerId: string): boolean {
    const result = this.database.prepare("DELETE FROM provider_secrets WHERE provider_id = ?").run(providerId);
    return Number(result.changes) > 0;
  }

  createMcpServer(input: CreateMcpServerInput, now: string): McpServer {
    const server: McpServer = {
      id: input.id ?? createMcpServerId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      displayName: input.displayName,
      transport: normalizeMcpServerTransport(input.transport),
      enabled: input.enabled ?? true,
      required: input.required ?? false,
      status: input.status ?? { kind: "unknown" },
      startupTimeoutSec: input.startupTimeoutSec,
      toolTimeoutSec: input.toolTimeoutSec,
      enabledTools: input.enabledTools,
      disabledTools: input.disabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO mcp_servers (
          id,
          workspace_id,
          display_name,
          transport_json,
          enabled,
          required,
          status_json,
          startup_timeout_sec,
          tool_timeout_sec,
          enabled_tools_json,
          disabled_tools_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        server.id,
        server.workspaceId,
        server.displayName,
        stringifyJson(server.transport),
        server.enabled ? 1 : 0,
        server.required ? 1 : 0,
        stringifyJson(server.status),
        server.startupTimeoutSec ?? null,
        server.toolTimeoutSec ?? null,
        server.enabledTools ? stringifyJson(server.enabledTools) : null,
        stringifyJson(server.disabledTools),
        server.createdAt,
        server.updatedAt,
      );

    const created = this.getMcpServer(server.id);
    if (!created) {
      throw new Error(`Failed to create MCP server: ${server.id}`);
    }
    return created;
  }

  getMcpServer(id: string): McpServer | undefined {
    const row = this.database.prepare(mcpServerSelectSql("WHERE id = ?")).get(id);
    return row ? mapMcpServer(row) : undefined;
  }

  listMcpServers(options: ListMcpServersOptions = {}): McpServer[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${mcpServerSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMcpServer);
  }

  updateMcpServer(id: string, input: UpdateMcpServerInput, now: string): McpServer | undefined {
    const existing = this.getMcpServer(id);
    if (!existing) {
      return undefined;
    }
    const next: McpServer = {
      ...existing,
      displayName: input.displayName ?? existing.displayName,
      transport: input.transport ? normalizeMcpServerTransport(input.transport) : existing.transport,
      enabled: input.enabled ?? existing.enabled,
      required: input.required ?? existing.required,
      status: input.status ?? existing.status,
      startupTimeoutSec: nullableUpdate(input.startupTimeoutSec, existing.startupTimeoutSec),
      toolTimeoutSec: nullableUpdate(input.toolTimeoutSec, existing.toolTimeoutSec),
      enabledTools: nullableUpdate(input.enabledTools, existing.enabledTools),
      disabledTools: input.disabledTools ?? existing.disabledTools,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE mcp_servers
        SET
          display_name = ?,
          transport_json = ?,
          enabled = ?,
          required = ?,
          status_json = ?,
          startup_timeout_sec = ?,
          tool_timeout_sec = ?,
          enabled_tools_json = ?,
          disabled_tools_json = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.displayName,
        stringifyJson(next.transport),
        next.enabled ? 1 : 0,
        next.required ? 1 : 0,
        stringifyJson(next.status),
        next.startupTimeoutSec ?? null,
        next.toolTimeoutSec ?? null,
        next.enabledTools ? stringifyJson(next.enabledTools) : null,
        stringifyJson(next.disabledTools),
        next.updatedAt,
        id,
      );

    return this.getMcpServer(id);
  }

  updateMcpServerStatus(id: string, status: McpServerStatus, now: string): McpServer | undefined {
    return this.updateMcpServer(id, { status }, now);
  }

  deleteMcpServer(id: string): boolean {
    const result = this.database.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  setMcpServerSecret(serverId: string, secretName: string, secretValue: string, now: string): void {
    if (!this.getMcpServer(serverId)) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    this.database
      .prepare(`
        INSERT INTO mcp_server_secrets (
          server_id,
          secret_name,
          secret_value,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(server_id, secret_name) DO UPDATE SET
          secret_value = excluded.secret_value,
          updated_at = excluded.updated_at
      `)
      .run(serverId, secretName, secretValue, now, now);
  }

  getMcpServerSecret(serverId: string, secretName: string): string | undefined {
    const row = this.database
      .prepare("SELECT secret_value FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .get(serverId, secretName);
    return row ? readString(row, "secret_value") : undefined;
  }

  hasMcpServerSecret(serverId: string, secretName: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT 1 AS found FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
        .get(serverId, secretName),
    );
  }

  deleteMcpServerSecret(serverId: string, secretName: string): boolean {
    const result = this.database
      .prepare("DELETE FROM mcp_server_secrets WHERE server_id = ? AND secret_name = ?")
      .run(serverId, secretName);
    return Number(result.changes) > 0;
  }

  replaceMcpServerTools(serverId: string, tools: readonly ReplaceMcpServerToolInput[], now: string): McpTool[] {
    if (!this.getMcpServer(serverId)) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    const existingTools = new Map(this.listMcpTools({ serverId }).map((tool) => [tool.rawName, tool]));
    this.database.prepare("DELETE FROM mcp_tools WHERE server_id = ?").run(serverId);
    const insert = this.database.prepare(`
      INSERT INTO mcp_tools (
        server_id,
        raw_name,
        display_name,
        description,
        input_schema_json,
        callable_namespace,
        callable_name,
        side_effect_level,
        default_approval,
        enabled,
        first_seen_at,
        last_seen_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const tool of dedupeMcpToolInputs(tools)) {
      const existing = existingTools.get(tool.rawName);
      insert.run(
        serverId,
        tool.rawName,
        tool.displayName,
        tool.description ?? null,
        stringifyJson(tool.inputSchema),
        tool.callableNamespace,
        tool.callableName,
        tool.sideEffectLevel,
        tool.defaultApproval,
        tool.enabled === false ? 0 : 1,
        existing?.firstSeenAt ?? now,
        now,
        now,
      );
    }
    return this.listMcpTools({ serverId, limit: 500 });
  }

  listMcpTools(options: ListMcpToolsOptions = {}): McpTool[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.serverId) {
      clauses.push("server_id = ?");
      params.push(options.serverId);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${mcpToolSelectSql(whereClause)} ORDER BY server_id ASC, raw_name ASC LIMIT ?`)
      .all(...params)
      .map(mapMcpTool);
  }

  replaceTeammateMcpBindings(
    teammateId: string,
    bindings: readonly ReplaceTeammateMcpBindingInput[],
    now: string,
  ): TeammateMcpBinding[] {
    if (!this.getAiTeammate(teammateId)) {
      throw new Error(`AI teammate not found: ${teammateId}`);
    }
    this.database.prepare("DELETE FROM teammate_mcp_bindings WHERE teammate_id = ?").run(teammateId);
    const insert = this.database.prepare(`
      INSERT INTO teammate_mcp_bindings (
        teammate_id,
        server_id,
        mode,
        selected_tool_names_json,
        approval_overrides_json,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const binding of dedupeTeammateMcpBindingInputs(bindings)) {
      if (!this.getMcpServer(binding.serverId)) {
        throw new Error(`MCP server not found: ${binding.serverId}`);
      }
      insert.run(
        teammateId,
        binding.serverId,
        binding.mode,
        stringifyJson(binding.selectedToolNames ?? []),
        stringifyJson(binding.approvalOverrides ?? {}),
        binding.enabled === false ? 0 : 1,
        now,
        now,
      );
    }
    return this.listTeammateMcpBindings(teammateId);
  }

  listTeammateMcpBindings(teammateId: string): TeammateMcpBinding[] {
    return this.database
      .prepare(`${teammateMcpBindingSelectSql("WHERE teammate_id = ?")} ORDER BY server_id ASC`)
      .all(teammateId)
      .map(mapTeammateMcpBinding);
  }

  createMediaJob(input: CreateMediaJobInput, now: string): MediaJob {
    const job: MediaJob = {
      id: createMediaJobId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      providerPresetId: input.providerPresetId,
      operation: input.operation,
      prompt: input.prompt,
      input: input.input ?? {},
      artifactIds: [],
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };

    this.database
      .prepare(`
        INSERT INTO media_jobs (
          id,
          workspace_id,
          provider_preset_id,
          operation,
          prompt,
          input_json,
          artifact_ids_json,
          status,
          error_message,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.workspaceId,
        job.providerPresetId,
        job.operation,
        job.prompt,
        stringifyJson(redactSecrets(job.input)),
        stringifyJson(job.artifactIds),
        job.status,
        null,
        job.createdAt,
        job.updatedAt,
      );

    const created = this.getMediaJob(job.id);
    if (!created) {
      throw new Error(`Failed to create media job: ${job.id}`);
    }
    return created;
  }

  getMediaJob(id: string): MediaJob | undefined {
    const row = this.database.prepare(mediaJobSelectSql("WHERE id = ?")).get(id);
    return row ? mapMediaJob(row) : undefined;
  }

  listMediaJobs(options: ListMediaJobsOptions = {}): MediaJob[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.providerPresetId) {
      clauses.push("provider_preset_id = ?");
      params.push(options.providerPresetId);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${mediaJobSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapMediaJob);
  }

  updateMediaJobStatus(id: string, input: UpdateMediaJobStatusInput, now: string): MediaJob | undefined {
    const existing = this.getMediaJob(id);
    if (!existing) {
      return undefined;
    }

    this.database
      .prepare(`
        UPDATE media_jobs
        SET
          status = ?,
          artifact_ids_json = ?,
          error_message = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status,
        stringifyJson(input.artifactIds ?? existing.artifactIds),
        input.errorMessage === undefined ? existing.errorMessage ?? null : input.errorMessage,
        now,
        id,
      );

    return this.getMediaJob(id);
  }

  createApprovalRequest(input: CreateApprovalRequestInput, now: string): ApprovalRequest {
    const runId = normalizeOptionalOwnerId(input.runId);
    const taskId = normalizeOptionalOwnerId(input.taskId);
    const mediaJobId = normalizeOptionalOwnerId(input.mediaJobId);
    const externalWorkActionId = normalizeOptionalOwnerId(input.externalWorkActionId);
    const hasRunOwner = Boolean(runId && taskId);
    const hasMediaOwner = Boolean(mediaJobId);
    const hasExternalWorkActionOwner = Boolean(externalWorkActionId);
    if (Boolean(runId) !== Boolean(taskId)) {
      throw new Error("Run approval requests require both runId and taskId.");
    }
    if ([hasRunOwner, hasMediaOwner, hasExternalWorkActionOwner].filter(Boolean).length !== 1) {
      throw new Error("Approval requests require exactly one owner: runId/taskId, mediaJobId, or externalWorkActionId.");
    }
    if (runId && !this.getRun(runId)) {
      throw new Error(`Run not found: ${runId}`);
    }
    if (mediaJobId && !this.getMediaJob(mediaJobId)) {
      throw new Error(`Media job not found: ${mediaJobId}`);
    }
    if (externalWorkActionId && !this.getExternalWorkAction(externalWorkActionId)) {
      throw new Error(`External work action not found: ${externalWorkActionId}`);
    }

    const approval: ApprovalRequest = {
      id: createApprovalRequestId(),
      runId,
      taskId,
      mediaJobId,
      externalWorkActionId,
      channelId: input.channelId,
      toolCallId: input.toolCallId,
      actionType: input.actionType,
      risk: input.risk,
      title: input.title,
      description: input.description,
      payload: redactSecrets(input.payload) as ApprovalRequest["payload"],
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
    };

    this.database
      .prepare(`
        INSERT INTO approval_requests (
          id,
          run_id,
          task_id,
          media_job_id,
          external_work_action_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        approval.id,
        approval.runId ?? null,
        approval.taskId ?? null,
        approval.mediaJobId ?? null,
        approval.externalWorkActionId ?? null,
        approval.channelId ?? null,
        approval.toolCallId ?? null,
        approval.actionType,
        approval.risk,
        approval.title,
        approval.description,
        stringifyJson(approval.payload),
        approval.status,
        approval.createdAt,
        approval.expiresAt ?? null,
        null,
        null,
        null,
      );

    const created = this.getApprovalRequest(approval.id);
    if (!created) {
      throw new Error(`Failed to create approval request: ${approval.id}`);
    }
    return created;
  }

  getApprovalRequest(id: string): ApprovalRequest | undefined {
    const row = this.database.prepare(approvalRequestSelectSql("WHERE id = ?")).get(id);
    return row ? mapApprovalRequest(row) : undefined;
  }

  listApprovalRequests(options: ListApprovalRequestsOptions = {}): ApprovalRequest[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.mediaJobId) {
      clauses.push("media_job_id = ?");
      params.push(options.mediaJobId);
    }
    if (options.externalWorkActionId) {
      clauses.push("external_work_action_id = ?");
      params.push(options.externalWorkActionId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.database
      .prepare(`${approvalRequestSelectSql(whereClause)} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(mapApprovalRequest);
  }

  approveApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "approved", input, now);
  }

  denyApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "denied", input, now);
  }

  expireApprovalRequest(id: string, input: ResolveApprovalRequestInput, now: string): ApprovalRequest | undefined {
    return this.resolveApprovalRequest(id, "expired", input, now);
  }

  getApprovalPolicy(): ApprovalPolicy {
    const row = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (row) {
      return mapApprovalPolicy(row);
    }
    this.ensureDefaultApprovalPolicy();
    const created = this.database.prepare(approvalPolicySelectSql("WHERE workspace_id = ?")).get(DEFAULT_WORKSPACE_ID);
    if (!created) {
      throw new Error(`Approval policy not found: ${DEFAULT_WORKSPACE_ID}`);
    }
    return mapApprovalPolicy(created);
  }

  updateApprovalPolicy(input: ApprovalPolicyUpdateInput, now: string): ApprovalPolicy {
    const existing = this.getApprovalPolicy();
    const next: ApprovalPolicy = {
      ...existing,
      toolDecisions: {
        ...existing.toolDecisions,
        ...(input.toolDecisions ?? {}),
      },
      allowedWritePaths: input.allowedWritePaths ?? existing.allowedWritePaths,
      updatedAt: now,
    };

    this.database
      .prepare(`
        UPDATE approval_policies
        SET
          tool_decisions_json = ?,
          allowed_write_paths_json = ?,
          updated_at = ?
        WHERE workspace_id = ?
      `)
      .run(
        stringifyJson(next.toolDecisions),
        stringifyJson(next.allowedWritePaths),
        next.updatedAt,
        next.workspaceId,
      );

    return this.getApprovalPolicy();
  }

  close(): void {
    if (this.database.isOpen) {
      this.database.close();
    }
  }

  private configureDatabase(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private resolveApprovalRequest(
    id: string,
    status: Extract<ApprovalStatus, "approved" | "denied" | "expired">,
    input: ResolveApprovalRequestInput,
    now: string,
  ): ApprovalRequest | undefined {
    const existing = this.getApprovalRequest(id);
    if (!existing) {
      return undefined;
    }
    if (existing.status !== "pending") {
      throw new Error(`Approval request is not pending: ${id}`);
    }

    this.database
      .prepare(`
        UPDATE approval_requests
        SET
          status = ?,
          resolved_at = ?,
          resolved_by = ?,
          decision_reason = ?
        WHERE id = ?
      `)
      .run(status, now, status === "expired" ? (input.resolvedBy ?? null) : (input.resolvedBy ?? "local-user"), input.reason ?? null, id);

    return this.getApprovalRequest(id);
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    if (!this.hasMigration(INITIAL_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS run_sessions (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cwd TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          provider_name TEXT NOT NULL,
          provider_model TEXT NOT NULL,
          task_snapshot_json TEXT NOT NULL,
          provider_snapshot_json TEXT NOT NULL,
          request_snapshot_json TEXT NOT NULL,
          event_log_path TEXT NOT NULL,
          summary_path TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS run_events (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          UNIQUE(run_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_run_sessions_status ON run_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_task ON run_sessions(task_id);
        CREATE INDEX IF NOT EXISTS idx_run_sessions_created_at ON run_sessions(created_at);
        CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, seq);
        CREATE INDEX IF NOT EXISTS idx_run_events_type ON run_events(type);
      `);

      this.recordMigration(INITIAL_MIGRATION_VERSION, INITIAL_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDERS_MIGRATION_VERSION)) {
      if (!this.hasColumn("run_sessions", "provider_preset_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN provider_preset_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_presets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          display_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          model TEXT NOT NULL,
          api TEXT NOT NULL,
          base_url TEXT,
          api_key_ref TEXT,
          headers_json TEXT NOT NULL,
          auth_header INTEGER,
          reasoning INTEGER,
          input_json TEXT NOT NULL,
          context_window INTEGER,
          max_tokens INTEGER,
          compat_json TEXT NOT NULL,
          capabilities_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_provider_presets_kind ON provider_presets(kind);
        CREATE INDEX IF NOT EXISTS idx_provider_presets_enabled ON provider_presets(enabled);
      `);

      this.recordMigration(PROVIDERS_MIGRATION_VERSION, PROVIDERS_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVALS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      this.recordMigration(APPROVALS_MIGRATION_VERSION, APPROVALS_MIGRATION_NAME);
    }

    if (!this.hasMigration(WORKSPACE_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          default_provider_preset_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          name TEXT NOT NULL,
          bound_path TEXT,
          default_provider_preset_id TEXT,
          default_teammate_id TEXT,
          allowed_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          assignee_teammate_id TEXT,
          current_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id)
        );

        CREATE INDEX IF NOT EXISTS idx_channels_workspace ON channels(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_channel_status ON tasks(channel_id, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_current_run ON tasks(current_run_id);
      `);

      this.recordMigration(WORKSPACE_MIGRATION_VERSION, WORKSPACE_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVAL_POLICY_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS approval_policies (
          workspace_id TEXT PRIMARY KEY,
          tool_decisions_json TEXT NOT NULL,
          allowed_write_paths_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );
      `);

      this.recordMigration(APPROVAL_POLICY_MIGRATION_VERSION, APPROVAL_POLICY_MIGRATION_NAME);
    }

    if (!this.hasMigration(PROVIDER_CHECKS_MIGRATION_VERSION)) {
      if (!this.hasColumn("provider_presets", "last_check_json")) {
        this.database.exec("ALTER TABLE provider_presets ADD COLUMN last_check_json TEXT;");
      }

      this.recordMigration(PROVIDER_CHECKS_MIGRATION_VERSION, PROVIDER_CHECKS_MIGRATION_NAME);
    }

    if (!this.hasMigration(ARTIFACTS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS artifacts (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      this.recordMigration(ARTIFACTS_MIGRATION_VERSION, ARTIFACTS_MIGRATION_NAME);
    }

    if (!this.hasMigration(MEDIA_JOBS_MIGRATION_VERSION)) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS media_jobs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider_preset_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          prompt TEXT NOT NULL,
          input_json TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_media_jobs_workspace ON media_jobs(workspace_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_provider ON media_jobs(provider_preset_id);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_media_jobs_created_at ON media_jobs(created_at);
      `);

      this.recordMigration(MEDIA_JOBS_MIGRATION_VERSION, MEDIA_JOBS_MIGRATION_NAME);
    }

    if (!this.hasMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION)) {
      this.database.exec(`
        DROP TABLE IF EXISTS artifacts_next;

        CREATE TABLE artifacts_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          media_job_id TEXT,
          type TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT,
          content_type TEXT,
          size_bytes INTEGER,
          created_at TEXT NOT NULL,
          CHECK ((run_id IS NOT NULL AND media_job_id IS NULL) OR (run_id IS NULL AND media_job_id IS NOT NULL)),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO artifacts_next (
          id,
          run_id,
          media_job_id,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        )
        SELECT
          id,
          run_id,
          NULL,
          type,
          path,
          title,
          content_type,
          size_bytes,
          created_at
        FROM artifacts;

        DROP TABLE artifacts;
        ALTER TABLE artifacts_next RENAME TO artifacts;

        CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
      `);

      this.recordMigration(MEDIA_JOB_ARTIFACTS_MIGRATION_VERSION, MEDIA_JOB_ARTIFACTS_MIGRATION_NAME);
    }

    if (!this.hasMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION)) {
      this.database.exec(`
        DROP TABLE IF EXISTS approval_requests_next;

        CREATE TABLE approval_requests_next (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          task_id TEXT,
          media_job_id TEXT,
          channel_id TEXT,
          tool_call_id TEXT,
          action_type TEXT NOT NULL,
          risk TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          resolved_at TEXT,
          resolved_by TEXT,
          decision_reason TEXT,
          CHECK (
            (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL)
            OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL)
          ),
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
          FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO approval_requests_next (
          id,
          run_id,
          task_id,
          media_job_id,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        )
        SELECT
          id,
          run_id,
          task_id,
          NULL,
          channel_id,
          tool_call_id,
          action_type,
          risk,
          title,
          description,
          payload_json,
          status,
          created_at,
          expires_at,
          resolved_at,
          resolved_by,
          decision_reason
        FROM approval_requests;

        DROP TABLE approval_requests;
        ALTER TABLE approval_requests_next RENAME TO approval_requests;

        CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
        CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
      `);

      this.recordMigration(APPROVAL_MEDIA_JOB_OWNER_MIGRATION_VERSION, APPROVAL_MEDIA_JOB_OWNER_MIGRATION_NAME);
    }

    const hasChannelRuntimeMigration = this.hasMigration(CHANNEL_RUNTIME_MIGRATION_VERSION);
    if (
      !hasChannelRuntimeMigration ||
      !this.hasColumn("channels", "status") ||
      !this.hasColumn("channels", "runtime_policy_json") ||
      !this.hasTable("state_transition_events") ||
      !this.hasTable("resource_leases")
    ) {
      if (!this.hasColumn("channels", "status")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
      }
      if (!this.hasColumn("channels", "runtime_policy_json")) {
        this.database.exec(
          `ALTER TABLE channels ADD COLUMN runtime_policy_json TEXT NOT NULL DEFAULT '${stringifyJson(normalizeChannelRuntimePolicy(undefined))}';`,
        );
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS state_transition_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          from_status TEXT NOT NULL,
          to_status TEXT NOT NULL,
          event TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT,
          idempotency_key TEXT,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_state_transition_idempotency
        ON state_transition_events(entity_type, entity_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_state_transition_entity
        ON state_transition_events(entity_type, entity_id, created_at);

        CREATE TABLE IF NOT EXISTS resource_leases (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_active_resource_lease
        ON resource_leases(workspace_id, resource_type, resource_key)
        WHERE status = 'active';

        CREATE INDEX IF NOT EXISTS idx_resource_leases_owner
        ON resource_leases(owner_type, owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_expiry
        ON resource_leases(status, expires_at);
      `);

      if (!hasChannelRuntimeMigration) {
        this.recordMigration(CHANNEL_RUNTIME_MIGRATION_VERSION, CHANNEL_RUNTIME_MIGRATION_NAME);
      }
    }

    const hasProviderSecretsMigration = this.hasMigration(PROVIDER_SECRETS_MIGRATION_VERSION);
    if (!hasProviderSecretsMigration || !this.hasTable("provider_secrets")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS provider_secrets (
          provider_id TEXT PRIMARY KEY,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(provider_id) REFERENCES provider_presets(id) ON DELETE CASCADE
        );
      `);

      if (!hasProviderSecretsMigration) {
        this.recordMigration(PROVIDER_SECRETS_MIGRATION_VERSION, PROVIDER_SECRETS_MIGRATION_NAME);
      }
    }

    const hasChannelWorkspaceMigration = this.hasMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION);
    if (
      !hasChannelWorkspaceMigration ||
      !this.hasColumn("channels", "default_teammate_id") ||
      !this.hasColumn("tasks", "assignee_teammate_id") ||
      !this.hasTable("channel_messages") ||
      !this.hasTable("channel_attachments") ||
      !this.hasTable("channel_link_previews")
    ) {
      if (!this.hasColumn("channels", "default_teammate_id")) {
        this.database.exec("ALTER TABLE channels ADD COLUMN default_teammate_id TEXT;");
      }
      if (!this.hasColumn("tasks", "assignee_teammate_id")) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN assignee_teammate_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          thread_id TEXT,
          kind TEXT NOT NULL,
          intent TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          mentions_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          linked_task_id TEXT,
          linked_run_id TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_messages_channel_created
        ON channel_messages(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
        ON channel_messages(thread_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_attachments (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          kind TEXT NOT NULL,
          file_name TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_attachments_channel_created
        ON channel_attachments(channel_id, created_at);

        CREATE TABLE IF NOT EXISTS channel_link_previews (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          message_id TEXT,
          url TEXT NOT NULL,
          normalized_url TEXT NOT NULL,
          title TEXT,
          description TEXT,
          image_url TEXT,
          site_name TEXT,
          status TEXT NOT NULL,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(message_id) REFERENCES channel_messages(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_link_previews_channel_created
        ON channel_link_previews(channel_id, created_at);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_link_previews_channel_url
        ON channel_link_previews(channel_id, normalized_url);
      `);

      if (!hasChannelWorkspaceMigration) {
        this.recordMigration(CHANNEL_WORKSPACE_MIGRATION_VERSION, CHANNEL_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasChannelProtocolMigration = this.hasMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION);
    if (
      !hasChannelProtocolMigration ||
      !this.hasTable("channel_briefs") ||
      !this.hasTable("channel_decisions") ||
      !this.hasTable("channel_handoffs") ||
      !this.hasTable("channel_context_summaries")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_briefs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL UNIQUE,
          objective TEXT NOT NULL,
          scope TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          risks_json TEXT NOT NULL,
          decision_ids_json TEXT NOT NULL,
          attachment_ids_json TEXT NOT NULL,
          link_preview_ids_json TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_briefs_channel
        ON channel_briefs(channel_id);

        CREATE TABLE IF NOT EXISTS channel_decisions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          title TEXT NOT NULL,
          decision TEXT NOT NULL,
          rationale TEXT NOT NULL,
          alternatives_json TEXT NOT NULL,
          status TEXT NOT NULL,
          supersedes_decision_id TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL,
          FOREIGN KEY(supersedes_decision_id) REFERENCES channel_decisions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_created
        ON channel_decisions(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_decisions_channel_status_created
        ON channel_decisions(channel_id, status, created_at);

        CREATE TABLE IF NOT EXISTS channel_handoffs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT,
          source_task_id TEXT,
          source_run_id TEXT,
          from_participant_id TEXT NOT NULL,
          from_participant_label TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          reason TEXT NOT NULL,
          required_input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE SET NULL,
          FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(source_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_handoffs_channel_status_created
        ON channel_handoffs(channel_id, status, created_at);

        CREATE TABLE IF NOT EXISTS channel_context_summaries (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NOT NULL,
          source_message_ids_json TEXT NOT NULL,
          decision_ids_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          open_questions_json TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_channel_context_summaries_target_updated
        ON channel_context_summaries(channel_id, target_type, target_id, updated_at);
      `);

      if (!hasChannelProtocolMigration) {
        this.recordMigration(CHANNEL_PROTOCOL_MIGRATION_VERSION, CHANNEL_PROTOCOL_MIGRATION_NAME);
      }
    }

    const hasChannelWorkflowMigration = this.hasMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION);
    if (
      !hasChannelWorkflowMigration ||
      !this.hasTable("channel_workflows") ||
      !this.hasTable("channel_workflow_steps")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_workflows (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_handoff_id TEXT,
          title TEXT NOT NULL,
          objective TEXT NOT NULL,
          status TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_channel_status_updated
        ON channel_workflows(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflows_handoff
        ON channel_workflows(source_handoff_id);

        CREATE TABLE IF NOT EXISTS channel_workflow_steps (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          source_handoff_id TEXT,
          context_summary_id TEXT,
          task_id TEXT,
          run_id TEXT,
          position INTEGER NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          to_participant_id TEXT NOT NULL,
          to_participant_label TEXT NOT NULL,
          status TEXT NOT NULL,
          blocker TEXT,
          result_summary TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(workflow_id) REFERENCES channel_workflows(id) ON DELETE CASCADE,
          FOREIGN KEY(source_handoff_id) REFERENCES channel_handoffs(id) ON DELETE SET NULL,
          FOREIGN KEY(context_summary_id) REFERENCES channel_context_summaries(id) ON DELETE SET NULL,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_workflow_position
        ON channel_workflow_steps(workflow_id, position);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_channel_status
        ON channel_workflow_steps(channel_id, status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_task
        ON channel_workflow_steps(task_id);

        CREATE INDEX IF NOT EXISTS idx_channel_workflow_steps_run
        ON channel_workflow_steps(run_id);
      `);

      if (!hasChannelWorkflowMigration) {
        this.recordMigration(CHANNEL_WORKFLOW_MIGRATION_VERSION, CHANNEL_WORKFLOW_MIGRATION_NAME);
      }
    }

    const hasAiTeammateWorkspaceMigration = this.hasMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION);
    if (
      !hasAiTeammateWorkspaceMigration ||
      !this.hasTable("ai_teammates") ||
      !this.hasTable("teammate_channel_memberships") ||
      !this.hasTable("teammate_skill_bindings") ||
      !this.hasTable("teammate_memory_scopes") ||
      !this.hasTable("teammate_direct_threads") ||
      !this.hasTable("teammate_direct_messages")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS ai_teammates (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          template_id TEXT,
          role_key TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          avatar_tone TEXT,
          avatar_image_attachment_id TEXT,
          provider_preset_id TEXT,
          system_prompt TEXT,
          append_system_prompt_json TEXT NOT NULL,
          allowed_tools_json TEXT NOT NULL,
          approval_profile_json TEXT NOT NULL,
          status TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          hidden INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_ai_teammates_workspace_status
        ON ai_teammates(workspace_id, status, hidden, pinned);

        CREATE TABLE IF NOT EXISTS teammate_channel_memberships (
          teammate_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          is_default INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, channel_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_channel_memberships_channel
        ON teammate_channel_memberships(channel_id);

        CREATE TABLE IF NOT EXISTS teammate_skill_bindings (
          teammate_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          source TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, skill_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS teammate_memory_scopes (
          id TEXT PRIMARY KEY,
          teammate_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          channel_id TEXT,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_memory_scopes_teammate
        ON teammate_memory_scopes(teammate_id, enabled);

        CREATE TABLE IF NOT EXISTS teammate_direct_threads (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_teammate_direct_threads_teammate
        ON teammate_direct_threads(workspace_id, teammate_id);

        CREATE TABLE IF NOT EXISTS teammate_direct_messages (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          teammate_id TEXT NOT NULL,
          author_type TEXT NOT NULL,
          author_id TEXT,
          body TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          linked_task_id TEXT,
          linked_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(thread_id) REFERENCES teammate_direct_threads(id) ON DELETE CASCADE,
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_thread_created
        ON teammate_direct_messages(thread_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_teammate_direct_messages_teammate_created
        ON teammate_direct_messages(teammate_id, created_at);
      `);

      if (!hasAiTeammateWorkspaceMigration) {
        this.recordMigration(AI_TEAMMATE_WORKSPACE_MIGRATION_VERSION, AI_TEAMMATE_WORKSPACE_MIGRATION_NAME);
      }
    }

    const hasExternalWorkMigration = this.hasMigration(EXTERNAL_WORK_MIGRATION_VERSION);
    if (
      !hasExternalWorkMigration ||
      !this.hasTable("external_work_items") ||
      !this.hasColumn("artifacts", "external_work_id")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_items (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          work_item_kind TEXT NOT NULL,
          external_id TEXT NOT NULL,
          identifier TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          item_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_idempotency
        ON external_work_items(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_channel_created
        ON external_work_items(channel_id, created_at);
      `);

      if (!this.hasColumn("artifacts", "external_work_id")) {
        this.database.exec(`
          DROP TABLE IF EXISTS artifacts_next;

          CREATE TABLE artifacts_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            media_job_id TEXT,
            external_work_id TEXT,
            type TEXT NOT NULL,
            path TEXT NOT NULL,
            title TEXT,
            content_type TEXT,
            size_bytes INTEGER,
            created_at TEXT NOT NULL,
            CHECK (
              (run_id IS NOT NULL AND media_job_id IS NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NOT NULL AND external_work_id IS NULL)
              OR (run_id IS NULL AND media_job_id IS NULL AND external_work_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE
          );

          INSERT INTO artifacts_next (
            id,
            run_id,
            media_job_id,
            external_work_id,
            type,
            path,
            title,
            content_type,
            size_bytes,
            created_at
          )
          SELECT
            id,
            run_id,
            media_job_id,
            NULL,
            type,
            path,
            title,
            content_type,
            size_bytes,
            created_at
          FROM artifacts;

          DROP TABLE artifacts;
          ALTER TABLE artifacts_next RENAME TO artifacts;

          CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_media_job ON artifacts(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_external_work ON artifacts(external_work_id);
          CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at);
        `);
      }

      if (!hasExternalWorkMigration) {
        this.recordMigration(EXTERNAL_WORK_MIGRATION_VERSION, EXTERNAL_WORK_MIGRATION_NAME);
      }
    }

    const hasExternalWorkSchedulerMigration = this.hasMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION);
    if (!hasExternalWorkSchedulerMigration || !this.hasTable("external_work_scheduler_state")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_scheduler_state (
          external_work_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          subject_key TEXT NOT NULL,
          source_key TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_step_id TEXT NOT NULL,
          scheduler_status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          max_retry_backoff_ms INTEGER NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          workspace_path TEXT,
          workspace_mode TEXT,
          hook_artifact_ids_json TEXT NOT NULL,
          last_reconciled_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_subject
        ON external_work_scheduler_state(workspace_id, source_key, subject_key, scheduler_status);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_channel_status
        ON external_work_scheduler_state(channel_id, scheduler_status, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_scheduler_retry
        ON external_work_scheduler_state(scheduler_status, next_attempt_at);
      `);

      if (!hasExternalWorkSchedulerMigration) {
        this.recordMigration(EXTERNAL_WORK_SCHEDULER_MIGRATION_VERSION, EXTERNAL_WORK_SCHEDULER_MIGRATION_NAME);
      }
    }

    const hasExternalWorkActionsMigration = this.hasMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION);
    if (
      !hasExternalWorkActionsMigration ||
      !this.hasTable("external_work_actions") ||
      !this.hasColumn("approval_requests", "external_work_action_id")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_actions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          action_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          approval_id TEXT,
          idempotency_key TEXT NOT NULL,
          target_json TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          approval_requirement TEXT NOT NULL,
          artifact_ids_json TEXT NOT NULL,
          execution_attempt_count INTEGER NOT NULL,
          last_attempt_at TEXT,
          next_attempt_at TEXT,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          executed_at TEXT,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(approval_id) REFERENCES approval_requests(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_actions_idempotency
        ON external_work_actions(workspace_id, source_kind, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_external_work_status
        ON external_work_actions(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_approval
        ON external_work_actions(workspace_id, approval_id);

        CREATE INDEX IF NOT EXISTS idx_external_work_actions_updated
        ON external_work_actions(workspace_id, updated_at);
      `);

      if (!this.hasColumn("approval_requests", "external_work_action_id")) {
        this.database.exec(`
          DROP TABLE IF EXISTS approval_requests_next;

          CREATE TABLE approval_requests_next (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            task_id TEXT,
            media_job_id TEXT,
            external_work_action_id TEXT,
            channel_id TEXT,
            tool_call_id TEXT,
            action_type TEXT NOT NULL,
            risk TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            resolved_at TEXT,
            resolved_by TEXT,
            decision_reason TEXT,
            CHECK (
              (run_id IS NOT NULL AND task_id IS NOT NULL AND media_job_id IS NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NOT NULL AND external_work_action_id IS NULL)
              OR (run_id IS NULL AND task_id IS NULL AND media_job_id IS NULL AND external_work_action_id IS NOT NULL)
            ),
            FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE CASCADE,
            FOREIGN KEY(media_job_id) REFERENCES media_jobs(id) ON DELETE CASCADE,
            FOREIGN KEY(external_work_action_id) REFERENCES external_work_actions(id) ON DELETE CASCADE
          );

          INSERT INTO approval_requests_next (
            id,
            run_id,
            task_id,
            media_job_id,
            external_work_action_id,
            channel_id,
            tool_call_id,
            action_type,
            risk,
            title,
            description,
            payload_json,
            status,
            created_at,
            expires_at,
            resolved_at,
            resolved_by,
            decision_reason
          )
          SELECT
            id,
            run_id,
            task_id,
            media_job_id,
            NULL,
            channel_id,
            tool_call_id,
            action_type,
            risk,
            title,
            description,
            payload_json,
            status,
            created_at,
            expires_at,
            resolved_at,
            resolved_by,
            decision_reason
          FROM approval_requests;

          DROP TABLE approval_requests;
          ALTER TABLE approval_requests_next RENAME TO approval_requests;

          CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_media_job ON approval_requests(media_job_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_external_work_action ON approval_requests(external_work_action_id);
          CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
        `);
      }

      if (!hasExternalWorkActionsMigration) {
        this.recordMigration(EXTERNAL_WORK_ACTIONS_MIGRATION_VERSION, EXTERNAL_WORK_ACTIONS_MIGRATION_NAME);
      }
    }

    const hasExternalWorkCiTriageMigration = this.hasMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION);
    if (!hasExternalWorkCiTriageMigration || !this.hasTable("external_work_ci_triage")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS external_work_ci_triage (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          external_work_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          repository TEXT NOT NULL,
          subject_kind TEXT NOT NULL,
          subject_number INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          failure_key TEXT NOT NULL,
          status TEXT NOT NULL,
          check_name TEXT NOT NULL,
          workflow_name TEXT,
          job_name TEXT,
          conclusion TEXT NOT NULL,
          html_url TEXT,
          first_failing_command TEXT,
          reproduction_command TEXT,
          suspected_source_path TEXT,
          task_id TEXT,
          run_id TEXT,
          artifact_ids_json TEXT NOT NULL,
          failure_json TEXT NOT NULL,
          last_error_code TEXT,
          last_error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(external_work_id) REFERENCES external_work_items(id) ON DELETE CASCADE,
          FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_external_work_ci_triage_failure
        ON external_work_ci_triage(workspace_id, source_kind, failure_key);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_external_work_status
        ON external_work_ci_triage(workspace_id, external_work_id, status);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_channel_updated
        ON external_work_ci_triage(workspace_id, channel_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_external_work_ci_triage_head
        ON external_work_ci_triage(workspace_id, head_sha);
      `);

      if (!hasExternalWorkCiTriageMigration) {
        this.recordMigration(EXTERNAL_WORK_CI_TRIAGE_MIGRATION_VERSION, EXTERNAL_WORK_CI_TRIAGE_MIGRATION_NAME);
      }
    }

    const hasChannelExecutionProposalsMigration = this.hasMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION);
    if (!hasChannelExecutionProposalsMigration || !this.hasTable("channel_execution_proposals")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS channel_execution_proposals (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          source_message_id TEXT NOT NULL,
          proposed_by_teammate_id TEXT NOT NULL,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          assignee_teammate_id TEXT NOT NULL,
          acceptance_criteria_json TEXT NOT NULL,
          collaboration_steps_json TEXT NOT NULL,
          required_tools_json TEXT NOT NULL,
          risk_summary TEXT,
          status TEXT NOT NULL,
          linked_task_id TEXT,
          linked_run_id TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
          FOREIGN KEY(source_message_id) REFERENCES channel_messages(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_channel_created
        ON channel_execution_proposals(channel_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_source
        ON channel_execution_proposals(source_message_id);

        CREATE INDEX IF NOT EXISTS idx_channel_execution_proposals_status
        ON channel_execution_proposals(channel_id, status, updated_at);
      `);

      if (!hasChannelExecutionProposalsMigration) {
        this.recordMigration(CHANNEL_EXECUTION_PROPOSALS_MIGRATION_VERSION, CHANNEL_EXECUTION_PROPOSALS_MIGRATION_NAME);
      }
    }

    const hasRuntimeSupervisorMigration = this.hasMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION);
    if (
      !hasRuntimeSupervisorMigration ||
      !this.hasColumn("run_sessions", "work_unit_id") ||
      !this.hasTable("work_units") ||
      !this.hasTable("work_unit_attempts") ||
      !this.hasTable("runtime_events") ||
      !this.hasTable("runtime_heartbeats") ||
      !this.hasTable("runtime_semaphore_slots") ||
      !this.hasColumn("resource_leases", "last_renewed_at") ||
      !this.hasColumn("resource_leases", "release_reason") ||
      !this.hasColumn("resource_leases", "work_unit_id") ||
      !this.hasColumn("resource_leases", "attempt_id")
    ) {
      if (!this.hasColumn("run_sessions", "work_unit_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN work_unit_id TEXT;");
      }
      if (!this.hasColumn("resource_leases", "last_renewed_at")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN last_renewed_at TEXT;");
        this.database.exec("UPDATE resource_leases SET last_renewed_at = acquired_at WHERE last_renewed_at IS NULL;");
      }
      if (!this.hasColumn("resource_leases", "release_reason")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN release_reason TEXT;");
      }
      if (!this.hasColumn("resource_leases", "work_unit_id")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN work_unit_id TEXT;");
      }
      if (!this.hasColumn("resource_leases", "attempt_id")) {
        this.database.exec("ALTER TABLE resource_leases ADD COLUMN attempt_id TEXT;");
      }

      this.database.exec(`
        CREATE TABLE IF NOT EXISTS work_units (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          channel_id TEXT,
          task_id TEXT,
          teammate_id TEXT,
          provider_preset_id TEXT,
          runner_id TEXT,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL,
          attempt_count INTEGER NOT NULL,
          active_attempt_id TEXT,
          created_by_client_id TEXT,
          created_by_actor TEXT NOT NULL,
          request_json TEXT NOT NULL,
          timeout_policy_json TEXT NOT NULL,
          linked_run_id TEXT,
          linked_message_id TEXT,
          linked_media_job_id TEXT,
          linked_external_work_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
          FOREIGN KEY(linked_run_id) REFERENCES run_sessions(id) ON DELETE SET NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_work_units_idempotency
        ON work_units(workspace_id, kind, owner_type, owner_id, idempotency_key);

        CREATE INDEX IF NOT EXISTS idx_work_units_status_priority
        ON work_units(workspace_id, status, priority, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_owner
        ON work_units(workspace_id, owner_type, owner_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_work_units_linked_run
        ON work_units(linked_run_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_work_unit
        ON run_sessions(work_unit_id);

        CREATE TABLE IF NOT EXISTS work_unit_attempts (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          provider_preset_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          ended_at TEXT,
          last_event_at TEXT,
          last_heartbeat_at TEXT,
          abort_requested_at TEXT,
          error_code TEXT,
          error_message TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          UNIQUE(work_unit_id, attempt_number)
        );

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_work_unit
        ON work_unit_attempts(work_unit_id, attempt_number);

        CREATE INDEX IF NOT EXISTS idx_work_unit_attempts_runtime
        ON work_unit_attempts(runtime_instance_id, status);

        CREATE TABLE IF NOT EXISTS runtime_events (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          type TEXT NOT NULL,
          actor TEXT NOT NULL,
          data_json TEXT NOT NULL,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE SET NULL,
          UNIQUE(work_unit_id, seq)
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_events_work_unit_seq
        ON runtime_events(work_unit_id, seq);

        CREATE INDEX IF NOT EXISTS idx_runtime_events_type_ts
        ON runtime_events(type, ts);

        CREATE TABLE IF NOT EXISTS runtime_heartbeats (
          id TEXT PRIMARY KEY,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          runtime_instance_id TEXT NOT NULL,
          ts TEXT NOT NULL,
          source TEXT NOT NULL,
          detail_json TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_attempt_ts
        ON runtime_heartbeats(attempt_id, ts);

        CREATE INDEX IF NOT EXISTS idx_runtime_heartbeats_runtime_ts
        ON runtime_heartbeats(runtime_instance_id, ts);

        CREATE TABLE IF NOT EXISTS runtime_semaphore_slots (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_type TEXT NOT NULL,
          resource_key TEXT NOT NULL,
          owner_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          work_unit_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          status TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          last_renewed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          released_at TEXT,
          release_reason TEXT,
          FOREIGN KEY(work_unit_id) REFERENCES work_units(id) ON DELETE CASCADE,
          FOREIGN KEY(attempt_id) REFERENCES work_unit_attempts(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_active
        ON runtime_semaphore_slots(workspace_id, resource_type, resource_key, status, expires_at);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_owner
        ON runtime_semaphore_slots(owner_id, status);

        CREATE INDEX IF NOT EXISTS idx_runtime_semaphore_work_unit
        ON runtime_semaphore_slots(work_unit_id, status);

        CREATE INDEX IF NOT EXISTS idx_resource_leases_work_unit
        ON resource_leases(work_unit_id, attempt_id, status);
      `);

      if (!hasRuntimeSupervisorMigration) {
        this.recordMigration(RUNTIME_SUPERVISOR_MIGRATION_VERSION, RUNTIME_SUPERVISOR_MIGRATION_NAME);
      }
    }

    const hasMcpToolManagementMigration = this.hasMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION);
    if (
      !hasMcpToolManagementMigration ||
      !this.hasTable("mcp_servers") ||
      !this.hasTable("mcp_server_secrets") ||
      !this.hasTable("mcp_tools") ||
      !this.hasTable("teammate_mcp_bindings")
    ) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          transport_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          required INTEGER NOT NULL,
          status_json TEXT NOT NULL,
          startup_timeout_sec INTEGER,
          tool_timeout_sec INTEGER,
          enabled_tools_json TEXT,
          disabled_tools_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_servers_workspace
        ON mcp_servers(workspace_id, enabled, created_at);

        CREATE TABLE IF NOT EXISTS mcp_server_secrets (
          server_id TEXT NOT NULL,
          secret_name TEXT NOT NULL,
          secret_value TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, secret_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS mcp_tools (
          server_id TEXT NOT NULL,
          raw_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          description TEXT,
          input_schema_json TEXT NOT NULL,
          callable_namespace TEXT NOT NULL,
          callable_name TEXT NOT NULL,
          side_effect_level TEXT NOT NULL,
          default_approval TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(server_id, raw_name),
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_mcp_tools_server_enabled
        ON mcp_tools(server_id, enabled, raw_name);

        CREATE TABLE IF NOT EXISTS teammate_mcp_bindings (
          teammate_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          selected_tool_names_json TEXT NOT NULL,
          approval_overrides_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(teammate_id, server_id),
          FOREIGN KEY(teammate_id) REFERENCES ai_teammates(id) ON DELETE CASCADE,
          FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_teammate_mcp_bindings_server
        ON teammate_mcp_bindings(server_id, enabled);
      `);

      if (!hasMcpToolManagementMigration) {
        this.recordMigration(MCP_TOOL_MANAGEMENT_MIGRATION_VERSION, MCP_TOOL_MANAGEMENT_MIGRATION_NAME);
      }
    }

    const hasLingMemoryMigration = this.hasMigration(LING_MEMORY_MIGRATION_VERSION);
    if (!hasLingMemoryMigration || !this.hasTable("memory_objects") || !this.hasTable("memory_used_events")) {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS memory_objects (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          source_refs_json TEXT NOT NULL,
          review_state TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          sensitivity TEXT NOT NULL,
          retrieval_provider_id TEXT,
          retrieval_handle TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_objects_scope
        ON memory_objects(workspace_id, scope_type, owner_id, review_state, enabled);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_updated
        ON memory_objects(workspace_id, updated_at);

        CREATE INDEX IF NOT EXISTS idx_memory_objects_last_used
        ON memory_objects(workspace_id, last_used_at);

        CREATE TABLE IF NOT EXISTS memory_used_events (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          memory_ids_json TEXT NOT NULL,
          intent TEXT NOT NULL,
          recall_query TEXT NOT NULL,
          teammate_id TEXT,
          channel_id TEXT,
          task_id TEXT,
          run_id TEXT,
          response_id TEXT,
          policy_version TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_run
        ON memory_used_events(workspace_id, run_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_response
        ON memory_used_events(workspace_id, response_id, created_at);

        CREATE INDEX IF NOT EXISTS idx_memory_used_events_teammate_channel
        ON memory_used_events(workspace_id, teammate_id, channel_id, created_at);
      `);

      if (!hasLingMemoryMigration) {
        this.recordMigration(LING_MEMORY_MIGRATION_VERSION, LING_MEMORY_MIGRATION_NAME);
      }
    }

    const hasSkillAwareRunMigration = this.hasMigration(SKILL_AWARE_RUN_MIGRATION_VERSION);
    if (
      !hasSkillAwareRunMigration ||
      !this.hasColumn("tasks", "requested_skill_id") ||
      !this.hasColumn("run_sessions", "selected_skill_id")
    ) {
      if (!this.hasColumn("tasks", "requested_skill_id")) {
        this.database.exec("ALTER TABLE tasks ADD COLUMN requested_skill_id TEXT;");
      }
      if (!this.hasColumn("run_sessions", "selected_skill_id")) {
        this.database.exec("ALTER TABLE run_sessions ADD COLUMN selected_skill_id TEXT;");
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_requested_skill
        ON tasks(requested_skill_id);

        CREATE INDEX IF NOT EXISTS idx_run_sessions_selected_skill
        ON run_sessions(selected_skill_id);
      `);
      if (!hasSkillAwareRunMigration) {
        this.recordMigration(SKILL_AWARE_RUN_MIGRATION_VERSION, SKILL_AWARE_RUN_MIGRATION_NAME);
      }
    }
  }

  private ensureDefaultWorkspace(): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO workspaces (id, name, default_provider_preset_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `)
      .run(DEFAULT_WORKSPACE_ID, "Default Workspace", null, now, now);
  }

  private ensureDefaultApprovalPolicy(): void {
    const now = new Date().toISOString();
    const policy = createDefaultApprovalPolicy(DEFAULT_WORKSPACE_ID, now);
    this.database
      .prepare(`
        INSERT INTO approval_policies (
          workspace_id,
          tool_decisions_json,
          allowed_write_paths_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO NOTHING
      `)
      .run(
        policy.workspaceId,
        stringifyJson(policy.toolDecisions),
        stringifyJson(policy.allowedWritePaths),
        policy.createdAt,
        policy.updatedAt,
      );
  }

  private ensureDefaultAiTeammates(): void {
    if (!this.hasTable("ai_teammates")) {
      return;
    }
    const now = new Date().toISOString();
    for (const template of listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID)) {
      const teammateId = createBuiltinAiTeammateId(template.id);
      const existing = this.getAiTeammate(teammateId);
      if (existing) {
        if (this.listTeammateSkillBindings(teammateId).length === 0) {
          this.replaceTeammateSkillBindings(
            teammateId,
            template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
            now,
          );
        }
        this.database
          .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
          .run(teammateId, now, template.id);
        this.database
          .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
          .run(teammateId, now, template.id);
        continue;
      }

      this.createAiTeammate(
        {
          id: teammateId,
          templateId: template.id,
          roleKey: template.roleKey,
          displayName: template.name,
          description: template.summary,
          systemPrompt: template.systemPrompt,
          allowedTools: template.allowedTools,
          approvalProfile: template.approvalProfile,
          status: "active",
          pinned: template.id === "engineer" || template.id === "designer",
          hidden: false,
        },
        now,
      );
      this.replaceTeammateSkillBindings(
        teammateId,
        template.defaultSkillIds.map((skillId) => ({ skillId, source: "template", enabled: true })),
        now,
      );
      this.database
        .prepare("UPDATE channels SET default_teammate_id = ?, updated_at = ? WHERE default_teammate_id = ?")
        .run(teammateId, now, template.id);
      this.database
        .prepare("UPDATE tasks SET assignee_teammate_id = ?, updated_at = ? WHERE assignee_teammate_id = ?")
        .run(teammateId, now, template.id);
    }
  }

  private hasMigration(version: number): boolean {
    return Boolean(this.database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version));
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    return this.database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all()
      .some((row) => readString(row, "name") === columnName);
  }

  private hasTable(tableName: string): boolean {
    return Boolean(
      this.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName),
    );
  }

  private recordMigration(version: number, name: string): void {
    this.database
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(version, name, new Date().toISOString());
  }

  private nextEventSeq(runId: string): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM run_events WHERE run_id = ?").get(runId);
    return readNumber(row, "next_seq");
  }

  private nextRuntimeEventSeq(workUnitId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM runtime_events WHERE work_unit_id = ?")
      .get(workUnitId);
    return readNumber(row, "next_seq");
  }

  private hasTerminalEvent(runId: string): boolean {
    const row = this.database
      .prepare("SELECT 1 AS found FROM run_events WHERE run_id = ? AND type IN ('run_end', 'run_error', 'run_cancelled', 'result') LIMIT 1")
      .get(runId);
    return Boolean(row);
  }

  private assertChannelExists(channelId: string): void {
    if (!this.getChannel(channelId)) {
      throw new Error(`Channel not found: ${channelId}`);
    }
  }

  private assertMessageInChannel(channelId: string, messageId: string): void {
    const message = this.getChannelMessage(messageId);
    if (!message) {
      throw new Error(`Channel message not found: ${messageId}`);
    }
    if (message.channelId !== channelId) {
      throw new Error(`Message does not belong to channel: ${messageId}`);
    }
  }

  private assertAttachmentInChannel(channelId: string, attachmentId: string): void {
    const attachment = this.getChannelAttachment(attachmentId);
    if (!attachment) {
      throw new Error(`Channel attachment not found: ${attachmentId}`);
    }
    if (attachment.channelId !== channelId) {
      throw new Error(`Attachment does not belong to channel: ${attachmentId}`);
    }
  }

  private assertLinkPreviewInChannel(channelId: string, linkPreviewId: string): void {
    const linkPreview = this.getChannelLinkPreview(linkPreviewId);
    if (!linkPreview) {
      throw new Error(`Channel link preview not found: ${linkPreviewId}`);
    }
    if (linkPreview.channelId !== channelId) {
      throw new Error(`Link preview does not belong to channel: ${linkPreviewId}`);
    }
  }

  private assertTaskInChannel(channelId: string, taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.channelId !== channelId) {
      throw new Error(`Task does not belong to channel: ${taskId}`);
    }
  }

  private assertRunInChannel(channelId: string, runId: string): void {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run session not found: ${runId}`);
    }
    if (run.channelId !== channelId) {
      throw new Error(`Run does not belong to channel: ${runId}`);
    }
  }

  private assertDecisionInChannel(channelId: string, decisionId: string): void {
    const decision = this.getChannelDecision(decisionId);
    if (!decision) {
      throw new Error(`Channel decision not found: ${decisionId}`);
    }
    if (decision.channelId !== channelId) {
      throw new Error(`Decision does not belong to channel: ${decisionId}`);
    }
  }

  private assertHandoffInChannel(channelId: string, handoffId: string): void {
    const handoff = this.getChannelHandoff(handoffId);
    if (!handoff) {
      throw new Error(`Channel handoff not found: ${handoffId}`);
    }
    if (handoff.channelId !== channelId) {
      throw new Error(`Handoff does not belong to channel: ${handoffId}`);
    }
  }

  private assertContextSummaryInChannel(channelId: string, contextSummaryId: string): void {
    const contextSummary = this.getChannelContextSummary(contextSummaryId);
    if (!contextSummary) {
      throw new Error(`Channel context summary not found: ${contextSummaryId}`);
    }
    if (contextSummary.channelId !== channelId) {
      throw new Error(`Context summary does not belong to channel: ${contextSummaryId}`);
    }
  }

  private assertSourceRefsInChannel(
    channelId: string,
    input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
  ): void {
    if (input.sourceMessageId) {
      this.assertMessageInChannel(channelId, input.sourceMessageId);
    }
    if (input.sourceTaskId) {
      this.assertTaskInChannel(channelId, input.sourceTaskId);
    }
    if (input.sourceRunId) {
      this.assertRunInChannel(channelId, input.sourceRunId);
    }
  }

  private assertSummaryTargetInChannel(
    channelId: string,
    targetType: ChannelContextSummaryTargetType,
    targetId: string,
  ): void {
    if (targetType === "task") {
      this.assertTaskInChannel(channelId, targetId);
      return;
    }
    const directMessage = this.getChannelMessage(targetId);
    if (directMessage) {
      if (directMessage.channelId !== channelId) {
        throw new Error(`Summary target does not belong to channel: ${targetId}`);
      }
      return;
    }
    const threadMessage = this.database
      .prepare("SELECT id FROM channel_messages WHERE channel_id = ? AND thread_id = ? LIMIT 1")
      .get(channelId, targetId);
    if (!threadMessage) {
      throw new Error(`Channel thread not found: ${targetId}`);
    }
  }

  private nextWorkflowStepPosition(workflowId: string): number {
    const row = this.database
      .prepare("SELECT COALESCE(MAX(position), 0) + 1 AS next_position FROM channel_workflow_steps WHERE workflow_id = ?")
      .get(workflowId);
    return readNumber(row, "next_position");
  }

  private updateRunStatus(
    runId: string,
    status: RunStatus,
    startedAt: string | undefined,
    endedAt: string | null | undefined,
    errorMessage: string | null | undefined,
    summaryPath: string | undefined,
    updatedAt: string,
  ): void {
    const existing = this.getRun(runId);
    if (!existing) {
      throw new Error(`Run session not found: ${runId}`);
    }

    this.database
      .prepare(
        `
          UPDATE run_sessions
          SET
            status = ?,
            started_at = ?,
            ended_at = ?,
            error_message = ?,
            summary_path = ?,
            updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        status,
        startedAt ?? existing.startedAt ?? null,
        endedAt === undefined ? existing.endedAt ?? null : endedAt,
        errorMessage === undefined ? existing.errorMessage ?? null : errorMessage,
        summaryPath ?? existing.summaryPath ?? null,
        updatedAt,
        runId,
      );
  }
}

export function createSqliteRunStore(cwd: string): SqliteRunStore {
  return new SqliteRunStore({ cwd });
}

function mapRunSession(row: Record<string, SQLOutputValue>): RunSession {
  return omitUndefined({
    id: readString(row, "id"),
    status: readString(row, "status") as RunStatus,
    cwd: readString(row, "cwd"),
    taskId: readString(row, "task_id"),
    channelId: readNullableString(row, "channel_id"),
    teammateId: readNullableString(row, "teammate_id"),
    selectedSkillId: readNullableString(row, "selected_skill_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    taskSnapshot: parseJson(readString(row, "task_snapshot_json")),
    providerSnapshot: parseJson(readString(row, "provider_snapshot_json")),
    requestSnapshot: parseJson(readString(row, "request_snapshot_json")),
    eventLogPath: readString(row, "event_log_path"),
    workUnitId: readNullableString(row, "work_unit_id"),
    summaryPath: readNullableString(row, "summary_path"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapRunEvent(row: Record<string, SQLOutputValue>): RunEventEnvelope {
  return {
    id: readString(row, "id"),
    runId: readString(row, "run_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RunEventType,
    data: parseJson(readString(row, "data_json")),
  };
}

function mapChannel(row: Record<string, SQLOutputValue>): Channel {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    name: readString(row, "name"),
    status: readString(row, "status") as ChannelStatus,
    boundPath: readNullableString(row, "bound_path"),
    defaultProviderPresetId: readNullableString(row, "default_provider_preset_id"),
    defaultTeammateId: readNullableString(row, "default_teammate_id"),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    runtimePolicy: parseChannelRuntimePolicy(readString(row, "runtime_policy_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTask(row: Record<string, SQLOutputValue>): Task {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    status: readString(row, "status") as TaskStatus,
    assigneeTeammateId: readNullableString(row, "assignee_teammate_id"),
    requestedSkillId: readNullableString(row, "requested_skill_id"),
    currentRunId: readNullableString(row, "current_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapAiTeammate(row: Record<string, SQLOutputValue>): AiTeammate {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    templateId: readNullableString(row, "template_id"),
    roleKey: readString(row, "role_key") as AiTeammateRoleKey,
    displayName: readString(row, "display_name"),
    description: readString(row, "description"),
    avatarTone: readNullableString(row, "avatar_tone"),
    avatarImageAttachmentId: readNullableString(row, "avatar_image_attachment_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    systemPrompt: readNullableString(row, "system_prompt"),
    appendSystemPrompt: parseJsonStringArray(readString(row, "append_system_prompt_json")),
    allowedTools: parseJsonStringArray(readString(row, "allowed_tools_json")) as RunTool[],
    approvalProfile: parseApprovalProfile(readString(row, "approval_profile_json")),
    status: readString(row, "status") as AiTeammateStatus,
    pinned: readBoolean(row, "pinned"),
    hidden: readBoolean(row, "hidden"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTeammateChannelMembership(row: Record<string, SQLOutputValue>): TeammateChannelMembership {
  return {
    teammateId: readString(row, "teammate_id"),
    channelId: readString(row, "channel_id"),
    isDefault: readBoolean(row, "is_default"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapTeammateSkillBinding(row: Record<string, SQLOutputValue>): TeammateSkillBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    skillId: readString(row, "skill_id"),
    source: readString(row, "source") as TeammateSkillBindingSource,
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapTeammateMemoryScope(row: Record<string, SQLOutputValue>): TeammateMemoryScope {
  return omitUndefined({
    id: readString(row, "id"),
    teammateId: readString(row, "teammate_id"),
    kind: readString(row, "kind") as TeammateMemoryScopeKind,
    channelId: readNullableString(row, "channel_id"),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMemoryObject(row: Record<string, SQLOutputValue>): MemoryObject {
  const id = readString(row, "id");
  return omitUndefined({
    id,
    workspaceId: readString(row, "workspace_id"),
    scopeType: readString(row, "scope_type") as MemoryScopeType,
    ownerId: readString(row, "owner_id"),
    title: readString(row, "title"),
    body: readString(row, "body"),
    tags: parseJsonStringArray(readString(row, "tags_json")),
    sourceRefs: ensureMemorySourceRefs(id, parseMemorySourceRefs(readString(row, "source_refs_json"))),
    reviewState: readString(row, "review_state") as MemoryReviewState,
    enabled: readBoolean(row, "enabled"),
    sensitivity: readString(row, "sensitivity") as MemorySensitivity,
    retrievalProviderId: readNullableString(row, "retrieval_provider_id"),
    retrievalHandle: readNullableString(row, "retrieval_handle"),
    createdBy: readNullableString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    lastUsedAt: readNullableString(row, "last_used_at"),
  });
}

function mapUsedMemoryEvent(row: Record<string, SQLOutputValue>): UsedMemoryEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    memoryIds: parseJsonStringArray(readString(row, "memory_ids_json")),
    intent: readString(row, "intent") as UsedMemoryEvent["intent"],
    recallQuery: readString(row, "recall_query"),
    teammateId: readNullableString(row, "teammate_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    responseId: readNullableString(row, "response_id"),
    policyVersion: readString(row, "policy_version"),
    createdAt: readString(row, "created_at"),
  });
}

function mapTeammateDirectThread(row: Record<string, SQLOutputValue>): TeammateDirectThread {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    title: readString(row, "title"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapTeammateDirectMessage(row: Record<string, SQLOutputValue>): TeammateDirectMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    threadId: readString(row, "thread_id"),
    teammateId: readString(row, "teammate_id"),
    authorType: readString(row, "author_type") as TeammateDirectMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    status: readString(row, "status") as TeammateDirectMessageStatus,
    errorMessage: readNullableString(row, "error_message"),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelMessage(row: Record<string, SQLOutputValue>): ChannelMessage {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    threadId: readNullableString(row, "thread_id"),
    kind: readString(row, "kind") as ChannelMessageKind,
    intent: readString(row, "intent") as ChannelMessageIntent,
    authorType: readString(row, "author_type") as ChannelMessageAuthorType,
    authorId: readNullableString(row, "author_id"),
    body: readString(row, "body"),
    mentions: parseChannelMentions(readString(row, "mentions_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    status: readString(row, "status") as ChannelMessage["status"],
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelExecutionProposal(row: Record<string, SQLOutputValue>): ChannelExecutionProposal {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readString(row, "source_message_id"),
    proposedByTeammateId: readString(row, "proposed_by_teammate_id"),
    title: readString(row, "title"),
    prompt: readString(row, "prompt"),
    assigneeTeammateId: readString(row, "assignee_teammate_id"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    collaborationSteps: parseChannelExecutionProposalSteps(readString(row, "collaboration_steps_json")),
    requiredTools: parseJsonStringArray(readString(row, "required_tools_json")) as ChannelExecutionProposal["requiredTools"],
    riskSummary: readNullableString(row, "risk_summary"),
    status: readString(row, "status") as ChannelExecutionProposalStatus,
    linkedTaskId: readNullableString(row, "linked_task_id"),
    linkedRunId: readNullableString(row, "linked_run_id"),
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelAttachment(row: Record<string, SQLOutputValue>): ChannelAttachment {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    kind: readString(row, "kind") as ChannelAttachmentKind,
    fileName: readString(row, "file_name"),
    contentType: readString(row, "content_type"),
    sizeBytes: readNumber(row, "size_bytes"),
    path: readString(row, "path"),
    createdAt: readString(row, "created_at"),
  });
}

function mapChannelLinkPreview(row: Record<string, SQLOutputValue>): ChannelLinkPreview {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    messageId: readNullableString(row, "message_id"),
    url: readString(row, "url"),
    normalizedUrl: readString(row, "normalized_url"),
    title: readNullableString(row, "title"),
    description: readNullableString(row, "description"),
    imageUrl: readNullableString(row, "image_url"),
    siteName: readNullableString(row, "site_name"),
    status: readString(row, "status") as ChannelLinkPreviewStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelBrief(row: Record<string, SQLOutputValue>): ChannelBrief {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    objective: readString(row, "objective"),
    scope: readString(row, "scope"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    risks: parseJsonStringArray(readString(row, "risks_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    attachmentIds: parseJsonStringArray(readString(row, "attachment_ids_json")),
    linkPreviewIds: parseJsonStringArray(readString(row, "link_preview_ids_json")),
    updatedBy: readString(row, "updated_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapChannelDecision(row: Record<string, SQLOutputValue>): ChannelDecision {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    title: readString(row, "title"),
    decision: readString(row, "decision"),
    rationale: readString(row, "rationale"),
    alternatives: parseJsonStringArray(readString(row, "alternatives_json")),
    status: readString(row, "status") as ChannelDecisionStatus,
    supersedesDecisionId: readNullableString(row, "supersedes_decision_id"),
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelHandoff(row: Record<string, SQLOutputValue>): ChannelHandoff {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceMessageId: readNullableString(row, "source_message_id"),
    sourceTaskId: readNullableString(row, "source_task_id"),
    sourceRunId: readNullableString(row, "source_run_id"),
    fromParticipantId: readString(row, "from_participant_id"),
    fromParticipantLabel: readString(row, "from_participant_label"),
    toParticipantId: readString(row, "to_participant_id"),
    toParticipantLabel: readString(row, "to_participant_label"),
    reason: readString(row, "reason"),
    requiredInput: readString(row, "required_input"),
    expectedOutput: readString(row, "expected_output"),
    status: readString(row, "status") as ChannelHandoffStatus,
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelContextSummary(row: Record<string, SQLOutputValue>): ChannelContextSummary {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    targetType: readString(row, "target_type") as ChannelContextSummaryTargetType,
    targetId: readString(row, "target_id"),
    sourceMessageIds: parseJsonStringArray(readString(row, "source_message_ids_json")),
    decisionIds: parseJsonStringArray(readString(row, "decision_ids_json")),
    summary: readString(row, "summary"),
    acceptanceCriteria: parseJsonStringArray(readString(row, "acceptance_criteria_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    authorType: readString(row, "author_type") as ChannelContextSummaryAuthorType,
    authorId: readNullableString(row, "author_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelWorkflow(row: Record<string, SQLOutputValue>): ChannelWorkflow {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceHandoffId: readNullableString(row, "source_handoff_id"),
    title: readString(row, "title"),
    objective: readString(row, "objective"),
    status: readString(row, "status") as ChannelWorkflowStatus,
    createdBy: readString(row, "created_by"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapChannelWorkflowStep(row: Record<string, SQLOutputValue>): ChannelWorkflowStep {
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
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapProviderPreset(row: Record<string, SQLOutputValue>): ProviderPreset {
  return omitUndefined({
    id: readString(row, "id"),
    kind: readString(row, "kind") as ProviderPreset["kind"],
    displayName: readString(row, "display_name"),
    providerId: readString(row, "provider_id"),
    model: readString(row, "model"),
    api: readString(row, "api") as ProviderPreset["api"],
    baseUrl: readNullableString(row, "base_url"),
    apiKeyRef: readNullableString(row, "api_key_ref"),
    headers: parseJsonStringRecord(readString(row, "headers_json")),
    authHeader: readNullableBoolean(row, "auth_header"),
    reasoning: readNullableBoolean(row, "reasoning"),
    input: parseJsonStringArray(readString(row, "input_json")) as ProviderPreset["input"],
    contextWindow: readNullableNumber(row, "context_window"),
    maxTokens: readNullableNumber(row, "max_tokens"),
    compat: parseJsonObject(readString(row, "compat_json")),
    capabilities: parseJsonStringArray(readString(row, "capabilities_json")) as ProviderPreset["capabilities"],
    enabled: readBoolean(row, "enabled"),
    lastCheck: parseProviderCheckResult(readNullableString(row, "last_check_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMcpServer(row: Record<string, SQLOutputValue>): McpServer {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    displayName: readString(row, "display_name"),
    transport: parseMcpServerTransport(readString(row, "transport_json")),
    enabled: readBoolean(row, "enabled"),
    required: readBoolean(row, "required"),
    status: parseMcpServerStatus(readString(row, "status_json")),
    startupTimeoutSec: readNullableNumber(row, "startup_timeout_sec"),
    toolTimeoutSec: readNullableNumber(row, "tool_timeout_sec"),
    enabledTools: parseNullableJsonStringArray(readNullableString(row, "enabled_tools_json")),
    disabledTools: parseJsonStringArray(readString(row, "disabled_tools_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMcpTool(row: Record<string, SQLOutputValue>): McpTool {
  return omitUndefined({
    serverId: readString(row, "server_id"),
    rawName: readString(row, "raw_name"),
    displayName: readString(row, "display_name"),
    description: readNullableString(row, "description"),
    inputSchema: parseJson(readString(row, "input_schema_json")),
    callableNamespace: readString(row, "callable_namespace"),
    callableName: readString(row, "callable_name"),
    sideEffectLevel: readString(row, "side_effect_level") as McpTool["sideEffectLevel"],
    defaultApproval: readString(row, "default_approval") as McpTool["defaultApproval"],
    enabled: readBoolean(row, "enabled"),
    firstSeenAt: readString(row, "first_seen_at"),
    lastSeenAt: readString(row, "last_seen_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapTeammateMcpBinding(row: Record<string, SQLOutputValue>): TeammateMcpBinding {
  return {
    teammateId: readString(row, "teammate_id"),
    serverId: readString(row, "server_id"),
    mode: readString(row, "mode") as TeammateMcpBinding["mode"],
    selectedToolNames: parseJsonStringArray(readString(row, "selected_tool_names_json")),
    approvalOverrides: parseMcpApprovalOverrides(readString(row, "approval_overrides_json")),
    enabled: readBoolean(row, "enabled"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapApprovalRequest(row: Record<string, SQLOutputValue>): ApprovalRequest {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    taskId: readNullableString(row, "task_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkActionId: readNullableString(row, "external_work_action_id"),
    channelId: readNullableString(row, "channel_id"),
    toolCallId: readNullableString(row, "tool_call_id"),
    actionType: readString(row, "action_type") as ApprovalRequest["actionType"],
    risk: readString(row, "risk") as ApprovalRequest["risk"],
    title: readString(row, "title"),
    description: readString(row, "description"),
    payload: parseJsonObject(readString(row, "payload_json")) as ApprovalRequest["payload"],
    status: readString(row, "status") as ApprovalStatus,
    createdAt: readString(row, "created_at"),
    expiresAt: readNullableString(row, "expires_at"),
    resolvedAt: readNullableString(row, "resolved_at"),
    resolvedBy: readNullableString(row, "resolved_by") as ApprovalRequest["resolvedBy"],
    decisionReason: readNullableString(row, "decision_reason"),
  });
}

function mapApprovalPolicy(row: Record<string, SQLOutputValue>): ApprovalPolicy {
  return {
    workspaceId: readString(row, "workspace_id"),
    toolDecisions: parseApprovalToolDecisions(readString(row, "tool_decisions_json")),
    allowedWritePaths: parseJsonStringArray(readString(row, "allowed_write_paths_json")),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function normalizeOptionalOwnerId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function labelForParticipant(participantId: string): string {
  if (participantId === "engineer" || participantId === "teammate_builtin_engineer") {
    return "Engineer";
  }
  return participantId;
}

function mapArtifact(row: Record<string, SQLOutputValue>): RunArtifact {
  return omitUndefined({
    id: readString(row, "id"),
    runId: readNullableString(row, "run_id"),
    mediaJobId: readNullableString(row, "media_job_id"),
    externalWorkId: readNullableString(row, "external_work_id"),
    type: readString(row, "type") as ArtifactType,
    path: readString(row, "path"),
    title: readNullableString(row, "title"),
    contentType: readNullableString(row, "content_type"),
    sizeBytes: readNullableNumber(row, "size_bytes"),
    createdAt: readString(row, "created_at"),
  });
}

function mapExternalWorkRecord(row: Record<string, SQLOutputValue>): ExternalWorkRecord {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkRecord["sourceKind"],
    workItemKind: readString(row, "work_item_kind") as ExternalWorkRecord["workItemKind"],
    externalId: readString(row, "external_id"),
    identifier: readString(row, "identifier"),
    idempotencyKey: readString(row, "idempotency_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    item: parseJsonObject(readString(row, "item_json")) as unknown as ExternalWorkItem,
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  };
}

function mapExternalWorkSchedulerState(row: Record<string, SQLOutputValue>): ExternalWorkSchedulerState {
  return omitUndefined({
    externalWorkId: readString(row, "external_work_id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    subjectKey: readString(row, "subject_key"),
    sourceKey: readString(row, "source_key"),
    workflowId: readString(row, "workflow_id"),
    workflowStepId: readString(row, "workflow_step_id"),
    schedulerStatus: readString(row, "scheduler_status") as ExternalWorkSchedulerState["schedulerStatus"],
    attemptCount: readNumber(row, "attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    maxRetryBackoffMs: readNumber(row, "max_retry_backoff_ms"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    workspacePath: readNullableString(row, "workspace_path"),
    workspaceMode: readNullableString(row, "workspace_mode") as ExternalWorkSchedulerState["workspaceMode"],
    hookArtifactIds: parseJsonStringArray(readString(row, "hook_artifact_ids_json")),
    lastReconciledAt: readNullableString(row, "last_reconciled_at"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapExternalWorkAction(row: Record<string, SQLOutputValue>): ExternalWorkAction {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkAction["sourceKind"],
    actionKind: readString(row, "action_kind") as ExternalWorkAction["actionKind"],
    status: readString(row, "status") as ExternalWorkAction["status"],
    approvalId: readNullableString(row, "approval_id"),
    idempotencyKey: readString(row, "idempotency_key"),
    target: parseJsonObject(readString(row, "target_json")) as unknown as ExternalWorkAction["target"],
    payload: parseJsonObject(readString(row, "payload_json")) as unknown as ExternalWorkAction["payload"],
    approvalRequirement: readString(row, "approval_requirement") as ExternalWorkAction["approvalRequirement"],
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    executionAttemptCount: readNumber(row, "execution_attempt_count"),
    lastAttemptAt: readNullableString(row, "last_attempt_at"),
    nextAttemptAt: readNullableString(row, "next_attempt_at"),
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    executedAt: readNullableString(row, "executed_at"),
  });
}

function mapExternalWorkCiTriage(row: Record<string, SQLOutputValue>): ExternalWorkCiTriageRecord {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    channelId: readString(row, "channel_id"),
    externalWorkId: readString(row, "external_work_id"),
    sourceKind: readString(row, "source_kind") as ExternalWorkCiTriageRecord["sourceKind"],
    repository: readString(row, "repository"),
    subjectKind: readString(row, "subject_kind") as ExternalWorkCiTriageRecord["subjectKind"],
    subjectNumber: readNumber(row, "subject_number"),
    headSha: readString(row, "head_sha"),
    failureKey: readString(row, "failure_key"),
    status: readString(row, "status") as ExternalWorkCiTriageRecord["status"],
    checkName: readString(row, "check_name"),
    workflowName: readNullableString(row, "workflow_name"),
    jobName: readNullableString(row, "job_name"),
    conclusion: readString(row, "conclusion") as ExternalWorkCiTriageRecord["conclusion"],
    htmlUrl: readNullableString(row, "html_url"),
    firstFailingCommand: readNullableString(row, "first_failing_command"),
    reproductionCommand: readNullableString(row, "reproduction_command"),
    suspectedSourcePath: readNullableString(row, "suspected_source_path"),
    taskId: readNullableString(row, "task_id"),
    runId: readNullableString(row, "run_id"),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    failure: parseJsonObject(readString(row, "failure_json")) as unknown as ExternalWorkCiTriageRecord["failure"],
    lastErrorCode: readNullableString(row, "last_error_code"),
    lastErrorMessage: readNullableString(row, "last_error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapMediaJob(row: Record<string, SQLOutputValue>): MediaJob {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    providerPresetId: readString(row, "provider_preset_id"),
    operation: readString(row, "operation") as MediaJob["operation"],
    prompt: readString(row, "prompt"),
    input: parseJsonObject(readString(row, "input_json")),
    artifactIds: parseJsonStringArray(readString(row, "artifact_ids_json")),
    status: readString(row, "status") as MediaJobStatus,
    errorMessage: readNullableString(row, "error_message"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapStateTransitionEvent(row: Record<string, SQLOutputValue>): StateTransitionEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    entityType: readString(row, "entity_type") as StateEntityType,
    entityId: readString(row, "entity_id"),
    fromStatus: readString(row, "from_status"),
    toStatus: readString(row, "to_status"),
    event: readString(row, "event"),
    actor: readString(row, "actor") as StateTransitionActor,
    reason: readNullableString(row, "reason"),
    idempotencyKey: readNullableString(row, "idempotency_key"),
    createdAt: readString(row, "created_at"),
  });
}

function mapWorkUnit(row: Record<string, SQLOutputValue>): WorkUnit {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    kind: readString(row, "kind") as WorkUnitKind,
    ownerType: readString(row, "owner_type"),
    ownerId: readString(row, "owner_id"),
    channelId: readNullableString(row, "channel_id"),
    taskId: readNullableString(row, "task_id"),
    teammateId: readNullableString(row, "teammate_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    runnerId: readNullableString(row, "runner_id"),
    idempotencyKey: readString(row, "idempotency_key"),
    status: readString(row, "status") as WorkUnitStatus,
    priority: readNumber(row, "priority"),
    attemptCount: readNumber(row, "attempt_count"),
    activeAttemptId: readNullableString(row, "active_attempt_id"),
    createdByClientId: readNullableString(row, "created_by_client_id"),
    createdByActor: readString(row, "created_by_actor") as WorkUnit["createdByActor"],
    request: parseJson(readString(row, "request_json")),
    timeoutPolicy: parseRuntimeTimeoutPolicy(readString(row, "timeout_policy_json")),
    linkedRunId: readNullableString(row, "linked_run_id"),
    linkedMessageId: readNullableString(row, "linked_message_id"),
    linkedMediaJobId: readNullableString(row, "linked_media_job_id"),
    linkedExternalWorkId: readNullableString(row, "linked_external_work_id"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function mapWorkUnitAttempt(row: Record<string, SQLOutputValue>): WorkUnitAttempt {
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptNumber: readNumber(row, "attempt_number"),
    runtimeInstanceId: readString(row, "runtime_instance_id"),
    runnerId: readString(row, "runner_id"),
    providerPresetId: readNullableString(row, "provider_preset_id"),
    status: readString(row, "status") as WorkUnitAttemptStatus,
    createdAt: readString(row, "created_at"),
    startedAt: readNullableString(row, "started_at"),
    endedAt: readNullableString(row, "ended_at"),
    lastEventAt: readNullableString(row, "last_event_at"),
    lastHeartbeatAt: readNullableString(row, "last_heartbeat_at"),
    abortRequestedAt: readNullableString(row, "abort_requested_at"),
    errorCode: readNullableString(row, "error_code"),
    errorMessage: readNullableString(row, "error_message"),
  });
}

function mapRuntimeEvent(row: Record<string, SQLOutputValue>): RuntimeEvent {
  return omitUndefined({
    id: readString(row, "id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
    seq: readNumber(row, "seq"),
    ts: readString(row, "ts"),
    type: readString(row, "type") as RuntimeEventType,
    actor: readString(row, "actor") as RuntimeEvent["actor"],
    data: parseJson(readString(row, "data_json")),
  });
}

function mapRuntimeSemaphoreSlot(row: Record<string, SQLOutputValue>): RuntimeSemaphoreSlot {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as RuntimeSemaphoreResourceType,
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as RuntimeSemaphoreSlot["ownerType"],
    ownerId: readString(row, "owner_id"),
    workUnitId: readString(row, "work_unit_id"),
    attemptId: readString(row, "attempt_id"),
    status: readString(row, "status") as RuntimeSemaphoreSlotStatus,
    acquiredAt: readString(row, "acquired_at"),
    lastRenewedAt: readString(row, "last_renewed_at"),
    expiresAt: readString(row, "expires_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
  });
}

function mapResourceLease(row: Record<string, SQLOutputValue>): ResourceLease {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    resourceType: readString(row, "resource_type") as ResourceLease["resourceType"],
    resourceKey: readString(row, "resource_key"),
    ownerType: readString(row, "owner_type") as ResourceLease["ownerType"],
    ownerId: readString(row, "owner_id"),
    status: readString(row, "status") as ResourceLeaseStatus,
    acquiredAt: readString(row, "acquired_at"),
    expiresAt: readString(row, "expires_at"),
    lastRenewedAt: readNullableString(row, "last_renewed_at"),
    releasedAt: readNullableString(row, "released_at"),
    releaseReason: readNullableString(row, "release_reason"),
    workUnitId: readNullableString(row, "work_unit_id"),
    attemptId: readNullableString(row, "attempt_id"),
  });
}

function parseApprovalToolDecisions(value: string): ApprovalToolDecisions {
  const parsed = parseJsonObject(value);
  const decisions: Record<RunTool, ApprovalToolDecision> = { ...defaultApprovalToolDecisions };
  for (const tool of Object.keys(defaultApprovalToolDecisions) as RunTool[]) {
    const decision = parsed[tool];
    if (decision === "allow" || decision === "ask" || decision === "deny") {
      decisions[tool] = decision;
    }
  }
  return decisions;
}

function parseChannelRuntimePolicy(value: string): ChannelRuntimePolicy {
  const parsed = parseJsonObject(value);
  return normalizeChannelRuntimePolicy({
    maxConcurrentRuns: typeof parsed.maxConcurrentRuns === "number" ? parsed.maxConcurrentRuns : undefined,
    executionMode: parsed.executionMode === "parallel" ? "parallel" : parsed.executionMode === "serial" ? "serial" : undefined,
    writeLockScope:
      parsed.writeLockScope === "channel" || parsed.writeLockScope === "boundPath" || parsed.writeLockScope === "workspace"
        ? parsed.writeLockScope
        : undefined,
    allowReadOnlyParallel: typeof parsed.allowReadOnlyParallel === "boolean" ? parsed.allowReadOnlyParallel : undefined,
    queueOnConflict: typeof parsed.queueOnConflict === "boolean" ? parsed.queueOnConflict : undefined,
  });
}

function parseRuntimeTimeoutPolicy(value: string): RuntimeTimeoutPolicy {
  try {
    const parsed = parseJsonObject(value);
    return {
      heartbeatIntervalMs: readRuntimePolicyNumber(parsed.heartbeatIntervalMs, defaultRuntimeTimeoutPolicy.heartbeatIntervalMs),
      heartbeatTimeoutMs: readRuntimePolicyNumber(parsed.heartbeatTimeoutMs, defaultRuntimeTimeoutPolicy.heartbeatTimeoutMs),
      idleTimeoutMs: readRuntimePolicyNumber(parsed.idleTimeoutMs, defaultRuntimeTimeoutPolicy.idleTimeoutMs),
      hardTimeoutMs: readRuntimePolicyNumber(parsed.hardTimeoutMs, defaultRuntimeTimeoutPolicy.hardTimeoutMs),
      cancelGraceMs: readRuntimePolicyNumber(parsed.cancelGraceMs, defaultRuntimeTimeoutPolicy.cancelGraceMs),
    };
  } catch {
    return defaultRuntimeTimeoutPolicy;
  }
}

function readRuntimePolicyNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function channelSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      name,
      status,
      bound_path,
      default_provider_preset_id,
      default_teammate_id,
      allowed_tools_json,
      runtime_policy_json,
      created_at,
      updated_at
    FROM channels
    ${whereClause}
  `;
}

function stateTransitionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      entity_type,
      entity_id,
      from_status,
      to_status,
      event,
      actor,
      reason,
      idempotency_key,
      created_at
    FROM state_transition_events
    ${whereClause}
  `;
}

function resourceLeaseSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      status,
      acquired_at,
      expires_at,
      last_renewed_at,
      released_at,
      release_reason,
      work_unit_id,
      attempt_id
    FROM resource_leases
    ${whereClause}
  `;
}

function workUnitSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      kind,
      owner_type,
      owner_id,
      channel_id,
      task_id,
      teammate_id,
      provider_preset_id,
      runner_id,
      idempotency_key,
      status,
      priority,
      attempt_count,
      active_attempt_id,
      created_by_client_id,
      created_by_actor,
      request_json,
      timeout_policy_json,
      linked_run_id,
      linked_message_id,
      linked_media_job_id,
      linked_external_work_id,
      created_at,
      updated_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      error_code,
      error_message
    FROM work_units
    ${whereClause}
  `;
}

function workUnitAttemptSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_number,
      runtime_instance_id,
      runner_id,
      provider_preset_id,
      status,
      created_at,
      started_at,
      ended_at,
      last_event_at,
      last_heartbeat_at,
      abort_requested_at,
      error_code,
      error_message
    FROM work_unit_attempts
    ${whereClause}
  `;
}

function runtimeEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      work_unit_id,
      attempt_id,
      seq,
      ts,
      type,
      actor,
      data_json
    FROM runtime_events
    ${whereClause}
  `;
}

function runtimeSemaphoreSlotSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      resource_type,
      resource_key,
      owner_type,
      owner_id,
      work_unit_id,
      attempt_id,
      status,
      acquired_at,
      last_renewed_at,
      expires_at,
      released_at,
      release_reason
    FROM runtime_semaphore_slots
    ${whereClause}
  `;
}

function taskSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      title,
      prompt,
      status,
      assignee_teammate_id,
      requested_skill_id,
      current_run_id,
      created_at,
      updated_at
    FROM tasks
    ${whereClause}
  `;
}

function aiTeammateSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      template_id,
      role_key,
      display_name,
      description,
      avatar_tone,
      avatar_image_attachment_id,
      provider_preset_id,
      system_prompt,
      append_system_prompt_json,
      allowed_tools_json,
      approval_profile_json,
      status,
      pinned,
      hidden,
      created_at,
      updated_at
    FROM ai_teammates
    ${whereClause}
  `;
}

function teammateChannelMembershipSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      channel_id,
      is_default,
      created_at,
      updated_at
    FROM teammate_channel_memberships
    ${whereClause}
  `;
}

function teammateSkillBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      skill_id,
      source,
      enabled,
      created_at,
      updated_at
    FROM teammate_skill_bindings
    ${whereClause}
  `;
}

function teammateMemoryScopeSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      teammate_id,
      kind,
      channel_id,
      enabled,
      created_at,
      updated_at
    FROM teammate_memory_scopes
    ${whereClause}
  `;
}

function memoryObjectSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      scope_type,
      owner_id,
      title,
      body,
      tags_json,
      source_refs_json,
      review_state,
      enabled,
      sensitivity,
      retrieval_provider_id,
      retrieval_handle,
      created_by,
      created_at,
      updated_at,
      last_used_at
    FROM memory_objects
    ${whereClause}
  `;
}

function memoryUsedEventSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      memory_ids_json,
      intent,
      recall_query,
      teammate_id,
      channel_id,
      task_id,
      run_id,
      response_id,
      policy_version,
      created_at
    FROM memory_used_events
    ${whereClause}
  `;
}

function teammateDirectThreadSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      teammate_id,
      title,
      created_at,
      updated_at
    FROM teammate_direct_threads
    ${whereClause}
  `;
}

function teammateDirectMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      thread_id,
      teammate_id,
      author_type,
      author_id,
      body,
      status,
      error_message,
      linked_task_id,
      linked_run_id,
      created_at,
      updated_at
    FROM teammate_direct_messages
    ${whereClause}
  `;
}

function channelMessageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      thread_id,
      kind,
      intent,
      author_type,
      author_id,
      body,
      mentions_json,
      attachment_ids_json,
      link_preview_ids_json,
      linked_task_id,
      linked_run_id,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_messages
    ${whereClause}
  `;
}

function channelExecutionProposalSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      proposed_by_teammate_id,
      title,
      prompt,
      assignee_teammate_id,
      acceptance_criteria_json,
      collaboration_steps_json,
      required_tools_json,
      risk_summary,
      status,
      linked_task_id,
      linked_run_id,
      error_message,
      created_at,
      updated_at
    FROM channel_execution_proposals
    ${whereClause}
  `;
}

function channelAttachmentSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      kind,
      file_name,
      content_type,
      size_bytes,
      path,
      created_at
    FROM channel_attachments
    ${whereClause}
  `;
}

function channelLinkPreviewSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      message_id,
      url,
      normalized_url,
      title,
      description,
      image_url,
      site_name,
      status,
      error_message,
      created_at,
      updated_at
    FROM channel_link_previews
    ${whereClause}
  `;
}

function channelBriefSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      objective,
      scope,
      acceptance_criteria_json,
      open_questions_json,
      risks_json,
      decision_ids_json,
      attachment_ids_json,
      link_preview_ids_json,
      updated_by,
      created_at,
      updated_at
    FROM channel_briefs
    ${whereClause}
  `;
}

function channelDecisionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      title,
      decision,
      rationale,
      alternatives_json,
      status,
      supersedes_decision_id,
      created_by,
      created_at,
      updated_at
    FROM channel_decisions
    ${whereClause}
  `;
}

function channelHandoffSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_message_id,
      source_task_id,
      source_run_id,
      from_participant_id,
      from_participant_label,
      to_participant_id,
      to_participant_label,
      reason,
      required_input,
      expected_output,
      status,
      created_by,
      created_at,
      updated_at
    FROM channel_handoffs
    ${whereClause}
  `;
}

function channelContextSummarySelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      target_type,
      target_id,
      source_message_ids_json,
      decision_ids_json,
      summary,
      acceptance_criteria_json,
      open_questions_json,
      author_type,
      author_id,
      created_at,
      updated_at
    FROM channel_context_summaries
    ${whereClause}
  `;
}

function channelWorkflowSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      source_handoff_id,
      title,
      objective,
      status,
      created_by,
      created_at,
      updated_at
    FROM channel_workflows
    ${whereClause}
  `;
}

function channelWorkflowStepSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      workflow_id,
      source_handoff_id,
      context_summary_id,
      task_id,
      run_id,
      position,
      title,
      prompt,
      to_participant_id,
      to_participant_label,
      status,
      blocker,
      result_summary,
      created_at,
      updated_at
    FROM channel_workflow_steps
    ${whereClause}
  `;
}

function providerPresetSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      kind,
      display_name,
      provider_id,
      model,
      api,
      base_url,
      api_key_ref,
      headers_json,
      auth_header,
      reasoning,
      input_json,
      context_window,
      max_tokens,
      compat_json,
      capabilities_json,
      enabled,
      last_check_json,
      created_at,
      updated_at
    FROM provider_presets
    ${whereClause}
  `;
}

function approvalRequestSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      task_id,
      media_job_id,
      external_work_action_id,
      channel_id,
      tool_call_id,
      action_type,
      risk,
      title,
      description,
      payload_json,
      status,
      created_at,
      expires_at,
      resolved_at,
      resolved_by,
      decision_reason
    FROM approval_requests
    ${whereClause}
  `;
}

function mcpServerSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      display_name,
      transport_json,
      enabled,
      required,
      status_json,
      startup_timeout_sec,
      tool_timeout_sec,
      enabled_tools_json,
      disabled_tools_json,
      created_at,
      updated_at
    FROM mcp_servers
    ${whereClause}
  `;
}

function mcpToolSelectSql(whereClause: string): string {
  return `
    SELECT
      server_id,
      raw_name,
      display_name,
      description,
      input_schema_json,
      callable_namespace,
      callable_name,
      side_effect_level,
      default_approval,
      enabled,
      first_seen_at,
      last_seen_at,
      updated_at
    FROM mcp_tools
    ${whereClause}
  `;
}

function teammateMcpBindingSelectSql(whereClause: string): string {
  return `
    SELECT
      teammate_id,
      server_id,
      mode,
      selected_tool_names_json,
      approval_overrides_json,
      enabled,
      created_at,
      updated_at
    FROM teammate_mcp_bindings
    ${whereClause}
  `;
}

function approvalPolicySelectSql(whereClause: string): string {
  return `
    SELECT
      workspace_id,
      tool_decisions_json,
      allowed_write_paths_json,
      created_at,
      updated_at
    FROM approval_policies
    ${whereClause}
  `;
}

function artifactSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      run_id,
      media_job_id,
      external_work_id,
      type,
      path,
      title,
      content_type,
      size_bytes,
      created_at
    FROM artifacts
    ${whereClause}
  `;
}

function externalWorkSelectSql(whereClause: string): string {
  return `
    SELECT
      ${externalWorkSelectColumnsFromAlias("")}
    FROM external_work_items
    ${whereClause}
  `;
}

function externalWorkSelectColumnsFromAlias(alias: string): string {
  const prefix = alias ? `${alias}.` : "";
  return `
      ${prefix}id,
      ${prefix}workspace_id,
      ${prefix}channel_id,
      ${prefix}source_kind,
      ${prefix}work_item_kind,
      ${prefix}external_id,
      ${prefix}identifier,
      ${prefix}idempotency_key,
      ${prefix}workflow_id,
      ${prefix}workflow_step_id,
      ${prefix}artifact_ids_json,
      ${prefix}item_json,
      ${prefix}created_at,
      ${prefix}updated_at
  `;
}

function externalWorkSchedulerStateSelectSql(whereClause: string): string {
  return `
    SELECT
      external_work_id,
      workspace_id,
      channel_id,
      subject_key,
      source_key,
      workflow_id,
      workflow_step_id,
      scheduler_status,
      attempt_count,
      last_attempt_at,
      next_attempt_at,
      max_retry_backoff_ms,
      last_error_code,
      last_error_message,
      workspace_path,
      workspace_mode,
      hook_artifact_ids_json,
      last_reconciled_at,
      created_at,
      updated_at
    FROM external_work_scheduler_state
    ${whereClause}
  `;
}

function externalWorkActionSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      action_kind,
      status,
      approval_id,
      idempotency_key,
      target_json,
      payload_json,
      approval_requirement,
      artifact_ids_json,
      execution_attempt_count,
      last_attempt_at,
      next_attempt_at,
      last_error_code,
      last_error_message,
      created_at,
      updated_at,
      executed_at
    FROM external_work_actions
    ${whereClause}
  `;
}

function externalWorkCiTriageSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      channel_id,
      external_work_id,
      source_kind,
      repository,
      subject_kind,
      subject_number,
      head_sha,
      failure_key,
      status,
      check_name,
      workflow_name,
      job_name,
      conclusion,
      html_url,
      first_failing_command,
      reproduction_command,
      suspected_source_path,
      task_id,
      run_id,
      artifact_ids_json,
      failure_json,
      last_error_code,
      last_error_message,
      created_at,
      updated_at
    FROM external_work_ci_triage
    ${whereClause}
  `;
}

function mediaJobSelectSql(whereClause: string): string {
  return `
    SELECT
      id,
      workspace_id,
      provider_preset_id,
      operation,
      prompt,
      input_json,
      artifact_ids_json,
      status,
      error_message,
      created_at,
      updated_at
    FROM media_jobs
    ${whereClause}
  `;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected JSON object from SQLite");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  const result: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(parsed)) {
    if (typeof entryValue !== "string") {
      throw new Error("Expected JSON string record from SQLite");
    }
    result[key] = entryValue;
  }
  return result;
}

function parseJsonStringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Expected JSON string array from SQLite");
  }
  return parsed as string[];
}

function parseNullableJsonStringArray(value: string | undefined): string[] | undefined {
  return value ? parseJsonStringArray(value) : undefined;
}

function parseMcpServerTransport(value: string): McpServerTransport {
  return normalizeMcpServerTransport(parseJson(value) as McpServerTransport);
}

function normalizeMcpServerTransport(transport: McpServerTransport): McpServerTransport {
  if (transport.type === "stdio") {
    if (typeof transport.command !== "string" || transport.command.length === 0) {
      throw new Error("Expected MCP stdio command");
    }
    const normalized = omitUndefined({
      type: "stdio",
      command: transport.command,
      args: [...(transport.args ?? [])],
      env: { ...(transport.env ?? {}) },
      cwd: transport.cwd,
      secretEnvNames: [...(transport.secretEnvNames ?? [])],
    });
    return normalized as McpServerTransport;
  }
  if (transport.type === "streamable-http") {
    if (typeof transport.url !== "string" || transport.url.length === 0) {
      throw new Error("Expected MCP streamable HTTP URL");
    }
    const normalized = omitUndefined({
      type: "streamable-http",
      url: transport.url,
      bearerTokenEnvVar: transport.bearerTokenEnvVar,
      headers: { ...(transport.headers ?? {}) },
      envHeaders: { ...(transport.envHeaders ?? {}) },
      secretHeaderNames: [...(transport.secretHeaderNames ?? [])],
      oauthClientId: transport.oauthClientId,
      oauthResource: transport.oauthResource,
    });
    return normalized as McpServerTransport;
  }
  throw new Error("Expected MCP server transport from SQLite");
}

function parseMcpServerStatus(value: string): McpServerStatus {
  const parsed = parseJsonObject(value);
  if (
    parsed.kind !== "unknown" &&
    parsed.kind !== "checking" &&
    parsed.kind !== "ready" &&
    parsed.kind !== "failed" &&
    parsed.kind !== "disabled"
  ) {
    throw new Error("Expected MCP server status kind from SQLite");
  }
  if (parsed.message !== undefined && typeof parsed.message !== "string") {
    throw new Error("Expected MCP server status message from SQLite");
  }
  if (parsed.checkedAt !== undefined && typeof parsed.checkedAt !== "string") {
    throw new Error("Expected MCP server status checkedAt from SQLite");
  }
  return omitUndefined({
    kind: parsed.kind,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as McpServerStatus;
}

function parseMcpApprovalOverrides(value: string): TeammateMcpBinding["approvalOverrides"] {
  const parsed = parseJsonObject(value);
  const result: Record<string, McpTool["defaultApproval"]> = {};
  for (const [toolName, decision] of Object.entries(parsed)) {
    if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
      throw new Error("Expected MCP approval override decision from SQLite");
    }
    result[toolName] = decision;
  }
  return result;
}

function parseChannelMentions(value: string): ChannelMessage["mentions"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel mentions array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.id !== "string" || typeof item.label !== "string") {
      throw new Error("Expected channel mention from SQLite");
    }
    if (item.kind !== "ai-teammate" && item.kind !== "local-user" && item.kind !== "channel") {
      throw new Error("Expected channel mention kind from SQLite");
    }
    return {
      id: item.id,
      label: item.label,
      kind: item.kind,
    };
  });
}

function parseMemorySourceRefs(value: string): MemorySourceRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected memory source refs array from SQLite");
  }
  return normalizeMemorySourceRefs(parsed);
}

function parseChannelExecutionProposalSteps(value: string): ChannelExecutionProposal["collaborationSteps"] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Expected channel execution proposal steps array from SQLite");
  }
  return parsed.map((item) => {
    if (!isJsonRecord(item) || typeof item.teammateId !== "string" || typeof item.summary !== "string") {
      throw new Error("Expected channel execution proposal step from SQLite");
    }
    if (
      item.action !== "coordinated" &&
      item.action !== "consulted" &&
      item.action !== "reviewed" &&
      item.action !== "flagged_risk"
    ) {
      throw new Error("Expected channel execution proposal step action from SQLite");
    }
    return {
      teammateId: item.teammateId,
      action: item.action,
      summary: item.summary,
    };
  });
}

function parseApprovalProfile(value: string): SkillApprovalProfile {
  const parsed = parseJsonObject(value);
  if (parsed.mode !== "none" && parsed.mode !== "standard" && parsed.mode !== "strict") {
    throw new Error("Expected approval profile mode from SQLite");
  }
  return parsed as unknown as SkillApprovalProfile;
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}

function normalizeMemorySourceRefs(values: readonly unknown[]): MemorySourceRef[] {
  return values.map((value, index) => {
    if (!isJsonRecord(value)) {
      throw new Error(`sourceRefs[${index}] must be an object`);
    }
    const type = value.type;
    if (!isMemorySourceType(type)) {
      throw new Error(`sourceRefs[${index}].type is not supported`);
    }
    if (typeof value.id !== "string" || value.id.trim().length === 0) {
      throw new Error(`sourceRefs[${index}].id must be a non-empty string`);
    }
    return omitUndefined({
      type,
      id: value.id.trim(),
      label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : undefined,
      url: typeof value.url === "string" && value.url.trim() ? value.url.trim() : undefined,
    });
  });
}

function ensureMemorySourceRefs(memoryId: string, sourceRefs: readonly MemorySourceRef[]): readonly MemorySourceRef[] {
  if (sourceRefs.length > 0) {
    return sourceRefs;
  }
  return [{ type: "manual", id: memoryId, label: "Manual memory" }];
}

function isMemorySourceType(value: unknown): value is MemorySourceRef["type"] {
  return (
    value === "manual" ||
    value === "message" ||
    value === "decision" ||
    value === "doc" ||
    value === "attachment" ||
    value === "run-event" ||
    value === "artifact" ||
    value === "import"
  );
}

function validateMemoryObject(memory: MemoryObject): void {
  if (!isMemoryScopeType(memory.scopeType)) {
    throw new Error("scopeType is not supported");
  }
  if (!memory.ownerId.trim()) {
    throw new Error("ownerId must be a non-empty string");
  }
  if (!memory.title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (!memory.body.trim()) {
    throw new Error("body must be a non-empty string");
  }
  if (!isMemoryReviewState(memory.reviewState)) {
    throw new Error("reviewState is not supported");
  }
  if (!isMemorySensitivity(memory.sensitivity)) {
    throw new Error("sensitivity is not supported");
  }
}

function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return value === "workspace" || value === "channel" || value === "teammate" || value === "task" || value === "run";
}

function isMemoryReviewState(value: unknown): value is MemoryReviewState {
  return value === "candidate" || value === "active" || value === "disabled" || value === "archived" || value === "rejected";
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return value === "normal" || value === "private" || value === "secret-adjacent";
}

function memoryRecallAllowedScopes(
  input: MemoryRecallRequest,
  workspaceId: string,
): readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[] {
  const scopes: Array<{ readonly scopeType: MemoryScopeType; readonly ownerId: string }> = [
    { scopeType: "workspace", ownerId: workspaceId },
  ];
  if (input.channelId) {
    scopes.push({ scopeType: "channel", ownerId: input.channelId });
  }
  if (input.teammateId) {
    scopes.push({ scopeType: "teammate", ownerId: input.teammateId });
  }
  if (input.taskId) {
    scopes.push({ scopeType: "task", ownerId: input.taskId });
  }
  if (input.runId) {
    scopes.push({ scopeType: "run", ownerId: input.runId });
  }
  return scopes;
}

function memoryAllowedForRecall(
  memory: MemoryObject,
  input: MemoryRecallRequest,
  allowedScopes: readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[],
): boolean {
  if (!input.includeDisabled && (!memory.enabled || memory.reviewState !== "active")) {
    return false;
  }
  if (!input.includeSecretAdjacent && memory.sensitivity === "secret-adjacent") {
    return false;
  }
  if (
    !input.includePrivate &&
    memory.sensitivity === "private" &&
    input.intent !== "private-chat" &&
    input.intent !== "channel-reply" &&
    input.intent !== "task-run"
  ) {
    return false;
  }
  return allowedScopes.some((scope) => scope.scopeType === memory.scopeType && scope.ownerId === memory.ownerId);
}

function tokenizeMemoryQuery(query: string): readonly string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)].slice(0, 32);
}

function scoreMemoryForRecall(
  memory: MemoryObject,
  queryTerms: readonly string[],
  requestedTags: ReadonlySet<string>,
): MemoryRecallResult["memories"][number] {
  const title = memory.title.toLowerCase();
  const body = memory.body.toLowerCase();
  const tags = memory.tags.map((tag) => tag.toLowerCase());
  const sourceLabels = memory.sourceRefs
    .map((ref) => [ref.type, ref.id, ref.label, ref.url].filter((item): item is string => typeof item === "string").join(" ").toLowerCase())
    .join(" ");
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 8;
      matchedTerms.add(term);
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 6;
      matchedTerms.add(term);
    }
    if (sourceLabels.includes(term)) {
      score += 3;
      matchedTerms.add(term);
    }
    if (body.includes(term)) {
      score += 2;
      matchedTerms.add(term);
    }
  }

  for (const tag of requestedTags) {
    if (tags.includes(tag)) {
      score += 10;
      matchedTerms.add(tag);
    }
  }

  if (queryTerms.length === 0 && requestedTags.size === 0) {
    score = 1;
  }

  return {
    memory,
    score,
    matchedTerms: [...matchedTerms],
    excerpt: excerptMemoryBody(memory.body, queryTerms),
  };
}

function excerptMemoryBody(body: string, queryTerms: readonly string[]): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const firstIndex = queryTerms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstIndex - 80);
  const excerpt = normalized.slice(start, start + 240);
  return `${start > 0 ? "..." : ""}${excerpt}${start + 240 < normalized.length ? "..." : ""}`;
}

function dedupeMembershipInputs(
  memberships: readonly ReplaceTeammateChannelMembershipInput[],
): readonly ReplaceTeammateChannelMembershipInput[] {
  const byChannel = new Map<string, ReplaceTeammateChannelMembershipInput>();
  for (const membership of memberships) {
    byChannel.set(membership.channelId, membership);
  }
  return [...byChannel.values()];
}

function dedupeSkillBindingInputs(
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }
  return [...bySkill.values()];
}

function dedupeMcpToolInputs(tools: readonly ReplaceMcpServerToolInput[]): readonly ReplaceMcpServerToolInput[] {
  const byRawName = new Map<string, ReplaceMcpServerToolInput>();
  for (const tool of tools) {
    byRawName.set(tool.rawName, tool);
  }
  return [...byRawName.values()];
}

function dedupeTeammateMcpBindingInputs(
  bindings: readonly ReplaceTeammateMcpBindingInput[],
): readonly ReplaceTeammateMcpBindingInput[] {
  const byServer = new Map<string, ReplaceTeammateMcpBindingInput>();
  for (const binding of bindings) {
    byServer.set(binding.serverId, binding);
  }
  return [...byServer.values()];
}

function protectDefaultSkillBindings(
  teammate: AiTeammate,
  existing: readonly TeammateSkillBinding[],
  bindings: readonly ReplaceTeammateSkillBindingInput[],
): readonly ReplaceTeammateSkillBindingInput[] {
  const bySkill = new Map<string, ReplaceTeammateSkillBindingInput>();
  for (const binding of bindings) {
    bySkill.set(binding.skillId, binding);
  }

  const template = teammate.templateId
    ? listDefaultTeammateTemplates(GSTACK_DEFAULT_SKILL_PACK_ID).find((item) => item.id === teammate.templateId)
    : undefined;
  if (!template) {
    return [...bySkill.values()];
  }

  const existingBySkill = new Map(existing.map((binding) => [binding.skillId, binding]));
  for (const skillId of template.defaultSkillIds) {
    const requested = bySkill.get(skillId);
    const previous = existingBySkill.get(skillId);
    bySkill.set(skillId, {
      skillId,
      source: "template",
      enabled: requested?.enabled ?? previous?.enabled ?? true,
    });
  }
  return [...bySkill.values()];
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProviderCheckResult(value: string | undefined): ProviderCheckResult | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseJsonObject(value);
  if (typeof parsed.ok !== "boolean" || typeof parsed.message !== "string" || typeof parsed.checkedAt !== "string") {
    throw new Error("Expected provider check result from SQLite");
  }
  if (parsed.code !== undefined && typeof parsed.code !== "string") {
    throw new Error("Expected provider check code to be a string");
  }

  const code = typeof parsed.code === "string" ? parsed.code : undefined;
  return omitUndefined({
    ok: parsed.ok,
    code,
    message: parsed.message,
    checkedAt: parsed.checkedAt,
  }) as ProviderCheckResult;
}

function readString(row: Record<string, SQLOutputValue> | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string`);
  }
  return value;
}

function readBoolean(row: Record<string, SQLOutputValue>, key: string): boolean {
  const value = row[key];
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer`);
}

function readNullableBoolean(row: Record<string, SQLOutputValue>, key: string): boolean | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "bigint") {
    return value === 1n;
  }
  throw new Error(`Expected SQLite column ${key} to be a boolean integer or null`);
}

function readNullableString(row: Record<string, SQLOutputValue>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected SQLite column ${key} to be a string or null`);
  }
  return value;
}

function readNullableNumber(row: Record<string, SQLOutputValue>, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number or null`);
}

function readNumber(row: Record<string, SQLOutputValue> | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new Error(`Expected SQLite column ${key} to be a number`);
}

function booleanToSql(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function nullableUpdate<T>(value: T | null | undefined, existing: T | undefined): T | undefined {
  if (value === undefined) {
    return existing;
  }
  if (value === null) {
    return undefined;
  }
  return value;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}
