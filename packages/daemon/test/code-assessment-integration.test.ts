import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { CodeAssessmentDetail, CodeAssessmentList, CodeAssessmentSnapshot } from "@ling-stack/contracts";
import { createSqliteRunStore } from "@ling-stack/core";
import type { PiRunnerRunOptions } from "@ling-stack/runner-pi";
import { createDaemonServer } from "../dist/index.js";
import { ToolFreePiRunner } from "./support/tool-free-pi-runner.mjs";

type ScriptedRun = (options: PiRunnerRunOptions, reply: () => string | Promise<string>) => ReturnType<ToolFreePiRunner["runTask"]>;
const exec = promisify(execFile);

test("real Pi assessment persists reports, rejects foreign access, and handles failure/cancel/reconnect", { timeout: 60000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-assessment-integration-")));
  const cwd = join(root, "workspace"), userRoot = join(root, "user");
  await mkdir(cwd);
  await mkdir(userRoot);
  const previousUserRoot = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  let stopDaemon: (() => Promise<void>) | undefined;
  t.after(async () => {
    try { await stopDaemon?.(); }
    finally {
      if (previousUserRoot === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousUserRoot;
      await rm(root, { recursive: true, force: true });
    }
  });
  // A broken agent Hooks configuration must not prevent an assessment Run.
  await writeFile(join(userRoot, "hooks.json"), "{", { mode: 0o600 });
  await exec("git", ["init", "-q", "-b", "main"], { cwd });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd });
  await exec("git", ["config", "user.name", "Ling Test"], { cwd });
  await writeFile(join(cwd, ".gitignore"), ".ling-stack/\n");
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  await exec("git", ["add", "."], { cwd }); await exec("git", ["commit", "-qm", "initial"], { cwd });
  await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
  const store = createSqliteRunStore(cwd);
  let mode: "valid" | "invalid" | "invalid_threat" | "blocked" = "valid";
  let release: (() => void) | undefined;
  let enteredBlocked: (() => void) | undefined;
  const blockedEntered = new Promise<void>(resolve => { enteredBlocked = resolve; });
  let exitedBlocked: (() => void) | undefined;
  const blockedExited = new Promise<void>(resolve => { exitedBlocked = resolve; });
  let sdkCalls = 0;
  const seen: PiRunnerRunOptions[] = [];
  class AssessmentRunner extends ToolFreePiRunner {
    async runTask(options: PiRunnerRunOptions) {
      seen.push(options);
      assert.deepEqual(options.tools, []);
      assert.deepEqual(options.mcpTools, []);
      assert.deepEqual(options.hostCapabilityTools, []);
      assert.deepEqual(options.mediaGenerationTools, []);
      assert.equal(options.hooks, undefined);
      assert.deepEqual(options.initialToolSurface, { toolHydration: false, mediaGeneration: false, userInput: false, delegation: false, nativeFileCreate: false });
      assert.equal(options.onMcpToolCall, undefined);
      assert.equal(options.onUserInputRequest, undefined);
      const snapshot = JSON.parse(options.task.prompt.slice(options.task.prompt.indexOf("\n") + 1)) as CodeAssessmentSnapshot & { assessmentPhase: "threat_model" | "reviewing_code"; threatModel?: { snapshotDigest: string } };
      assert.doesNotMatch(options.systemPrompt ?? "", /export const value/u, "source stays in task data");
      return (super.runTask as ScriptedRun).call(this, options, async () => {
        sdkCalls++;
        if (mode === "blocked") {
          enteredBlocked?.();
          try {
            await new Promise<void>(resolve => { release = resolve; options.signal?.addEventListener("abort", () => resolve(), { once: true }); });
            options.signal?.throwIfAborted();
          } finally { exitedBlocked?.(); }
        }
        if (snapshot.assessmentPhase === "threat_model") {
          if (mode === "invalid_threat") return "not a threat model";
          return JSON.stringify({ snapshotDigest: snapshot.digest, summary: "Only the changed constant is visible.", assets: ["Caller result"], trustBoundaries: [], attackerControls: [], assumptions: ["Caller context is outside this Diff."] });
        }
        assert.equal(snapshot.threatModel?.snapshotDigest, snapshot.digest, "second stage receives the sealed bounded model for this exact snapshot");
        if (mode === "invalid") return "not a structured report sk-fakeassessment123456";
        return JSON.stringify({ snapshotDigest: snapshot.digest, summary: "One candidate in the captured Diff.", findings: [{ title: "Changed constant",
          body: "This changes the observed constant for every caller.", severity: "medium", confidence: "high", path: "app.ts", side: "new", startLine: 1, endLine: 1, evidence: "export const value = 2;" }] });
      });
    }
  }
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd,
    channels: { autoRoute: false, intentSelector: false, terminalReports: false, teamObserverBus: false } }, { runner: new AssessmentRunner(), storeFactory: () => store });
  stopDaemon = async () => { release?.(); await daemon.stop(); };
  await daemon.start();
  const address = daemon.server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}cwd=${encodeURIComponent(cwd)}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json(); assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`); return result as T;
  }
  const provider = (await api<{ provider: { id: string } }>("/providers", "POST", { kind: "glm", displayName: "Local assessment transport", providerId: "assessment-fixture", model: "fixture", api: "openai-completions",
    baseUrl: "https://assessment-fixture.invalid/v1", capabilities: ["chat", "tool_call"], input: ["text"], authHeader: false, reasoning: false, enabled: true })).provider;
  store.recordProviderCheckResult(provider.id, { ok: true, code: "ready", message: "Scripted local SDK transport", checkedAt: new Date().toISOString() });
  const input = { kind: "security", target: { type: "working_tree" }, providerPresetId: provider.id };
  const start = () => api<CodeAssessmentDetail>("/workspace/code-assessments", "POST", input);
  async function terminal(id: string): Promise<CodeAssessmentDetail> {
    for (let count = 0; count < 400; count++) {
      const detail = await api<CodeAssessmentDetail>(`/workspace/code-assessments/${id}`);
      if (!["queued", "analyzing"].includes(detail.assessment.status)) return detail;
      await delay(20);
    }
    throw new Error(`Assessment timed out: ${JSON.stringify(store.getCodeAssessment(id))}`);
  }
  const created = await start();
  const completed = await terminal(created.assessment.id);
  assert.equal(completed.assessment.status, "completed", JSON.stringify(completed));
  assert.equal(completed.findings.length, 1);
  assert.equal(completed.findings[0]?.validation, "unverified");
  assert.equal(completed.assessment.phase, "completed");
  assert.equal(completed.assessment.validation.state, "inconclusive");
  assert.ok(completed.assessment.phaseHistory.some(entry => entry.phase === "validating_output"));
  assert.ok(completed.assessment.phaseHistory.some(entry => entry.phase === "validating_candidates" && entry.status !== "skipped"));
  assert.ok(completed.assessment.metrics.captureDurationMs! >= 0);
  assert.ok(completed.assessment.metrics.timeToFinalMs! >= completed.assessment.metrics.timeToSummaryMs!);
  assert.equal(completed.assessment.metrics.timeToFirstFindingMs, undefined);
  assert.ok(completed.assessment.metrics.reportBytes! > 0);
  assert.ok(completed.assessment.reportArtifactId);
  assert.ok(completed.assessment.threatModelArtifactId);
  assert.deepEqual(completed.assessment.phaseRuns?.map(item => [item.phase, item.status]), [["threat_model", "completed"], ["reviewing_code", "completed"]]);
  assert.equal(new Set(completed.assessment.phaseRuns?.map(item => item.runId)).size, 2);
  assert.equal(completed.assessment.phaseRuns?.[0]?.artifactId, completed.assessment.threatModelArtifactId);
  assert.equal(completed.assessment.phaseRuns?.[1]?.runId, completed.assessment.runId);
  const threatArtifact = store.getArtifact(completed.assessment.threatModelArtifactId)!;
  assert.equal(threatArtifact.runId, completed.assessment.phaseRuns?.[0]?.runId);
  assert.equal((threatArtifact.sealedPayload as { snapshotDigest: string }).snapshotDigest, completed.snapshot.digest);
  assert.ok(completed.assessment.phaseHistory.some(entry => entry.phase === "threat_model" && entry.status !== "skipped"));
  assert.equal((store.getArtifact(completed.assessment.reportArtifactId)!.sealedPayload as { snapshotDigest: string }).snapshotDigest, completed.snapshot.digest);
  assert.equal((await api<{ state: string }>(`/workspace/code-assessments/${created.assessment.id}/freshness`, "POST", {})).state, "current");
  await writeFile(join(cwd, "app.ts"), "export const value = 3;\n");
  const staleResolution = await fetch(`${base}/workspace/code-assessments/${created.assessment.id}/findings/${completed.findings[0]!.id}?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotDigest: completed.snapshot.digest, disposition: "resolved", closeReason: "out_of_scope", reason: "Manually handled." }),
  });
  assert.equal(staleResolution.status, 409, "resolve checks the repository again instead of trusting cached current freshness");
  assert.equal((await api<{ state: string }>(`/workspace/code-assessments/${created.assessment.id}/freshness`, "POST", {})).state, "stale");
  const stale = await api<CodeAssessmentDetail>(`/workspace/code-assessments/${created.assessment.id}`);
  assert.equal(stale.assessment.freshness?.state, "stale");
  assert.equal(stale.findings[0]?.freshnessState, "stale");
  await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
  const finding = completed.findings[0]!;
  const resolved = await api<{ disposition: string; validation: string }>(`/workspace/code-assessments/${created.assessment.id}/findings/${finding.id}`, "POST", { snapshotDigest: completed.snapshot.digest, disposition: "resolved", closeReason: "out_of_scope", reason: "Manually handled." });
  assert.equal(resolved.disposition, "resolved");
  assert.equal(resolved.validation, "unverified");
  const dismissed = await api<{ disposition: string }>(`/workspace/code-assessments/${created.assessment.id}/findings/${finding.id}`, "POST", { snapshotDigest: completed.snapshot.digest, disposition: "dismissed", closeReason: "accepted_risk", reason: "Expected configuration." });
  assert.equal(dismissed.disposition, "dismissed");
  const mismatched = await fetch(`${base}/workspace/code-assessments/${created.assessment.id}/findings/${finding.id}?cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshotDigest: "wrong", disposition: "open" }),
  });
  assert.equal(mismatched.status, 409);
  assert.equal(store.getCodeAssessment(created.assessment.id)!.findings[0]!.disposition, "dismissed");
  assert.equal((await api<{ disposition: string }>(`/workspace/code-assessments/${created.assessment.id}/findings/${finding.id}`, "POST", { snapshotDigest: completed.snapshot.digest, disposition: "open" })).disposition, "open");
  for (const [origin, root] of [["https://foreign.invalid", cwd], ["null", cwd], ["http://localhost:4174", join(cwd, "..", "unknown-assessment")]]) {
    const response = await fetch(`${base}/workspace/code-assessments?cwd=${encodeURIComponent(root!)}`, { headers: { origin: origin! } });
    assert.equal(response.status, 403, `${origin} ${root}: ${await response.text()}`);
  }
  mode = "invalid";
  await writeFile(join(cwd, "app.ts"), "export const value = 4;\n");
  const invalid = await terminal((await start()).assessment.id);
  assert.equal(invalid.assessment.status, "failed"); assert.equal(invalid.findings.length, 0);
  assert.equal(invalid.assessment.phase, "failed");
  assert.ok(invalid.assessment.phaseHistory.some(entry => entry.phase === "validating_output"));
  const autoStale = store.getCodeAssessment(created.assessment.id)!;
  assert.equal(autoStale.assessment.freshness?.state, "stale", "a new capture invalidates the previous result for the same target");
  assert.equal(autoStale.findings[0]?.freshnessState, "stale");
  assert.ok(invalid.assessment.diagnosticArtifactId);
  const diagnostic = store.getArtifact(invalid.assessment.diagnosticArtifactId)!;
  assert.equal(diagnostic.runId, invalid.assessment.runId);
  assert.equal((diagnostic.sealedPayload as { snapshotDigest: string }).snapshotDigest, invalid.snapshot.digest);
  assert.match(JSON.stringify(diagnostic.sealedPayload), /not a structured report/u);
  assert.doesNotMatch(JSON.stringify(diagnostic.sealedPayload), /sk-fakeassessment123456/u);
  await writeFile(join(cwd, "app.ts"), "export const value = 2;\n");
  mode = "invalid_threat";
  const invalidThreat = await terminal((await start()).assessment.id);
  assert.equal(invalidThreat.assessment.status, "failed");
  assert.equal(invalidThreat.assessment.threatModelArtifactId, undefined);
  assert.equal(invalidThreat.assessment.phaseRuns?.length, 1, "invalid threat model cannot admit review stage");
  assert.ok(invalidThreat.assessment.diagnosticArtifactId);
  assert.equal(store.getCodeAssessment(created.assessment.id)!.assessment.freshness?.state, "current", "recapturing the original source restores matching freshness");
  mode = "valid";
  await writeFile(join(cwd, ".env"), "password=excluded\n");
  const partial = await terminal((await start()).assessment.id);
  assert.equal(partial.assessment.status, "partial");
  assert.equal(partial.snapshot.coverage, "partial");
  assert.equal((await api<{ state: string }>(`/workspace/code-assessments/${partial.assessment.id}/freshness`, "POST", {})).state, "unknown");
  await rm(join(cwd, ".env"));
  mode = "blocked";
  const blocked = await start();
  await blockedEntered;
  assert.equal((await start()).assessment.id, blocked.assessment.id, "duplicate active requests reuse the same digest-bound assessment");
  assert.ok(release, "cancellation exercises the running SDK transport");
  await api(`/workspace/code-assessments/${blocked.assessment.id}/cancel`, "POST", {});
  const cancelled = await terminal(blocked.assessment.id);
  assert.equal(cancelled.assessment.status, "cancelled");
  assert.equal(cancelled.assessment.phase, "cancelled");
  assert.ok(cancelled.assessment.metrics.cancelLatencyMs! >= 0);
  assert.equal(cancelled.findings.length, 0);
  assert.equal(cancelled.assessment.phaseRuns?.length, 1, "cancel during threat modeling cannot admit a later stage");
  release?.();
  await blockedExited;
  assert.equal(store.getCodeAssessment(blocked.assessment.id)!.assessment.status, "cancelled", "late completion cannot revive a cancelled result");
  // A pre-Run orphan simulates restart between durable creation and Runner admission.
  const snapshot = { ...completed.snapshot, id: "orphan_snapshot" };
  store.createCodeAssessment({ id: "orphan", kind: "review", providerPresetId: provider.id, snapshot, now: new Date().toISOString() });
  const interrupted = await api<CodeAssessmentDetail>("/workspace/code-assessments/orphan");
  assert.equal(interrupted.assessment.status, "interrupted");
  assert.equal(interrupted.assessment.phase, "interrupted");
  const history = await api<CodeAssessmentList>("/workspace/code-assessments?limit=2");
  assert.equal(history.assessments.length, 2); assert.equal(history.nextOffset, 2);
  const filtered = await api<CodeAssessmentList>(`/workspace/code-assessments?kind=security&targetType=working_tree&status=completed&severity=medium&confidence=high&snapshotDigest=${completed.snapshot.digest}&updatedAfter=2026-01-01T00%3A00%3A00Z`);
  assert.deepEqual(filtered.assessments.map(item => item.id), [created.assessment.id]);
  assert.equal(filtered.total, 1);
  for (const query of ["severity=urgent", "confidence=certain", "targetType=github", "snapshotDigest=bad", "updatedAfter=yesterday", "updatedAfter=2027-01-01T00%3A00%3A00Z&updatedBefore=2026-01-01T00%3A00%3A00Z"]) {
    const response = await fetch(`${base}/workspace/code-assessments?cwd=${encodeURIComponent(cwd)}&${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal(seen.length >= 2, true); assert.equal(sdkCalls >= 2, true);
});
