import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, toRuntimeAttemptFence, nativeArtifactIdentity } from "../dist/index.js";

const now = "2026-09-08T12:00:00.000Z";
const selection = { engineId: "codex-app-server", profileId: "profile_codex", profileRevision: 1,
  profileFingerprint: "a".repeat(64), modelId: "test-model", configurationFingerprint: "b".repeat(64) };

async function fixture(t, engineId = selection.engineId) {
  const selected = { ...selection, engineId };
  const cwd = await mkdtemp(join(tmpdir(), "ling-native-journal-"));
  const stores = [];
  const open = () => { const store = createSqliteRunStore(cwd); stores.push(store); return store; };
  t.after(async () => { for (const store of stores) store.close(); await rm(cwd, { recursive: true, force: true }); });
  const store = open();
  const channel = store.createChannel({ name: "Native tests", boundPath: cwd }, now);
  const task = store.createTask({ channelId: channel.id, title: "Native test", prompt: "Test" }, now);
  const thread = store.createLingThread({ kind: "conversation", title: "Native test", objective: "Test" }, now);
  let count = 0;
  const run = (options = {}) => {
    const id = `run_native_${++count}`;
    const created = store.createRun({ id, cwd: options.cwd ?? cwd, taskId: task.id, channelId: channel.id,
      threadId: options.threadId ?? thread.id, teammateId: options.teammateId,
      providerName: "native", providerModel: selection.modelId, taskSnapshot: task,
      providerSnapshot: {}, requestSnapshot: { executionBinding: options.binding ?? {
        kind: "native_profile", engineId: selected.engineId, profileId: selected.profileId,
        profileRevision: selected.profileRevision, nativeModelId: selected.modelId,
      } }, createdAt: now });
    const work = store.createWorkUnit({ id: `wu_${id}`, workspaceId: DEFAULT_WORKSPACE_ID, kind: "conversation_run",
      ownerType: "run", ownerId: id, idempotencyKey: id, createdByActor: "user", request: {},
      linkedRunId: id, runnerId: selected.engineId, now });
    const attempt = store.createWorkUnitAttempt({ workUnitId: work.id, attemptNumber: 1,
      runtimeInstanceId: "runtime_native", runnerId: selected.engineId, now });
    store.linkRunToWorkUnit(id, work.id, now);
    return { run: created, fence: toRuntimeAttemptFence(attempt), generation: 1, runId: id, selection: { ...selected } };
  };
  const reserve = (input = run()) => {
    const entry = store.reserveNativeExecution(input, now);
    if (engineId === "openclaw-acp") store.prepareNativeOpenClawSession({ submissionId: entry.submission.id, fence: input.fence, agentId: "fixture" }, now);
    return { ...entry, binding: store.getNativeExecutionBinding(entry.binding.id), input };
  };
  const accepted = () => {
    const entry = reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence };
    store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-thread" }, now);
    store.beginNativeSubmission(key, now);
    store.acceptNativeSubmission({ ...key, nativeTurnId: "native-turn" }, now);
    return { ...entry, key };
  };
  return { cwd, store, open, run, reserve, accepted, thread };
}

const outputInput = (entry, events, firstSequence = 1, terminal) => ({ ...entry.key,
  nativeSessionId: "native-thread", nativeTurnId: "native-turn", events, firstSequence,
  ...(terminal ? { terminal } : {}),
});
const textOutput = text => ({ type: "assistant_text_delta", data: { text } });

test("native completion cannot claim Pi no-tools coverage from a boolean", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => true);
  assert.ok(fact.drainedAt);
  assert.equal(fact.effectCoverage, undefined);
  assert.equal(f.open().getHostAttemptCompletion(source).effectCoverage, undefined);
});

test("closed native no-tools coverage is independently verified and survives reopen", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Completed without tools")], 1, "completed"), now);
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  assert.equal(fact.effectCoverage, "native_journal_v1");
  assert.equal(f.open().getHostAttemptCompletion(source).effectCoverage, "native_journal_v1");
});

test("terminal native Run cannot release resources while its submission is unknown", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const lease = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "task",
    resourceKey: entry.input.runId, ownerType: "work_unit_attempt", ownerId: source.attemptId,
    ...source, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  assert.ok(lease);
  f.store.markNativeSubmissionUnknown(entry.key, now);
  await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  f.store.markRunStarted(entry.input.runId, now);
  f.store.markRunFailed(entry.input.runId, now, "transport_lost");
  const reader = f.open();
  reader.releaseHostAttemptResources(source, now);
  assert.equal(reader.expireResourceLeases("2099-01-02T00:00:00.000Z"), 0);
  assert.equal(reader.listResourceLeases({ status: "active", workUnitId: source.workUnitId }).length, 1);
  assert.equal(reader.getHostAttemptCompletion(source).nativeEffectStatus, "unknown");
});

for (const variant of ["omitted", "forged", "duplicate", "extra-field"]) test(`native completion rejects ${variant} submission inventory`, async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Done")], 1, "completed"), now);
  const inventory = { schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id] };
  if (variant === "omitted") inventory.submissionIds = [];
  if (variant === "forged") inventory.submissionIds = ["invented-submission"];
  if (variant === "duplicate") inventory.submissionIds.push(entry.submission.id);
  if (variant === "extra-field") inventory.settled = true;
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => inventory);
  assert.equal(fact.effectCoverage, undefined);
  assert.equal(f.open().getHostAttemptCompletion(source).nativeEffectStatus, "unverified");
});

for (const hasSubmission of [false, true]) test(`native completion cannot omit untagged tool events (submission=${hasSubmission})`, async t => {
  const f = await fixture(t);
  const entry = hasSubmission ? f.accepted() : { input: f.run() };
  if (hasSubmission) f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Done")], 1, "completed"), now);
  f.store.appendEvent(entry.input.runId, "tool_start", { toolCallId: "untracked", toolName: "bash" });
  f.store.appendEvent(entry.input.runId, "tool_end", { toolCallId: "untracked", toolName: "bash", isError: false });
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: hasSubmission ? [entry.submission.id] : [],
  }));
  assert.equal(fact.effectCoverage, undefined);
  assert.equal(f.open().getHostAttemptCompletion(source).nativeEffectStatus, "unverified");
});

for (const toolName of ["read", "bash", "unknown-effect"]) test(`native ${toolName} completion checks original tool coverage`, async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.appendNativeRunEvents(outputInput(entry, [
    { type: "tool_start", data: { toolCallId: "tool", toolName } },
    { type: "tool_end", data: { toolCallId: "tool", toolName, isError: false } },
  ], 1), now);
  f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Done")], 3, "completed"), now);
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  assert.equal(fact.nativeEffectStatus, toolName === "read" ? "settled" : "unknown");
  assert.equal(fact.effectCoverage, toolName === "read" ? "native_journal_v1" : undefined);
});

for (const variant of ["orphan", "name-change", "after-end"]) test(`native completion rejects ${variant} tool updates`, async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const start = { type: "tool_start", data: { toolCallId: "tool", toolName: "read" } };
  const end = { type: "tool_end", data: { toolCallId: "tool", toolName: "read", isError: false } };
  const update = { type: "tool_update", data: { toolCallId: "tool", toolName: "bash", phase: "running" } };
  const events = variant === "orphan" ? [update] : variant === "name-change" ? [start, update, end] : [start, end, update];
  f.store.appendNativeRunEvents(outputInput(entry, events), now);
  f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Done")], events.length + 1, "completed"), now);
  const fact = await f.store.trackHostAttemptCompletion({ runId: entry.input.runId, ...entry.input.fence }, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  assert.equal(fact.effectCoverage, undefined);
  assert.equal(fact.nativeEffectStatus, "unverified");
});

test("completion revalidates newly observed native effects after reopen", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.appendNativeRunEvents(outputInput(entry, [textOutput("Done")], 1, "completed"), now);
  const source = { runId: entry.input.runId, ...entry.input.fence };
  const fact = await f.store.trackHostAttemptCompletion(source, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  assert.equal(fact.effectCoverage, "native_journal_v1");
  const lease = f.store.acquireResourceLease({ workspaceId: DEFAULT_WORKSPACE_ID, resourceType: "task",
    resourceKey: entry.input.runId, ownerType: "work_unit_attempt", ownerId: source.attemptId,
    ...source, acquiredAt: now, expiresAt: "2099-01-01T00:00:00.000Z" });
  f.store.markRunStarted(source.runId, now);
  f.store.markRunFailed(source.runId, now, "fixture terminal");
  f.store.appendEvent(source.runId, "tool_start", { toolCallId: "late", toolName: "bash" });
  const reopened = f.open();
  assert.equal(reopened.getHostAttemptCompletion(source).effectCoverage, undefined);
  reopened.releaseHostAttemptResources(source, now);
  assert.equal(reopened.listResourceLeases({ status: "active", workUnitId: source.workUnitId })[0].id, lease.id);
});

test("native completion verifies submission selection against the durable Run binding", async t => {
  const f = await fixture(t);
  const input = f.run({ binding: { kind: "native_profile", engineId: selection.engineId,
    profileId: "another-profile", profileRevision: selection.profileRevision, nativeModelId: selection.modelId } });
  const entry = f.reserve(input);
  const key = { submissionId: entry.submission.id, fence: input.fence };
  f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-thread" }, now);
  f.store.beginNativeSubmission(key, now);
  f.store.acceptNativeSubmission({ ...key, nativeTurnId: "native-turn" }, now);
  f.store.appendNativeRunEvents(outputInput({ ...entry, key }, [textOutput("Done")], 1, "completed"), now);
  const fact = await f.store.trackHostAttemptCompletion({ runId: input.runId, ...input.fence }, Promise.resolve(), () => ({
    schemaVersion: 1, kind: "native_journal_v1", submissionIds: [entry.submission.id],
  }));
  assert.equal(fact.effectCoverage, undefined);
  assert.equal(fact.nativeEffectStatus, "unverified");
});

for (const engineId of ["kimi-acp", "openclaw-acp"]) {
  test(`${engineId} persists its real prompt request without inventing a native turn`, async t => {
    const f = await fixture(t, engineId);
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence };
    const correlation = { nativePromptRequestId: 0 };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
    const pending = f.store.beginNativeSubmission({ ...key, ...correlation }, now);
    assert.equal(pending.nativePromptRequestId, 0);
    assert.equal(pending.nativeTurnId, undefined);
    assert.equal(pending.status, "submission_pending");
    assert.deepEqual(f.open().getNativeSubmission(entry.submission.id), pending);
    const output = { ...key, ...correlation, nativeSessionId: "acp-session", firstSequence: 1,
      events: [textOutput("ACP output")] };
    assert.throws(() => f.store.appendNativeRunEvents(output, now), { code: "native_submission_conflict" });
    const accepted = f.store.acceptNativeSubmission({ ...key, ...correlation }, now);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.nativeTurnId, undefined);
    assert.deepEqual(f.open().acceptNativeSubmission({ ...key, ...correlation }, now), accepted);
    const saved = f.store.appendNativeRunEvents({ ...output, terminal: "completed" }, now);
    assert.equal(saved.events[0].data.text, "ACP output");
    assert.deepEqual(f.open().appendNativeRunEvents({ ...output, terminal: "completed" }, now), { ...saved, created: false });
    assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "completed");
  });

  test(`${engineId} rejects invalid or mixed correlation before consuming its send permit`, async t => {
    const f = await fixture(t, engineId);
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
    for (const nativePromptRequestId of [undefined, null, "", " ", "x\ny", {}, [], NaN, Infinity, -0, 0.5, 2 ** 53, "x".repeat(513)]) {
      assert.throws(() => f.store.beginNativeSubmission({ ...key, nativePromptRequestId }, now), { code: "native_journal_invalid" });
      assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "reserved");
    }
    assert.throws(() => f.store.beginNativeSubmission({ ...key, nativePromptRequestId: 7, nativeTurnId: "invented" }, now),
      { code: "native_journal_invalid" });
    f.store.beginNativeSubmission({ ...key, nativePromptRequestId: "7" }, now);
    assert.throws(() => f.open().beginNativeSubmission({ ...key, nativePromptRequestId: 8 }, now), { code: "native_submission_conflict" });
    assert.throws(() => f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: 7 }, now), { code: "native_submission_conflict" });
    assert.throws(() => f.store.acceptNativeSubmission({ ...key, nativeTurnId: "invented" }, now), { code: "native_journal_invalid" });
    assert.throws(() => f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: "7", nativeTurnId: "invented" }, now),
      { code: "native_journal_invalid" });
    assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "submission_pending");
    f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: "7" }, now);
    const output = { ...key, nativePromptRequestId: "7", nativeSessionId: "acp-session", firstSequence: 1, events: [textOutput("checked")] };
    for (const patch of [{ nativePromptRequestId: 7 }, { nativePromptRequestId: "8" }, { nativeTurnId: "invented" }, { nativeSessionId: "other" }]) {
      assert.throws(() => f.store.appendNativeRunEvents({ ...output, ...patch }, now), { code: "native_owner_mismatch" });
    }
    assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  });

  test(`${engineId} scopes repeated RPC ids to separate submissions and fences unknown outcomes`, async t => {
    const f = await fixture(t, engineId);
    for (const outcome of ["not_submitted", "rejected", "completed", "failed", "cancelled", "unknown"]) {
      const entry = f.reserve();
      const key = { submissionId: entry.submission.id, fence: entry.input.fence };
      f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
      f.store.beginNativeSubmission({ ...key, nativePromptRequestId: "request-1" }, now);
      if (!["not_submitted", "rejected", "unknown"].includes(outcome)) {
        f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: "request-1" }, now);
      }
      if (outcome === "unknown") {
        f.store.markNativeSubmissionUnknown(key, now);
        const reopened = f.open();
        assert.equal(reopened.getNativeSubmission(entry.submission.id).nativePromptRequestId, "request-1");
        assert.throws(() => reopened.beginNativeSubmission({ ...key, nativePromptRequestId: "request-1" }, now), { code: "native_submission_conflict" });
        assert.throws(() => reopened.acceptNativeSubmission({ ...key, nativePromptRequestId: "request-1" }, now), { code: "native_submission_conflict" });
        assert.throws(() => reopened.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now), { code: "native_submission_conflict" });
        assert.throws(() => reopened.reserveNativeExecution(f.run(), now), { code: "native_session_busy" });
      } else {
        assert.equal(f.store.finishNativeSubmission({ ...key, outcome }, now).status, outcome);
      }
    }
  });

  test(`${engineId} cannot accept or publish for an obsolete Attempt`, async t => {
    const f = await fixture(t, engineId);
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence, nativePromptRequestId: 3 };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
    f.store.beginNativeSubmission(key, now);
    f.store.createWorkUnitAttempt({ workUnitId: entry.input.fence.workUnitId, attemptNumber: 2,
      runtimeInstanceId: "replacement", runnerId: engineId, now });
    assert.throws(() => f.store.acceptNativeSubmission(key, now), { code: "native_owner_mismatch" });
    assert.throws(() => f.store.appendNativeRunEvents({ ...key, nativeSessionId: "acp-session", firstSequence: 1,
      events: [textOutput("stale")], terminal: "completed" }, now), { code: "native_owner_mismatch" });
    assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "submission_pending");
    assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  });

  test(`${engineId} keeps user decisions distinct from reply delivery across reopen and terminal`, async t => {
    const f = await fixture(t, engineId);
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence, nativePromptRequestId: 3 };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
    f.store.beginNativeSubmission(key, now);
    f.store.acceptNativeSubmission(key, now);
    const approvals = [];
    for (const [index, status] of ["pending", "claimed", "written", "not_written", "unknown"].entries()) {
      const { approval } = f.store.createNativeApproval({ ...key, ...approvalInput, method: "session/request_permission", requestId: `permission-${index}` }, now);
      const approvalKey = { approvalId: approval.id, fence: key.fence };
      assert.throws(() => f.store.claimNativeApprovalReply(approvalKey, now), { code: "native_approval_unavailable" });
      if (status !== "pending") {
        f.store.approveApprovalRequest(approval.id, {}, now);
        assert.equal(f.store.getNativeApprovalCorrelation(approval.id).replyStatus, "pending");
        f.store.claimNativeApprovalReply(approvalKey, now);
        if (status !== "claimed") f.store.settleNativeApprovalReply({ ...approvalKey, outcome: status }, now);
        assert.throws(() => f.open().claimNativeApprovalReply(approvalKey, now), { code: "native_approval_unavailable" });
      }
      approvals.push({ id: approval.id, status });
    }
    f.store.finishNativeSubmission({ ...key, outcome: "cancelled" }, now);
    const reopened = f.open();
    for (const { id, status } of approvals) {
      assert.equal(reopened.getApprovalRequest(id).status, status === "pending" ? "cancelled" : "approved");
      assert.equal(reopened.getNativeApprovalCorrelation(id).replyStatus,
        status === "pending" ? "not_written" : status === "claimed" ? "unknown" : status);
      assert.ok(reopened.getNativeApprovalCorrelation(id).resolvedAt);
    }
  });

  test(`${engineId} rolls back prompt correlation and terminal output on storage failure`, async t => {
    const f = await fixture(t, engineId);
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence, nativePromptRequestId: 0 };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "acp-session" }, now);
    const db = new DatabaseSync(f.store.paths.databasePath);
    t.after(() => db.close());
    db.exec("CREATE TRIGGER reject_acp_begin BEFORE UPDATE OF status ON native_submissions WHEN NEW.status = 'submission_pending' BEGIN SELECT RAISE(FAIL, 'injected_acp_begin'); END;");
    assert.throws(() => f.store.beginNativeSubmission(key, now), /injected_acp_begin/);
    const unchanged = f.open().getNativeSubmission(entry.submission.id);
    assert.equal(unchanged.status, "reserved");
    assert.equal(unchanged.nativePromptRequestId, undefined);
    db.exec("DROP TRIGGER reject_acp_begin");
    f.store.beginNativeSubmission(key, now);
    f.store.acceptNativeSubmission(key, now);
    const { approval } = f.store.createNativeApproval({ ...key, ...approvalInput, method: "session/request_permission" }, now);
    const output = { ...key, nativeSessionId: "acp-session", firstSequence: 1, events: [textOutput("done")], terminal: "completed" };
    db.exec("CREATE TRIGGER reject_acp_terminal BEFORE UPDATE OF status ON native_submissions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(FAIL, 'injected_acp_terminal'); END;");
    assert.throws(() => f.store.appendNativeRunEvents(output, now), /injected_acp_terminal/);
    assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "accepted");
    assert.equal(f.store.getApprovalRequest(approval.id).status, "pending");
    assert.equal(f.store.getNativeApprovalCorrelation(approval.id).resolvedAt, undefined);
    assert.deepEqual(f.store.listEvents(entry.input.runId), []);
    db.exec("DROP TRIGGER reject_acp_terminal");
    f.store.appendNativeRunEvents(output, now);
    assert.equal(f.store.getApprovalRequest(approval.id).status, "cancelled");
    assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "completed");
  });
}

for (const failMigration of [false, true]) test(`ACP additive migration preserves an existing Codex journal (rollback=${failMigration})`, async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const before = f.store.getNativeSubmission(entry.submission.id);
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  const savedOutput = f.store.appendNativeRunEvents(outputInput(entry, [textOutput("preserved")]), now);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    db.exec("ALTER TABLE native_submissions DROP COLUMN native_prompt_request_key; DELETE FROM schema_migrations WHERE version = 170;");
    if (failMigration) {
      db.exec("CREATE TRIGGER reject_acp_migration BEFORE INSERT ON schema_migrations WHEN NEW.version = 170 BEGIN SELECT RAISE(FAIL, 'injected_acp_migration'); END;");
      assert.throws(() => f.open(), /injected_acp_migration/);
      db.exec("DROP TRIGGER reject_acp_migration");
    }
  } finally { db.close(); }
  const reopened = f.open();
  assert.deepEqual(reopened.getNativeSubmission(entry.submission.id), before);
  assert.deepEqual(reopened.getApprovalRequest(approval.id), approval);
  assert.equal(reopened.getNativeExecutionBinding(entry.binding.id).nativeSessionId, "native-thread");
  assert.deepEqual(reopened.appendNativeRunEvents(outputInput(entry, [textOutput("preserved")]), now), { ...savedOutput, created: false });
  assert.deepEqual(f.open().getNativeSubmission(entry.submission.id), before);
});

test("Codex cannot substitute ACP correlation for its native turn", async t => {
  const f = await fixture(t);
  const entry = f.reserve();
  const key = { submissionId: entry.submission.id, fence: entry.input.fence };
  f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-thread" }, now);
  assert.throws(() => f.store.beginNativeSubmission({ ...key, nativePromptRequestId: 1 }, now), { code: "native_journal_invalid" });
  f.store.beginNativeSubmission(key, now);
  assert.throws(() => f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: 1 }, now), { code: "native_journal_invalid" });
  assert.throws(() => f.store.acceptNativeSubmission({ ...key, nativePromptRequestId: 1, nativeTurnId: "native-turn" }, now), { code: "native_journal_invalid" });
  f.store.acceptNativeSubmission({ ...key, nativeTurnId: "native-turn" }, now);
  assert.throws(() => f.store.appendNativeRunEvents({ ...outputInput({ key }, [textOutput("bad")]), nativePromptRequestId: 1 }, now),
    { code: "native_owner_mismatch" });
});

function artifactOutput(f, entry) {
  const artifact = { eventIndex: 0, contentIndex: 0, toolCallId: "image-1", kind: "image",
    sha256: "c".repeat(64), sizeBytes: 100 };
  const identity = nativeArtifactIdentity(f.store.paths.artifactsDir, entry.submission.id, artifact);
  const event = { type: "tool_end", data: { toolCallId: "image-1", toolName: "image_generation",
    isError: false, result: { content: [identity.content] } } };
  return { ...outputInput(entry, [event]), artifacts: [artifact] };
}

test("native artifacts publish next to their tool output and replay the same identity after reopen", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = artifactOutput(f, entry);
  const saved = f.store.appendNativeRunEvents(input, now);
  assert.deepEqual(saved.events.map(event => event.type), ["tool_end", "artifact_created"]);
  assert.deepEqual(saved.events.map(event => event.data.nativeOutput.sequence), [1, 2]);
  const [artifact] = f.store.listArtifacts(entry.input.runId);
  assert.equal(artifact.type, "image");
  assert.equal(artifact.contentType, "image/png");
  assert.equal(artifact.sealedPayload.nativeArtifact.byteSha256, "c".repeat(64));
  assert.equal(saved.events[1].data.artifactId, artifact.id);
  assert.deepEqual(f.open().appendNativeRunEvents(input, now), { ...saved, created: false });
  assert.equal(f.store.listArtifacts(entry.input.runId).length, 1);
  assert.throws(() => f.store.appendNativeRunEvents({ ...input, artifacts: [{ ...input.artifacts[0], sizeBytes: 99 }] }, now),
    { code: "native_output_conflict" });
});

function assistantArtifactOutput(f, entry) {
  const input = artifactOutput(f, entry);
  const descriptor = { ...input.artifacts[0], sourceKind: "assistant" };
  const identity = nativeArtifactIdentity(f.store.paths.artifactsDir, entry.submission.id, descriptor);
  return { ...input, events: [{ type: "progress", data: { nativeKind: "assistant_content", role: "assistant",
    itemId: descriptor.toolCallId, content: [identity.content] } }], artifacts: [descriptor] };
}

test("assistant artifact identities cannot collide with tool outputs and replay once after reopen", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const tool = artifactOutput(f, entry);
  const assistant = assistantArtifactOutput(f, entry);
  const input = { ...tool, events: [...tool.events, ...assistant.events],
    artifacts: [...tool.artifacts, { ...assistant.artifacts[0], eventIndex: 1 }], terminal: "completed" };
  const saved = f.store.appendNativeRunEvents(input, now);
  const artifacts = f.store.listArtifacts(entry.input.runId);
  assert.equal(artifacts.length, 2);
  assert.notEqual(artifacts[0].id, artifacts[1].id);
  assert.deepEqual(saved.events.map(event => event.type), ["tool_end", "artifact_created", "progress", "artifact_created"]);
  assert.equal(saved.events[3].data.role, "assistant");
  assert.equal(saved.events[3].data.itemId, "image-1");
  assert.equal(saved.events[3].data.toolCallId, undefined);
  assert.equal(saved.events[3].data.toolName, undefined);
  assert.deepEqual(f.open().appendNativeRunEvents(input, now), { ...saved, created: false });
  assert.equal(f.store.listArtifacts(entry.input.runId).length, 2);
});

test("assistant artifact provenance mismatches cannot commit source events or artifacts", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = assistantArtifactOutput(f, entry);
  for (const patch of [{ role: "user" }, { itemId: "other" }, { toolCallId: "image-1" }, { toolName: "fake" }, { nativeKind: "function_output" }]) {
    assert.throws(() => f.store.appendNativeRunEvents({ ...input, events: [{ ...input.events[0], data: { ...input.events[0].data, ...patch } }] }, now),
      { code: "native_journal_invalid" });
  }
  for (const sourceKind of [undefined, null, "tool", "unknown"]) {
    assert.throws(() => f.store.appendNativeRunEvents({ ...input, artifacts: [{ ...input.artifacts[0], sourceKind }] }, now), { code: "native_journal_invalid" });
  }
  assert.deepEqual(f.store.listArtifacts(entry.input.runId), []);
  assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "accepted");
  assert.equal(f.store.appendNativeRunEvents(input, now).created, true);
});

test("native artifact publication rejects unrelated content and stale execution ownership", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = artifactOutput(f, entry);
  for (const patch of [{ eventIndex: 1 }, { contentIndex: 1 }, { toolCallId: "other" }, { sha256: "../bad" }, { path: "/tmp/untrusted" }]) {
    assert.throws(() => f.store.appendNativeRunEvents({ ...input, artifacts: [{ ...input.artifacts[0], ...patch }] }, now),
      { code: "native_journal_invalid" });
  }
  f.store.createWorkUnitAttempt({ workUnitId: entry.input.fence.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "codex-app-server", now });
  assert.throws(() => f.store.appendNativeRunEvents(input, now), { code: "native_owner_mismatch" });
  assert.deepEqual(f.store.listArtifacts(entry.input.runId), []);
  assert.deepEqual(f.store.listEvents(entry.input.runId), []);
});

test("native artifact rows, source events and terminal result commit or roll back together", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = { ...artifactOutput(f, entry), terminal: "completed" };
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_native_artifact_terminal BEFORE UPDATE OF status ON native_submissions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(FAIL, 'injected_artifact_failure'); END;");
  assert.throws(() => f.store.appendNativeRunEvents(input, now), /injected_artifact_failure/);
  assert.deepEqual(f.store.listArtifacts(entry.input.runId), []);
  assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "accepted");
  db.exec("DROP TRIGGER reject_native_artifact_terminal");
  assert.equal(f.store.appendNativeRunEvents(input, now).created, true);
  assert.equal(f.store.listArtifacts(entry.input.runId).length, 1);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "completed");
});

test("native output batches persist in run_events and replay once after reopen", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = outputInput(entry, [textOutput("hello "), textOutput("world")]);
  const first = f.store.appendNativeRunEvents(input, now);
  assert.equal(first.created, true);
  assert.deepEqual(first.events.map(event => event.data.text), ["hello ", "world"]);
  assert.deepEqual(first.events.map(event => event.data.nativeOutput.sequence), [1, 2]);
  const retry = f.open().appendNativeRunEvents(input, now);
  assert.equal(retry.created, false);
  assert.deepEqual(retry.events, first.events);
  assert.equal(f.store.listEvents(entry.input.runId).length, 2);
  assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, [textOutput("changed")]), now), { code: "native_output_conflict" });
  assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, [textOutput("gap")], 4), now), { code: "native_output_conflict" });
  assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, [textOutput("world"), textOutput("mixed")], 2), now), { code: "native_output_conflict" });
});

test("native output requires bound identity and full current attempt ownership", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = outputInput(entry, [textOutput("visible")]);
  for (const key of ["nativeSessionId", "nativeTurnId"]) assert.throws(() => f.store.appendNativeRunEvents({ ...input, [key]: "other" }, now), { code: "native_owner_mismatch" });
  f.store.createWorkUnitAttempt({ workUnitId: entry.input.fence.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: "codex-app-server", now });
  assert.throws(() => f.store.appendNativeRunEvents(input, now), { code: "native_owner_mismatch" });
  assert.deepEqual(f.store.listEvents(entry.input.runId), []);
});

test("native output validates the entire bounded batch and redacts before persistence", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  for (const events of [[textOutput("ok"), { type: "tool_end", data: { toolName: "bash" } }],
    [{ type: "approval_approved", data: { approvalId: "forged" } }],
    [textOutput("x".repeat(4 * 1024 * 1024 + 1))],
    [{ type: "assistant_text_delta", data: { text: "ok", nativeOutput: {} } }]]) {
    assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, events), now), { code: "native_journal_invalid" });
    assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  }
  const result = f.store.appendNativeRunEvents({ ...outputInput(entry, [textOutput("owned-secret Bearer abc sk-123456789012")]), extraSecrets: ["owned-secret"] }, now);
  assert.equal(result.events[0].data.text, "[REDACTED] [REDACTED] [REDACTED]");
});

test("native terminal events and outcome roll back together, then replay idempotently", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const db = new DatabaseSync(f.store.paths.databasePath);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER reject_native_finish BEFORE UPDATE OF status ON native_submissions WHEN NEW.status = 'completed' BEGIN SELECT RAISE(FAIL, 'injected_terminal_failure'); END;");
  const events = [{ type: "message_end", data: { role: "assistant", text: "done" } }, { type: "turn_end", data: {} }];
  const input = outputInput(entry, events, 1, "completed");
  assert.throws(() => f.store.appendNativeRunEvents(input, now), /injected_terminal_failure/);
  assert.deepEqual(f.store.listEvents(entry.input.runId), []);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "accepted");
  db.exec("DROP TRIGGER reject_native_finish");
  const saved = f.store.appendNativeRunEvents(input, now);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "completed");
  assert.deepEqual(f.open().appendNativeRunEvents(input, now), { ...saved, created: false });
  assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, [textOutput("late")], 3), now), { code: "native_submission_conflict" });
});

test("cancelling owners record terminal evidence but cannot stream more normal output", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.updateWorkUnitAttemptStatus({ ...entry.input.fence, status: "cancelling", now });
  assert.throws(() => f.store.appendNativeRunEvents(outputInput(entry, [textOutput("late")]), now), { code: "native_owner_mismatch" });
  const input = outputInput(entry, [{ type: "message_end", data: { role: "assistant", stopReason: "aborted" } },
    { type: "turn_end", data: {} }], 1, "cancelled");
  f.store.appendNativeRunEvents(input, now);
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "cancelled");
  assert.equal(f.store.listEvents(entry.input.runId).length, 2);
});

test("native journal upgrades without changing existing conversation data and survives reopen", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  assert.equal(entry.created, true);
  assert.equal(entry.submission.status, "reserved");
  const reopened = f.open();
  assert.deepEqual(reopened.getNativeSubmission(entry.submission.id), entry.submission);
  assert.deepEqual(reopened.getNativeExecutionBinding(entry.binding.id), entry.binding);
  assert.equal(reopened.getLingThread(f.thread.id).title, "Native test");
  const db = new DatabaseSync(f.store.paths.databasePath);
  try {
    const migrations = db.prepare("SELECT version, name FROM schema_migrations WHERE version BETWEEN 169 AND 174 ORDER BY version")
      .all().map(row => ({ version: row.version, name: row.name }));
    assert.deepEqual(migrations, [
      { version: 169, name: "native_execution_journal" },
      { version: 170, name: "native_acp_prompt_correlation" },
      { version: 171, name: "native_host_effect_journal" },
      { version: 172, name: "native_host_reply_observations" },
      { version: 173, name: "native_host_terminal_lifecycle" },
      { version: 174, name: "native_openclaw_session_identity" },
    ]);
  }
  finally { db.close(); }
});

test("native execution generation is derived from the durable conversation binding", async (t) => {
  const f = await fixture(t);
  const first = f.run();
  assert.equal(f.store.resolveNativeExecutionGeneration({ runId: first.runId, fence: first.fence,
    selection: first.selection }), 1);

  const entry = f.reserve(first);
  const key = { submissionId: entry.submission.id, fence: first.fence };
  f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-generation-session" }, now);
  f.store.beginNativeSubmission(key, now);
  f.store.acceptNativeSubmission({ ...key, nativeTurnId: "native-generation-turn" }, now);
  f.store.finishNativeSubmission({ ...key, outcome: "completed" }, now);

  const continuation = f.run();
  assert.equal(f.open().resolveNativeExecutionGeneration({ runId: continuation.runId, fence: continuation.fence,
    selection: continuation.selection }), 1);

  const rebound = f.run();
  const reboundEntry = f.store.reserveNativeExecution({ ...rebound, generation: 2 }, now);
  const afterRebind = f.run();
  assert.equal(f.open().resolveNativeExecutionGeneration({ runId: afterRebind.runId, fence: afterRebind.fence,
    selection: afterRebind.selection }), 2);
  assert.equal(reboundEntry.binding.generation, 2);
});

test("native generation derivation rejects implicit selection or cwd replacement", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  f.store.finishNativeSubmission({ submissionId: entry.submission.id, fence: entry.input.fence,
    outcome: "not_submitted" }, now);

  for (const selectionDelta of [
    { profileId: "other-profile" },
    { profileRevision: 2 },
    { profileFingerprint: "c".repeat(64) },
    { modelId: "other-model" },
    { configurationFingerprint: "d".repeat(64) },
  ]) {
    const changed = f.run();
    assert.throws(() => f.store.resolveNativeExecutionGeneration({ runId: changed.runId, fence: changed.fence,
      selection: { ...changed.selection, ...selectionDelta } }), { code: "native_binding_conflict" });
  }

  const moved = f.run({ cwd: join(f.cwd, "different") });
  assert.throws(() => f.store.resolveNativeExecutionGeneration({ runId: moved.runId, fence: moved.fence,
    selection: moved.selection }), { code: "native_binding_conflict" });
});

test("reserve is idempotent, but only one transaction grants a send permit", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  const key = { submissionId: entry.submission.id, fence: entry.input.fence };
  assert.equal(f.store.reserveNativeExecution(entry.input, now).created, false);
  assert.throws(() => f.store.beginNativeSubmission(key, now), { code: "native_session_missing" });
  f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-thread" }, now);
  assert.equal(f.store.beginNativeSubmission(key, now).status, "submission_pending");
  assert.throws(() => f.open().beginNativeSubmission(key, now), { code: "native_submission_conflict" });
});

test("competing attempts cannot submit into the same conversation or bypass it with a new generation", async (t) => {
  const f = await fixture(t);
  f.reserve();
  const competing = f.run();
  assert.throws(() => f.open().reserveNativeExecution(competing, now), { code: "native_session_busy" });
  assert.throws(() => f.store.reserveNativeExecution({ ...competing, generation: 2 }, now), { code: "native_session_busy" });
});

test("native identity and profile selection cannot be changed by a retry", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  for (const delta of [{ modelId: "another" }, { profileRevision: 2 }, { profileId: "other" }, { configurationFingerprint: "c".repeat(64) }]) {
    assert.throws(() => f.store.reserveNativeExecution({ ...entry.input, selection: { ...selection, ...delta } }, now), { code: "native_binding_conflict" });
  }
  assert.throws(() => f.store.bindNativeExecutionSession({ ...entry.key, nativeSessionId: "another-thread" }, now), { code: "native_binding_conflict" });
  assert.throws(() => f.store.acceptNativeSubmission({ ...entry.key, nativeTurnId: "another-turn" }, now), { code: "native_submission_conflict" });
});

test("unknown outcome survives restart and never grants retry or completion without a native terminal", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  f.store.markNativeSubmissionUnknown(entry.key, now);
  const reopened = f.open();
  assert.equal(reopened.getNativeSubmission(entry.submission.id).status, "unknown");
  assert.equal(reopened.listUnresolvedNativeSubmissions().length, 1);
  assert.throws(() => reopened.reserveNativeExecution(f.run(), now), { code: "native_session_busy" });
  assert.throws(() => reopened.finishNativeSubmission({ ...entry.key, outcome: "not_submitted" }, now), { code: "native_submission_conflict" });
});

test("only proven no-send or native terminal outcomes release the conversation", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  const key = { submissionId: entry.submission.id, fence: entry.input.fence };
  assert.throws(() => f.store.finishNativeSubmission({ ...key, outcome: "completed" }, now), { code: "native_submission_conflict" });
  f.store.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now);
  const next = f.accepted();
  f.store.finishNativeSubmission({ ...next.key, outcome: "completed" }, now);
  assert.equal(f.store.listUnresolvedNativeSubmissions().length, 0);
  assert.equal(f.reserve().binding.id, next.binding.id);
});

test("another conversation cannot reuse an already bound native session", async (t) => {
  const f = await fixture(t);
  f.accepted();
  const thread = f.store.createLingThread({ kind: "conversation", title: "Other", objective: "Test" }, now);
  const entry = f.reserve(f.run({ threadId: thread.id }));
  assert.throws(() => f.store.bindNativeExecutionSession({ submissionId: entry.submission.id, fence: entry.input.fence,
    nativeSessionId: "native-thread" }, now), { code: "native_binding_conflict" });
});

test("complete current Attempt fence and linked Run ownership are mandatory", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  const other = f.run();
  assert.throws(() => f.store.reserveNativeExecution({ ...other, fence: entry.input.fence }, now), { code: "native_owner_mismatch" });
  for (const field of ["workUnitId", "attemptId", "runtimeInstanceId", "fencingToken"]) {
    assert.throws(() => f.store.bindNativeExecutionSession({ submissionId: entry.submission.id,
      fence: { ...entry.input.fence, [field]: "999" }, nativeSessionId: "native-thread" }, now), { code: "native_owner_mismatch" });
  }
  f.store.createWorkUnitAttempt({ workUnitId: entry.input.fence.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "runtime_new", runnerId: selection.engineId, now });
  assert.throws(() => f.store.bindNativeExecutionSession({ submissionId: entry.submission.id,
    fence: entry.input.fence, nativeSessionId: "native-thread" }, now), { code: "native_owner_mismatch" });
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "reserved");
});

const approvalInput = { method: "item/commandExecution/requestApproval", requestId: 7,
  approval: { actionType: "bash", risk: "medium", toolCallId: "native-item", title: "Approve command",
    description: "whois example.com", payload: { command: "whois example.com", cwd: "/tmp", type: "bash", riskFlags: [] } } };

function startOwnedRun(f, entry) {
  const { runId, fence } = entry.input;
  const turn = f.store.createLingTurn({ threadId: f.thread.id, kind: "initial_request", title: "Native wait",
    userInstruction: "Test native approval state" }, now);
  f.store.linkRunToLingTurn({ turnId: turn.id, runId, now });
  assert.equal(f.store.transitionRunStatus({ runId, event: "runner_started", actor: "system", now }).ok, true);
  for (const event of ["claim", "runner_started"]) {
    assert.equal(f.store.transitionWorkUnitStatus({ ...fence, event, actor: "system", now }).ok, true);
  }
  f.store.updateWorkUnitAttemptStatus({ ...fence, status: "started", now });
  f.store.updateLingThread(f.thread.id, { status: "running", activeRunId: runId, lastRunId: runId }, now);
}

test("native human wait aggregates pending approvals and a denial does not fail the turn", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  const first = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now).approval;
  const second = f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: 8 }, now).approval;
  let snapshot = f.store.synchronizeNativeApprovalWait(entry.key, now);
  assert.deepEqual(new Set(snapshot.pendingApprovalIds), new Set([first.id, second.id]));
  for (const entity of [f.store.getRun(entry.input.runId), f.store.getWorkUnit(entry.input.fence.workUnitId),
    f.store.getWorkUnitAttempt(entry.input.fence.attemptId), f.store.getLingThread(f.thread.id), f.store.getLingTurnForRun(entry.input.runId)]) {
    assert.equal(entity.status, "waiting_for_approval");
  }
  f.store.denyApprovalRequest(first.id, { resolvedBy: "local-user" }, now);
  snapshot = f.store.synchronizeNativeApprovalWait(entry.key, now);
  assert.deepEqual(snapshot.pendingApprovalIds, [second.id]);
  assert.equal(f.store.getRun(entry.input.runId).status, "waiting_for_approval");
  f.store.approveApprovalRequest(second.id, {}, now);
  snapshot = f.store.synchronizeNativeApprovalWait(entry.key, now);
  assert.deepEqual(snapshot.pendingApprovalIds, []);
  assert.equal(f.store.getRun(entry.input.runId).status, "running");
  assert.equal(f.store.getWorkUnit(entry.input.fence.workUnitId).status, "running");
  assert.equal(f.store.getWorkUnitAttempt(entry.input.fence.attemptId).status, "started");
  assert.equal(f.store.getLingThread(f.thread.id).status, "running");
  assert.equal(f.store.getLingTurnForRun(entry.input.runId).status, "running");
  assert.equal(f.store.getNativeSubmission(entry.submission.id).status, "accepted");
  const events = f.store.listEvents(entry.input.runId);
  assert.equal(events.filter(event => event.type === "approval_requested").length, 2);
  assert.equal(events.find(event => event.type === "approval_denied").data.approvalId, first.id);
  assert.equal(events.find(event => event.type === "approval_approved").data.decisionKind, "approve_once");
  f.store.synchronizeNativeApprovalWait(entry.key, now);
  assert.deepEqual(f.store.listEvents(entry.input.runId), events);
});

test("native wait reuses an HTTP decision event and still expires each saved deadline", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  const first = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now).approval;
  const second = f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: 8,
    approval: { ...approvalInput.approval, expiresAt: "2026-09-08T12:00:01.000Z" } }, now).approval;
  f.store.synchronizeNativeApprovalWait(entry.key, now);
  const approved = f.store.approveApprovalRequest(first.id, {}, now);
  const httpEvent = f.store.appendEvent(entry.input.runId, "approval_approved", {
    approvalId: first.id, status: "approved", decisionKind: approved.decisionKind,
  });
  const snapshot = f.store.synchronizeNativeApprovalWait(entry.key, "2026-09-08T12:00:01.000Z");
  assert.deepEqual(snapshot.pendingApprovalIds, []);
  assert.equal(f.store.getApprovalRequest(second.id).status, "expired");
  assert.equal(snapshot.events.find(event => event.type === "approval_approved").id, httpEvent.id);
  assert.equal(f.store.listEvents(entry.input.runId).filter(event => event.type === "approval_approved").length, 1);
  assert.equal(f.store.getRun(entry.input.runId).status, "running");
});

test("HTTP publication after a native waiter wins reuses the committed decision", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  const approval = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now).approval;
  f.store.synchronizeNativeApprovalWait(entry.key, now);
  f.store.approveApprovalRequest(approval.id, {}, now);
  const snapshot = f.store.synchronizeNativeApprovalWait(entry.key, now);
  const published = f.open().publishNativeApprovalDecision(approval.id, now);
  assert.equal(published.id, snapshot.events.find(event => event.type === "approval_approved").id);
  assert.equal(f.store.listEvents(entry.input.runId).filter(event => event.type === "approval_approved").length, 1);
});

test("native wait cannot publish events or change state for a replacement Attempt", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  f.store.createWorkUnitAttempt({ workUnitId: entry.input.fence.workUnitId, attemptNumber: 2,
    runtimeInstanceId: "replacement", runnerId: selection.engineId, now });
  assert.throws(() => f.store.synchronizeNativeApprovalWait(entry.key, now), { code: "native_owner_mismatch" });
  assert.equal(f.store.getRun(entry.input.runId).status, "running");
  assert.equal(f.store.listEvents(entry.input.runId).length, 0);
});

test("native wait projection rolls back all states and events on storage failure", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  const db = new DatabaseSync(f.store.paths.databasePath);
  try { db.exec("CREATE TRIGGER fail_wait BEFORE UPDATE ON work_unit_attempts WHEN NEW.status = 'waiting_for_approval' BEGIN SELECT RAISE(ABORT, 'fixture wait failure'); END"); }
  finally { db.close(); }
  assert.throws(() => f.store.synchronizeNativeApprovalWait(entry.key, now), /fixture wait failure/);
  assert.equal(f.store.getRun(entry.input.runId).status, "running");
  assert.equal(f.store.getWorkUnit(entry.input.fence.workUnitId).status, "running");
  assert.equal(f.store.getWorkUnitAttempt(entry.input.fence.attemptId).status, "started");
  assert.equal(f.store.listEvents(entry.input.runId).length, 0);
});

test("native resolution ends its wait without reviving a cancelling owner", async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  startOwnedRun(f, entry);
  const approval = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now).approval;
  f.store.synchronizeNativeApprovalWait(entry.key, now);
  f.store.transitionWorkUnitStatus({ ...entry.input.fence, event: "cancel", actor: "system", now });
  f.store.updateWorkUnitAttemptStatus({ ...entry.input.fence, status: "cancelling", now });
  f.store.resolveNativeApprovalRequest({ approvalId: approval.id, fence: entry.input.fence }, now);
  const snapshot = f.store.synchronizeNativeApprovalWait(entry.key, now);
  assert.deepEqual(snapshot.pendingApprovalIds, []);
  assert.equal(f.store.getWorkUnit(entry.input.fence.workUnitId).status, "cancelling");
  assert.equal(f.store.getWorkUnitAttempt(entry.input.fence.attemptId).status, "cancelling");
  assert.ok(snapshot.events.some(event => event.type === "approval_cancelled"));
});

test("native request correlation and the existing approval commit together, with typed request ids", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const first = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  assert.equal(first.approval.runId, entry.input.runId);
  assert.deepEqual(first.approval.availableDecisions, ["approve_once", "deny"]);
  assert.equal(f.store.getApprovalCheckpointForApproval(first.approval.id).approvalId, first.approval.id);
  assert.equal(f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now).approval.id, first.approval.id);
  const stringId = f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: "7" }, now);
  assert.notEqual(stringId.approval.id, first.approval.id);
  assert.throws(() => f.store.createNativeApproval({ ...entry.key, ...approvalInput,
    method: "item/fileChange/requestApproval" }, now), { code: "native_approval_conflict" });
});

test("failed native correlation insertion rolls back approval and checkpoint", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try { db.exec("CREATE TRIGGER fail_native_approval BEFORE INSERT ON native_approval_requests BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"); }
  finally { db.close(); }
  assert.throws(() => f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now));
  assert.equal(f.store.listApprovalRequests({ runId: entry.input.runId }).length, 0);
  assert.equal(f.store.listApprovalCheckpoints({}).length, 0);
});

test("a durable approval decision grants one reply claim, not a retry after restart", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  const key = { approvalId: approval.id, fence: entry.input.fence };
  assert.throws(() => f.store.claimNativeApprovalReply(key, now), { code: "native_approval_unavailable" });
  f.store.approveApprovalRequest(approval.id, {}, now);
  const claim = f.store.claimNativeApprovalReply(key, now);
  assert.equal(claim.correlation.replyStatus, "claimed");
  assert.equal(claim.approval.decisionKind, "approve_once");
  assert.throws(() => f.open().claimNativeApprovalReply(key, now), { code: "native_approval_unavailable" });
  assert.equal(f.store.settleNativeApprovalReply({ ...key, outcome: "written" }, now).replyStatus, "written");
});

test("native resolution cancels a pending approval but preserves a potentially written decision", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  const key = { approvalId: approval.id, fence: entry.input.fence };
  f.store.resolveNativeApprovalRequest(key, now);
  assert.equal(f.store.getApprovalRequest(approval.id).status, "cancelled");
  assert.throws(() => f.store.claimNativeApprovalReply(key, now), { code: "native_approval_unavailable" });
  const second = f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: 8 }, now);
  const secondKey = { ...key, approvalId: second.approval.id };
  f.store.approveApprovalRequest(second.approval.id, {}, now);
  f.store.claimNativeApprovalReply(secondKey, now);
  assert.equal(f.store.resolveNativeApprovalRequest(secondKey, now).replyStatus, "unknown");
  assert.equal(f.store.getApprovalRequest(second.approval.id).status, "approved");
});

test("terminal turns retire unanswered native approvals without changing existing decisions", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  f.store.finishNativeSubmission({ ...entry.key, outcome: "cancelled" }, now);
  assert.equal(f.store.getApprovalRequest(approval.id).status, "cancelled");
  assert.throws(() => f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: 9 }, now), { code: "native_submission_conflict" });
});

test("expired or unsupported native persistent decisions never receive a reply permit", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  assert.throws(() => f.store.createNativeApproval({ ...entry.key, ...approvalInput,
    approval: { ...approvalInput.approval, availableDecisions: ["approve_command_rule"] } }, now), { code: "native_journal_invalid" });
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput,
    approval: { ...approvalInput.approval, expiresAt: now } }, now);
  f.store.approveApprovalRequest(approval.id, {}, now);
  assert.throws(() => f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: entry.input.fence }, now), { code: "native_approval_unavailable" });
});

test("cancellation still accepts terminal evidence, but cannot grant new submissions or approvals", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  const { approval } = f.store.createNativeApproval({ ...entry.key, ...approvalInput }, now);
  f.store.approveApprovalRequest(approval.id, {}, now);
  f.store.updateWorkUnitAttemptStatus({ ...entry.input.fence, status: "cancelling", now });
  assert.throws(() => f.store.claimNativeApprovalReply({ approvalId: approval.id, fence: entry.input.fence }, now), { code: "native_owner_mismatch" });
  assert.throws(() => f.store.createNativeApproval({ ...entry.key, ...approvalInput, requestId: 20 }, now), { code: "native_owner_mismatch" });
  assert.equal(f.store.finishNativeSubmission({ ...entry.key, outcome: "cancelled" }, now).status, "cancelled");
});

test("engines without negotiated model selection do not need a fabricated model id", async (t) => {
  const f = await fixture(t);
  const input = f.run();
  delete input.selection.modelId;
  const entry = f.reserve(input);
  assert.equal(entry.binding.selection.modelId, undefined);
});

test("additive upgrade preserves pre-journal runs, threads and approvals", async (t) => {
  const f = await fixture(t);
  const input = f.run();
  const approval = f.store.createApprovalRequest({ ...approvalInput.approval, runId: input.runId, taskId: input.run.taskId }, now);
  const before = f.store.getRun(input.runId);
  f.store.close();
  const db = new DatabaseSync(f.store.paths.databasePath);
  try { db.exec("DROP TABLE native_host_operations; DROP TABLE native_host_actions; DROP TABLE native_approval_requests; DROP TABLE native_submissions; DROP TABLE native_execution_bindings; DELETE FROM schema_migrations WHERE version IN (169, 170, 171, 172, 173, 174)"); }
  finally { db.close(); }
  const reopened = f.open();
  assert.deepEqual(reopened.getRun(input.runId), before);
  assert.deepEqual(reopened.getApprovalRequest(approval.id), approval);
  assert.equal(reopened.getLingThread(f.thread.id).title, "Native test");
  assert.equal(reopened.listUnresolvedNativeSubmissions().length, 0);
});

for (const withArtifact of [false, true]) test(`two concurrent native output writers commit one batch (artifact=${withArtifact})`, { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const entry = f.accepted();
  const input = withArtifact ? artifactOutput(f, entry) : outputInput(entry, [textOutput("one stream")]);
  const start = new SharedArrayBuffer(4);
  const workers = Array.from({ length: 2 }, () => new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{const {createSqliteRunStore}=await import(workerData.module);
      const store=createSqliteRunStore(workerData.cwd);parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.start),0,0);
      try{const result=store.appendNativeRunEvents(workerData.input,workerData.now);
        parentPort.postMessage({created:result.created,id:result.events[0].id});}
      catch(error){parentPort.postMessage({error:error.code??error.message});}
      finally{store.close();}})();
  `, { eval: true, workerData: { cwd: f.cwd, input, now, start, module: new URL("../dist/index.js", import.meta.url).href } }));
  const ready = workers.map(() => Promise.withResolvers());
  const results = workers.map(() => Promise.withResolvers());
  workers.forEach((worker, index) => {
    worker.on("message", message => message.ready ? ready[index].resolve() : results[index].resolve(message));
    worker.on("error", error => { ready[index].reject(error); results[index].reject(error); });
    t.after(() => worker.terminate());
  });
  await Promise.all(ready.map(item => item.promise));
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  const outcomes = await Promise.all(results.map(item => item.promise));
  assert.deepEqual(outcomes.map(item => item.created).sort(), [false, true]);
  assert.equal(outcomes[0].id, outcomes[1].id);
  assert.equal(f.store.listEvents(entry.input.runId).length, withArtifact ? 2 : 1);
  assert.equal(f.store.listArtifacts(entry.input.runId).length, withArtifact ? 1 : 0);
});

for (const engineId of ["codex-app-server", "kimi-acp", "openclaw-acp"])
for (const operation of ["reserve", "begin"])
test(`${engineId}: two concurrent SQLite workers produce one first-send ${operation}`, { timeout: 15000 }, async (t) => {
  const f = await fixture(t, engineId);
  let inputs;
  if (operation === "reserve") inputs = [f.run(), f.run()];
  else {
    const entry = f.reserve();
    const key = { submissionId: entry.submission.id, fence: entry.input.fence };
    f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "race-session" }, now);
    inputs = [0, "0"].map(nativePromptRequestId => ({ ...key,
      ...(engineId === "codex-app-server" ? {} : { nativePromptRequestId }) }));
  }
  const start = new SharedArrayBuffer(4);
  const workers = inputs.map(input => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createSqliteRunStore } = await import(workerData.module);
      const store = createSqliteRunStore(workerData.cwd);
      parentPort.postMessage({ ready: true });
      Atomics.wait(new Int32Array(workerData.start), 0, 0);
      try {
        if (workerData.operation === 'reserve') parentPort.postMessage({ created: store.reserveNativeExecution(workerData.input, workerData.now).created });
        else {
          const saved = store.beginNativeSubmission(workerData.input, workerData.now);
          parentPort.postMessage({ created: saved.status === 'submission_pending', requestId: saved.nativePromptRequestId });
        }
      }
      catch (error) { parentPort.postMessage({ code: error.code }); }
      finally { store.close(); }
    })();
  `, { eval: true, workerData: { cwd: f.cwd, operation, input, now, start, module: new URL("../dist/index.js", import.meta.url).href } }));
  const readiness = [];
  const outcomes = [];
  for (const worker of workers) {
    const ready = Promise.withResolvers();
    const result = Promise.withResolvers();
    readiness.push(ready.promise);
    outcomes.push(result.promise);
    worker.on("message", message => message.ready ? ready.resolve() : result.resolve(message));
    worker.on("error", error => { ready.reject(error); result.reject(error); });
    t.after(() => worker.terminate());
  }
  await Promise.all(readiness);
  Atomics.store(new Int32Array(start), 0, 1);
  Atomics.notify(new Int32Array(start), 0);
  const results = await Promise.all(outcomes);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.deepEqual(results.filter(result => result.code), [{ code: operation === "reserve" ? "native_session_busy" : "native_submission_conflict" }]);
  if (operation === "begin") assert.equal(f.store.getNativeSubmission(inputs[0].submissionId).nativePromptRequestId, results.find(result => result.created).requestId);
  assert.equal(f.store.listUnresolvedNativeSubmissions().length, 1);
});

test("optional model absence is canonical across persistence and a repeated reservation", async (t) => {
  const f = await fixture(t);
  const input = f.run();
  input.selection.modelId = undefined;
  const entry = f.reserve(input);
  assert.equal(f.open().reserveNativeExecution(input, now).binding.id, entry.binding.id);
});

test("confirmed pre-transport cancellation can release a send permit, unknown outcomes cannot", async (t) => {
  const f = await fixture(t);
  const entry = f.reserve();
  const key = { submissionId: entry.submission.id, fence: entry.input.fence };
  f.store.bindNativeExecutionSession({ ...key, nativeSessionId: "native-thread" }, now);
  f.store.beginNativeSubmission(key, now);
  assert.equal(f.store.finishNativeSubmission({ ...key, outcome: "not_submitted" }, now).status, "not_submitted");
});

test("the binding pins the actual Run cwd, and later runs cannot reuse it from another directory", async (t) => {
  const f = await fixture(t);
  const entry = f.accepted();
  assert.equal(entry.binding.cwd, f.cwd);
  f.store.finishNativeSubmission({ ...entry.key, outcome: "completed" }, now);
  const changed = f.run({ cwd: join(f.cwd, "different") });
  assert.throws(() => f.reserve(changed), { code: "native_binding_conflict" });
});
