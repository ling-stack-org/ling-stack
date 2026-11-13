import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../../core/dist/index.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { RunStoreRegistry } from "../dist/runtime/store-registry.js";
import { handleGetRunAssuranceEvidence } from "../dist/features/runs/assurance-evidence.js";

test("assurance errors withhold damaged artifact bodies and preserve public lineage errors", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-assurance-evidence-errors-"));
  const store = createSqliteRunStore(cwd);
  const registry = new RunStoreRegistry(() => store, { recoverOnOpen: false });
  registry.getStore(cwd);
  t.after(async () => {
    registry.closeAll();
    await rm(cwd, { recursive: true, force: true });
  });
  const now = "2026-11-11T08:00:00.000Z";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "run-assurance-errors", idempotencyKey: "assurance-errors", status: "running", createdByActor: "system", request: {}, now });
  store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "runtime-assurance-errors",
    runnerId: "pi", effectiveRunnerId: "pi", status: "started", now });
  const run = store.createRun({ id: "run-assurance-errors", cwd, taskId: "task-assurance-errors", workUnitId: unit.id,
    providerName: "fixture", providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  const unlinked = store.createRun({ id: "run-assurance-unlinked", cwd, taskId: "task-assurance-unlinked",
    providerName: "fixture", providerModel: "fixture-model", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: now });
  store.linkRunToWorkUnit(run.id, unit.id, now);
  const artifact = store.createArtifact({ runId: run.id, type: "json", path: "result.json",
    sealedPayload: { value: "PRIVATE_ARTIFACT_BODY" }, createdAt: now });
  const database = new DatabaseSync(store.paths.databasePath);
  try {
    database.prepare("UPDATE artifacts SET sealed_payload_json = ? WHERE id = ?")
      .run("PRIVATE_ARTIFACT_BODY", artifact.id);
  } finally {
    database.close();
  }
  assert.throws(() => store.listArtifacts(run.id), /PRIVATE_AR/);

  const activeRuns = new ActiveRunRegistry();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://local");
    handleGetRunAssuranceEvidence(response, url, registry, activeRuns, decodeURIComponent(url.pathname.split("/")[2] ?? ""));
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = (id: string) => {
    const url = new URL(`http://127.0.0.1:${address.port}/runs/${id}/assurance-evidence`);
    url.searchParams.set("cwd", cwd);
    return url;
  };
  const missing = await fetch(endpoint(unlinked.id));
  assert.equal(missing.status, 409);
  assert.deepEqual(await missing.json(), { error: "assurance_lineage_incomplete", message: "Run has no WorkUnit lineage." });
  const response = await fetch(endpoint(run.id));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "assurance_evidence_unavailable", message: "Live assurance evidence is unavailable.",
  });
});
