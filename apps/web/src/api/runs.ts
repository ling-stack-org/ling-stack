import type {
  ExecutionCancellationRequest,
  CreateLingThreadRequest,
  CreateRunInterventionRequest,
  LingThreadArchiveRequest,
  HardDeleteLingThreadResponse,
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
  LingThreadGoalResponse,
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
  LingTraceDetailResponse,
  LingTraceListResponse,
  LingTraceSpansResponse,
  ExecutionActionListResponse,
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
  UserInputAnswerSubmissionResponseV1,
  UserInputAnswerSubmissionV1,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  return daemonClient.getRun(runId, cwd);
}

export async function listRuns(cwd: string, options: RunListRequest | number = 50): Promise<RunListResponse> {
  return daemonClient.listRuns(cwd, options);
}

export async function listExecutionActions(
  cwd: string,
  options: {
    readonly runId?: string;
    readonly threadId?: string;
    readonly status?: string;
    readonly actionType?: string;
    readonly limit?: number;
  } = {},
): Promise<ExecutionActionListResponse> {
  return daemonClient.listExecutionActions(cwd, options);
}

export async function submitRunUserInputAnswer(
  cwd: string,
  threadId: string,
  requestId: string,
  input: UserInputAnswerSubmissionV1,
): Promise<UserInputAnswerSubmissionResponseV1> {
  return daemonClient.submitRunUserInputAnswer(cwd, threadId, requestId, input);
}

export async function listLingThreads(cwd: string, options: LingThreadListRequest = {}): Promise<LingThreadListResponse> {
  return daemonClient.listLingThreads(cwd, options);
}

export async function createLingThread(cwd: string, input: CreateLingThreadRequest): Promise<LingThreadMutationResponse> {
  return daemonClient.createLingThread(cwd, input);
}

export async function getLingThread(cwd: string, threadId: string): Promise<LingThreadDetailResponse> {
  return daemonClient.getLingThread(cwd, threadId);
}

export async function getLingThreadEvidence(cwd: string, threadId: string): Promise<LingThreadEvidenceResponse> {
  return daemonClient.getLingThreadEvidence(cwd, threadId);
}

export async function getLingThreadMode(cwd: string, threadId: string): Promise<LingThreadModeResponse> {
  return daemonClient.getLingThreadMode(cwd, threadId);
}

export async function updateLingThreadMode(cwd: string, threadId: string, input: LingThreadModeUpdateRequest): Promise<LingThreadModeResponse> {
  return daemonClient.updateLingThreadMode(cwd, threadId, input);
}

export async function getLingThreadGoal(cwd: string, threadId: string): Promise<LingThreadGoalResponse> {
  return daemonClient.getLingThreadGoal(cwd, threadId);
}

export async function putLingThreadGoal(cwd: string, threadId: string, input: LingThreadGoalPutRequest): Promise<LingThreadGoalResponse> {
  return daemonClient.putLingThreadGoal(cwd, threadId, input);
}

export async function patchLingThreadGoal(cwd: string, threadId: string, input: LingThreadGoalPatchRequest): Promise<LingThreadGoalResponse> {
  return daemonClient.patchLingThreadGoal(cwd, threadId, input);
}

export async function completeLingThreadGoal(cwd: string, threadId: string, input: LingThreadGoalCompleteRequest = {}): Promise<LingThreadGoalResponse> {
  return daemonClient.completeLingThreadGoal(cwd, threadId, input);
}

export async function deleteLingThreadGoal(cwd: string, threadId: string): Promise<LingThreadGoalResponse> {
  return daemonClient.deleteLingThreadGoal(cwd, threadId);
}

export async function listProposedPlanArtifacts(
  cwd: string,
  threadId: string,
  options: { readonly limit?: number } = {},
): Promise<ProposedPlanArtifactListResponse> {
  return daemonClient.listProposedPlanArtifacts(cwd, threadId, options);
}

export async function listChannelProposedPlanArtifacts(
  cwd: string,
  channelId: string,
  options: { readonly scope?: "channel" | "thread"; readonly threadId?: string; readonly goalId?: string; readonly agentId?: string; readonly status?: string; readonly limit?: number } = {},
): Promise<ProposedPlanArtifactListResponse> {
  return daemonClient.listChannelProposedPlanArtifacts(cwd, channelId, options);
}

export async function putProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanArtifactPutRequest,
): Promise<ProposedPlanArtifactResponse> {
  return daemonClient.putProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function patchProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanArtifactPatchRequest,
): Promise<ProposedPlanArtifactResponse> {
  return daemonClient.patchProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function saveProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanActionRequest = {},
): Promise<ProposedPlanActionResponse> {
  return daemonClient.saveProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function acceptProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanActionRequest = {},
): Promise<ProposedPlanActionResponse> {
  return daemonClient.acceptProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function refineProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanActionRequest = {},
): Promise<ProposedPlanActionResponse> {
  return daemonClient.refineProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function archiveProposedPlanArtifact(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanActionRequest = {},
): Promise<ProposedPlanActionResponse> {
  return daemonClient.archiveProposedPlanArtifact(cwd, threadId, planId, input);
}

export async function convertProposedPlanToWorkflow(
  cwd: string,
  threadId: string,
  planId: string,
  input: ProposedPlanActionRequest = {},
): Promise<ProposedPlanActionResponse> {
  return daemonClient.convertProposedPlanToWorkflow(cwd, threadId, planId, input);
}

export async function listLingTraces(
  cwd: string,
  options: {
    readonly threadId?: string;
    readonly runId?: string;
    readonly limit?: number;
  } = {},
): Promise<LingTraceListResponse> {
  return daemonClient.listLingTraces(cwd, options);
}

export async function getLingTrace(cwd: string, traceId: string): Promise<LingTraceDetailResponse> {
  return daemonClient.getLingTrace(cwd, traceId);
}

export async function listLingTraceSpans(cwd: string, traceId: string): Promise<LingTraceSpansResponse> {
  return daemonClient.listLingTraceSpans(cwd, traceId);
}

export async function listLingThreadTurns(
  cwd: string,
  threadId: string,
  options: { readonly limit?: number; readonly beforeUpdatedAt?: string } = {},
): Promise<LingThreadTurnsResponse> {
  return daemonClient.listLingThreadTurns(cwd, threadId, options);
}

export async function resumeLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadResumeRequest = {},
): Promise<LingThreadResumeResponse> {
  return daemonClient.resumeLingThread(cwd, threadId, input);
}

export async function previewLingThreadResume(
  cwd: string,
  threadId: string,
  input: LingThreadResumeRequest = {},
): Promise<LingThreadResumePreviewResponse> {
  return daemonClient.previewLingThreadResume(cwd, threadId, input);
}

export async function forkLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadForkRequest = {},
): Promise<LingThreadForkResponse> {
  return daemonClient.forkLingThread(cwd, threadId, input);
}

export async function forkRunLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadForkRunRequest,
): Promise<LingThreadForkRunResponse> {
  return daemonClient.forkRunLingThread(cwd, threadId, input);
}

export async function archiveLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadArchiveRequest = {},
): Promise<LingThreadMutationResponse> {
  return daemonClient.archiveLingThread(cwd, threadId, input);
}

export async function unarchiveLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadArchiveRequest = {},
): Promise<LingThreadMutationResponse> {
  return daemonClient.unarchiveLingThread(cwd, threadId, input);
}

export async function hardDeleteLingThread(
  cwd: string,
  threadId: string,
  reason?: string,
): Promise<HardDeleteLingThreadResponse> {
  return daemonClient.hardDeleteLingThread(cwd, threadId, reason?.trim() ? { reason: reason.trim() } : {});
}

export async function pinLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadPinRequest = {},
): Promise<LingThreadMutationResponse> {
  return daemonClient.pinLingThread(cwd, threadId, input);
}

export async function unpinLingThread(
  cwd: string,
  threadId: string,
  input: LingThreadPinRequest = {},
): Promise<LingThreadMutationResponse> {
  return daemonClient.unpinLingThread(cwd, threadId, input);
}

export async function listRunInterventions(cwd: string, runId: string, limit = 100, idempotencyKey?: string): Promise<RunInterventionListResponse> {
  return daemonClient.listRunInterventions(cwd, runId, limit, idempotencyKey);
}

export async function createRunIntervention(
  cwd: string,
  runId: string,
  input: CreateRunInterventionRequest,
): Promise<RunInterventionResponse> {
  return daemonClient.createRunIntervention(cwd, runId, input);
}

export async function getRunIntervention(cwd: string, interventionId: string): Promise<RunInterventionResponse> {
  return daemonClient.getRunIntervention(cwd, interventionId);
}

export async function cancelRunIntervention(cwd: string, interventionId: string): Promise<RunInterventionResponse> {
  return daemonClient.cancelRunIntervention(cwd, interventionId);
}

export async function promoteRunIntervention(cwd: string, interventionId: string): Promise<RunInterventionResponse> {
  return daemonClient.promoteRunIntervention(cwd, interventionId);
}

export async function getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse> {
  return daemonClient.getRunEvents(runId, cwd);
}

export async function listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse> {
  return daemonClient.listRunArtifacts(runId, cwd);
}

export async function listRunShellSnapshots(runId: string, cwd?: string, toolCallId?: string): Promise<ShellSnapshotListResponse> {
  return daemonClient.listRunShellSnapshots(runId, cwd, toolCallId);
}

export async function getRunShellSnapshot(runId: string, snapshotId: string, cwd?: string): Promise<ShellSnapshotResponse> {
  return daemonClient.getRunShellSnapshot(runId, snapshotId, cwd);
}

export async function cancelRun(cwd: string, runId: string, input: ExecutionCancellationRequest = {}): Promise<RunCancelResponse> {
  return daemonClient.cancelRun(cwd, runId, input);
}
