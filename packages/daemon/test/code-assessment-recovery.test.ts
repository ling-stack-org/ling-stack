import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { CodeAssessmentDetail, CodeAssessmentList, CodeAssessmentSnapshot } from "@ling-stack/contracts";
import { createSqliteRunStore, type RunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { createDaemonServer } from "../dist/index.js";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { reconcileCodeAssessments } from "../dist/features/code-assessments/service.js";
import { runtimeRunQueueFixture } from "../../core/test/support/runtime-run-queue-fixture.ts";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

const createdAt = "2026-11-16T00:00:00.000Z";
function snapshot(id: string): CodeAssessmentSnapshot {
  return { id: `snapshot_${id}`, digest: "a".repeat(64), capturedAt: createdAt, target: { type: "working_tree" },
    files: [{ path: "app.ts", diff: "@@ -1 +1 @@\n-old\n+new\n", kind: "modified", contentDigest: "b".repeat(64), redacted: false }],
    totalFileCount: 1, coverage: "complete", exclusions: [] };
}

function boundAssessment(store: RunStore, id: string, now = createdAt) {
  const run = store.createRun({ id: `run_${id}`, cwd: store.paths.cwd, taskId: `task_${id}`, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: { id: `task_${id}`, title: "Captured Diff assessment" }, providerSnapshot: { provider: "fixture", model: "fixture" },
    requestSnapshot: { cwd: store.paths.cwd, codeAssessment: { id, snapshotDigest: snapshot(id).digest } }, createdAt: now });
  store.createCodeAssessment({ id, kind: "review", providerPresetId: "fixture", snapshot: snapshot(id), now });
  store.bindCodeAssessmentRun(id, run.id, now);
  return run;
}

async function restartFixture(t: TestContext) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-assessment-recovery-")));
  const stores: RunStore[] = [];
  const daemons: ReturnType<typeof createDaemonServer>[] = [];
  let runnerCalls = 0;
  class RecoveryRunner extends ToolFreePiRunner {
    async runTask(_options: PiRunnerRunOptions): ReturnType<ToolFreePiRunner["runTask"]> {
      runnerCalls++;
      throw new Error("Recovery must materialize durable reports without rerunning the model.");
    }
  }
  t.after(async () => {
    try {
      for (const daemon of daemons) await daemon.stop();
      for (const store of stores) store.close();
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  const open = async () => {
    const store = createSqliteRunStore(cwd);
    stores.push(store);
    const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
      channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false } },
    { runner: new RecoveryRunner(), storeFactory: () => store });
    daemons.push(daemon);
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    const get = async <T>(path: string): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`,
        { signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body as T;
    };
    return { store, daemon, get };
  };
  return { open, get runnerCalls() { return runnerCalls; } };
}

test("a stopped daemon and reopened SQLite store materialize a bound terminal report exactly once", { timeout: 60000 }, async t => {
  const fixture = await restartFixture(t);
  const first = await fixture.open();
  const run = boundAssessment(first.store, "terminal");
  first.store.appendEvent(run.id, "message_end", { role: "assistant", text: JSON.stringify({ snapshotDigest: snapshot("terminal").digest,
    summary: "One captured candidate.", findings: [{ title: "Changed result", body: "This changes the caller result.", severity: "high", confidence: "high",
      path: "app.ts", side: "new", startLine: 1, endLine: 1, evidence: "new" }] }) });
  first.store.markRunSucceeded(run.id, createdAt);
  assert.equal(first.store.getCodeAssessment("terminal")?.assessment.status, "analyzing");
  const databasePath = first.store.paths.databasePath;
  await first.daemon.stop();
  assert.throws(() => first.store.getCodeAssessment("terminal"));
  const second = await fixture.open();
  assert.equal(second.store.paths.databasePath, databasePath);
  assert.notEqual(second.store, first.store);
  const detail = await second.get<CodeAssessmentDetail>("/workspace/code-assessments/terminal");
  assert.equal(detail.assessment.status, "completed");
  assert.equal(detail.assessment.runId, run.id);
  assert.equal(detail.findings.length, 1);
  assert.equal(detail.findings[0]?.validation, "unverified");
  assert.ok(detail.assessment.reportArtifactId);
  assert.equal((second.store.getArtifact(detail.assessment.reportArtifactId)?.sealedPayload as { snapshotDigest: string }).snapshotDigest, detail.snapshot.digest);
  await second.daemon.stop();
  const third = await fixture.open();
  const persisted = await third.get<CodeAssessmentDetail>("/workspace/code-assessments/terminal");
  assert.deepEqual(persisted, detail);
  assert.equal(fixture.runnerCalls, 0);
});

test("restart finds a failed bound Run beyond 100 history rows and interrupts a missing Run", { timeout: 60000 }, async t => {
  const fixture = await restartFixture(t);
  const first = await fixture.open();
  for (let index = 0; index < 101; index++) {
    const id = `history_${index}`;
    const now = new Date(Date.parse(createdAt) + index + 1000).toISOString();
    first.store.createCodeAssessment({ id, kind: "review", providerPresetId: "fixture", snapshot: snapshot(id), now });
    first.store.finishCodeAssessment(id, { status: "failed", errorMessage: "Earlier report unavailable.", now });
  }
  const run = boundAssessment(first.store, "orphan");
  assert.equal(first.store.listCodeAssessments({ limit: 100 }).assessments.some(item => item.id === "orphan"), false);
  await first.daemon.stop();
  const second = await fixture.open();
  const history = await second.get<CodeAssessmentList>("/workspace/code-assessments?limit=100");
  assert.equal(history.assessments.length, 100);
  assert.equal(history.nextOffset, 100);
  const detail = await second.get<CodeAssessmentDetail>("/workspace/code-assessments/orphan");
  assert.equal(detail.assessment.status, "failed");
  assert.equal(detail.assessment.runId, run.id);
  assert.equal(detail.assessment.errorMessage, "Daemon stopped before the run reached a terminal state.");
  assert.equal(detail.findings.length, 0);
  assert.equal(detail.assessment.reportArtifactId, undefined);
  second.store.createCodeAssessment({ id: "missing_run", kind: "security", providerPresetId: "fixture", snapshot: snapshot("missing_run"), now: createdAt });
  second.store.bindCodeAssessmentRun("missing_run", "run_unavailable", createdAt);
  await second.daemon.stop();
  const third = await fixture.open();
  assert.deepEqual(await third.get<CodeAssessmentDetail>("/workspace/code-assessments/orphan"), detail);
  const missing = await third.get<CodeAssessmentDetail>("/workspace/code-assessments/missing_run");
  assert.equal(missing.assessment.status, "interrupted");
  assert.equal(missing.assessment.runId, "run_unavailable");
  assert.match(missing.assessment.errorMessage ?? "", /interrupted/u);
  assert.equal(missing.findings.length, 0);
  assert.equal(missing.assessment.reportArtifactId, undefined);
  assert.equal(fixture.runnerCalls, 0);
});

test("reopened assessments retain genuine runtime queue custody without a live Runner", async t => {
  const fixture = await runtimeRunQueueFixture(t);
  const current = fixture.prepare("assessment");
  fixture.enqueue(current);
  fixture.store.createCodeAssessment({ id: "queue_owned", kind: "security", providerPresetId: fixture.preset.id, snapshot: snapshot("queue_owned"), now: createdAt });
  fixture.store.bindCodeAssessmentRun("queue_owned", current.run.id, createdAt);
  fixture.reopen();
  const registry = new ActiveRunRegistry();
  assert.equal(registry.get(current.run.id), undefined);
  assert.equal(fixture.store.hasRuntimeRunQueueCustody(current.run.id), true);
  reconcileCodeAssessments(fixture.store, registry);
  assert.equal(fixture.store.getCodeAssessment("queue_owned")?.assessment.status, "analyzing");
  assert.equal(fixture.store.getCodeAssessment("queue_owned")?.assessment.runId, current.run.id);
  assert.equal(fixture.store.getRuntimeRunQueueEntry(current.run.id)?.dispatchedAt, undefined);
  assert.equal(fixture.store.getRun(current.run.id)?.status, "queued");
});

test("restart seals a terminal threat model and interrupts before admitting a new stage", { timeout: 60000 }, async t => {
  const fixture = await restartFixture(t);
  const first = await fixture.open();
  const captured = snapshot("threat_restart");
  const run = first.store.createRun({ id: "threat_restart_run", cwd: first.store.paths.cwd, taskId: "threat_task", providerName: "fixture", providerModel: "fixture",
    taskSnapshot: { id: "threat_task", title: "Bounded threat model" }, providerSnapshot: { provider: "fixture", model: "fixture" },
    requestSnapshot: { cwd: first.store.paths.cwd, codeAssessment: { id: "threat_restart", snapshotDigest: captured.digest, phase: "threat_model" } }, createdAt });
  first.store.createCodeAssessment({ id: "threat_restart", kind: "security", providerPresetId: "fixture", snapshot: captured, now: createdAt });
  first.store.bindCodeAssessmentRun("threat_restart", run.id, createdAt, "threat_model");
  first.store.appendEvent(run.id, "message_end", { role: "assistant", text: JSON.stringify({ snapshotDigest: captured.digest, summary: "Only a changed value is visible.", assets: ["Result"], trustBoundaries: [], attackerControls: [], assumptions: ["No caller context."] }) });
  first.store.markRunSucceeded(run.id, createdAt);
  await first.daemon.stop();
  const second = await fixture.open();
  const detail = await second.get<CodeAssessmentDetail>("/workspace/code-assessments/threat_restart");
  assert.equal(detail.assessment.status, "interrupted");
  assert.ok(detail.assessment.threatModelArtifactId);
  assert.deepEqual(detail.assessment.phaseRuns, [{ phase: "threat_model", runId: run.id, status: "completed", artifactId: detail.assessment.threatModelArtifactId }]);
  assert.equal(detail.assessment.reportArtifactId, undefined);
  assert.equal(fixture.runnerCalls, 0);
  assert.deepEqual(await second.get<CodeAssessmentDetail>("/workspace/code-assessments/threat_restart"), detail, "repeated reconciliation does not append phases or artifacts");
});
