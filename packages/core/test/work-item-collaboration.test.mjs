import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  appendWorkItemCollaboration,
  createSqliteRunStore,
  listWorkItemCollaboration,
} from "../dist/index.js";

test("work item collaboration records use durable evidence CAS and idempotent replay", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-work-item-collaboration-"));
  const store = createSqliteRunStore(cwd);
  try {
    const item = store.upsertWorkItem({ sourceType: "manual", sourceId: "collab-1", title: "Collaboration target" }, "2026-11-21T00:00:00.000Z");
    const first = appendWorkItemCollaboration(store, {
      workItemId: item.id,
      expectedWorkItemRevision: item.revision,
      expectedCollaborationRevision: 0,
      kind: "deliberation",
      action: "started",
      actorId: "lead",
      payload: { decisionPoint: "choose adapter" },
      idempotencyKey: "collab-1",
    }, "2026-11-21T00:01:00.000Z");
    assert.equal(first?.status, "appended");
    assert.equal(first?.record.collaborationRevision, 1);
    assert.equal(first?.record.kind, "deliberation");

    const replay = appendWorkItemCollaboration(store, {
      workItemId: item.id,
      expectedWorkItemRevision: 999,
      expectedCollaborationRevision: 999,
      kind: "deliberation",
      action: "started",
      actorId: "lead",
      payload: { decisionPoint: "choose adapter" },
      idempotencyKey: "collab-1",
    }, "2026-11-21T00:02:00.000Z");
    assert.equal(replay?.status, "replayed");
    assert.equal(replay?.record.id, first?.record.id);

    const stale = appendWorkItemCollaboration(store, {
      workItemId: item.id,
      expectedWorkItemRevision: item.revision,
      expectedCollaborationRevision: 0,
      kind: "question",
      action: "created",
      actorId: "worker",
      payload: { text: "Which adapter?" },
      idempotencyKey: "collab-2",
    }, "2026-11-21T00:03:00.000Z");
    assert.equal(stale, undefined);

    const second = appendWorkItemCollaboration(store, {
      workItemId: item.id,
      expectedWorkItemRevision: first.workItemRevision,
      expectedCollaborationRevision: 1,
      kind: "question",
      action: "created",
      actorId: "worker",
      payload: { text: "Which adapter?" },
      parentRecordId: first.record.id,
      idempotencyKey: "collab-2",
    }, "2026-11-21T00:03:30.000Z");
    assert.equal(second?.record.parentRecordId, first?.record.id);

    const page = listWorkItemCollaboration(store, { workItemId: item.id, kind: "question" });
    assert.equal(page.records.length, 1);
    assert.deepEqual(page.records[0]?.payload, { text: "Which adapter?" });
    assert.equal(page.nextAfterRevision, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
