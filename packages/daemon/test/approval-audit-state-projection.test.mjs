import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveStoragePaths } from "../../core/dist/index.js";
import { syncLingThreadForRunEvent } from "../dist/features/runs/threads.js";
import { syncWorkUnitForRunEvent } from "../dist/features/runs/work-units.js";

const NOW = "2026-10-16T00:00:00.000Z";
const LATER = "2026-10-16T00:00:01.000Z";

test("A27 immediate policy-deny audit preserves the running WorkUnit, Attempt and Thread", async t => {
  const f = await fixture(t);
  const approval = f.createApproval();
  const denied = f.store.denyApprovalRequest(approval.id, { reason: "Current workspace policy denies this operation." }, LATER);
  assert.equal(denied.status, "denied");
  f.keepThreadRunning();
  const before = f.snapshot();
  const requested = f.appendAndProject("approval_requested", requestPayload(denied));
  const afterRequested = f.snapshot();
  const decision = f.appendAndProject("approval_denied", decisionPayload(denied));
  const afterDenied = f.snapshot();
  f.reopen();
  assert.deepEqual({ afterRequested, afterDenied, reopened: f.snapshot() },
    { afterRequested: before, afterDenied: before, reopened: before },
    "A denied command attempt is audit evidence, not a committed approval wait or a terminal Run");
  assert.deepEqual(f.store.listEvents(f.run.id).map(event => [event.id, event.type, event.data.approvalId]),
    [[requested.id, "approval_requested", approval.id], [decision.id, "approval_denied", approval.id]],
    "The fix must retain both durable audit events, not hide the deny");
  assert.equal(f.store.getApprovalRequest(approval.id).status, "denied");
});

test("A27 pending same-Run approval plus stored Run wait projects the real wait using a stale caller Run", async t => {
  const f = await fixture(t);
  const approval = f.createApproval();
  f.enterRunWait();
  assert.equal(f.run.status, "running", "The callback deliberately retains the orchestrator's captured Run");
  const event = f.appendAndProject("approval_requested", requestPayload(approval));
  assert.deepEqual(f.statuses(), waitingStatuses());
  assert.equal(f.store.getLingThread(f.thread.id).activeRunId, f.run.id);
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
  assert.equal(f.store.listRuntimeEvents(f.unit.id).filter(row => row.type === "work_unit_approval_requested").length, 1);
  const beforeReplay = f.snapshot();
  f.project(event);
  assert.deepEqual(f.snapshot(), beforeReplay, "Replaying a genuine wait must not duplicate projection effects");
  f.reopen();
  assert.deepEqual(f.statuses(), waitingStatuses());
});

test("A27 a pending approval alone cannot fabricate a wait while its stored Run is running", async t => {
  const f = await fixture(t);
  const approval = f.createApproval();
  f.keepThreadRunning();
  const before = f.snapshot();
  f.appendAndProject("approval_requested", requestPayload(approval));
  assert.deepEqual(f.snapshot(), before);
  f.reopen();
  assert.deepEqual(f.snapshot(), before);
});

for (const kind of ["missing", "other-run", "denied", "expired", "cancelled", "approved"]) {
  test(`A27 stored Run wait rejects ${kind} approval evidence without changing any projection`, async t => {
    const f = await fixture(t);
    let approval;
    if (kind === "missing") {
      approval = { id: "approval_missing_a27", toolCallId: "call-missing", actionType: "bash", risk: "medium",
        title: "Missing fixture approval", description: "No approval record exists.",
        payload: { type: "bash", cwd: f.cwd, command: "fixture-never-executed", riskFlags: [] } };
    } else if (kind === "other-run") {
      const foreign = f.createRun("a27-foreign-run");
      approval = f.createApproval(foreign);
    } else {
      approval = f.createApproval();
      const resolve = kind === "denied" ? "denyApprovalRequest" : kind === "expired" ? "expireApprovalRequest"
        : kind === "cancelled" ? "cancelApprovalRequest" : "approveApprovalRequest";
      approval = f.store[resolve](approval.id, { reason: "Resolved fixture approval." }, LATER);
      assert.equal(approval.status, kind);
    }
    f.enterRunWait();
    const before = f.snapshot();
    const approvalBefore = f.store.getApprovalRequest(approval.id);
    f.appendAndProject("approval_requested", requestPayload(approval));
    assert.deepEqual(f.snapshot(), before, "Run wait alone cannot authenticate unrelated or resolved approval evidence");
    assert.deepEqual(f.store.getApprovalRequest(approval.id), approvalBefore);
    f.reopen();
    assert.deepEqual(f.snapshot(), before);
  });
}

for (const status of ["denied", "expired", "approved"]) {
  test(`A27 genuine approval wait keeps existing ${status} decision behavior`, async t => {
    const f = await fixture(t);
    const approval = f.createApproval();
    f.enterRunWait();
    f.appendAndProject("approval_requested", requestPayload(approval));
    assert.deepEqual(f.statuses(), waitingStatuses(), "The control must enter a real persisted wait first");
    const resolve = status === "denied" ? "denyApprovalRequest"
      : status === "expired" ? "expireApprovalRequest" : "approveApprovalRequest";
    const resolved = f.store[resolve](approval.id, { reason: "Real wait decision." }, LATER);
    assert.equal(resolved.status, status);
    const eventType = `approval_${status}`;
    const changed = f.store.transitionRunStatus({ runId: f.run.id, expectedStatus: "waiting_for_approval",
      event: eventType, actor: status === "expired" ? "system" : "local-user", now: LATER,
      ...(status === "approved" ? {} : { endedAt: LATER, errorMessage: "Real wait decision." }) });
    assert.equal(changed.ok, true);
    f.appendAndProject(eventType, decisionPayload(resolved));
    const expected = status === "approved"
      ? { run: "running", workUnit: "running", attempt: "started", thread: "running" }
      : { run: "failed", workUnit: "failed", attempt: "failed", thread: "failed" };
    assert.deepEqual(f.statuses(), expected);
    assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, f.attempt.id);
    assert.equal(f.store.getLingThread(f.thread.id).activeRunId, status === "approved" ? f.run.id : undefined);
    f.reopen();
    assert.deepEqual(f.statuses(), expected);
  });
}

for (const kind of ["missing", "other-run"]) {
  test(`A27 ${kind} denial audit cannot terminate an existing genuine approval wait`, async t => {
    const f = await fixture(t);
    const pending = f.createApproval();
    f.enterRunWait();
    f.appendAndProject("approval_requested", requestPayload(pending));
    assert.deepEqual(f.statuses(), waitingStatuses());
    let approvalId = "approval_missing_a27_decision";
    if (kind === "other-run") {
      const foreign = f.createRun("a27-foreign-decision-run");
      const foreignApproval = f.createApproval(foreign);
      approvalId = f.store.denyApprovalRequest(foreignApproval.id, { reason: "Foreign decision." }, LATER).id;
    }
    const before = f.snapshot();
    f.appendAndProject("approval_denied", { approvalId, status: "denied", decisionReason: "Not this Run's decision." });
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.store.getApprovalRequest(pending.id).status, "pending");
    f.reopen();
    assert.deepEqual(f.snapshot(), before);
  });
}

/** Store-only fixture: explicit owned paths, no Daemon, Provider, Runner or command execution. */
async function fixture(t) {
  const temporaryParent = await realpath(tmpdir());
  const root = await realpath(await mkdtemp(join(temporaryParent, "ling-a27-approval-audit-")));
  const cwd = join(root, "workspace"), userRoot = join(root, "user-data");
  await mkdir(cwd); await mkdir(userRoot);
  const paths = resolveStoragePaths(cwd, { userRootDir: userRoot, workspaceStateLocation: "repo-local", env: {} }).workspace;
  let store = createSqliteRunStore(cwd, paths);
  assert.equal(store.paths.cwd, cwd);
  assert.equal(store.paths.databasePath, join(cwd, ".ling-stack", "ling-stack.sqlite"));
  t.after(async () => {
    try { store.close(); }
    finally {
      assert.equal(dirname(root), temporaryParent);
      assert.ok(basename(root).startsWith("ling-a27-approval-audit-"));
      await rm(root, { recursive: true, force: true });
    }
  });
  const thread = store.createLingThread({ kind: "conversation", title: "A27 approval audit", objective: "Verify real approval state." }, NOW);
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run",
    ownerId: "a27-audit-run", idempotencyKey: "a27-audit-unit", status: "running",
    createdByActor: "system", request: {}, now: NOW });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1,
    runtimeInstanceId: "a27-audit-runtime", runnerId: "pi", status: "started", now: NOW });
  const f = {
    cwd, thread, unit, attempt,
    get store() { return store; },
    createRun(id) {
      const created = store.createRun({ id, cwd, taskId: `${id}-task`, threadId: thread.id,
        ...(id === "a27-audit-run" ? { workUnitId: unit.id } : {}),
        providerName: "fixture", providerModel: "fixture", taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, createdAt: NOW });
      store.markRunStarted(created.id, NOW);
      return store.getRun(created.id);
    },
    createApproval(owner = f.run) {
      return store.createApprovalRequest({ runId: owner.id, taskId: owner.taskId,
        toolCallId: `${owner.id}-call`, actionType: "bash", risk: "medium", title: "Approval audit fixture",
        description: "Synthetic request only; no command is executed.",
        payload: { type: "bash", cwd, command: "fixture-never-executed", riskFlags: [] } }, NOW);
    },
    keepThreadRunning() {
      store.updateLingThread(thread.id, { status: "running", activeRunId: f.run.id, lastRunId: f.run.id }, NOW);
    },
    enterRunWait() {
      assert.equal(store.transitionRunStatus({ runId: f.run.id, expectedStatus: "running",
        event: "approval_requested", actor: "system", now: LATER }).ok, true);
      // The following event is what these two projection functions must validate.
      f.keepThreadRunning();
    },
    appendAndProject(type, data) {
      const event = store.appendEvent(f.run.id, type, data);
      f.project(event);
      return event;
    },
    project(event) {
      syncWorkUnitForRunEvent(store, unit.id, attempt.id, event.type, event);
      syncLingThreadForRunEvent(store, f.run, event.type, event);
    },
    snapshot() {
      return { run: store.getRun(f.run.id), workUnit: store.getWorkUnit(unit.id),
        attempt: store.getWorkUnitAttempt(attempt.id), thread: store.getLingThread(thread.id),
        runtimeEvents: store.listRuntimeEvents(unit.id) };
    },
    statuses() {
      return { run: store.getRun(f.run.id).status, workUnit: store.getWorkUnit(unit.id).status,
        attempt: store.getWorkUnitAttempt(attempt.id).status, thread: store.getLingThread(thread.id).status };
    },
    reopen() {
      // A second read-only SQLite connection sees the actual durable projection before reopen.
      const reader = new DatabaseSync(paths.databasePath, { readOnly: true });
      try {
        for (const [table, id, model] of [["run_sessions", f.run.id, store.getRun(f.run.id)],
          ["work_units", unit.id, store.getWorkUnit(unit.id)], ["work_unit_attempts", attempt.id, store.getWorkUnitAttempt(attempt.id)],
          ["ling_threads", thread.id, store.getLingThread(thread.id)]]) {
          assert.equal(reader.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id).status, model.status);
        }
      } finally { reader.close(); }
      store.close();
      store = createSqliteRunStore(cwd, paths);
    },
  };
  f.run = f.createRun("a27-audit-run");
  store.linkRunToWorkUnit(f.run.id, unit.id, NOW);
  f.keepThreadRunning();
  assert.deepEqual(f.statuses(), { run: "running", workUnit: "running", attempt: "started", thread: "running" });
  return f;
}

function requestPayload(approval) {
  return { approvalId: approval.id, toolCallId: approval.toolCallId, actionType: approval.actionType,
    risk: approval.risk, title: approval.title, description: approval.description,
    payload: approval.payload, previewArtifactIds: [] };
}

function decisionPayload(approval) {
  return { approvalId: approval.id, status: approval.status, resolvedBy: approval.resolvedBy, decisionReason: approval.decisionReason };
}

function waitingStatuses() {
  return { run: "waiting_for_approval", workUnit: "waiting_for_approval", attempt: "waiting_for_approval", thread: "waiting_for_approval" };
}
