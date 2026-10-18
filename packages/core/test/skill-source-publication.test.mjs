import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, getBuiltinSkillPack, GSTACK_DEFAULT_SKILL_PACK_ID } from "../dist/index.js";
import { SqliteSkillRegistryStore } from "../dist/storage/sqlite/skill-registry-store.js";

const before = "2026-10-15T10:00:00.000Z", now = "2026-10-15T11:00:00.000Z";
const source = (skillId, version = "1", extra = {}) => ({ id: `${skillId}-${version}`, skillId,
  sourceKind: "gstack-skill-directory", upstreamName: "gstack", upstreamVersion: version,
  sourceChecksum: `sha256:${skillId}-${version}`, rawSkillMarkdown: `# ${skillId} ${version}\n`,
  reviewStatus: "published", ...extra });
const update = (skillId, old = "1", next = "2") => ({ snapshot: source(skillId, next),
  expectedSnapshotId: `${skillId}-${old}`, expectedSourceChecksum: `sha256:${skillId}-${old}` });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-source-publication-"));
  const store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(join(cwd, ".ling-stack/ling-stack.sqlite"));
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  for (const id of ["review", "qa"]) store.upsertSkillSourceSnapshot(source(id), before);
  return { cwd, store, database };
}

test("whole source batch and artifacts commit together and survive reopening", async t => {
  const { store, cwd } = await fixture(t);
  const records = [update("review"), update("qa")];
  records[0].artifacts = [{ id: "review-ref", snapshotId: "review-2", path: "SKILL.md", kind: "other",
    checksum: "sha256:review-2", sizeBytes: 12, storageRef: "skill-source/review-2/source.md", reviewStatus: "published" }];
  const result = store.publishSkillSourceBatch({ records }, now);
  assert.deepEqual(result.snapshots.map(s => s.id), ["review-2", "qa-2"]);
  assert.equal(result.artifacts.length, 1);
  const reopened = createSqliteRunStore(cwd);
  try {
    for (const skill of ["review", "qa"]) {
      assert.equal(reopened.getSkillSourceSnapshot(skill).id, `${skill}-2`);
      assert.equal(reopened.getSkillSourceSnapshotById(`${skill}-1`).reviewStatus, "archived");
    }
    assert.equal(reopened.getSkillSourceArtifact("review-ref").snapshotId, "review-2");
  } finally { reopened.close(); }
});

test("failure on the last snapshot rolls back earlier sources and new registry definitions", async t => {
  const { store, database } = await fixture(t);
  const original = store.listSkillSourceSnapshots({ includeArchived: true });
  const definition = { ...getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID).skills[0], id: "new-fixture-skill" };
  database.exec(`CREATE TRIGGER fail_source_batch BEFORE INSERT ON skill_source_snapshots
    WHEN NEW.id = 'qa-2' BEGIN SELECT RAISE(ABORT, 'injected batch failure'); END;`);
  assert.throws(() => store.publishSkillSourceBatch({
    records: [{ snapshot: source(definition.id) }, update("review"), update("qa")],
    newSkills: { source: "gstack", name: "Fixture", description: "Fixture", definitions: [{ definition }] },
  }, now), /injected batch failure/);
  assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }), original);
  assert.equal(store.getSkillRegistryEntry(definition.id), undefined);
  assert.equal(database.prepare("SELECT count(*) n FROM skill_import_drafts").get().n, 0);
});

test("stale preview cannot overwrite a newer publication or same-id source edit", async t => {
  const { store } = await fixture(t);
  const stale = [update("review"), update("qa")];
  store.publishSkillSourceBatch({ records: [update("qa", "1", "3")] }, now);
  assert.throws(() => store.publishSkillSourceBatch({ records: stale }, now), { code: "skill_source_publication_conflict" });
  assert.equal(store.getSkillSourceSnapshot("review").id, "review-1");
  store.upsertSkillSourceSnapshot(source("review", "1", { sourceChecksum: "changed" }), now);
  assert.throws(() => store.publishSkillSourceBatch({ records: [update("review")] }, now), { code: "skill_source_publication_conflict" });
});

test("identical concurrent publication converges without duplicate history or timestamp churn", async t => {
  const { store } = await fixture(t);
  const first = store.publishSkillSourceBatch({ records: [update("review"), update("qa")] }, now);
  const retry = store.publishSkillSourceBatch({ records: [
    { ...update("review"), snapshot: source("review", "2", { id: "retry-review" }) },
    { ...update("qa"), snapshot: source("qa", "2", { id: "retry-qa" }) },
  ] }, "2026-10-15T12:00:00.000Z");
  assert.deepEqual(retry, first);
  assert.equal(store.listSkillSourceSnapshots({ includeArchived: true }).length, 4);
});

test("initialization-only identical retry converges, while a different version cannot bypass the history fence", async t => {
  const { store } = await fixture(t);
  const first = store.publishSkillSourceBatch({ records: [{ requireNoSourceHistory: true, snapshot: source("new-bundled") }] }, now);
  const retry = store.publishSkillSourceBatch({ records: [{ requireNoSourceHistory: true,
    snapshot: source("new-bundled", "1", { id: "retry-id" }) }] }, "2026-10-15T12:00:00.000Z");
  assert.deepEqual(retry, first);
  assert.equal(store.listSkillSourceSnapshots({ skillId: "new-bundled", includeArchived: true }).length, 1);
  assert.throws(() => store.publishSkillSourceBatch({ records: [{ ...update("new-bundled"), requireNoSourceHistory: true }] }, now),
    { code: "skill_source_publication_conflict" });
  const explicit = store.publishSkillSourceBatch({ records: [update("new-bundled")] }, now);
  assert.equal(explicit.snapshots[0].upstreamVersion, "2");
});

test("independent readers cannot see half a batch and competing writers are fenced", async t => {
  const { cwd, database } = await fixture(t);
  const observer = new DatabaseSync(join(cwd, ".ling-stack/ling-stack.sqlite"));
  t.after(() => observer.close());
  observer.exec("PRAGMA busy_timeout = 0");
  const published = () => observer.prepare("SELECT id FROM skill_source_snapshots WHERE review_status = 'published' ORDER BY id").all().map(row => row.id);
  let observed = 0;
  database.function("observe_source_batch", () => {
    observed++;
    assert.deepEqual(published(), ["qa-1", "review-1"]);
    assert.throws(() => observer.prepare("DELETE FROM skill_source_snapshots WHERE id = 'qa-1'").run(), /locked/);
    return 1;
  });
  database.exec(`CREATE TEMP TRIGGER source_batch_observer AFTER INSERT ON skill_source_snapshots
    WHEN NEW.id = 'review-2' BEGIN SELECT observe_source_batch(); END;`);
  new SqliteSkillRegistryStore({ database }).publishSkillSourceBatch({ records: [update("review"), update("qa")] }, now);
  assert.equal(observed, 1);
  assert.deepEqual(published(), ["qa-2", "review-2"]);
});

test("duplicate identities, snapshot history overwrites and mismatched artifacts fail closed", async t => {
  const { store } = await fixture(t);
  const original = store.listSkillSourceSnapshots({ includeArchived: true });
  for (const records of [
    [update("review"), update("review")],
    [{ ...update("review"), snapshot: source("review", "2", { id: "review-1" }) }],
    [{ ...update("review"), artifacts: [{ snapshotId: "other" }] }],
  ]) {
    assert.throws(() => store.publishSkillSourceBatch({ records }, now), { code: "skill_source_publication_invalid" });
    assert.deepEqual(store.listSkillSourceSnapshots({ includeArchived: true }), original);
  }
});

test("nested import failure rolls back its savepoint without ending the caller's transaction", async t => {
  const { store, database } = await fixture(t);
  const definition = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID).skills[0];
  const draft = store.createSkillImportDraft({ source: "gstack", packId: "nested-fixture", name: "Nested", description: "Fixture",
    definitions: ["nested-first", "nested-last"].map(id => ({ definition: { ...definition, id } })) }, before);
  database.exec(`CREATE TEMP TRIGGER reject_nested_import BEFORE INSERT ON skill_definitions
    WHEN NEW.id = 'nested-last' BEGIN SELECT RAISE(ABORT, 'injected nested failure'); END;`);
  database.exec("BEGIN IMMEDIATE");
  try {
    const writer = new SqliteSkillRegistryStore({ database });
    assert.throws(() => writer.publishSkillImportDraft(draft.id, now), /injected nested failure/);
    assert.equal(database.isTransaction, true);
    assert.equal(writer.getSkillRegistryEntry("nested-first"), undefined);
    assert.equal(database.prepare("SELECT id FROM skill_packs WHERE id = 'nested-fixture'").get(), undefined);
    database.exec("COMMIT");
  } catch (error) { if (database.isTransaction) database.exec("ROLLBACK"); throw error; }
});
