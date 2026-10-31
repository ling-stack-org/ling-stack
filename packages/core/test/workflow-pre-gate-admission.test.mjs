import assert from "node:assert/strict";
import test from "node:test";
import { b013CreateStep, b013FactCounts, b013Gate, b013OwnedStore, b013ParticipantId } from "./support/b013-pre-gate-fixture.mjs";

/** Calls today's real Core begin API; no new pre-gate API is assumed to exist. */
function begin(f, step) {
  const now = new Date().toISOString();
  const lease = f.store.acquireResourceLease({ workspaceId: f.channel.workspaceId,
    resourceType: "workflow_step", resourceKey: step.id, ownerType: "workflow_step", ownerId: step.id,
    acquiredAt: now, expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() });
  assert.ok(lease, "fixture must acquire a real current execution lease");
  return f.store.beginChannelWorkflowStepStart({ workflowStepId: step.id,
    expected: { status: step.status, taskId: step.taskId, runId: step.runId, updatedAt: step.updatedAt },
    leaseId: lease.id, task: { channelId: f.channel.id, assigneeTeammateId: b013ParticipantId,
      title: "B013 Task", prompt: "Read evidence.txt" }, now });
}

for (const [label, metadata] of [
  ["unrestricted pre", { gates: [b013Gate()] }],
  ["queued-only pre", { gates: [b013Gate({ statuses: ["queued"] })] }],
  ["legacy builtin profile", { approvalGate: { mode: "standard", risk: "medium", requiredForTools: ["read"] } }],
]) {
  test(`B013 direct Core begin rejects ${label} without an approved current permit`, async t => {
    const f = await b013OwnedStore(t), { workflow, step } = b013CreateStep(f, metadata);
    const before = b013FactCounts(f.store);
    const result = begin(f, step);
    const after = b013FactCounts(f.store);
    assert.equal(after.tasks, 0, `pre-gate bypass created a Task: ${JSON.stringify({ result, after })}`);
    assert.equal(after.run_sessions, 0);
    assert.deepEqual(after, before, "direct begin cannot create its own approval or partial execution facts");
    assert.equal(result.status, "invalid", JSON.stringify(result));
    assert.equal(result.code, "workflow_pre_approval_required");
    const current = f.store.getChannelWorkflowStep(step.id);
    assert.equal(current.status, "queued");
    assert.equal(current.taskId, undefined);
    assert.equal(current.runId, undefined);
    assert.equal(current.metadata?.startOwner, undefined);
    assert.equal(f.store.getChannelWorkflow(workflow.id).status, "ready");
  });
}

for (const [label, metadata] of [
  ["no gate", {}],
  ["mode none", { gates: [b013Gate({ mode: "none" })] }],
  ["post-only", { gates: [b013Gate({ stage: "post" })] }],
  ["empty status scope", { gates: [b013Gate({ statuses: [] })] }],
  ["nonmatching status scope", { gates: [b013Gate({ statuses: ["blocked"] })] }],
]) {
  test(`B013 direct Core begin preserves ${label} as a lawful no-pre-gate start`, async t => {
    const f = await b013OwnedStore(t), { step } = b013CreateStep(f, metadata);
    const result = begin(f, step);
    assert.equal(result.status, "begun", JSON.stringify(result));
    assert.equal(b013FactCounts(f.store).tasks, 1);
    assert.equal(b013FactCounts(f.store).run_sessions, 0, "Core begin does not itself execute a Run");
    assert.equal(b013FactCounts(f.store).approval_requests, 0);
    const current = f.store.getChannelWorkflowStep(step.id);
    assert.equal(current.taskId, result.task.id);
    assert.equal(current.metadata.startOwner.taskId, result.task.id);
    assert.equal(current.metadata.startOwner.phase, "preparing");
  });
}
