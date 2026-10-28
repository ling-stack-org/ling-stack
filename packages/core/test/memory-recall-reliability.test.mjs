import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { SqliteMemoryRetrievalStore } from "../dist/storage/sqlite/memory-retrieval-store.js";

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-memory-h3-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const create = (id, values = {}) => store.createMemoryObject({
    id, scopeType: "channel", ownerId: "allowed", title: "Synthetic fact", body: "Synthetic body", ...values,
  }, "2026-01-01T00:00:00.000Z");
  const recall = (values = {}) => store.recallMemory({ channelId: "allowed", intent: "channel-reply", query: "sentinel", ...values });
  const health = (memoryId, values) => store.upsertMemorySelfImprovingMetadata({
    memoryId, kind: "workflow_lesson", trigger: "manual_review", lesson: "Synthetic health fixture", ...values,
  });
  const flood = (count, ownerId = "allowed", body = "Unrelated filler") => {
    const insert = database.prepare(`INSERT INTO memory_objects (
      id, workspace_id, scope_type, owner_id, title, body, tags_json, source_refs_json, review_state,
      enabled, sensitivity, verify_before_use, created_at, updated_at
    ) VALUES (?, 'workspace_default', 'channel', ?, 'Newer filler', ?, '[]', '[]', 'active', 1, 'normal', 0,
      '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`);
    database.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < count; i++) insert.run(`filler_${i}`, ownerId, body);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  };
  return { cwd, store, database, create, recall, health, flood };
}

const ids = (result) => result.memories.map((item) => item.memory.id);

test("prepared Memory eligibility reuses scope/health checks without ranking or inspection overrides", async (t) => {
  const f = await fixture(t);
  f.create("eligible", { title: "No matching query needed" });
  f.create("foreign", { ownerId: "other" });
  f.create("disabled", { enabled: false });
  f.create("expired"); f.health("expired", { validUntil: "2000-01-01T00:00:00Z" });
  f.create("secret", { sensitivity: "secret-adjacent" });
  const result = f.store.getEligibleMemoryIdsForRecall({ channelId: "allowed", query: "unmatched", intent: "review",
    includeDisabled: true, includePrivate: true, includeSecretAdjacent: true }, ["foreign", "eligible", "disabled", "expired", "secret", "missing"]);
  assert.deepEqual(result, ["eligible"]);
  assert.deepEqual(f.store.getEligibleMemoryIdsForRecall({ channelId: "allowed", query: "", intent: "task-run" }, []), []);
  assert.throws(() => f.store.getEligibleMemoryIdsForRecall({ query: "", intent: "task-run" }, Array(21).fill("eligible")), /Invalid prepared memory/);
});

test("relevant oldest memory survives more than 500 newer same-scope records", async (t) => {
  const f = await fixture(t);
  f.create("old_target", { title: "sentinel" }); f.flood(501);
  assert.deepEqual(ids(f.recall()), ["old_target"]);
});

test("another channel cannot crowd relevant scoped memory out before filtering", async (t) => {
  const f = await fixture(t);
  f.create("old_target", { title: "sentinel" }); f.flood(600, "other", "sentinel private noise");
  assert.deepEqual(ids(f.recall()), ["old_target"]);
});

test("relevance is evaluated before the result limit, even beyond the old candidate window", async (t) => {
  const f = await fixture(t);
  f.create("strong_old", { title: "sentinel" }); f.flood(501, "allowed", "sentinel");
  assert.deepEqual(ids(f.recall({ maxResults: 1 })), ["strong_old"]);
});

test("Chinese lexical fragments recall shared facts without requiring the full sentence", async (t) => {
  const f = await fixture(t);
  f.create("backup", { title: "数据库备份方案", body: "每天凌晨进行数据库备份，完成后核验文件。" });
  f.create("unrelated", { title: "颜色设置", body: "浅色主题使用白色背景。" });
  assert.deepEqual(ids(f.recall({ query: "请说明数据库应该怎样备份" })), ["backup"]);
  const terms = f.recall({ query: "请说明数据库应该怎样备份" }).memories[0].matchedTerms;
  assert.ok(terms.includes("备份"));
  assert.ok(terms.every((term) => Array.from(term).length >= 2));
});

test("expired, invalid-expiry and superseded memories are not current facts", async (t) => {
  const f = await fixture(t);
  for (const id of ["current", "expired", "invalid", "replaced", "future"]) f.create(id, { title: "sentinel" });
  f.health("expired", { validUntil: "2000-01-01T00:00:00.000Z" });
  f.health("invalid", { validUntil: "not-a-date" });
  f.health("replaced", { supersededBy: "missing-or-private-replacement" });
  f.health("future", { validUntil: "2999-01-01T00:00:00.000Z" });
  assert.deepEqual(new Set(ids(f.recall())), new Set(["current", "future"]));
  assert.ok(f.store.getMemoryObject("expired"), "recall must not delete history");
});

test("expiry comparison honors timezone and expires exactly at the boundary", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-07T00:00:00Z") });
  f.create("boundary", { title: "sentinel" }); f.create("future", { title: "sentinel" });
  f.health("boundary", { validUntil: "2026-09-07T08:00:00+08:00" });
  f.health("future", { validUntil: "2026-09-07T08:00:01+08:00" });
  assert.deepEqual(ids(f.recall()), ["future"]);
});

test("includeDisabled is inspection-only and cannot activate candidates for execution", async (t) => {
  const f = await fixture(t);
  f.create("candidate", { title: "sentinel", reviewState: "candidate" });
  f.create("disabled", { title: "sentinel", enabled: false });
  f.create("expired", { title: "sentinel" }); f.health("expired", { validUntil: "2000-01-01T00:00:00Z" });
  assert.deepEqual(ids(f.recall({ intent: "task-run", includeDisabled: true })), []);
  assert.deepEqual(ids(f.recall({ intent: "search" })), []);
  assert.deepEqual(new Set(ids(f.recall({ intent: "review", includeDisabled: true }))), new Set(["candidate", "disabled", "expired"]));
});

test("private teammate recall does not include other agents, channels, workspaces or secrets", async (t) => {
  const f = await fixture(t);
  f.create("mine", { title: "sentinel", scopeType: "teammate", ownerId: "agent_a", sensitivity: "private" });
  f.create("peer", { title: "sentinel", scopeType: "teammate", ownerId: "agent_b", sensitivity: "private" });
  f.create("channel", { title: "sentinel" });
  f.create("secret", { title: "sentinel", scopeType: "teammate", ownerId: "agent_a", sensitivity: "secret-adjacent" });
  assert.deepEqual(ids(f.recall({ channelId: undefined, teammateId: "agent_a", intent: "private-chat" })), ["mine"]);
  assert.deepEqual(ids(f.recall({ workspaceId: "other_workspace" })), []);
  assert.deepEqual(ids(f.recall({ channelId: "x' OR 1=1 --" })), []);
});

test("health and review revocation take effect on the next recall without resurrecting cached content", async (t) => {
  const f = await fixture(t);
  f.create("target", { title: "sentinel", verifyBeforeUse: true });
  assert.equal(f.recall().memories[0].memory.verifyBeforeUse, true);
  f.health("target", { supersededBy: "replacement" });
  assert.deepEqual(ids(f.recall()), []);
  f.health("target", { supersededBy: null });
  assert.deepEqual(ids(f.recall()), ["target"]);
  f.store.updateMemoryObject("target", { enabled: false }, "2026-09-07T00:00:00Z");
  assert.deepEqual(ids(f.recall()), []);
});

test("tag-only, case-insensitive and Unicode recall remain supported with stable ties", async (t) => {
  const f = await fixture(t);
  f.create("memory_a", { title: "SENTINEL ΜΝΉΜΗ", tags: ["Backend"] });
  f.create("memory_b", { title: "SENTINEL ΜΝΉΜΗ", tags: ["Backend"] });
  assert.deepEqual(ids(f.recall()), ["memory_b", "memory_a"]);
  assert.deepEqual(ids(f.recall({ query: "μνήμη" })), ["memory_b", "memory_a"]);
  assert.equal(f.recall({ query: "", tags: ["backend"], maxResults: 1 }).memories.length, 1);
});

test("empty browse is explicit; single-character and punctuation queries cannot return unrelated memories", async (t) => {
  const f = await fixture(t); f.create("target", { title: "sentinel" });
  assert.deepEqual(ids(f.recall({ query: "" })), ["target"]);
  assert.deepEqual(ids(f.recall({ query: "的" })), []);
  assert.deepEqual(ids(f.recall({ query: "???" })), []);
});

test("caller limits stay bounded and non-finite limits do not silently become empty success", async (t) => {
  const f = await fixture(t); f.flood(25, "allowed", "sentinel");
  assert.equal(f.recall({ maxResults: 999 }).memories.length, 20);
  assert.equal(f.recall({ maxResults: 0 }).memories.length, 1);
  assert.equal(f.recall({ maxResults: 2.5 }).memories.length, 2);
  for (const maxResults of [NaN, Infinity, -Infinity]) assert.throws(() => f.recall({ maxResults }), RangeError);
});

test("recall reads committed snapshots and does not write or retain a transaction", async (t) => {
  const f = await fixture(t); f.create("target", { title: "sentinel" });
  const version = f.database.prepare("PRAGMA data_version").get().data_version;
  assert.deepEqual(ids(f.recall()), ["target"]);
  assert.equal(f.database.prepare("PRAGMA data_version").get().data_version, version);
  f.database.exec("BEGIN IMMEDIATE");
  try {
    f.database.prepare("UPDATE memory_objects SET enabled = 0 WHERE id = ?").run("target");
    assert.deepEqual(ids(f.recall()), ["target"], "another connection cannot observe uncommitted revocation");
    f.database.exec("COMMIT");
  } catch (error) { f.database.exec("ROLLBACK"); throw error; }
  assert.deepEqual(ids(f.recall()), [], "the next snapshot must observe committed revocation");
});

test("long and mixed-script queries have bounded matched terms without breaking escaped JSON recall", async (t) => {
  const f = await fixture(t);
  const words = Array.from({ length: 300 }, (_, index) => `term_${index}`);
  f.create("terms", { title: words.join(" ") });
  const result = f.recall({ query: words.join(" ") });
  assert.equal(result.memories[0].memory.id, "terms");
  assert.ok(result.memories[0].matchedTerms.length <= 32);
  f.create("mixed", { title: "Node 数据库备份" });
  assert.equal(f.recall({ query: "Node服务应该怎样备份数据库" }).memories[0].memory.id, "mixed");
  f.create("escaped", { title: "Synthetic", tags: ["备份"] });
  f.database.prepare("UPDATE memory_objects SET tags_json = ? WHERE id = ?").run('["\\u5907\\u4efd"]', "escaped");
  assert.ok(ids(f.recall({ query: "备份" })).includes("escaped"));
});

test("SQLite infrastructure failures are not normalized into empty recall results", () => {
  const failure = new Error("synthetic database unavailable");
  const retrieval = new SqliteMemoryRetrievalStore({ database: { prepare() { throw failure; } } });
  assert.throws(() => retrieval.recallMemory({ query: "sentinel", intent: "task-run" }), (error) => error === failure);
});

test("model recall shares authorized workspace/channel context without granting peer private or secret access", async (t) => {
  const f = await fixture(t);
  f.create("public", { title: "sentinel" });
  f.create("channel_private", { title: "sentinel", sensitivity: "private" });
  f.create("workspace_private", { title: "sentinel", scopeType: "workspace", ownerId: "workspace_default", sensitivity: "private" });
  f.create("mine", { title: "sentinel", scopeType: "teammate", ownerId: "agent_a", sensitivity: "private" });
  f.create("peer", { title: "sentinel", scopeType: "teammate", ownerId: "agent_b", sensitivity: "private" });
  f.create("secret", { title: "sentinel", scopeType: "teammate", ownerId: "agent_a", sensitivity: "secret-adjacent" });
  f.create("other_channel", { title: "sentinel", ownerId: "not_allowed", sensitivity: "private" });
  f.database.prepare("INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("other", "Synthetic other workspace", "2026-09-08T00:00:00Z", "2026-09-08T00:00:00Z");
  f.create("other_workspace", { title: "sentinel", workspaceId: "other", scopeType: "workspace", ownerId: "other", sensitivity: "private" });
  for (const intent of ["private-chat", "channel-reply", "task-run"]) {
    for (const explicit of [false, true]) {
      assert.deepEqual(new Set(ids(f.recall({ intent, teammateId: "agent_a", includePrivate: explicit, includeSecretAdjacent: explicit }))),
        new Set(["public", "channel_private", "workspace_private", "mine"]));
      assert.deepEqual(new Set(ids(f.recall({ intent, includePrivate: explicit, includeSecretAdjacent: explicit }))),
        new Set(["public", "channel_private", "workspace_private"]));
      assert.deepEqual(new Set(ids(f.recall({ intent, channelId: undefined, teammateId: "agent_b", includePrivate: explicit, includeSecretAdjacent: explicit }))),
        new Set(["workspace_private", "peer"]));
    }
  }
  assert.deepEqual(new Set(ids(f.recall({ intent: "review", teammateId: "agent_a", includePrivate: true, includeSecretAdjacent: true }))),
    new Set(["public", "channel_private", "workspace_private", "mine", "secret"]));
});

test('recall audit separates in-scope eligibility exclusions, retrieval candidates and selection without leaking rejected content', async t => {
 const f=await fixture(t);
 f.create('chosen',{title:'sentinel'}); f.create('unmatched');
 f.create('pending',{title:'sentinel',reviewState:'candidate'});
 f.create('secret',{title:'DO NOT EXPOSE',body:'hidden-sensitive',sensitivity:'secret-adjacent'});
 f.create('expired',{title:'sentinel'}); f.health('expired',{validUntil:'2000-01-01T00:00:00Z'});
 f.create('foreign',{ownerId:'other',title:'foreign-private-body'});
 const result=f.recall();
 assert.equal(result.audit.eligibleCount,2); assert.equal(result.audit.excludedCount,3);
 assert.deepEqual(result.audit.selectedMemoryIds,['chosen']);
 assert.ok(result.audit.candidateCount>=1); assert.ok(result.audit.candidateCount<=2);
 assert.doesNotMatch(JSON.stringify(result.audit),/foreign|hidden-sensitive|DO NOT EXPOSE|pending|expired/);
 assert.deepEqual(f.store.listUsedMemoryEvents(),[],'selection is not evidence of supplied context');
 f.store.recordUsedMemoryEvent({memoryIds:['chosen'],intent:'channel-reply',channelId:'allowed',
   recallQuery:'sentinel',policyVersion:result.policyVersion,responseId:'reply'},'2026-10-29T00:00:00Z');
 assert.deepEqual(f.store.listUsedMemoryEvents()[0].memoryIds,['chosen']);
});
