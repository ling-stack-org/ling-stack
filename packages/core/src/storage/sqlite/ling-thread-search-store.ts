import type { SQLOutputValue } from "node:sqlite";
import {
  type LingThread,
  type LingThreadSearchField,
  type LingThreadSearchMatch,
  type ListLingThreadsOptions,
  type SearchLingThreadsResult,
} from "../../run-types.js";
import { redactSecrets } from "../../redaction.js";
import { isRecord, omitUndefined, parseJson, readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteLingThreadSearchStorePorts {
  readonly listLingThreads: (options: ListLingThreadsOptions) => LingThread[];
}

export class SqliteLingThreadSearchStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteLingThreadSearchStorePorts,
  ) {}

  searchLingThreads(options: ListLingThreadsOptions & { readonly q: string }): SearchLingThreadsResult {
    const query = normalizeLingThreadSearchQuery(options.q);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const candidates = this.ports.listLingThreads({
      ...options,
      limit: 500,
    });
    if (candidates.length === 0) {
      return { threads: [], matches: [] };
    }
    const matchesByThreadId = new Map<string, LingThreadSearchMatch[]>();
    const threadIds = new Set(candidates.map((thread) => thread.id));

    for (const thread of candidates) {
      addLingThreadSearchMatch(matchesByThreadId, thread, "thread_title", thread.title, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "thread_objective", thread.objective, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.taskId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.workflowStepId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "task_id", thread.externalWorkId, query);
      addLingThreadSearchMatch(matchesByThreadId, thread, "metadata_summary", thread.metadata?.summary, query);
    }

    const threadIdPlaceholders = [...threadIds].map(() => "?").join(", ");
    const turnRows = this.context.database
      .prepare(`
        SELECT id, thread_id, title, user_instruction, task_id, source_turn_id
        FROM ling_turns
        WHERE thread_id IN (${threadIdPlaceholders})
        ORDER BY updated_at DESC, id DESC
        LIMIT 5000
      `)
      .all(...threadIds);
    for (const row of turnRows) {
      const record = row as Record<string, SQLOutputValue>;
      const threadId = readString(record, "thread_id");
      if (!threadIds.has(threadId)) {
        continue;
      }
      const turnId = readString(record, "id");
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "turn_title", readNullableString(record, "title"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "turn_instruction", readNullableString(record, "user_instruction"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(record, "task_id"), query, { turnId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(record, "source_turn_id"), query, { turnId });
    }

    const runRows = this.context.database
      .prepare(`
        SELECT id, thread_id, task_id, task_snapshot_json, summary_path
        FROM run_sessions
        WHERE thread_id IN (${threadIdPlaceholders})
        ORDER BY updated_at DESC, id DESC
        LIMIT 5000
      `)
      .all(...threadIds);
    for (const row of runRows) {
      const record = row as Record<string, SQLOutputValue>;
      const threadId = readNullableString(record, "thread_id");
      if (!threadId || !threadIds.has(threadId)) {
        continue;
      }
      const runId = readString(record, "id");
      const taskSnapshot = parseNullableSearchJsonObject(readString(record, "task_snapshot_json"));
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_id", readNullableString(record, "task_id"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_title", readOptionalSearchString(taskSnapshot, "title"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_prompt", readOptionalSearchString(taskSnapshot, "prompt"), query, { runId });
      addLingThreadSearchMatch(matchesByThreadId, { id: threadId }, "task_title", basenameSearchValue(readNullableString(record, "summary_path")), query, { runId });
    }

    const matchedThreads = candidates
      .filter((thread) => (matchesByThreadId.get(thread.id)?.length ?? 0) > 0)
      .sort((left, right) =>
        bestLingThreadSearchRank(left, matchesByThreadId.get(left.id) ?? [], query) -
        bestLingThreadSearchRank(right, matchesByThreadId.get(right.id) ?? [], query) ||
        right.updatedAt.localeCompare(left.updatedAt) ||
        right.id.localeCompare(left.id)
      )
      .slice(0, limit);
    const visibleThreadIds = new Set(matchedThreads.map((thread) => thread.id));
    const matches = matchedThreads.flatMap((thread) =>
      (matchesByThreadId.get(thread.id) ?? [])
        .slice(0, 5)
        .filter((match) => visibleThreadIds.has(match.threadId))
    );
    return { threads: matchedThreads, matches };
  }
}

function normalizeLingThreadSearchQuery(query: string): string {
  const normalized = query.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized.length < 2) {
    throw new Error("search query must include at least two visible characters");
  }
  if (normalized.length > 128) {
    throw new Error("search query must be at most 128 characters");
  }
  return normalized;
}

function addLingThreadSearchMatch(
  matchesByThreadId: Map<string, LingThreadSearchMatch[]>,
  thread: { readonly id: string },
  field: LingThreadSearchField,
  value: string | undefined | null,
  query: string,
  refs: { readonly turnId?: string; readonly runId?: string } = {},
): void {
  if (!value || !normalizedSearchText(value).includes(query)) {
    return;
  }
  const existing = matchesByThreadId.get(thread.id) ?? [];
  if (existing.some((match) => match.field === field && match.turnId === refs.turnId && match.runId === refs.runId)) {
    return;
  }
  matchesByThreadId.set(thread.id, [
    ...existing,
    omitUndefined({
      threadId: thread.id,
      turnId: refs.turnId,
      runId: refs.runId,
      field,
      snippet: buildSearchSnippet(value, query),
    }),
  ]);
}

function bestLingThreadSearchRank(thread: LingThread, matches: readonly LingThreadSearchMatch[], query: string): number {
  const archivedPenalty = thread.archivedAt || thread.status === "archived" ? 100 : 0;
  const pinnedBonus = thread.pinnedAt ? -5 : 0;
  return Math.min(...matches.map((match) => archivedPenalty + pinnedBonus + lingThreadSearchFieldRank(thread, match, query)));
}

function lingThreadSearchFieldRank(thread: LingThread, match: LingThreadSearchMatch, query: string): number {
  const title = normalizedSearchText(thread.title);
  if (match.field === "thread_title" && title === query) {
    return 0;
  }
  if (match.field === "thread_title" && title.startsWith(query)) {
    return 10;
  }
  if (match.field === "thread_title" || match.field === "thread_objective") {
    return 20;
  }
  if (match.field === "metadata_summary") {
    return 30;
  }
  if (match.field === "task_id" || match.field === "task_title" || match.field === "task_prompt") {
    return 40;
  }
  return 50;
}

function normalizedSearchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function buildSearchSnippet(value: string, query: string): string {
  const redacted = String(redactSecrets(value));
  const normalized = normalizedSearchText(redacted);
  const index = normalized.indexOf(query);
  const start = index > 30 ? index - 30 : 0;
  const end = Math.min(redacted.length, Math.max(index + query.length + 80, 160));
  const snippet = redacted.slice(start, end).trim();
  const prefix = start > 0 ? "..." : "";
  const suffix = end < redacted.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

function parseNullableSearchJsonObject(value: string): Record<string, unknown> | undefined {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function readOptionalSearchString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function basenameSearchValue(value: string | undefined): string | undefined {
  return value?.split(/[\\/]/).filter(Boolean).at(-1);
}
