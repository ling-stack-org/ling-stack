import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore, createSqliteWorkflowTemplateRegistryStore, WorkflowTemplateRegistryError,
  workflowTemplateDigest } from "../dist/index.js";
import { at, businessSnapshot, fixture, persistSkill, registrySnapshot, saveInput, template } from "./support/workflow-template-registry-fixture.mjs";

const fails = (fn, code) => assert.throws(fn, error => error instanceof WorkflowTemplateRegistryError
  && error.code === `workflow_template_registry.${code}`);
const publish = (registry, saved, extra = {}) => registry.setReviewStatus({ id: saved.entry.id, reviewStatus: "published",
  version: saved.version.version, digest: saved.version.digest, expectedRevision: saved.entry.revision, now: at(1), ...extra });

test("SQLite registry factory is bound to the canonical RunStore and saving a draft never creates executable skills or work", t => {
  const f = fixture(t), before = businessSnapshot(f.db), skills = f.store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true });
  assert.equal(createSqliteWorkflowTemplateRegistryStore(f.store), f.registry);
  fails(() => createSqliteWorkflowTemplateRegistryStore({}), "store_not_sqlite");
  const saved = f.registry.saveVersion(saveInput());
  assert.equal(saved.status, "created");
  assert.equal(saved.entry.kind, "workflow_template");
  assert.equal(saved.entry.workspaceId, "workspace_default");
  assert.equal(saved.entry.reviewStatus, "draft");
  assert.equal(saved.entry.revision, 1);
  assert.equal(saved.entry.publishedVersion, undefined);
  assert.equal(saved.version.template.autoStartDefault, false);
  assert.match(saved.version.digest, /^wt1_[a-f0-9]{64}$/u);
  assert.equal(saved.version.digest, workflowTemplateDigest(template()));
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.deepEqual(f.store.listSkillRegistryEntries({ includeArchived: true, includeDisabled: true }), skills);
  assert.deepEqual(f.registry.list(), [saved.entry]);
  assert.deepEqual(f.registry.get("review"), saved.entry);
  assert.deepEqual(f.registry.getVersion("review", "v1"), saved.version);
});

test("review publication requires an exact immutable pin, is separate from save and is idempotent only at the current revision", t => {
  const f = fixture(t), saved = f.registry.saveVersion(saveInput()), initial = registrySnapshot(f.db);
  for (const patch of [{ digest: `wt1_${"0".repeat(64)}` }, { version: "missing" }]) {
    fails(() => publish(f.registry, saved, patch), "version_conflict");
    assert.deepEqual(registrySnapshot(f.db), initial);
  }
  fails(() => publish(f.registry, saved, { digest: undefined }), "invalid_review_pin");
  fails(() => publish(f.registry, saved, { reviewStatus: "builtin" }), "identity_conflict");
  const approved = publish(f.registry, saved);
  assert.equal(approved.reviewStatus, "published");
  assert.equal(approved.revision, 2);
  assert.deepEqual(approved.publishedVersion, { id: "review", version: "v1", digest: saved.version.digest });
  const before = registrySnapshot(f.db);
  assert.deepEqual(publish(f.registry, { ...saved, entry: approved }, { now: at(2) }), approved);
  assert.deepEqual(registrySnapshot(f.db), before);
  fails(() => publish(f.registry, saved), "revision_conflict");
  fails(() => f.registry.setReviewStatus({ id: "missing", reviewStatus: "draft", expectedRevision: 0, now: at(2) }), "not_found");
});

test("same-ID workflow templates never replace or enter the executable SkillDefinition reader", t => {
  const f = fixture(t), skill = persistSkill(f.store), before = businessSnapshot(f.db);
  const saved = f.registry.saveVersion(saveInput());
  publish(f.registry, saved);
  assert.deepEqual(f.store.getSkillRegistryEntry("review"), skill);
  assert.deepEqual(f.store.listSkillRegistryEntries(), [skill]);
  assert.deepEqual(businessSnapshot(f.db), before);
  assert.equal(f.registry.getVersion("review", "v1").kind, "workflow_template");
});

test("new versions return to draft without changing historical pins or mutating caller/returned objects", t => {
  const f = fixture(t), input = saveInput(), v1 = f.registry.saveVersion(input), approved = publish(f.registry, v1);
  input.template.steps[0].prompt = "caller changed";
  v1.version.template.steps[0].prompt = "result changed";
  assert.equal(f.registry.getVersion("review", "v1").template.steps[0].prompt, "Read the evidence");
  const v2 = f.registry.saveVersion(saveInput({ version: "v2", template: template({ name: "Review v2" }),
    expectedRevision: approved.revision, now: at(2) }));
  assert.equal(v2.entry.revision, 3);
  assert.equal(v2.entry.reviewStatus, "draft");
  assert.equal(v2.entry.latestVersion, "v2");
  assert.deepEqual(v2.entry.publishedVersion, approved.publishedVersion, "the old pin is history, not draft compile authority");
  assert.notEqual(v2.version.digest, v1.version.digest);
  assert.equal(f.registry.getVersion("review", "v1").template.name, "Review");
  const selected = publish(f.registry, v2, { now: at(3) });
  assert.deepEqual(selected.publishedVersion, { id: "review", version: "v2", digest: v2.version.digest });
  assert.equal(f.registry.getVersion("review", "v1").digest, v1.version.digest);
});

test("legacy Runner aliases are canonicalized before version digests are persisted", t => {
  const f = fixture(t), legacy = template({ steps: [{ id: "read", name: "Read", prompt: "Read the evidence", requestedRunnerId: "pi-coding-agent" }] });
  const saved = f.registry.saveVersion(saveInput({ template: legacy }));
  assert.equal(saved.version.template.steps[0].requestedRunnerId, "pi");
  assert.equal(saved.version.digest, workflowTemplateDigest({ ...legacy, steps: [{ ...legacy.steps[0], requestedRunnerId: "pi" }] }));
  assert.equal(f.registry.getVersion("review", "v1").template.steps[0].requestedRunnerId, "pi");
});

test("saving a successor preserves disabled and archived revocation until an explicit review transition", t => {
  for (const reviewStatus of ["disabled", "archived"]) {
    const f = fixture(t), first = f.registry.saveVersion(saveInput()), published = publish(f.registry, first);
    const revoked = f.registry.setReviewStatus({ id: "review", reviewStatus, expectedRevision: published.revision, now: at(2) });
    const successor = f.registry.saveVersion(saveInput({ version: "v2", template: template({ name: "Review v2" }),
      expectedRevision: revoked.revision, now: at(3) }));
    assert.equal(successor.entry.reviewStatus, reviewStatus);
    assert.deepEqual(successor.entry.publishedVersion, published.publishedVersion);
    assert.equal(successor.entry.latestVersion, "v2");
  }
});

test("same version/digest is a no-op, changed content conflicts and stale save/review CAS cannot overwrite newer state", t => {
  const f = fixture(t), saved = f.registry.saveVersion(saveInput()), approved = publish(f.registry, saved);
  const before = registrySnapshot(f.db);
  const duplicate = f.registry.saveVersion(saveInput({ expectedRevision: approved.revision, now: at(2),
    template: template({ autoStartDefault: false }) }));
  assert.equal(duplicate.status, "duplicate");
  assert.deepEqual(duplicate.entry, approved);
  assert.deepEqual(registrySnapshot(f.db), before);
  fails(() => f.registry.saveVersion(saveInput({ expectedRevision: approved.revision, now: at(2), template: template({ name: "Replacement" }) })), "version_conflict");
  fails(() => f.registry.saveVersion(saveInput()), "revision_conflict");
  fails(() => f.registry.saveVersion(saveInput({ version: "v2", expectedRevision: 1, now: at(2) })), "revision_conflict");
  assert.deepEqual(registrySnapshot(f.db), before);
});

test("two real Store connections observe CAS conflicts instead of lost versions or stale publication", t => {
  const f = fixture(t), peer = createSqliteRunStore(f.root, f.paths);
  t.after(() => peer.close());
  const other = createSqliteWorkflowTemplateRegistryStore(peer);
  const first = f.registry.saveVersion(saveInput());
  fails(() => other.saveVersion(saveInput({ version: "v2" })), "revision_conflict");
  assert.deepEqual(other.get("review"), first.entry);
  const second = other.saveVersion(saveInput({ version: "v2", expectedRevision: 1, now: at(1) }));
  fails(() => publish(f.registry, first), "revision_conflict");
  assert.deepEqual(f.registry.get("review"), second.entry);
  assert.equal(f.registry.getVersion("review", "v1").digest, first.version.digest);
});

test("source, source path and owner/visibility cannot drift through new versions or duplicate saves", async t => {
  for (const [name, patch] of [["source", { source: "workspace" }], ["path", { sourcePath: "other.json" }],
    ["removed-path", { sourcePath: undefined }], ["owner", { visibility: { workspaceVisible: true, promotableToWorkspace: false, ownerTeammateId: "other" } }],
    ["visibility", { visibility: { workspaceVisible: false, promotableToWorkspace: false } }]])
    await t.test(name, t => {
      const f = fixture(t), saved = f.registry.saveVersion(saveInput()), before = registrySnapshot(f.db);
      for (const version of ["v1", "v2"]) fails(() => f.registry.saveVersion(saveInput({ ...patch, version,
        expectedRevision: saved.entry.revision, now: at(1) })), "identity_conflict");
      assert.deepEqual(registrySnapshot(f.db), before);
    });
});

test("disabled and archived entries hide from ordinary lists while historical versions survive reopen and restoration", async t => {
  for (const reviewStatus of ["disabled", "archived"]) await t.test(reviewStatus, t => {
    const f = fixture(t), saved = f.registry.saveVersion(saveInput()), published = publish(f.registry, saved);
    const entry = f.registry.setReviewStatus({ id: "review", reviewStatus, expectedRevision: published.revision, now: at(2) });
    assert.equal(entry.reviewStatus, reviewStatus);
    assert.deepEqual(f.registry.list(), []);
    assert.deepEqual(f.registry.list({ includeArchived: true, includeDisabled: true }), [entry]);
    assert.deepEqual(f.registry.getVersion("review", "v1"), saved.version);
    f.reopen();
    assert.deepEqual(f.registry.get("review"), entry);
    assert.deepEqual(f.registry.getVersion("review", "v1"), saved.version);
    const restored = f.registry.setReviewStatus({ id: "review", reviewStatus: "draft", expectedRevision: entry.revision, now: at(3) });
    assert.equal(restored.reviewStatus, "draft");
    assert.deepEqual(restored.publishedVersion, published.publishedVersion);
  });
});

test("registry lists have deterministic source/id ordering, owner/source filters and bounded limits", t => {
  const f = fixture(t);
  for (const [id, source, ownerTeammateId] of [["z", "workspace", "owner-1"], ["b", "custom", "owner-1"], ["a", "custom", "owner-2"]])
    f.registry.saveVersion(saveInput({ id, source, template: template({ id }),
      visibility: { workspaceVisible: false, promotableToWorkspace: true, ownerTeammateId } }));
  assert.deepEqual(f.registry.list().map(entry => entry.id), ["a", "b", "z"]);
  assert.deepEqual(f.registry.list({ ownerTeammateId: "owner-1", source: "custom" }).map(entry => entry.id), ["b"]);
  assert.deepEqual(f.registry.list({ limit: 1 }).map(entry => entry.id), ["a"]);
  for (const options of [null, "all", [], { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { source: "foreign" }, { unknown: true }])
    fails(() => f.registry.list(options), "invalid_list");
  assert.equal(f.registry.get("unknown"), undefined);
  assert.equal(f.registry.getVersion("unknown", "v1"), undefined);
  assert.equal(f.registry.getVersion("a", "unknown"), undefined);
});

test("save validation rejects malformed metadata, explicit invalid versions and template identity mismatch without any writes", t => {
  const f = fixture(t), before = registrySnapshot(f.db);
  for (const patch of [{ kind: "skill" }, { expectedRevision: -1 }, { expectedRevision: 1.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { now: "2026-11-03" }, { now: "not-time" }, { version: "" }, { version: " " }, { version: " v1" },
    { version: "v1\0" }, { version: "v".repeat(129) }, { source: "foreign" }, { sourcePath: "" }, { unknown: true }])
    fails(() => f.registry.saveVersion(saveInput(patch)), "invalid_save");
  for (const visibility of [null, [], {}, { workspaceVisible: true, promotableToWorkspace: false, extra: true },
    { workspaceVisible: true, promotableToWorkspace: false, ownerTeammateId: "" },
    { workspaceVisible: true, promotableToWorkspace: false, [Symbol("owner")]: "x" }])
    fails(() => f.registry.saveVersion(saveInput({ visibility })), "invalid_visibility");
  fails(() => f.registry.saveVersion(saveInput({ template: template({ id: "different" }) })), "template_id_mismatch");
  assert.throws(() => f.registry.saveVersion(saveInput({ template: template({ steps: [] }) })), /template.steps/u);
  let calls = 0;
  const visibility = Object.defineProperty({ promotableToWorkspace: false }, "workspaceVisible", { enumerable: true, get() { calls++; return true; } });
  fails(() => f.registry.saveVersion(saveInput({ visibility })), "invalid_visibility");
  assert.equal(calls, 0);
  const unsafeTemplate = template();
  Object.defineProperty(unsafeTemplate.steps[0], "requestedRunnerId", { enumerable: true, get() { calls++; return "pi-coding-agent"; } });
  assert.throws(() => f.registry.saveVersion(saveInput({ template: unsafeTemplate })), /expected JSON data fields/u);
  assert.equal(calls, 0, "Runner canonicalization must never evaluate unvalidated template getters");
  assert.deepEqual(registrySnapshot(f.db), before);
});

test("review validation and monotonic timestamps do not mutate existing registry history", t => {
  const f = fixture(t), saved = f.registry.saveVersion(saveInput()), before = registrySnapshot(f.db);
  for (const patch of [{ reviewStatus: "unknown" }, { expectedRevision: -1 }, { now: "bad" }, { unknown: true }])
    fails(() => f.registry.setReviewStatus({ id: "review", reviewStatus: "draft", expectedRevision: 1, now: at(1), ...patch }), "invalid_review");
  fails(() => f.registry.setReviewStatus({ id: "review", reviewStatus: "disabled", expectedRevision: 1, now: at(1), version: "v1" }), "invalid_review_pin");
  fails(() => publish(f.registry, saved, { now: at(-1) }), "invalid_time");
  fails(() => f.registry.saveVersion(saveInput({ version: "v2", expectedRevision: 1, now: at(-1) })), "invalid_time");
  assert.deepEqual(registrySnapshot(f.db), before);
});

test("builtin review is allowed only for pinned builtin sources and still requires explicit publication", t => {
  const f = fixture(t), saved = f.registry.saveVersion(saveInput({ source: "builtin" }));
  assert.equal(saved.entry.reviewStatus, "draft");
  const builtin = publish(f.registry, saved, { reviewStatus: "builtin" });
  assert.equal(builtin.reviewStatus, "builtin");
  assert.equal(builtin.publishedVersion.digest, saved.version.digest);
});

test("SQL guards retain all history and reject direct identity/revision or version updates", t => {
  const f = fixture(t);
  f.registry.saveVersion(saveInput());
  const before = registrySnapshot(f.db);
  for (const sql of ["DELETE FROM workflow_template_registry", "DELETE FROM workflow_template_versions",
    "UPDATE workflow_template_versions SET digest='other'", "UPDATE workflow_template_registry SET source='workspace'",
    "UPDATE workflow_template_registry SET revision=revision+2", "UPDATE workflow_template_registry SET visibility_json='{}'"])
    assert.throws(() => f.db.exec(sql), /workflow_template_registry\./u);
  assert.deepEqual(registrySnapshot(f.db), before);
});

test("owned write rollback handles commit-time FK failures and leaves later saves retryable", t => {
  const f = fixture(t), before = registrySnapshot(f.db);
  f.db.exec("CREATE TABLE template_commit_fault (id TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED)");
  f.db.exec("CREATE TRIGGER template_commit_fault_trigger AFTER INSERT ON workflow_template_versions BEGIN INSERT INTO template_commit_fault VALUES('missing-task'); END");
  assert.throws(() => f.registry.saveVersion(saveInput()), /FOREIGN KEY/u);
  assert.equal(f.db.isTransaction, false);
  assert.deepEqual(registrySnapshot(f.db), before);
  assert.deepEqual(f.db.prepare("SELECT * FROM template_commit_fault").all(), []);
  f.db.exec("DROP TRIGGER template_commit_fault_trigger");
  assert.equal(f.registry.saveVersion(saveInput()).status, "created");
});

test("registry writes never adopt, commit or roll back a caller-owned SQLite transaction", t => {
  const f = fixture(t), saved = f.registry.saveVersion(saveInput()), before = registrySnapshot(f.db);
  f.db.exec("BEGIN IMMEDIATE");
  try {
    f.db.prepare("UPDATE workspaces SET name='caller-owned' WHERE id='workspace_default'").run();
    fails(() => f.registry.saveVersion(saveInput({ version: "v2", expectedRevision: 1, now: at(1) })), "transaction_active");
    fails(() => publish(f.registry, saved), "transaction_active");
    assert.equal(f.db.isTransaction, true);
    assert.equal(f.db.prepare("SELECT name FROM workspaces WHERE id='workspace_default'").get().name, "caller-owned");
    assert.deepEqual(registrySnapshot(f.db), before);
  } finally { f.db.exec("ROLLBACK"); }
  assert.equal(publish(f.registry, saved).reviewStatus, "published");
});

test("reads revalidate canonical snapshots and digests instead of trusting corrupt or noncanonical JSON", async t => {
  for (const [name, json] of [["changed", JSON.stringify(template({ name: "Tampered", autoStartDefault: false }))],
    ["noncanonical", JSON.stringify({ ...template(), autoStartDefault: false })], ["unknown-field", JSON.stringify(template({ execute: true }))]])
    await t.test(name, t => {
      const f = fixture(t);
      f.registry.saveVersion(saveInput());
      f.db.exec("DROP TRIGGER trg_workflow_template_versions_immutable");
      f.db.prepare("UPDATE workflow_template_versions SET template_json=?").run(json);
      assert.throws(() => f.registry.getVersion("review", "v1"), /workflow_template_registry.corrupt|expected only known JSON fields/u);
    });
});
