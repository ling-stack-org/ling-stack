import type {
  ExternalWorkActionCancelRequest,
  ExternalWorkActionDetailResponse,
  ExternalWorkActionExecuteRequest,
  ExternalWorkActionListRequest,
  ExternalWorkActionListResponse,
  ExternalWorkActionMutationResponse,
  ExternalWorkBackgroundMutationResponse,
  ExternalWorkCiTriageDetailResponse,
  ExternalWorkCiTriageListRequest,
  ExternalWorkCiTriageListResponse,
  ExternalWorkGitHubBackgroundStartRequest,
  ExternalWorkPollRequest,
  ExternalWorkPollResponse,
  ExternalWorkReconcileRequest,
  ExternalWorkReconcileResponse,
  ExternalWorkRouteRequest,
  ExternalWorkRouteResponse,
  ExternalWorkSecretConfigureRequest,
  ExternalWorkSecretDeleteRequest,
  ExternalWorkSecretMutationResponse,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
  ExternalWorkWorkflowMutationResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listExternalWorkActions(
  cwd: string,
  options: ExternalWorkActionListRequest = {},
): Promise<ExternalWorkActionListResponse> {
  return daemonClient.listExternalWorkActions(cwd, options);
}

export async function getExternalWorkAction(cwd: string, actionId: string): Promise<ExternalWorkActionDetailResponse> {
  return daemonClient.getExternalWorkAction(cwd, actionId);
}

export async function routeExternalWork(
  cwd: string,
  externalWorkId: string,
  input: ExternalWorkRouteRequest,
): Promise<ExternalWorkRouteResponse> {
  return daemonClient.routeExternalWork(cwd, externalWorkId, input);
}

export async function cancelExternalWorkAction(
  cwd: string,
  actionId: string,
  input: ExternalWorkActionCancelRequest = {},
): Promise<ExternalWorkActionMutationResponse> {
  return daemonClient.cancelExternalWorkAction(cwd, actionId, input);
}

export async function executeExternalWorkAction(
  cwd: string,
  actionId: string,
  input: ExternalWorkActionExecuteRequest = {},
): Promise<ExternalWorkActionMutationResponse> {
  return daemonClient.executeExternalWorkAction(cwd, actionId, input);
}

export async function getExternalWorkStatus(
  cwd: string,
  input: { readonly channelId: string; readonly workflowPath?: string },
): Promise<ExternalWorkStatusResponse> {
  return daemonClient.getExternalWorkStatus(cwd, input);
}

export async function configureExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretConfigureRequest,
): Promise<ExternalWorkSecretMutationResponse> {
  return daemonClient.configureExternalWorkSecret(cwd, input);
}

export async function deleteExternalWorkSecret(
  cwd: string,
  input: ExternalWorkSecretDeleteRequest,
): Promise<ExternalWorkSecretMutationResponse> {
  return daemonClient.deleteExternalWorkSecret(cwd, input);
}

export async function configureExternalWorkWorkflow(
  cwd: string,
  input: ExternalWorkWorkflowConfigureRequest,
): Promise<ExternalWorkWorkflowMutationResponse> {
  return daemonClient.configureExternalWorkWorkflow(cwd, input);
}

export async function pollGitHubExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
  return daemonClient.pollGitHubExternalWork(cwd, input);
}

export async function pollLinearExternalWork(cwd: string, input: ExternalWorkPollRequest): Promise<ExternalWorkPollResponse> {
  return daemonClient.pollLinearExternalWork(cwd, input);
}

export async function reconcileExternalWork(
  cwd: string,
  input: ExternalWorkReconcileRequest = {},
): Promise<ExternalWorkReconcileResponse> {
  return daemonClient.reconcileExternalWork(cwd, input);
}

export async function startGitHubExternalWorkBackground(
  cwd: string,
  input: ExternalWorkGitHubBackgroundStartRequest,
): Promise<ExternalWorkBackgroundMutationResponse> {
  return daemonClient.startGitHubExternalWorkBackground(cwd, input);
}

export async function stopExternalWorkBackground(
  cwd: string,
  schedulerId: string,
): Promise<ExternalWorkBackgroundMutationResponse> {
  return daemonClient.stopExternalWorkBackgroundScheduler(cwd, schedulerId);
}

export async function listGitHubExternalWorkCiTriage(
  cwd: string,
  options: ExternalWorkCiTriageListRequest = {},
): Promise<ExternalWorkCiTriageListResponse> {
  return daemonClient.listGitHubExternalWorkCiTriage(cwd, options);
}

export async function getGitHubExternalWorkCiTriage(cwd: string, triageId: string): Promise<ExternalWorkCiTriageDetailResponse> {
  return daemonClient.getGitHubExternalWorkCiTriage(cwd, triageId);
}
