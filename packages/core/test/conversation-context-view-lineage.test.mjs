import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const firstAt = "2026-11-17T01:00:00.000Z";
const secondAt = "2026-11-17T01:01:00.000Z";

function projection(overrides = {}) {
  return {
    projectionVersion: "projection-v1",
    sourceStateFingerprint: "source-v1",
    threadId: "thread_1",
    turnId: "turn_1",
    segmentId: "segment_1",
    throughItemSequence: 4,
    summaryIds: [],
    sourceRefs: [{ type: "thread", id: "thread_1" }],
    policyVersion: "continuity-v2-projector-v1",
    visibilityFingerprint: "visibility-v1",
    contextViewId: "view_1",
    contextViewCreatedAt: firstAt,
    ...overrides,
  };
}

test("context view lineage survives reopen and rejects stale or late materialization", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-view-lineage-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let store = createSqliteRunStore(cwd);
  const created = store.upsertConversationContextViewLineage({
    lineageKey: "lineage_1",
    workspaceId: "workspace_default",
    channelId: "channel_1",
    threadId: "thread_1",
    sourceItemId: "item_1",
    kind: "ling_agent_channel_view",
    consumerTeammateId: "agent_1",
    contextViewId: "view_1",
    contextViewCreatedAt: firstAt,
    projection: projection(),
    viewFingerprint: "view-shape-v1",
  }, firstAt);
  assert.equal(created.status, "created");
  assert.equal(store.getConversationContextViewLineage("lineage_1")?.contextViewId, "view_1");
  store.close();

  store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const recovered = store.getConversationContextViewLineage("lineage_1");
  assert.equal(recovered?.projection?.sourceStateFingerprint, "source-v1");
  assert.equal(recovered?.revision, 1);

  const older = store.upsertConversationContextViewLineage({
    lineageKey: "lineage_1",
    workspaceId: "workspace_default",
    kind: "ling_agent_channel_view",
    contextViewId: "view_old",
    contextViewCreatedAt: firstAt,
    projection: projection({ throughItemSequence: 3 }),
    viewFingerprint: "view-shape-old",
  }, secondAt);
  assert.deepEqual(older, { status: "rejected_stale", lineage: recovered, reason: "older_projection" });

  const olderWithMatchingCas = store.upsertConversationContextViewLineage({
    lineageKey: "lineage_1",
    workspaceId: "workspace_default",
    kind: "ling_agent_channel_view",
    contextViewId: "view_old_cas",
    contextViewCreatedAt: secondAt,
    projection: projection({ throughItemSequence: 3, contextViewId: "view_old_cas" }),
    viewFingerprint: "view-shape-old-cas",
    expectedCurrentViewId: "view_1",
  }, secondAt);
  assert.deepEqual(olderWithMatchingCas, { status: "rejected_stale", lineage: recovered, reason: "older_projection" });

  const late = store.upsertConversationContextViewLineage({
    lineageKey: "lineage_1",
    workspaceId: "workspace_default",
    kind: "ling_agent_channel_view",
    contextViewId: "view_late",
    contextViewCreatedAt: secondAt,
    projection: projection({ sourceStateFingerprint: "source-late", contextViewId: "view_late" }),
    viewFingerprint: "view-shape-late",
    expectedCurrentViewId: "view_old",
  }, secondAt);
  assert.equal(late.status, "rejected_stale");
  assert.equal(late.reason, "current_view_changed");
  assert.equal(store.getConversationContextViewLineage("lineage_1")?.contextViewId, "view_1");
});

test("context view lineage composes with a caller-owned transaction", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-context-view-lineage-transaction-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = createSqliteRunStore(cwd);
  t.after(() => store.close());
  const database = store.database;

  database.exec("BEGIN IMMEDIATE");
  const result = store.upsertConversationContextViewLineage({
    lineageKey: "lineage_transaction",
    workspaceId: "workspace_default",
    kind: "ling_agent_channel_view",
    contextViewId: "view_transaction",
    contextViewCreatedAt: firstAt,
    projection: projection({ contextViewId: "view_transaction" }),
    viewFingerprint: "view-shape-transaction",
  }, firstAt);
  assert.equal(result.status, "created");
  assert.equal(database.isTransaction, true);
  database.exec("COMMIT");

  assert.equal(store.getConversationContextViewLineage("lineage_transaction")?.contextViewId, "view_transaction");
});
