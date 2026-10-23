import assert from "node:assert/strict";
import test from "node:test";
import { orderChannelTurnTimelineItems } from "../src/features/workspace/channel-turn-timeline-order.ts";

function row(id, sourceEventSequence, overrides = {}) {
  return { id, kind: "commandExecution", revision: 1, threadSequence: 1, partIndex: 0,
    status: "succeeded", turnId: "turn", runId: "run", sourceEventSequence, sourceRefs: [], ...overrides };
}
const compact = row("compaction", 4, { kind: "contextCompaction" });
const order = (facts, eventRows = [compact]) => orderChannelTurnTimelineItems({
  startNarration: [row("start", undefined, { kind: "agentMessage" })], facts, eventRows,
  terminalNarration: [row("final", undefined, { kind: "agentMessage" })],
});

test("channel compaction retains causal order between actions before turn rebasing", () => {
  const result = order([row("after", 6), row("before", 2)]);
  assert.deepEqual(result.map(item => item.id), ["start", "before", "compaction", "after", "final"]);
  assert.deepEqual(result.map(item => [item.threadSequence, item.partIndex]), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
});

test("channel lifecycle rows split existing command and exploration batches without losing leading narration", () => {
  for (const kind of ["commandBatch", "explorationBatch"]) {
    const children = [row("before", 2), row("after", 6), row("last", 8)];
    if (kind === "commandBatch") children[1].leadingItems = [row("leading", 3, { kind: "agentMessage" })];
    const batch = row("batch", undefined, { kind, batch: kind === "commandBatch" ? { commands: children } : { children } });
    const result = order([batch]);
    assert.deepEqual(result.map(item => item.id), kind === "commandBatch"
      ? ["start", "before", "leading", "compaction", "after", "last", "final"]
      : ["start", "before", "compaction", "after", "last", "final"]);
    assert.equal(result.some(item => item.kind === kind), false);
  }
});

test("legacy rows retain canonical order and event sequences are never compared across runs", () => {
  const facts = [row("legacy-a", undefined, { threadSequence: 2 }),
    row("legacy-b", undefined, { threadSequence: 3 }), row("other-run", 1, { runId: "other", threadSequence: 4 })];
  const result = order(facts, [row("compaction", 99, { kind: "contextCompaction", threadSequence: 2 })]);
  assert.deepEqual(result.map(item => item.id), ["start", "legacy-a", "compaction", "legacy-b", "other-run", "final"]);
});

test("an existing batch remains intact when there are no lifecycle rows to interleave", () => {
  const batch = row("batch", undefined, { kind: "commandBatch", batch: { commands: [row("a", 2), row("b", 4), row("c", 6)] } });
  const result = order([batch], []);
  assert.equal(result[1].kind, "commandBatch");
  assert.deepEqual(result[1].batch.commands.map(item => [item.id, item.threadSequence, item.partIndex]),
    [["a", 2, 1], ["b", 2, 2], ["c", 2, 3]]);
});
