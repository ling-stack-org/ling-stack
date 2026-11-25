import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rewindNodeRerunApprovalFixture, rewindNodeRerunApprovalFixtureWithinTransaction } from "./node-rerun-approval-predecessor.ts";

// Explicit ownership: dropping these empty tables also removes their listed indexes and triggers.
const overlays = [
  { version: 204, name: "workflow_isolation_foundation",
    tables: ["workflow_integration_rounds", "workflow_integration_generations", "workflow_isolation_scope_plans",
      "workflow_isolation_bindings", "workflow_isolation_intents", "workflow_isolation_receipts", "workflow_isolation_commands"],
    indexes: ["idx_workflow_isolation_receipt_confirmed", "idx_workflow_isolation_intent_pending"],
    triggers: ["trg_workflow_isolation_plan_immutable", "trg_workflow_isolation_generation_immutable",
      "trg_workflow_isolation_round_immutable", "trg_workflow_isolation_binding_immutable", "trg_workflow_isolation_intent_immutable",
      "trg_workflow_isolation_receipts_immutable", "trg_workflow_isolation_commands_immutable"] },
  { version: 205, name: "workflow_isolation_terminal_results",
    tables: ["workflow_isolation_result_intents", "workflow_isolation_result_receipts"],
    indexes: ["idx_workflow_isolation_result_confirmed"],
    triggers: ["trg_workflow_isolation_result_intent_immutable", "trg_workflow_isolation_result_receipt_immutable",
      "trg_workflow_isolation_result_intents_retained", "trg_workflow_isolation_result_receipts_retained"] },
  { version: 206, name: "workflow_integration_coordinator_evidence",
    tables: ["workflow_integration_effect_links", "workflow_integration_receipt_links"], indexes: [],
    triggers: ["trg_workflow_integration_effect_link_immutable", "trg_workflow_integration_effect_link_retained",
      "trg_workflow_integration_receipt_link_immutable", "trg_workflow_integration_receipt_link_retained"] },
  { version: 207, name: "workflow_merge_approval_basis", tables: ["workflow_merge_approval_requests"], indexes: [],
    triggers: ["trg_workflow_merge_approval_immutable", "trg_workflow_merge_approval_retained"] },
  { version: 208, name: "workflow_merge_apply_permits", tables: ["workflow_merge_apply_permits"], indexes: [],
    triggers: ["trg_workflow_merge_apply_permit_immutable", "trg_workflow_merge_apply_permit_retained"] },
  { version: 209, name: "workflow_worktree_cleanup_journal",
    tables: ["workflow_worktree_cleanup_intents", "workflow_worktree_cleanup_receipts"],
    indexes: ["idx_workflow_worktree_cleanup_removed"],
    triggers: ["trg_workflow_worktree_cleanup_intents_immutable", "trg_workflow_worktree_cleanup_intents_retained",
      "trg_workflow_worktree_cleanup_receipts_immutable", "trg_workflow_worktree_cleanup_receipts_retained"] },
  { version: 210, name: "workflow_parallel_parent_fences", tables: ["workflow_parallel_parent_fences"],
    indexes: ["idx_workflow_parallel_parent_workspace", "idx_workflow_parallel_parent_common_dir"],
    triggers: ["trg_workflow_parallel_parent_immutable", "trg_workflow_parallel_parent_retained"] },
  { version: 211, name: "workflow_isolation_selections", tables: ["workflow_isolation_selections"], indexes: [],
    triggers: ["trg_workflow_isolation_selection_immutable", "trg_workflow_isolation_selection_retained"] },
  { version: 212, name: "workflow_template_registry", tables: ["workflow_template_registry", "workflow_template_versions"], indexes: [],
    triggers: ["trg_workflow_template_registry_created_draft", "trg_workflow_template_registry_immutable",
      "trg_workflow_template_registry_retained", "trg_workflow_template_versions_immutable", "trg_workflow_template_versions_retained"] },
  { version: 213, name: "workflow_conflict_recoveries", tables: ["workflow_conflict_recoveries"], indexes: [],
    triggers: ["trg_workflow_conflict_recovery_immutable", "trg_workflow_conflict_recovery_retained"] },
  { version: 214, name: "runtime_concurrency_policies", tables: ["runtime_concurrency_policies"], indexes: [], triggers: [] },
  { version: 215, name: "runtime_concurrency_policy_activation", tables: [], indexes: [], triggers: [] },
  { version: 216, name: "runtime_delegation_capacity_admissions", tables: ["runtime_delegation_capacity_admissions"], indexes: [], triggers: [] },
  { version: 217, name: "runtime_run_queue", tables: ["runtime_run_queue"], indexes: [], triggers: [] },
  { version: 218, name: "runtime_host_capacity", tables: ["runtime_host_capacity_intents", "runtime_host_capacity_releases"], indexes: [], triggers: [] },
  { version: 219, name: "runtime_delegation_spawn_admissions", tables: ["runtime_delegation_spawn_admissions"], indexes: [], triggers: [] },
  { version: 220, name: "runtime_host_capacity_continuations", tables: [], indexes: [], triggers: [] },
  { version: 221, name: "create_automation_event_ingress_and_delivery",
    tables: ["automation_event_sources", "automation_events", "automation_event_dispatches", "automation_deliveries", "automation_delivery_receipts"],
    indexes: ["idx_automation_event_pending", "idx_automation_event_rate", "idx_automation_delivery_pending"], triggers: [] },
  { version: 222, name: "create_node_rerun_submissions_and_goal_supervision",
    tables: ["node_rerun_submissions"], indexes: [], triggers: [] },
  { version: 225, name: "persist_rebuildable_context_view_lineage",
    tables: ["conversation_context_view_lineage"],
    indexes: ["idx_context_view_lineage_source", "idx_context_view_lineage_view"], triggers: [] },
  { version: 226, name: "node_rerun_intents", tables: ["node_rerun_intents"], indexes: [], triggers: [] },
  { version: 230, name: "code_assessments",
    tables: ["code_assessment_snapshots", "code_assessments", "code_assessment_findings"],
    indexes: ["code_assessment_active", "code_assessment_history", "code_assessment_findings_owner"], triggers: [] },
  { version: 231, name: "code_assessment_lifecycle", tables: [], indexes: [], triggers: [] },
  { version: 232, name: "code_assessment_comments", tables: ["code_assessment_comments"],
    indexes: ["code_assessment_comments_finding"], triggers: [] },
  { version: 233, name: "code_assessment_history_filters", tables: [],
    indexes: ["code_assessment_target_history", "code_assessment_snapshot_history", "code_assessment_status_history",
      "code_assessment_updated_history", "code_assessment_finding_filters"], triggers: [] },
  { version: 235, name: "add_work_item_control_projection", tables: [], indexes: [], triggers: [] },
  { version: 236, name: "create_work_item_evidence", tables: ["work_item_evidence"],
    indexes: ["idx_work_item_evidence_item_sequence"], triggers: [] },
  { version: 237, name: "create_app_server_state", tables: ["app_server_state"],
    indexes: ["idx_app_server_state_kind_updated"], triggers: [] },
  { version: 238, name: "conversation_visualizations", tables: ["conversation_visualizations"],
    indexes: ["idx_conversation_visualizations_run"], triggers: [] },
];
const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
const markers = db => db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
const identity = rows => rows.map(({ version, name }) => ({ version, name }));
function rewoundComparisonDatabase(db) {
  // The production fixture uses WAL. node:sqlite cannot deserialize a WAL
  // image into another connection, so materialize a consistent rollback-mode
  // copy before applying the historical rewind.
  const comparisonRoot = mkdtempSync(join(tmpdir(), "ling-migration-comparison-"));
  const comparisonPath = join(comparisonRoot, "comparison.sqlite");
  const escapedPath = comparisonPath.replaceAll("'", "''");
  try {
    db.exec(`VACUUM INTO '${escapedPath}'`);
    const comparison = new DatabaseSync(comparisonPath);
    const close = comparison.close.bind(comparison);
    comparison.close = () => {
      try { close(); }
      finally { rmSync(comparisonRoot, { recursive: true, force: true }); }
    };
    comparison.exec(`PRAGMA foreign_keys=${db.prepare("PRAGMA foreign_keys").get().foreign_keys}`);
    rewindNodeRerunApprovalFixture(comparison);
    return comparison;
  } catch (error) {
    rmSync(comparisonRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Remove only known empty overlays from an owned temporary fixture. */
function removeOwnedOverlays(f, version) {
  const db = f.store.database, root = realpathSync(f.root);
  assert.ok(dirname(root) === realpathSync(tmpdir()) && ["ling-p1c-admission-", "ling-delegation-full-schema-"]
    .some(prefix => basename(root).startsWith(prefix)),
    "migration predecessor requires a temporary fixture root");
  const path = realpathSync(f.paths.databasePath);
  assert.ok(path.startsWith(`${root}${sep}`), "database must belong to the temporary fixture");
  assert.equal(realpathSync(db.prepare("PRAGMA database_list").all().find(row => row.name === "main").file), path);
  assert.equal(db.isTransaction, false, "fixture must not adopt a caller transaction");
  assert.ok(overlays.some(overlay => overlay.version === version), "migration needs an explicit ownership inventory");
  const removed = overlays.filter(overlay => overlay.version >= version), tables = removed.flatMap(overlay => overlay.tables);
  const objects = new Map(removed.flatMap(overlay => [
    ...overlay.tables.map(name => [name, "table"]), ...overlay.indexes.map(name => [name, "index"]),
    ...overlay.triggers.map(name => [name, "trigger"]),
  ]));
  const foreignKeys = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  const legacyAlter = db.prepare("PRAGMA legacy_alter_table").get().legacy_alter_table;
  let fullSchema, fullMarkers;
  db.exec("PRAGMA foreign_keys=OFF"); db.exec("PRAGMA legacy_alter_table=ON");
  try {
    db.exec("BEGIN IMMEDIATE");
    // The current constructor installs the later F5 overlays after the
    // historical workflow range. Rewind them in this transaction so any
    // predecessor validation failure restores the exact original fixture.
    rewindNodeRerunApprovalFixtureWithinTransaction(db);
    fullSchema = schema(db); fullMarkers = markers(db);
    assert.deepEqual(identity(fullMarkers.filter(row => row.version >= version)), identity(removed),
      "later migration markers must match the explicit overlay inventory");
    for (const [name, type] of objects) {
      const object = fullSchema.find(row => row.name === name);
      assert.equal(object?.type, type, `expected owned ${type}: ${name}`);
      assert.ok(tables.includes(object.tbl_name), `unexpected overlay owner: ${name}`);
    }
    for (const object of fullSchema.filter(row => tables.includes(row.tbl_name)))
      assert.ok(objects.has(object.name), `unexpected overlay object: ${object.name}`);
    for (const table of tables)
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} must be empty`);
    for (const overlay of [...removed].reverse()) {
      for (const table of [...overlay.tables].reverse()) db.exec(`DROP TABLE "${table}"`);
      assert.equal(db.prepare("DELETE FROM schema_migrations WHERE version=? AND name=?").run(overlay.version, overlay.name).changes, 1);
    }
    assert.deepEqual(schema(db), fullSchema.filter(row => !objects.has(row.name)));
    assert.deepEqual(markers(db), fullMarkers.filter(row => row.version < version));
    assert.equal(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version, version - 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally { db.exec(`PRAGMA legacy_alter_table=${legacyAlter}`); db.exec(`PRAGMA foreign_keys=${foreignKeys}`); }
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, foreignKeys);
  return { fullSchema, fullMarkers, objects, removed, tables };
}

/** Downgrade only an owned temporary fixture, retaining an exact full-upgrade expectation. */
export function workflowMigrationPredecessorFixture(f, version) {
  const { fullSchema, fullMarkers } = removeOwnedOverlays(f, version);
  return (upgradedDb, installed) => {
    const comparisonDb = rewoundComparisonDatabase(upgradedDb);
    try {
      const laterTables = overlays.filter(overlay => overlay.version > version).flatMap(overlay => overlay.tables);
      if (installed.markers.some(row => row.version === 227)) {
        assert.deepEqual(schema(upgradedDb), installed.schema, "constructor must preserve the fully installed schema");
      } else {
        assert.deepEqual(schema(comparisonDb).filter(row => !laterTables.includes(row.tbl_name)),
          installed.schema.filter(row => !laterTables.includes(row.tbl_name)),
          "constructor upgrade must preserve every single-migration schema object");
      }
      assert.deepEqual(markers(comparisonDb).filter(row => row.version <= version),
        installed.markers.filter(row => row.version <= version),
        "constructor upgrade must preserve every installed marker, including its timestamp");
      assert.deepEqual(schema(comparisonDb), fullSchema, "constructor must restore the exact complete overlay schema");
      assert.deepEqual(identity(markers(comparisonDb)), identity(fullMarkers), "constructor must install every later marker exactly once");
      for (const table of laterTables)
        assert.equal(comparisonDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} must remain empty`);
      assert.equal(comparisonDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.deepEqual(comparisonDb.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(upgradedDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.deepEqual(upgradedDb.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { comparisonDb.close(); }
  };
}

/** A deeper historical rewind owns its other changes; these overlays must still be restored exactly. */
export function removeWorkflowMigrationOverlaysForLegacyFixture(f) {
  const { fullSchema, fullMarkers, objects, removed, tables } = removeOwnedOverlays(f, 204);
  return upgradedDb => {
    const comparisonDb = rewoundComparisonDatabase(upgradedDb);
    try {
      assert.deepEqual(schema(comparisonDb).filter(row => objects.has(row.name)), fullSchema.filter(row => objects.has(row.name)));
      assert.deepEqual(identity(markers(comparisonDb).filter(row => row.version >= 204)), identity(removed));
      assert.deepEqual(identity(markers(comparisonDb).filter(row => row.version >= 204)),
        identity(fullMarkers.filter(row => row.version >= 204)));
      for (const table of tables)
        assert.equal(comparisonDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n, 0, `${table} must remain empty`);
      assert.equal(comparisonDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.deepEqual(comparisonDb.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(upgradedDb.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
      assert.deepEqual(upgradedDb.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { comparisonDb.close(); }
  };
}
