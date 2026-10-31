import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

test("recording Memory use changes recency, not its semantic revision", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-memory-use-revision-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const createdAt = "2026-10-24T01:00:00.000Z", usedAt = "2026-10-24T01:01:00.000Z";
  const memory = store.createMemoryObject({ scopeType: "teammate", ownerId: "owner",
    title: "Private project rule", body: "Verify the real result.", sensitivity: "private" }, createdAt);
  const event = store.recordUsedMemoryEvent({ memoryIds: [memory.id], teammateId: "owner",
    intent: "task-run", recallQuery: "project", policyVersion: "test" }, usedAt);
  const used = store.getMemoryObject(memory.id);
  assert.equal(used.lastUsedAt, usedAt);
  assert.equal(used.updatedAt, createdAt, "use must not make frozen role evidence appear edited");
  assert.equal(event.createdAt, usedAt);
  const { lastUsedAt: _usedAt, ...semanticState } = used;
  const { lastUsedAt: _beforeUse, ...originalState } = memory;
  assert.deepEqual(semanticState, originalState);

  const changedAt = "2026-10-24T01:02:00.000Z";
  store.updateMemoryObject(memory.id, { body: "A corrected project rule." }, changedAt);
  const changed = store.getMemoryObject(memory.id);
  assert.equal(changed.updatedAt, changedAt, "actual semantic updates still invalidate old evidence");
  assert.equal(changed.lastUsedAt, usedAt);
});
