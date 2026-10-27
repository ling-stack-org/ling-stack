import type {
  CandidateGenerationDecisionAction,
  OfficialSkillSourceStatusResponse,
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
  SkillCandidateDraftRequest,
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
  SkillImportDraftOptimizationPreviewRequest,
  SkillImportDraftRequest,
  SkillImportDraftResponse,
  SkillImportPreviewResponse,
  SkillImportPublishResponse,
  SkillHealthResponse,
  SkillHardDeleteResponse,
  SkillOptimizationPreviewRequest,
  SkillOptimizationPreviewResponse,
  SkillRecordingEligibilityResponse,
  SkillRecordingObservationRequest,
  SkillRecordingObservationResponse,
  SkillRegistryListResponse,
  SkillRegistryMutationResponse,
  SkillRevisionPreviewRequest,
  SkillRevisionPreviewResponse,
  SkillRevisionPublishRequest,
  SkillRevisionPublishResponse,
  SkillSourceHealthResponse,
  SkillSourceArtifactListResponse,
  SkillSourceSnapshotArchiveResponse,
  SkillSourceSnapshotRollbackRequest,
  SkillSourceSnapshotRollbackResponse,
  SkillSourceSnapshotResponse,
  SkillSourceSyncApplyResponse,
  SkillSourceSyncCheckUpdatesResponse,
  SkillSourceSyncPreviewResponse,
  SharedSkillSourceScanRequest,
  SharedSkillSourceScanResponse,
  SharedSkillSourcePublishRequest,
  SharedSkillSourcePublishResponse,
  SkillSourceSyncPublishRequest,
  SkillSourceSyncPublishResponse,
  SkillSourceSyncRefreshResponse,
  SkillSourceSyncRequest,
  SkillSourceUpgradePolicyResponse,
  SkillSourceUpgradePolicyUpdateRequest,
  SkillUsageEventKind,
  SkillUsageEventListResponse,
  SkillUsageStatsListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listSkills(cwd: string): Promise<SkillRegistryListResponse> {
  return daemonClient.listSkills(cwd);
}

export async function getOfficialSkillSourceStatus(cwd: string): Promise<OfficialSkillSourceStatusResponse> {
  return daemonClient.getOfficialSkillSourceStatus(cwd);
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

export async function rollbackSkillSourceSnapshot(cwd: string, skillId: string, input: SkillSourceSnapshotRollbackRequest): Promise<SkillSourceSnapshotRollbackResponse> {
  return daemonClient.rollbackSkillSourceSnapshot(cwd, skillId, input);
}

export async function listSkillSourceArtifacts(cwd: string, skillId: string): Promise<SkillSourceArtifactListResponse> {
  return daemonClient.listSkillSourceArtifacts(cwd, skillId);
}

export async function previewSkillOptimization(cwd: string, skillId: string, input: SkillOptimizationPreviewRequest = {}): Promise<SkillOptimizationPreviewResponse> {
  return daemonClient.previewSkillOptimization(cwd, skillId, input);
}

export function skillSourceArtifactContentUrl(artifactId: string, cwd?: string): string {
  return daemonClient.skillSourceArtifactContentUrl(artifactId, cwd);
}

export async function getSkillSourceUpgradePolicy(cwd: string): Promise<SkillSourceUpgradePolicyResponse> {
  return daemonClient.getSkillSourceUpgradePolicy(cwd);
}

export async function updateSkillSourceUpgradePolicy(cwd: string, input: SkillSourceUpgradePolicyUpdateRequest): Promise<SkillSourceUpgradePolicyResponse> {
  return daemonClient.updateSkillSourceUpgradePolicy(cwd, input);
}

export async function previewGstackSkillSourceSync(cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncPreviewResponse> {
  return daemonClient.previewGstackSkillSourceSync(cwd, input);
}

export async function previewSharedSkillSources(cwd: string, input: SharedSkillSourceScanRequest = {}): Promise<SharedSkillSourceScanResponse> {
  return daemonClient.previewSharedSkillSources(cwd, input);
}

export async function publishSharedSkillSources(cwd: string, input: SharedSkillSourcePublishRequest): Promise<SharedSkillSourcePublishResponse> {
  return daemonClient.publishSharedSkillSources(cwd, input);
}

export async function applyGstackSkillSourceSync(cwd: string): Promise<SkillSourceSyncApplyResponse> {
  return daemonClient.applyGstackSkillSourceSync(cwd);
}

export async function checkGstackSkillSourceUpdates(cwd: string, input: SkillSourceSyncRequest = {}): Promise<SkillSourceSyncCheckUpdatesResponse> {
  return daemonClient.checkGstackSkillSourceUpdates(cwd, input);
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

export async function getSkillRecordingEligibility(cwd: string, runId: string): Promise<SkillRecordingEligibilityResponse> {
  return daemonClient.getSkillRecordingEligibility(cwd, runId);
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

export async function createSkillCandidateDraft(cwd: string, candidateId: string, input: SkillCandidateDraftRequest = {}): Promise<SkillCandidateDraftResponse> {
  return daemonClient.createSkillCandidateDraft(cwd, candidateId, input);
}

export async function createSkillImportDraft(cwd: string, input: SkillImportDraftRequest): Promise<SkillImportDraftResponse> {
  return daemonClient.createSkillImportDraft(cwd, input);
}

export async function previewSkillImport(cwd: string, input: SkillImportDraftRequest): Promise<SkillImportPreviewResponse> {
  return daemonClient.previewSkillImport(cwd, input);
}

export async function previewSkillRevision(cwd: string, skillId: string, input: SkillRevisionPreviewRequest): Promise<SkillRevisionPreviewResponse> {
  return daemonClient.previewSkillRevision(cwd, skillId, input);
}

export async function publishSkillRevision(cwd: string, skillId: string, input: SkillRevisionPublishRequest): Promise<SkillRevisionPublishResponse> {
  return daemonClient.publishSkillRevision(cwd, skillId, input);
}

export async function previewSkillImportDraftOptimization(
  cwd: string,
  input: SkillImportDraftOptimizationPreviewRequest,
): Promise<SkillOptimizationPreviewResponse> {
  return daemonClient.previewSkillImportDraftOptimization(cwd, input);
}

export async function publishSkillImportDraft(cwd: string, draftId: string): Promise<SkillImportPublishResponse> {
  return daemonClient.publishSkillImportDraft(cwd, draftId);
}

export async function archiveSkill(cwd: string, skillId: string): Promise<SkillRegistryMutationResponse> {
  return daemonClient.archiveSkill(cwd, skillId);
}

export async function hardDeleteSkill(cwd: string, skillId: string): Promise<SkillHardDeleteResponse> {
  return daemonClient.hardDeleteSkill(cwd, skillId);
}
