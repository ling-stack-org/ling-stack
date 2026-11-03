import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, createSqliteWorkflowTemplateRegistryStore, resolveRuntimePaths } from "../../dist/index.js";
import { createSqliteRunStoreFixture } from "./sqlite-run-store-fixture.mjs";

export const at = n => new Date(Date.UTC(2026, 10, 3, 0, 0, n)).toISOString();
export const template = (extra = {}) => ({ schemaVersion: 1, id: "review", name: "Review",
  steps: [{ id: "read", name: "Read", prompt: "Read the evidence" }], ...extra });
export const saveInput = (extra = {}) => ({ kind: "workflow_template", id: "review", version: "v1",
  source: "custom", sourcePath: "templates/review.json", visibility: { workspaceVisible: true, promotableToWorkspace: false },
  template: template(), expectedRevision: 0, now: at(0), ...extra });
export const registryTables = ["workflow_template_registry", "workflow_template_versions"];
export const registryTriggers = ["trg_workflow_template_registry_created_draft", "trg_workflow_template_registry_immutable",
  "trg_workflow_template_registry_retained", "trg_workflow_template_versions_immutable", "trg_workflow_template_versions_retained"];
const recoveryObjects = ["workflow_conflict_recoveries", "trg_workflow_conflict_recovery_immutable", "trg_workflow_conflict_recovery_retained"];
export const rows = (db, name) => db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
export const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
export const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
export const registrySnapshot = db => Object.fromEntries(registryTables.map(name => [name, rows(db, name)]));
export const businessSnapshot = db => Object.fromEntries(["tasks", "run_sessions", "work_units", "channel_workflows", "artifacts", "skill_definitions"]
  .map(name => [name, rows(db, name)]));

export function persistSkill(store, id = "review") {
  const draft = store.createSkillImportDraft({ source: "custom", name: "Registry predecessor", description: "Keep the executable skill separate",
    definitions: [{ definition: { id, name: "Review skill", summary: "Read evidence", roleAffinity: ["engineer"],
      promptFragments: ["Read the evidence"], requiredTools: ["read"], requiredProviderCapabilities: ["chat"],
      approvalProfile: { mode: "none" }, stateEffects: [] } }] }, at(0));
  return store.publishSkillImportDraft(draft.id, at(0))[0];
}

export function fixture(t, { fresh = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ling-workflow-template-registry-")), paths = resolveRuntimePaths(root);
  let store = fresh ? createSqliteRunStore(root, paths) : createSqliteRunStoreFixture(root);
  t.after(() => { try { store?.close(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { root, paths, get store() { return store; }, get db() { return store.database; },
    get registry() { return createSqliteWorkflowTemplateRegistryStore(store); },
    close() { store?.close(); store = undefined; },
    reopen() { store?.close(); store = undefined; store = createSqliteRunStore(root, paths); return store; } };
}

/** Rewind only the new, empty overlay inside this fixture's own temporary database. */
export function removeRegistryOverlay(f) {
  const db = f.db;
  assert.equal(db.isTransaction, false);
  assert.deepEqual(markers(db).filter(row => row.version >= 212).map(({ version, name }) => ({ version, name })),
    [{ version: 212, name: "workflow_template_registry" }, { version: 213, name: "workflow_conflict_recoveries" }]);
  assert.equal(rows(db, recoveryObjects[0]).length, 0);
  assert.deepEqual(schema(db).filter(row => row.tbl_name === recoveryObjects[0]).map(row => row.name).sort(), [...recoveryObjects].sort());
  for (const table of registryTables) assert.equal(rows(db, table).length, 0);
  assert.deepEqual(schema(db).filter(row => registryTables.includes(row.tbl_name)).map(row => row.name).sort(),
    [...registryTables, ...registryTriggers].sort());
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec("DROP TABLE workflow_conflict_recoveries");
    assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=213 AND name='workflow_conflict_recoveries'").run().changes, 1);
    for (const table of [...registryTables].reverse()) db.exec(`DROP TABLE "${table}"`);
    assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=212 AND name='workflow_template_registry'").run().changes, 1);
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 211);
}
