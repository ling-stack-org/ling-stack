import assert from "node:assert/strict";
import test from "node:test";
import { b013Gate } from "./support/b013-pre-gate-fixture.mjs";
import { assertBeginRefusesWithoutWrites, assertRefused, b013PermitFixture } from "./support/b013-permit-lifecycle-fixture.mjs";

// Test-only source. Root owns fresh build, effective RED/GREEN and actual exit receipts.
// These tests never start a Runner, model, daemon recovery, App or CI.
test("B013 permit request is idempotent across two SQLite connections and pending owns zero execution facts", async t => {
  const f = await b013PermitFixture(t), initial = f.expected();
  const first = f.request(); assert.equal(first.status, "requested", JSON.stringify(first));
  const step = f.current(f.peer), approval = first.approval;
  assert.equal(step.status, "waiting_for_approval");
  assert.equal(f.peer.getChannelWorkflow(f.workflow.id).status, "waiting_for_approval");
  assert.equal(step.metadata.activeGateStage, "pre");
  assert.equal(step.metadata.preStepApprovalId, approval.id);
  assert.equal(step.metadata.preStepApprovalMarker.basis.requestedStatus, "queued");
  assert.equal(step.metadata.preStepApprovalMarker.consumedByTaskId, undefined);
  assert.deepEqual(step.metadata.preStepApprovalMarker.basis, approval.payload.preGateBasis);
  assert.equal(approval.channelId, f.channel.id); assert.equal(approval.workflowStepId, step.id);
  assert.equal(approval.payload.workflowId, f.workflow.id); assert.equal(approval.payload.gateStage, "pre");
  assert.equal(f.count("approval_requests"), 1); assert.equal(f.count("resource_leases"), 0); f.noExecution();
  const before = f.snapshot();
  for (let index = 0; index < 8; index++) {
    const duplicate = f.request(index % 2 ? f.peer : f.store);
    assert.equal(duplicate.status, "duplicate"); assert.equal(duplicate.approval.id, approval.id);
    assert.deepEqual(f.snapshot(), before);
  }
  const oldExpected = f.request(f.peer, { expected: initial });
  assert.equal(oldExpected.status, "stale", "stale CAS snapshot must not be silently refreshed");
  assert.equal(f.resolve(approval, f.peer).status, "duplicate", "pending callback cannot approve itself");
  assert.deepEqual(f.snapshot(), before); f.noExecution();
});

test("B013 approved queued-only gate survives waiting/running and consumes exactly once with the Task owner", async t => {
  const f = await b013PermitFixture(t, { gates: [b013Gate({ statuses: ["queued"] })] });
  const approval = f.approved(), pendingBasis = structuredClone(approval.payload.preGateBasis);
  assert.equal(f.current().status, "running");
  assert.equal(f.current().metadata.preStepApprovalMarker.basis.requestedStatus, "queued");
  assert.equal(f.count("resource_leases"), 0); f.noExecution();
  const approvedSnapshot = f.snapshot();
  const replay = f.request(f.peer, { now: f.at(4) });
  assert.equal(replay.status, "approved", JSON.stringify(replay));
  assert.equal(replay.approval.id, approval.id);
  assert.deepEqual(f.snapshot(), approvedSnapshot, "approved admission replay must not resolve or mutate the cleared active stage again");
  const lease = f.lease(), input = f.beginInput(lease);
  const result = f.peer.beginChannelWorkflowStepStart(input);
  assert.equal(result.status, "begun", JSON.stringify(result));
  const current = f.current();
  assert.equal(current.taskId, result.task.id); assert.equal(current.runId, undefined);
  assert.deepEqual(current.metadata.startOwner, result.owner);
  assert.equal(current.metadata.preStepApprovalMarker.consumedByTaskId, result.task.id);
  assert.deepEqual(current.metadata.preStepApprovalMarker.basis, pendingBasis);
  assert.equal(current.metadata.preStepApprovalId, approval.id);
  const committed = f.snapshot();
  assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "stale");
  assert.equal(f.resolve(approval).status, "stale");
  assert.deepEqual(f.snapshot(), committed); f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
});

test("B013 Retry after a preflight block reuses the same approved unconsumed permit", async t => {
  const f = await b013PermitFixture(t), approval = f.approved();
  const approvedBasis = structuredClone(approval.payload.preGateBasis);
  const lease = f.lease(), expected = f.current();
  const settlement = f.store.settleChannelWorkflowStepStartFailure({
    workflowStepId: f.step.id,
    expected,
    leaseId: lease.id,
    blocker: "B013 Provider preflight blocked before Task creation",
    now: f.at(5),
  });
  assert.equal(settlement.status, "linked", JSON.stringify(settlement));
  assert.equal(f.current().status, "blocked");
  assert.equal(f.peer.getChannelWorkflow(f.workflow.id).status, "blocked");
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, undefined);
  assert.equal(f.peer.getApprovalRequest(approval.id).status, "approved");
  f.noExecution();

  const blockedSnapshot = f.snapshot();
  const retry = f.request(f.peer, { now: f.at(6) });
  assert.equal(retry.status, "approved", JSON.stringify(retry));
  assert.equal(retry.approval.id, approval.id);
  assert.deepEqual(retry.approval.payload.preGateBasis, approvedBasis);
  assert.deepEqual(f.snapshot(), blockedSnapshot, "Retry classification must not mint, resolve or consume another approval");

  const nextLease = f.lease(f.peer, f.at(7));
  const begun = f.store.beginChannelWorkflowStepStart(f.beginInput(nextLease, f.store, f.at(8)));
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, begun.task.id);
  assert.equal(f.count("approval_requests"), 1);
  f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
});

test("B013 changed definition after an approved preflight block retires the holding before a new approval", async t => {
  const f = await b013PermitFixture(t), oldApproval = f.approved();
  const lease = f.lease(), expected = f.current();
  const settlement = f.store.settleChannelWorkflowStepStartFailure({
    workflowStepId: f.step.id,
    expected,
    leaseId: lease.id,
    blocker: "B013 Provider preflight blocked before Task creation",
    now: f.at(5),
  });
  assert.equal(settlement.status, "linked", JSON.stringify(settlement));
  assert.equal(f.current().status, "blocked");
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, undefined);
  f.noExecution();

  const transitionCount = f.count("state_transition_events");
  f.peer.updateChannelWorkflowStep(f.step.id, { prompt: "Changed after the approved preflight block" }, f.at(6));
  const retired = f.request(f.store, { now: f.at(7) });
  assert.equal(retired.status, "stale", JSON.stringify(retired));
  assert.equal(retired.code, "workflow_pre_approval_basis_stale");
  const blocked = f.current();
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.metadata.preStepApprovalId, undefined);
  assert.equal(blocked.metadata.preStepApprovalMarker, undefined);
  assert.equal(blocked.metadata.activeGateStage, undefined);
  assert.equal(f.count("state_transition_events"), transitionCount,
    "retiring a blocked holding must not invent a blocked-to-blocked transition");
  assert.equal(f.count("approval_requests"), 1);
  f.noExecution();

  const next = f.request(f.peer, { now: f.at(8) });
  assert.equal(next.status, "requested", JSON.stringify(next));
  assert.notEqual(next.approval.id, oldApproval.id);
  assert.notEqual(next.approval.payload.preGateBasis.startNonce, oldApproval.payload.preGateBasis.startNonce);
  assert.equal(next.approval.payload.preGateBasis.requestedStatus, "blocked");
  assert.equal(f.peer.getApprovalRequest(oldApproval.id).status, "approved");
  assert.equal(f.count("approval_requests"), 2);
  f.noExecution();

  const successorSnapshot = f.snapshot();
  assert.equal(f.resolve(oldApproval, f.store, f.at(9)).status, "stale",
    "an old approved callback cannot unlock its successor approval cycle");
  assert.deepEqual(f.snapshot(), successorSnapshot);

  f.approve(next.approval, f.peer, f.at(10));
  assert.equal(f.resolve(next.approval, f.store, f.at(11)).status, "approved");
  const nextLease = f.lease(f.peer, f.at(12));
  const nextInput = f.beginInput(nextLease, f.peer, f.at(13));
  const begun = f.store.beginChannelWorkflowStepStart(nextInput);
  assert.equal(begun.status, "begun", JSON.stringify(begun));
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, begun.task.id);
  const consumedSnapshot = f.snapshot();
  assert.equal(f.peer.beginChannelWorkflowStepStart(nextInput).status, "stale");
  assert.equal(f.resolve(oldApproval, f.store, f.at(14)).status, "stale");
  assert.equal(f.resolve(next.approval, f.peer, f.at(15)).status, "stale");
  assert.deepEqual(f.snapshot(), consumedSnapshot, "the successor approval can create exactly one Task owner");
  assert.equal(f.count("approval_requests"), 2);
  f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
});

test("B013 Retry after real start-failure settlement needs a new nonce and cannot reuse a consumed approval", async t => {
  const f = await b013PermitFixture(t), oldApproval = f.approved();
  const oldLease = f.lease(), begun = f.store.beginChannelWorkflowStepStart(f.beginInput(oldLease));
  assert.equal(begun.status, "begun");
  const settlement = f.store.settleChannelWorkflowStepStartFailure({ workflowStepId: f.step.id,
    owner: begun.owner, leaseId: oldLease.id, blocker: "B013 owned preparation failed before Run creation", now: f.at(6) });
  assert.equal(settlement.status, "linked"); assert.equal(f.current().status, "blocked");
  assertBeginRefusesWithoutWrites(f, { tasks: 1, owners: 1, now: f.at(7) });
  const next = f.request(f.peer, { now: f.at(10) });
  assert.equal(next.status, "requested", JSON.stringify(next));
  assert.notEqual(next.approval.id, oldApproval.id);
  assert.notEqual(next.approval.payload.preGateBasis.startNonce, oldApproval.payload.preGateBasis.startNonce);
  assert.equal(next.approval.payload.preGateBasis.requestedStatus, "blocked");
  assert.equal(f.peer.getApprovalRequest(oldApproval.id).status, "approved", "old immutable approval remains audit evidence");
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, undefined);
  f.noExecution({ tasks: 1 });
  const waiting = f.snapshot();
  assert.equal(f.resolve(oldApproval, f.store, f.at(11)).status, "stale"); assert.deepEqual(f.snapshot(), waiting);
  f.approve(next.approval, f.peer, f.at(11));
  assert.equal(f.resolve(next.approval, f.peer, f.at(12)).status, "approved");
  const newLease = f.lease(f.peer, f.at(13));
  const nextBegin = f.store.beginChannelWorkflowStepStart(f.beginInput(newLease, f.store, f.at(14)));
  assert.equal(nextBegin.status, "begun"); assert.notEqual(nextBegin.task.id, begun.task.id);
  assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, nextBegin.task.id);
  f.noExecution({ tasks: 2, owners: 1, activeLeases: 1 });
});

for (const phase of ["pending", "approved", "consumed"]) {
  test(`B013 reopen preserves ${phase} permit facts without implicitly creating a new start cycle`, async t => {
    const f = await b013PermitFixture(t), request = f.request();
    assert.equal(request.status, "requested");
    let input, taskId;
    if (phase !== "pending") { f.approve(request.approval); assert.equal(f.resolve(request.approval).status, "approved"); }
    if (phase === "consumed") {
      input = f.beginInput(f.lease());
      const result = f.store.beginChannelWorkflowStepStart(input); assert.equal(result.status, "begun"); taskId = result.task.id;
    }
    const before = f.snapshot(); f.reopen("store"); f.reopen("peer");
    assert.deepEqual(f.snapshot(), before, "opening Store is not approval recovery execution");
    if (phase === "pending") {
      const duplicate = f.request(f.peer); assert.equal(duplicate.status, "duplicate");
      assert.equal(duplicate.approval.id, request.approval.id); assert.deepEqual(f.snapshot(), before); f.noExecution();
    } else if (phase === "approved") {
      assert.equal(f.resolve(request.approval, f.peer).status, "approved"); f.noExecution();
      const result = f.store.beginChannelWorkflowStepStart(f.beginInput(f.lease()));
      assert.equal(result.status, "begun"); assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, result.task.id);
      f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
    } else {
      assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "stale");
      assert.equal(f.resolve(request.approval).status, "stale");
      assert.deepEqual(f.snapshot(), before); assert.equal(f.current().taskId, taskId);
      f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
    }
  });
}

test("B013 createTaskOnly consumes its approved permit and does not retain an execution owner or lease", async t => {
  const f = await b013PermitFixture(t);
  const request = f.request(f.store, { executionPermit: f.executionPermit({ mode: "create_task" }) });
  assert.equal(request.status, "requested");
  f.approve(request.approval); assert.equal(f.resolve(request.approval).status, "approved");
  const approval = request.approval, lease = f.lease();
  const input = { ...f.beginInput(lease), executionPermit: f.executionPermit({ mode: "create_task" }), createTaskOnly: true };
  const result = f.peer.beginChannelWorkflowStepStart(input); assert.equal(result.status, "begun");
  const current = f.current();
  assert.equal(current.status, "succeeded"); assert.equal(current.taskId, result.task.id);
  assert.equal(current.metadata.startOwner, undefined);
  assert.equal(current.metadata.preStepApprovalId, approval.id);
  assert.equal(current.metadata.preStepApprovalMarker.consumedByTaskId, result.task.id);
  f.noExecution({ tasks: 1 });
  const committed = f.snapshot(); assert.equal(f.store.beginChannelWorkflowStepStart(input).status, "stale");
  assert.deepEqual(f.snapshot(), committed);
});

for (const [label, overrides] of [
  ["mode", { mode: "create_task" }],
  ["skip Provider preflight", { skipProviderPreflight: true }],
  ["assignee", { assigneeTeammateId: "teammate_builtin_qa" }],
]) {
  test(`B013 approved permit cannot be reused after ${label} changes`, async t => {
    const f = await b013PermitFixture(t), approval = f.approved(), lease = f.lease();
    const original = f.beginInput(lease), changed = f.executionPermit(overrides);
    const input = { ...original, executionPermit: changed,
      createTaskOnly: changed.mode === "create_task",
      task: { ...original.task, assigneeTeammateId: changed.assigneeTeammateId } };
    const before = f.snapshot(), result = f.store.beginChannelWorkflowStepStart(input);
    assertRefused(result); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.peer.getApprovalRequest(approval.id).status, "approved");
    f.noExecution({ activeLeases: 1 });
  });
}

for (const phase of ["pending", "approved"]) {
  test(`B013 changed ${phase} definition needs explicit stale retirement and a new approval, never an old callback`, async t => {
    const f = await b013PermitFixture(t), initial = f.request(); assert.equal(initial.status, "requested");
    if (phase === "approved") { f.approve(initial.approval); assert.equal(f.resolve(initial.approval).status, "approved"); }
    f.peer.updateChannelWorkflowStep(f.step.id, { prompt: "A new explicit owned objective" }, f.at(7));
    const changed = f.snapshot(); assert.equal(f.resolve(initial.approval, f.peer, f.at(8)).status, "stale");
    assert.deepEqual(f.snapshot(), changed, "stale callback cannot retire or rewrite a current source");
    const retired = f.request(f.store, { now: f.at(9) });
    assert.equal(retired.status, "stale"); assert.equal(f.current().status, "blocked");
    assert.equal(f.current().metadata.preStepApprovalId, undefined); assert.equal(f.current().metadata.preStepApprovalMarker, undefined);
    assert.equal(f.count("approval_requests"), 1); f.noExecution();
    const next = f.request(f.peer, { now: f.at(10) }); assert.equal(next.status, "requested", JSON.stringify(next));
    assert.notEqual(next.approval.id, initial.approval.id);
    assert.notEqual(next.approval.payload.preGateBasis.startNonce, initial.approval.payload.preGateBasis.startNonce);
    const waiting = f.snapshot(); assert.equal(f.resolve(initial.approval, f.store, f.at(11)).status, "stale");
    assert.deepEqual(f.snapshot(), waiting); assert.equal(f.count("approval_requests"), 2); f.noExecution();
  });
}

for (const variant of ["row-channel", "row-step", "payload-workflow", "payload-step", "post-stage", "missing-basis", "forged-basis", "malformed-marker", "missing-marker"]) {
  test(`B013 current approved permit with ${variant} cannot resolve or authorize direct begin`, async t => {
    const f = await b013PermitFixture(t), approval = f.approved();
    if (variant === "row-channel") {
      const foreign = f.peer.createChannel({ name: "Other owned channel", boundPath: f.cwd }, f.at(6));
      f.peer.database.prepare("UPDATE approval_requests SET channel_id=? WHERE id=?").run(foreign.id, approval.id);
    } else if (variant === "row-step" || variant === "payload-workflow" || variant === "payload-step") {
      const sibling = f.peer.createChannelWorkflow({ channelId: f.channel.id, title: "Sibling", objective: "Other owned definition", status: "ready", createdBy: "local-user" }, f.at(6));
      const step = f.peer.createChannelWorkflowStep({ workflowId: sibling.id, title: "Other step", prompt: "Other owned input",
        toParticipantId: f.step.toParticipantId, toParticipantLabel: f.step.toParticipantLabel }, f.at(6));
      if (variant === "row-step") f.peer.database.prepare("UPDATE approval_requests SET workflow_step_id=? WHERE id=?").run(step.id, approval.id);
      else f.mutateApprovalPayload(approval, payload => { payload[variant === "payload-workflow" ? "workflowId" : "workflowStepId"] = variant === "payload-workflow" ? sibling.id : step.id; });
    } else if (variant === "post-stage") f.mutateApprovalPayload(approval, payload => { payload.gateStage = "post"; });
    else if (variant === "missing-basis") f.mutateApprovalPayload(approval, payload => { delete payload.preGateBasis; });
    else if (variant === "forged-basis") f.mutateApprovalPayload(approval, payload => { payload.preGateBasis.fingerprint = `wpg1_${"0".repeat(64)}`; });
    else if (variant === "malformed-marker") f.mutateMetadata(metadata => { metadata.preStepApprovalMarker.basis.startNonce = "forged-without-matching-digest"; });
    else f.mutateMetadata(metadata => { delete metadata.preStepApprovalMarker; });
    const before = f.snapshot(), result = f.resolve(approval, f.peer, f.at(8));
    assert.equal(result.status, "stale", JSON.stringify(result));
    assert.equal(result.code, "workflow_pre_approval_basis_stale");
    assert.deepEqual(f.snapshot(), before); f.noExecution();
    const refused = assertBeginRefusesWithoutWrites(f);
    assert.ok(["workflow_pre_approval_basis_stale", "workflow_pre_approval_required"].includes(refused.code), JSON.stringify(refused));
  });
}

for (const variant of ["prompt", "title", "tools", "gate", "channel-permissions", "workflow-objective", "runner", "missing-source"]) {
  test(`B013 approved permit is stale after current ${variant} definition changes before begin`, async t => {
    const f = await b013PermitFixture(t), approval = f.approved();
    if (variant === "prompt" || variant === "title") f.peer.updateChannelWorkflowStep(f.step.id, { [variant]: "Changed owned definition" }, f.at(7));
    else if (variant === "tools") f.mutateMetadata(metadata => { metadata.requiredTools = ["read", "bash"]; });
    else if (variant === "gate") f.mutateMetadata(metadata => { metadata.gates[0].reason = "New decision basis must be approved"; });
    else if (variant === "channel-permissions") f.peer.updateChannel(f.channel.id, { allowedTools: ["read"] }, f.at(7));
    else if (variant === "workflow-objective") f.peer.updateChannelWorkflow(f.workflow.id, { objective: "New owned objective" }, f.at(7));
    else if (variant === "runner") f.mutateMetadata(metadata => { metadata.requestedRunnerId = "b013-other-runner"; });
    else f.mutateMetadata(metadata => { metadata.sourceMessageId = "b013-absent-source-item"; });
    const before = f.snapshot(), resolved = f.resolve(approval, f.peer, f.at(8));
    assert.equal(resolved.status, "stale"); assert.equal(resolved.code, "workflow_pre_approval_basis_stale");
    assert.deepEqual(f.snapshot(), before); f.noExecution();
    assertBeginRefusesWithoutWrites(f);
  });
}

for (const [decision, status, code] of [["deny", "denied", "workflow_pre_approval_denied"],
  ["expire", "expired", "workflow_pre_approval_expired"], ["cancel", "cancelled", "workflow_pre_approval_cancelled"],
  ["pending-deadline", "pending", "workflow_pre_approval_expired"], ["approved-deadline", "approved", "workflow_pre_approval_expired"]]) {
  test(`B013 ${decision} permit blocks without any Task, Run, owner or execution lease`, async t => {
    const f = await b013PermitFixture(t), request = f.request(); assert.equal(request.status, "requested");
    const approval = request.approval, expiredAt = new Date(Date.parse(approval.expiresAt) + 1).toISOString();
    if (decision === "approved-deadline") f.approve(approval);
    else if (decision === "deny" || decision === "cancel" || decision === "expire") {
      const method = decision === "deny" ? "denyApprovalRequest" : decision === "cancel" ? "cancelApprovalRequest" : "expireApprovalRequest";
      assert.equal(f.peer[method](approval.id, { resolvedBy: "local-user", reason: `B013 ${decision} decision` }, decision === "expire" ? expiredAt : f.at(2))?.status, status);
    }
    const now = decision.includes("deadline") || decision === "expire" ? expiredAt : f.at(3);
    const result = f.resolve(approval, f.store, now);
    assert.equal(result.status, "blocked", JSON.stringify(result)); assert.equal(result.code, code);
    assert.equal(f.current().status, "blocked"); assert.equal(f.peer.getChannelWorkflow(f.workflow.id).status, "blocked");
    assert.equal(f.peer.getApprovalRequest(approval.id).status, status, "projection expiry does not forge an Approval status mutation");
    const again = f.request(f.peer, { now }); assert.equal(again.status, "blocked");
    assert.equal(f.count("approval_requests"), 1); assert.equal(f.count("resource_leases"), 0); f.noExecution();
    assertBeginRefusesWithoutWrites(f, { now: new Date(Date.parse(now) + 1_000).toISOString() });
  });
}

for (const [policy, expectedStep, expectedWorkflow] of [["fail_workflow", "failed", "failed"],
  ["cancel_workflow", "cancelled", "cancelled"], ["skip_if_optional", "skipped", "running"]]) {
  test(`B013 denial preserves the existing ${policy} policy without beginning execution`, async t => {
    const f = await b013PermitFixture(t, { gates: [b013Gate()], policy: { onRunFailed: "block_for_user",
      onRunCancelled: "block_for_user", onApprovalDenied: policy, retryable: true } });
    const request = f.request(); assert.equal(request.status, "requested");
    f.peer.denyApprovalRequest(request.approval.id, { resolvedBy: "local-user", reason: "B013 reject by configured policy" }, f.at(2));
    assert.equal(f.resolve(request.approval).status, "blocked");
    assert.equal(f.current().status, expectedStep); assert.equal(f.peer.getChannelWorkflow(f.workflow.id).status, expectedWorkflow);
    // Skipping one Step does not authorize workflow success. The Daemon's
    // canonical completion/evidence gate, not this pre-permit Store, owns it.
    const before = f.snapshot(); assertRefused(f.resolve(request.approval, f.peer)); assert.deepEqual(f.snapshot(), before);
    assert.equal(f.count("resource_leases"), 0); f.noExecution();
  });
}

for (const phase of ["pending", "approved"]) for (const target of ["workflow", "step"]) {
  test(`B013 ${target} cancellation wins over a ${phase} permit and stale callback cannot revive it`, async t => {
    const f = await b013PermitFixture(t), request = f.request(); assert.equal(request.status, "requested");
    if (phase === "approved") { f.approve(request.approval); assert.equal(f.resolve(request.approval).status, "approved"); }
    const current = f.current(f.peer), workflow = f.peer.getChannelWorkflow(f.workflow.id);
    const cancellation = target === "workflow"
      ? f.peer.transitionChannelWorkflowStatus({ workflowId: workflow.id, expectedStatus: workflow.status, event: "cancel", actor: "local-user", now: f.at(7) })
      : f.peer.transitionChannelWorkflowStepStatus({ workflowStepId: current.id, expectedStatus: current.status, event: "cancel", actor: "local-user", now: f.at(7) });
    assert.equal(cancellation.ok, true, JSON.stringify(cancellation));
    const cancelled = f.snapshot(); assertRefused(f.resolve(request.approval, f.store, f.at(8)));
    assert.deepEqual(f.snapshot(), cancelled); f.noExecution(); assertBeginRefusesWithoutWrites(f);
  });
}

for (const [fault, clause] of [["approval-insert", "BEFORE INSERT ON approval_requests"],
  ["marker-update", "BEFORE UPDATE OF metadata_json ON channel_workflow_steps"],
  ["transition-audit", "BEFORE INSERT ON state_transition_events"],
  ["workflow-waiting", "BEFORE UPDATE OF status ON channel_workflows WHEN NEW.status='waiting_for_approval'"]]) {
  test(`B013 request ${fault} failure rolls approval, marker, states and audits back across connections`, async t => {
    const f = await b013PermitFixture(t), before = f.snapshot();
    f.peer.database.exec(`CREATE TRIGGER b013_request_fault ${clause} BEGIN SELECT RAISE(ABORT, 'B013_REQUEST_ATOMIC_FAULT'); END`);
    assert.throws(() => f.request(), /B013_REQUEST_ATOMIC_FAULT/);
    assert.deepEqual(f.snapshot(), before); f.noExecution(); assert.equal(f.count("approval_requests"), 0);
    f.peer.database.exec("DROP TRIGGER b013_request_fault");
    assert.equal(f.request(f.peer).status, "requested"); assert.equal(f.count("approval_requests"), 1); f.noExecution();
  });
}

for (const [fault, clause] of [["step-audit", "BEFORE INSERT ON state_transition_events"],
  ["workflow-resume", "BEFORE UPDATE OF status ON channel_workflows WHEN NEW.status='running'"]]) {
  test(`B013 resolve ${fault} rollback keeps the committed approval but no half-resumed Step`, async t => {
    const f = await b013PermitFixture(t), request = f.request(); assert.equal(request.status, "requested"); f.approve(request.approval);
    const before = f.snapshot();
    f.peer.database.exec(`CREATE TRIGGER b013_resolve_fault ${clause} BEGIN SELECT RAISE(ABORT, 'B013_RESOLVE_ATOMIC_FAULT'); END`);
    assert.throws(() => f.resolve(request.approval), /B013_RESOLVE_ATOMIC_FAULT/);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.current().status, "waiting_for_approval");
    assert.equal(f.peer.getApprovalRequest(request.approval.id).status, "approved"); f.noExecution();
    f.peer.database.exec("DROP TRIGGER b013_resolve_fault");
    assert.equal(f.resolve(request.approval, f.peer).status, "approved"); f.noExecution();
  });
}

for (const [fault, clause] of [["task-insert", "BEFORE INSERT ON tasks"],
  ["owner-and-consumption", "BEFORE UPDATE OF task_id ON channel_workflow_steps WHEN NEW.task_id IS NOT NULL"]]) {
  test(`B013 begin ${fault} failure leaves its approved permit unconsumed and no orphan Task`, async t => {
    const f = await b013PermitFixture(t), approval = f.approved(), input = f.beginInput(f.lease()), before = f.snapshot();
    f.peer.database.exec(`CREATE TRIGGER b013_consume_fault ${clause} BEGIN SELECT RAISE(ABORT, 'B013_CONSUME_ATOMIC_FAULT'); END`);
    assert.throws(() => f.store.beginChannelWorkflowStepStart(input), /B013_CONSUME_ATOMIC_FAULT/);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, undefined);
    assert.equal(f.peer.getApprovalRequest(approval.id).status, "approved"); f.noExecution({ activeLeases: 1 });
    f.peer.database.exec("DROP TRIGGER b013_consume_fault");
    const result = f.peer.beginChannelWorkflowStepStart(input); assert.equal(result.status, "begun");
    assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, result.task.id);
    f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
  });
}

for (const order of [[0, 1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0], [4, 0, 6, 2, 7, 3, 5, 1]]) {
  test(`B013 eight ordered contenders across two real connections CAS exactly one request and one consumption: ${order.join("")}`, async t => {
    const f = await b013PermitFixture(t), initial = { workflowStepId: f.step.id, expected: f.expected(),
      executionPermit: f.executionPermit(), now: f.at(1) };
    const outcomes = order.map(index => (index % 2 ? f.peer : f.store).requestChannelWorkflowStepPreApproval(initial));
    assert.equal(outcomes.filter(result => result.status === "requested").length, 1);
    assert.equal(outcomes.filter(result => result.status === "stale").length, 7);
    const approval = outcomes.find(result => result.status === "requested").approval;
    assert.equal(f.count("approval_requests"), 1); assert.equal(f.count("resource_leases"), 0); f.noExecution();
    for (const index of order) {
      const result = f.request(index % 2 ? f.peer : f.store);
      assert.equal(result.status, "duplicate"); assert.equal(result.approval.id, approval.id);
    }
    f.approve(approval); assert.equal(f.resolve(approval).status, "approved");
    const input = f.beginInput(f.lease()), starts = [];
    for (const index of order) {
      const before = f.snapshot();
      const result = (index % 2 ? f.peer : f.store).beginChannelWorkflowStepStart(input); starts.push(result);
      if (result.status !== "begun") assert.deepEqual(f.snapshot(), before, "a CAS loser cannot mutate the winning owner or permit");
    }
    assert.equal(starts.filter(result => result.status === "begun").length, 1);
    assert.equal(starts.filter(result => result.status === "stale").length, 7);
    const winner = starts.find(result => result.status === "begun");
    assert.equal(f.current().taskId, winner.task.id); assert.equal(f.current().metadata.preStepApprovalMarker.consumedByTaskId, winner.task.id);
    assert.equal(f.current().metadata.startOwner.leaseId, input.leaseId);
    f.noExecution({ tasks: 1, owners: 1, activeLeases: 1 });
  });
}
