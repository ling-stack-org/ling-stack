import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } from "../../core/dist/index.js";

const { AttemptHostOperationTracker } = await import(process.env.LING_MEDIA_TRACKER_MODULE
  ? pathToFileURL(process.env.LING_MEDIA_TRACKER_MODULE).href : new URL("../dist/runtime/attempt-host-operation-tracker.js", import.meta.url).href);
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const required = Object.freeze({ kind: "user_input_required", requestId: "media-pause", requestVersion: 1 });

async function fixture(t, protocol = "image_response_v1") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-tracker-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now(), video = protocol === "seedance_task_v1";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "parent-runtime", runnerId: "pi", status: "started", now: at });
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) };
  const thread = store.createLingThread({ kind: "conversation", title: "Media tracker", objective: "Whole evidence" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Generate", userInstruction: "Generate",
    idempotencyKey: "turn", payload: { body: "Generate", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit("run", unit.id, at); store.markRunStarted("run", at);
  const tracker = new AttemptHostOperationTracker({ store, source });
  const parent = tracker.beginHostCall("media", "media-call");
  const transport = tracker.registerProducer(parent, "media", "media-http-chain");
  const operation = video ? "video_generate" : "image_generate", intentDigest = "a".repeat(64), target = { kind: "normal", conversationId: "conversation" };
  const created = store.createOrReuseConversationMediaJob({ runId: "run", toolCallId: "media-call", target,
    idempotencyKey: "job", mediaJob: { providerPresetId: "image", operation, prompt: "Fixture" },
    executionAdmission: { schemaVersion: 1, source, requestDigest: intentDigest } }, now());
  const prepared = { schemaVersion: 1, executionId: "execution", mediaJobId: created.mediaJob.id,
    mediaChildWorkUnitId: created.workUnit.id, executionGenerationId: "generation", source, toolCallId: "media-call", protocol,
    adapterId: "adapter", toolName: video ? "video_generate" : "image_generate", operation,
    intentDigest, targetDigest: digestHarnessToolValue(target), namespaceDigest: "b".repeat(64) };
  const sealed = store.createArtifact({ runId: "run", type: "json", path: "media/prepared.json", createdAt: now(), sealedPayload: prepared });
  const { schemaVersion: _s, source: _source, toolCallId: _call, ...intent } = prepared;
  const input = { ...intent, preparedRequestArtifactId: sealed.id, preparedRequestDigest: sealed.contentSha256, preparedAt: now() };
  const f = { cwd, store, other, tracker, source, parent, transport, unit, created, input, protocol };
  f.prepare = () => tracker.prepareMediaExecution(parent, transport, input);
  f.bind = ticket => {
    const childAttempt = store.createWorkUnitAttempt({ workUnitId: created.workUnit.id, attemptNumber: 1,
      runtimeInstanceId: "child-runtime", runnerId: "media", status: "started", now: now() });
    f.childFence = toRuntimeAttemptFence(childAttempt);
    store.transitionWorkUnitStatus({ ...f.childFence, event: "claim", actor: "system", now: now() });
    store.transitionWorkUnitStatus({ ...f.childFence, event: "runner_started", actor: "runner", now: now() });
    return tracker.bindMediaChildExecution(ticket, f.childFence);
  };
  f.effect = (ticket, override = {}) => tracker.prepareMediaEffect(ticket, { effectId: "effect", ordinal: 0,
    kind: protocol === "image_response_v1" ? "image_request" : "remote_generation_submit", method: "POST",
    routeDigest: "c".repeat(64), wireDigest: "d".repeat(64), preparedAt: now(), ...override });
  f.base = ticket => {
    const row = store.getHostMediaExecution(ticket.executionId);
    return { schemaVersion: 1, executionId: row.executionId, executionIdentityDigest: row.identityDigest,
      mediaJobId: row.mediaJobId, executionGenerationId: row.executionGenerationId, source, childFence: f.childFence,
      namespaceDigest: row.namespaceDigest, protocol };
  };
  f.seal = payload => store.createArtifact({ runId: "run", type: "json", path: `media/${payload.kind}.json`, createdAt: now(), sealedPayload: payload });
  f.response = (ticket, member) => f.seal({ ...f.base(ticket), kind: "media_response_v1", effectId: member.effectId,
    routeDigest: member.routeDigest, wireDigest: member.wireDigest, responseNamespaceDigest: input.namespaceDigest,
    httpStatus: 200, bodySha256: hash("body"), completedAt: now(),
    ...(member.kind === "remote_generation_submit" ? { externalOperationId: "remote" } : {}) });
  f.remote = (ticket, member, rawStatus, outcome) => {
    const response = f.response(ticket, member);
    tracker.recordMediaResponse(ticket, member.effectId, response.id);
    const submission = f.seal({ ...f.base(ticket), kind: "media_submission_v1", effectId: member.effectId,
      responseArtifactId: response.id, externalOperationId: "remote", statusRouteDigest: "e".repeat(64), completedAt: now() });
    tracker.recordMediaSubmission(ticket, submission.id);
    const terminal = f.seal({ ...f.base(ticket), kind: "media_terminal_v1", observation: {
      protocol, externalOperationId: "remote", identitySource: "echoed_id", rawStatus, outcome,
    }, responseNamespaceDigest: input.namespaceDigest, routeDigest: "e".repeat(64), bodySha256: hash("status"), httpStatus: 200, completedAt: now() });
    tracker.recordMediaTerminal(ticket, terminal.id);
  };
  f.manifest = (ticket, outcome = "collection_failed") => {
    const artifact = f.seal({ ...f.base(ticket), kind: "media_manifest_v1", outcome, items: [], completedAt: now() });
    tracker.recordMediaArtifactManifest(ticket, artifact.id);
    return artifact;
  };
  f.finish = ticket => {
    store.transitionWorkUnitAttemptTerminal({ ...f.childFence, event: "runner_succeeded", attemptStatus: "succeeded",
      runtimeEventType: "work_unit_succeeded", actor: "runner", now: now() });
    const row = store.getHostMediaExecution(ticket.executionId);
    const final = f.seal({ ...f.base(ticket), kind: "media_finalization_v1", effects: store.listHostMediaEffects(ticket.executionId).map(effect => ({
      effectId: effect.effectId, ...(effect.responseArtifactId ? { responseArtifactId: effect.responseArtifactId } : {}),
      ...(effect.noStartArtifactId ? { noStartArtifactId: effect.noStartArtifactId } : {}),
    })), ...(row.submissionArtifactId ? { submissionArtifactId: row.submissionArtifactId } : {}),
      ...(row.terminalArtifactId ? { terminalArtifactId: row.terminalArtifactId } : {}), manifestArtifactId: row.manifestArtifactId, completedAt: now() });
    tracker.finalizeMediaExecution(ticket, final.id);
  };
  f.replace = () => store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
    runtimeInstanceId: "successor", runnerId: "pi", status: "started", now: now() });
  return f;
}

test("Media tracker exposes fixed Core facades, not result-driven safety callbacks", async t => {
  const f = await fixture(t);
  for (const name of ["prepareMediaExecution", "bindMediaChildExecution", "prepareMediaEffect", "launchMediaEffect",
    "recordMediaResponse", "recordMediaSubmission", "recordMediaTerminal", "recordMediaArtifactManifest",
    "finalizeMediaExecution", "recordMediaEffectNoStart", "settleMediaFromStore"]) assert.equal(typeof f.tracker[name], "function", name);
});

test("Media preparation binds original parent and exact transport without settling either", async t => {
  const f = await fixture(t), ticket = f.prepare();
  const row = f.other.getHostMediaExecution(ticket.executionId);
  assert.deepEqual(row.source, f.source);
  assert.equal(row.parentOperationId, f.parent.operationId);
  assert.equal(row.transportOperationId, f.transport.operationId);
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
  assert.throws(() => f.tracker.settleMediaFromStore(f.transport));
});

test("Media tracker rejects cloned, restored and other-tracker capabilities before effects", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket);
  const other = new AttemptHostOperationTracker({ store: f.store, source: f.source });
  for (const invalid of [{ ...ticket }, Object.create(ticket), undefined]) {
    assert.throws(() => f.tracker.prepareMediaEffect(invalid, {}));
    assert.throws(() => f.tracker.launchMediaEffect(invalid, "effect", () => assert.fail("forged send")));
    assert.throws(() => f.tracker.recordMediaResponse(invalid, "effect", "artifact"));
  }
  assert.throws(() => other.bindMediaChildExecution(ticket, f.childFence));
  assert.throws(() => f.tracker.prepareMediaExecution({ ...f.parent }, f.transport, f.input));
});

test("Media actual send atomically enters both journals and barrier members", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  let sends = 0;
  assert.equal(f.tracker.launchMediaEffect(ticket, effect.effectId, () => { sends++; return "send"; }), "send");
  assert.deepEqual(f.tracker.executorGroup.getSnapshot().operations.map(row => row.state), ["launched", "launched"]);
  for (const handle of [f.parent, f.transport]) {
    assert.equal(f.other.getHostOperation(handle.operationId).phase, "launched");
    assert.throws(() => f.tracker.settleNoStart(handle));
  }
  assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, () => { sends++; }));
  assert.equal(sends, 1);
});

test("Media Comfy upload and submit share a pair but each physical member sends once", async t => {
  const f = await fixture(t, "comfy_jobs_v1"), ticket = f.prepare(); f.bind(ticket);
  const upload = f.effect(ticket, { effectId: "upload", kind: "comfy_image_upload" });
  const submit = f.effect(ticket, { effectId: "submit", ordinal: 1 });
  let sends = 0;
  assert.throws(() => f.tracker.launchMediaEffect(ticket, submit.effectId, () => { sends++; }));
  f.tracker.launchMediaEffect(ticket, upload.effectId, () => { sends++; });
  f.tracker.launchMediaEffect(ticket, submit.effectId, () => { sends++; });
  assert.equal(sends, 2);
  assert.equal(f.tracker.executorGroup.getSnapshot().operations.length, 2);
});

for (const failure of ["close", "parent replacement", "child replacement"]) {
  test(`Media ${failure} refuses all further forward effects with zero send`, async t => {
    const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
    if (failure === "close") f.tracker.executorGroup.closeAdmission(required);
    if (failure === "parent replacement") f.replace();
    if (failure === "child replacement") f.store.createWorkUnitAttempt({ workUnitId: f.created.workUnit.id, attemptNumber: 2,
      runtimeInstanceId: "child-successor", runnerId: "media", status: "started", now: now() });
    let sends = 0;
    assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, () => { sends++; }));
    assert.equal(sends, 0);
    assert.equal(f.other.listHostMediaEffects(ticket.executionId)[0].launchedAt, undefined);
  });
}

for (const failure of ["throw", "COMMIT"]) {
  test(`Media entered send then ${failure} cannot rollback either barrier to no-start or replay`, async t => {
    const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
    if (failure === "COMMIT") {
      const exec = f.store.database.exec.bind(f.store.database); let inject = true;
      f.store.database.exec = sql => { if (sql === "COMMIT" && inject) { inject = false; throw new Error("injected COMMIT failure"); } return exec(sql); };
    }
    let sends = 0;
    assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, () => {
      sends++; if (failure === "throw") throw new Error("send failed");
    }));
    assert.deepEqual(f.tracker.executorGroup.getSnapshot().operations.map(row => row.state), ["launched", "launched"]);
    assert.equal(f.other.getHostOperation(f.transport.operationId).phase, "admitted");
    for (const handle of [f.parent, f.transport]) assert.throws(() => f.tracker.settleNoStart(handle));
    assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, () => { sends++; }));
    const noStart = f.seal({ ...f.base(ticket), kind: "media_effect_no_start_v1", effectId: effect.effectId, completedAt: now() });
    assert.throws(() => f.tracker.recordMediaEffectNoStart(ticket, effect.effectId, noStart.id));
    f.tracker.executorGroup.closeAdmission(required);
    assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "blocked");
    assert.equal(sends, 1);
  });
}

test("Media refuses async send before effect and observes accidental rejected Promise without releasing blockers", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket); let sends = 0;
  assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, async () => { sends++; }));
  assert.equal(sends, 0);
  assert.throws(() => f.tracker.launchMediaEffect(ticket, effect.effectId, () => { sends++; return Promise.reject(new Error("late send reject")); }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
  assert.throws(() => f.tracker.settleNoStart(f.transport));
});

test("Media return values, a response alone and model success are not whole-operation evidence", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  f.tracker.launchMediaEffect(ticket, effect.effectId, () => true);
  const response = f.response(ticket, effect); f.tracker.recordMediaResponse(ticket, effect.effectId, response.id);
  assert.throws(() => f.tracker.settleMediaFromStore(f.transport));
  assert.throws(() => f.tracker.settleMediaFromStore(f.parent));
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});

for (const [protocol, rawStatus, outcome, manifestOutcome] of [
  ["image_response_v1", undefined, undefined, "collection_failed"],
  ["seedance_task_v1", "succeeded", "completed", "collection_failed"],
  ["seedance_task_v1", "failed", "failed", "remote_failed"],
  ["comfy_jobs_v1", "cancelled", "cancelled", "remote_cancelled"],
]) {
  test(`Media exact ${protocol}/${outcome} whole receipts settle child then parent with Core revalidation`, async t => {
    const f = await fixture(t, protocol), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
    f.tracker.launchMediaEffect(ticket, effect.effectId, () => {});
    f.tracker.executorGroup.closeAdmission(required);
    if (rawStatus) f.remote(ticket, effect, rawStatus, outcome);
    else { const response = f.response(ticket, effect); f.tracker.recordMediaResponse(ticket, effect.effectId, response.id); }
    f.manifest(ticket, manifestOutcome); f.finish(ticket);
    assert.throws(() => f.tracker.settleMediaFromStore(f.parent), "parent cannot settle before transport");
    const transport = f.tracker.settleMediaFromStore(f.transport);
    assert.equal(transport.phase, "safe");
    assert.equal(transport.settlementKind, protocol === "image_response_v1" ? "media_response_completed" : "media_remote_terminal");
    const parent = f.tracker.settleMediaFromStore(f.parent);
    assert.equal(parent.settlementKind, "media_chain_completed");
    const drain = await f.tracker.executorGroup.observeDrain(0);
    assert.equal(drain.status, "settled");
    for (const operation of drain.operations) assert.equal(operation.settlement.kind, "completed_persisted");
    assert.deepEqual(f.tracker.settleMediaFromStore(f.transport), transport);
  });
}

test("Media never-started member requires full sealed no-start and finalization, not a boolean", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  assert.throws(() => f.tracker.settleNoStart(f.transport));
  const noStart = f.seal({ ...f.base(ticket), kind: "media_effect_no_start_v1", effectId: effect.effectId, completedAt: now() });
  f.tracker.recordMediaEffectNoStart(ticket, effect.effectId, noStart.id);
  f.manifest(ticket); f.finish(ticket);
  f.tracker.executorGroup.closeAdmission(required);
  f.tracker.settleNoStart(f.transport); f.tracker.settleNoStart(f.parent);
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "settled");
});

test("Media unknown cannot be upgraded by a later result or later receipt", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  f.tracker.launchMediaEffect(ticket, effect.effectId, () => {});
  f.tracker.markUnknown(f.transport, "media_stop_unconfirmed");
  assert.throws(() => f.tracker.settleMediaFromStore(f.transport));
  const response = f.response(ticket, effect);
  assert.throws(() => f.tracker.recordMediaResponse(ticket, effect.effectId, response.id));
  f.tracker.executorGroup.closeAdmission(required);
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "blocked");
});

test("Media safe readback is independently reverified, not replayed from a cached tracker proof", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  f.tracker.launchMediaEffect(ticket, effect.effectId, () => {});
  const response = f.response(ticket, effect); f.tracker.recordMediaResponse(ticket, effect.effectId, response.id);
  f.manifest(ticket); f.finish(ticket);
  f.tracker.settleMediaFromStore(f.transport); f.tracker.settleMediaFromStore(f.parent);
  f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("0".repeat(64), response.id);
  assert.throws(() => f.tracker.settleMediaFromStore(f.transport));
  assert.throws(() => f.tracker.settleFromStore(f.parent));
});

test("Media finalized receipt alone does not settle either operation or reopen forward admission", async t => {
  const f = await fixture(t), ticket = f.prepare(); f.bind(ticket); const effect = f.effect(ticket);
  f.tracker.launchMediaEffect(ticket, effect.effectId, () => {});
  f.tracker.executorGroup.closeAdmission(required);
  const response = f.response(ticket, effect); f.tracker.recordMediaResponse(ticket, effect.effectId, response.id);
  f.manifest(ticket); f.finish(ticket);
  assert.equal(f.other.getHostOperation(f.transport.operationId).phase, "launched");
  assert.equal((await f.tracker.executorGroup.observeDrain(0)).status, "blocked");
  assert.throws(() => f.tracker.launchMediaEffect(ticket, "additional", () => assert.fail("must not reopen")));
  assert.throws(() => f.effect(ticket, { effectId: "additional", ordinal: 1 }));
});
