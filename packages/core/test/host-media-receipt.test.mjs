import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } from "../dist/index.js";
import { assertUserInputDurableQuiescence } from "../dist/storage/sqlite/user-input-durable-quiescence.js";

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(t, protocol = "image_response_v1") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-receipt-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now(), video = protocol === "seedance_task_v1";
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "parent-runtime", runnerId: "pi", status: "started", now: at });
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) };
  const thread = store.createLingThread({ kind: "conversation", title: "Media receipts", objective: "Exact evidence" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Generate", userInstruction: "Generate",
    idempotencyKey: "turn", payload: { body: "Generate", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit("run", unit.id, at); store.markRunStarted("run", at);
  const parent = store.admitHostOperation({ operationId: "parent", source, kind: "media", toolCallId: "media-call" });
  const transport = store.admitHostOperation({ operationId: "transport", source, kind: "media", toolCallId: "media-call",
    parentOperationId: "parent", producerId: "media-http-chain" });
  const operation = video ? "video_generate" : "image_generate", intentDigest = "a".repeat(64), target = { kind: "normal", conversationId: "conversation" };
  const created = store.createOrReuseConversationMediaJob({ runId: "run", toolCallId: "media-call", target,
    idempotencyKey: "job", mediaJob: { providerPresetId: "image", operation, prompt: "Test" },
    executionAdmission: { schemaVersion: 1, source, requestDigest: intentDigest } }, now());
  const prepared = { schemaVersion: 1, executionId: "execution", mediaJobId: created.mediaJob.id,
    mediaChildWorkUnitId: created.workUnit.id, executionGenerationId: "generation", source, toolCallId: "media-call", protocol,
    adapterId: "adapter", toolName: video ? "video_generate" : "image_generate", operation,
    intentDigest, targetDigest: digestHarnessToolValue(target), namespaceDigest: "b".repeat(64) };
  const sealed = store.createArtifact({ runId: "run", type: "json", path: "media/prepared.json", createdAt: now(), sealedPayload: prepared });
  const { schemaVersion: _s, source: _source, toolCallId: _call, ...input } = prepared;
  const ticket = store.prepareHostMediaExecution(parent, transport, { ...input, preparedRequestArtifactId: sealed.id,
    preparedRequestDigest: sealed.contentSha256, preparedAt: now() });
  const childAttempt = store.createWorkUnitAttempt({ workUnitId: created.workUnit.id, attemptNumber: 1,
    runtimeInstanceId: "child-runtime", runnerId: "media", status: "started", now: now() });
  const childFence = toRuntimeAttemptFence(childAttempt);
  store.transitionWorkUnitStatus({ ...childFence, event: "claim", actor: "system", now: now() });
  store.transitionWorkUnitStatus({ ...childFence, event: "runner_started", actor: "runner", now: now() });
  store.bindHostMediaChildExecution(ticket, childFence);
  const execution = store.getHostMediaExecution(ticket.executionId);
  const base = { schemaVersion: 1, executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    mediaJobId: execution.mediaJobId, executionGenerationId: execution.executionGenerationId, source, childFence,
    namespaceDigest: execution.namespaceDigest, protocol };
  const seal = payload => store.createArtifact({ runId: "run", type: "json", path: `media/${payload.kind}.json`, createdAt: now(), sealedPayload: payload });
  const effect = (override = {}) => store.prepareHostMediaEffect(ticket, { effectId: "effect", ordinal: 0,
    kind: video || protocol.startsWith("comfy") ? "remote_generation_submit" : "image_request", method: "POST",
    routeDigest: "c".repeat(64), wireDigest: "d".repeat(64), preparedAt: now(), ...override });
  const launch = () => { const member = effect(); store.launchHostMediaEffect(ticket, member.effectId, () => {}); return member; };
  const response = (member, override = {}) => seal({ ...base, kind: "media_response_v1", effectId: member.effectId,
    routeDigest: member.routeDigest, wireDigest: member.wireDigest, responseNamespaceDigest: base.namespaceDigest,
    httpStatus: 200, bodySha256: hash("body"), completedAt: now(),
    ...(member.kind === "remote_generation_submit" ? { externalOperationId: "remote" } : {}), ...override });
  const collect = (outcome = "collected", itemsOverride) => {
    const items = [];
    if (outcome === "collected") {
      const bytes = Buffer.from("actual collected bytes"), collectedAt = now(), path = `media_jobs/${created.mediaJob.id}/generation/result.${video ? "mp4" : "png"}`;
      const bytesFact = { schemaVersion: 1, kind: "media_bytes_v1", executionId: base.executionId, mediaJobId: base.mediaJobId,
        path, type: video ? "video" : "image", contentType: video ? "video/mp4" : "image/png", sizeBytes: bytes.length,
        bytesSha256: hash(bytes), remoteDescriptorDigest: hash("descriptor"), collectedAt };
      const artifact = store.createArtifact({ mediaJobId: base.mediaJobId, type: bytesFact.type, path, contentType: bytesFact.contentType,
        sizeBytes: bytes.length, createdAt: collectedAt, sealedPayload: bytesFact });
      items.push({ artifactId: artifact.id, type: artifact.type, path, contentType: artifact.contentType, sizeBytes: bytes.length,
        bytesSha256: bytesFact.bytesSha256, remoteDescriptorDigest: bytesFact.remoteDescriptorDigest, collectedAt });
    }
    const manifest = seal({ ...base, kind: "media_manifest_v1", outcome, items: itemsOverride ?? items, completedAt: now() });
    store.recordHostMediaArtifactManifest(ticket, manifest.id);
    return manifest;
  };
  const finish = (overrides = {}) => {
    if (!store.getWorkUnitAttempt(childFence.attemptId).endedAt) {
      assert.equal(store.transitionWorkUnitAttemptTerminal({ ...childFence, event: "runner_succeeded", attemptStatus: "succeeded",
        runtimeEventType: "work_unit_succeeded", actor: "runner", now: now() }), true);
    }
    const row = store.getHostMediaExecution(ticket.executionId);
    const payload = { ...base, kind: "media_finalization_v1", effects: store.listHostMediaEffects(ticket.executionId).map(effect => ({
      effectId: effect.effectId, ...(effect.responseArtifactId ? { responseArtifactId: effect.responseArtifactId } : {}),
      ...(effect.noStartArtifactId ? { noStartArtifactId: effect.noStartArtifactId } : {}), })),
      ...(row.submissionArtifactId ? { submissionArtifactId: row.submissionArtifactId } : {}),
      ...(row.terminalArtifactId ? { terminalArtifactId: row.terminalArtifactId } : {}), manifestArtifactId: row.manifestArtifactId,
      completedAt: now(), ...overrides };
    const artifact = seal(payload);
    store.finalizeHostMediaExecution(ticket, artifact.id);
    return artifact;
  };
  const bindRemote = (member, observation) => {
    const acknowledged = response(member);
    store.recordHostMediaResponse(ticket, member.effectId, acknowledged.id);
    const submitted = seal({ ...base, kind: "media_submission_v1", effectId: member.effectId,
      responseArtifactId: acknowledged.id, externalOperationId: "remote", statusRouteDigest: "e".repeat(64), completedAt: now() });
    store.recordHostMediaSubmission(ticket, submitted.id);
    const terminal = seal({ ...base, kind: "media_terminal_v1", observation, responseNamespaceDigest: base.namespaceDigest,
      routeDigest: "e".repeat(64), bodySha256: hash("status"), httpStatus: 200, completedAt: now() });
    store.recordHostMediaTerminal(ticket, terminal.id);
    return terminal;
  };
  return { cwd, store, other, parent, transport, source, ticket, created, execution, base, seal, effect, launch, response,
    hash, turn, childFence, collect, finish, bindRemote };
}

test("Media receipt methods are fixed Host APIs; prepared facts cannot settle safe", async t => {
  const f = await fixture(t);
  for (const name of ["recordHostMediaResponse", "recordHostMediaSubmission", "recordHostMediaTerminal",
    "recordHostMediaArtifactManifest", "finalizeHostMediaExecution", "recordHostMediaEffectNoStart"]) {
    assert.equal(typeof f.store[name], "function", name);
  }
  assert.throws(() => f.store.settleHostOperation(f.transport, { kind: "media_response_completed" }));
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});
test("completed response is first-writer-wins, source/namespace/wire exact, and is not yet whole-chain safety", async t => {
  const f = await fixture(t), effect = f.launch(), response = f.response(effect);
  f.store.recordHostMediaResponse(f.ticket, effect.effectId, response.id);
  f.store.recordHostMediaResponse(f.ticket, effect.effectId, response.id);
  assert.throws(() => f.store.recordHostMediaResponse(f.ticket, effect.effectId, f.response(effect).id));
  assert.throws(() => f.store.recordHostMediaResponse({ ...f.ticket }, effect.effectId, response.id));
  assert.equal(f.other.listHostOperationBlockers(f.source).length, 2);
});
test("pending remote URLs and inconsistent raw status cannot be promoted to a Media terminal receipt", async t => {
  const f = await fixture(t, "seedance_task_v1"), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
  const submission = f.seal({ ...f.base, kind: "media_submission_v1", effectId: member.effectId,
    responseArtifactId: response.id, externalOperationId: "remote", statusRouteDigest: "e".repeat(64), completedAt: now() });
  f.store.recordHostMediaSubmission(f.ticket, submission.id);
  for (const observation of [
    { protocol: "seedance_task_v1", externalOperationId: "remote", identitySource: "echoed_id", rawStatus: "pending", outcome: "completed" },
    { protocol: "seedance_task_v1", externalOperationId: "remote", identitySource: "echoed_id", rawStatus: "failed", outcome: "completed" },
    { protocol: "seedance_task_v1", externalOperationId: "foreign", identitySource: "echoed_id", rawStatus: "succeeded", outcome: "completed" },
  ]) {
    const terminal = f.seal({ ...f.base, kind: "media_terminal_v1", observation,
      responseNamespaceDigest: f.base.namespaceDigest, routeDigest: "e".repeat(64), bodySha256: f.hash("status"), httpStatus: 200, completedAt: now() });
    assert.throws(() => f.store.recordHostMediaTerminal(f.ticket, terminal.id));
  }
});

test("legacy terminal accepts only the immutable submission's ordered exact route set", async t => {
  const f = await fixture(t, "comfy_prompt_legacy_v1"), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
  const statusRouteDigests = ["e".repeat(64), "f".repeat(64), "a".repeat(64)];
  const submitted = f.seal({ ...f.base, kind: "media_submission_v1", effectId: member.effectId,
    responseArtifactId: response.id, externalOperationId: "remote", statusRouteDigest: statusRouteDigests[0],
    statusRouteDigests, completedAt: now() });
  f.store.recordHostMediaSubmission(f.ticket, submitted.id);
  const terminal = routeDigest => f.seal({ ...f.base, kind: "media_terminal_v1",
    observation: { protocol: "comfy_prompt_legacy_v1", externalOperationId: "remote", identitySource: "exact_history_key", rawStatus: "success", outcome: "completed" },
    responseNamespaceDigest: f.base.namespaceDigest, routeDigest, bodySha256: hash("actual-status"), httpStatus: 200, completedAt: now() });
  assert.throws(() => f.store.recordHostMediaTerminal(f.ticket, terminal("b".repeat(64)).id));
  const accepted = terminal(statusRouteDigests[1]);
  f.store.recordHostMediaTerminal(f.ticket, accepted.id);
  assert.equal(f.other.getHostMediaExecution(f.ticket.executionId).terminalArtifactId, accepted.id);
  const replacement = f.seal({ ...submitted.sealedPayload, statusRouteDigests: [statusRouteDigests[0], "b".repeat(64), "c".repeat(64)] });
  assert.throws(() => f.store.recordHostMediaSubmission(f.ticket, replacement.id));
  assert.equal(f.other.getHostMediaExecution(f.ticket.executionId).submissionArtifactId, submitted.id);
});

for (const [protocol, routes] of [
  ["seedance_task_v1", ["e".repeat(64), "f".repeat(64), "a".repeat(64)]],
  ["comfy_jobs_v1", ["e".repeat(64), "f".repeat(64), "a".repeat(64)]],
  ["comfy_prompt_legacy_v1", ["e".repeat(64), "e".repeat(64), "a".repeat(64)]],
  ["comfy_prompt_legacy_v1", ["e".repeat(64), "bad", "a".repeat(64)]],
  ["comfy_prompt_legacy_v1", ["f".repeat(64), "e".repeat(64), "a".repeat(64)]],
  ["comfy_prompt_legacy_v1", ["e".repeat(64), "f".repeat(64)]],
]) test(`submission rejects invalid route strategy ${protocol}/${routes.join("-").slice(0, 90)}`, async t => {
  const f = await fixture(t, protocol), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
  const submission = f.seal({ ...f.base, kind: "media_submission_v1", effectId: member.effectId,
    responseArtifactId: response.id, externalOperationId: "remote", statusRouteDigest: "e".repeat(64),
    statusRouteDigests: routes, completedAt: now() });
  assert.throws(() => f.store.recordHostMediaSubmission(f.ticket, submission.id));
  assert.equal(f.other.getHostMediaExecution(f.ticket.executionId).submissionArtifactId, undefined);
});
test("an entered send whose COMMIT fails can never mint per-effect no-start", async t => {
  const f = await fixture(t), member = f.effect(), exec = f.store.database.exec.bind(f.store.database);
  assert.equal(typeof f.store.recordHostMediaEffectNoStart, "function");
  f.store.database.exec = sql => { if (sql === "COMMIT") throw new Error("injected_commit_failure"); return exec(sql); };
  let sends = 0;
  assert.throws(() => f.store.launchHostMediaEffect(f.ticket, member.effectId, () => { sends++; }));
  f.store.database.exec = exec;
  assert.equal(sends, 1);
  assert.equal(f.store.listHostMediaEffects(f.ticket.executionId)[0].launchedAt, undefined);
  assert.throws(() => f.store.recordHostMediaEffectNoStart(f.ticket, member.effectId));
});

test("exact synchronous image response/bytes/manifest/finalization settles both scopes and survives reopen", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
  f.collect();
  assert.throws(() => f.store.settleHostOperation(f.transport, { kind: "media_response_completed" }));
  f.finish();
  assert.throws(() => f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" }));
  const transport = f.store.settleHostOperation(f.transport, { kind: "media_response_completed" });
  const parent = f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  assert.equal(parent.phase, "safe"); assert.equal(transport.phase, "safe");
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
  assert.equal(assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()).get("media-call"), "image_generate");
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(reopened.getHostOperation("parent"), parent);
    assert.throws(() => reopened.recordHostMediaResponse(f.ticket, member.effectId, response.id));
  } finally { reopened.close(); }
});
for (const [protocol, rawStatus, outcome, identitySource] of [
  ["seedance_task_v1", "succeeded", "completed", "exact_status_route"], ["seedance_task_v1", "failed", "failed", "echoed_id"],
  ["comfy_jobs_v1", "completed", "completed", "echoed_id"], ["comfy_jobs_v1", "failed", "failed", "echoed_id"],
  ["comfy_jobs_v1", "cancelled", "cancelled", "echoed_id"], ["comfy_prompt_legacy_v1", "success", "completed", "exact_history_key"],
  ["comfy_prompt_legacy_v1", "error", "failed", "exact_history_key"],
]) test(`exact ${protocol}/${rawStatus} receipt settles without inferring status from artifacts`, async t => {
  const f = await fixture(t, protocol), member = f.launch();
  f.bindRemote(member, { protocol, externalOperationId: "remote", identitySource, rawStatus, outcome });
  f.collect(outcome === "completed" ? "collected" : outcome === "failed" ? "remote_failed" : "remote_cancelled");
  f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_remote_terminal" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
});
for (const field of ["executionId", "executionIdentityDigest", "mediaJobId", "executionGenerationId", "source", "childFence",
  "namespaceDigest", "protocol", "effectId", "routeDigest", "wireDigest", "responseNamespaceDigest", "bodySha256", "httpStatus", "completedAt"]) {
  test(`response ${field} substitution is rejected without binding`, async t => {
    const f = await fixture(t), member = f.launch();
    const overrides = { [field]: field === "source" || field === "childFence" ? {} : field === "httpStatus" ? 302 : "foreign" };
    assert.throws(() => f.store.recordHostMediaResponse(f.ticket, member.effectId, f.response(member, overrides).id));
    assert.equal(f.other.listHostMediaEffects(f.ticket.executionId)[0].responseArtifactId, undefined);
  });
}
test("planned per-effect no-start requires the original unentered ticket and forbids a later send", async t => {
  const f = await fixture(t), member = f.effect();
  const seal = f.seal({ ...f.base, kind: "media_effect_no_start_v1", effectId: member.effectId, completedAt: now() });
  assert.throws(() => f.other.recordHostMediaEffectNoStart(f.ticket, member.effectId, seal.id));
  f.store.recordHostMediaEffectNoStart(f.ticket, member.effectId, seal.id);
  let sends = 0;
  assert.throws(() => f.store.launchHostMediaEffect(f.ticket, member.effectId, () => { sends++; }));
  assert.equal(sends, 0);
  f.collect("collection_failed"); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "known_no_start" });
  f.store.settleHostOperation(f.parent, { kind: "known_no_start" });
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
});
test("an exact remote terminal with unavailable output may settle collection failure, not successful artifacts", async t => {
  const f = await fixture(t, "seedance_task_v1"), member = f.launch();
  f.bindRemote(member, { protocol: "seedance_task_v1", externalOperationId: "remote", identitySource: "echoed_id", rawStatus: "succeeded", outcome: "completed" });
  f.collect("collection_failed"); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_remote_terminal" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  assert.deepEqual(f.other.listHostOperationBlockers(f.source), []);
});

for (const field of ["bytesSha256", "remoteDescriptorDigest", "path", "contentType", "sizeBytes", "collectedAt", "artifactId", "type"]) {
  test(`manifest ${field} substitution is rejected and leaves no binding`, async t => {
    const f = await fixture(t), member = f.launch(), response = f.response(member);
    f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
    const manifest = f.collect(), payload = structuredClone(manifest.sealedPayload);
    const original = f.store.database.prepare("SELECT manifest_artifact_id FROM host_media_executions WHERE execution_id=?").get(f.ticket.executionId);
    // Test the verifier independently, not the immutable-ref conflict guard.
    payload.items[0][field] = field === "sizeBytes" ? 999 : "foreign";
    const tampered = f.seal(payload);
    const verifier = await import("../dist/storage/sqlite/host-media-receipt-evidence.js");
    assert.throws(() => verifier.validateHostMediaManifest(f.store.database, f.store.getHostMediaExecution(f.ticket.executionId),
      f.store.listHostMediaEffects(f.ticket.executionId), tampered.id));
    assert.deepEqual(f.store.database.prepare("SELECT manifest_artifact_id FROM host_media_executions WHERE execution_id=?").get(f.ticket.executionId), original);
  });
}
test("safe reopen independently rejects a corrupted JSON seal and corrupted media bytes provenance", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id);
  const manifest = f.collect(); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_response_completed" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  const artifactId = manifest.sealedPayload.items[0].artifactId;
  f.store.database.prepare("UPDATE artifacts SET size_bytes=size_bytes+1 WHERE id=?").run(artifactId);
  assert.throws(() => f.other.getHostOperation("parent"));
  assert.throws(() => assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()));
  f.store.database.prepare("UPDATE artifacts SET size_bytes=size_bytes-1 WHERE id=?").run(artifactId);
  f.store.database.prepare("UPDATE artifacts SET content_sha256=? WHERE id=?").run("0".repeat(64), response.id);
  assert.throws(() => f.other.getHostOperation("transport"));
});
test("missing effect/member or local finalization never becomes parent safe", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id); f.collect();
  assert.throws(() => f.store.settleHostOperation(f.transport, { kind: "media_response_completed" }));
  assert.throws(() => f.finish({ effects: [] }));
  assert.equal(f.other.getHostMediaExecution(f.ticket.executionId).finalizationArtifactId, undefined);
  f.finish();
  assert.throws(() => f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" }));
  assert.equal(f.other.getHostOperation("parent").phase, "launched");
});
test("all Comfy upload effects need separate responses; a final submit receipt cannot hide a missing upload", async t => {
  const f = await fixture(t, "comfy_jobs_v1");
  const upload = f.effect({ effectId: "upload", kind: "comfy_image_upload" });
  f.store.launchHostMediaEffect(f.ticket, upload.effectId, () => {});
  const submitted = f.effect({ effectId: "submit", ordinal: 1, kind: "remote_generation_submit" });
  f.store.launchHostMediaEffect(f.ticket, submitted.effectId, () => {});
  f.bindRemote(submitted, { protocol: "comfy_jobs_v1", externalOperationId: "remote", identitySource: "echoed_id", rawStatus: "completed", outcome: "completed" });
  f.collect();
  assert.throws(() => f.finish());
  assert.equal(f.other.getHostMediaExecution(f.ticket.executionId).finalizationArtifactId, undefined);
  f.store.recordHostMediaResponse(f.ticket, upload.effectId, f.response(upload).id);
  f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_remote_terminal" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
});
test("source replacement rejects receipt writes even for an exact acknowledged response", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.createWorkUnitAttempt({ workUnitId: f.source.workUnitId, attemptNumber: 2, runtimeInstanceId: "replacement",
    runnerId: "pi", status: "started", now: now() });
  assert.throws(() => f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id), error => error.code === "host_operation_stale_owner");
  assert.equal(f.other.listHostMediaEffects(f.ticket.executionId)[0].responseArtifactId, undefined);
});
test("required-input closes new sends but exact entered response and finalization can still drain", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.createUserInputRequest({ sourceRunId: "run", sourceItemId: f.turn.item.id, sourceFence: f.source,
    toolCallId: "ask", idempotencyKey: "ask", toolInput: { schemaVersion: 1, waitMode: "required",
      questions: [{ questionId: "choice", prompt: "Choose", required: true, allowFreeText: true, options: [] }] } }, now());
  assert.throws(() => f.store.prepareHostMediaEffect(f.ticket, { effectId: "late", ordinal: 1, kind: "image_request", method: "POST",
    routeDigest: "c".repeat(64), wireDigest: "d".repeat(64), preparedAt: now() }));
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id); f.collect(); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_response_completed" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  assert.equal(assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()).get("media-call"), "image_generate");
});
test("durable Media veto covers each exact source-owned child without blocking an unrelated sibling", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id); f.collect(); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_response_completed" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  f.store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "media_job", ownerType: "conversation_run", ownerId: "unrelated-run",
    idempotencyKey: "unrelated", status: "succeeded", createdByActor: "system", request: {}, now: now() });
  assert.equal(assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()).get("media-call"), "image_generate");
  f.store.createOrReuseConversationMediaJob({ runId: "run", toolCallId: "missing", target: { kind: "normal", conversationId: "conversation" },
    idempotencyKey: "missing", mediaJob: { providerPresetId: "image", operation: "image_generate", prompt: "Missing receipt" },
    executionAdmission: { schemaVersion: 1, source: f.source, requestDigest: "a".repeat(64) } }, now());
  assert.throws(() => assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()));
});
test("persisted unknown cannot be upgraded by later complete receipt facts", async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id); f.collect(); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "unknown_outcome", code: "lost_response" });
  assert.throws(() => f.store.settleHostOperation(f.transport, { kind: "media_response_completed" }));
  assert.throws(() => f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" }));
  assert.equal(f.other.getHostOperation("transport").phase, "unknown_outcome");
});
for (const status of ["created", "started"]) test(`old historical receipt cannot cover a newer child Attempt/${status}`, async t => {
  const f = await fixture(t), member = f.launch(), response = f.response(member);
  f.store.recordHostMediaResponse(f.ticket, member.effectId, response.id); f.collect(); f.finish();
  f.store.settleHostOperation(f.transport, { kind: "media_response_completed" });
  f.store.settleHostOperation(f.parent, { kind: "media_chain_completed" });
  assert.equal(assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()).get("media-call"), "image_generate");
  f.store.createWorkUnitAttempt({ workUnitId: f.created.workUnit.id, attemptNumber: 2,
    runtimeInstanceId: "replacement-media-runtime", runnerId: "media", status, now: now() });
  assert.equal(f.other.getHostOperation("parent").phase, "safe"); // Historical facts remain intact.
  assert.throws(() => assertUserInputDurableQuiescence(f.store.database, "run", f.source, Date.now()), error => error.code === "not_quiescent");
});
