import { createHash } from "node:crypto";
import type { ConversationContextSummary, ConversationItemV1, TurnContextAssignment } from "@ling-stack/contracts";
import type { LingThread, LingTurn, LingTurnRun, RunEventEnvelope, RunSession } from "@ling-stack/core";
import { ConversationNarrationAccumulator } from "./narration-segments.js";

/** Captured before execution; this is a Run event cursor, never an Item sequence. */
export interface NormalContextRunEventWatermark {
  readonly runId: string;
  readonly throughEventSequence: number;
  readonly throughEventId: string;
}

export type NormalContextSourceRef =
  | { readonly kind: "conversation_item"; readonly id: string; readonly sequence: number; readonly revision: number }
  | { readonly kind: "turn"; readonly id: string; readonly updatedAt: string }
  | { readonly kind: "run"; readonly id: string }
  | { readonly kind: "run_event"; readonly id: string; readonly runId: string; readonly sequence: number }
  | { readonly kind: "context_summary"; readonly id: string; readonly version: number };

interface NormalContextEntryBase {
  readonly role: "user" | "assistant" | "context";
  readonly text: string;
  readonly sourceRefs: readonly NormalContextSourceRef[];
}

/** Context-only records. No variant is a Timeline item or an execution anchor. */
export type NormalContextEntry = NormalContextEntryBase & (
  | { readonly origin: "canonical_item"; readonly turnId: string }
  | { readonly origin: "legacy_turn_user"; readonly turnId: string }
  | { readonly origin: "run_narration"; readonly turnId: string; readonly runId: string; readonly completed: boolean }
  | { readonly origin: "terminal_report"; readonly turnId: string; readonly reportId: string }
  | { readonly origin: "context_summary"; readonly summaryId: string }
);

export interface NormalContextTerminalReportFact {
  readonly reportId: string;
  readonly outcomeStatus: "succeeded" | "partially_succeeded" | "blocked" | "failed" | "cancelled";
  readonly unresolvedRisks: readonly string[];
}

export interface NormalContextHydrationDiagnostic {
  readonly code: "invalid_history_owner" | "ambiguous_history" | "unverified_run_owner" | "invalid_event_boundary" | "invalid_summary" | "budget_exceeded";
  readonly turnId?: string;
}

export interface HydrateNormalConversationContextInput {
  readonly thread: LingThread;
  readonly sourceTurn: LingTurn;
  readonly sourceItem: ConversationItemV1;
  /**
   * Shared-projector admitted items plus scope-checked legacy items whose Turns
   * have no assignment. Never pass an unfiltered thread-wide scan or UI text.
   */
  readonly canonicalItems: readonly ConversationItemV1[];
  /** Host-verified facts for admitted, published report anchors only. */
  readonly terminalReportFactsByItemId?: ReadonlyMap<string, NormalContextTerminalReportFact>;
  /**
   * Shared-projector admitted, source-visibility-checked summaries. Sources absent
   * from the captured tail must already be verified upstream; no lookups occur here.
   */
  readonly contextSummaries?: readonly ConversationContextSummary[];
  /** Effective canonical segment plus captured assignment history, including omissions. */
  readonly contextSegmentId: string;
  readonly turnContextAssignments: readonly TurnContextAssignment[];
  /** Captured historical candidates; no store, I/O or late history reads here. */
  readonly turns: readonly LingTurn[];
  readonly runLinks: readonly LingTurnRun[];
  readonly runs: readonly RunSession[];
  readonly eventsByRunId: ReadonlyMap<string, readonly RunEventEnvelope[]>;
  readonly runEventWatermarks: readonly NormalContextRunEventWatermark[];
  /** Collector proved a canonical reply exists but was excluded by the shared projector. */
  readonly excludedRunNarrationIds?: readonly string[];
  readonly supersededTurnIds?: readonly string[];
  /** One body-text budget shared by canonical, summary and hydrated entries. */
  readonly maxHistoryTextChars?: number;
}

export interface NormalConversationContextHydration {
  readonly schemaVersion: 1;
  readonly source: { readonly threadId: string; readonly turnId: string; readonly itemId: string; readonly throughItemSequence: number; readonly itemRevision: number };
  readonly entries: readonly NormalContextEntry[];
  readonly sourceRefs: readonly NormalContextSourceRef[];
  readonly runEventWatermarks: readonly NormalContextRunEventWatermark[];
  readonly diagnostics: readonly NormalContextHydrationDiagnostic[];
  readonly usedTextChars: number;
  readonly fingerprint: string;
}

/**
 * Hydrate an immutable normal-context snapshot from canonical facts and exact
 * legacy Turn/Run provenance. Canonical reply identity wins over event replay;
 * current input, superseded owners and post-capture events never become history.
 * This pure function cannot persist items, mint anchors, or choose UI owners.
 */
export function hydrateNormalConversationContext(input: HydrateNormalConversationContextInput): NormalConversationContextHydration {
  const { sourceTurn, sourceItem, thread } = input;
  if (thread.kind !== "conversation" || thread.channelId || thread.workflowStepId || thread.archivedAt || thread.status === "archived" ||
    sourceTurn.status === "superseded" || input.supersededTurnIds?.includes(sourceTurn.id) ||
    !ownedTurn(sourceTurn, thread) || sourceTurn.sourceItemId !== sourceItem.id ||
    sourceItem.turnId !== sourceTurn.id || sourceItem.kind !== "user_message" || !inputActorMatches(sourceItem, sourceTurn) ||
    !ownedItem(sourceItem, thread) || !Number.isSafeInteger(sourceItem.sequence) || sourceItem.sequence < 1) {
    throw new Error("Normal context source scope mismatch");
  }
  const budget = input.maxHistoryTextChars ?? 32_768;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 256_000) throw new RangeError("Invalid normal history text budget");
  const diagnostics: NormalContextHydrationDiagnostic[] = [];
  const superseded = new Set(input.supersededTurnIds ?? []);
  const turnsById = groupById(input.turns);
  const canonicalById = groupById(input.canonicalItems);
  const groups: { turnId?: string; entries: NormalContextEntry[] }[] = [];
  const usedWatermarks = new Map<string, NormalContextRunEventWatermark>();
  const canonicalCandidates = input.canonicalItems.filter((item) => ownedItem(item, thread) && item.sequence < sourceItem.sequence &&
    Number.isSafeInteger(item.sequence) && item.sequence > 0 && canonicalById.get(item.id)?.length === 1);
  const canonical = canonicalCandidates.filter((item) => !canonicalCandidates.some((replacement) =>
    replacement.supersedesItemId === item.id && replacement.sequence > item.sequence));
  const summaryOwners: LingTurn[] = [];
  const historical = [...turnsById.values()].flatMap((rows) => {
    const turn = rows[0]!;
    if (turn.id === sourceTurn.id) return [];
    if (rows.length !== 1) { diagnostics.push({ code: "ambiguous_history" }); return []; }
    if (!ownedTurn(turn, thread) || turn.status === "superseded" || superseded.has(turn.id) ||
      turn.createdAt > sourceTurn.createdAt || (turn.createdAt === sourceTurn.createdAt &&
        !canonical.some((item) => item.turnId === turn.id && item.kind === "user_message"))) {
      diagnostics.push({ code: "invalid_history_owner" });
      return [];
    }
    const assignments = input.turnContextAssignments.filter((assignment) => assignment.turnId === turn.id);
    if (assignments.length > 0) {
      const revision = Math.max(...assignments.map((assignment) => assignment.revision));
      const latest = assignments.filter((assignment) => assignment.revision === revision);
      // An assigned Turn omitted by the shared projector is not a legacy hole.
      // Never resurrect another segment, an invalid decision, or a budget cut.
      if (latest.length !== 1 || !["committed", "provisional"].includes(latest[0]!.status) ||
        latest[0]!.segmentId !== input.contextSegmentId) return [];
    }
    // A valid summary owner can be absent from the canonical tail precisely
    // because the summary already covers it. That is not permission to hydrate it.
    summaryOwners.push(turn);
    if (assignments.length > 0 && !canonical.some((item) => item.turnId === turn.id)) return [];
    return [turn];
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const summaryOwnerIds = new Set(summaryOwners.map((turn) => turn.id));
  const summaries = (input.contextSummaries ?? []).filter((summary) => {
    const valid = summary.threadId === thread.id && summary.status === "active" &&
      (!summary.segmentId || summary.segmentId === input.contextSegmentId) &&
      Number.isSafeInteger(summary.coveredFromSequence) && summary.coveredFromSequence > 0 &&
      Number.isSafeInteger(summary.coveredThroughSequence) && summary.coveredThroughSequence >= summary.coveredFromSequence &&
      summary.coveredThroughSequence < sourceItem.sequence && summary.sourceRefs.every((ref) => {
        if (ref.type === "thread") return ref.id === thread.id;
        if (ref.type === "turn") return ref.id !== sourceTurn.id && !superseded.has(ref.id) &&
          (!turnsById.has(ref.id) || summaryOwnerIds.has(ref.id));
        if (ref.type === "conversation_item" || ref.type === "message") {
          if (ref.id === sourceItem.id) return false;
          const rows = canonicalById.get(ref.id);
          if (!rows) return true; // Shared projector owns visibility for sources outside the captured tail.
          const item = rows[0]!;
          return rows.length === 1 && canonical.includes(item) && Boolean(item.turnId && summaryOwnerIds.has(item.turnId)) &&
            item.sequence >= summary.coveredFromSequence && item.sequence <= summary.coveredThroughSequence;
        }
        if (ref.type === "run" && input.runLinks.some((link) => link.runId === ref.id)) {
          return summaryOwners.some((turn) => selectedRun(input, turn)?.id === ref.id);
        }
        return true;
      });
    if (!valid) diagnostics.push({ code: "invalid_summary" });
    return valid && Boolean(summaryText(summary).trim());
  });
  for (const summary of summaries) {
    const text = summaryText(summary);
    if (text) groups.push({ entries: [{ origin: "context_summary", role: "context", summaryId: summary.id, text,
      sourceRefs: [{ kind: "context_summary", id: summary.id, version: summary.version }] }] });
  }
  for (const turn of historical) {
    const entries: NormalContextEntry[] = [];
    const items = canonical.filter((item) => item.turnId === turn.id).sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
    const rawUsers = input.canonicalItems.filter((item) => item.turnId === turn.id && item.kind === "user_message" && item.sequence < sourceItem.sequence);
    const users = items.filter((item): item is Extract<ConversationItemV1, { kind: "user_message" }> =>
      item.kind === "user_message" && verifiedUserSource(item, turn, canonicalCandidates));
    const userCovered = users.some((item) => summaries.some((summary) => summaryCoversItem(summary, item)));
    if (!userCovered) {
      if (users.length === 1) entries.push(canonicalEntry(users[0]!, users[0]!.actorType === "system" ? "context" : "user", turn.id));
      else if (rawUsers.length === 0 && !input.turnContextAssignments.some((assignment) => assignment.turnId === turn.id) &&
        turn.createdByActor === "local-user" && turn.userInstruction.trim()) {
        entries.push({ origin: "legacy_turn_user", role: "user", turnId: turn.id, text: turn.userInstruction,
          sourceRefs: [{ kind: "turn", id: turn.id, updatedAt: turn.updatedAt }] });
      } else if (rawUsers.length > 0) diagnostics.push({ code: "ambiguous_history", turnId: turn.id });
    }
    const selection = selectedRun(input, turn);
    if (!selection && (turn.activeRunId || turn.lastRunId || input.runLinks.some((link) => link.turnId === turn.id))) {
      diagnostics.push({ code: "unverified_run_owner", turnId: turn.id });
    }
    if (selection) {
      const replies = items.filter((item): item is Extract<ConversationItemV1, { kind: "assistant_message" }> =>
        item.kind === "assistant_message" && (item.payload.presentationRole === "narration" || !!item.payload.runNarration) &&
        item.domainRefs.filter((ref) => ref.type === "run").length === 1 &&
        item.domainRefs.some((ref) => ref.type === "run" && ref.id === selection.id));
      const runCovered = summaries.some((summary) => summary.sourceRefs.some((ref) =>
        ref.type === "run" && ref.id === selection.id && ["succeeded", "failed", "cancelled"].includes(selection.status) && selection.updatedAt <= summary.createdAt));
      if (replies.length > 0) {
        entries.push(...replies.filter((item) => !summaries.some((summary) => summaryCoversItem(summary, item)))
          .map((item) => canonicalEntry(item, "assistant", turn.id)));
      } else if (!runCovered && !input.excludedRunNarrationIds?.includes(selection.id)) {
        const frozen = frozenRunEvents(input, selection.id);
        if (!frozen) diagnostics.push({ code: "invalid_event_boundary", turnId: turn.id });
        else {
          const fold = new ConversationNarrationAccumulator();
          frozen.events.forEach((event) => fold.append(event));
          for (const segment of fold.snapshot().narrationSegments) if (segment.content.trim()) entries.push({
            origin: "run_narration", role: "assistant", turnId: turn.id, runId: selection.id,
            completed: segment.completed, text: segment.content,
            sourceRefs: [{ kind: "turn", id: turn.id, updatedAt: turn.updatedAt }, { kind: "run", id: selection.id },
              { kind: "run_event", id: segment.firstEventId, runId: selection.id, sequence: segment.startEventSequence },
              { kind: "run_event", id: segment.lastEventId, runId: selection.id, sequence: segment.endEventSequence }],
          });
          usedWatermarks.set(selection.id, frozen.watermark);
        }
      }
    }
    const reports = items.filter((item): item is Extract<ConversationItemV1, { kind: "terminal_report" }> =>
      item.kind === "terminal_report");
    const latestBySource = new Map<string, typeof reports[number]>();
    for (const item of reports) {
      const key = `${item.payload.sourceKind}:${item.payload.sourceId}`;
      const previous = latestBySource.get(key);
      if (!previous || previous.payload.generation < item.payload.generation) latestBySource.set(key, item);
    }
    for (const item of latestBySource.values()) {
      const fact = input.terminalReportFactsByItemId?.get(item.id);
      if (!fact || summaries.some((summary) => summaryCoversItem(summary, item))) continue;
      entries.push({ origin: "terminal_report", role: "context", turnId: turn.id, reportId: fact.reportId,
        text: JSON.stringify({ hostTerminalOutcome: fact.outcomeStatus, unresolvedRisksAtCompletion: fact.unresolvedRisks }),
        sourceRefs: [{ kind: "conversation_item", id: item.id, sequence: item.sequence, revision: item.revision }] });
    }
    if (entries.length > 0) groups.push({ turnId: turn.id, entries });
  }
  const kept: typeof groups = [];
  let usedTextChars = 0;
  for (const group of [...groups].reverse()) {
    const size = group.entries.reduce((total, entry) => total + entry.text.length, 0);
    if (usedTextChars + size > budget) { diagnostics.push({ code: "budget_exceeded", ...(group.turnId ? { turnId: group.turnId } : {}) }); continue; }
    usedTextChars += size;
    kept.push(group);
  }
  const entries = kept.reverse().flatMap((group) => group.entries);
  const eventRunIds = new Set(entries.flatMap((entry) => entry.origin === "run_narration" ? [entry.runId] : []));
  const snapshot = {
    schemaVersion: 1 as const,
    source: { threadId: thread.id, turnId: sourceTurn.id, itemId: sourceItem.id, throughItemSequence: sourceItem.sequence, itemRevision: sourceItem.revision },
    entries,
    sourceRefs: uniqueRefs(entries.flatMap((entry) => entry.sourceRefs)),
    runEventWatermarks: [...eventRunIds].map((runId) => ({ ...usedWatermarks.get(runId)! })),
    diagnostics, usedTextChars,
  };
  return deepFreeze({ ...snapshot, fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") });
}

function ownedTurn(turn: LingTurn, thread: LingThread): boolean {
  return turn.workspaceId === thread.workspaceId && turn.threadId === thread.id && !turn.channelId && !turn.workflowStepId &&
    (!turn.teammateId || turn.teammateId === (thread.teammateId ?? "ling_agent"));
}

function ownedItem(item: ConversationItemV1, thread: LingThread): boolean {
  return item.workspaceId === thread.workspaceId && item.threadId === thread.id && !item.channelId &&
    item.status === "committed" && item.visibility === "thread_participants" && !item.visibilityOwnerId &&
    (item.kind !== "user_message" || item.actorType === "local_user" || item.actorType === "system") &&
    (item.kind !== "assistant_message" || (item.actorType === "ling_agent" && (!item.actorId || item.actorId === (thread.teammateId ?? "ling_agent"))));
}

/** Follow only captured, same-Turn, strictly older supersessions to the real source. */
function verifiedUserSource(item: ConversationItemV1, turn: LingTurn, candidates: readonly ConversationItemV1[]): boolean {
  if (!turn.sourceItemId || !inputActorMatches(item, turn)) return false;
  let current: ConversationItemV1 | undefined = item;
  while (current) {
    if (current.kind !== "user_message" || !inputActorMatches(current, turn) || current.turnId !== turn.id ||
      current.domainRefs.some((ref) => ref.type === "turn" && ref.id !== turn.id)) return false;
    if (current.id === turn.sourceItemId || current.supersedesItemId === turn.sourceItemId) return true;
    const previous: ConversationItemV1 | undefined = candidates.find((candidate) => candidate.id === current!.supersedesItemId);
    current = previous && previous.sequence < current.sequence ? previous : undefined;
  }
  return false;
}

function inputActorMatches(item: ConversationItemV1, turn: LingTurn): boolean {
  return (item.actorType === "local_user" && turn.createdByActor === "local-user") ||
    (item.actorType === "system" && turn.createdByActor === "system");
}

function summaryText(summary: ConversationContextSummary): string {
  return [summary.objective, ...summary.decisions, ...summary.constraints, ...summary.openQuestions,
    ...summary.activeWorkRefs.map((ref) => `${ref.type}:${ref.id}`)].filter(Boolean).join("\n");
}

function summaryCoversItem(summary: ConversationContextSummary, item: ConversationItemV1): boolean {
  return item.sequence >= summary.coveredFromSequence && item.sequence <= summary.coveredThroughSequence &&
    item.updatedAt <= summary.createdAt && summary.sourceRefs.some((ref) => ref.type === "conversation_item" && ref.id === item.id);
}

function canonicalEntry(item: Extract<ConversationItemV1, { kind: "user_message" | "assistant_message" }>, role: NormalContextEntry["role"], turnId: string): NormalContextEntry {
  return { origin: "canonical_item", role, turnId, text: item.payload.body,
    sourceRefs: [{ kind: "conversation_item", id: item.id, sequence: item.sequence, revision: item.revision }] };
}

/** Prefer the durable active/last pointer; absent pointers require a unique link. */
function selectedRun(input: HydrateNormalConversationContextInput, turn: LingTurn): RunSession | undefined {
  const links = input.runLinks.filter((link) => link.turnId === turn.id && link.role !== "validation");
  const runId = turn.activeRunId ?? turn.lastRunId ?? (links.length === 1 ? links[0]!.runId : undefined);
  if (!runId || links.filter((link) => link.runId === runId).length !== 1 || input.runLinks.filter((link) => link.runId === runId).length !== 1) return undefined;
  const runs = input.runs.filter((run) => run.id === runId);
  const run = runs.length === 1 ? runs[0] : undefined;
  if (!run || run.threadId !== input.thread.id || run.channelId || run.workflowStepId ||
    (run.teammateId && run.teammateId !== (input.thread.teammateId ?? "ling_agent"))) return undefined;
  const request = run.requestSnapshot;
  if (request && typeof request === "object" && !Array.isArray(request)) {
    for (const [key, expected] of [["threadId", input.thread.id], ["turnId", turn.id], ["teammateId", input.thread.teammateId ?? "ling_agent"]] as const) {
      const actual = Reflect.get(request, key);
      if (actual !== undefined && actual !== expected) return undefined;
    }
  }
  return run;
}

/** Require the complete captured prefix. Conflicting seq/IDs cannot be guessed. */
function frozenRunEvents(input: HydrateNormalConversationContextInput, runId: string): { events: readonly RunEventEnvelope[]; watermark: NormalContextRunEventWatermark } | undefined {
  const watermarks = input.runEventWatermarks.filter((watermark) => watermark.runId === runId);
  if (watermarks.length !== 1) return undefined;
  const watermark = watermarks[0]!;
  if (!Number.isSafeInteger(watermark.throughEventSequence) || watermark.throughEventSequence < 1) return undefined;
  const bySequence = new Map<number, RunEventEnvelope>();
  const ids = new Map<string, number>();
  for (const event of input.eventsByRunId.get(runId) ?? []) {
    if (event.seq > watermark.throughEventSequence) continue;
    if (event.runId !== runId || !event.id.trim() || !Number.isSafeInteger(event.seq) || event.seq < 1) return undefined;
    const previous = bySequence.get(event.seq);
    if ((previous && JSON.stringify(previous) !== JSON.stringify(event)) || (ids.has(event.id) && ids.get(event.id) !== event.seq)) return undefined;
    bySequence.set(event.seq, event);
    ids.set(event.id, event.seq);
  }
  const events = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
  if (events.length !== watermark.throughEventSequence || events.at(-1)?.id !== watermark.throughEventId) return undefined;
  return { events, watermark };
}

function groupById<T extends { readonly id: string }>(values: readonly T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) result.set(value.id, [...(result.get(value.id) ?? []), value]);
  return result;
}

function uniqueRefs(refs: readonly NormalContextSourceRef[]): NormalContextSourceRef[] {
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
