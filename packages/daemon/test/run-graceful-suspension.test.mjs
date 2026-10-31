import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import * as core from "@ling-stack/core";

// Source-only leaf overlay: never writes shared dist, starts an App, or opens a
// real/temporary DB. Core lineage capture remains the actual installed Core.
async function sourceModule(url, replacements = {}) {
  let source = stripTypeScriptTypes(await readFile(url, "utf8"), { mode: "transform", sourceUrl: url.href });
  for (const [specifier, target] of Object.entries(replacements)) {
    source = source.replaceAll(JSON.stringify(specifier), JSON.stringify(target));
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const runnerUrl = await sourceModule(new URL("../../runner-pi/src/runtime-suspension.ts", import.meta.url));
const controllerUrl = await sourceModule(new URL("../src/features/harness/continuations/run-graceful-suspension.ts", import.meta.url), {
  "@ling-stack/core": import.meta.resolve("@ling-stack/core"), "@ling-stack/runner-pi": runnerUrl,
});
const { PiRunnerSuspended } = await import(runnerUrl);
const { RunGracefulSuspensionController, RunGracefulSuspensionBlocked } = await import(controllerUrl);
const now = "2026-10-23T03:00:00.000Z";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => structuredClone(value);
const blocked = code => error => error instanceof RunGracefulSuspensionBlocked && error.code === code;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Contract ports model durable authority, not physical-drain integration proof.
function fixture() {
  const config = {}, calls = [];
  const workspacePolicy = core.createDefaultApprovalPolicy("workspace", now);
  const policy = core.applyConversationModeToEffectiveRunPolicySnapshot(core.resolveSessionRunPolicy({
    workspacePolicy, authorizationMode: "always", workspaceAccessMode: "full_access", channelBoundPath: "/fixture",
  }).snapshot, undefined);
  const sourceFence = { workUnitId: "unit", attemptId: "attempt", runtimeInstanceId: "original-runtime", fencingToken: "1" };
  const task = { id: "task", title: "Suspension fixture", prompt: "Read owned data." };
  const preparedBody = { schemaVersion: 1, boundary: "pi-model-context", taskId: task.id,
    systemPrompt: "Fixture system", userPrompt: task.prompt,
    model: { id: "fixture-model", provider: "fixture-provider" }, thinkingLevel: "off", tools: [] };
  const execution = { schemaVersion: 1, runnerId: "pi", toolHydrationEnabled: false,
    input: { cwd: "/fixture", task, provider: { provider: "fixture-provider", model: "fixture-model" } },
    preparedInput: { ...preparedBody, fingerprint: hash(preparedBody) } };
  const run = { id: "run", status: "running", cwd: "/fixture", taskId: task.id, workUnitId: "unit",
    providerName: "fixture-provider", providerModel: "fixture-model", taskSnapshot: task, providerSnapshot: {},
    requestSnapshot: { authorizationMode: "always", workspaceAccessMode: "full_access", effectivePolicySnapshot: policy,
      runnerExecutionInput: execution }, contextViewId: "context", contextViewCreatedAt: now,
    eventLogPath: "/fixture/events.jsonl", createdAt: now, startedAt: now, updatedAt: now };
  const unit = { id: "unit", status: "running", activeAttemptId: "attempt", linkedRunId: "run", workspaceId: "workspace" };
  const attempt = { id: "attempt", ...sourceFence, status: "started", runnerId: "pi", effectiveRunnerId: "pi" };
  const store = {
    getRun: () => config.runMissing ? undefined : copy(run), getWorkUnit: () => copy(unit),
    getWorkUnitAttempt: () => copy(attempt), getApprovalPolicy: () => copy(workspacePolicy),
    getLatestWorkspaceProvenanceWatermark: () => "0", isCurrentRunExecutionOwner: () => !config.stale,
  };
  const lineage = core.captureRunProgressCheckpointLineage(store, run, policy).lineage;
  const witness = { checkpointId: "checkpoint", headRevision: 1, modelViewSha256: "a".repeat(64),
    sourceEventSeq: 7, sourceFence: copy(sourceFence), lineage };
  const f = { config, calls, store, run, unit, attempt, sourceFence, policy, witness, record: undefined, stop: undefined };
  const lifecycle = {
    requestRunSuspension(input) {
      calls.push(["request", copy(input)]);
      if (config.requestError) throw config.requestError;
      f.record = { id: "suspension", state: "requested", requestArtifactId: "request-artifact", requestDigest: "b".repeat(64),
        request: { schemaVersion: 1, kind: "run.suspension_request.v1", runId: input.runId, sourceFence: copy(input.sourceFence),
          cause: input.cause, contextDigest: "c".repeat(64), selectionDigest: "d".repeat(64), lineage: copy(input.expectedLineage),
          requestedEventSeq: 7, requestedAt: input.now } };
      return copy(config.requestReturn?.(f.record) ?? f.record);
    },
    sealRunSuspension(input) {
      calls.push(["seal", copy(input)]);
      if (config.sealError) throw config.sealError;
      f.record = { ...f.record, state: "sealed", sealArtifactId: "seal-artifact", sealDigest: "e".repeat(64),
        seal: { schemaVersion: 1, kind: "run.suspension_seal.v1", suspensionId: input.suspensionId, runId: run.id,
          sourceFence: copy(input.sourceFence), requestDigest: f.record.requestDigest, witness: copy(input.witness),
          modelViewArtifactId: "model-view-artifact", sealedAt: now } };
      return copy(config.sealReturn?.(f.record) ?? f.record);
    },
    beginRunSuspensionStop(input) {
      calls.push(["begin", copy(input)]);
      if (config.beginError) throw config.beginError;
      if (config.cancellingAtBegin) { unit.status = "cancelling"; attempt.status = "cancelling"; }
      f.stop = { suspensionId: input.suspensionId, state: "stopping", beginArtifactId: "begin-artifact", beginDigest: "f".repeat(64),
        begin: { schemaVersion: 1, kind: "run.suspension_stop_begin.v1", suspensionId: input.suspensionId, runId: run.id,
          sourceFence: copy(input.sourceFence), sealDigest: f.record.sealDigest, source: { kind: "root" }, descendants: [], begunAt: now } };
      f.stop.begin.modelAdmissionDigest = "4".repeat(64);
      f.stop.begin.canonicalEventDigest = "5".repeat(64);
      return copy(config.beginReturn?.(f.stop) ?? f.stop);
    },
    commitRunSuspensionStopped(input) {
      calls.push(["commit", copy(input)]);
      if (config.commitError) throw config.commitError;
      if (!config.durableDrained) throw new Error("Core original durable completion is absent");
      f.stop = { ...f.stop, state: "stopped", receiptArtifactId: "receipt-artifact", receiptDigest: "1".repeat(64),
        receipt: { schemaVersion: 1, kind: "run.suspension_stopped.v1", suspensionId: input.suspensionId, runId: run.id,
          sourceFence: copy(input.sourceFence), beginDigest: f.stop.beginDigest, sealDigest: f.record.sealDigest,
          completionDigest: "2".repeat(64), drainedAt: now, audit: { seq: 8, digest: "3".repeat(64) }, descendants: [], stoppedAt: now } };
      return copy(config.commitReturn?.(f.stop) ?? f.stop);
    },
    getRunSuspensionStop(id) {
      calls.push(["getStop", id]);
      return config.missingStop ? undefined : copy(config.readStop?.(f.stop) ?? f.stop);
    },
  };
  const progress = { sealSuspensionBoundary(input) {
    calls.push(["progress", copy(input)]);
    if (config.progressError) throw config.progressError;
    return copy(config.progressResult ?? { kind: "sealed", witness: config.currentWitness?.() ?? witness });
  } };
  f.controller = new RunGracefulSuspensionController({ store, run, sourceFence, policySnapshot: policy, progress, lifecycle,
    compactionProgress: input => {
      if (!config.compactionResult) return { kind: "not_compacted" };
      calls.push(["compactionProgress", copy(input)]);
      return copy(config.compactionResult);
    },
    settlementProgress: input => {
      calls.push(["settlementProgress", copy(input)]);
      return copy(config.settlementResult ?? { kind: "blocked", code: "checkpoint.effect_unknown" });
    },
    assertCurrent() { calls.push(["live"]); if (config.cancelled) throw config.cancelled; if (config.liveError) throw config.liveError; },
    assertCleanupCurrent() { calls.push(["cleanup"]); if (config.cancelled) throw config.cancelled; if (config.cleanupError) throw config.cleanupError; },
    now: () => now, async awaitDescendantsReady() { calls.push(["descendants"]); await config.descendants?.(); } });
  f.boundary = () => ({ boundary: "before_provider_request", modelView: [{ role: "user", content: task.prompt }], activeToolCallIds: [] });
  f.events = name => calls.filter(call => call[0] === name);
  f.request = () => f.controller.request("daemon_restart");
  f.seal = async () => { f.request(); return await f.controller.beforeBoundary(f.boundary()); };
  return f;
}

function compactedWitness(f) {
  return { kind: "compaction", checkpoint: { checkpointId: "compaction-checkpoint", revision: 1,
    sourceEventSeq: 3, boundaryEventSeq: 7, summaryArtifactId: "compaction-summary", summaryContentSha256: "6".repeat(64),
    contextSnapshotArtifactId: "compaction-snapshot", contextSnapshotSha256: "7".repeat(64),
    installedEventSeq: 4, installedEventDigest: "8".repeat(64), sourceFence: copy(f.sourceFence), lineage: copy(f.witness.lineage) } };
}

function settlementWitness(f) {
  return { kind: "settlement", settlement: { id: "final-settlement", artifactId: "final-evidence", digest: "9".repeat(64),
    modelViewArtifactId: "final-view", modelViewSha256: "a".repeat(64), boundaryEventSeq: 8,
    sourceFence: copy(f.sourceFence), lineage: copy(f.witness.lineage) } };
}

test("final SDK settlement uses its own witness and revalidates after descendants without checkpoint fallback", async () => {
  const f = fixture(), witness = settlementWitness(f);
  f.config.settlementResult = { kind: "sealed", witness };
  f.request();
  const directive = await f.controller.beforeSettledBoundary(f.boundary());
  assert.equal(f.events("progress").length, 0);
  assert.equal(f.events("compactionProgress").length, 0);
  assert.equal(f.events("settlementProgress").length, 2);
  assert.deepEqual(f.events("seal").map(call => call[1].witness), [witness, witness]);
  assert.equal(directive.checkpointId, witness.settlement.id);
  assert.equal(directive.checkpointSha256, witness.settlement.modelViewSha256);
  assert.equal(f.events("begin").length, 1);
});

test("unknown final SDK evidence never falls back to an older ordinary checkpoint", async () => {
  const f = fixture(); f.request();
  await assert.rejects(f.controller.beforeSettledBoundary(f.boundary()), blocked("checkpoint.effect_unknown"));
  assert.equal(f.events("progress").length, 0);
  assert.equal(f.events("seal").length, 0); assert.equal(f.events("begin").length, 0);
});

test("final settlement identity drift across descendant await cannot begin stopping", async () => {
  const f = fixture(), witness = settlementWitness(f);
  f.config.settlementResult = { kind: "sealed", witness };
  f.config.descendants = () => { witness.settlement.digest = "0".repeat(64); };
  f.request();
  await assert.rejects(f.controller.beforeSettledBoundary(f.boundary()), blocked("suspension.witness_mismatch"));
  assert.equal(f.events("seal").length, 1); assert.equal(f.events("begin").length, 0);
});

test("a final settlement predating the suspension request cannot authorize stopping", async () => {
  const f = fixture(), witness = settlementWitness(f);
  witness.settlement.boundaryEventSeq = 6;
  f.config.settlementResult = { kind: "sealed", witness }; f.request();
  await assert.rejects(f.controller.beforeSettledBoundary(f.boundary()), blocked("suspension.witness_mismatch"));
  assert.equal(f.events("seal").length, 0); assert.equal(f.events("begin").length, 0);
});

test("compaction seal keeps its own witness and later boundary watermark without ordinary fallback", async () => {
  const f = fixture(), witness = compactedWitness(f);
  f.config.compactionResult = { kind: "sealed", witness };
  const directive = await f.seal();
  assert.equal(f.events("progress").length, 0);
  assert.equal(f.events("compactionProgress").length, 2);
  assert.deepEqual(f.events("seal").map(call => call[1].witness), [witness, witness]);
  assert.equal(directive.checkpointId, witness.checkpoint.checkpointId);
  assert.equal(directive.checkpointSha256, witness.checkpoint.summaryContentSha256);
  assert.equal(f.events("begin").length, 1);
});

test("compaction blockers never fall through to an older ordinary checkpoint", async () => {
  const f = fixture();
  f.config.compactionResult = { kind: "blocked", code: "checkpoint.snapshot_unavailable" };
  await assert.rejects(f.seal(), blocked("checkpoint.snapshot_unavailable"));
  assert.equal(f.events("progress").length, 0);
  assert.equal(f.events("seal").length, 0); assert.equal(f.events("begin").length, 0);
});

test("compaction boundary predating the request cannot borrow its checkpoint identity", async () => {
  const f = fixture(), witness = compactedWitness(f);
  witness.checkpoint.boundaryEventSeq = 6;
  f.config.compactionResult = { kind: "sealed", witness };
  await assert.rejects(f.seal(), blocked("suspension.witness_mismatch"));
  assert.equal(f.events("seal").length, 0); assert.equal(f.events("begin").length, 0);
});

test("compaction revision drift across the descendant await cannot start physical stop", async () => {
  const f = fixture(), witness = compactedWitness(f);
  f.config.compactionResult = { kind: "sealed", witness };
  f.config.descendants = () => { witness.checkpoint.revision += 1; };
  await assert.rejects(f.seal(), blocked("suspension.witness_mismatch"));
  assert.equal(f.events("progress").length, 0); assert.equal(f.events("seal").length, 1);
  assert.equal(f.events("begin").length, 0);
});

test("without a request the boundary and ordinary-result guard are side-effect free", async () => {
  const f = fixture();
  assert.equal(f.controller.hasPendingRequest(), false);
  assert.equal(await f.controller.beforeBoundary(f.boundary()), undefined);
  f.controller.assertSuspensionHandled();
  assert.deepEqual(f.calls, []);
});

test("request synchronously persists exact source/lineage and captures immutable internal identity", () => {
  const f = fixture(), record = f.request();
  assert.equal(f.controller.hasPendingRequest(), true);
  assert.equal(f.events("request").length, 1);
  assert.deepEqual(f.events("request")[0][1], { runId: "run", sourceFence: f.sourceFence,
    cause: "daemon_restart", expectedLineage: f.witness.lineage, now });
  record.request.sourceFence.attemptId = "mutated-return";
  assert.equal(f.request().request.sourceFence.attemptId, "attempt");
  assert.equal(f.events("request").length, 1);
  assert.throws(() => f.controller.request("desktop_quit"), blocked("suspension.request_conflict"));
  assert.throws(() => f.controller.assertSuspensionHandled(), blocked("suspension.boundary_unavailable"));
});

test("request freezes the original constructor fence rather than a later caller mutation", () => {
  const f = fixture(); f.sourceFence.attemptId = "caller-replaced-attempt";
  assert.equal(f.request().request.sourceFence.attemptId, "attempt");
  assert.equal(f.events("request")[0][1].sourceFence.attemptId, "attempt");
});

test("repeated request cannot replace its first durable lineage", () => {
  const f = fixture(); f.request(); f.run.contextViewId = "replaced-context";
  assert.throws(f.request, blocked("suspension.witness_mismatch"));
  assert.equal(f.events("request").length, 1);
});

for (const [label, change, code] of [
  ["not started", f => { f.run.status = "queued"; f.attempt.status = "created"; }, "suspension.source_not_started"],
  ["terminal", f => { f.run.status = "completed"; }, "suspension.source_stale"],
  ["missing", f => { f.config.runMissing = true; }, "suspension.source_stale"],
  ["wrong fence", f => { f.attempt.fencingToken = "2"; }, "suspension.source_stale"],
  ["cancel requested", f => { f.attempt.abortRequestedAt = now; }, "suspension.source_stale"],
]) {
  test(`request fails closed with typed blocked for ${label}`, () => {
    const f = fixture(); change(f);
    assert.throws(f.request, blocked(code));
    assert.equal(f.events("request").length, 0);
    assert.equal(f.controller.hasPendingRequest(), false);
  });
}

test("request persistence errors propagate, never manufacturing a pending durable request", () => {
  const f = fixture(), error = new Error("SQLite request failed"); f.config.requestError = error;
  assert.throws(f.request, failure => failure === error);
  assert.equal(f.controller.hasPendingRequest(), false);
});

test("explicit cancellation precedes request persistence and ordinary-result blockers", async () => {
  const f = fixture(), error = new Error("original user cancellation"); f.config.cancelled = error;
  assert.throws(f.request, failure => failure === error);
  assert.equal(f.events("request").length, 0);
  f.config.cancelled = undefined; f.request(); f.config.cancelled = error;
  assert.throws(() => f.controller.assertSuspensionHandled(), failure => failure === error);
  f.config.cancelled = undefined; await f.controller.beforeBoundary(f.boundary()); f.config.cancelled = error;
  assert.throws(() => f.controller.assertSuspensionHandled(), failure => failure === error);
});

test("Core lineage permission drift is a typed blocker before request persistence", () => {
  const f = fixture(); f.run.requestSnapshot.effectivePolicySnapshot.toolDecisions.read = "deny";
  assert.throws(f.request, blocked("checkpoint.permission_drift"));
  assert.equal(f.events("request").length, 0);
});

test("an in-flight unsafe boundary waits for provider admission, never seals or permits terminal fallback", async () => {
  const f = fixture(); f.request();
  for (const boundary of ["before_agent_start", "tool_call"]) {
    assert.equal(await f.controller.beforeBoundary({ ...f.boundary(), boundary, modelView: undefined }), undefined);
  }
  assert.equal(f.events("progress").length, 0);
  assert.throws(() => f.controller.assertSuspensionHandled(), blocked("suspension.boundary_unavailable"));
});

test("provider boundary forces a seal with no ordinary progress call and waits before beginning stop", async () => {
  const f = fixture(), ready = deferred(); f.config.descendants = () => ready.promise;
  f.request(); const pending = f.controller.beforeBoundary(f.boundary());
  await Promise.resolve();
  assert.equal(f.events("progress").length, 1); assert.equal(f.events("seal").length, 1);
  assert.equal(f.events("descendants").length, 1); assert.equal(f.events("begin").length, 0);
  ready.resolve(); const directive = await pending;
  assert.deepEqual(directive, { schemaVersion: 1, kind: "runtime_suspension", runId: "run", attemptId: "attempt",
    suspensionId: "suspension", checkpointId: "checkpoint", checkpointSha256: f.witness.modelViewSha256 });
  assert.equal(Object.isFrozen(directive), true);
  assert.equal(f.events("progress").length, 2); assert.equal(f.events("seal").length, 2);
  assert.equal(f.events("begin").length, 1); assert.equal(f.events("commit").length, 0);
  assert.throws(() => f.controller.assertSuspensionHandled(), blocked("suspension.result_not_suspended"));
  assert.throws(() => f.controller.beforeBoundary({ ...f.boundary(), boundary: "tool_call" }), blocked("suspension.already_sealed"));
});

for (const [label, code] of [
  ["missing model view", "checkpoint.snapshot_unavailable"], ["active tools", "checkpoint.effect_unknown"],
  ["final assistant", "checkpoint.lineage_mismatch"], ["compacted view", "checkpoint.lineage_mismatch"],
  ["unjournaled effect", "checkpoint.effect_unjournaled"],
]) {
  test(`ordinary producer blocker propagates for ${label}, with no stop or terminal fallback`, async () => {
    const f = fixture(); f.request(); f.config.progressResult = { kind: "blocked", code };
    await assert.rejects(f.controller.beforeBoundary(f.boundary()), blocked(code));
    assert.equal(f.events("begin").length, 0); assert.equal(f.events("seal").length, 0);
    assert.throws(() => f.controller.assertSuspensionHandled(), blocked("suspension.boundary_unavailable"));
  });
}

test("an ordinary not_needed DTO cannot substitute for a forced suspension seal", async () => {
  const f = fixture(); f.request(); f.config.progressResult = { kind: "not_needed" };
  await assert.rejects(f.controller.beforeBoundary(f.boundary()), blocked("checkpoint.snapshot_unavailable"));
  assert.equal(f.events("seal").length, 0); assert.equal(f.events("begin").length, 0);
});

for (const [label, field, configure] of [
  ["request source", "requestReturn", record => { record.request.sourceFence.attemptId = "other"; return record; }],
  ["sealed witness", "sealReturn", record => { record.seal.witness.checkpoint.modelViewSha256 = "0".repeat(64); return record; }],
  ["stop begin source", "beginReturn", record => { record.begin.sourceFence.attemptId = "other"; return record; }],
  ["stop begin seal", "beginReturn", record => { record.begin.sealDigest = "0".repeat(64); return record; }],
  ["stop begin admission", "beginReturn", record => { delete record.begin.modelAdmissionDigest; return record; }],
]) {
  test(`private port exact binding rejects wrong ${label}`, async () => {
    const f = fixture(); f.config[field] = configure;
    if (field === "requestReturn") assert.throws(f.request, blocked("suspension.request_mismatch"));
    else {
      f.request();
      await assert.rejects(f.controller.beforeBoundary(f.boundary()), blocked(field === "sealReturn"
        ? "suspension.witness_mismatch" : "suspension.stop_unverified"));
    }
    assert.equal(f.events("commit").length, 0);
  });
}

for (const stage of ["progress", "seal", "begin"]) {
  test(`${stage} exception retains original failure and cannot become a suspension success`, async () => {
    const f = fixture(), error = new Error(`${stage} failed`); f.config[`${stage}Error`] = error; f.request();
    await assert.rejects(f.controller.beforeBoundary(f.boundary()), failure => failure === error);
    assert.throws(() => f.controller.commitStopped(), blocked("suspension.sdk_stop_unobserved"));
    assert.equal(f.events("commit").length, 0);
  });
}

test("descendant barrier rejection is preserved and never begins source stop", async () => {
  const f = fixture(), error = new Error("descendant cannot become ready"); f.request();
  f.config.descendants = () => Promise.reject(error);
  await assert.rejects(f.controller.beforeBoundary(f.boundary()), failure => failure === error);
  assert.equal(f.events("begin").length, 0);
});

for (const [label, mutate, expected] of [
  ["source fence", f => { f.attempt.fencingToken = "2"; }, blocked("suspension.source_stale")],
  ["checkpoint witness", f => { f.witness.headRevision += 1; }, blocked("suspension.witness_mismatch")],
  ["explicit cancellation", f => { f.config.cancelled = new Error("user cancelled"); }, error => error.message === "user cancelled"],
  ["current authorization", f => { f.config.liveError = new Error("authorization revoked"); }, error => error.message === "authorization revoked"],
]) {
  test(`after descendant await ${label} is revalidated before beginStop`, async () => {
    const f = fixture(); f.request(); f.config.descendants = async () => { mutate(f); };
    await assert.rejects(f.controller.beforeBoundary(f.boundary()), expected);
    assert.equal(f.events("begin").length, 0);
  });
}

test("concurrent identical provider boundaries share one captured immutable flight", async () => {
  const f = fixture(), ready = deferred(); f.config.descendants = () => ready.promise; f.request();
  const input = f.boundary(), first = f.controller.beforeBoundary(input);
  assert.equal(f.controller.beforeBoundary(copy(input)), first);
  input.modelView[0].content = "caller mutation";
  assert.throws(() => f.controller.beforeBoundary(input), blocked("suspension.boundary_changed"));
  ready.resolve(); const directive = await first;
  assert.equal(await f.controller.beforeBoundary(f.boundary()), directive);
  assert.equal(f.events("begin").length, 1); assert.equal(f.events("descendants").length, 1);
  assert.equal(f.events("progress")[0][1].modelView[0].content, "Read owned data.");
});

test("a failed boundary cannot be replaced by a later ordinary-result or retry", async () => {
  const f = fixture(), error = new Error("sealed descendant failure"); f.request();
  f.config.descendants = () => Promise.reject(error);
  const first = f.controller.beforeBoundary(f.boundary());
  await assert.rejects(first, failure => failure === error);
  assert.equal(f.controller.beforeBoundary(f.boundary()), first);
  assert.throws(() => f.controller.assertSuspensionHandled(), blocked("suspension.result_not_suspended"));
});

test("only an exact genuine SDK suspension is observed, not a DTO, generic error or wrong directive", async () => {
  const f = fixture(), directive = await f.seal();
  for (const candidate of [directive, { name: "PiRunnerSuspended", request: directive, sdkStoppedAt: now },
    new Error("Runner suspended"), new PiRunnerSuspended({ ...directive, attemptId: "other" }, now),
    new PiRunnerSuspended({ ...directive, runId: "other" }, now),
    new PiRunnerSuspended({ ...directive, checkpointSha256: "0".repeat(64) }, now),
    new PiRunnerSuspended({ ...directive, checkpointId: "other" }, now),
    new PiRunnerSuspended({ ...directive, suspensionId: "other" }, now),
    new PiRunnerSuspended(directive, "not-a-time"), new PiRunnerSuspended(directive, "2026-10-22T03:00:00.000Z")]) {
    assert.throws(() => f.controller.observeSuspended(candidate), blocked("suspension.directive_mismatch"));
  }
  f.controller.observeSuspended(new PiRunnerSuspended(directive, now));
  assert.equal(f.events("commit").length, 0, "SDK stop alone is not Host drain");
});

test("commit requires observed SDK stop and then Core durable closure; SDK error is never a drain flag", async () => {
  const f = fixture(), directive = await f.seal();
  assert.throws(() => f.controller.commitStopped(), blocked("suspension.sdk_stop_unobserved"));
  f.controller.observeSuspended(new PiRunnerSuspended(directive, now));
  assert.throws(() => f.controller.commitStopped(), /Core original durable completion is absent/);
  assert.equal(f.events("getStop").length, 0);
  f.config.durableDrained = true;
  const stopped = f.controller.commitStopped();
  assert.equal(stopped.state, "stopped"); assert.equal(f.events("getStop").length, 1);
  assert.deepEqual(f.events("commit").at(-1)[1], { suspensionId: "suspension", sourceFence: f.sourceFence, now });
});

test("Core stopped persistence errors propagate unchanged", async () => {
  const f = fixture(), directive = await f.seal(), error = new Error("Core stop commit failed");
  f.controller.observeSuspended(new PiRunnerSuspended(directive, now)); f.config.commitError = error;
  assert.throws(() => f.controller.commitStopped(), failure => failure === error);
  assert.equal(f.events("getStop").length, 0);
});

for (const [label, configure] of [
  ["missing readback", f => { f.config.missingStop = true; }],
  ["different readback", f => { f.config.readStop = record => ({ ...record, receiptDigest: "9".repeat(64) }); }],
  ["wrong receipt source", f => { f.config.commitReturn = record => { record.receipt.sourceFence.attemptId = "other"; f.stop = record; return record; }; }],
  ["wrong seal", f => { f.config.commitReturn = record => { record.receipt.sealDigest = "9".repeat(64); f.stop = record; return record; }; }],
  ["not actually stopped", f => { f.config.commitReturn = record => { record.state = "stopping"; f.stop = record; return record; }; }],
]) {
  test(`commit rejects ${label} rather than caching success`, async () => {
    const f = fixture(), directive = await f.seal();
    f.controller.observeSuspended(new PiRunnerSuspended(directive, now)); f.config.durableDrained = true; configure(f);
    assert.throws(() => f.controller.commitStopped(), blocked("suspension.stop_unverified"));
  });
}

test("expected cancelling uses only the explicit cleanup gate after beginStop", async () => {
  const f = fixture(); f.config.cancellingAtBegin = true;
  const directive = await f.seal(); f.config.liveError = new Error("dispatch must stay closed");
  f.controller.observeSuspended(new PiRunnerSuspended(directive, now)); f.config.durableDrained = true;
  assert.equal(f.controller.commitStopped().state, "stopped");
  assert.equal(f.attempt.status, "cancelling"); assert.equal(f.events("cleanup").length, 2);
  assert.equal(await f.controller.beforeBoundary(f.boundary()), directive, "an exact duplicate cannot reopen dispatch or stop twice");
  assert.equal(f.events("begin").length, 1);
});

for (const key of ["cancelled", "cleanupError"]) {
  test(`cleanup gate ${key} wins over exact SDK stop and stopped commit`, async () => {
    const f = fixture(), directive = await f.seal(), error = new Error(key);
    f.config[key] = error;
    assert.throws(() => f.controller.observeSuspended(new PiRunnerSuspended(directive, now)), failure => failure === error);
    f.config[key] = undefined; f.controller.observeSuspended(new PiRunnerSuspended(directive, now));
    f.config[key] = error; f.config.durableDrained = true;
    assert.throws(() => f.controller.commitStopped(), failure => failure === error);
    assert.equal(f.events("commit").length, 0);
  });
}
