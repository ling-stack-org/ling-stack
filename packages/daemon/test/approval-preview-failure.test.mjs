import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, resolveSessionRunPolicy, toRuntimeAttemptFence } from "@ling-stack/core";
import { loadSourceHookModule } from "./support/protected-host-source-hooks-fixture.mjs";
import { observeGitSourceProcesses } from "./support/protected-host-git-source-hooks-fixture.mjs";
import { observeSourceHookBootstrap } from "./support/protected-host-source-bootstrap-observer.mjs";

// These are real SQLite request/checkpoint/harness transitions. Only the Git
// producer is observed; no command, OS protection profile or UI is exercised.
test("original Git preview refusals close their owning approval before escaping", { skip: process.platform !== "darwin" }, async t => {
  const observed = observeGitSourceProcesses(t);
  const { createRunApprovalHandler } = await loadSourceHookModule("features/runs/approvals.js");
  const { reconcileApprovalPostCommitEffects } = await loadSourceHookModule("features/runs/approval-postcommit-effects.js");
  const { ACTION_CLASSIFIER_GIT_ACTOR_ENTRY } = await loadSourceHookModule("features/runs/action-classifier.js");
  const { ProtectedHostStageRegistry } = await loadSourceHookModule("runtime/sandbox/protected-host-staging.js");

  for (const decision of ["deny", "ask"]) {
    await t.test(`${decision}: original refusal is not a ready preview or a dangling pending request`, async t => {
      const f = await fixture(t, decision, ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
      const before = observed.calls.length, callbacks = { started: 0, resolved: [], abandoned: 0 };
      const handler = createRunApprovalHandler({ ...f.options,
        onApprovalWaitStarted() { callbacks.started += 1; },
        onApprovalResolved(approval) { callbacks.resolved.push(approval); },
        onApprovalWaitAbandoned() { callbacks.abandoned += 1; },
      });
      await assert.rejects(handler(f.request), /protected_host_actor_unbound_with_active_stage/u);
      assert.equal(observed.calls.length, before, "the physical Git producer must remain unentered");
      const approvals = f.store.listApprovalRequests({ runId: f.run.id, complete: true });
      assert.equal(approvals.length, 1);
      const approval = approvals[0], expectedStatus = decision === "deny" ? "denied" : "cancelled";
      assert.equal(approval.status, expectedStatus);
      assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, expectedStatus);
      assert.deepEqual(f.store.listApprovalRequests({ runId: f.run.id, status: "pending", complete: true }), []);
      const executions = f.store.listHarnessToolExecutions(f.run.id);
      assert.equal(executions.length, 1);
      assert.equal(executions[0].approvalId, approval.id);
      assert.equal(executions[0].state, expectedStatus);
      assert.equal(executions[0].failureCode, decision === "deny" ? "tool.policy_denied" : "tool.execution_cancelled");
      assert.equal(executions[0].executionStartedAt, undefined);
      assert.ok(executions[0].executionFinishedAt);
      assert.equal(f.store.getRun(f.run.id).status, "running", "preview failure precedes the durable wait transition");
      const events = f.store.listEvents(f.run.id, { limit: 100 });
      assert.equal(events.some(event => event.type === "approval_requested"), false);
      assert.equal(events.filter(event => event.type === `approval_${expectedStatus}`).length, 1);
      assert.equal(events.some(event => event.type === "host_command_prepared"), false);
      assert.equal(callbacks.started, decision === "ask" ? 1 : 0);
      assert.deepEqual(callbacks.resolved.map(approval => approval.status), decision === "ask" ? ["cancelled"] : []);
      assert.equal(callbacks.abandoned, 0, "a real terminal decision releases the wait through onApprovalResolved");
    });
  }

  for (const scenario of ["stale_before_cleanup", "stale_at_cas", "external_cas_winner", "cleanup_failed", "harness_failed", "event_failed", "callback_failed"]) {
    await t.test(`ask: ${scenario} never fabricates cleanup success and releases only its local wait`, async t => {
      const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
      const before = observed.calls.length, callbacks = { started: 0, resolved: [], abandoned: 0 }, cleanupFailure = new Error(`injected_${scenario}`);
      let paused = false, winner;
      if (scenario === "stale_before_cleanup") f.beforeRefusal(f.replace);
      if (scenario === "stale_at_cas" || scenario === "external_cas_winner") {
        const cancel = f.store.cancelApprovalRequest.bind(f.store);
        t.mock.method(f.store, "cancelApprovalRequest", (...args) => {
          if (scenario === "stale_at_cas") f.replace();
          else winner = f.other.denyApprovalRequest(args[0], { reason: "external winner" }, new Date().toISOString());
          return cancel(...args);
        });
      }
      if (scenario === "cleanup_failed") t.mock.method(f.store, "cancelApprovalRequest", () => { throw cleanupFailure; });
      if (scenario === "harness_failed") t.mock.method(f.store, "resolveHarnessToolApproval", () => { throw cleanupFailure; });
      const handler = createRunApprovalHandler({ ...f.options,
        appendAndMaybeStream(type, data) {
          return f.options.appendAndMaybeStream(type, data);
        },
        streamEnvelope(event) {
          if (scenario === "event_failed" && event.type === "approval_cancelled") throw cleanupFailure;
        },
        onApprovalWaitStarted() { callbacks.started += 1; paused = true; },
        onApprovalResolved(approval) {
          callbacks.resolved.push(approval);
          if (scenario === "callback_failed") throw cleanupFailure;
          paused = false;
        },
        onApprovalWaitAbandoned() { callbacks.abandoned += 1; paused = false; },
      });
      const error = await rejection(handler(f.request));
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /protected_host_actor_unbound_with_active_stage/u);
      assert.match(error.cause.message, /protected_host_actor_unbound_with_active_stage/u);
      assert.equal(error.errors[0], error.cause, "the original gate refusal must remain first and cause");
      if (["cleanup_failed", "harness_failed", "event_failed", "callback_failed"].includes(scenario)) {
        assert.ok(error.errors.includes(cleanupFailure), "the cleanup failure must not disappear");
      }
      const approval = f.store.listApprovalRequests({ runId: f.run.id, complete: true })[0];
      const pending = ["stale_before_cleanup", "stale_at_cas", "cleanup_failed"].includes(scenario);
      assert.equal(approval.status, pending ? "pending" : scenario === "external_cas_winner" ? "denied" : "cancelled");
      assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, approval.status);
      const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
      assert.equal(execution.state, pending || ["external_cas_winner", "harness_failed"].includes(scenario) ? "approval_pending" : "cancelled");
      assert.equal(execution.executionStartedAt, undefined);
      const events = f.store.listEvents(f.run.id, { limit: 100 });
      assert.equal(events.some(event => ["approval_requested", "host_command_prepared"].includes(event.type)), false);
      assert.equal(events.filter(event => event.type === "approval_cancelled").length,
        ["harness_failed", "event_failed", "callback_failed"].includes(scenario) ? 1 : 0);
      assert.equal(callbacks.started, 1);
      assert.deepEqual(callbacks.resolved.map(approval => approval.status), pending ? [] : [approval.status]);
      assert.equal(callbacks.abandoned, pending || scenario === "callback_failed" ? 1 : 0);
      assert.equal(paused, false);
      assert.equal(observed.calls.length, before);
      if (winner) assert.equal(approval.decisionReason, winner.decisionReason);
    });
  }

  for (const scenario of ["bind_failed", "prepare_failed", "stale_before_insert"]) {
    await t.test(`ask: adjacent ${scenario} abandons the local pause without inventing a verdict`, async t => {
      const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
      const failure = new Error(`injected_${scenario}`), callbacks = { started: 0, resolved: [], abandoned: 0 };
      if (scenario === "bind_failed") t.mock.method(f.store, "updateApprovalCheckpointStatus", () => { throw failure; });
      if (scenario === "prepare_failed") t.mock.method(f.store, "prepareHarnessToolExecution", () => { throw failure; });
      if (scenario === "stale_before_insert") {
        const create = f.store.createExecutionApprovalRequest.bind(f.store);
        t.mock.method(f.store, "createExecutionApprovalRequest", (...args) => { f.replace(); return create(...args); });
      }
      const handler = createRunApprovalHandler({ ...f.options,
        onApprovalWaitStarted() { callbacks.started += 1; },
        onApprovalResolved(approval) { callbacks.resolved.push(approval); },
        onApprovalWaitAbandoned() { callbacks.abandoned += 1; },
      });
      if (scenario === "stale_before_insert") assert.equal((await handler(f.request)).approved, false);
      else assert.equal(await rejection(handler(f.request)), failure);
      const approvals = f.store.listApprovalRequests({ runId: f.run.id, complete: true });
      assert.equal(approvals.length, scenario === "stale_before_insert" ? 0 : 1);
      for (const approval of approvals) assert.equal(approval.status, "pending");
      assert.deepEqual(callbacks, { started: 1, resolved: [], abandoned: 1 });
      assert.equal(f.store.listEvents(f.run.id).some(event => event.type.startsWith("approval_")), false);
    });
  }

  await t.test("ask: a throwing start hook retains its original error and abandons only its own pause", async t => {
    const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
    const failure = new Error("injected_wait_start_failure"), before = observed.calls.length;
    const callbacks = { started: 0, resolved: [], abandoned: 0 };
    let paused = false;
    const handler = createRunApprovalHandler({ ...f.options,
      onApprovalWaitStarted() { callbacks.started += 1; paused = true; throw failure; },
      onApprovalResolved(approval) { callbacks.resolved.push(approval); },
      onApprovalWaitAbandoned() { callbacks.abandoned += 1; assert.equal(paused, true); paused = false; },
    });
    assert.equal(await rejection(handler(f.request)), failure);
    assert.deepEqual(callbacks, { started: 1, resolved: [], abandoned: 1 });
    assert.equal(paused, false);
    assert.deepEqual(f.store.listApprovalRequests({ runId: f.run.id, complete: true }), []);
    assert.deepEqual(f.store.listHarnessToolExecutions(f.run.id), []);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.sourceFence, false), true);
    assert.equal(f.store.listEvents(f.run.id).some(event => event.type.startsWith("approval_") || event.type === "host_command_prepared"), false);
    assert.equal(observed.calls.length, before);
  });

  await t.test("ask: a throwing abandon hook cannot mask the original failure or fabricate a decision", async t => {
    const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
    const failure = new Error("injected_before_approval_insert"), releaseFailure = new Error("injected_wait_abandon_failure");
    const before = observed.calls.length, callbacks = { started: 0, resolved: [], abandoned: 0 };
    t.mock.method(f.store, "createExecutionApprovalRequest", () => { throw failure; });
    const handler = createRunApprovalHandler({ ...f.options,
      onApprovalWaitStarted() { callbacks.started += 1; },
      onApprovalResolved(approval) { callbacks.resolved.push(approval); },
      onApprovalWaitAbandoned() { callbacks.abandoned += 1; throw releaseFailure; },
    });
    const error = await rejection(handler(f.request));
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.deepEqual(error.errors, [failure, releaseFailure]);
    assert.equal(error.message, failure.message);
    assert.deepEqual(callbacks, { started: 1, resolved: [], abandoned: 1 });
    // A throwing Host hook is not evidence of successful physical release.
    // The handler must expose its failure without retrying or inventing a verdict.
    assert.deepEqual(f.store.listApprovalRequests({ runId: f.run.id, complete: true }), []);
    assert.deepEqual(f.store.listHarnessToolExecutions(f.run.id), []);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.sourceFence, false), true);
    assert.equal(f.store.listEvents(f.run.id).some(event => event.type.startsWith("approval_") || event.type === "host_command_prepared"), false);
    assert.equal(observed.calls.length, before);
  });

  await t.test("ask: queued callbacks retain independent pauses and original preview errors", async t => {
    const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
    const requests = ["queued-first", "queued-second"].map(toolCallId => ({ ...f.request, toolCallId,
      input: { command: "node fixture.js" } }));
    const failures = requests.map(request => new Error(`injected_preview_${request.toolCallId}`));
    const cleanupFailure = new Error("injected_first_cleanup_failure"), before = observed.calls.length;
    const callbacks = { started: 0, resolved: [], abandoned: 0 }, trace = [], refusedCalls = [];
    const createArtifact = f.store.createArtifact.bind(f.store), cancel = f.store.cancelApprovalRequest.bind(f.store);
    t.mock.method(f.store, "createArtifact", input => {
      const approval = f.store.listApprovalRequests({ runId: f.run.id, complete: true })
        .find(approval => input.path === `${f.run.id}/actions/${approval.id}/preview.json`);
      if (!approval) return createArtifact(input);
      const index = requests.findIndex(request => request.toolCallId === approval.toolCallId);
      assert.notEqual(index, -1);
      refusedCalls.push(approval.toolCallId);
      throw failures[index];
    });
    t.mock.method(f.store, "cancelApprovalRequest", (approvalId, ...args) => {
      if (f.store.getApprovalRequest(approvalId).toolCallId === requests[0].toolCallId) throw cleanupFailure;
      return cancel(approvalId, ...args);
    });
    let paused = false, activeCallId;
    const handler = createRunApprovalHandler({ ...f.options,
      onApprovalWaitStarted() {
        assert.equal(paused, false, "the preceding callback must release before its queued successor starts");
        activeCallId = requests[callbacks.started].toolCallId;
        callbacks.started += 1; paused = true; trace.push(["start", activeCallId]);
      },
      onApprovalResolved(approval) {
        assert.equal(paused, true); assert.equal(approval.toolCallId, activeCallId);
        callbacks.resolved.push(approval); trace.push(["resolve", activeCallId]); paused = false; activeCallId = undefined;
      },
      onApprovalWaitAbandoned() {
        assert.equal(paused, true); callbacks.abandoned += 1;
        trace.push(["abandon", activeCallId]); paused = false; activeCallId = undefined;
      },
    });
    // Enqueue both before either callback has run; each promise catches its own
    // error immediately, so serialization is tested without unhandled rejection.
    const errors = await Promise.all(requests.map(request => rejection(handler(request))));
    assert.ok(errors[0] instanceof AggregateError);
    assert.equal(errors[0].cause, failures[0]);
    assert.deepEqual(errors[0].errors, [failures[0], cleanupFailure]);
    assert.equal(errors[1], failures[1]);
    assert.deepEqual(refusedCalls, requests.map(request => request.toolCallId));
    assert.deepEqual(trace, [["start", "queued-first"], ["abandon", "queued-first"],
      ["start", "queued-second"], ["resolve", "queued-second"]]);
    assert.equal(paused, false);
    assert.equal(callbacks.started, 2); assert.equal(callbacks.abandoned, 1);
    assert.deepEqual(callbacks.resolved.map(approval => approval.toolCallId), ["queued-second"]);
    const approvals = f.store.listApprovalRequests({ runId: f.run.id, complete: true });
    const executions = f.store.listHarnessToolExecutions(f.run.id);
    assert.equal(approvals.length, 2); assert.equal(executions.length, 2);
    for (const [index, request] of requests.entries()) {
      const approval = approvals.find(approval => approval.toolCallId === request.toolCallId);
      const execution = executions.find(execution => execution.toolCallId === request.toolCallId);
      assert.ok(approval); assert.ok(execution);
      assert.equal(approval.status, index === 0 ? "pending" : "cancelled");
      assert.equal(f.store.getApprovalCheckpointForApproval(approval.id).status, approval.status);
      assert.equal(execution.approvalId, approval.id);
      assert.equal(execution.attemptId, f.sourceFence.attemptId);
      assert.equal(execution.state, index === 0 ? "approval_pending" : "cancelled");
      assert.equal(execution.executionStartedAt, undefined);
      assert.ok(f.store.getArtifact(execution.policySnapshotArtifactId));
    }
    const events = f.store.listEvents(f.run.id, { limit: 100 });
    assert.equal(events.some(event => ["approval_requested", "host_command_prepared"].includes(event.type)), false);
    const cancelled = events.filter(event => event.type === "approval_cancelled");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].data.approvalId, approvals.find(approval => approval.toolCallId === "queued-second").id);
    assert.equal(f.store.getRun(f.run.id).status, "running");
    assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.sourceFence, false), true);
    assert.equal(observed.calls.length, before);
  });

  await t.test("ask: a non-Git artifact persistence failure has the same truthful cleanup", async t => {
    const f = await fixture(t, "ask", ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
    const failure = new Error("injected_artifact_store_failure"), before = observed.calls.length, resolved = [], refusedPaths = [];
    const createArtifact = f.store.createArtifact.bind(f.store);
    t.mock.method(f.store, "createArtifact", input => {
      const approval = f.store.listApprovalRequests({ runId: f.run.id, status: "pending", complete: true })[0];
      if (approval && input.path === `${f.run.id}/actions/${approval.id}/preview.json`) {
        refusedPaths.push(input.path);
        throw failure;
      }
      return createArtifact(input);
    });
    const request = { ...f.request, input: { command: "node fixture.js" } };
    const handler = createRunApprovalHandler({ ...f.options, onApprovalResolved(approval) { resolved.push(approval); } });
    assert.equal(await rejection(handler(request)), failure, "successful cleanup preserves the exact original Error");
    const approval = f.store.listApprovalRequests({ runId: f.run.id, complete: true })[0];
    assert.deepEqual(refusedPaths, [`${f.run.id}/actions/${approval.id}/preview.json`], "inject only the actual preview persistence after Harness preparation");
    assert.equal(approval.status, "cancelled");
    const execution = f.store.listHarnessToolExecutions(f.run.id)[0];
    assert.equal(execution.state, "cancelled");
    assert.ok(f.store.getArtifact(execution.policySnapshotArtifactId), "the real Harness policy artifact must be persisted before preview refusal");
    assert.deepEqual(resolved.map(approval => approval.status), ["cancelled"]);
    assert.equal(observed.calls.length, before, "non-Git artifacts must not introduce a Git producer");
  });

  for (const decision of ["deny", "ask"]) {
    await t.test(`${decision}: successful neighboring preview preserves the existing approval flow`, async t => {
      const f = await fixture(t, decision, ProtectedHostStageRegistry, ACTION_CLASSIFIER_GIT_ACTOR_ENTRY);
      f.closeStage();
      const callbacks = { started: 0, resolved: [], abandoned: 0 }, streamed = [];
      let hostDecisionEvent;
      const handler = createRunApprovalHandler({ ...f.options,
        appendAndMaybeStream(type, data) {
          const event = f.options.appendAndMaybeStream(type, data);
          if (decision === "ask" && type === "approval_requested") {
            const now = new Date().toISOString();
            const denied = f.other.denyApprovalRequest(data.approvalId, { reason: "neighboring human denial" }, now);
            const postCommit = reconcileApprovalPostCommitEffects({ store: f.other, approval: denied, cwd: f.run.cwd, now });
            assert.equal(postCommit.deferred, true,
              "owner evidence stays pending until the run handler leaves waiting_for_approval");
            hostDecisionEvent = f.other.listEvents(f.run.id).find(event => event.type === "approval_denied" && event.data.approvalId === denied.id);
            assert.ok(hostDecisionEvent);
          }
          return event;
        },
        streamEnvelope(event) { streamed.push(event); },
        onApprovalWaitStarted() { callbacks.started += 1; },
        onApprovalResolved(approval) { callbacks.resolved.push(approval); },
        onApprovalWaitAbandoned() { callbacks.abandoned += 1; },
      });
      assert.equal((await handler(f.request)).approved, false);
      const approval = f.store.listApprovalRequests({ runId: f.run.id, complete: true })[0];
      assert.equal(approval.status, "denied");
      assert.equal(f.store.listHarnessToolExecutions(f.run.id)[0].state, "denied");
      assert.ok(f.store.listArtifacts(f.run.id).length > 0);
      assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "approval_requested").length, 1);
      if (decision === "ask") {
        assert.equal(f.store.listEvents(f.run.id).filter(event => event.type === "approval_denied").length, 1);
        assert.deepEqual(streamed.filter(event => event.type === "approval_denied"), [hostDecisionEvent], "the handler replays the already committed Host decision exactly once");
      }
      assert.deepEqual(callbacks, { started: decision === "ask" ? 1 : 0, resolved: decision === "ask" ? [approval] : [], abandoned: 0 });
    });
  }
});

async function rejection(promise) {
  try { await promise; }
  catch (error) { return error; }
  assert.fail("Expected refusal, not a ready result");
}

async function fixture(t, decision, ProtectedHostStageRegistry, entry) {
  // Approval/source placement only: this supplies no actual OS or native proof.
  // Keep the real SQLite transitions and exact pre-producer refusal unchanged.
  observeSourceHookBootstrap(t);
  const root = await realpath(await mkdtemp("/private/tmp/ling-approval-preview-failure-"));
  const cwd = join(root, "workspace"), stagePath = join(root, "stage");
  for (const path of [cwd, stagePath]) await mkdir(path, { mode: 0o700 });
  const store = createSqliteRunStore(cwd), now = new Date().toISOString();
  const approvalPolicy = store.updateApprovalPolicy({ toolDecisions: { bash: decision } }, now);
  const effectivePolicySnapshot = resolveSessionRunPolicy({ workspacePolicy: approvalPolicy,
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const task = { id: `preview-task-${decision}`, title: "Isolated approval preview", prompt: "No actual Git execution" };
  const id = `preview-run-${decision}`;
  const unit = store.createWorkUnit({ workspaceId: DEFAULT_WORKSPACE_ID, kind: "task_run", ownerType: "run", ownerId: id,
    idempotencyKey: id, status: "running", createdByActor: "system", request: {}, now });
  const attempt = store.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 1, runtimeInstanceId: "preview-fixture-runtime",
    runnerId: "pi", status: "started", now });
  store.createRun({ id, cwd, workUnitId: unit.id, taskId: task.id, providerName: "fixture", providerModel: "fixture",
    taskSnapshot: task, providerSnapshot: {}, requestSnapshot: { effectivePolicySnapshot,
      harnessFeatureSnapshot: { toolBroker: "enforce" } }, createdAt: now });
  store.linkRunToWorkUnit(id, unit.id, now); store.markRunStarted(id, now);
  const run = store.getRun(id), sourceFence = toRuntimeAttemptFence(attempt), registry = new ProtectedHostStageRegistry();
  const stage = registry.registerStage({ store, run, sourceFence, stagePath });
  registry.bindOriginalActorEntries([entry]);
  const other = createSqliteRunStore(cwd);
  t.after(async () => { registry.closeStage(stage); other.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const request = { toolName: "bash", toolCallId: `preview-call-${decision}`, cwd, task, input: { command: "git commit -m fixture" } };
  return { store, other, run, sourceFence, request, registry,
    closeStage: () => registry.closeStage(stage),
    replace: () => other.createWorkUnitAttempt({ workUnitId: unit.id, attemptNumber: 2,
      runtimeInstanceId: "replacement-runtime", runnerId: "pi", status: "started", now: new Date().toISOString() }),
    beforeRefusal(hook) {
      const gate = registry.assertActorEntryLaunchCurrent.bind(registry);
      t.mock.method(registry, "assertActorEntryLaunchCurrent", (...args) => { hook(); return gate(...args); });
    },
    options: { store, run, sourceFence, workUnitId: unit.id, attemptId: attempt.id, approvalPolicy,
      effectivePolicySnapshot, unifiedExecEnabled: true,
      appendAndMaybeStream(type, data) { return store.appendExecutionEvent(run.id, sourceFence, type, data); },
      streamEnvelope() {},
    },
  };
}
