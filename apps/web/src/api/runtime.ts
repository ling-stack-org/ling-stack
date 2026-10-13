import type {
  HarnessDiagnosticQueryV1,
  ListResourceLeasesRequest,
  ResourceLeaseListResponse,
  RunnerListResponse,
  RuntimeDiagnosticsResponse,
  RuntimeExtensionListResponse,
  RuntimeResponse,
  RuntimeSemaphoreListResponse,
  RuntimeSettingsResponse,
  StateEntityType,
  StateTransitionListResponse,
  WorkUnitDetailResponse,
  WorkUnitEventsResponse,
  WorkUnitHarnessDiagnosticsResponse,
  WorkUnitKind,
  WorkUnitListResponse,
  WorkUnitMutationResponse,
  WorkUnitStatus,
  WorkspaceRuntimeSettingsPatch,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listStateTransitions(
  cwd: string,
  options: { readonly entityType?: StateEntityType; readonly entityId?: string; readonly limit?: number } = {},
): Promise<StateTransitionListResponse> {
  return daemonClient.listStateTransitions(cwd, options);
}

export async function listResourceLeases(
  cwd: string,
  options: ListResourceLeasesRequest = {},
): Promise<ResourceLeaseListResponse> {
  return daemonClient.listResourceLeases(cwd, options);
}

export async function getRuntime(cwd: string): Promise<RuntimeResponse> {
  return daemonClient.getRuntime(cwd);
}

export async function listRunners(cwd: string): Promise<RunnerListResponse> {
  return daemonClient.listRunners(cwd);
}

export async function listRuntimeExtensions(cwd: string): Promise<RuntimeExtensionListResponse> {
  return daemonClient.listRuntimeExtensions(cwd);
}

export async function getRuntimeSettings(cwd: string): Promise<RuntimeSettingsResponse> {
  return daemonClient.getRuntimeSettings(cwd);
}

export async function updateRuntimeSettings(cwd: string, input: WorkspaceRuntimeSettingsPatch): Promise<RuntimeSettingsResponse> {
  return daemonClient.updateRuntimeSettings(cwd, input);
}

export async function getRuntimeDiagnostics(cwd: string): Promise<RuntimeDiagnosticsResponse> {
  return daemonClient.getRuntimeDiagnostics(cwd);
}

export async function listRuntimeSemaphores(cwd: string): Promise<RuntimeSemaphoreListResponse> {
  return daemonClient.listRuntimeSemaphores(cwd);
}

export async function listWorkUnits(
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
  return daemonClient.listWorkUnits(cwd, options);
}

export async function getWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitDetailResponse> {
  return daemonClient.getWorkUnit(cwd, workUnitId);
}

export async function getWorkUnitHarnessDiagnostics(cwd: string, workUnitId: string, query: HarnessDiagnosticQueryV1 = {}): Promise<WorkUnitHarnessDiagnosticsResponse> {
  return daemonClient.getWorkUnitHarnessDiagnostics(cwd, workUnitId, query);
}

export async function getWorkUnitEvents(cwd: string, workUnitId: string, afterSeq?: number): Promise<WorkUnitEventsResponse> {
  return daemonClient.getWorkUnitEvents(cwd, workUnitId, afterSeq);
}

export async function cancelWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.cancelWorkUnit(cwd, workUnitId);
}

export async function retryWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.retryWorkUnit(cwd, workUnitId);
}

export async function reconcileWorkUnit(cwd: string, workUnitId: string): Promise<WorkUnitMutationResponse> {
  return daemonClient.reconcileWorkUnit(cwd, workUnitId);
}
