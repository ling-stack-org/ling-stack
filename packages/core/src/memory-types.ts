import { randomUUID } from "node:crypto";

export type MemoryScopeType = "workspace" | "channel" | "teammate" | "task" | "run";

export type MemorySourceType =
  | "manual"
  | "message"
  | "decision"
  | "doc"
  | "attachment"
  | "run-event"
  | "artifact"
  | "import";

export type MemoryReviewState = "candidate" | "active" | "disabled" | "archived" | "rejected";

export type MemorySensitivity = "normal" | "private" | "secret-adjacent";

export interface MemorySourceRef {
  readonly type: MemorySourceType;
  readonly id: string;
  readonly label?: string;
  readonly url?: string;
}

export interface MemoryObject {
  readonly id: string;
  readonly workspaceId: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRef[];
  readonly reviewState: MemoryReviewState;
  readonly enabled: boolean;
  readonly sensitivity: MemorySensitivity;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt?: string;
}

export interface CreateMemoryObjectInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly scopeType: MemoryScopeType;
  readonly ownerId: string;
  readonly title: string;
  readonly body: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly retrievalProviderId?: string;
  readonly retrievalHandle?: string;
  readonly createdBy?: string;
}

export interface MemoryObjectUpdateInput {
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
  readonly sourceRefs?: readonly MemorySourceRef[];
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly retrievalProviderId?: string | null;
  readonly retrievalHandle?: string | null;
  readonly createdBy?: string | null;
  readonly lastUsedAt?: string | null;
}

export interface ListMemoryObjectsOptions {
  readonly workspaceId?: string;
  readonly scopeType?: MemoryScopeType;
  readonly ownerId?: string;
  readonly reviewState?: MemoryReviewState;
  readonly enabled?: boolean;
  readonly sensitivity?: MemorySensitivity;
  readonly tag?: string;
  readonly limit?: number;
}

export type MemoryRecallIntent = "private-chat" | "channel-reply" | "task-run" | "review" | "search";

export interface MemoryRecallRequest {
  readonly workspaceId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly intent: MemoryRecallIntent;
  readonly query: string;
  readonly tags?: readonly string[];
  readonly maxResults?: number;
  readonly includePrivate?: boolean;
  readonly includeDisabled?: boolean;
  readonly includeSecretAdjacent?: boolean;
}

export interface RecalledMemory {
  readonly memory: MemoryObject;
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly excerpt: string;
}

export interface MemoryRecallResult {
  readonly request: MemoryRecallRequest;
  readonly memories: readonly RecalledMemory[];
  readonly policyVersion: string;
}

export interface UsedMemoryEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly memoryIds: readonly string[];
  readonly intent: MemoryRecallIntent;
  readonly recallQuery: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly policyVersion: string;
  readonly createdAt: string;
}

export interface CreateUsedMemoryEventInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly memoryIds: readonly string[];
  readonly intent: MemoryRecallIntent;
  readonly recallQuery: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly policyVersion: string;
}

export interface ListUsedMemoryEventsOptions {
  readonly workspaceId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly responseId?: string;
  readonly memoryId?: string;
  readonly limit?: number;
}

export interface MemoryIndexInput {
  readonly memory: MemoryObject;
}

export interface MemoryIndexResult {
  readonly retrievalHandle?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemorySearchInput {
  readonly request: MemoryRecallRequest;
  readonly lexicalCandidates: readonly MemoryObject[];
}

export interface MemorySearchResult {
  readonly memories: readonly RecalledMemory[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryRerankInput {
  readonly request: MemoryRecallRequest;
  readonly memories: readonly RecalledMemory[];
}

export interface MemoryRerankResult {
  readonly memories: readonly RecalledMemory[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface MemoryRetrievalProvider {
  readonly id: string;
  readonly capabilities: {
    readonly embedding: boolean;
    readonly vectorSearch: boolean;
    readonly rerank: boolean;
  };
  index?(input: MemoryIndexInput): Promise<MemoryIndexResult>;
  search(input: MemorySearchInput): Promise<MemorySearchResult>;
  rerank?(input: MemoryRerankInput): Promise<MemoryRerankResult>;
}

export function createMemoryObjectId(): string {
  return `memory_${randomUUID().replaceAll("-", "")}`;
}

export function createUsedMemoryEventId(): string {
  return `used_memory_${randomUUID().replaceAll("-", "")}`;
}
