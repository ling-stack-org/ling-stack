import type {
  ListWorkItemsRequest,
  WorkItemClaimRequest,
  WorkItemClaimResponse,
  WorkItemCompleteRequest,
  WorkItemFailRequest,
  WorkItemHeartbeatRequest,
  WorkItemListResponse,
  WorkItemMutationResponse,
  WorkItemReleaseRequest,
} from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function listWorkItems(
  cwd: string,
  options: ListWorkItemsRequest = {},
): Promise<WorkItemListResponse> {
  return daemonClient.listWorkItems(cwd, options);
}

export async function claimWorkItem(
  cwd: string,
  workItemId: string,
  input: WorkItemClaimRequest,
): Promise<WorkItemClaimResponse> {
  return daemonClient.claimWorkItem(cwd, workItemId, input);
}

export async function heartbeatWorkItem(
  cwd: string,
  workItemId: string,
  input: WorkItemHeartbeatRequest,
): Promise<WorkItemMutationResponse> {
  return daemonClient.heartbeatWorkItem(cwd, workItemId, input);
}

export async function releaseWorkItem(
  cwd: string,
  workItemId: string,
  input: WorkItemReleaseRequest,
): Promise<WorkItemMutationResponse> {
  return daemonClient.releaseWorkItem(cwd, workItemId, input);
}

export async function completeWorkItem(
  cwd: string,
  workItemId: string,
  input: WorkItemCompleteRequest,
): Promise<WorkItemMutationResponse> {
  return daemonClient.completeWorkItem(cwd, workItemId, input);
}

export async function failWorkItem(
  cwd: string,
  workItemId: string,
  input: WorkItemFailRequest,
): Promise<WorkItemMutationResponse> {
  return daemonClient.failWorkItem(cwd, workItemId, input);
}
