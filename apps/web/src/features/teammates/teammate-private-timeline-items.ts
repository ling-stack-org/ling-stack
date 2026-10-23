import {
  createConversationTimelineMessageItem,
  mergeConversationRunNarration,
  interleaveConversationUserInputRows,
  projectConversationRunNarration,
  type CanonicalTranscriptProjection,
  type ConversationTimelineItem,
  type ConversationTimelineMessageItem,
  type ConversationTimelineUserInputItem,
} from "@ling-stack/conversation-ui-core";
import type { ConversationGeneratedMedia, ConversationItemV1, LingTurn, LingTurnRun, RunSession, TeammateDirectMessage, TeammateDirectMessageListResponse } from "../../types.js";
import type { ConversationTimelineDiagnosticPlacement } from "../../domains/conversations/timeline-diagnostic-placement.js";

export interface TeammatePrivateTimelineScope {
  readonly teammateId: string;
  readonly directThreadId?: string;
  readonly canonicalThreadId?: string;
  readonly runs?: readonly RunSession[];
  readonly runLinks?: readonly LingTurnRun[];
  readonly turns?: readonly LingTurn[];
}

function privateMessageOwnerMatches(message: TeammateDirectMessage, scope: TeammatePrivateTimelineScope): boolean {
  return Boolean(scope.teammateId && scope.directThreadId && message.teammateId === scope.teammateId &&
    message.threadId === scope.directThreadId);
}

/** Message ownership proves text visibility, independently of execution lineage. */
function privateMessageIsOwned(message: TeammateDirectMessage, scope: TeammatePrivateTimelineScope): boolean {
  return privateMessageOwnerMatches(message, scope) && (message.authorType === "local-user" ||
    (message.authorType === "ai-teammate" && message.authorId === scope.teammateId) ||
    (message.authorType === "system" && message.authorId === "system" && message.systemPurpose === "governance_notification"));
}

function privateMessageTransportIsOwned(message: TeammateDirectMessage, scope: TeammatePrivateTimelineScope): boolean {
  return privateMessageOwnerMatches(message, scope) && (message.authorType === "local-user" ||
    (message.authorType === "ai-teammate" && message.authorId === scope.teammateId) ||
    (message.authorType === "system" && message.authorId === "system"));
}

/** Text visibility depends only on the direct-message owner, not Run lineage. */
export function selectTeammatePrivateOwnedMessages(
  messages: readonly TeammateDirectMessage[],
  scope: TeammatePrivateTimelineScope,
): readonly TeammateDirectMessage[] {
  return messages.filter((message) => privateMessageIsOwned(message, scope));
}

/** Linked IDs are not authority: only a private owner Run with one Turn link is usable. */
export function privateTimelineOwnedRunIds(scope: TeammatePrivateTimelineScope): ReadonlySet<string> {
  return new Set((scope.runs ?? []).filter((run) => scope.canonicalThreadId &&
    run.threadId === scope.canonicalThreadId && run.teammateId === scope.teammateId &&
    !run.channelId && !run.workflowStepId &&
    (scope.runLinks ?? []).filter((link) => link.runId === run.id).length === 1,
  ).map((run) => run.id));
}

/** Strip unproved execution relations before constructing message chrome or callbacks. */
export function selectTeammatePrivateMessages(
  messages: readonly TeammateDirectMessage[],
  scope: TeammatePrivateTimelineScope,
): readonly TeammateDirectMessage[] {
  const ownedRuns = privateTimelineOwnedRunIds(scope);
  return selectTeammatePrivateOwnedMessages(messages, scope).map((message) => {
    if (!message.linkedRunId || ownedRuns.has(message.linkedRunId)) return message;
    const { linkedRunId: _unprovedRun, ...ownedMessage } = message;
    return ownedMessage;
  });
}

/** A message ID cannot authorize media produced by another or unverified Run. */
export function privateGeneratedMediaForMessage(
  items: readonly ConversationGeneratedMedia[],
  message: TeammateDirectMessage,
): readonly ConversationGeneratedMedia[] {
  return items.filter((item) => Boolean(message.linkedRunId && item.runId === message.linkedRunId) &&
    (!item.messageId || item.messageId === message.id));
}

/** Reject a mismatched DTO before publishing its canonical snapshot to the selected owner. */
export function privateTimelineResponseIsOwned(
  response: TeammateDirectMessageListResponse,
  scope: TeammatePrivateTimelineScope,
): boolean {
  if (response.teammateId !== scope.teammateId || response.thread.teammateId !== scope.teammateId ||
    (scope.directThreadId && response.thread.id !== scope.directThreadId) ||
    response.messages.some((message) => message.workspaceId !== response.thread.workspaceId ||
      !privateMessageTransportIsOwned(message, { ...scope, directThreadId: response.thread.id }))) return false;
  const detail = response.timeline;
  if (!detail) return true;
  if (detail.thread.kind !== "teammate_direct" || detail.thread.teammateId !== scope.teammateId ||
    detail.thread.channelId || detail.thread.workflowId || detail.thread.workflowStepId ||
    detail.thread.workspaceId !== response.thread.workspaceId) return false;
  const ownedRuns = privateTimelineOwnedRunIds({ ...scope, canonicalThreadId: detail.thread.id, runs: detail.runs, runLinks: detail.runLinks });
  if (ownedRuns.size !== detail.runs.length) return false;
  return detail.runLinks.every((link) => ownedRuns.has(link.runId) && detail.turns.some((turn) =>
    turn.id === link.turnId && turn.threadId === detail.thread.id && turn.workspaceId === detail.thread.workspaceId &&
    turn.teammateId === scope.teammateId && !turn.channelId && !turn.workflowStepId));
}

export interface TeammatePrivateTimelineMessage {
  readonly message: TeammateDirectMessage;
  readonly body: string;
  readonly facts: readonly ConversationTimelineItem[];
}

/** Exact durable message relations, including edited item revisions with distinct IDs. */
export function privateMessageIdsByCanonicalItemId(
  items: readonly ConversationItemV1[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const item of items) {
    const messages = [...new Set(item.domainRefs.filter((ref) => ref.type === "message").map((ref) => ref.id))];
    if (messages.length === 1) result.set(item.id, messages[0]!);
  }
  return result;
}

/**
 * Keep canonical atomic evidence authoritative, merge the Host's ordered
 * narration, and leave all batching to the shared surface snapshot. Direct
 * message IDs are UI relations, never proof that a ConversationItem exists.
 */
export function projectTeammatePrivateTimelineItems(input: TeammatePrivateTimelineScope & {
  readonly messages: readonly TeammatePrivateTimelineMessage[];
  readonly canonical?: CanonicalTranscriptProjection;
  readonly canonicalMessageIds?: ReadonlyMap<string, string>;
  readonly canonicalState?: "loading" | "loaded" | "error";
}): readonly ConversationTimelineItem[] {
  const ownedMessages = new Map(selectTeammatePrivateMessages(input.messages.map(({ message }) => message), input).map((message) => [message.id, message]));
  const messages = input.messages.flatMap((entry) => {
    const message = ownedMessages.get(entry.message.id);
    if (!message || !privateMessageIsOwned(entry.message, input)) return [];
    const unverifiedDiagnostics = !message.linkedRunId && entry.message.linkedRunId
      ? sanitizePrivateUnverifiedDiagnostics(entry.facts, message.id)
      : [];
    return [{ ...entry, message, facts: message.linkedRunId ? entry.facts : [], unverifiedDiagnostics }];
  });
  const turnIdByRunId = new Map(input.runLinks?.map((link) => [link.runId, link.turnId]) ?? []);
  const visibleIds = new Set(messages.map(({ message }) => message.id));
  const visibleRunIds = new Set(messages.flatMap(({ message }) => message.linkedRunId ? [message.linkedRunId] : []));
  const visibleTurnIds = new Set([...visibleRunIds].flatMap((runId) => turnIdByRunId.has(runId) ? [turnIdByRunId.get(runId)!] : []));
  const refsAreOwned = (refs: ConversationTimelineItem["sourceRefs"]): boolean => refs.every((ref) => {
    if (ref.kind === "run") return visibleRunIds.has(ref.id);
    if (ref.kind === "participant" || ref.kind === "teammate") return ref.id === input.teammateId;
    if (ref.kind === "message") return visibleIds.has(ref.id);
    if (ref.kind === "thread") return ref.id === input.canonicalThreadId || ref.id === input.directThreadId;
    if (ref.kind === "channel" || ref.kind === "workflow" || ref.kind === "workflow_step") return false;
    if (ref.kind === "conversation_item") {
      const owner = input.canonicalMessageIds?.get(ref.id);
      return !owner || visibleIds.has(owner);
    }
    return true;
  });
  const itemIsOwned = (item: ConversationTimelineItem): boolean =>
    (!item.participantId || item.participantId === input.teammateId) &&
    (!item.runId || visibleRunIds.has(item.runId)) && refsAreOwned(item.sourceRefs);
  const isPrivateScopeBlocked = (item: ConversationTimelineItem): boolean =>
    item.kind === "subAgentActivity" || item.kind === "collabAgentToolCall" || item.kind === "protocolEvent" || Boolean(item.workflowStepId);
  let scopeBlocked = false;
  const sourceMessageId = (item: ConversationTimelineItem): string | undefined => item.itemId
    ? input.canonicalMessageIds?.get(item.itemId) ?? item.itemId
    : undefined;
  const inputOwnedRunIds = privateTimelineOwnedRunIds(input);
  const canonical = (input.canonical?.items ?? []).filter((item) => {
    if (item.kind === "userInputRequest" || item.kind === "userInputAnswer") {
      const record = item.userInput;
      return record.availability === "available" && record.source.threadId === input.canonicalThreadId
        && record.source.participantId === input.teammateId && !record.source.workflowStepId
        && inputOwnedRunIds.has(record.source.runId);
    }
    // A current owner's prohibited operation may reference its external target.
    // Keep only the generic blocked notice, never the operation's target details.
    if (isPrivateScopeBlocked(item) && item.participantId === input.teammateId &&
      Boolean(item.runId ? visibleRunIds.has(item.runId) : item.turnId && visibleTurnIds.has(item.turnId))) {
      scopeBlocked = true;
      return false;
    }
    if (!itemIsOwned(item)) return false;
    if (item.kind === "userMessage" || item.kind === "agentMessage") return Boolean(sourceMessageId(item) && visibleIds.has(sourceMessageId(item)!));
    const visible = item.runId ? visibleRunIds.has(item.runId) : Boolean(item.turnId && visibleTurnIds.has(item.turnId));
    if (!visible) return false;
    if (isPrivateScopeBlocked(item) || (item.kind === "diagnostic" && item.code === "scope_mismatch")) {
      scopeBlocked = true;
      return false;
    }
    return true;
  });
  const segmentedMessageIds = new Set(messages.filter(({ message }) => message.authorType === "ai-teammate" && message.linkedRunId && message.narrationSegments?.length).map(({ message }) => message.id));
  const items = canonical.filter((item) => item.kind !== "agentMessage" || !segmentedMessageIds.has(sourceMessageId(item) ?? ""));
  const visibleSourceKeys = new Set([
    ...[...visibleIds].map((id) => `message:${id}`),
    ...[...visibleRunIds].map((id) => `run:${id}`),
    ...[...visibleTurnIds].map((id) => `turn:${id}`),
    ...[...(input.canonicalMessageIds ?? [])].filter(([, messageId]) => visibleIds.has(messageId)).map(([id]) => `conversation_item:${id}`),
    ...messages.flatMap(({ facts }) => facts.filter((item) => itemIsOwned(item) && !isPrivateScopeBlocked(item)).flatMap((item) => [
      ...(item.actionId ? [`execution_action:${item.actionId}`] : []),
      ...item.sourceRefs.filter((ref) => ref.kind === "execution_action").map((ref) => `${ref.kind}:${ref.id}`),
    ])),
  ]);
  for (const diagnostic of input.canonical?.diagnostics ?? []) {
    // Unanchored evidence lives in the projector's diagnostic collection,
    // not its atomic facts. Display only diagnostics tied to visible messages
    // through exact durable identities; paths and timestamps are not owners.
    const runs = diagnostic.sourceRefs.filter((ref) => ref.kind === "run");
    if (!refsAreOwned(diagnostic.sourceRefs) ||
      !diagnostic.sourceRefs.some((ref) => visibleSourceKeys.has(`${ref.kind}:${ref.id}`))) continue;
    if (diagnostic.code === "scope_mismatch" || diagnostic.code === "cross_thread_anchor") {
      scopeBlocked = true;
      continue;
    }
    if (items.some((item) => item.kind === "diagnostic" && item.summary === diagnostic.message)) continue;
    const runId = runs.length === 1 ? runs[0]!.id : undefined;
    // Rejected older revisions and lifecycle events are audit notices, not
    // evidence that the accepted action was blocked or succeeded.
    const advisory = diagnostic.code === "stale_revision" || diagnostic.code === "stale_event" || diagnostic.code === "late_event";
    items.push({
      id: privateDiagnosticId(diagnostic),
      kind: "diagnostic",
      revision: input.canonical?.sourceSequence ?? 0,
      threadSequence: input.canonical?.sourceSequence ?? 0,
      partIndex: items.length + 1,
      ...(advisory ? {} : { status: "blocked" as const }),
      ...(runId ? { runId, turnId: turnIdByRunId.get(runId) } : {}),
      sourceRefs: diagnostic.sourceRefs,
      title: advisory ? "Activity" : "Activity unavailable",
      description: diagnostic.message,
      summary: diagnostic.message,
    });
  }
  const narration: ConversationTimelineMessageItem[] = [];
  messages.forEach(({ message, body, facts: unfilteredFacts, unverifiedDiagnostics }, messageIndex) => {
    const facts = unfilteredFacts.filter((item) => itemIsOwned(item) && !isPrivateScopeBlocked(item));
    const existing = canonical.find((item) => (item.kind === "userMessage" || item.kind === "agentMessage") && sourceMessageId(item) === message.id);
    const turnId = message.linkedRunId ? turnIdByRunId.get(message.linkedRunId) : undefined;
    const related = canonical.filter((item) => (message.linkedRunId && item.runId === message.linkedRunId) || (turnId && item.turnId === turnId));
    const anchor = related.find((item) => item.kind === "userMessage") ?? related.find((item) => item.sourceRefs.some((ref) => ref.kind === "conversation_item"));
    const lastRelated = [...related].sort(compareItems).at(-1);
    const threadSequence = existing?.threadSequence ?? lastRelated?.threadSequence ?? fallbackSequence(messageIndex, messages, canonical, sourceMessageId);
    const messageItem = createConversationTimelineMessageItem({
      id: `message:${message.authorType === "local-user" ? "user" : "agent"}:${message.id}`,
      role: message.authorType === "local-user" ? "user" : "agent",
      markdown: body,
      waitingPlaceholder: message.status === "pending" && !message.body.trim() && !message.narrationSegments?.length,
      phase: message.authorType === "ai-teammate" && message.status === "ready" ? "final" : "commentary",
      revision: message.revision,
      threadSequence,
      partIndex: existing?.partIndex ?? (lastRelated ? lastRelated.partIndex + 1 : messageIndex),
      status: privateMessageTimelineStatus(message.status),
      itemId: message.id,
      participantId: message.authorType === "ai-teammate" ? message.authorId ?? input.teammateId : undefined,
      turnId: existing?.turnId ?? turnId,
      // A private message is durable in its own store, but its identifier is
      // not automatically an owning ConversationItem reference.
      sourceRefs: [{ kind: "message", id: message.id }],
      fileRefs: message.fileRefs,
    });
    if (messageItem.kind === "agentMessage" && message.linkedRunId && message.narrationSegments?.length) {
      narration.push(...projectConversationRunNarration({
        message: messageItem,
        segments: message.narrationSegments,
        runId: message.linkedRunId,
        anchor: anchor ?? { ...messageItem, itemId: undefined, sourceRefs: [] },
      }));
    } else if (!existing) {
      items.push({ ...messageItem, ...(message.linkedRunId ? { runId: message.linkedRunId } : {}) });
    }
    if (!input.canonical && input.canonicalState !== "loading" && input.canonicalState !== undefined &&
      (facts.length > 0 || unverifiedDiagnostics.length > 0)) {
      if (input.canonicalState === "loaded" && unverifiedDiagnostics.length > 0) {
        items.push(...unverifiedDiagnostics.map((diagnostic, index) => ({
          ...diagnostic,
          threadSequence,
          partIndex: messageItem.partIndex + index + 1,
        })));
      } else {
        items.push({
          id: `diagnostic:private-canonical:${message.id}`,
          kind: "diagnostic",
          revision: facts.reduce((max, item) => Math.max(max, item.revision), 0),
          threadSequence,
          partIndex: messageItem.partIndex + 1,
          status: "blocked",
          runId: message.linkedRunId,
          sourceRefs: facts.flatMap((item) => item.sourceRefs.filter((ref) => ref.kind !== "conversation_item")),
          title: "Activity unavailable",
          description: input.canonicalState === "error" ? "Execution evidence could not be loaded." : "Execution evidence is missing required lineage.",
          summary: input.canonicalState === "error" ? "Execution evidence could not be loaded." : "Execution evidence is missing required lineage.",
        });
      }
    }
  });
  if (scopeBlocked) items.push({
    id: `diagnostic:private-scope:${input.teammateId}`,
    kind: "diagnostic", code: "scope_mismatch", status: "blocked",
    revision: input.canonical?.sourceSequence ?? 0, threadSequence: input.canonical?.sourceSequence ?? 0,
    partIndex: items.length + 1, sourceRefs: [], title: "Activity unavailable", summary: "Activity unavailable",
  });
  const seen = new Set<string>();
  const atomic = items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).sort(compareItems);
  const isUserInput = (item: ConversationTimelineItem): item is ConversationTimelineUserInputItem =>
    item.kind === "userInputRequest" || item.kind === "userInputAnswer";
  return interleaveConversationUserInputRows(
    mergeConversationRunNarration(atomic.filter(item => !isUserInput(item)), narration), atomic.filter(isUserInput),
  );
}

const safePrivateUnverifiedDiagnosticSummaries = new Set([
  "Command batch lineage is incomplete.",
  "Exploration batch lineage is incomplete.",
  "Missing action, run, participant, or source lineage.",
  "Execution evidence is missing required lineage.",
]);

function sanitizePrivateUnverifiedDiagnostics(
  facts: readonly ConversationTimelineItem[],
  messageId: string,
): readonly ConversationTimelineItem[] {
  const summaries = new Set<string>();
  return facts.flatMap((item, index) => {
    if (item.kind !== "diagnostic" || item.status !== "blocked") return [];
    const candidate = item.summary?.trim() || item.description?.trim() || "";
    const summary = safePrivateUnverifiedDiagnosticSummaries.has(candidate)
      ? candidate
      : "Execution evidence is missing required lineage.";
    if (summaries.has(summary)) return [];
    summaries.add(summary);
    return [{
      id: `diagnostic:private-unverified:${messageId}:${index}`,
      kind: "diagnostic" as const,
      revision: item.revision,
      threadSequence: 0,
      partIndex: index,
      status: "blocked" as const,
      sourceRefs: [],
      title: "Activity unavailable",
      description: summary,
      summary,
    }];
  });
}

/**
 * Resolve only display relations: a durable private Turn may name a native user
 * message without a canonical Item. Shared snapshot projection owns placement;
 * this adapter never moves rows or invents a canonical anchor/sequence.
 */
export function resolveTeammatePrivateDiagnosticPlacements(input: {
  readonly items: readonly ConversationTimelineItem[];
  readonly scope: TeammatePrivateTimelineScope;
  readonly messages: readonly TeammateDirectMessage[];
  readonly canonicalMessageIds?: ReadonlyMap<string, string>;
  readonly canonical?: CanonicalTranscriptProjection;
}): readonly ConversationTimelineDiagnosticPlacement[] {
  const diagnosticIds = new Set((input.canonical?.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.code === "missing_anchor" && !diagnostic.sourceRefs.some((ref) => ref.kind === "conversation_item"))
    .map(privateDiagnosticId));
  const ownedRuns = privateTimelineOwnedRunIds(input.scope);
  const placements: ConversationTimelineDiagnosticPlacement[] = [];
  for (const item of input.items) {
    if (item.kind !== "diagnostic" || !diagnosticIds.has(item.id) || !item.runId || !ownedRuns.has(item.runId)) continue;
    const links = (input.scope.runLinks ?? []).filter((link) => link.runId === item.runId);
    if (links.length !== 1 || item.turnId !== links[0]!.turnId) continue;
    const turns = (input.scope.turns ?? []).filter((turn) => turn.id === links[0]!.turnId);
    if (turns.length !== 1) continue;
    const turn = turns[0]!;
    if (!turn.sourceItemId || turn.threadId !== input.scope.canonicalThreadId ||
      turn.teammateId !== input.scope.teammateId || turn.channelId || turn.workflowStepId) continue;
    const mappedId = input.canonicalMessageIds?.get(turn.sourceItemId);
    if (mappedId && mappedId !== turn.sourceItemId && input.messages.some((message) => message.id === turn.sourceItemId)) continue;
    const candidates = input.messages.filter((message) => message.authorType === "local-user" &&
      (message.id === turn.sourceItemId || message.id === mappedId));
    if (candidates.length !== 1 || candidates[0]!.workspaceId !== turn.workspaceId || !privateMessageIsOwned(candidates[0]!, input.scope)) continue;
    const source = candidates[0]!;
    const rows = input.items.filter((row) => row.kind === "userMessage" && row.itemId &&
      (!row.turnId || row.turnId === turn.id) &&
      (row.itemId === source.id || input.canonicalMessageIds?.get(row.itemId) === source.id));
    if (rows.length !== 1) continue;
    placements.push({ diagnosticId: item.id, afterItemId: rows[0]!.id });
  }
  return placements;
}

function privateDiagnosticId(diagnostic: CanonicalTranscriptProjection["diagnostics"][number]): string {
  return `diagnostic:private:${JSON.stringify([diagnostic.code, diagnostic.sourceRefs.map((ref) => `${ref.kind}:${ref.id}`).sort()])}`;
}

function fallbackSequence(
  index: number,
  messages: readonly TeammatePrivateTimelineMessage[],
  canonical: readonly ConversationTimelineItem[],
  sourceMessageId: (item: ConversationTimelineItem) => string | undefined,
): number {
  for (let next = index + 1; next < messages.length; next += 1) {
    const candidate = canonical.find((item) => sourceMessageId(item) === messages[next]!.message.id);
    if (candidate) return candidate.threadSequence - 1;
  }
  return canonical.reduce((max, item) => Math.max(max, item.threadSequence), 0) + index + 1;
}

function privateMessageTimelineStatus(status: TeammateDirectMessage["status"]): ConversationTimelineItem["status"] {
  switch (status) {
    case "pending": return "running";
    case "blocked": return "blocked";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "ready": return "succeeded";
    default: return "pending";
  }
}

function compareItems(left: ConversationTimelineItem, right: ConversationTimelineItem): number {
  return left.threadSequence - right.threadSequence || left.partIndex - right.partIndex || left.id.localeCompare(right.id);
}
