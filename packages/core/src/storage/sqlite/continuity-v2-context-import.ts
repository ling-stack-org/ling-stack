import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isConversationContextSummary } from "@ling-stack/contracts";
import {
  CONTINUITY_V2_IMPORT_POLICY_VERSION,
  continuityV2ImportId,
  insertContinuitySyntheticTurn,
  requiredContinuityMapValue,
  type ContinuityV2ThreadTopology,
} from "./continuity-v2-legacy-types.js";
import { parseJsonStringArray, readNullableString, readNumber, readString, stringifyJson } from "./helpers.js";

export interface ContinuityV2ContextImportReport {
  readonly segmentCount: number;
  readonly assignmentCount: number;
  readonly summaryCount: number;
  readonly invalidatedSummaryCount: number;
}

export function importLegacyConversationContext(
  database: DatabaseSync,
  topology: ContinuityV2ThreadTopology,
  migrationTimestamp: string,
): ContinuityV2ContextImportReport {
  const { segmentCount, assignmentCount } = materializeDefaultSegments(database, migrationTimestamp);
  const { summaryCount, invalidatedSummaryCount } = importLegacySummaries(database, topology, migrationTimestamp);
  updateThreadSequenceCursors(database);
  return { segmentCount, assignmentCount, summaryCount, invalidatedSummaryCount };
}

function materializeDefaultSegments(
  database: DatabaseSync,
  migrationTimestamp: string,
): { readonly segmentCount: number; readonly assignmentCount: number } {
  const continuityThreads = database.prepare(`
    SELECT id, workspace_id, channel_id, created_at
    FROM ling_threads
    WHERE surface_kind IN ('channel_root', 'topic', 'branch')
       OR id IN (SELECT DISTINCT thread_id FROM conversation_items)
    ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  let segmentCount = 0;
  let assignmentCount = 0;
  for (const thread of continuityThreads) {
    const threadId = readString(thread, "id");
    let turns = database.prepare(`
      SELECT id, created_at, updated_at
      FROM ling_turns
      WHERE thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(threadId) as Record<string, SQLOutputValue>[];
    if (turns.length === 0) {
      insertContinuitySyntheticTurn(
        database,
        threadId,
        readNullableString(thread, "channel_id"),
        `empty_thread:${threadId}`,
        readString(thread, "created_at") || migrationTimestamp,
      );
      turns = database.prepare(`
        SELECT id, created_at, updated_at FROM ling_turns WHERE thread_id = ? ORDER BY created_at ASC, id ASC
      `).all(threadId) as Record<string, SQLOutputValue>[];
    }
    const firstTurn = turns[0]!;
    const lastTurn = [...turns].sort((left, right) =>
      readString(right, "updated_at").localeCompare(readString(left, "updated_at"))
      || readString(right, "id").localeCompare(readString(left, "id")))[0]!;
    const segmentId = continuityV2ImportId("segment", threadId);
    database.prepare(`
      INSERT INTO context_segments (
        id, workspace_id, thread_id, state, label, created_from_turn_id,
        last_active_turn_id, merged_into_segment_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL, 1, ?, ?)
    `).run(
      segmentId,
      readString(thread, "workspace_id"),
      threadId,
      "Imported conversation",
      readString(firstTurn, "id"),
      readString(lastTurn, "id"),
      readString(firstTurn, "created_at"),
      readString(lastTurn, "updated_at"),
    );
    segmentCount += 1;
    for (const turn of turns) {
      const turnId = readString(turn, "id");
      database.prepare(`
        INSERT INTO turn_context_assignments (
          id, workspace_id, turn_id, segment_id, status, revision, decision_source,
          confidence, antecedent_turn_id, evidence_refs_json, policy_version,
          supersedes_assignment_id, created_at
        ) VALUES (?, ?, ?, ?, 'committed', 1, 'structural', 1, NULL, '[]', ?, NULL, ?)
      `).run(
        continuityV2ImportId("assignment", turnId),
        readString(thread, "workspace_id"),
        turnId,
        segmentId,
        CONTINUITY_V2_IMPORT_POLICY_VERSION,
        readString(turn, "created_at"),
      );
      assignmentCount += 1;
    }
  }
  return { segmentCount, assignmentCount };
}

function importLegacySummaries(
  database: DatabaseSync,
  topology: ContinuityV2ThreadTopology,
  migrationTimestamp: string,
): { readonly summaryCount: number; readonly invalidatedSummaryCount: number } {
  const summaries = database.prepare(`
    SELECT * FROM channel_context_summaries ORDER BY created_at ASC, id ASC
  `).all() as Record<string, SQLOutputValue>[];
  let summaryCount = 0;
  let invalidatedSummaryCount = 0;
  const versionByScope = new Map<string, number>();
  const activeSummaryByScope = new Map<string, string>();
  for (const summary of summaries) {
    const channelId = readString(summary, "channel_id");
    const targetId = readString(summary, "target_id");
    const topicThreadId = topology.topicThreadByAnchorItemId.get(targetId);
    const targetThreadId = topicThreadId
      ?? (topology.threadChannelById.get(targetId) === channelId ? targetId : undefined)
      ?? requiredContinuityMapValue(topology.rootByChannel, channelId, "summary target thread");
    const sourceMessageIds = parseJsonStringArray(readString(summary, "source_message_ids_json"));
    const sourceItems = sourceMessageIds.flatMap((itemId) => {
      const row = database.prepare("SELECT thread_id, sequence FROM conversation_items WHERE id = ?").get(itemId) as
        | Record<string, SQLOutputValue>
        | undefined;
      return row ? [{ id: itemId, threadId: readString(row, "thread_id"), sequence: readNumber(row, "sequence") }] : [];
    });
    const inTarget = sourceItems.filter((item) => item.threadId === targetThreadId);
    const complete = sourceItems.length === sourceMessageIds.length
      && inTarget.length === sourceMessageIds.length
      && isContiguous(inTarget.map((item) => item.sequence));
    const targetRange = database.prepare(`
      SELECT MIN(sequence) AS minimum, MAX(sequence) AS maximum
      FROM conversation_items
      WHERE thread_id = ?
    `).get(targetThreadId) as Record<string, SQLOutputValue>;
    const fallbackMinimum = numericOrUndefined(targetRange.minimum);
    const fallbackMaximum = numericOrUndefined(targetRange.maximum);
    if (inTarget.length === 0 && (fallbackMinimum === undefined || fallbackMaximum === undefined)) {
      throw new Error(`Continuity v2 migration cannot preserve empty legacy summary: ${readString(summary, "id")}`);
    }
    const sequences = inTarget.map((item) => item.sequence);
    const coveredFrom = sequences.length > 0 ? Math.min(...sequences) : fallbackMinimum!;
    const coveredThrough = sequences.length > 0 ? Math.max(...sequences) : fallbackMaximum!;
    const status = complete ? "active" : "invalidated";
    const segment = database.prepare("SELECT id FROM context_segments WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT 1")
      .get(targetThreadId) as Record<string, SQLOutputValue> | undefined;
    if (!segment) throw new Error(`Continuity v2 migration cannot find summary segment: ${targetThreadId}`);
    const segmentId = readString(segment, "id");
    const scopeKey = `${targetThreadId}:${segmentId}`;
    const version = (versionByScope.get(scopeKey) ?? 0) + 1;
    versionByScope.set(scopeKey, version);
    const previousActiveSummaryId = complete ? activeSummaryByScope.get(scopeKey) : undefined;
    const decisionIds = parseJsonStringArray(readString(summary, "decision_ids_json"));
    const decisions = decisionIds.map((decisionId) => {
      const row = database.prepare("SELECT decision FROM channel_decisions WHERE id = ?").get(decisionId) as
        | Record<string, SQLOutputValue>
        | undefined;
      return row ? readString(row, "decision") : `Legacy decision ${decisionId}`;
    });
    const contextSummary = {
      id: readString(summary, "id"),
      threadId: targetThreadId,
      segmentId,
      scope: "segment" as const,
      status,
      version,
      coveredFromSequence: coveredFrom,
      coveredThroughSequence: coveredThrough,
      objective: readString(summary, "summary"),
      decisions,
      constraints: parseJsonStringArray(readString(summary, "acceptance_criteria_json")),
      openQuestions: parseJsonStringArray(readString(summary, "open_questions_json")),
      activeWorkRefs: readString(summary, "target_type") === "task"
        ? [{ type: "task" as const, id: targetId }]
        : [],
      sourceRefs: sourceItems.map((item) => ({ type: "conversation_item" as const, id: item.id })),
      ...(previousActiveSummaryId ? { supersedesSummaryId: previousActiveSummaryId } : {}),
      policyVersion: CONTINUITY_V2_IMPORT_POLICY_VERSION,
      createdAt: readString(summary, "created_at") || migrationTimestamp,
    };
    if (!isConversationContextSummary(contextSummary)) {
      throw new Error(`Continuity v2 migration cannot represent legacy summary without loss: ${contextSummary.id}`);
    }
    if (previousActiveSummaryId) {
      database.prepare("UPDATE conversation_context_summaries SET status = 'superseded' WHERE id = ?")
        .run(previousActiveSummaryId);
    }
    database.prepare(`
      INSERT INTO conversation_context_summaries (
        id, workspace_id, thread_id, segment_id, scope, status, version,
        covered_from_sequence, covered_through_sequence, objective, decisions_json,
        constraints_json, open_questions_json, active_work_refs_json, source_refs_json,
        supersedes_summary_id, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contextSummary.id,
      readString(summary, "workspace_id"),
      contextSummary.threadId,
      contextSummary.segmentId,
      contextSummary.scope,
      contextSummary.status,
      contextSummary.version,
      contextSummary.coveredFromSequence,
      contextSummary.coveredThroughSequence,
      contextSummary.objective ?? null,
      stringifyJson(contextSummary.decisions),
      stringifyJson(contextSummary.constraints),
      stringifyJson(contextSummary.openQuestions),
      stringifyJson(contextSummary.activeWorkRefs),
      stringifyJson(contextSummary.sourceRefs),
      contextSummary.supersedesSummaryId ?? null,
      contextSummary.policyVersion,
      contextSummary.createdAt,
    );
    if (complete) activeSummaryByScope.set(scopeKey, contextSummary.id);
    summaryCount += 1;
    if (!complete) invalidatedSummaryCount += 1;
  }
  return { summaryCount, invalidatedSummaryCount };
}

function updateThreadSequenceCursors(database: DatabaseSync): void {
  database.exec(`
    UPDATE ling_threads
    SET next_item_sequence = COALESCE((
      SELECT MAX(sequence) + 1 FROM conversation_items WHERE thread_id = ling_threads.id
    ), 1);
  `);
}

function isContiguous(values: readonly number[]): boolean {
  if (values.length === 0) return false;
  const unique = [...new Set(values)].sort((left, right) => left - right);
  return unique.at(-1)! - unique[0]! + 1 === unique.length;
}

function numericOrUndefined(value: SQLOutputValue | undefined): number | undefined {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
}
