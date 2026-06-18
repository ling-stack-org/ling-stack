import type {
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
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const operationEndpoints = {
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

  async getWorkItem(this: LingDaemonEndpointContext, cwd: string, workItemId: string): Promise<WorkItemDetailResponse> {
      return this._get(`/work-items/${encodeURIComponent(workItemId)}`, { cwd });
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
};

export type OperationEndpoints = PublicEndpointGroup<typeof operationEndpoints>;