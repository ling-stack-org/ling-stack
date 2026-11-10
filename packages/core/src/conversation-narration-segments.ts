import type { ConversationNarrationSegment, ConversationNarrationSource, RunEventEnvelope } from "@ling-stack/contracts";
import type { RunStore } from "./run-types.js";

interface NarrationOwner {
  readonly runId: string;
  readonly source?: ConversationNarrationSource;
  readonly creationEventId?: string;
}

/** Replay the complete durable narrative in bounded event pages, including end-only messages. */
export function readRunNarrationSnapshot(store: Pick<RunStore, "listEvents">, runId: string): ReturnType<ConversationNarrationAccumulator["snapshot"]> {
  const narration = new ConversationNarrationAccumulator();
  let afterSeq = 0;
  for (;;) {
    const events = store.listEvents(runId, { afterSeq, limit: 1000 });
    if (events.length === 0) break;
    for (const event of events) {
      if (event.runId === runId) narration.append(event);
    }
    const nextSeq = events.at(-1)!.seq;
    if (nextSeq <= afterSeq) break;
    afterSeq = nextSeq;
  }
  return narration.snapshot();
}

/**
 * Fold only narrative events. message_end closes one assistant message so the
 * next text delta cannot be concatenated across a tool turn. Callers supply
 * persisted sequence order; repeated/replayed events are ignored by the cursor.
 */
export class ConversationNarrationAccumulator {
  private readonly segments: ConversationNarrationSegment[] = [];
  private openSegmentIndex: number | undefined;
  private cursor = 0;
  private source: ConversationNarrationSource | undefined;
  private ownershipRevision = 0;
  private readonly owner: NarrationOwner | undefined;

  constructor(owner?: NarrationOwner) {
    this.owner = owner;
    this.source = owner?.source;
  }

  /** Changes even when only ownership is withdrawn, with no new narrative text. */
  get sourceRevision(): number { return this.ownershipRevision; }
  get sourceLineage(): ConversationNarrationSource | undefined { return this.source; }

  append(event: RunEventEnvelope): void {
    if (this.owner && event.runId !== this.owner.runId) return;
    if (this.source && !this.matchesSource(event)) {
      this.source = undefined;
      this.ownershipRevision += 1;
    }
    if (event.seq <= this.cursor) return;
    this.cursor = event.seq;
    const isEnd = event.type === "message_end" && event.data.role === "assistant";
    if (event.type !== "assistant_text_delta" && !isEnd) return;
    const text = "text" in event.data && typeof event.data.text === "string" ? event.data.text : "";
    if (this.openSegmentIndex === undefined) {
      if (!text) return;
      this.openSegmentIndex = this.segments.length;
      this.segments.push({
        content: "",
        firstEventId: event.id,
        lastEventId: event.id,
        startEventSequence: event.seq,
        endEventSequence: event.seq,
        completed: false,
      });
    }
    const index = this.openSegmentIndex;
    const segment = this.segments[index]!;
    this.segments[index] = {
      ...segment,
      // Within one message preserve every whitespace chunk. An end payload is
      // a full-message fallback, never another delta to append a second time.
      content: isEnd ? segment.content || text : segment.content + text,
      lastEventId: event.id,
      endEventSequence: event.seq,
      completed: isEnd,
    };
    if (isEnd) this.openSegmentIndex = undefined;
  }

  snapshot(): { readonly content: string; readonly narrationSegments: readonly ConversationNarrationSegment[] } {
    return {
      content: this.segments.map((segment) => segment.content).join("\n\n"),
      narrationSegments: this.segments.map(segment => ({
        ...segment,
        ...(this.source ? { source: this.source } : {}),
        ...(this.ownershipRevision ? { sourceRevision: this.ownershipRevision } : {}),
      })),
    };
  }

  private matchesSource(event: RunEventEnvelope): boolean {
    const source = this.source!;
    const data = event.data as Readonly<Record<string, unknown>>;
    if (event.type === "run_created" && event.id !== this.owner?.creationEventId) return false;
    for (const [key, expected] of [
      ["attemptId", source.attemptId], ["workUnitId", source.workUnitId],
      ["threadId", source.threadId], ["turnId", source.turnId],
      ["teammateId", source.participantId], ["participantId", source.participantId],
    ] as const) {
      if (data[key] !== undefined && data[key] !== expected) return false;
    }
    return data.workflowStepId === undefined;
  }
}
