import assert from "node:assert/strict";
import test from "node:test";
import { projectCanonicalConversationTimeline } from "../dist/index.js";
import { transcriptScaleFixture } from "./fixtures/transcript-scale.mjs";

test("ordered canonical history does not repeatedly scan every previous sequence", () => {
  const input = transcriptScaleFixture(1_000, "message");
  let sequenceReads = 0;
  for (const item of input.items) {
    const sequence = item.sequence;
    Object.defineProperty(item, "sequence", { enumerable: true, get() { sequenceReads += 1; return sequence; } });
  }
  const result = projectCanonicalConversationTimeline(input);
  assert.equal(result.items.length, input.items.length);
  assert.equal(result.diagnostics.length, 0);
  assert.ok(sequenceReads <= input.items.length * 30,
    `Sequence reads ${sequenceReads} exceed linear scan budget ${input.items.length * 30}`);
});

const message = (id, sequence, revision = 1, body = id) => ({
  ...transcriptScaleFixture(1, "message").items[0], id, sequence, revision,
  payload: { body, deliveryStatus: "ready", presentationRole: "narration" },
});
const project = (items) => projectCanonicalConversationTimeline({
  ...transcriptScaleFixture(1, "message"), items, sourceSequence: 10,
});

test("sequence index releases a moved revision's old position", () => {
  const result = project([message("a", 1), message("a", 2, 2), message("b", 1)]);
  assert.deepEqual(result.items.map((item) => item.itemId), ["b", "a"]);
  assert.deepEqual(result.diagnostics, []);
});

test("sequence index detects a later claimant at a moved revision's new position", () => {
  const result = project([message("a", 1), message("a", 2, 2), message("b", 2)]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["duplicate_sequence"]);
});

test("a newer revision moving into an occupied sequence is rejected as a conflict", () => {
  const result = project([message("a", 1), message("b", 2), message("a", 2, 2)]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["duplicate_sequence"]);
  assert.deepEqual(result.diagnostics[0].sourceRefs.map((ref) => ref.id), ["b", "a"]);
});

test("equal-revision removal releases its index entry without erasing the conflict diagnostic", () => {
  const result = project([message("a", 1), message("a", 1, 1, "conflicting body"), message("b", 1)]);
  assert.deepEqual(result.items.map((item) => item.itemId), ["b"]);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["owner_conflict"]);
});

test("removing one conflicting owner retains the remaining peer in the sequence index", () => {
  const result = project([message("a", 1), message("b", 1), message("a", 1, 1, "conflict"), message("c", 1)]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics.at(-1).sourceRefs.map((ref) => ref.id), ["b", "c"]);
});

test("a stale revision does not move the current sequence index", () => {
  const result = project([message("a", 2, 2), message("a", 1), message("b", 2)]);
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.diagnostics.map((entry) => entry.code), ["stale_revision", "duplicate_sequence"]);
});
