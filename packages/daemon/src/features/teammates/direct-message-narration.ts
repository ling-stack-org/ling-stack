import type { ConversationNarrationSegment, TeammateDirectMessage } from "@ling-stack/contracts";
import type { RunStore } from "@ling-stack/core";
import { ConversationNarrationAccumulator } from "../conversations/narration-segments.js";
import { createOwnedRunNarrationAccumulator, type NarrationOwnerStore } from "../conversations/narration-owner.js";
import { isTeammateDirectMessageInScope, resolveTeammateDirectRunOwner, type TeammateDirectRunOwnerStore } from "./direct-run-owner.js";

type NarrationSnapshot = ReturnType<ConversationNarrationAccumulator["snapshot"]>;
type NarrationStore = TeammateDirectRunOwnerStore & NarrationOwnerStore & Pick<RunStore, "readSnapshot">;

/** Project receipt-filtered text and segments together so they cannot disagree. */
export function projectTeammateDirectNarrationSnapshot(snapshot: NarrationSnapshot): NarrationSnapshot {
  const content = projectTeammateDirectReplyText(snapshot.content);
  let remainingPrefix = snapshot.content.endsWith(content) ? snapshot.content.length - content.length : 0;
  const narrationSegments: ConversationNarrationSegment[] = [];
  snapshot.narrationSegments.forEach((segment, index) => {
    const skipped = Math.min(remainingPrefix, segment.content.length);
    remainingPrefix -= skipped;
    const visible = segment.content.slice(skipped);
    if (visible) narrationSegments.push({ ...segment, content: visible });
    if (index < snapshot.narrationSegments.length - 1) remainingPrefix = Math.max(0, remainingPrefix - 2);
  });
  return { content, narrationSegments };
}

/**
 * Hydrate the API view from durable RunEvents, without writing DTO fields back
 * to SQLite. The live sink supplies its already-folded snapshot to avoid
 * rescanning history on every token. Run ownership is verified for read paths.
 */
export function projectTeammateDirectMessageNarration(
  store: NarrationStore,
  message: TeammateDirectMessage,
  liveSnapshot?: NarrationSnapshot,
): TeammateDirectMessage {
  if (message.authorType !== "ai-teammate") return message;
  const scope = { teammateId: message.teammateId, directThreadId: message.threadId, replyMessageId: message.id };
  if (!isTeammateDirectMessageInScope(message, scope)) return message;
  let snapshot = liveSnapshot;
  if (!snapshot) {
    snapshot = store.readSnapshot(() => {
      const owner = message.linkedRunId ? resolveTeammateDirectRunOwner(store, message.linkedRunId, scope) : undefined;
      if (!owner) return undefined;
      const { run } = owner;
      const narration = createOwnedRunNarrationAccumulator(store, run.id, {
        threadId: owner.turn.threadId, turnId: owner.turn.id, participantId: scope.teammateId, kind: "teammate_direct",
      });
      let afterSeq = 0;
      while (true) {
        const events = store.listEvents(run.id, { afterSeq, limit: 1000 });
        if (events.length === 0) break;
        for (const event of events) if (event.runId === run.id) narration.append(event);
        const nextSeq = events.at(-1)!.seq;
        if (nextSeq <= afterSeq) break;
        afterSeq = nextSeq;
      }
      return narration.snapshot();
    });
  }
  if (!snapshot) return message;
  if (snapshot.narrationSegments.length === 0) return message;
  const projected = projectTeammateDirectNarrationSnapshot(snapshot);
  return { ...message, body: projected.content, narrationSegments: projected.narrationSegments };
}

const DIRECT_RECEIPT_HEAD = String.raw`(?:(?:好的|好)[，,\s]*)?(?:已)?收到(?:了)?`;
const DIRECT_RECEIPT_ECHO = String.raw`(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?`;
const DIRECT_RECEIPT_END = String.raw`[。！？!?]`;
const directReceiptLinePattern = new RegExp(
  String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}?[\t ]*(?:\r?\n)+`, "u",
);
const directReceiptSentencePattern = new RegExp(
  String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}[\t ]*(?=\S)`, "u",
);
const directReceiptOnlyPattern = new RegExp(String.raw`^${DIRECT_RECEIPT_HEAD}${DIRECT_RECEIPT_ECHO}${DIRECT_RECEIPT_END}?\s*$`, "u");
const partialDirectReceiptPattern = new RegExp(
  String.raw`^(?:好|好的|好的[，,\s]*|已|已收|收|收到(?:了)?(?:[：:,，]\s*[^。\r\n！？!?]{0,80})?)$`, "u",
);

export function projectTeammateDirectReplyText(value: string): string {
  const source = value.trimStart();
  const leadingReceipt = directReceiptLinePattern.exec(source) ?? directReceiptSentencePattern.exec(source);
  if (leadingReceipt) return source.slice(leadingReceipt[0].length).trimStart();
  if (directReceiptOnlyPattern.test(source) || partialDirectReceiptPattern.test(source)) return "";
  return value;
}
