import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createSqliteRunStore } from "@ling-stack/core";
import type { CodeAssessmentSnapshot } from "@ling-stack/contracts";
import { ActiveRunRegistry } from "../dist/runtime/active-runs.js";
import { cancelCodeAssessment, startCodeAssessment, type StartCodeAssessmentRun } from "../dist/features/code-assessments/service.js";

const exec = promisify(execFile);

test("duplicate threat callbacks admit one review Run and cancelled pre-admission work admits none", async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-security-phase-callback-")));
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await exec("git", ["config", "user.name", "Ling Test"], { cwd });
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(cwd, "app.ts"), "old\n");
  await exec("git", ["add", "."], { cwd }); await exec("git", ["commit", "-qm", "initial"], { cwd });
  await writeFile(join(cwd, "app.ts"), "new\n");
  const store = createSqliteRunStore(cwd);
  const createdAt = new Date().toISOString();
  const provider = store.createProviderPreset({ kind: "openai-compatible", displayName: "Stage fixture", providerId: "fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1", capabilities: ["chat"], enabled: true }, createdAt);
  const callbacks: (() => Promise<void>)[] = [];
  let admissions = 0;
  let cancelBeforeReady = false;
  const startRun: StartCodeAssessmentRun = async (request, afterTerminal, ready) => {
    admissions++;
    const run = store.createRun({ id: `stage_run_${admissions}`, cwd, taskId: request.task.id, providerName: "fixture", providerModel: "fixture",
      taskSnapshot: request.task, providerSnapshot: { provider: "fixture", model: "fixture" }, requestSnapshot: request, createdAt });
    if (cancelBeforeReady) cancelCodeAssessment(store, new ActiveRunRegistry(), store.getCodeAssessment(request.codeAssessment!.id)!);
    ready(run.id);
    const captured = JSON.parse(request.task.prompt.slice(request.task.prompt.indexOf("\n") + 1)) as CodeAssessmentSnapshot;
    const report = request.codeAssessment?.phase === "threat_model"
      ? { snapshotDigest: captured.digest, summary: "The Diff changes a value.", assets: ["Result"], trustBoundaries: [], attackerControls: [], assumptions: ["No caller context."] }
      : { snapshotDigest: captured.digest, summary: "No supported finding.", findings: [] };
    store.appendEvent(run.id, "message_end", { role: "assistant", text: JSON.stringify(report) });
    store.markRunSucceeded(run.id, new Date().toISOString());
    callbacks.push(async () => afterTerminal(store.getRun(run.id)!));
    return run.id;
  };
  try {
    const detail = await startCodeAssessment(store, { kind: "security", target: { type: "working_tree" }, providerPresetId: provider.id }, startRun);
    assert.equal(admissions, 1);
    await callbacks[0]!();
    assert.equal(admissions, 2);
    await callbacks[0]!();
    assert.equal(admissions, 2, "duplicate threat completion cannot start another review");
    await callbacks[1]!();
    const completed = store.getCodeAssessment(detail.assessment.id)!;
    assert.equal(completed.assessment.status, "completed");
    assert.equal(completed.assessment.phaseRuns?.length, 2);
    cancelBeforeReady = true;
    const cancelled = await startCodeAssessment(store, { kind: "security", target: { type: "working_tree" }, providerPresetId: provider.id }, startRun);
    assert.equal(cancelled.assessment.status, "cancelled");
    assert.equal(cancelled.assessment.phaseRuns, undefined);
    assert.equal(store.getRun("stage_run_3")?.status, "cancelled", "a Run becoming ready after aggregate cancellation is cancelled before execution");
    assert.equal(admissions, 3);
    assert.equal(callbacks.length, 2, "cancelled admission never emits or completes a stage");
  } finally { store.close(); await rm(cwd, { recursive: true, force: true }); }
});
