import type {
  ApplyMemoryReviewActionRequest,
  CreateMemoryConsolidationJobRequest,
  CreateMemoryObjectRequest,
  MemoryConsolidationJobListResponse,
  MemoryConsolidationJobMutationResponse,
  MemoryHealthRequest,
  MemoryHealthResponse,
  MemoryListResponse,
  MemoryMutationResponse,
  MemoryPromotionInboxResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryReviewMutationResponse,
  MemoryReviewPolicyResponse,
  MemoryReviewPolicyUpdateRequest,
  UpdateMemoryObjectRequest,
  UsedMemoryListResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function listMemoryObjects(cwd: string): Promise<MemoryListResponse> {
  return daemonClient.listMemoryObjects(cwd);
}

export async function createMemoryObject(cwd: string, input: CreateMemoryObjectRequest): Promise<MemoryMutationResponse> {
  return daemonClient.createMemoryObject(cwd, input);
}

export async function getMemoryHealth(cwd: string, options: MemoryHealthRequest = {}): Promise<MemoryHealthResponse> {
  return daemonClient.getMemoryHealth(cwd, options);
}

export async function listMemoryConsolidationJobs(
  cwd: string,
  options: {
    readonly kind?: string;
    readonly status?: string;
    readonly limit?: number;
  } = {},
): Promise<MemoryConsolidationJobListResponse> {
  return daemonClient.listMemoryConsolidationJobs(cwd, options);
}

export async function createMemoryConsolidationJob(cwd: string, input: CreateMemoryConsolidationJobRequest): Promise<MemoryConsolidationJobMutationResponse> {
  return daemonClient.createMemoryConsolidationJob(cwd, input);
}

export async function updateMemoryObject(cwd: string, memoryId: string, input: UpdateMemoryObjectRequest): Promise<MemoryMutationResponse> {
  return daemonClient.updateMemoryObject(cwd, memoryId, input);
}

export async function getMemoryReviewPolicy(cwd: string): Promise<MemoryReviewPolicyResponse> {
  return daemonClient.getMemoryReviewPolicy(cwd);
}

export async function updateMemoryReviewPolicy(cwd: string, input: MemoryReviewPolicyUpdateRequest): Promise<MemoryReviewPolicyResponse> {
  return daemonClient.updateMemoryReviewPolicy(cwd, input);
}

export async function listMemoryPromotionInbox(
  cwd: string,
  options: {
    readonly scopeType?: string;
    readonly ownerId?: string;
    readonly sensitivity?: string;
    readonly limit?: number;
  } = {},
): Promise<MemoryPromotionInboxResponse> {
  return daemonClient.listMemoryPromotionInbox(cwd, options);
}

export async function reviewMemory(cwd: string, memoryId: string, input: ApplyMemoryReviewActionRequest): Promise<MemoryReviewMutationResponse> {
  return daemonClient.reviewMemory(cwd, memoryId, input);
}

export async function recallMemory(cwd: string, input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
  return daemonClient.recallMemory(cwd, input);
}

export async function listUsedMemoryEvents(
  cwd: string,
  options: {
    readonly teammateId?: string;
    readonly channelId?: string;
    readonly taskId?: string;
    readonly runId?: string;
    readonly responseId?: string;
    readonly memoryId?: string;
    readonly limit?: number;
  } = {},
): Promise<UsedMemoryListResponse> {
  return daemonClient.listUsedMemoryEvents(cwd, options);
}
