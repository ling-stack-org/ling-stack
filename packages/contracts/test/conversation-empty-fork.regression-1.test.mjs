import assert from "node:assert/strict";
import test from "node:test";
import { isConversationContextSnapshot, isLingThreadContinuityV2 } from "../dist/index.js";

// Regression: C03-EMPTY-FORK-CONTRACT — public validation rejected a legal empty branch.
// Found by /qa independent review on 2026-10-25.
// Report: output/e6-20260928/p3-bash-cwd-contract-live-20261025/c03-scope-findings.md
// Pure public contract checks; the Store separately proves parent emptiness.
const branch = { surfaceKind: "branch", relationKind: "branch", parentThreadId: "parent",
  forkContextSnapshotId: "empty-snapshot" };
const snapshot = { id: branch.forkContextSnapshotId, threadId: branch.parentThreadId,
  projectionVersion: "empty-fork-v1", throughItemSequence: 0, summaryIds: [],
  sourceRefs: [{ type: "thread", id: branch.parentThreadId }], policyVersion: "continuity-v2",
  createdAt: "2026-10-25T00:00:00.000Z" };

test("an empty branch's public header does not invent a parent Turn", () => {
  assert.equal(isLingThreadContinuityV2(branch), true);
  assert.equal(isConversationContextSnapshot(snapshot), true);
  assert.equal(isLingThreadContinuityV2({ ...branch, parentTurnId: "turn-real" }), true);
});

test("optional empty-branch Turn does not weaken other lineage requirements", () => {
  for (const invalid of [
    { ...branch, forkContextSnapshotId: undefined },
    { ...branch, parentThreadId: undefined },
    { ...branch, parentTurnId: "" },
    { ...branch, anchorItemId: "anchor" },
    { ...branch, surfaceKind: "work" },
    { surfaceKind: "topic", relationKind: "topic", parentThreadId: "parent", anchorItemId: "anchor" },
  ]) assert.equal(isLingThreadContinuityV2(invalid), false, JSON.stringify(invalid));
});

test("zero-watermark snapshots require an exact empty-parent boundary", () => {
  for (const invalid of [
    { ...snapshot, segmentId: "invented-segment" },
    { ...snapshot, summaryIds: ["invented-summary"] },
    { ...snapshot, sourceRefs: [] },
    { ...snapshot, sourceRefs: [{ type: "thread", id: "foreign-parent" }] },
    { ...snapshot, sourceRefs: [{ type: "conversation_item", id: "invented-item" }] },
    { ...snapshot, throughItemSequence: 1 },
  ]) assert.equal(isConversationContextSnapshot(invalid), false, JSON.stringify(invalid));
});
