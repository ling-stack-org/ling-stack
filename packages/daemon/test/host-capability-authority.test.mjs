import assert from "node:assert/strict";
import test from "node:test";
import { approvalSideEffectFingerprintV1, createApprovalResumeBasisV1 } from "@ling-stack/core";
import { createHostCapabilityAuthority } from "../dist/features/runs/host-capability-authority.js";
import { hostCapabilityApprovalPayload } from "../dist/features/runs/host-capability-action.js";
import { hostAuthorityFixture } from "./support/host-capability-authority-fixture.mjs";

test("selected Host capability requires a matching current prepared Run and durable approval", async t => {
  const f = await hostAuthorityFixture(t);
  const decision = await f.handler()(f.request);
  assert.equal(decision.approved, true);
  assert.equal(decision.approvalId, f.approvals[0].id);
  assert.equal(decision.handledResult, undefined);
});

for (const scenario of ["missing-fence", "missing-prepared", "unselected-capability", "foreign-task", "foreign-cwd", "old-attempt", "foreign-runtime"]) {
  test(`Host admission rejects ${scenario} before creating an approval`, async t => {
    const f = await hostAuthorityFixture(t, { withoutPrepared: scenario === "missing-prepared", ...(scenario === "unselected-capability" ? { tools: [] } : {}) });
    const overrides = scenario === "missing-fence" ? { sourceFence: undefined }
      : scenario === "foreign-runtime" ? { sourceFence: { ...f.sourceFence, runtimeInstanceId: "foreign" } } : {};
    const handler = f.handler(overrides);
    if (scenario === "old-attempt") f.replace();
    const request = scenario === "foreign-task" ? { ...f.request, task: { ...f.task, id: "foreign" } }
      : scenario === "foreign-cwd" ? { ...f.request, cwd: `${f.cwd}/foreign` } : f.request;
    const decision = await handler(request);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /host_capability_/);
    assert.equal(f.approvals.length, 0);
  });
}

test("Host approval wait cannot rebind an old callback to a successor from another SQLite connection", async t => {
  const f = await hostAuthorityFixture(t);
  let successor;
  f.duringApproval = () => { successor = f.replace(); };
  const decision = await f.handler()(f.request);
  assert.equal(decision.approved, false);
  assert.equal(f.store.getWorkUnit(f.unit.id).activeAttemptId, successor.id);
  assert.equal(f.store.getRun(f.run.id).status, "waiting_for_approval", "old callback must not resume the new owner's run");
});

for (const field of ["path", "toolCallId", "task", "cwd"]) {
  test(`Host approval cannot execute a changed ${field} after the wait`, async t => {
    const f = await hostAuthorityFixture(t);
    f.duringApproval = () => {
      if (field === "path") f.request.input.path = "different.html";
      else if (field === "task") f.request.task = { ...f.task, prompt: "Different objective" };
      else f.request[field] = "different";
    };
    const decision = await f.handler()(f.request);
    assert.equal(decision.approved, false);
    assert.equal(decision.handledResult, undefined);
  });
}

for (const field of ["priorAttemptId", "runId", "workUnitId", "toolCallId", "sideEffectFingerprint"]) {
  test(`Host approval rejects a checkpoint rebound to a different ${field}`, async t => {
    const f = await hostAuthorityFixture(t);
    f.duringApproval = approval => {
      const cp = f.store.getApprovalCheckpointForApproval(approval.id);
      const { schemaVersion: _schema, fingerprint: _fingerprint, ...basis } = cp.resumeBasis;
      const foreignBasis = createApprovalResumeBasisV1({ ...basis, [field]: "foreign" });
      assert.throws(() => f.store.updateApprovalCheckpointStatus(cp.id, { status: cp.status, expectedStatus: cp.status, expectedRevision: cp.revision,
        resumeBasis: foreignBasis }, new Date().toISOString()), /resume basis is immutable/);
      // Deliberately mismatched read seam, not an actual overwrite of the immutable DB record.
      const read = f.store.getApprovalCheckpointForApproval.bind(f.store);
      f.store.getApprovalCheckpointForApproval = id => { const value = read(id); return value && id === approval.id ? { ...value, resumeBasis: foreignBasis } : value; };
    };
    assert.equal((await f.handler()(f.request)).approved, false);
  });
}

test("Host authority rechecks after approval-resolution callbacks before returning execution permission", async t => {
  const f = await hostAuthorityFixture(t);
  const decision = await f.handler({ onApprovalResolved: () => f.replace() })(f.request);
  assert.equal(decision.approved, false);
});

for (const defaultApproval of ["ask", "deny"]) {
  test(`Host ${defaultApproval} request cannot write approval/checkpoint after losing ownership at the insertion boundary`, async t => {
    const f = await hostAuthorityFixture(t);
    const create = f.store.createExecutionApprovalRequest?.bind(f.store);
    f.store.createExecutionApprovalRequest = (...args) => { f.replace(); return create(...args); };
    const decision = await f.handler()({ ...f.request, defaultApproval });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /host_capability_owner_invalid/);
    assert.equal(f.store.listApprovalRequests({ runId: f.run.id }).length, 0);
    assert.equal(f.store.listApprovalCheckpoints({ runId: f.run.id }).length, 0);
  });
}

for (const when of ["before", "during"]) {
  test(`Host cancellation ${when} approval never grants execution permission`, async t => {
    const f = await hostAuthorityFixture(t);
    const controller = new AbortController();
    if (when === "before") controller.abort();
    else f.duringApproval = () => controller.abort();
    const decision = f.handler({ signal: controller.signal })(f.request);
    if (when === "during") await assert.rejects(decision, { name: "AbortError" });
    else assert.equal((await decision).approved, false);
  });
}

for (const scenario of ["unknown-tool", "foreign-owner-field", "absolute-path", "traversal"]) {
  test(`Host rejects malformed model input before approval: ${scenario}`, async t => {
    const f = await hostAuthorityFixture(t);
    if (scenario === "unknown-tool") f.request.toolName = "host_unknown";
    else f.request.input = scenario === "foreign-owner-field" ? { path: "index.html", runId: "foreign" }
      : { path: scenario === "absolute-path" ? "/private/index.html" : "../index.html" };
    const decision = await f.handler()(f.request);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /host_capability_input_invalid/);
    assert.equal(f.approvals.length, 0);
  });
}

test("a Run-owned Host approval retains workflow lineage only in its immutable resume basis", async t => {
  const f = await hostAuthorityFixture(t, { workflow: true });
  const authority = createHostCapabilityAuthority(f);
  assert.equal(authority.check(f.request), undefined);
  const payload = hostCapabilityApprovalPayload(f.request);
  const approval = f.store.createExecutionApprovalRequest({ runId: f.run.id, taskId: f.task.id, channelId: f.run.channelId,
    toolCallId: f.request.toolCallId, actionType: "host_capability", risk: "medium", title: "Host", description: "Host", payload }, f.sourceFence, new Date().toISOString());
  const checkpoint = f.store.getApprovalCheckpointForApproval(approval.id);
  f.store.updateApprovalCheckpointStatus(checkpoint.id, { status: checkpoint.status, expectedRevision: checkpoint.revision,
    resumeBasis: createApprovalResumeBasisV1({ approvalId: approval.id, runId: f.run.id, workUnitId: f.unit.id,
      priorAttemptId: f.attempt.id, workflowStepId: f.run.workflowStepId, toolCallId: f.request.toolCallId,
      actionType: "host_capability", sideEffectFingerprint: approvalSideEffectFingerprintV1({ actionType: "host_capability", toolCallId: f.request.toolCallId, sideEffect: payload }) }) }, new Date().toISOString());
  f.store.approveApprovalRequest(approval.id, {}, new Date().toISOString());
  assert.equal(authority.check(f.request, approval.id), undefined);
  assert.equal(authority.check({ ...f.request, toolCallId: "another-call" }, approval.id).code, "host_capability_approval_invalid");
  assert.equal(authority.check({ ...f.request, input: { path: "another.html" } }, approval.id).code, "host_capability_approval_invalid");
});
