import type {
  ListWorkItemsRequest,
  WorkItemClaimRequest,
  WorkItemClaimResponse,
  WorkItemHeartbeatRequest,
  WorkItemListResponse,
  WorkItemMutationResponse,
} from "../types.js";
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
