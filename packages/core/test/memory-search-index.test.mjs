import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";
import { initializeMemorySearchIndex, rebuildMemorySearchIndex, refreshMemorySearchIndex } from "../dist/storage/sqlite/memory-search-index.js";
import { SqliteMemoryRetrievalStore } from "../dist/storage/sqlite/memory-retrieval-store.js";

const now = "2026-10-01T00:00:00.000Z";
const request = { intent: "channel-reply", channelId: "allowed", query: "数据库备份", maxResults: 6 };
const ids = result => result.memories.map(item => item.memory.id);
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-memory-search-"));
  let store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { database, get store() { return store; }, reopen() { store.close(); store = createSqliteRunStore(cwd); },
    create(id, values = {}) { return store.createMemoryObject({ id, scopeType: "channel", ownerId: "allowed",
      title: "数据库备份", body: "每天核验数据库备份文件。", ...values }, now); } };
}

test("FTS candidates retain lexical Unicode/identifier/tag semantics and do not leak filtered bodies", async t => {
  const f = await fixture(t);
  f.create("backup");
  f.create("foreign", { ownerId: "forbidden", title: "secret foreign database title" });
  f.create("disabled", { enabled: false });
  f.create("candidate", { reviewState: "candidate" });
  f.create("secret", { sensitivity: "secret-adjacent" });
  f.create("unicode", { title: "ΜΝΉΜΗ pre_node_service-post", body: "Unicode only", tags: ["x", "deploy"] });
  f.create("punctuation", { title: "Odd tag", body: "exact tag only", tags: ['foo" OR bar', "的"] });
  for (const input of [request, { ...request, query: "μνήμη" }, { ...request, query: "node_service" },
    { ...request, query: "", tags: ["x", "deploy"] }, { ...request, query: "", tags: ['foo" OR bar'] },
    { ...request, query: "", tags: ["的", "deploy"] }, { ...request, query: "impossible_sentinel_9876" }]) {
    const indexed = f.store.recallMemory(input);
    f.database.exec("UPDATE memory_search_index_state SET version = -1");
    const fallback = f.store.recallMemory(input);
    f.database.exec("UPDATE memory_search_index_state SET version = 1");
    assert.deepEqual(indexed.memories, fallback.memories, JSON.stringify(input));
    assert.ok(!JSON.stringify(indexed).includes("secret foreign database title"));
  }
  assert.deepEqual(ids(f.store.recallMemory(request)), ["backup"]);
  assert.equal(f.store.recallMemory(request).audit.strategy, "fts5");
  assert.equal(f.store.recallMemory({ ...request, query: "missing" }).audit.candidateCount, 0);
});

test("raw SQL changes stay visible before refresh, then rebuild and restart preserve the same answers", async t => {
  const f = await fixture(t);
  f.create("target", { title: "Original", body: "No relevant content" });
  assert.deepEqual(ids(f.store.recallMemory(request)), []);
  f.database.prepare("UPDATE memory_objects SET body = ? WHERE id = ?").run("数据库备份", "target");
  assert.deepEqual(ids(f.store.recallMemory(request)), ["target"], "dirty rows must be scanned in the same SQLite snapshot");
  rebuildMemorySearchIndex(f.database);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM memory_search_dirty").get().n, 0);
  assert.deepEqual(ids(f.store.recallMemory(request)), ["target"]);
  f.database.exec("DROP TABLE memory_search_fts_v1");
  assert.equal(f.store.recallMemory(request).audit.strategy, "scan");
  f.create("while_unavailable");
  f.reopen();
  assert.deepEqual(new Set(ids(f.store.recallMemory(request))), new Set(["target", "while_unavailable"]));
  assert.equal(f.store.recallMemory(request).audit.strategy, "fts5");
  f.database.prepare("DELETE FROM memory_objects WHERE id = ?").run("target");
  assert.deepEqual(ids(f.store.recallMemory(request)), ["while_unavailable"]);
});

test("usage updates do not change content age or dirty/refresh the derived index", async t => {
  const f = await fixture(t);
  f.create("target");
  const index = f.database.prepare("SELECT rowid, tokens FROM memory_search_fts_v1").all();
  const result = f.store.recallMemory(request);
  f.store.recordUsedMemoryEvent({ memoryIds: ["target"], intent: request.intent, recallQuery: request.query,
    policyVersion: result.policyVersion }, "2026-10-02T00:00:00.000Z");
  assert.equal(f.store.getMemoryObject("target").updatedAt, now);
  assert.equal(f.store.getMemoryObject("target").lastUsedAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(f.database.prepare("SELECT rowid, tokens FROM memory_search_fts_v1").all(), index);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM memory_search_dirty").get().n, 0);
});

test("an unsupported FTS runtime opens an indexed database and uses lexical fallback without touching FTS", async t => {
  const f = await fixture(t);
  f.create("target");
  f.database.function("fts5_source_id", () => { throw new Error("no such function: fts5_source_id"); });
  assert.doesNotThrow(() => initializeMemorySearchIndex(f.database));
  f.database.prepare("UPDATE memory_objects SET title = ? WHERE id = ?").run("Changed 数据库备份", "target");
  assert.doesNotThrow(() => refreshMemorySearchIndex(f.database));
  const result = new SqliteMemoryRetrievalStore({ database: f.database }).recallMemory(request);
  assert.equal(result.audit.strategy, "scan");
  assert.deepEqual(ids(result), ["target"]);
});

test("a failed index write rolls back its source mutation instead of returning a partially saved memory", async t => {
  const f = await fixture(t);
  f.database.exec("CREATE TRIGGER fail_search_refresh BEFORE DELETE ON memory_search_dirty BEGIN SELECT RAISE(ABORT, 'synthetic index failure'); END");
  assert.throws(() => f.create("rolled_back"), /synthetic index failure/);
  assert.equal(f.store.getMemoryObject("rolled_back"), undefined);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM memory_search_fts_v1").get().n, 0);
});

test("frozen recall labels and 1k/10k fixtures report quality, latency and candidate work", async t => {
  const f = await fixture(t);
  f.create("backup");
  f.create("identifier", { title: "restore_snapshot_v2", body: "Verify checksum before restoring." });
  f.create("foreign", { ownerId: "forbidden", title: "数据库备份 restore_snapshot_v2" });
  f.create("expired");
  f.store.upsertMemorySelfImprovingMetadata({ memoryId: "expired", kind: "workflow_lesson", trigger: "manual_review",
    lesson: "Old policy", validUntil: "2000-01-01T00:00:00Z" });
  const labels = [
    { query: "请说明数据库应该怎样备份", expected: "backup" },
    { query: "restore_snapshot_v2", expected: "identifier" },
    { query: "qz987654_absent", expected: undefined },
  ];
  const insert = f.database.prepare(`INSERT INTO memory_objects
    (id, workspace_id, scope_type, owner_id, title, body, tags_json, source_refs_json, review_state, enabled,
      sensitivity, verify_before_use, created_at, updated_at)
    VALUES (?, 'workspace_default', 'channel', 'allowed', 'Filler', 'Unrelated synthetic theme', '[]', '[]', 'active', 1, 'normal', 0, ?, ?)`);
  let inserted = 0;
  for (const size of [1_000, 10_000]) {
    f.database.exec("BEGIN IMMEDIATE");
    try { while (inserted < size) insert.run(`filler_${inserted++}`, now, now); f.database.exec("COMMIT"); }
    catch (error) { f.database.exec("ROLLBACK"); throw error; }
    const rebuildStart = performance.now();
    rebuildMemorySearchIndex(f.database);
    const rebuildMs = performance.now() - rebuildStart;
    let reciprocalRank = 0, hits = 0, noAnswerFalseHits = 0;
    for (const label of labels) {
      const actual = ids(f.store.recallMemory({ ...request, query: label.query }));
      if (!label.expected) noAnswerFalseHits += actual.length;
      else { const rank = actual.indexOf(label.expected); if (rank >= 0) { hits++; reciprocalRank += 1 / (rank + 1); } }
      assert.ok(!actual.includes("foreign") && !actual.includes("expired"));
    }
    const samples = [], scanSamples = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now(); f.store.recallMemory(request); samples.push(performance.now() - start);
    }
    f.database.exec("UPDATE memory_search_index_state SET version = -1");
    for (let i = 0; i < 5; i++) {
      const start = performance.now(); f.store.recallMemory(request); scanSamples.push(performance.now() - start);
    }
    f.database.exec("UPDATE memory_search_index_state SET version = 1");
    samples.sort((a, b) => a - b); scanSamples.sort((a, b) => a - b);
    const report = { size, recallAt6: hits / 2, mrr: reciprocalRank / 2, noAnswerFalseHits, isolationViolations: 0,
      candidateCount: f.store.recallMemory(request).audit.candidateCount, rebuildMs,
      indexedP50Ms: samples[5], indexedP95Ms: samples[9], fallbackP50Ms: scanSamples[2] };
    t.diagnostic(JSON.stringify(report));
    assert.equal(report.recallAt6, 1); assert.equal(report.mrr, 1); assert.equal(noAnswerFalseHits, 0);
    assert.equal(report.candidateCount, 1);
  }
  const plan = f.database.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM memory_search_fts_v1 WHERE memory_search_fts_v1 MATCH ?").all('"g6461"');
  assert.ok(plan.some(row => /VIRTUAL TABLE INDEX/.test(row.detail)));
});
