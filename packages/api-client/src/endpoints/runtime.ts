import type {
  RunnerListResponse,
  RunnerReadinessResponse,
  RuntimeExtensionListResponse,
  RuntimeDiagnosticsResponse,
  RuntimeResponse,
  RuntimeSemaphoreListResponse,
  RuntimeSettingsResponse,
  WorkUnitDetailResponse,
  WorkUnitEventsResponse,
  WorkUnitKind,
  WorkUnitListResponse,
  WorkUnitMutationResponse,
  WorkUnitStatus,
  WorkspaceRuntimeSettingsPatch,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const runtimeEndpoints = {
  async getRuntime(this: LingDaemonEndpointContext, cwd: string): Promise<RuntimeResponse> {
      return this._get("/runtime", { cwd });
    },

  async listRunners(this: LingDaemonEndpointContext, cwd: string): Promise<RunnerListResponse> {
      return this._get("/runners", { cwd });
    },

  async getRunnerReadiness(this: LingDaemonEndpointContext, cwd: string, runnerId: string): Promise<RunnerReadinessResponse> {
      return this._get(`/runners/${encodeURIComponent(runnerId)}/readiness`, { cwd });
    },

  async listRuntimeExtensions(this: LingDaemonEndpointContext, cwd: string): Promise<RuntimeExtensionListResponse> {
      return this._get("/runtime/extensions", { cwd });
    },

  async getRuntimeSettings(this: LingDaemonEndpointContext, cwd: string): Promise<RuntimeSettingsResponse> {
      return this._get("/runtime/settings", { cwd });
    },

  async updateRuntimeSettings(this: LingDaemonEndpointContext, cwd: string, input: WorkspaceRuntimeSettingsPatch): Promise<RuntimeSettingsResponse> {
      return this._patch("/runtime/settings", { cwd }, input);
    },

  async getRuntimeDiagnostics(this: LingDaemonEndpointContext, cwd: string): Promise<RuntimeDiagnosticsResponse> {
      return this._get("/runtime/supervisor", { cwd });
    },

  async listRuntimeActive(this: LingDaemonEndpointContext, cwd: string): Promise<WorkUnitListResponse> {
      return this._get("/runtime/active", { cwd });
    },

  async listRuntimeStuck(this: LingDaemonEndpointContext, cwd: string): Promise<WorkUnitListResponse> {
      return this._get("/runtime/stuck", { cwd });
    },

  async listRuntimeSemaphores(this: LingDaemonEndpointContext, cwd: string): Promise<RuntimeSemaphoreListResponse> {
      return this._get("/runtime/semaphores", { cwd });
    },

  async listWorkUnits(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly status?: WorkUnitStatus;
        readonly kind?: WorkUnitKind;
        readonly ownerType?: string;
        readonly ownerId?: string;
        readonly channelId?: string;
        readonly linkedRunId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<WorkUnitListResponse> {
      return this._get("/work-units", {
        cwd,
        status: options.status,
        kind: options.kind,
        ownerType: options.ownerType,
        ownerId: options.ownerId,
        channelId: options.channelId,
        linkedRunId: options.linkedRunId,
        limit: options.limit,
      });
    },

  async getWorkUnit(this: LingDaemonEndpointContext, cwd: string, workUnitId: string): Promise<WorkUnitDetailResponse> {
      return this._get(`/work-units/${encodeURIComponent(workUnitId)}`, { cwd });
    },

  async getWorkUnitEvents(this: LingDaemonEndpointContext, cwd: string, workUnitId: string, afterSeq?: number): Promise<WorkUnitEventsResponse> {
      return this._get(`/work-units/${encodeURIComponent(workUnitId)}/events`, { cwd, afterSeq });
    },

  async cancelWorkUnit(this: LingDaemonEndpointContext, cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
      return this._post(`/work-units/${encodeURIComponent(workUnitId)}/cancel`, { cwd });
    },

  async retryWorkUnit(this: LingDaemonEndpointContext, cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
      return this._post(`/work-units/${encodeURIComponent(workUnitId)}/retry`, { cwd });
    },

  async reconcileWorkUnit(this: LingDaemonEndpointContext, cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
      return this._post(`/work-units/${encodeURIComponent(workUnitId)}/reconcile`, { cwd });
    },
};

export type RuntimeEndpoints = PublicEndpointGroup<typeof runtimeEndpoints>;