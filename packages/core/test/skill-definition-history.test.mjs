import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore } from "../dist/index.js";

const now = "2026-10-01T00:00:00.000Z";
const definition = { id: "history_skill", name: "History skill", summary: "Original summary", roleAffinity: ["engineer"],
  promptFragments: ["Read the receipt and compare both totals."], requiredTools: ["read"],
  requiredProviderCapabilities: ["chat"], approvalProfile: { mode: "none" }, stateEffects: [] };
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-skill-history-"));
  let store = createSqliteRunStore(cwd);
  const database = new DatabaseSync(store.paths.databasePath);
  const draft = store.createSkillImportDraft({ source: "custom", sourcePath: "skills.json", name: "History pack",
    description: "History pack", definitions: [{ definition }] }, now);
  const original = store.publishSkillImportDraft(draft.id, now)[0];
  t.after(async () => { database.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  return { database, original, get store() { return store; }, reopen() { store.close(); store = createSqliteRunStore(cwd); },
    edit(summary, values = {}) {
      const current = store.getSkillRegistryEntry(definition.id);
      const draft = store.createSkillImportDraft({ source: current.source, packId: current.packId, name: current.definition.name,
        description: summary, definitions: [{ definition: { ...current.definition, summary, ...values.definition } }] }, now);
      return store.publishSkillRevisionDraft({ draftId: draft.id, skillId: current.id, expectedUpdatedAt: current.updatedAt,
        expectedRevisionId: store.getSkillDefinitionRevision(current.id).id, ...values.input }, values.now ?? now);
    } };
}

test("definition history captures immutable before/after, provenance and a durable notice in the source transaction", async t => {
  const f = await fixture(t);
  const created = f.store.getSkillDefinitionRevision(definition.id);
  assert.equal(created.kind, "create"); assert.equal(created.beforeDefinition, undefined);
  const updated = f.edit("Improved summary", { input: { actor: "local-user", reason: "Confirmed correction",
    sourceJobId: "job", sourceCandidateId: "candidate", validationStatus: "evidence_checked" } });
  const head = f.store.getSkillDefinitionRevision(definition.id);
  assert.deepEqual(head.beforeDefinition, definition); assert.equal(head.afterDefinition.summary, "Improved summary");
  assert.equal(head.baseRevisionId, created.id); assert.equal(head.revision, created.revision + 1);
  assert.equal(head.sourceJobId, "job"); assert.equal(head.sourceCandidateId, "candidate");
  assert.equal(head.validationStatus, "evidence_checked"); assert.equal(head.reason, "Confirmed correction");
  assert.deepEqual(f.store.getSkillDefinitionRevision(definition.id, created.id), created);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM skill_definition_revision_notices WHERE revision_id = ?").get(head.id).n, 1);
  for (const field of ["id", "workspaceId", "packId", "source", "sourcePath", "visibility", "createdAt"]) assert.deepEqual(updated[field], f.original[field]);
  assert.equal(f.store.getSkillDefinitionRevision("other", head.id), undefined);
});

test("undo appends a restoring revision, preserves authority and is idempotent even after another edit", async t => {
  const f = await fixture(t);
  const updated = f.edit("Improved summary");
  const target = f.store.getSkillDefinitionRevision(definition.id);
  const request = { revisionId: target.id, expectedUpdatedAt: updated.updatedAt };
  const undo = f.store.undoSkillDefinitionRevision(definition.id, request, now);
  assert.equal(undo.reused, false); assert.equal(undo.revision.kind, "undo");
  assert.equal(undo.revision.undoOfRevisionId, target.id); assert.equal(undo.revision.baseRevisionId, target.id);
  assert.deepEqual(undo.skill.definition, f.original.definition);
  assert.equal(undo.skill.sourcePath, f.original.sourcePath);
  assert.equal(undo.revision.validationStatus, "not_run", "restoration is not a new runtime validation");
  f.edit("Later deliberate edit");
  const repeated = f.store.undoSkillDefinitionRevision(definition.id, request, now);
  assert.equal(repeated.reused, true); assert.equal(repeated.revision.id, undo.revision.id);
  assert.equal(repeated.skill.definition.summary, "Later deliberate edit", "a retry cannot overwrite subsequent work");
});

test("a later edit or stale monotonic revision rejects undo/publication without losing current work", async t => {
  const f = await fixture(t);
  const first = f.edit("First correction");
  const target = f.store.getSkillDefinitionRevision(definition.id);
  const current = f.edit("Second correction");
  assert.ok(current.updatedAt > first.updatedAt, "same-millisecond writes still advance the legacy CAS timestamp");
  assert.throws(() => f.store.undoSkillDefinitionRevision(definition.id,
    { revisionId: target.id, expectedUpdatedAt: current.updatedAt }, now), error => error.code === "skill_revision_conflict");
  assert.throws(() => f.edit("Stale publication", { input: { expectedRevisionId: target.id } }), error => error.code === "skill_revision_conflict");
  assert.equal(f.store.getSkillRegistryEntry(definition.id).definition.summary, "Second correction");
  assert.equal(f.store.listSkillDefinitionRevisions(definition.id).length, 3);
});

test("undo never silently changes tools/provider/approval authority", async t => {
  const f = await fixture(t);
  const updated = f.edit("Explicit authority edit", { definition: { requiredTools: ["read", "bash"] } });
  const target = f.store.getSkillDefinitionRevision(definition.id);
  const request = { revisionId: target.id, expectedUpdatedAt: updated.updatedAt };
  assert.throws(() => f.store.undoSkillDefinitionRevision(definition.id, request, now),
    error => error.code === "skill_revision_confirmation_required");
  assert.deepEqual(f.store.getSkillRegistryEntry(definition.id).definition.requiredTools, ["read", "bash"]);
  const undo = f.store.undoSkillDefinitionRevision(definition.id, { ...request, confirmAuthorityChanges: true }, now);
  assert.deepEqual(undo.skill.definition.requiredTools, ["read"]);
});

test("imports and direct owning-source updates also enter history; historical migration only captures the current baseline", async t => {
  const f = await fixture(t);
  f.edit("Current definition");
  f.database.exec(`DROP TRIGGER skill_definition_history_create; DROP TRIGGER skill_definition_history_update;
    DROP TRIGGER skill_definition_history_notice; DROP TABLE skill_definition_revision_notices;
    DROP TABLE skill_definition_revisions; DELETE FROM schema_migrations WHERE version = 178`);
  f.reopen();
  const history = f.store.listSkillDefinitionRevisions(definition.id);
  assert.equal(history.length, 1); assert.equal(history[0].kind, "baseline");
  assert.equal(history[0].beforeDefinition, undefined); assert.equal(history[0].afterDefinition.summary, "Current definition");
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM skill_definition_revision_notices").get().n, 0);
  assert.throws(() => f.store.undoSkillDefinitionRevision(definition.id,
    { revisionId: history[0].id, expectedUpdatedAt: f.store.getSkillRegistryEntry(definition.id).updatedAt }, now),
    error => error.code === "skill_revision_invalid");
  f.database.prepare("UPDATE skill_definitions SET definition_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...definition, summary: "Owning source change" }), definition.id);
  assert.equal(f.store.listSkillDefinitionRevisions(definition.id).length, 2);
  assert.equal(f.store.getSkillDefinitionRevision(definition.id).afterDefinition.summary, "Owning source change");
});

test("failed history/outbox insertion rolls back the definition edit and its history", async t => {
  const f = await fixture(t);
  const before = f.store.listSkillDefinitionRevisions(definition.id);
  f.database.exec("CREATE TRIGGER fail_history_notice BEFORE INSERT ON skill_definition_revision_notices BEGIN SELECT RAISE(ABORT, 'synthetic notice failure'); END");
  assert.throws(() => f.edit("Must roll back"), /synthetic notice failure/);
  assert.deepEqual(f.store.getSkillRegistryEntry(definition.id), f.original);
  assert.deepEqual(f.store.listSkillDefinitionRevisions(definition.id), before);
});

test("hard deletion removes the definition history and its notices under the existing ownership rules", async t => {
  const f = await fixture(t);
  f.edit("Corrected");
  f.store.archiveSkillRegistryEntry(definition.id, "2026-10-02T00:00:00.000Z");
  const result = f.store.hardDeleteSkillRegistryEntry(definition.id);
  assert.equal(result.status, "deleted");
  assert.deepEqual(f.store.listSkillDefinitionRevisions(definition.id), []);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM skill_definition_revision_notices").get().n, 0);
});


test("revision notices recover after reopening, deliver once and roll back with their durable event", async t => {
  const f = await fixture(t);
  f.edit("Recovery revision");
  f.reopen();
  f.database.exec("CREATE TRIGGER fail_notice_ack BEFORE UPDATE OF notified_at ON skill_definition_revision_notices BEGIN SELECT RAISE(ABORT, 'synthetic ack failure'); END");
  assert.throws(() => f.store.drainSkillDefinitionRevisionNotices(f.store.paths.cwd, now), /synthetic ack failure/);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM skill_definition_revision_notices WHERE notified_at IS NULL").get().n, 2);
  f.database.exec("DROP TRIGGER fail_notice_ack");
  const events = f.store.drainSkillDefinitionRevisionNotices(f.store.paths.cwd, now);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map(event => event.idempotencyKey)).size, 2);
  assert.equal(events[1].data.revisionId, f.store.getSkillDefinitionRevision(definition.id).id);
  assert.equal(events[1].data.validationStatus, "not_run");
  assert.deepEqual(f.store.drainSkillDefinitionRevisionNotices(f.store.paths.cwd, now), []);
  f.reopen();
  assert.deepEqual(f.store.drainSkillDefinitionRevisionNotices(f.store.paths.cwd, now), []);
});
