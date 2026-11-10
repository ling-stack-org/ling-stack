import assert from "node:assert/strict";
import test from "node:test";
import { ConversationNarrationAccumulator, readRunNarrationSnapshot } from "../dist/features/conversations/narration-segments.js";

const event = (seq, type, data) => ({ id: `event-${seq}`, runId: "run-1", seq, ts: "2026-09-05T00:00:00Z", type, data });

test("durable narration pagination retains identities and stops a non-advancing store page", () => {
  const first = event(1, "message_end", { role: "assistant", text: "First." });
  const second = event(1001, "message_end", { role: "assistant", text: "Second." });
  const reads = [];
  const store = { listEvents(runId, options) {
    reads.push([runId, options.afterSeq, options.limit]);
    return options.afterSeq === 0 ? [first] : [second];
  } };
  const snapshot = readRunNarrationSnapshot(store, "run-1");
  assert.equal(snapshot.content, "First.\n\nSecond.");
  assert.deepEqual(snapshot.narrationSegments.map((segment) => segment.firstEventId), ["event-1", "event-1001"]);
  assert.deepEqual(reads, [["run-1", 0, 1000], ["run-1", 1, 1000], ["run-1", 1001, 1000]]);
});

test("durable narration never accepts events owned by a different run", () => {
  const store = { listEvents(_runId, { afterSeq }) {
    return afterSeq === 0 ? [{ ...event(1, "message_end", { role: "assistant", text: "Foreign." }), runId: "run-2" }] : [];
  } };
  assert.deepEqual(readRunNarrationSnapshot(store, "run-1"), { content: "", narrationSegments: [] });
});

test("stream narration and durable replay keep the same message boundaries and identities", () => {
  const events = [
    event(1, "assistant_text_delta", { text: "Inspect" }),
    event(2, "assistant_text_delta", { text: "\n\n" }),
    event(3, "assistant_text_delta", { text: "first." }),
    event(4, "message_end", { role: "assistant", text: "Inspect\n\nfirst." }),
    event(5, "tool_start", { toolCallId: "read-1", toolName: "read", args: {} }),
    event(6, "message_end", { role: "toolResult" }),
    event(7, "assistant_text_delta", { text: "Write next." }),
    event(8, "message_end", { role: "assistant", text: "Write next." }),
    event(9, "message_end", { role: "assistant" }),
  ];
  const live = new ConversationNarrationAccumulator();
  let streamingId;
  for (const entry of events) {
    live.append(entry);
    if (entry.seq === 1) streamingId = live.snapshot().narrationSegments[0].firstEventId;
    live.append(entry); // duplicate delivery must not double text
  }
  const replay = new ConversationNarrationAccumulator();
  events.forEach((entry) => replay.append(entry));
  assert.deepEqual(live.snapshot(), replay.snapshot());
  assert.equal(live.snapshot().content, "Inspect\n\nfirst.\n\nWrite next.");
  assert.equal(live.snapshot().narrationSegments.length, 2);
  assert.equal(live.snapshot().narrationSegments[0].firstEventId, streamingId);
});

test("final-only assistant messages and unfinished streaming tails remain distinct", () => {
  const fold = new ConversationNarrationAccumulator();
  fold.append(event(1, "message_end", { role: "assistant", text: "Final-only first." }));
  fold.append(event(2, "message_end", { role: "assistant", text: "Final-only second." }));
  fold.append(event(3, "assistant_text_delta", { text: "Still streaming" }));
  const snapshot = fold.snapshot();
  assert.equal(snapshot.content, "Final-only first.\n\nFinal-only second.\n\nStill streaming");
  assert.deepEqual(snapshot.narrationSegments.map((part) => [part.startEventSequence, part.completed]), [[1, true], [2, true], [3, false]]);
});
