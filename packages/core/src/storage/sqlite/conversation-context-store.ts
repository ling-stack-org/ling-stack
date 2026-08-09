import { randomUUID } from "node:crypto";
import type { SQLOutputValue } from "node:sqlite";
import {
  isContextSegment,
  isConversationContextSummary,
  isConversationDomainRef,
  isTurnContextAssignment,
  type ContextSegment,
  type ConversationContextSummary,
  type ConversationDomainRef,
  type TurnContextAssignment,
} from "@ling-stack/contracts";
import type {
  ApplyTurnContextAssignmentInput,
  ApplyTurnContextAssignmentResult,
  ListContextSegmentsOptions,
  ListConversationContextSummariesOptions,
} from "../../conversation-context-store-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  parseJson,
  parseJsonStringArray,
  readNullableNumber,
  readNullableString,
  readNumber,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteConversationContextStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getContextSegment(segmentId: string): ContextSegment | undefined {
    const row = this.context.database.prepare(`${contextSegmentSelectSql} WHERE id = ?`).get(segmentId);
    return row ? mapContextSegment(row as Record<string, SQLOutputValue>) : undefined;
  }

  listContextSegments(options: ListContextSegmentsOptions): readonly ContextSegment[] {
    const clauses = ["workspace_id = ?", "thread_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.threadId];
    const states = [...new Set(options.states ?? [])];
    if (states.length > 0) {
      clauses.push(`state IN (${states.map(() => "?").join(", ")})`);
      params.push(...states);
    }
    params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
    return this.context.database.prepare(`
      ${contextSegmentSelectSql}
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params).map((row) => mapContextSegment(row as Record<string, SQLOutputValue>));
  }

  getEffectiveTurnContextAssignment(turnId: string): TurnContextAssignment | undefined {
    const row = this.context.database.prepare(`
      ${turnContextAssignmentSelectSql}
      WHERE turn_id = ?
      ORDER BY revision DESC
      LIMIT 1
    `).get(turnId);
    return row ? mapTurnContextAssignment(row as Record<string, SQLOutputValue>) : undefined;
  }

  applyTurnContextAssignment(
    input: ApplyTurnContextAssignmentInput,
    now: string,
  ): ApplyTurnContextAssignmentResult {
    assertCanonicalTimestamp(now);
    if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
      throw new Error(`Context assignment confidence must be between 0 and 1: ${input.confidence}`);
    }
    const evidenceRefs = [...(input.evidenceRefs ?? [])];
    if (evidenceRefs.some((ref) => !isConversationDomainRef(ref))) {
      throw new Error("Context assignment contains an invalid evidence ref.");
    }

    this.context.database.exec("BEGIN IMMEDIATE");
    try {
      const turn = this.context.database.prepare(`
        SELECT workspace_id, thread_id FROM ling_turns WHERE workspace_id = ? AND id = ?
      `).get(DEFAULT_WORKSPACE_ID, input.turnId) as Record<string, SQLOutputValue> | undefined;
      if (!turn) throw new Error(`Ling turn not found for context assignment: ${input.turnId}`);
      const threadId = readString(turn, "thread_id");
      const previousAssignment = this.getEffectiveTurnContextAssignment(input.turnId);
      const segment = this.resolveAssignmentSegment(input, threadId, previousAssignment, now);
      if (input.antecedentTurnId) {
        const antecedent = this.context.database.prepare(`
          SELECT thread_id FROM ling_turns WHERE workspace_id = ? AND id = ?
        `).get(DEFAULT_WORKSPACE_ID, input.antecedentTurnId) as Record<string, SQLOutputValue> | undefined;
        if (!antecedent || readString(antecedent, "thread_id") !== threadId) {
          throw new Error(`Context assignment antecedent is not in the same thread: ${input.antecedentTurnId}`);
        }
      }

      if (previousAssignment && assignmentMatches(previousAssignment, segment.id, input, evidenceRefs)) {
        this.context.database.exec("COMMIT");
        return {
          segment,
          assignment: previousAssignment,
          previousAssignment,
          invalidatedSummaryIds: [],
          idempotentReplay: true,
        };
      }

      const revision = (previousAssignment?.revision ?? 0) + 1;
      const assignment: TurnContextAssignment = {
        id: `assignment_${randomUUID()}`,
        turnId: input.turnId,
        segmentId: segment.id,
        status: input.status,
        revision,
        decisionSource: input.decisionSource,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.antecedentTurnId ? { antecedentTurnId: input.antecedentTurnId } : {}),
        evidenceRefs,
        policyVersion: input.policyVersion,
        ...(previousAssignment ? { supersedesAssignmentId: previousAssignment.id } : {}),
        createdAt: now,
      };
      assertValidTurnContextAssignment(assignment);
      this.context.database.prepare(`
        INSERT INTO turn_context_assignments (
          id, workspace_id, turn_id, segment_id, status, revision, decision_source,
          confidence, antecedent_turn_id, evidence_refs_json, policy_version,
          supersedes_assignment_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        assignment.id,
        DEFAULT_WORKSPACE_ID,
        assignment.turnId,
        assignment.segmentId,
        assignment.status,
        assignment.revision,
        assignment.decisionSource,
        assignment.confidence ?? null,
        assignment.antecedentTurnId ?? null,
        stringifyJson(assignment.evidenceRefs),
        assignment.policyVersion,
        assignment.supersedesAssignmentId ?? null,
        assignment.createdAt,
      );

      const promote = segment.state === "provisional"
        && input.status === "committed"
        && segment.createdFromTurnId !== input.turnId;
      this.context.database.prepare(`
        UPDATE context_segments
        SET state = CASE WHEN ? THEN 'active' ELSE state END,
            last_active_turn_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(promote ? 1 : 0, input.turnId, now, segment.id);

      const invalidatedSummaryIds = previousAssignment && previousAssignment.segmentId !== segment.id
        ? this.invalidateSegmentSummaries([previousAssignment.segmentId, segment.id])
        : [];
      const updatedSegment = this.getContextSegment(segment.id);
      if (!updatedSegment) throw new Error(`Context segment disappeared after assignment: ${segment.id}`);
      this.context.database.exec("COMMIT");
      return {
        segment: updatedSegment,
        assignment,
        ...(previousAssignment ? { previousAssignment } : {}),
        invalidatedSummaryIds,
        idempotentReplay: false,
      };
    } catch (error) {
      if (this.context.database.isTransaction) this.context.database.exec("ROLLBACK");
      throw error;
    }
  }

  getConversationContextSummary(summaryId: string): ConversationContextSummary | undefined {
    const row = this.context.database.prepare(`${conversationContextSummarySelectSql} WHERE id = ?`).get(summaryId);
    return row ? mapConversationContextSummary(row as Record<string, SQLOutputValue>) : undefined;
  }

  listConversationContextSummaries(
    options: ListConversationContextSummariesOptions,
  ): readonly ConversationContextSummary[] {
    const clauses = ["workspace_id = ?", "thread_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.threadId];
    if (options.segmentId) {
      clauses.push("segment_id = ?");
      params.push(options.segmentId);
    }
    const statuses = [...new Set(options.statuses ?? ["active"] as const)];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }
    if (options.throughSequence !== undefined) {
      if (!Number.isSafeInteger(options.throughSequence) || options.throughSequence < 1) {
        throw new RangeError(`Invalid context summary watermark: ${options.throughSequence}`);
      }
      clauses.push("covered_through_sequence <= ?");
      params.push(options.throughSequence);
    }
    params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
    return this.context.database.prepare(`
      ${conversationContextSummarySelectSql}
      WHERE ${clauses.join(" AND ")}
      ORDER BY covered_through_sequence DESC, version DESC, created_at DESC
      LIMIT ?
    `).all(...params).map((row) => mapConversationContextSummary(row as Record<string, SQLOutputValue>));
  }

  private resolveAssignmentSegment(
    input: ApplyTurnContextAssignmentInput,
    threadId: string,
    previousAssignment: TurnContextAssignment | undefined,
    now: string,
  ): ContextSegment {
    if (input.target.kind === "existing") {
      const segment = this.getContextSegment(input.target.segmentId);
      if (!segment || segment.threadId !== threadId || segment.state === "archived" || segment.state === "merged") {
        throw new Error(`Context segment is not assignable in this thread: ${input.target.segmentId}`);
      }
      return segment;
    }
    if (previousAssignment?.policyVersion === input.policyVersion) {
      const previousSegment = this.getContextSegment(previousAssignment.segmentId);
      if (previousSegment?.createdFromTurnId === input.turnId && previousSegment.state === input.target.state) {
        return previousSegment;
      }
    }
    const segment: ContextSegment = {
      id: `segment_${randomUUID()}`,
      threadId,
      state: input.target.state,
      ...(input.target.label?.trim() ? { label: input.target.label.trim().slice(0, 160) } : {}),
      createdFromTurnId: input.turnId,
      lastActiveTurnId: input.turnId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    assertValidContextSegment(segment);
    this.context.database.prepare(`
      INSERT INTO context_segments (
        id, workspace_id, thread_id, state, label, created_from_turn_id,
        last_active_turn_id, merged_into_segment_id, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      segment.id,
      DEFAULT_WORKSPACE_ID,
      segment.threadId,
      segment.state,
      segment.label ?? null,
      segment.createdFromTurnId,
      segment.lastActiveTurnId,
      segment.revision,
      segment.createdAt,
      segment.updatedAt,
    );
    return segment;
  }

  private invalidateSegmentSummaries(segmentIds: readonly string[]): string[] {
    const uniqueIds = [...new Set(segmentIds)];
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.context.database.prepare(`
      SELECT id FROM conversation_context_summaries
      WHERE workspace_id = ? AND status = 'active' AND segment_id IN (${placeholders})
      ORDER BY id
    `).all(DEFAULT_WORKSPACE_ID, ...uniqueIds) as Record<string, SQLOutputValue>[];
    if (rows.length > 0) {
      this.context.database.prepare(`
        UPDATE conversation_context_summaries
        SET status = 'invalidated'
        WHERE workspace_id = ? AND status = 'active' AND segment_id IN (${placeholders})
      `).run(DEFAULT_WORKSPACE_ID, ...uniqueIds);
    }
    return rows.map((row) => readString(row, "id"));
  }
}

const contextSegmentSelectSql = `
  SELECT id, thread_id, state, label, created_from_turn_id, last_active_turn_id,
         merged_into_segment_id, revision, created_at, updated_at
  FROM context_segments
`;

const turnContextAssignmentSelectSql = `
  SELECT id, turn_id, segment_id, status, revision, decision_source, confidence,
         antecedent_turn_id, evidence_refs_json, policy_version,
         supersedes_assignment_id, created_at
  FROM turn_context_assignments
`;

const conversationContextSummarySelectSql = `
  SELECT id, thread_id, segment_id, scope, status, version, covered_from_sequence,
         covered_through_sequence, objective, decisions_json, constraints_json,
         open_questions_json, active_work_refs_json, source_refs_json,
         supersedes_summary_id, policy_version, created_at
  FROM conversation_context_summaries
`;

function mapContextSegment(row: Record<string, SQLOutputValue>): ContextSegment {
  const value = {
    id: readString(row, "id"),
    threadId: readString(row, "thread_id"),
    state: readString(row, "state"),
    ...(readNullableString(row, "label") ? { label: readNullableString(row, "label") } : {}),
    createdFromTurnId: readString(row, "created_from_turn_id"),
    lastActiveTurnId: readString(row, "last_active_turn_id"),
    ...(readNullableString(row, "merged_into_segment_id")
      ? { mergedIntoSegmentId: readNullableString(row, "merged_into_segment_id") }
      : {}),
    revision: readNumber(row, "revision"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  } as unknown;
  assertValidContextSegment(value);
  return value;
}

function mapTurnContextAssignment(row: Record<string, SQLOutputValue>): TurnContextAssignment {
  const evidenceRefs = parseDomainRefs(readString(row, "evidence_refs_json"));
  const value = {
    id: readString(row, "id"),
    turnId: readString(row, "turn_id"),
    segmentId: readString(row, "segment_id"),
    status: readString(row, "status"),
    revision: readNumber(row, "revision"),
    decisionSource: readString(row, "decision_source"),
    ...(readNullableNumber(row, "confidence") !== undefined
      ? { confidence: readNullableNumber(row, "confidence") }
      : {}),
    ...(readNullableString(row, "antecedent_turn_id")
      ? { antecedentTurnId: readNullableString(row, "antecedent_turn_id") }
      : {}),
    evidenceRefs,
    policyVersion: readString(row, "policy_version"),
    ...(readNullableString(row, "supersedes_assignment_id")
      ? { supersedesAssignmentId: readNullableString(row, "supersedes_assignment_id") }
      : {}),
    createdAt: readString(row, "created_at"),
  } as unknown;
  assertValidTurnContextAssignment(value);
  return value;
}

function mapConversationContextSummary(row: Record<string, SQLOutputValue>): ConversationContextSummary {
  const value = {
    id: readString(row, "id"),
    threadId: readString(row, "thread_id"),
    ...(readNullableString(row, "segment_id") ? { segmentId: readNullableString(row, "segment_id") } : {}),
    scope: readString(row, "scope"),
    status: readString(row, "status"),
    version: readNumber(row, "version"),
    coveredFromSequence: readNumber(row, "covered_from_sequence"),
    coveredThroughSequence: readNumber(row, "covered_through_sequence"),
    ...(readNullableString(row, "objective") ? { objective: readNullableString(row, "objective") } : {}),
    decisions: parseJsonStringArray(readString(row, "decisions_json")),
    constraints: parseJsonStringArray(readString(row, "constraints_json")),
    openQuestions: parseJsonStringArray(readString(row, "open_questions_json")),
    activeWorkRefs: parseDomainRefs(readString(row, "active_work_refs_json")),
    sourceRefs: parseDomainRefs(readString(row, "source_refs_json")),
    ...(readNullableString(row, "supersedes_summary_id")
      ? { supersedesSummaryId: readNullableString(row, "supersedes_summary_id") }
      : {}),
    policyVersion: readString(row, "policy_version"),
    createdAt: readString(row, "created_at"),
  } as unknown;
  if (!isConversationContextSummary(value)) {
    throw new Error(`Invalid conversation context summary row: ${readString(row, "id")}`);
  }
  return value;
}

function parseDomainRefs(value: string): ConversationDomainRef[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((ref) => !isConversationDomainRef(ref))) {
    throw new Error("Invalid conversation context domain refs.");
  }
  return parsed;
}

function assignmentMatches(
  assignment: TurnContextAssignment,
  segmentId: string,
  input: ApplyTurnContextAssignmentInput,
  evidenceRefs: readonly ConversationDomainRef[],
): boolean {
  return assignment.segmentId === segmentId
    && assignment.status === input.status
    && assignment.decisionSource === input.decisionSource
    && assignment.confidence === input.confidence
    && assignment.antecedentTurnId === input.antecedentTurnId
    && assignment.policyVersion === input.policyVersion
    && stringifyJson(assignment.evidenceRefs) === stringifyJson(evidenceRefs);
}

function assertValidContextSegment(value: unknown): asserts value is ContextSegment {
  if (!isContextSegment(value)) throw new Error("Context segment failed schema validation.");
}

function assertValidTurnContextAssignment(value: unknown): asserts value is TurnContextAssignment {
  if (!isTurnContextAssignment(value)) throw new Error("Turn context assignment failed schema validation.");
}

function assertCanonicalTimestamp(value: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`Expected canonical ISO timestamp: ${value}`);
  }
}
