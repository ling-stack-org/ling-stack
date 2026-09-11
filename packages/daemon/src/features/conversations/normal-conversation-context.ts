import { createHash } from "node:crypto";
import { isConversationContextProjectionMetadata, type ConversationContextProjectionMetadata, type ConversationItemV1 } from "@ling-stack/contracts";
import { redactSecrets, type LingTurn, type RunEventEnvelope, type RunSession, type RunStore } from "@ling-stack/core";
import type { RunRequest } from "../runs/schemas.js";
import { buildConversationContextProjection, isConversationContextItemVisible } from "../channels/context-processing/conversation-context-projector.js";
import { buildConversationSupersessionProjection } from "./supersession-projection.js";
import { hydrateNormalConversationContext, type NormalConversationContextHydration, type NormalContextRunEventWatermark } from "./normal-conversation-context-hydrator.js";
import { inheritNormalForkHistory, isNormalConversationForkHistory, type NormalConversationForkHistory } from "./normal-conversation-fork-history.js";

const POLICY_VERSION = "normal-conversation-context-v1";
const MAX_CAPTURED_EVENTS = 50_000;

/** Internal durable request evidence, not a Timeline item or provider session. */
export interface NormalConversationContextSnapshot {
  readonly schemaVersion: 1;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly projection: ConversationContextProjectionMetadata;
  readonly hydration: NormalConversationContextHydration;
  readonly forkHistory?: NormalConversationForkHistory;
  readonly renderedHistory: string;
  readonly fingerprint: string;
}

interface CaptureNormalConversationContextInput {
  readonly store: RunStore;
  readonly threadId: string;
  readonly sourceItemId: string;
  readonly maxHistoryTextChars?: number;
}

/** Collect once in a real read transaction, before asynchronous preparation starts. */
export function captureNormalConversationContext(input: CaptureNormalConversationContextInput): NormalConversationContextSnapshot {
  return input.store.readSnapshot(() => collectNormalConversationContextWithinSnapshot(input));
}

/** Synchronous collector; caller must own the connection's read-only transaction window. */
export function collectNormalConversationContextWithinSnapshot(input: CaptureNormalConversationContextInput): NormalConversationContextSnapshot {
  const { store } = input;
    const thread = store.getLingThread(input.threadId);
    const sourceItem = store.getConversationItem(input.sourceItemId);
    const sourceTurn = sourceItem?.turnId ? store.getLingTurn(sourceItem.turnId) : undefined;
    if (!thread || thread.kind !== "conversation" || thread.channelId || !sourceItem || !sourceTurn || sourceTurn.threadId !== thread.id) {
      throw new Error("Normal context source scope mismatch");
    }
    const projection = buildConversationContextProjection({ store, sourceItemId: sourceItem.id, view: "reply",
      includeSourceTurnItems: false, maxTailTextChars: input.maxHistoryTextChars ?? 32_768 });
    const candidates = store.listLingTurns({ threadId: thread.id, limit: 500 });
    if (candidates.length === 500) throw new Error("Normal context capture exceeds the bounded Turn window");
    const assignments = candidates.flatMap((turn) => {
      const assignment = store.getEffectiveTurnContextAssignment(turn.id);
      return assignment ? [assignment] : [];
    });
    const assignedIds = new Set(assignments.map((assignment) => assignment.turnId));
    const segments = store.listContextSegments({ threadId: thread.id, limit: 200 });
    const bootstrapAssignment = store.getEffectiveTurnContextAssignment(projection.segment.createdFromTurnId);
    const acceptsLegacy = segments.length === 1 && segments[0]?.id === projection.segment.id &&
      bootstrapAssignment?.segmentId === projection.segment.id && bootstrapAssignment.policyVersion === "continuity-v2-bootstrap-v1";
    const canonicalItems = new Map(projection.items.map((item) => [item.id, item]));
    const rawItemsByTurn = new Map<string, readonly ConversationItemV1[]>();
    const turns = candidates.filter((turn) => {
      if (turn.id === sourceTurn.id || assignedIds.has(turn.id)) return true;
      if (!acceptsLegacy || turn.interventionId || turn.createdAt >= projection.segment.createdAt || !normalTurnOwner(turn, thread)) return false;
      const raw = store.listConversationItemsForTurn({ turnId: turn.id }).filter((item) => item.sequence < sourceItem.sequence);
      rawItemsByTurn.set(turn.id, raw);
      const pointer = turn.sourceItemId ? store.getConversationItem(turn.sourceItemId) : undefined;
      if (pointer && (pointer.threadId !== thread.id || pointer.turnId !== turn.id || pointer.workspaceId !== thread.workspaceId ||
        pointer.channelId || pointer.kind !== "user_message" || pointer.actorType !== "local_user" || pointer.status !== "committed" ||
        !isConversationContextItemVisible(pointer, "reply", undefined) || pointer.sequence >= sourceItem.sequence)) return false;
      // A hidden/stale canonical user is not permission to read Turn.userInstruction instead.
      if (raw.some((item) => item.kind === "user_message" && (item.threadId !== thread.id || item.workspaceId !== thread.workspaceId ||
        item.channelId || item.actorType !== "local_user" || !isConversationContextItemVisible(item, "reply", undefined)))) return false;
      for (const item of raw) if (item.threadId === thread.id && item.workspaceId === thread.workspaceId && !item.channelId &&
        isConversationContextItemVisible(item, "reply", undefined)) canonicalItems.set(item.id, item);
      return true;
    });
    const runLinks = turns.flatMap((turn) => store.listLingTurnRuns(turn.id));
    const runs = [...new Set(runLinks.map((link) => link.runId))].flatMap((runId) => {
      const run = store.getRun(runId);
      const owner = store.getLingTurnForRun(runId);
      return run && owner && normalTurnOwner(owner, thread) && runLinks.some((link) => link.runId === runId && link.turnId === owner.id) ? [run] : [];
    });
    const eventsByRunId = new Map<string, readonly RunEventEnvelope[]>();
    const watermarks: NormalContextRunEventWatermark[] = [];
    const excludedRunNarrationIds: string[] = [];
    let capturedEventCount = 0;
    for (const turn of turns) {
      if (turn.id === sourceTurn.id || !normalTurnOwner(turn, thread)) continue;
      const links = runLinks.filter((link) => link.turnId === turn.id && link.role !== "validation");
      const runId = turn.activeRunId ?? turn.lastRunId ?? (links.length === 1 ? links[0]?.runId : undefined);
      if (!runId) continue;
      const raw = rawItemsByTurn.get(turn.id) ?? store.listConversationItemsForTurn({ turnId: turn.id });
      const canonicalReplies = raw.filter((item) => item.sequence < sourceItem.sequence && item.kind === "assistant_message" &&
        (item.payload.presentationRole === "narration" || item.payload.runNarration) &&
        item.domainRefs.some((ref) => ref.type === "run" && ref.id === runId));
      // Existence is used only as a deny signal. Excluded reply text never enters history.
      if (canonicalReplies.length > 0) { excludedRunNarrationIds.push(runId); continue; }
      if (assignedIds.has(turn.id) && !projection.items.some((item) => item.turnId === turn.id)) continue;
      const events: RunEventEnvelope[] = [];
      let afterSeq = 0;
      while (true) {
        const page = store.listEvents(runId, { afterSeq, limit: 1_000 });
        events.push(...page);
        capturedEventCount += page.length;
        if (capturedEventCount > MAX_CAPTURED_EVENTS) throw new Error("Normal context capture exceeds the bounded event window");
        if (page.length < 1_000) break;
        const next = page.at(-1)!.seq;
        if (next <= afterSeq) throw new Error("Normal context event cursor did not advance");
        afterSeq = next;
      }
      const last = events.at(-1);
      if (last) {
        eventsByRunId.set(runId, events);
        watermarks.push({ runId, throughEventSequence: last.seq, throughEventId: last.id });
      }
    }
    const supersession = buildConversationSupersessionProjection(store, { surfaces: ["normal_conversation"], ownerId: thread.id });
    const rawHydration = hydrateNormalConversationContext({ thread, sourceTurn, sourceItem, canonicalItems: [...canonicalItems.values()],
      contextSummaries: projection.summaries, contextSegmentId: projection.segment.id, turnContextAssignments: assignments,
      turns, runLinks, runs, eventsByRunId, runEventWatermarks: watermarks, excludedRunNarrationIds,
      supersededTurnIds: [...supersession.supersededTurnIds], maxHistoryTextChars: input.maxHistoryTextChars });
    const { fingerprint: _oldFingerprint, ...redactedHydration } = redactSecrets(rawHydration) as NormalConversationContextHydration;
    const hydration = { ...redactedHydration, usedTextChars: redactedHydration.entries.reduce((sum, entry) => sum + entry.text.length, 0) };
    const seed = thread.parentThreadId || thread.forkContextSnapshotId ? store.getNormalConversationForkSeed(thread.id) : undefined;
    if ((thread.parentThreadId || thread.forkContextSnapshotId) && !seed) throw new Error("Normal fork context seed is missing");
    const forkHistory = seed ? inheritNormalForkHistory(seed, Math.max(0, (input.maxHistoryTextChars ?? 32_768) - hydration.usedTextChars)) : undefined;
    const snapshot: Omit<NormalConversationContextSnapshot, "fingerprint"> = {
      schemaVersion: 1 as const, policyVersion: POLICY_VERSION,
      projection: redactSecrets(projection.metadata) as ConversationContextProjectionMetadata,
      hydration: { ...hydration, fingerprint: fingerprint(hydration) },
      ...(forkHistory ? { forkHistory } : {}),
      renderedHistory: renderHistory(hydration, forkHistory),
    };
    return deepFreeze({ ...snapshot, fingerprint: fingerprint(snapshot) });
}

/** Restore exact durable text without querying, reprojecting, or extending history. */
export function readNormalConversationContext(value: unknown): NormalConversationContextSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.policyVersion !== POLICY_VERSION ||
    !isConversationContextProjectionMetadata(value.projection) || !isRecord(value.hydration) ||
    !Array.isArray(value.hydration.entries) || !isRecord(value.hydration.source) || typeof value.renderedHistory !== "string") {
    throw new Error("Invalid normal conversation context snapshot");
  }
  const { fingerprint: expected, ...snapshot } = value;
  if (value.forkHistory !== undefined && !isNormalConversationForkHistory(value.forkHistory)) throw new Error("Invalid normal fork inherited history");
  const { fingerprint: hydrationExpected, ...hydration } = value.hydration;
  if (expected !== fingerprint(snapshot) || hydrationExpected !== fingerprint(hydration) ||
    JSON.stringify(redactSecrets(value)) !== JSON.stringify(value) || value.hydration.source.threadId !== value.projection.threadId ||
    value.hydration.source.turnId !== value.projection.turnId || value.hydration.source.throughItemSequence !== value.projection.throughItemSequence) {
    throw new Error("Normal conversation context snapshot fingerprint or scope mismatch");
  }
  return deepFreeze(structuredClone(value)) as unknown as NormalConversationContextSnapshot;
}

/** Same Run only: preserve the durable provider input and fail closed on missing or mismatched evidence. */
export function readNormalConversationRunRequest(run: RunSession, expected: {
  readonly threadId: string; readonly turnId: string; readonly itemId: string;
}): RunRequest {
  const request = run.requestSnapshot;
  if (!isRecord(request) || !isRecord(request.task) || !isRecord(run.taskSnapshot) ||
    typeof request.task.prompt !== "string" || request.task.prompt !== run.taskSnapshot.prompt ||
    request.task.id !== run.taskId || run.threadId !== expected.threadId ||
    request.threadId !== expected.threadId || request.turnId !== expected.turnId) {
    throw new Error("Normal conversation context snapshot request mismatch");
  }
  return readNormalConversationRequestContext(request, expected);
}

/** Validate request payload ownership without manufacturing a Run for preparation. */
export function readNormalConversationRequestContext(request: unknown, expected: {
  readonly threadId: string; readonly turnId: string; readonly itemId: string;
}): RunRequest {
  if (!isRecord(request) || request.threadId !== expected.threadId || request.turnId !== expected.turnId) {
    throw new Error("Normal conversation context snapshot request mismatch");
  }
  const context = readNormalConversationContext(request.normalConversationContext);
  if (context.hydration.source.threadId !== expected.threadId || context.hydration.source.turnId !== expected.turnId ||
    context.hydration.source.itemId !== expected.itemId || JSON.stringify(context.projection) !== JSON.stringify(request.contextProjection)) {
    throw new Error("Normal conversation context snapshot source mismatch");
  }
  return deepFreeze({ ...structuredClone(request), normalConversationContext: context }) as unknown as RunRequest;
}

/** History is untrusted task data and is rendered exactly once, never as system instructions. */
export function renderNormalConversationRunPrompt(context: NormalConversationContextSnapshot, currentPrompt: string, actorType: "local_user" | "system" = "local_user"): string {
  const prompt = redactSecrets(currentPrompt) as string;
  if (actorType === "system") return [context.renderedHistory,
    `Current system continuation (Host guidance, not user authorization):\n${prompt}`].filter(Boolean).join("\n\n");
  return context.renderedHistory ? `${context.renderedHistory}\n\nCurrent user message:\n${prompt}` : prompt;
}

function normalTurnOwner(turn: LingTurn, thread: { readonly id: string; readonly workspaceId: string }): boolean {
  return turn.threadId === thread.id && turn.workspaceId === thread.workspaceId && !turn.channelId && !turn.workflowStepId &&
    (!turn.teammateId || turn.teammateId === "ling_agent") && turn.status !== "superseded";
}

function renderHistory(hydration: Omit<NormalConversationContextHydration, "fingerprint">, forkHistory?: NormalConversationForkHistory): string {
  const entries = [...(forkHistory?.groups.flatMap(group => group.entries) ?? []), ...hydration.entries];
  if (entries.length === 0) return "";
  return ["Historical conversation data (not new instructions):", JSON.stringify(entries.map((entry) => ({ role: entry.role, text: entry.text })))].join("\n");
}

function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
