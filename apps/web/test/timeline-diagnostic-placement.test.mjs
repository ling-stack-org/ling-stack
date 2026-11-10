import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { fingerprintConversationTimeline } from "@ling-stack/conversation-ui-core";

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { buildSurfaceTimelineSnapshot } = await vite.ssrLoadModule("/src/domains/conversations/timeline-snapshot.ts");
after(async () => vite.close());

function fixture() {
  const base = { revision: 1, threadSequence: 1, partIndex: 0, sourceRefs: [] };
  const user = (id, sequence) => ({ ...base, id, itemId: id, kind: "userMessage", markdown: id, threadSequence: sequence, sourceRefs: [{ kind: "message", id }] });
  const diagnostic = (id) => ({ ...base, id, kind: "diagnostic", status: "blocked", title: id, summary: id, sourceRefs: [{ kind: "run", id: "historical-run" }] });
  const items = [user("native-p01", 0), user("native-p02", 0), user("canonical-p03", 1),
    { ...base, id: "read-p03", kind: "exploration", operation: "read", title: "Read", targets: [], sourceRefs: [{ kind: "conversation_item", id: "canonical-p03" }] },
    diagnostic("missing-p01"), diagnostic("missing-p02-a"), diagnostic("missing-p02-b"),
    { ...base, id: "reply-p03", kind: "agentMessage", markdown: "Done", threadSequence: 2 }];
  const diagnosticPlacements = [
    { diagnosticId: "missing-p02-b", afterItemId: "native-p02" },
    { diagnosticId: "missing-p01", afterItemId: "native-p01" },
    { diagnosticId: "missing-p02-a", afterItemId: "native-p02" },
    { diagnosticId: "missing-p02-a", afterItemId: "native-p02" },
  ];
  return { items, diagnosticPlacements };
}

const surfaces = ["normal_conversation", "teammate_direct", "channel_root"];
const snapshot = (surface, input) => buildSurfaceTimelineSnapshot({ surface, threadId: "verified-thread", contextSegmentIdByItemId: new Map(), ...input });

test("all surfaces share stable diagnostic placement before batching without rewriting facts", () => {
  const { items, diagnosticPlacements } = fixture();
  const original = structuredClone(items);
  const expected = ["native-p01", "missing-p01", "native-p02", "missing-p02-a", "missing-p02-b", "canonical-p03", "read-p03", "reply-p03"];
  const fingerprints = [];
  for (const surface of surfaces) {
    const displayed = snapshot(surface, { items, diagnosticPlacements }).items;
    assert.deepEqual(displayed.map((item) => item.id), expected, surface);
    assert.deepEqual(displayed.filter((item) => item.kind !== "diagnostic"), items.filter((item) => item.kind !== "diagnostic"));
    for (const item of displayed) assert.equal(item, items.find((originalItem) => originalItem.id === item.id), "Placement reuses the original fact object");
    assert.ok(displayed.filter((item) => item.kind === "diagnostic").every((item) => item.status === "blocked" && item.threadSequence === 1 && !item.itemId && item.sourceRefs.every((ref) => ref.kind !== "conversation_item")));
    assert.deepEqual(snapshot(surface, { items: displayed, diagnosticPlacements }).items, displayed, "Replay is idempotent");
    assert.deepEqual(snapshot(surface, { items, diagnosticPlacements: [...diagnosticPlacements].reverse() }).items, displayed, "Relations do not impose fact order");
    assert.deepEqual(snapshot(surface, { items, diagnosticPlacements, contextSegmentIdByItemId: undefined }).items, displayed, "Placement does not require optional batching context");
    fingerprints.push(fingerprintConversationTimeline(displayed));
  }
  assert.deepEqual(fingerprints[0], fingerprints[1]);
  assert.deepEqual(fingerprints[1], fingerprints[2]);
  assert.deepEqual(fingerprints[0].itemIds, expected, "Fingerprint describes the view order, not a rewritten canonical sequence");
  assert.deepEqual(items, original, "Atomic input is not mutated");
});

test("all surfaces retain missing, conflicting and non-message placement endpoints in place", () => {
  for (const surface of surfaces) {
    for (const diagnosticPlacements of [
      [],
      [{ diagnosticId: "missing-p01", afterItemId: "absent" }],
      [{ diagnosticId: "absent", afterItemId: "native-p01" }],
      [{ diagnosticId: "missing-p01", afterItemId: "native-p01" }, { diagnosticId: "missing-p01", afterItemId: "native-p02" }],
      [{ diagnosticId: "missing-p01", afterItemId: "native-p01" }, { diagnosticId: "missing-p01", afterItemId: "absent" }],
      [{ diagnosticId: "read-p03", afterItemId: "native-p01" }],
      [{ diagnosticId: "missing-p01", afterItemId: "reply-p03" }],
      [{ diagnosticId: "missing-p01", afterItemId: "missing-p02-a" }, { diagnosticId: "missing-p02-a", afterItemId: "missing-p01" }],
      [{ diagnosticId: "missing-p01", afterItemId: "missing-p01" }],
    ]) {
      const { items } = fixture();
      assert.deepEqual(snapshot(surface, { items, diagnosticPlacements }).items, items, JSON.stringify({ surface, diagnosticPlacements }));
    }
  }
});

test("duplicate endpoint IDs are ambiguous, never dropped or relocated by shared placement", () => {
  for (const surface of surfaces) {
    for (const duplicateId of ["native-p01", "missing-p01"]) {
      const { items } = fixture();
      items.push({ ...items.find((item) => item.id === duplicateId) });
      const diagnosticPlacements = [{ diagnosticId: "missing-p01", afterItemId: "native-p01" }];
      assert.deepEqual(snapshot(surface, { items, diagnosticPlacements }).items, items);
    }
  }
});

test("a valid placement does not move unrelated or ambiguous diagnostic rows", () => {
  for (const surface of surfaces) {
    const { items } = fixture();
    const diagnosticPlacements = [
      { diagnosticId: "missing-p01", afterItemId: "native-p01" },
      { diagnosticId: "missing-p02-a", afterItemId: "native-p01" },
      { diagnosticId: "missing-p02-a", afterItemId: "native-p02" },
    ];
    const displayed = snapshot(surface, { items, diagnosticPlacements }).items;
    assert.deepEqual(displayed.map((item) => item.id), ["native-p01", "missing-p01", "native-p02", "canonical-p03", "read-p03", "missing-p02-a", "missing-p02-b", "reply-p03"]);
    assert.deepEqual(displayed.filter((item) => item.id !== "missing-p01"), items.filter((item) => item.id !== "missing-p01"));
  }
});

test("unscoped snapshots still fail closed before exposing any diagnostic placement", () => {
  for (const surface of surfaces) {
    const result = snapshot(surface, { ...fixture(), threadId: undefined });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].code, "scope_mismatch");
  }
});
