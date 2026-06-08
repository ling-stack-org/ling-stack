import type {
  CreateRunInterventionRequest,
  LingThreadDetailResponse,
  LingThreadEvidenceResponse,
  LingThreadListRequest,
  LingThreadListResponse,
  LingThreadResumePreviewResponse,
  LingThreadResumeRequest,
  LingThreadResumeResponse,
  LingThreadTurnsResponse,
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
} from "../types.js";
import { daemonClient } from "./client.js";

export async function getRun(runId: string, cwd?: string): Promise<RunSession> {
  return daemonClient.getRun(runId, cwd);
}

export async function listRuns(cwd: string, options: RunListRequest | number = 50): Promise<RunListResponse> {
  return daemonClient.listRuns(cwd, options);
}

export async function listLingThreads(cwd: string, options: LingThreadListRequest = {}): Promise<LingThreadListResponse> {
  return daemonClient.listLingThreads(cwd, options);
}

export async function getLingThread(cwd: string, threadId: string): Promise<LingThreadDetailResponse> {
  return daemonClient.getLingThread(cwd, threadId);
}

export async function getLingThreadEvidence(cwd: string, threadId: string): Promise<LingThreadEvidenceResponse> {
  return daemonClient.getLingThreadEvidence(cwd, threadId);
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

export async function listRunInterventions(cwd: string, runId: string, limit = 100): Promise<RunInterventionListResponse> {
  return daemonClient.listRunInterventions(cwd, runId, limit);
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

export async function cancelRun(cwd: string, runId: string): Promise<RunCancelResponse> {
  return daemonClient.cancelRun(cwd, runId);
}
