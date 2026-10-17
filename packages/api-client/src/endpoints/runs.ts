import type {
  ExecutionCancellationRequest,
  CreateLingTurnRequest,
  CreateLingThreadRequest,
  CreateToolLoadRequest,
  CreateRunInterventionRequest,
  ExecutionActionListResponse,
  HardDeleteLingThreadRequest,
  HardDeleteLingThreadResponse,
  LingThreadArchiveRequest,
  LingThreadDetailResponse,
  LingThreadEvidenceResponse,
  LingThreadForkRunRequest,
  LingThreadForkRunResponse,
  LingThreadForkRequest,
  LingThreadForkResponse,
  LingThreadListRequest,
  LingThreadListResponse,
  LingThreadModeResponse,
  LingThreadModeUpdateRequest,
  LingThreadGoalPatchRequest,
  LingThreadGoalCompleteRequest,
  LingThreadGoalPutRequest,
  LingThreadMutationResponse,
  LingThreadPinRequest,
  ProposedPlanActionRequest,
  ProposedPlanActionResponse,
  ProposedPlanArtifactListResponse,
  ProposedPlanArtifactPatchRequest,
  ProposedPlanArtifactPutRequest,
  ProposedPlanArtifactResponse,
  LingThreadResumePreviewResponse,
  LingThreadResumeRequest,
  LingThreadResumeResponse,
  LingThreadTurnsResponse,
  LingThreadGoalResponse,
  LingTraceDetailResponse,
  LingTraceListResponse,
  LingTraceSpansResponse,
  LingTurnMutationResponse,
  RunArtifactListResponse,
  RunCancelResponse,
  RunEventsResponse,
  RunInterventionListResponse,
  RunInterventionResponse,
  RunListRequest,
  RunListResponse,
  RunSession,
  ShellSnapshotListResponse,
  ShellSnapshotResponse,
  ToolLoadRequestResponse,
  ToolSurfaceResponse,
  RunWorkspaceChangesResponse,
  TurnWorkspaceChangesResponse,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const runEndpoints = {
  async listRuns(this: LingDaemonEndpointContext, cwd: string, options: RunListRequest | number = 50): Promise<RunListResponse> {
      const request = typeof options === "number" ? { limit: options } : options;
      return this._get("/runs", {
        cwd,
        status: request.status,
        teammateId: request.teammateId,
        workflowStepId: request.workflowStepId,
        threadId: request.threadId,
        limit: request.limit,
      });
    },

  async listExecutionActions(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly runId?: string;
        readonly threadId?: string;
        readonly status?: string;
        readonly actionType?: string;
        readonly limit?: number;
      } = {},
    ): Promise<ExecutionActionListResponse> {
      return this._get("/execution-actions", {
        cwd,
        runId: options.runId,
        threadId: options.threadId,
        status: options.status,
        actionType: options.actionType,
        limit: options.limit,
      });
    },

  async listLingThreads(this: LingDaemonEndpointContext, cwd: string, options: LingThreadListRequest = {}): Promise<LingThreadListResponse> {
      return this._get("/threads", {
        cwd,
        q: options.q,
        kind: options.kind,
        channelId: options.channelId,
        taskId: options.taskId,
        teammateId: options.teammateId,
        workflowStepId: options.workflowStepId,
        externalWorkId: options.externalWorkId,
        status: options.status,
        archived: options.archived,
        includeArchived: options.includeArchived,
        limit: options.limit,
      });
    },

  async createLingThread(this: LingDaemonEndpointContext, cwd: string, input: CreateLingThreadRequest): Promise<LingThreadMutationResponse> {
      return this._post("/threads", { cwd }, input);
    },

  async getLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<LingThreadDetailResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}`, { cwd });
    },

  async getLingThreadEvidence(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<LingThreadEvidenceResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}/evidence`, { cwd });
    },

  async getLingThreadMode(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<LingThreadModeResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}/mode`, { cwd });
    },

  async updateLingThreadMode(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadModeUpdateRequest): Promise<LingThreadModeResponse> {
      return this._patch(`/threads/${encodeURIComponent(threadId)}/mode`, { cwd }, input);
    },

  async getLingThreadGoal(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<LingThreadGoalResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}/goal`, { cwd });
    },

  async putLingThreadGoal(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadGoalPutRequest): Promise<LingThreadGoalResponse> {
      return this._put(`/threads/${encodeURIComponent(threadId)}/goal`, { cwd }, input);
    },

  async patchLingThreadGoal(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadGoalPatchRequest): Promise<LingThreadGoalResponse> {
      return this._patch(`/threads/${encodeURIComponent(threadId)}/goal`, { cwd }, input);
    },

  async completeLingThreadGoal(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadGoalCompleteRequest = {}): Promise<LingThreadGoalResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/goal/complete`, { cwd }, input);
    },

  async deleteLingThreadGoal(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<LingThreadGoalResponse> {
      return this._delete(`/threads/${encodeURIComponent(threadId)}/goal`, { cwd });
    },

  async listProposedPlanArtifacts(this: LingDaemonEndpointContext, cwd: string, threadId: string, options: { readonly limit?: number } = {}): Promise<ProposedPlanArtifactListResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}/proposed-plans`, { cwd, limit: options.limit });
    },

  async listChannelProposedPlanArtifacts(this: LingDaemonEndpointContext, cwd: string, channelId: string, options: { readonly scope?: "channel" | "thread"; readonly threadId?: string; readonly goalId?: string; readonly agentId?: string; readonly status?: string; readonly limit?: number } = {}): Promise<ProposedPlanArtifactListResponse> {
      return this._get(`/channels/${encodeURIComponent(channelId)}/proposed-plans`, {
        cwd,
        scope: options.scope,
        threadId: options.threadId,
        goalId: options.goalId,
        agentId: options.agentId,
        status: options.status,
        limit: options.limit,
      });
    },

  async putProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanArtifactPutRequest): Promise<ProposedPlanArtifactResponse> {
      return this._put(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}`, { cwd }, input);
    },

  async patchProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanArtifactPatchRequest): Promise<ProposedPlanArtifactResponse> {
      return this._patch(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}`, { cwd }, input);
    },

  async saveProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanActionRequest = {}): Promise<ProposedPlanActionResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}/save`, { cwd }, input);
    },

  async acceptProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanActionRequest = {}): Promise<ProposedPlanActionResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}/accept`, { cwd }, input);
    },

  async refineProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanActionRequest = {}): Promise<ProposedPlanActionResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}/refine`, { cwd }, input);
    },

  async archiveProposedPlanArtifact(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanActionRequest = {}): Promise<ProposedPlanActionResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}/archive`, { cwd }, input);
    },

  async convertProposedPlanToWorkflow(this: LingDaemonEndpointContext, cwd: string, threadId: string, planId: string, input: ProposedPlanActionRequest = {}): Promise<ProposedPlanActionResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/proposed-plans/${encodeURIComponent(planId)}/convert-workflow`, { cwd }, input);
    },

  async listLingTraces(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly threadId?: string;
        readonly runId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<LingTraceListResponse> {
      return this._get("/traces", {
        cwd,
        threadId: options.threadId,
        runId: options.runId,
        limit: options.limit,
      });
    },

  async getLingTrace(this: LingDaemonEndpointContext, cwd: string, traceId: string): Promise<LingTraceDetailResponse> {
      return this._get(`/traces/${encodeURIComponent(traceId)}`, { cwd });
    },

  async listLingTraceSpans(this: LingDaemonEndpointContext, cwd: string, traceId: string): Promise<LingTraceSpansResponse> {
      return this._get(`/traces/${encodeURIComponent(traceId)}/spans`, { cwd });
    },

  async getToolSurface(this: LingDaemonEndpointContext, cwd: string, options: { readonly runId?: string } = {}): Promise<ToolSurfaceResponse> {
      return this._get("/tool-surfaces", {
        cwd,
        runId: options.runId,
      });
    },

  async listLingThreadTurns(this: LingDaemonEndpointContext, cwd: string, threadId: string, options: { readonly limit?: number; readonly beforeUpdatedAt?: string } = {}): Promise<LingThreadTurnsResponse> {
      return this._get(`/threads/${encodeURIComponent(threadId)}/turns`, {
        cwd,
        limit: options.limit,
        beforeUpdatedAt: options.beforeUpdatedAt,
      });
    },

  async createLingTurn(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: CreateLingTurnRequest): Promise<LingTurnMutationResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/turns`, { cwd }, input);
    },

  async resumeLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadResumeRequest = {}): Promise<LingThreadResumeResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/resume`, { cwd }, input);
    },

  async previewLingThreadResume(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadResumeRequest = {}): Promise<LingThreadResumePreviewResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/resume-preview`, { cwd }, input);
    },

  async forkLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadForkRequest = {}): Promise<LingThreadForkResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/fork`, { cwd }, input);
    },

  async forkRunLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadForkRunRequest): Promise<LingThreadForkRunResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/fork-run`, { cwd }, input);
    },

  async archiveLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadArchiveRequest = {}): Promise<LingThreadMutationResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/archive`, { cwd }, input);
    },

  async unarchiveLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadArchiveRequest = {}): Promise<LingThreadMutationResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/unarchive`, { cwd }, input);
    },

  async hardDeleteLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: HardDeleteLingThreadRequest = {}): Promise<HardDeleteLingThreadResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/hard-delete`, { cwd }, input);
    },

  async pinLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadPinRequest = {}): Promise<LingThreadMutationResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/pin`, { cwd }, input);
    },

  async unpinLingThread(this: LingDaemonEndpointContext, cwd: string, threadId: string, input: LingThreadPinRequest = {}): Promise<LingThreadMutationResponse> {
      return this._post(`/threads/${encodeURIComponent(threadId)}/unpin`, { cwd }, input);
    },

  async getRun(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunSession> {
      return this._get(`/runs/${encodeURIComponent(runId)}`, { cwd });
    },

  async getRunEvents(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunEventsResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/events`, { cwd });
    },

  async getRunWorkspaceChanges(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunWorkspaceChangesResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/workspace-changes`, { cwd });
    },

  async undoRunWorkspaceChanges(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunWorkspaceChangesResponse> {
      return this._post(`/runs/${encodeURIComponent(runId)}/workspace-changes/undo`, { cwd }, {});
    },

  async reapplyRunWorkspaceChanges(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunWorkspaceChangesResponse> {
      return this._post(`/runs/${encodeURIComponent(runId)}/workspace-changes/reapply`, { cwd }, {});
    },

  async getTurnWorkspaceChanges(this: LingDaemonEndpointContext, turnId: string, cwd?: string): Promise<TurnWorkspaceChangesResponse> {
      return this._get(`/turns/${encodeURIComponent(turnId)}/workspace-changes`, { cwd });
    },

  async undoTurnWorkspaceChanges(this: LingDaemonEndpointContext, turnId: string, idempotencyKey: string, cwd?: string): Promise<TurnWorkspaceChangesResponse> {
      return this._post(`/turns/${encodeURIComponent(turnId)}/workspace-changes/undo`, { cwd, idempotencyKey }, {});
    },

  async reapplyTurnWorkspaceChanges(this: LingDaemonEndpointContext, turnId: string, idempotencyKey: string, cwd?: string): Promise<TurnWorkspaceChangesResponse> {
      return this._post(`/turns/${encodeURIComponent(turnId)}/workspace-changes/reapply`, { cwd, idempotencyKey }, {});
    },

  async listRunArtifacts(this: LingDaemonEndpointContext, runId: string, cwd?: string): Promise<RunArtifactListResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/artifacts`, { cwd });
    },

  async listRunShellSnapshots(this: LingDaemonEndpointContext, runId: string, cwd?: string, toolCallId?: string): Promise<ShellSnapshotListResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/shell-snapshots`, { cwd, toolCallId });
    },

  async getRunShellSnapshot(this: LingDaemonEndpointContext, runId: string, snapshotId: string, cwd?: string): Promise<ShellSnapshotResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/shell-snapshots/${encodeURIComponent(snapshotId)}`, { cwd });
    },

  async cancelRun(this: LingDaemonEndpointContext, cwd: string, runId: string, input: ExecutionCancellationRequest = {}): Promise<RunCancelResponse> {
      return this._post(`/runs/${encodeURIComponent(runId)}/cancel`, { cwd }, input);
    },

  async listRunInterventions(this: LingDaemonEndpointContext, cwd: string, runId: string, limit: number = 100, idempotencyKey?: string): Promise<RunInterventionListResponse> {
      return this._get(`/runs/${encodeURIComponent(runId)}/interventions`, { cwd, limit, idempotencyKey });
    },

  async createRunIntervention(this: LingDaemonEndpointContext, cwd: string, runId: string, input: CreateRunInterventionRequest): Promise<RunInterventionResponse> {
      return this._post(`/runs/${encodeURIComponent(runId)}/interventions`, { cwd }, input);
    },

  async createToolLoadRequest(this: LingDaemonEndpointContext, cwd: string, runId: string, input: CreateToolLoadRequest): Promise<ToolLoadRequestResponse> {
      return this._post(`/runs/${encodeURIComponent(runId)}/tool-load-requests`, { cwd }, input);
    },

  async getRunIntervention(this: LingDaemonEndpointContext, cwd: string, interventionId: string): Promise<RunInterventionResponse> {
      return this._get(`/run-interventions/${encodeURIComponent(interventionId)}`, { cwd });
    },

  async cancelRunIntervention(this: LingDaemonEndpointContext, cwd: string, interventionId: string): Promise<RunInterventionResponse> {
      return this._post(`/run-interventions/${encodeURIComponent(interventionId)}/cancel`, { cwd }, {});
    },

  async promoteRunIntervention(this: LingDaemonEndpointContext, cwd: string, interventionId: string): Promise<RunInterventionResponse> {
      return this._post(`/run-interventions/${encodeURIComponent(interventionId)}/promote`, { cwd }, {});
    },
};

export type RunEndpoints = PublicEndpointGroup<typeof runEndpoints>;
