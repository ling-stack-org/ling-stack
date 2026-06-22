import type {
  CandidateGenerationDecisionAction,
  CandidateGenerationDecisionListResponse,
  CandidateRouteKind,
  ProcedureObservationClusterListResponse,
  ProcedureObservationClusterResponse,
  ProcedureObservationClusterStatus,
  ProcedureObservationListResponse,
  ProcedureObservationJobRequest,
  ProcedureObservationJobResponse,
  ProcedureObservationRequest,
  ProcedureObservationResponse,
  SkillCandidateDraftResponse,
  SkillCandidateListResponse,
  SkillCandidateObserveResponse,
  SkillCandidateOrigin,
  SkillCandidateResponse,
  SkillCandidateReviewRequest,
  SkillCandidateReviewResponse,
  SkillCandidateStatus,
  SkillCorrectionRequest,
  SkillCorrectionResponse,
  SkillInvocationSuggestionRequest,
  SkillInvocationSuggestionResponse,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPublishResponse,
  SkillHealthResponse,
  SkillRecordingObservationRequest,
  SkillRecordingObservationResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillSourceHealthResponse,
  SkillSourceSnapshotArchiveResponse,
  SkillSourceSnapshotResponse,
  SkillSourceSyncPreviewResponse,
  SkillSourceSyncPublishRequest,
  SkillSourceSyncPublishResponse,
  SkillSourceSyncRefreshResponse,
  SkillSourceSyncRequest,
  SkillUsageEventKind,
  SkillUsageEventListResponse,
  SkillUsageStatsListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listSkills(cwd: string): Promise<SkillRegistryListResponse> {
  return daemonClient.listSkills(cwd);
}

export async function getSkillHealth(cwd: string, options: { readonly limit?: number } = {}): Promise<SkillHealthResponse> {
  return daemonClient.getSkillHealth(cwd, options);
}

export async function getSkillSourceHealth(cwd: string, options: { readonly limit?: number } = {}): Promise<SkillSourceHealthResponse> {
  return daemonClient.getSkillSourceHealth(cwd, options);
}

export async function getSkillSourceSnapshot(cwd: string, skillId: string): Promise<SkillSourceSnapshotResponse> {
  return daemonClient.getSkillSourceSnapshot(cwd, skillId);
}

export async function archiveSkillSourceSnapshot(cwd: string, skillId: string): Promise<SkillSourceSnapshotArchiveResponse> {
  return daemonClient.archiveSkillSourceSnapshot(cwd, skillId);
}

export async function previewGstackSkillSourceSync(cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncPreviewResponse> {
  return daemonClient.previewGstackSkillSourceSync(cwd, input);
}

export async function refreshGstackSkillSourceSync(cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncRefreshResponse> {
  return daemonClient.refreshGstackSkillSourceSync(cwd, input);
}

export async function publishGstackSkillSourceSync(cwd: string, input: SkillSourceSyncPublishRequest): Promise<SkillSourceSyncPublishResponse> {
  return daemonClient.publishGstackSkillSourceSync(cwd, input);
}

export async function listSkillUsageEvents(
  cwd: string,
  options: {
    readonly skillId?: string;
    readonly candidateId?: string;
    readonly runId?: string;
    readonly kind?: SkillUsageEventKind;
    readonly limit?: number;
  } = {},
): Promise<SkillUsageEventListResponse> {
  return daemonClient.listSkillUsageEvents(cwd, options);
}

export async function listSkillUsageStats(
  cwd: string,
  options: { readonly skillId?: string } = {},
): Promise<SkillUsageStatsListResponse> {
  return daemonClient.listSkillUsageStats(cwd, options);
}

export async function suggestSkillInvocations(cwd: string, input: SkillInvocationSuggestionRequest): Promise<SkillInvocationSuggestionResponse> {
  return daemonClient.suggestSkillInvocations(cwd, input);
}

export async function listCandidateGenerationDecisions(
  cwd: string,
  options: {
    readonly observationId?: string;
    readonly clusterId?: string;
    readonly decision?: CandidateGenerationDecisionAction;
    readonly limit?: number;
  } = {},
): Promise<CandidateGenerationDecisionListResponse> {
  return daemonClient.listCandidateGenerationDecisions(cwd, options);
}

export async function recordSkillCorrection(cwd: string, skillId: string, input: SkillCorrectionRequest): Promise<SkillCorrectionResponse> {
  return daemonClient.recordSkillCorrection(cwd, skillId, input);
}

export async function listProcedureObservations(
  cwd: string,
  options: {
    readonly clusterId?: string;
    readonly channelId?: string;
    readonly routeKind?: CandidateRouteKind;
    readonly limit?: number;
  } = {},
): Promise<ProcedureObservationListResponse> {
  return daemonClient.listProcedureObservations(cwd, options);
}

export async function listProcedureObservationClusters(
  cwd: string,
  options: {
    readonly channelId?: string;
    readonly routeKind?: CandidateRouteKind;
    readonly status?: ProcedureObservationClusterStatus;
    readonly limit?: number;
  } = {},
): Promise<ProcedureObservationClusterListResponse> {
  return daemonClient.listProcedureObservationClusters(cwd, options);
}

export async function getProcedureObservationCluster(cwd: string, clusterId: string): Promise<ProcedureObservationClusterResponse> {
  return daemonClient.getProcedureObservationCluster(cwd, clusterId);
}

export async function createProcedureObservation(cwd: string, input: ProcedureObservationRequest): Promise<ProcedureObservationResponse> {
  return daemonClient.createProcedureObservation(cwd, input);
}

export async function createProcedureObservationJob(cwd: string, input: ProcedureObservationJobRequest): Promise<ProcedureObservationJobResponse> {
  return daemonClient.createProcedureObservationJob(cwd, input);
}

export async function recordSkillRecording(cwd: string, input: SkillRecordingObservationRequest): Promise<SkillRecordingObservationResponse> {
  return daemonClient.recordSkillRecording(cwd, input);
}

export async function listSkillCandidates(
  cwd: string,
  options: {
    readonly status?: SkillCandidateStatus;
    readonly origin?: SkillCandidateOrigin;
    readonly limit?: number;
  } = {},
): Promise<SkillCandidateListResponse> {
  return daemonClient.listSkillCandidates(cwd, options);
}

export async function getSkillCandidate(cwd: string, candidateId: string): Promise<SkillCandidateResponse> {
  return daemonClient.getSkillCandidate(cwd, candidateId);
}

export async function reviewSkillCandidate(
  cwd: string,
  candidateId: string,
  input: SkillCandidateReviewRequest,
): Promise<SkillCandidateReviewResponse> {
  return daemonClient.reviewSkillCandidate(cwd, candidateId, input);
}

export async function observeSkillCandidate(cwd: string, input: ProcedureObservationRequest): Promise<SkillCandidateObserveResponse> {
  return daemonClient.observeSkillCandidate(cwd, input);
}

export async function createSkillCandidateDraft(cwd: string, candidateId: string): Promise<SkillCandidateDraftResponse> {
  return daemonClient.createSkillCandidateDraft(cwd, candidateId);
}

export async function createSkillImportDraft(cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
  return daemonClient.createSkillImportDraft(cwd, input);
}

export async function publishSkillImportDraft(cwd: string, draftId: string): Promise<SkillImportPublishResponse> {
  return daemonClient.publishSkillImportDraft(cwd, draftId);
}

export async function archiveSkill(cwd: string, skillId: string): Promise<SkillRegistryMutationResponse> {
  return daemonClient.archiveSkill(cwd, skillId);
}
