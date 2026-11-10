import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, digestHarnessToolValue } = await import(process.env.LING_CORE_MEDIA_SUBMISSION_MODULE
  ? pathToFileURL(process.env.LING_CORE_MEDIA_SUBMISSION_MODULE).href : new URL("../dist/index.js", import.meta.url).href);
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const projection = () => ({ recovery: { statusEndpoint: "https://example.invalid/task/remote", requestSummary: { model: "fixture" } },
  nextPollAt: new Date(Date.now() + 2000).toISOString(), pollAttempts: 0 });

async function fixture(t, protocol = "seedance_task_v1") {
  const cwd = await mkdtemp(join(tmpdir(), "ling-media-submission-handle-"));
  const store = createSqliteRunStore(cwd), other = createSqliteRunStore(cwd);
  t.after(async () => { other.close(); store.close(); await rm(cwd, { recursive: true, force: true }); });
  const at = now();
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: "run",
    idempotencyKey: "unit", status: "running", createdByActor: "system", request: {}, now: at });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "parent-runtime", runnerId: "pi", status: "started", now: at });
  const source = { runId: "run", ...toRuntimeAttemptFence(attempt) };
  const thread = store.createLingThread({ kind: "conversation", title: "Atomic submission", objective: "No duplicate send" }, at);
  const turn = store.appendConversationUserTurn({ threadId: thread.id, title: "Generate", userInstruction: "Generate",
    idempotencyKey: "turn", payload: { body: "Generate", format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] } }, at);
  store.createRun({ id: "run", cwd, workUnitId: unit.id, threadId: thread.id, turnId: turn.turnId,
    taskId: "task", providerName: "test", providerModel: "test", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: at });
  store.linkRunToWorkUnit("run", unit.id, at); store.markRunStarted("run", at);
  const parent = store.admitHostOperation({ operationId: "parent", source, kind: "media", toolCallId: "media-call" });
  const transport = store.admitHostOperation({ operationId: "transport", source, kind: "media", toolCallId: "media-call",
    parentOperationId: "parent", producerId: "media-http-chain" });
  const intentDigest = "a".repeat(64), target = { kind: "normal", conversationId: "conversation" };
  const created = store.createOrReuseConversationMediaJob({ runId: "run", toolCallId: "media-call", target,
    idempotencyKey: "job", mediaJob: { providerPresetId: "video", operation: "video_generate", prompt: "Test" },
    executionAdmission: { schemaVersion: 1, source, requestDigest: intentDigest } }, now());
  const prepared = { schemaVersion: 1, executionId: "execution", mediaJobId: created.mediaJob.id,
    mediaChildWorkUnitId: created.workUnit.id, executionGenerationId: "generation", source, toolCallId: "media-call", protocol,
    adapterId: protocol === "seedance_task_v1" ? "seedance" : "comfyui", toolName: "video_generate", operation: "video_generate",
    intentDigest, targetDigest: digestHarnessToolValue(target), namespaceDigest: "b".repeat(64) };
  const seal = payload => store.createArtifact({ runId: "run", type: "json", path: `media/${payload.kind ?? "prepared"}.json`, createdAt: now(), sealedPayload: payload });
  const sealed = seal(prepared), { schemaVersion: _s, source: _source, toolCallId: _call, ...input } = prepared;
  const ticket = store.prepareHostMediaExecution(parent, transport, { ...input, preparedRequestArtifactId: sealed.id,
    preparedRequestDigest: sealed.contentSha256, preparedAt: now() });
  const child = store.createWorkUnitAttempt({ workUnitId: created.workUnit.id, attemptNumber: 1,
    runtimeInstanceId: "child-runtime", runnerId: "media", status: "started", now: now() });
  const childFence = toRuntimeAttemptFence(child);
  store.transitionWorkUnitStatus({ ...childFence, event: "claim", actor: "system", now: now() });
  store.transitionWorkUnitStatus({ ...childFence, event: "runner_started", actor: "runner", now: now() });
  store.bindHostMediaChildExecution(ticket, childFence);
  const execution = store.getHostMediaExecution(ticket.executionId);
  const base = { schemaVersion: 1, executionId: execution.executionId, executionIdentityDigest: execution.identityDigest,
    mediaJobId: execution.mediaJobId, executionGenerationId: execution.executionGenerationId, source, childFence,
    namespaceDigest: execution.namespaceDigest, protocol };
  const effect = store.prepareHostMediaEffect(ticket, { effectId: "submit", ordinal: 0, kind: "remote_generation_submit", method: "POST",
    routeDigest: "c".repeat(64), wireDigest: "d".repeat(64), preparedAt: now() });
  let sends = 0; store.launchHostMediaEffect(ticket, effect.effectId, () => { sends++; });
  const response = seal({ ...base, kind: "media_response_v1", effectId: effect.effectId, routeDigest: effect.routeDigest,
    wireDigest: effect.wireDigest, responseNamespaceDigest: execution.namespaceDigest, httpStatus: 200,
    bodySha256: hash("real remote response"), externalOperationId: "remote", completedAt: now() });
  store.recordHostMediaResponse(ticket, effect.effectId, response.id);
  const submissionPayload = { ...base, kind: "media_submission_v1", effectId: effect.effectId, responseArtifactId: response.id,
    externalOperationId: "remote", statusRouteDigest: "e".repeat(64), completedAt: now() };
  const submission = seal(submissionPayload);
  const pending = override => store.upsertMediaJobExecutionHandle({ mediaJobId: created.mediaJob.id, adapterKind: execution.adapterId,
    externalOperationId: `ling-pending:${created.mediaJob.id}`, recovery: { phase: "waiting_for_submission" },
    workUnitId: childFence.workUnitId, attemptId: childFence.attemptId, nextPollAt: now(), pollAttempts: 0, ...override }, now());
  const record = p => store.recordHostMediaSubmissionAndExecutionHandle(ticket, submission.id, p ?? projection());
  return { cwd, store, other, unit, source, ticket, created, execution, childFence, response, submission, submissionPayload,
    seal, pending, record, get sends() { return sends; } };
}

test("atomic submission handle derives every identity from the receipt and bound child, not projection", async t => {
  const f = await fixture(t), p = projection();
  const row = f.record(p), handle = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id);
  assert.equal(row.submissionArtifactId, f.submission.id);
  assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, f.submission.id);
  assert.equal(handle.mediaJobId, f.execution.mediaJobId); assert.equal(handle.adapterKind, f.execution.adapterId);
  assert.equal(handle.externalOperationId, "remote"); assert.equal(handle.workUnitId, f.childFence.workUnitId);
  assert.equal(handle.attemptId, f.childFence.attemptId); assert.deepEqual(handle.recovery, p.recovery);
  assert.equal(handle.nextPollAt, p.nextPollAt); assert.equal(handle.pollAttempts, 0); assert.equal(f.sends, 1);
  assert.equal(f.other.getHostOperation("transport").phase, "launched", "projection alone cannot establish safe completion");
});

test("exact bound pending placeholder upgrades atomically without preserving the pending external ID", async t => {
  const f = await fixture(t), old = f.pending(), p = projection(); f.record(p);
  const handle = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id);
  assert.equal(handle.externalOperationId, "remote"); assert.equal(handle.createdAt, old.createdAt);
  assert.deepEqual(handle.recovery, p.recovery); assert.equal(handle.attemptId, f.childFence.attemptId);
});

test("real handle insert failure rolls back submission binding in the same writer transaction", async t => {
  const f = await fixture(t);
  f.store.database.exec("CREATE TRIGGER fail_media_handle BEFORE INSERT ON media_job_execution_handles BEGIN SELECT RAISE(ABORT,'projection insert failure'); END");
  assert.throws(() => f.record(), /projection insert failure/);
  assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
  assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), undefined);
  f.store.database.exec("DROP TRIGGER fail_media_handle"); f.record(); assert.equal(f.sends, 1);
});

test("pre-COMMIT failure rolls back both pending upgrade and submission ref without another send", async t => {
  const f = await fixture(t), old = f.pending(), exec = f.store.database.exec.bind(f.store.database); let fail = true;
  f.store.database.exec = sql => { if (sql === "COMMIT" && fail) { fail = false; throw new Error("precommit failure"); } return exec(sql); };
  assert.throws(() => f.record(), /precommit failure/);
  assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
  assert.deepEqual(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), old);
  f.record(); assert.equal(f.sends, 1);
});

test("post-COMMIT exception retry is exact idempotent projection, not a second POST", async t => {
  const f = await fixture(t), p = projection(), exec = f.store.database.exec.bind(f.store.database); let fail = true;
  f.store.database.exec = sql => { const result = exec(sql); if (sql === "COMMIT" && fail) { fail = false; throw new Error("postcommit failure"); } return result; };
  assert.throws(() => f.record(p), /postcommit failure/);
  const before = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), row = f.other.getHostMediaExecution("execution");
  assert.equal(row.submissionArtifactId, f.submission.id); assert.equal(before.externalOperationId, "remote");
  assert.deepEqual(f.record(p), row); assert.deepEqual(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), before);
  assert.throws(() => f.store.launchHostMediaEffect(f.ticket, "submit", () => assert.fail("duplicate POST")));
  assert.equal(f.sends, 1);
});

test("same sealed receipt can rebuild a missing projection without altering the durable receipt", async t => {
  const f = await fixture(t), p = projection(); const row = f.record(p);
  f.store.deleteMediaJobExecutionHandle(f.created.mediaJob.id);
  assert.deepEqual(f.record(p), row); assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id).externalOperationId, "remote");
  assert.equal(f.sends, 1);
});

test("an already recorded submission from the unchanged fixed API can receive only its exact missing handle", async t => {
  const f = await fixture(t), row = f.store.recordHostMediaSubmission(f.ticket, f.submission.id);
  assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), undefined);
  assert.deepEqual(f.record(), row);
  assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id).externalOperationId, "remote");
});

test("projection snapshot redacts persisted recovery consistently and unspecified polling preserves exact retry", async t => {
  const f = await fixture(t), p = { recovery: { apiKey: "not-a-real-secret", nested: { value: [1, null, true, "text"] } } };
  f.record(p); const before = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id);
  assert.equal(before.recovery.apiKey, "[REDACTED]"); assert.equal(before.nextPollAt, undefined); assert.equal(before.pollAttempts, 0);
  f.record(p); assert.deepEqual(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), before);
});

test("the fixed API does not adopt a caller-owned transaction or commit its unrelated writes", async t => {
  const f = await fixture(t);
  f.store.database.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => f.record(), /cannot start a transaction within a transaction/);
    assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
    assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), undefined);
  } finally { f.store.database.exec("ROLLBACK"); }
});

for (const [name, change] of [
  ["external ID", f => ({ externalOperationId: "foreign" })],
  ["adapter", f => ({ adapterKind: "foreign" })],
  ["work unit", f => ({ workUnitId: f.unit.id })],
  ["attempt", f => ({ attemptId: f.source.attemptId })],
  ["unbound pending", f => ({ workUnitId: null, attemptId: null })],
  ["nonexact pending", f => ({ externalOperationId: "ling-pending:foreign" })],
]) test(`submission projection never overwrites existing ${name} mismatch`, async t => {
  const f = await fixture(t), before = f.pending(change(f));
  assert.throws(() => f.record());
  assert.deepEqual(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), before);
  assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
});

test("an exact receipt retry rejects different recovery or polling state rather than overwrite progress", async t => {
  const f = await fixture(t), p = projection(); f.record(p);
  const before = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id);
  for (const altered of [{ ...p, recovery: { replacement: true } }, { ...p, nextPollAt: null }, { ...p, pollAttempts: 1 }]) {
    assert.throws(() => f.record(altered)); assert.deepEqual(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), before);
  }
});

test("foreign sealed submission or response rejects before binding or projecting", async t => {
  const f = await fixture(t);
  for (const override of [{ mediaJobId: "foreign" }, { executionGenerationId: "foreign" }, { externalOperationId: "foreign" },
    { childFence: f.source }, { responseArtifactId: "foreign-response" }]) {
    const foreign = f.seal({ ...f.submissionPayload, ...override });
    assert.throws(() => f.store.recordHostMediaSubmissionAndExecutionHandle(f.ticket, foreign.id, projection()));
    assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
    assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), undefined);
  }
});

test("source replacement and child replacement cannot project old submission into a successor", async t => {
  for (const replaceParent of [true, false]) {
    const f = await fixture(t);
    f.store.createWorkUnitAttempt({ workUnitId: replaceParent ? f.unit.id : f.created.workUnit.id, attemptNumber: 2,
      runtimeInstanceId: "replacement", runnerId: replaceParent ? "pi" : "media", status: "started", now: now() });
    assert.throws(() => f.record());
    assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
    assert.equal(f.other.getMediaJobExecutionHandle(f.created.mediaJob.id), undefined);
  }
});

test("reopened store, cloned ticket and caller ID cannot gain projection authority", async t => {
  const f = await fixture(t), reopened = createSqliteRunStore(f.cwd);
  try {
    for (const [writer, ticket] of [[f.store, { ...f.ticket }], [f.other, f.ticket], [reopened, f.ticket], [reopened, { executionId: "execution" }]]) {
      assert.throws(() => writer.recordHostMediaSubmissionAndExecutionHandle(ticket, f.submission.id, projection()));
    }
    assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
  } finally { reopened.close(); }
});

for (const key of ["externalOperationId", "adapterKind", "mediaJobId", "source", "childFence", "safe", "verify", "callback"]) {
  test(`projection refuses caller authority field ${key} even when its value appears consistent`, async t => {
    const f = await fixture(t);
    assert.throws(() => f.record({ ...projection(), [key]: key === "callback" ? () => {} : "untrusted" }));
    assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
  });
}

test("projection snapshot rejects callbacks, getters, non-JSON and invalid polling values before transaction", async t => {
  const f = await fixture(t), cyclic = {}; cyclic.self = cyclic;
  let callbacks = 0; const getter = {}; Object.defineProperty(getter, "value", { enumerable: true, get() { callbacks++; return "unsafe"; } });
  for (const bad of [{ recovery: { fn() { callbacks++; } } }, { recovery: getter }, { recovery: cyclic },
    { recovery: new Date() }, { recovery: { number: Infinity } }, { recovery: {}, pollAttempts: -1 },
    { recovery: {}, pollAttempts: 1.5 }, { recovery: {}, nextPollAt: "not-a-date" }]) {
    assert.throws(() => f.record(bad)); assert.equal(f.other.getHostMediaExecution("execution").submissionArtifactId, undefined);
  }
  assert.equal(callbacks, 0);
});

test("Comfy jobs and legacy protocols use the same fixed identity-derived atomic handle projection", async t => {
  for (const protocol of ["comfy_jobs_v1", "comfy_prompt_legacy_v1"]) {
    const f = await fixture(t, protocol); f.record({ recovery: { statusNamespace: protocol } });
    const handle = f.other.getMediaJobExecutionHandle(f.created.mediaJob.id);
    assert.equal(handle.adapterKind, "comfyui"); assert.equal(handle.externalOperationId, "remote");
    assert.equal(handle.attemptId, f.childFence.attemptId); assert.equal(handle.pollAttempts, 0);
  }
});
