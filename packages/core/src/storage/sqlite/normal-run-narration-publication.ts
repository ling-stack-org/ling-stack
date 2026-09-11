import type { ConversationItemV1, ControlPlaneEvent, RunEventEnvelope } from "@ling-stack/contracts";
import type { AppendConversationItemInput } from "../../conversation-item-store-types.js";
import { createOwnedRunNarrationAccumulator } from "../../conversation-narration-owner.js";
import type { RunStore } from "../../run-types.js";
import { LING_AGENT_ID } from "../../workspace-types.js";
import type { SqliteStoreContext } from "./store-context.js";

import type { PublishNormalRunNarrationResult } from "../../normal-run-narration-types.js";

interface PublicationPorts {
  readonly store: RunStore;
  readonly cwd: string;
  readonly appendItem: (input: AppendConversationItemInput<"assistant_message">, now: string) => ConversationItemV1;
  readonly appendEvent: (input: Parameters<RunStore["appendControlPlaneEvent"]>[0], now: string) => ControlPlaneEvent;
}

/**
 * Host derives text from durable events inside one write transaction. No model/caller text,
 * authority token or active-attempt guess can enter the canonical publication.
 * Run outcome is already final and remains unchanged if this derived publication fails.
 */
export function publishNormalRunNarration(
  context: SqliteStoreContext, ports: PublicationPorts, runId: string, now: string,
): PublishNormalRunNarrationResult {
  context.database.exec("BEGIN IMMEDIATE");
  try {
    const result = publishWithinTransaction(ports, runId, now);
    context.database.exec(result.ok ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (error) {
    context.database.exec("ROLLBACK");
    throw error;
  }
}

function publishWithinTransaction({ store, cwd, appendItem, appendEvent }: PublicationPorts, runId: string, now: string): PublishNormalRunNarrationResult {
  const fail = (code: Extract<PublishNormalRunNarrationResult, { ok: false }>["code"]): PublishNormalRunNarrationResult => ({ ok: false, code });
  const run = store.getRun(runId);
  const thread = run?.threadId ? store.getLingThread(run.threadId) : undefined;
  if (!run || !thread || thread.kind !== "conversation" || run.channelId || run.workflowStepId) return fail("unsupported_surface");
  if (!["succeeded", "failed", "cancelled"].includes(run.status)) return fail("run_not_terminal");
  const turn = store.getLingTurnForRun(runId);
  const source = turn?.sourceItemId ? store.getConversationItem(turn.sourceItemId) : undefined;
  if (!turn || !source || source.kind !== "user_message" || source.status !== "committed"
    || source.threadId !== thread.id || source.turnId !== turn.id || source.workspaceId !== thread.workspaceId
    || source.channelId || source.visibility !== "thread_participants" || source.visibilityOwnerId
    || !((source.actorType === "local_user" && turn.createdByActor === "local-user")
      || (source.actorType === "system" && turn.createdByActor === "system"))) return fail("source_item_conflict");
  const id = `narration:${runId}`;
  const key = `normal-run-narration:${runId}`;
  const existing = store.getConversationItem(id);
  const byKey = store.getConversationItemByIdempotencyKey(thread.id, key);
  if (byKey?.id !== existing?.id) return fail("publication_conflict");
  const links = store.listLingTurnRuns(turn.id).filter(link => link.role !== "validation")
    .sort((a, b) => a.attemptNumber - b.attemptNumber || a.runId.localeCompare(b.runId));
  if (!existing && (links.at(-1)?.runId !== runId || turn.status === "superseded")) return fail("stale_run");
  const oldNarration = existing?.kind === "assistant_message" ? existing.payload.runNarration : undefined;
  if (existing && !oldNarration) return fail("publication_conflict");
  const fold = createOwnedRunNarrationAccumulator(store, runId, {
    threadId: thread.id, turnId: turn.id, participantId: LING_AGENT_ID, kind: "conversation",
  });
  let afterSeq = 0;
  let through: RunEventEnvelope | undefined;
  let lateNarration = false;
  for (;;) {
    const events = store.listEvents(runId, { afterSeq, limit: 1000 });
    if (!events.length) break;
    for (const event of events) {
      if (event.runId !== runId) return fail("narration_source_conflict");
      fold.append(event);
      if (!oldNarration || event.seq <= oldNarration.throughEventSequence) through = event;
      else if (event.type === "assistant_text_delta" || (event.type === "message_end" && event.data.role === "assistant")) lateNarration = true;
    }
    const next = events.at(-1)!.seq;
    if (next <= afterSeq) return fail("narration_source_conflict");
    afterSeq = next;
  }
  const lineage = fold.sourceLineage;
  if (!lineage) return fail("narration_source_conflict");
  if (lateNarration || (oldNarration && (through?.id !== oldNarration.throughEventId
    || through.seq !== oldNarration.throughEventSequence))) return fail("publication_conflict");
  const snapshot = fold.snapshot();
  if (!through || !snapshot.content.trim()) return fail("narration_empty");
  if (snapshot.content.length > 128_000) return fail("narration_budget_exceeded");
  if (run.status === "succeeded" && snapshot.narrationSegments.some(segment => !segment.completed)) return fail("narration_incomplete");
  const previous = links.slice(0, links.findIndex(link => link.runId === runId))
    .map(link => store.getConversationItem(`narration:${link.runId}`)).filter((item): item is ConversationItemV1 => !!item).at(-1);
  if (previous && (previous.kind !== "assistant_message" || previous.threadId !== thread.id
    || previous.turnId !== turn.id || previous.actorId !== LING_AGENT_ID || !previous.payload.runNarration)) return fail("publication_conflict");
  const input: AppendConversationItemInput<"assistant_message"> = {
    kind: "assistant_message",
    id, idempotencyKey: key, threadId: thread.id, turnId: turn.id, actorType: "ling_agent", actorId: LING_AGENT_ID,
    visibility: "thread_participants", status: "committed",
    ...(previous ? { supersedesItemId: previous.id } : {}),
    domainRefs: [{ type: "run", id: runId }, { type: "conversation_item", id: source.id }],
    payload: {
      body: snapshot.content, format: "markdown", streaming: false,
      deliveryStatus: run.status === "succeeded" ? "ready" : run.status === "failed" ? "failed" : "blocked",
      presentationRole: "narration",
      runNarration: { schemaVersion: 1, messageId: `conversation-assistant:${turn.id}`, sourceItemId: source.id,
        source: lineage, throughEventSequence: through.seq, throughEventId: through.id,
        segments: snapshot.narrationSegments.map(({ source: _source, sourceRevision: _revision, ...segment }) => segment) },
    },
  };
  const eventInput: Parameters<RunStore["appendControlPlaneEvent"]>[0] = {
    workspaceId: thread.workspaceId, cwd, domain: "work_units", entityType: "conversation_item",
    entityId: id, action: "conversation_narration.published", idempotencyKey: key + ":published",
    data: { threadId: thread.id, turnId: turn.id, runId, itemId: id },
  };
  const event = store.getControlPlaneEventByIdempotency(thread.workspaceId, eventInput.idempotencyKey!);
  if (existing || event) {
    if (!existing || !event || existing.kind !== input.kind || existing.status !== input.status
      || existing.actorType !== input.actorType || existing.actorId !== input.actorId || existing.workspaceId !== thread.workspaceId
      || existing.threadId !== thread.id || existing.turnId !== turn.id || existing.channelId
      || existing.visibility !== input.visibility || existing.visibilityOwnerId || existing.idempotencyKey !== key
      || existing.supersedesItemId !== input.supersedesItemId
      || JSON.stringify(existing.payload) !== JSON.stringify(input.payload) || JSON.stringify(existing.domainRefs) !== JSON.stringify(input.domainRefs)
      || event.action !== eventInput.action || event.entityType !== eventInput.entityType || event.entityId !== id
      || event.cwd !== cwd || event.domain !== eventInput.domain || JSON.stringify(event.data) !== JSON.stringify(eventInput.data)) return fail("publication_conflict");
    return { ok: true, item: existing, event, duplicate: true };
  }
  const item = appendItem(input, now);
  return { ok: true, item, event: appendEvent(eventInput, now), duplicate: false };
}
