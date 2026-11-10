import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths } from "../../dist/index.js";
import { SqliteRunSuspensionStore } from "../../dist/storage/sqlite/run-suspension-store.js";
import { createBudgetHarness, budgetLater, budgetNow } from "./delegation-budget-fixture.mjs";
import { prepareSuspensionSource } from "./run-suspension-integration-fixture.mjs";

/** Persisted crash-window fixtures only; no fabricated SDK stop or drain authority. */
export async function createSuspensionStartupFixture(t, state) {
  const cwd = await mkdtemp(join(tmpdir(), "ling-suspension-startup-"));
  const paths = resolveStoragePaths(cwd, { homeDir: join(cwd, "fixture-home"), env: {}, workspaceStateLocation: "repo-local" }).workspace;
  let store = createSqliteRunStore(cwd, paths);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const f = createBudgetHarness(cwd, { store }); f.start();
  const prepared = prepareSuspensionSource(f, budgetNow), source = { runId: f.root.id, ...f.fence };
  const resource = { ...f.fence, workspaceId: DEFAULT_WORKSPACE_ID, ownerType: "work_unit_attempt", ownerId: f.attempt.id,
    acquiredAt: budgetNow, expiresAt: budgetLater };
  assert.ok(store.acquireResourceLease({ ...resource, resourceType: "channel", resourceKey: "isolated-root" }));
  assert.ok(store.acquireRuntimeSemaphoreSlot({ ...resource, resourceType: "runner", resourceKey: "pi", limit: 1 }));
  if (state !== "absent") {
    const methods = ["getRun", "getWorkUnit", "getWorkUnitAttempt", "getApprovalPolicy", "getLingThread", "getChannel", "getProviderPreset",
      "getAiTeammate", "listTeammateSkillBindings", "getSkillRegistryEntry", "getLatestWorkspaceProvenanceWatermark", "getArtifact",
      "readRunProgressCheckpointForRecovery", "getChannelWorkflowStep", "getChannelWorkflow"];
    const authority = new SqliteRunSuspensionStore({ database: store.database }, {
      ...Object.fromEntries(methods.map(name => [name, (...args) => store[name](...args)])),
      createArtifactWithinTransaction: input => store.artifacts.createArtifactWithinTransaction(input) });
    const request = authority.requestRunSuspension(prepared.input);
    if (state === "sealed") {
      const committed = store.commitRunProgressCheckpoint({ runId: f.root.id, sourceFence: f.fence,
        expectedHead: { checkpointId: null, revision: 0 }, sourceEventSeq: store.listEvents(f.root.id).at(-1)?.seq ?? 0,
        expectedLineage: prepared.lineage, modelView: prepared.view, now: budgetNow });
      assert.equal(committed.kind, "committed", JSON.stringify(committed));
      const verified = store.readRunProgressCheckpointForRecovery({ runId: f.root.id, sourceFence: f.fence, expectedLineage: prepared.lineage });
      assert.equal(verified.kind, "verified", JSON.stringify(verified));
      authority.sealRunSuspension({ suspensionId: request.id, sourceFence: f.fence,
        witness: { kind: "ordinary", checkpoint: verified.witness }, now: budgetNow });
    }
  }
  store.close(); store = createSqliteRunStore(cwd, paths);
  const tables = ["run_sessions", "work_units", "work_unit_attempts", "run_events", "runtime_events", "resource_leases",
    "runtime_semaphore_slots", "host_attempt_completions", "run_suspensions", "artifacts", "harness_artifact_pins",
    "delegation_budget_charges", "delegation_budget_reservations", "runner_continuations", "ling_threads"];
  const snapshot = () => tables.map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]);
  return { cwd, get store() { return store; }, source, snapshot };
}
