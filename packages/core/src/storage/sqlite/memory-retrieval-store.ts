import type { SQLOutputValue } from "node:sqlite";
import {
  createUsedMemoryEventId,
  type CreateUsedMemoryEventInput,
  type ListMemoryObjectsOptions,
  type ListUsedMemoryEventsOptions,
  type MemoryObject,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryScopeType,
  type UsedMemoryEvent,
} from "../../memory-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapUsedMemoryEvent } from "./memory-mappers.js";
import { memoryUsedEventSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteMemoryRetrievalStorePorts {
  readonly listMemoryObjects: (options?: ListMemoryObjectsOptions) => MemoryObject[];
}

export class SqliteMemoryRetrievalStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteMemoryRetrievalStorePorts,
  ) {}

  recallMemory(input: MemoryRecallRequest): MemoryRecallResult {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const maxResults = Math.min(Math.max(input.maxResults ?? 8, 1), 20);
    const allowedScopes = memoryRecallAllowedScopes(input, workspaceId);
    if (allowedScopes.length === 0) {
      return { request: { ...input, workspaceId }, memories: [], policyVersion: "ling-memory-v1-lexical" };
    }

    const listOptions: ListMemoryObjectsOptions = {
      workspaceId,
      limit: 500,
    };
    const candidates = this.ports.listMemoryObjects(input.includeDisabled ? listOptions : { ...listOptions, enabled: true })
      .filter((memory) => memoryAllowedForRecall(memory, input, allowedScopes));
    const queryTerms = tokenizeMemoryQuery([input.query, ...(input.tags ?? [])].join(" "));
    const requestedTags = new Set((input.tags ?? []).map((tag) => tag.toLowerCase()));
    const memories = candidates
      .map((memory) => scoreMemoryForRecall(memory, queryTerms, requestedTags))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt))
      .slice(0, maxResults);
    return {
      request: { ...input, workspaceId },
      memories,
      policyVersion: "ling-memory-v1-lexical",
    };
  }

  recordUsedMemoryEvent(input: CreateUsedMemoryEventInput, now: string): UsedMemoryEvent {
    const event: UsedMemoryEvent = {
      id: input.id ?? createUsedMemoryEventId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      memoryIds: normalizeStringList(input.memoryIds),
      intent: input.intent,
      recallQuery: input.recallQuery,
      teammateId: input.teammateId,
      channelId: input.channelId,
      taskId: input.taskId,
      runId: input.runId,
      responseId: input.responseId,
      policyVersion: input.policyVersion,
      createdAt: now,
    };
    if (event.memoryIds.length === 0) {
      throw new Error("memoryIds must contain at least one memory id");
    }

    this.context.database
      .prepare(`
        INSERT INTO memory_used_events (
          id,
          workspace_id,
          memory_ids_json,
          intent,
          recall_query,
          teammate_id,
          channel_id,
          task_id,
          run_id,
          response_id,
          policy_version,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        stringifyJson(event.memoryIds),
        event.intent,
        event.recallQuery,
        event.teammateId ?? null,
        event.channelId ?? null,
        event.taskId ?? null,
        event.runId ?? null,
        event.responseId ?? null,
        event.policyVersion,
        event.createdAt,
      );
    for (const memoryId of event.memoryIds) {
      this.context.database
        .prepare("UPDATE memory_objects SET last_used_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, memoryId);
    }
    return event;
  }

  listUsedMemoryEvents(options: ListUsedMemoryEventsOptions = {}): UsedMemoryEvent[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.teammateId) {
      clauses.push("teammate_id = ?");
      params.push(options.teammateId);
    }
    if (options.channelId) {
      clauses.push("channel_id = ?");
      params.push(options.channelId);
    }
    if (options.taskId) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.runId) {
      clauses.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.responseId) {
      clauses.push("response_id = ?");
      params.push(options.responseId);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const events = this.context.database
      .prepare(`${memoryUsedEventSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapUsedMemoryEvent(row as Record<string, SQLOutputValue>));
    if (!options.memoryId) {
      return events;
    }
    return events.filter((event) => event.memoryIds.includes(options.memoryId as string));
  }
}

function memoryRecallAllowedScopes(
  input: MemoryRecallRequest,
  workspaceId: string,
): readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[] {
  const scopes: Array<{ readonly scopeType: MemoryScopeType; readonly ownerId: string }> = [
    { scopeType: "workspace", ownerId: workspaceId },
  ];
  if (input.channelId) {
    scopes.push({ scopeType: "channel", ownerId: input.channelId });
  }
  if (input.teammateId) {
    scopes.push({ scopeType: "teammate", ownerId: input.teammateId });
  }
  if (input.taskId) {
    scopes.push({ scopeType: "task", ownerId: input.taskId });
  }
  if (input.runId) {
    scopes.push({ scopeType: "run", ownerId: input.runId });
  }
  return scopes;
}

function memoryAllowedForRecall(
  memory: MemoryObject,
  input: MemoryRecallRequest,
  allowedScopes: readonly { readonly scopeType: MemoryScopeType; readonly ownerId: string }[],
): boolean {
  if (!input.includeDisabled && (!memory.enabled || memory.reviewState !== "active")) {
    return false;
  }
  if (!input.includeSecretAdjacent && memory.sensitivity === "secret-adjacent") {
    return false;
  }
  if (
    !input.includePrivate &&
    memory.sensitivity === "private" &&
    input.intent !== "private-chat" &&
    input.intent !== "channel-reply" &&
    input.intent !== "task-run"
  ) {
    return false;
  }
  return allowedScopes.some((scope) => scope.scopeType === memory.scopeType && scope.ownerId === memory.ownerId);
}

function tokenizeMemoryQuery(query: string): readonly string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
  return [...new Set(terms)].slice(0, 32);
}

function scoreMemoryForRecall(
  memory: MemoryObject,
  queryTerms: readonly string[],
  requestedTags: ReadonlySet<string>,
): MemoryRecallResult["memories"][number] {
  const title = memory.title.toLowerCase();
  const body = memory.body.toLowerCase();
  const tags = memory.tags.map((tag) => tag.toLowerCase());
  const sourceLabels = memory.sourceRefs
    .map((ref) => [ref.type, ref.id, ref.label, ref.url].filter((item): item is string => typeof item === "string").join(" ").toLowerCase())
    .join(" ");
  const matchedTerms = new Set<string>();
  let score = 0;

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 8;
      matchedTerms.add(term);
    }
    if (tags.some((tag) => tag.includes(term))) {
      score += 6;
      matchedTerms.add(term);
    }
    if (sourceLabels.includes(term)) {
      score += 3;
      matchedTerms.add(term);
    }
    if (body.includes(term)) {
      score += 2;
      matchedTerms.add(term);
    }
  }

  for (const tag of requestedTags) {
    if (tags.includes(tag)) {
      score += 10;
      matchedTerms.add(tag);
    }
  }

  if (queryTerms.length === 0 && requestedTags.size === 0) {
    score = 1;
  }

  return {
    memory,
    score,
    matchedTerms: [...matchedTerms],
    excerpt: excerptMemoryBody(memory.body, queryTerms),
  };
}

function excerptMemoryBody(body: string, queryTerms: readonly string[]): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  const firstIndex = queryTerms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstIndex - 80);
  const excerpt = normalized.slice(start, start + 240);
  return `${start > 0 ? "..." : ""}${excerpt}${start + 240 < normalized.length ? "..." : ""}`;
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}
