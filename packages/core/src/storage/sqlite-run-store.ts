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
  type ChannelHandoff,
  type ChannelHandoffStatus,
  type ChannelLinkPreview,
  type ChannelLinkPreviewStatus,
  type ChannelMessage,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
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
  transitionWorkflow,
  transitionWorkflowStep,
  type RunTransitionEvent,
  type StateEntityType,
  type StateTransitionActor,
  type TaskTransitionEvent,
  type TransitionResult,
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
          provider_preset_id,
          provider_name,
          provider_model,
          task_snapshot_json,
          provider_snapshot_json,
          request_snapshot_json,
          event_log_path,
          summary_path,
          error_message,
          created_at,
          started_at,
          ended_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        "queued",
        input.cwd,
        input.taskId,
        input.channelId ?? null,
        input.teammateId ?? null,
        input.providerPresetId ?? null,
        input.providerName,
        input.providerModel,
        stringifyJson(redactedTaskSnapshot),
        stringifyJson(redactedProviderSnapshot),
        stringifyJson(redactedRequestSnapshot),
        eventLogPath,
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
            provider_preset_id,
            provider_name,
            provider_model,
            task_snapshot_json,
            provider_snapshot_json,
            request_snapshot_json,
            event_log_path,
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
        provider_preset_id,
        provider_name,
        provider_model,
        task_snapshot_json,
        provider_snapshot_json,
        request_snapshot_json,
        event_log_path,
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
            released_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          null,
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
        SET status = 'released', released_at = ?
        WHERE owner_type = ? AND owner_id = ? AND status = 'active'
      `)
      .run(releasedAt, ownerType, ownerId);
    return Number(result.changes);
  }

  expireResourceLeases(now: string): number {
    const result = this.database
      .prepare(`
        UPDATE resource_leases
        SET status = 'expired', released_at = ?
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
          current_run_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.workspaceId,
        task.channelId,
        task.title,
        task.prompt,
        task.status,
        task.assigneeTeammateId ?? null,
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

  getChannelMessage(id: string): ChannelMessage | undefined {
    const row = this.database.prepare(channelMessageSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelMessage(row) : undefined;
  }

  listChannelMessages(options: ListChannelMessagesOptions): ChannelMessage[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.threadId) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.database
      .prepare(`${channelMessageSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
      .all(...params)
      .map(mapChannelMessage);
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
    providerPresetId: readNullableString(row, "provider_preset_id"),
    providerName: readString(row, "provider_name"),
    providerModel: readString(row, "provider_model"),
    taskSnapshot: parseJson(readString(row, "task_snapshot_json")),
    providerSnapshot: parseJson(readString(row, "provider_snapshot_json")),
    requestSnapshot: parseJson(readString(row, "request_snapshot_json")),
    eventLogPath: readString(row, "event_log_path"),
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
    releasedAt: readNullableString(row, "released_at"),
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
      released_at
    FROM resource_leases
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

function parseApprovalProfile(value: string): SkillApprovalProfile {
  const parsed = parseJsonObject(value);
  if (parsed.mode !== "none" && parsed.mode !== "standard" && parsed.mode !== "strict") {
    throw new Error("Expected approval profile mode from SQLite");
  }
  return parsed as unknown as SkillApprovalProfile;
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
