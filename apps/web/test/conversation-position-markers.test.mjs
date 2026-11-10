import assert from "node:assert/strict";
import test from "node:test";
import { conversationPositionMarkers, positionPreviewText } from "../src/shared/conversation/navigation/conversation-position-markers.ts";

const message = (id, overrides = {}) => ({ id, kind: "agentMessage", markdown: "Visible answer", sourceRefs: [], ...overrides });

test("segmented messages share one marker with all stable locator ids", () => {
  const markers = conversationPositionMarkers([
    message("first", { logicalMessageId: "logical", markdown: "First part" }),
    message("second", { logicalMessageId: "logical", markdown: "Second part" }),
    message("third", { logicalMessageId: "logical", markdown: "Second part" }),
  ]);
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].itemIds, ["first", "second", "third"]);
  assert.equal(markers[0].preview, "First part Second part");
});

test("role, participant and run preserve distinct messages with overlapping ids", () => {
  const markers = conversationPositionMarkers([
    message("a", { logicalMessageId: "same", participantId: "engineer", runId: "one" }),
    message("b", { logicalMessageId: "same", participantId: "reviewer", runId: "one" }),
    message("c", { logicalMessageId: "same", participantId: "engineer", runId: "two" }),
    message("d", { logicalMessageId: "same", kind: "userMessage", participantId: "engineer", runId: "one" }),
  ]);
  assert.equal(markers.length, 4);
  assert.equal(new Set(markers.map(marker => marker.id)).size, 4);
});

test("tool output, reasoning, waiting placeholders and empty messages are excluded", () => {
  assert.equal(conversationPositionMarkers([
    message("tool", { kind: "commandExecution" }), message("thinking", { kind: "reasoning" }),
    message("waiting", { waitingPlaceholder: true }), message("empty", { markdown: "" }),
  ]).length, 0);
  assert.equal(conversationPositionMarkers([message("attachment", { markdown: "", sourceRefs: [{ kind: "artifact", id: "image" }] })]).length, 1);
});

test("preview strips Markdown controls and keeps HTML inert as plain text", () => {
  assert.equal(positionPreviewText("## Plan\n\n**Read** [the file](https://example.com)\n- `done`"), "Plan Read the file done");
  assert.equal(positionPreviewText('<img src=x onerror="alert(1)">'), '<img src=x onerror="alert(1)">');
});

test("preview truncation never splits a Unicode surrogate pair", () => {
  assert.equal(positionPreviewText("😀".repeat(141)), `${"😀".repeat(140)}…`);
});
