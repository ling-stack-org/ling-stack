import type {
  LingAppServerStageHandoffParams,
  LingAppServerWorkItemCollaborationAppendResult,
  ListResourceLeasesRequest,
  ListStateTransitionsRequest,
  PreviewContentResponse,
  ResourceLeaseListResponse,
  SecretPurpose,
  SecretStatusResponse,
  StateTransitionListResponse,
  ListWorkItemsRequest,
  WorkItemClaimRequest,
  WorkItemClaimResponse,
  WorkItemCompleteRequest,
  WorkItemDetailResponse,
  WorkItemFailRequest,
  WorkItemHeartbeatRequest,
  WorkItemListResponse,
  WorkItemMutationResponse,
  WorkItemReleaseRequest,
  WorkItemRouteRequest,
  WorkspaceChangesResponse,
  ThreadWorkspaceChangeSummaryResponse,
  WorkSummaryResponse,
  WorkspaceSnapshotManifest,
  WorkspaceSnapshotEntry,
  WorkspaceSnapshotPreview,
  SnapshotRestoreConfirmation,
  SnapshotRestoreRequest,
  WorkspaceFileOpenOptionsResponse,
  WorkspaceFileOpenRequest,
  WorkspaceFileOpenResponse,
  WorkspaceFileOpenTarget,
  WorkspaceFileCapabilityRequest,
  WorkspaceFileCapabilityResponse,
  WorkspaceFileCapabilityPreviewRequest,
  CodeAssessmentDetail,
  CodeAssessmentList,
  CodeAssessmentListOptions,
  CreateCodeAssessmentRequest,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const operationEndpoints = {
  async getCodeAssessmentOverview(this: LingDaemonEndpointContext, cwd: string, assessmentId: string): Promise<import("@ling-stack/contracts").CodeAssessmentOverview> {
    return this._get(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}`, { cwd, view: "overview" });
  },
  async getWorkspaceVerification(this: LingDaemonEndpointContext, cwd: string, threadId?: string, operationId?: string): Promise<import("@ling-stack/contracts").WorkspaceVerificationReport> {
    return this._get("/workspace/verification", { cwd, threadId, operationId });
  },
  async startWorkspaceVerification(this: LingDaemonEndpointContext, cwd: string, input: import("@ling-stack/contracts").StartWorkspaceVerificationRequest): Promise<import("@ling-stack/contracts").WorkspaceVerificationReport> {
    return this._post("/workspace/verification", { cwd }, input);
  },
  async cancelWorkspaceVerification(this: LingDaemonEndpointContext, cwd: string, input: Omit<import("@ling-stack/contracts").LingAppServerVerifyCancelParams, "cwd">): Promise<import("@ling-stack/contracts").LingAppServerVerifyCancelResult> {
    return this._post("/workspace/verification/cancel", { cwd }, input);
  },
  async listGitHubIntakePolicies(this: LingDaemonEndpointContext, cwd: string): Promise<import("@ling-stack/contracts").LingAppServerGitHubIntakePolicyList> {
    return this._get("/workspace/github-intake", { cwd });
  },
  async pollGitHubIntake(this: LingDaemonEndpointContext, cwd: string, input: Omit<import("@ling-stack/contracts").LingAppServerGitHubIntakePollParams, "cwd">): Promise<import("@ling-stack/contracts").LingAppServerGitHubIntakePollResult> {
    return this._post("/workspace/github-intake", { cwd }, input);
  },
  async createCodeAssessmentOverview(this: LingDaemonEndpointContext, cwd: string, input: CreateCodeAssessmentRequest): Promise<import("@ling-stack/contracts").CodeAssessmentOverview> {
    return this._post("/workspace/code-assessments", { cwd, view: "overview" }, input);
  },
  async getCodeAssessmentFile(this: LingDaemonEndpointContext, cwd: string, assessmentId: string, path: string): Promise<import("@ling-stack/contracts").CodeAssessmentFilePreview> {
    return this._get(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/snapshot-file`, { cwd, path });
  },
  async listCodeAssessments(this: LingDaemonEndpointContext, cwd: string, kindOrOptions?: "review" | "security" | CodeAssessmentListOptions, offset = 0): Promise<CodeAssessmentList> {
    const options = typeof kindOrOptions === "string" ? { kind: kindOrOptions, offset } : { offset, ...kindOrOptions };
    return this._get("/workspace/code-assessments", { cwd, ...options });
  },
  async getCodeAssessment(this: LingDaemonEndpointContext, cwd: string, assessmentId: string): Promise<CodeAssessmentDetail> {
    return this._get(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}`, { cwd });
  },
  async createCodeAssessment(this: LingDaemonEndpointContext, cwd: string, input: CreateCodeAssessmentRequest): Promise<CodeAssessmentDetail> {
    return this._post("/workspace/code-assessments", { cwd }, input);
  },
  async cancelCodeAssessment(this: LingDaemonEndpointContext, cwd: string, assessmentId: string): Promise<CodeAssessmentDetail> {
    return this._post(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/cancel`, { cwd }, {});
  },
  async checkCodeAssessmentFreshness(this: LingDaemonEndpointContext, cwd: string, assessmentId: string): Promise<import("@ling-stack/contracts").CodeAssessmentFreshness> {
    return this._post(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/freshness`, { cwd }, {});
  },
  async setCodeFindingDisposition(this: LingDaemonEndpointContext, cwd: string, assessmentId: string, findingId: string, input: { readonly snapshotDigest: string; readonly disposition: import("@ling-stack/contracts").CodeFindingDisposition; readonly closeReason?: import("@ling-stack/contracts").CodeFindingCloseReason; readonly reason?: string }): Promise<import("@ling-stack/contracts").CodeAssessmentFinding> {
    return this._post(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/findings/${encodeURIComponent(findingId)}`, { cwd }, input);
  },
  async listCodeAssessmentComments(this: LingDaemonEndpointContext, cwd: string, assessmentId: string, findingId: string): Promise<{ readonly comments: readonly import("@ling-stack/contracts").CodeAssessmentComment[] }> {
    return this._get(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/findings/${encodeURIComponent(findingId)}/comments`, { cwd });
  },
  async createCodeAssessmentComment(this: LingDaemonEndpointContext, cwd: string, assessmentId: string, findingId: string, input: import("@ling-stack/contracts").CreateCodeAssessmentCommentRequest): Promise<import("@ling-stack/contracts").CodeAssessmentComment> {
    return this._post(`/workspace/code-assessments/${encodeURIComponent(assessmentId)}/findings/${encodeURIComponent(findingId)}/comments`, { cwd }, input);
  },
  async getThreadWorkspaceChangeSummary(this: LingDaemonEndpointContext, cwd: string, threadId: string): Promise<ThreadWorkspaceChangeSummaryResponse> {
    return this._get(`/threads/${encodeURIComponent(threadId)}/workspace-change-summary`, { cwd });
  },

  async getWorkSummaryChanges(this: LingDaemonEndpointContext, cwd: string): Promise<WorkspaceChangesResponse> {
    return this._get("/workspace/changes", { cwd, baseline: "head" });
  },

  async getWorkSummary(this: LingDaemonEndpointContext, cwd: string): Promise<WorkSummaryResponse> {
    return this._get("/workspace/work-summary", { cwd });
  },

  async attachWorkSummaryPullRequest(this: LingDaemonEndpointContext, cwd: string, url: string): Promise<void> {
    return this._post("/workspace/work-summary/pull-requests", { cwd }, { url });
  },

  async detachWorkSummaryPullRequest(this: LingDaemonEndpointContext, cwd: string, url: string): Promise<void> {
    return this._delete("/workspace/work-summary/pull-requests", { cwd, url });
  },

  async listWorkItems(this: LingDaemonEndpointContext, cwd: string, options: ListWorkItemsRequest = {}): Promise<WorkItemListResponse> {
      return this._get("/work-items", {
        cwd,
        channelId: options.channelId,
        status: options.status,
        sourceType: options.sourceType,
        assigneeTeammateId: options.assigneeTeammateId,
        limit: options.limit,
      });
    },

  async listNativeWorkIntake(this: LingDaemonEndpointContext, cwd: string,
    options: import("@ling-stack/contracts").ListNativeWorkIntakeRequest): Promise<import("@ling-stack/contracts").ListNativeWorkIntakeResponse> {
    return this._get("/work-items/intake", { cwd, ...options });
  },

  async retryNativeWorkIntake(this: LingDaemonEndpointContext, cwd: string,
    input: import("@ling-stack/contracts").RetryNativeWorkIntakeRequest): Promise<import("@ling-stack/contracts").NativeWorkIntakeMutationResponse> {
    return this._post("/work-items/intake", { cwd }, input);
  },

  async getWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, stageOffset?: number): Promise<WorkItemDetailResponse> {
      return this._get(`/work-items/${encodeURIComponent(workItemId)}`, { cwd, stageOffset });
    },

  async settleWorkItemStageHandoff(this: LingDaemonEndpointContext, cwd: string, workItemId: string,
    action: "accepted" | "returned", input: Omit<LingAppServerStageHandoffParams, "cwd" | "workItemId">): Promise<LingAppServerWorkItemCollaborationAppendResult> {
    return this._post(`/work-items/${encodeURIComponent(workItemId)}/handoff`, { cwd }, { ...input, action });
  },

  async routeWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemRouteRequest): Promise<WorkItemMutationResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/route`, { cwd }, input);
    },

  async claimWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemClaimRequest): Promise<WorkItemClaimResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/claim`, { cwd }, input);
    },

  async heartbeatWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemHeartbeatRequest): Promise<WorkItemMutationResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/heartbeat`, { cwd }, input);
    },

  async releaseWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemReleaseRequest): Promise<WorkItemMutationResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/release`, { cwd }, input);
    },

  async completeWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemCompleteRequest): Promise<WorkItemMutationResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/complete`, { cwd }, input);
    },

  async failWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string, input: WorkItemFailRequest): Promise<WorkItemMutationResponse> {
      return this._post(`/work-items/${encodeURIComponent(workItemId)}/fail`, { cwd }, input);
    },

  async listStateTransitions(this: LingDaemonEndpointContext, cwd: string, options: ListStateTransitionsRequest = {}): Promise<StateTransitionListResponse> {
      return this._get("/state-transitions", {
        cwd,
        entityType: options.entityType,
        entityId: options.entityId,
        limit: options.limit,
      });
    },

  async listResourceLeases(this: LingDaemonEndpointContext, cwd: string, options: ListResourceLeasesRequest = {}): Promise<ResourceLeaseListResponse> {
      return this._get("/runtime/leases", {
        cwd,
        status: options.status,
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        resourceType: options.resourceType,
        resourceKey: options.resourceKey,
        workUnitId: options.workUnitId,
        attemptId: options.attemptId,
        limit: options.limit,
      });
    },

  async getSecretStatus(this: LingDaemonEndpointContext, ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
      return this._get("/secrets/status", { ref, purpose });
    },

  artifactContentUrl(this: LingDaemonEndpointContext, artifactId: string, cwd?: string): string {
      return this._url(`/artifacts/${encodeURIComponent(artifactId)}/content`, { cwd });
    },

  async previewArtifactContent(this: LingDaemonEndpointContext, cwd: string, artifactId: string, maxBytes?: number): Promise<PreviewContentResponse> {
      return this._get(`/artifacts/${encodeURIComponent(artifactId)}/preview`, { cwd, maxBytes });
    },

  async previewWorkspaceFile(this: LingDaemonEndpointContext, cwd: string, path: string, maxBytes?: number, line?: number): Promise<PreviewContentResponse> {
      return this._get("/workspace-files/preview", { cwd, path, maxBytes, line });
  },

  async issueWorkspaceFileCapability(this: LingDaemonEndpointContext, input: WorkspaceFileCapabilityRequest): Promise<WorkspaceFileCapabilityResponse> {
      return this._post("/workspace-files/capabilities", {}, input);
  },

  async previewWorkspaceFileCapability(this: LingDaemonEndpointContext, input: WorkspaceFileCapabilityPreviewRequest): Promise<PreviewContentResponse> {
      return this._post("/workspace-files/preview", {}, input);
  },

  async previewWorkspaceReviewFile(this: LingDaemonEndpointContext, input: import("@ling-stack/contracts").WorkspaceChangeReviewPreviewRequest): Promise<PreviewContentResponse> {
      return this._post("/workspace-files/review-preview", {}, input);
  },

  async getWorkspaceFileCapabilityChanges(this: LingDaemonEndpointContext, input: WorkspaceFileCapabilityPreviewRequest): Promise<import("@ling-stack/contracts").WorkspaceFileCapabilityChangeResponse> {
      return this._post("/workspace-files/changes", {}, input);
  },

  async getWorkspaceChanges(this: LingDaemonEndpointContext, cwd: string): Promise<WorkspaceChangesResponse> {
      return this._get("/workspace/changes", { cwd });
  },

  async listWorkspaceSnapshots(this: LingDaemonEndpointContext, cwd: string): Promise<{ readonly cwd: string; readonly snapshots: readonly WorkspaceSnapshotManifest[]; readonly restoreUiEnabled?: boolean }> {
      return this._get("/workspace/snapshots", { cwd });
  },

  async getWorkspaceSnapshot(this: LingDaemonEndpointContext, cwd: string, snapshotId: string): Promise<WorkspaceSnapshotPreview> {
      return this._get(`/workspace/snapshots/${encodeURIComponent(snapshotId)}`, { cwd });
  },

  async createWorkspaceSnapshot(this: LingDaemonEndpointContext, cwd: string, input: { readonly ttlMs?: number } = {}): Promise<{ readonly manifest: WorkspaceSnapshotManifest; readonly entries: readonly WorkspaceSnapshotEntry[] }> {
      return this._post("/workspace/snapshots", { cwd }, input);
  },

  async createWorkspaceSnapshotAnchor(this: LingDaemonEndpointContext, cwd: string, snapshotId: string): Promise<import("@ling-stack/contracts").WorkspaceSnapshotRestoreAnchor> {
      return this._post(`/workspace/snapshots/${encodeURIComponent(snapshotId)}/anchors`, { cwd }, {});
  },

  async createWorkspaceSnapshotConfirmation(this: LingDaemonEndpointContext, cwd: string, snapshotId: string, input: { readonly anchorId: string }): Promise<SnapshotRestoreConfirmation> {
      return this._post(`/workspace/snapshots/${encodeURIComponent(snapshotId)}/confirmations`, { cwd }, input);
  },

  async confirmWorkspaceSnapshotRestore(this: LingDaemonEndpointContext, cwd: string, confirmationId: string): Promise<SnapshotRestoreConfirmation> {
      return this._post(`/workspace/snapshot-confirmations/${encodeURIComponent(confirmationId)}/confirm`, { cwd }, { state: "confirmed" });
  },

  async restoreWorkspaceSnapshot(this: LingDaemonEndpointContext, cwd: string, snapshotId: string, input: { readonly idempotencyKey: string; readonly anchorId: string; readonly confirmationId: string; readonly expectedWorkspaceFingerprint?: string; readonly expectedProvenanceWatermark?: string }): Promise<SnapshotRestoreRequest> {
      return this._post(`/workspace/snapshots/${encodeURIComponent(snapshotId)}/restore`, { cwd }, input);
  },

  async getWorkspaceSnapshotRestore(this: LingDaemonEndpointContext, cwd: string, requestId: string): Promise<SnapshotRestoreRequest> {
      return this._get(`/workspace/snapshot-restores/${encodeURIComponent(requestId)}`, { cwd });
  },

  async getWorkspaceFileOpenOptions(this: LingDaemonEndpointContext, cwd: string, path: string): Promise<WorkspaceFileOpenOptionsResponse> {
      return this._get("/workspace-files/open-options", { cwd, path });
    },

  async openWorkspaceFile(this: LingDaemonEndpointContext, cwd: string, path: string, input: WorkspaceFileOpenRequest): Promise<WorkspaceFileOpenResponse> {
      return this._post("/workspace-files/open", { cwd, path }, input);
    },

  async openWorkspaceFileCapability(this: LingDaemonEndpointContext, input: WorkspaceFileOpenRequest): Promise<WorkspaceFileOpenResponse> {
      return this._post("/workspace-files/open", {}, input);
    },

  workspaceFileOpenIconUrl(this: LingDaemonEndpointContext, cwd: string, target: WorkspaceFileOpenTarget): string {
      return this._url(`/workspace-files/open-icons/${encodeURIComponent(target)}`, { cwd });
    },

  workspaceFileContentUrl(this: LingDaemonEndpointContext, cwd: string, path: string, download = false): string {
      return this._url("/workspace-files/content", { cwd, path, download: download ? 1 : undefined });
    },
};

export type OperationEndpoints = PublicEndpointGroup<typeof operationEndpoints>;
