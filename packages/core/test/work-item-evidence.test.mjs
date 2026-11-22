import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("work item evidence append/read uses sequence CAS and idempotent replay", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-work-item-evidence-"));
  const store = createSqliteRunStore(cwd);
  try {
    const workItem = store.upsertWorkItem({ sourceType: "manual", sourceId: "evidence-1", title: "Evidence target" }, "2026-06-01T00:00:00.000Z");
    const first = store.appendWorkItemEvidence({
      workItemId: workItem.id,
      expectedWorkItemRevision: workItem.revision,
      expectedEvidenceRevision: 0,
      idempotencyKey: "evidence-1",
      actorId: "agent-a",
      subjectRevision: "candidate-1",
      kind: "observation",
      content: "The replay cursor remains monotonic.",
      sourceRefs: [{ type: "run", id: "run-1", revision: "attempt-1" }],
    }, "2026-06-01T00:01:00.000Z");
    assert.equal(first.status, "appended");
    assert.equal(first.entry.sequence, 1);
    assert.equal(first.workItemRevision, workItem.revision + 1);

    const replay = store.appendWorkItemEvidence({
      workItemId: workItem.id,
      expectedWorkItemRevision: 999,
      expectedEvidenceRevision: 999,
      idempotencyKey: "evidence-1",
      actorId: "agent-a",
      subjectRevision: "candidate-1",
      kind: "observation",
      content: "The replay cursor remains monotonic.",
      sourceRefs: [{ type: "run", id: "run-1", revision: "attempt-1" }],
    }, "2026-06-01T00:02:00.000Z");
    assert.equal(replay.status, "replayed");
    assert.equal(replay.entry.id, first.entry.id);

    assert.throws(() => store.appendWorkItemEvidence({
      workItemId: workItem.id,
      idempotencyKey: "evidence-1",
      actorId: "agent-a",
      subjectRevision: "candidate-1",
      kind: "observation",
      content: "Different content",
    }, "2026-06-01T00:02:30.000Z"), /work_item_evidence_idempotency_conflict/);

    const stale = store.appendWorkItemEvidence({
      workItemId: workItem.id,
      expectedWorkItemRevision: workItem.revision,
      expectedEvidenceRevision: 0,
      idempotencyKey: "evidence-2",
      actorId: "agent-b",
      subjectRevision: "candidate-1",
      kind: "challenge",
      content: "Need a second verification.",
    }, "2026-06-01T00:03:00.000Z");
    assert.equal(stale, undefined);

    const second = store.appendWorkItemEvidence({
      workItemId: workItem.id,
      expectedWorkItemRevision: first.workItemRevision,
      expectedEvidenceRevision: 1,
      idempotencyKey: "evidence-2",
      actorId: "agent-b",
      subjectRevision: "candidate-1",
      kind: "challenge",
      content: "Need a second verification.",
    }, "2026-06-01T00:03:30.000Z");
    assert.equal(second.entry.sequence, 2);
    assert.deepEqual(store.listWorkItemEvidence({ workItemId: workItem.id }), [first.entry, second.entry]);
    assert.deepEqual(store.getWorkItemEvidence(first.entry.id), first.entry);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
