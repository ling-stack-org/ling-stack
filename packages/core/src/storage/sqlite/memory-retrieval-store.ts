import type { SQLOutputValue } from "node:sqlite";
import {
  createUsedMemoryEventId,
  type CreateUsedMemoryEventInput,
  type ListUsedMemoryEventsOptions,
  type MemoryObject,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryScopeType,
  type UsedMemoryEvent,
} from "../../memory-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import { mapMemoryObject, mapUsedMemoryEvent } from "./memory-mappers.js";
import { memoryObjectSelectSql, memoryUsedEventSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { hasMemorySearchIndex, memorySearchMatch } from "./memory-search-index.js";

const MEMORY_RECALL_POLICY_VERSION = "ling-memory-v1-lexical-v3";

export class SqliteMemoryRetrievalStore {
  constructor(private readonly context: SqliteStoreContext) {}

  /** Same authority predicate as selection, but only test frozen IDs without decoding any body. */
  getEligibleMemoryIdsForRecall(input: MemoryRecallRequest, memoryIds: readonly string[]): readonly string[] {
    if (memoryIds.length > 20 || memoryIds.some((id) => typeof id !== "string" || !id)) throw new RangeError("Invalid prepared memory IDs.");
    const ids = [...new Set(memoryIds)];
    if (ids.length === 0) return [];
    const { clause, params } = memoryRecallPredicate({ ...input, intent: "task-run", includeDisabled: false,
      includePrivate: false, includeSecretAdjacent: false }, input.workspaceId ?? DEFAULT_WORKSPACE_ID, new Date().toISOString());
    const rows = this.context.database.prepare(`SELECT id FROM memory_objects WHERE ${clause} AND id IN (${ids.map(() => "?").join(",")})`)
      .all(...params, ...ids);
    const eligible = new Set(rows.map((row) => String(row.id)));
    return ids.filter((id) => eligible.has(id));
  }

  recallMemory(input: MemoryRecallRequest): MemoryRecallResult {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    if (!Number.isFinite(input.maxResults ?? 8)) throw new RangeError("Memory recall result limit must be finite.");
    const maxResults = Math.min(Math.max(Math.trunc(input.maxResults ?? 8), 1), 20);
    const requestedTags = new Set((input.tags ?? []).slice(0, 32)
      .map((tag) => tag.slice(0, 256).trim().toLowerCase()).filter(Boolean));
    const queryTerms = tokenizeMemoryQuery([input.query.slice(0, 8_192), ...requestedTags].join(" "));
    const memories: MemoryRecallResult["memories"][number][] = [];
    let candidateCount = 0;
    let strategy: "fts5" | "scan" = "scan";
    // Only an explicitly empty query browses recent memory; a non-matching token is not "show all".
    if (queryTerms.length > 0 || requestedTags.size > 0 || input.query.trim().length === 0) {
      const { clause, params } = memoryRecallPredicate(input, workspaceId, new Date().toISOString());
      const browse = queryTerms.length === 0 && requestedTags.size === 0;
      const match = memorySearchMatch([...queryTerms, ...requestedTags]);
      const indexed = !browse && match !== undefined && [...requestedTags].every(tag => Array.from(tag).length >= 2)
        && hasMemorySearchIndex(this.context.database);
      const candidateFilter = indexed ? ` AND rowid IN (
        SELECT rowid FROM memory_search_fts_v1 WHERE memory_search_fts_v1 MATCH ?
        UNION SELECT source_rowid FROM memory_search_dirty
      )` : "";
      if (indexed) { params.push(match!); strategy = "fts5"; }
      const query = `${memoryObjectSelectSql(`WHERE ${clause}${candidateFilter}`)} ORDER BY updated_at DESC, id DESC${browse ? " LIMIT ?" : ""}`;
      // A single SQLite statement holds one snapshot. Scope/health filters precede body decoding.
      // Stream all eligible candidates and retain only top-k; never truncate the candidate universe by recency.
      for (const row of this.context.database.prepare(query).iterate(...params, ...(browse ? [maxResults] : []))) {
        candidateCount++;
        const candidate = scoreMemoryForRecall(mapMemoryObject(row as Record<string, SQLOutputValue>), queryTerms, requestedTags);
        if (candidate.score <= 0) continue;
        if (memories.length === maxResults && compareRecalledMemory(candidate, memories.at(-1)!) >= 0) continue;
        memories.push(candidate);
        memories.sort(compareRecalledMemory);
        if (memories.length > maxResults) memories.pop();
      }
    }
    return {
      request: { ...input, workspaceId },
      memories,
      policyVersion: MEMORY_RECALL_POLICY_VERSION,
      audit: { strategy, candidateCount, selectedMemoryIds: memories.map(item => item.memory.id) },
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
        .prepare("UPDATE memory_objects SET last_used_at = ? WHERE id = ? AND workspace_id = ?")
        .run(now, memoryId, event.workspaceId);
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

function memoryRecallPredicate(
  input: MemoryRecallRequest,
  workspaceId: string,
  now: string,
): { readonly clause: string; readonly params: (string | number)[] } {
  const scopes = memoryRecallAllowedScopes(input, workspaceId);
  const clauses = ["workspace_id = ?", `(${scopes.map(() => "(scope_type = ? AND owner_id = ?)").join(" OR ")})`];
  const params: (string | number)[] = [workspaceId, ...scopes.flatMap((scope) => [scope.scopeType, scope.ownerId])];
  const inspection = input.intent === "review" || input.intent === "search";
  const inspectInactive = input.includeDisabled === true && inspection;
  if (!inspectInactive) {
    clauses.push("enabled = 1 AND review_state = 'active'");
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM memory_self_improving_metadata AS health
      WHERE health.memory_id = memory_objects.id AND (
        health.superseded_by IS NOT NULL OR
        (health.valid_until IS NOT NULL AND (julianday(health.valid_until) IS NULL OR julianday(health.valid_until) <= julianday(?)))
      )
    )`);
    params.push(now);
  }
  if (!(input.includeSecretAdjacent === true && inspection)) {
    clauses.push("sensitivity != 'secret-adjacent'");
  }
  if (!(input.includePrivate === true && inspection)) {
    if (inspection) {
      clauses.push("sensitivity != 'private'");
    } else {
      // Ownership was filtered above using Host-selected scopes. A shared workspace/channel
      // record can be private without belonging to a teammate; this does not permit quoting
      // it publicly or widen the selected channel/workspace. Inspection flags grant nothing.
      const privateScopes = ["scope_type IN ('workspace', 'channel')"];
      if (input.teammateId) {
        privateScopes.push("(scope_type = 'teammate' AND owner_id = ?)");
        params.push(input.teammateId);
      }
      clauses.push(`(sensitivity != 'private' OR ${privateScopes.join(" OR ")})`);
    }
  }
  return { clause: clauses.join(" AND "), params };
}

function tokenizeMemoryQuery(query: string): readonly string[] {
  const terms = new Set<string>();
  const words = query.toLowerCase().replace(/(\p{Script=Han}+)/gu, " $1 ").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const word of words) {
    const characters = Array.from(word);
    if (characters.length < 2) continue;
    terms.add(word);
    if (/^\p{Script=Han}+$/u.test(word)) {
      for (let index = 0; index + 1 < characters.length && terms.size < 32; index++) {
        terms.add(characters[index]! + characters[index + 1]!);
      }
    }
    if (terms.size >= 32) break;
  }
  return [...terms];
}

function compareRecalledMemory(left: MemoryRecallResult["memories"][number], right: MemoryRecallResult["memories"][number]): number {
  return right.score - left.score || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
    || right.memory.id.localeCompare(left.memory.id);
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
    if (memory.id.toLowerCase() === term) {
      score += 24;
      matchedTerms.add(term);
    }
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
